"""Vérification des faits : contrôles mécaniques + relecture IA indépendante.

Une vidéo n'est montée que si chaque affirmation du script est confirmée par le dossier.
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

from .sources import Dossier
from .text import find_numbers, find_quotes, normalize, number_keys, numbers_in
from .writer import revise_script

BLOCKING, WARNING = "bloquant", "avertissement"

CHECK_SCHEMA = {
    "type": "object",
    "properties": {
        "scenes": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "index": {"type": "integer"},
                    "assertions": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "texte": {"type": "string"},
                                "verdict": {"type": "string", "enum": ["confirme", "non_confirme", "contredit"]},
                                "passages": {"type": "array", "items": {"type": "string"}},
                                "explication": {"type": "string"},
                            },
                            "required": ["texte", "verdict", "passages", "explication"],
                            "additionalProperties": False,
                        },
                    },
                },
                "required": ["index", "assertions"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["scenes"],
    "additionalProperties": False,
}

CHECK_TASK = """Tu es maintenant le vérificateur, indépendant du rédacteur. Vérifie le script JSON ci-dessous contre le dossier.

Pour chaque scène (index à partir de 0), relève TOUTES les affirmations factuelles de la narration et du visuel (texte et légende), y compris celles que le rédacteur n'a pas listées. Pour chacune :
- "verdict" : "confirme" si un passage du dossier l'établit clairement ; "non_confirme" si aucun passage ne l'établit, même si tu penses que c'est vrai ; "contredit" si un passage dit autre chose.
- "passages" : les ids qui la confirment ou la contredisent.
- "explication" : une phrase ; pour "non_confirme" ou "contredit", la correction possible d'après le dossier.

Ignore les phrases de réflexion ou de transition qui n'affirment aucun fait. Sois strict sur les dates, nombres, noms, lieux, liens de cause à effet, détails dramatisés et superlatifs (« la première », « le plus grand »).

Script :
"""


def fingerprint(script: dict) -> str:
    return hashlib.sha256(json.dumps(script, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def _scene_texts(scene: dict) -> list[str]:
    visual = scene["visuel"]
    return [scene["narration"], visual.get("texte", ""), visual.get("legende", "")]


def _collector(found: list[dict]):
    def add(level: str, message: str) -> None:
        found.append({"niveau": level, "message": message})

    return add


def mechanical_checks(dossier: Dossier, script: dict) -> dict[int, list[dict]]:
    """Contrôles sans IA : ids de passages et d'images, citations mot pour mot, nombres."""
    passages = dossier.passages
    images = dossier.images
    all_numbers: set[str] = set()
    for passage in passages.values():
        all_numbers |= numbers_in(passage["texte"])
    normalized_passages = [normalize(p["texte"]) for p in passages.values()]

    issues: dict[int, list[dict]] = {}
    for index, scene in enumerate(script["scenes"]):
        found: list[dict] = []
        add = _collector(found)
        cited: set[str] = set()
        for claim in scene["affirmations"]:
            for passage_id in claim["passages"]:
                if passage_id in passages:
                    cited.add(passage_id)
                else:
                    add(BLOCKING, f"Passage inexistant « {passage_id} » cité pour : {claim['texte']}")
            if not claim["passages"]:
                add(BLOCKING, f"Affirmation sans source : {claim['texte']}")

        visual = scene["visuel"]
        if visual["type"] == "image" and visual["image"] not in images:
            add(BLOCKING, f"Image inconnue « {visual['image']} » : choisir un id du dossier ou une carte")

        quotes = find_quotes(scene["narration"])
        if visual["type"] == "carte_citation" and visual["texte"]:
            quotes.append(visual["texte"])
        for quote in quotes:
            if not any(normalize(quote) in text for text in normalized_passages):
                add(BLOCKING, f"Citation introuvable mot pour mot dans les sources : « {quote} »")

        cited_numbers: set[str] = set()
        for passage_id in cited:
            cited_numbers |= numbers_in(passages[passage_id]["texte"])
        for text in _scene_texts(scene):
            for number in find_numbers(text):
                keys = number_keys(number)
                if keys & cited_numbers:
                    continue
                if keys & all_numbers:
                    add(WARNING, f"Nombre « {number} » présent dans le dossier mais pas dans les passages cités")
                else:
                    add(BLOCKING, f"Nombre « {number} » absent de toutes les sources")
        if found:
            issues[index] = found
    return issues


def ai_check(llm, dossier: Dossier, script: dict) -> dict[int, list[dict]]:
    scenes = [{"index": i, **scene} for i, scene in enumerate(script["scenes"])]
    result = llm.json(dossier.as_prompt(), CHECK_TASK + json.dumps(scenes, ensure_ascii=False, indent=1), CHECK_SCHEMA)
    return {item["index"]: item["assertions"] for item in result["scenes"] if 0 <= item["index"] < len(scenes)}


def _problems(mechanical: dict[int, list[dict]], assertions: dict[int, list[dict]]) -> dict[int, list[str]]:
    problems: dict[int, list[str]] = {}
    for index, items in mechanical.items():
        for item in items:
            if item["niveau"] == BLOCKING:
                problems.setdefault(index, []).append(item["message"])
    for index, items in assertions.items():
        for item in items:
            if item["verdict"] != "confirme":
                label = "contredit par le dossier" if item["verdict"] == "contredit" else "non confirmé par le dossier"
                problems.setdefault(index, []).append(f"« {item['texte']} » : {label}. {item['explication']}")
    return problems


def verify(llm, dossier: Dossier, script: dict, max_rounds: int = 2, log=print) -> tuple[dict, dict]:
    """Vérifie, fait corriger les scènes fautives, revérifie. Renvoie (script, rapport)."""
    for round_number in range(max_rounds + 1):
        log(f"  Vérification, tour {round_number + 1}…")
        mechanical = mechanical_checks(dossier, script)
        assertions = ai_check(llm, dossier, script)
        problems = _problems(mechanical, assertions)
        if not problems:
            break
        log(f"    {sum(len(v) for v in problems.values())} problème(s) dans {len(problems)} scène(s)")
        if round_number == max_rounds:
            break
        log("  Correction des scènes signalées…")
        script = revise_script(llm, dossier, script, problems)

    report = {
        "statut": "echec" if problems else "valide",
        "empreinte_script": fingerprint(script),
        "date": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "tours": round_number + 1,
        "scenes": [
            {
                "index": index,
                "chapitre": scene["chapitre"],
                "assertions": assertions.get(index, []),
                "controles": mechanical.get(index, []),
                "problemes": problems.get(index, []),
            }
            for index, scene in enumerate(script["scenes"])
        ],
    }
    return script, report


def write_report(report: dict, dossier: Dossier, project_dir: Path) -> None:
    (project_dir / "verification.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    passages, sources = dossier.passages, dossier.sources

    def ref(passage_id: str) -> str:
        passage = passages.get(passage_id)
        if not passage:
            return f"`{passage_id}` (inexistant)"
        source = sources[passage["source"]]
        return f"[{passage_id}]({source['url']})" if source.get("url") else passage_id

    icons = {"confirme": "✅", "non_confirme": "❌", "contredit": "⛔"}
    status = "✅ VALIDÉ" if report["statut"] == "valide" else "❌ ÉCHEC — vidéo bloquée"
    lines = [
        f"# Rapport de vérification — {dossier.data['sujet']}",
        "",
        f"**Statut : {status}** · {report['tours']} tour(s) · {report['date']}",
        "",
        "Chaque affirmation est reliée au passage du dossier qui la prouve (`dossier.json`).",
        "Relisez ce rapport avant publication : la vérification automatique réduit les erreurs, "
        "elle ne remplace pas votre jugement.",
    ]
    for scene in report["scenes"]:
        lines += ["", f"## Scène {scene['index']} — {scene['chapitre']}"]
        for item in scene["assertions"]:
            refs = ", ".join(ref(p) for p in item["passages"]) or "aucune source"
            lines.append(f"- {icons[item['verdict']]} {item['texte']} — {refs}")
            if item["verdict"] != "confirme":
                lines.append(f"  - {item['explication']}")
        for check in scene["controles"]:
            icon = "❌" if check["niveau"] == BLOCKING else "⚠️"
            lines.append(f"- {icon} {check['message']}")
    (project_dir / "verification.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
