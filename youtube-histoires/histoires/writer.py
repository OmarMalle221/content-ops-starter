"""Rédaction du script par l'IA, chaque fait relié aux passages qui le prouvent."""

from __future__ import annotations

import json

from .config import Format
from .sources import Dossier

VISUAL_TYPES = ["image", "carte_date", "carte_fait", "carte_citation"]

_STRING = {"type": "string"}
_STRINGS = {"type": "array", "items": _STRING}

SCENE_SCHEMA = {
    "type": "object",
    "properties": {
        "chapitre": _STRING,
        "narration": _STRING,
        "affirmations": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"texte": _STRING, "passages": _STRINGS},
                "required": ["texte", "passages"],
                "additionalProperties": False,
            },
        },
        "visuel": {
            "type": "object",
            "properties": {
                "type": {"type": "string", "enum": VISUAL_TYPES},
                "image": _STRING,
                "texte": _STRING,
                "legende": _STRING,
            },
            "required": ["type", "image", "texte", "legende"],
            "additionalProperties": False,
        },
    },
    "required": ["chapitre", "narration", "affirmations", "visuel"],
    "additionalProperties": False,
}

SCRIPT_SCHEMA = {
    "type": "object",
    "properties": {
        "titre": _STRING,
        "titres_alternatifs": _STRINGS,
        "accroche_miniature": _STRING,
        "resume": _STRING,
        "tags": _STRINGS,
        "scenes": {"type": "array", "items": SCENE_SCHEMA},
    },
    "required": ["titre", "titres_alternatifs", "accroche_miniature", "resume", "tags", "scenes"],
    "additionalProperties": False,
}

REVISION_SCHEMA = {
    "type": "object",
    "properties": {
        "scenes": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"index": {"type": "integer"}, "scene": SCENE_SCHEMA},
                "required": ["index", "scene"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["scenes"],
    "additionalProperties": False,
}

WORDS_PER_MINUTE = 150

TRUTH_RULES = """Règles de vérité, non négociables :
1. Chaque fait (date, lieu, nombre, événement, relation, citation, superlatif) vient d'un passage du dossier. Liste-le dans "affirmations" de sa scène avec les identifiants exacts des passages qui le prouvent (ex. "S1-P12").
2. N'invente rien pour dramatiser : pas de dialogues, pas de pensées ni d'émotions prêtées à la personne, pas de détails de décor (météo, regards, gestes) absents des sources. La force du récit vient du choix des faits, du rythme et de la mise en perspective.
3. Citations : seulement des phrases présentes mot pour mot dans un passage en français, entre « », avec qui l'a dit. Si la phrase n'existe qu'en anglais, paraphrase-la sans guillemets.
4. Dates et nombres en chiffres, exactement comme dans les sources ; ne calcule pas d'âge ni de durée qui n'y figure pas. Si deux sources se contredisent, dis-le ou laisse ce point de côté.
5. Les phrases de réflexion ou de transition (leçon, question au spectateur) sont permises si elles n'affirment aucun fait ; ne les mets pas dans "affirmations".
6. Le texte des cartes à l'écran est aussi un fait : il doit figurer dans "affirmations"."""

VISUAL_RULES = """Visuels (champ "visuel" de chaque scène) :
- "image" : id d'une image du dossier (ex. "I3") qui illustre vraiment la scène ; "texte" vide ; "legende" : courte légende factuelle ou vide.
- "carte_date" : "texte" = l'année ou la date, "legende" = ce qui s'est passé ; "image" vide.
- "carte_fait" : "texte" = un chiffre ou un fait court et marquant, "legende" = son explication ; "image" vide.
- "carte_citation" : "texte" = la citation exacte sans guillemets, "legende" = son auteur ; "image" vide.
N'utilise que des ids d'images listés dans le dossier et varie les visuels."""


def _story_brief(fmt: Format, minutes: float) -> str:
    words = int(minutes * WORDS_PER_MINUTE)
    if fmt.name == "court":
        return (
            f"Format : YouTube Shorts vertical d'environ {round(minutes * 60)} secondes "
            f"(environ {words} mots de narration). 3 à 6 scènes de 15 à 40 mots. "
            "Scène 1 : une seule phrase d'accroche, chapitre « Introduction ». "
            "Puis le cœur de l'histoire en quelques faits forts, et une dernière phrase de leçon."
        )
    scenes_min, scenes_max = max(5, int(minutes * 1.2)), max(8, int(minutes * 2))
    return (
        f"Format : vidéo YouTube d'environ {minutes:g} minutes (environ {words} mots de narration). "
        f"{scenes_min} à {scenes_max} scènes de 40 à 160 mots.\n"
        "- Scène 1 : accroche de 2 ou 3 phrases qui pose l'enjeu à partir d'un fait marquant ou d'un "
        "contraste réel, chapitre « Introduction ». Pas de « Bonjour », pas de présentation de la chaîne.\n"
        "- Ensuite : origines et contexte, obstacles, tournant, combat ou œuvre, accomplissement, héritage.\n"
        "- Dernière scène : la leçon à retenir, puis une invitation courte à s'abonner."
    )


def write_script(llm, dossier: Dossier, fmt: Format, minutes: float | None = None) -> dict:
    minutes = minutes or fmt.minutes
    task = f"""Écris le script d'une vidéo sur : {dossier.data['sujet']}.

{_story_brief(fmt, minutes)}
Si le dossier ne permet pas de tenir cette durée sans broder, fais plus court.

Écriture : langue orale, phrases courtes, vocabulaire simple. Le texte sera lu par une voix de synthèse : pas de parenthèses, d'abréviations, de listes ni de symboles. "chapitre" est le titre court du chapitre YouTube ; plusieurs scènes consécutives peuvent partager le même.

{TRUTH_RULES}

{VISUAL_RULES}

Métadonnées :
- "titre" : titre YouTube honnête et intrigant, 70 caractères au plus, sans tout en majuscules ni promesse que la vidéo ne tient pas.
- "titres_alternatifs" : 3 autres propositions.
- "accroche_miniature" : 2 à 5 mots forts pour la miniature.
- "resume" : 2 ou 3 phrases factuelles pour la description.
- "tags" : 8 à 15 mots-clés."""
    return llm.json(dossier.as_prompt(), task, SCRIPT_SCHEMA)


def revise_script(llm, dossier: Dossier, script: dict, problems: dict[int, list[str]]) -> dict:
    """Réécrit seulement les scènes signalées par la vérification."""
    listing = "\n".join(
        f"Scène {index} :\n" + "\n".join(f"  - {problem}" for problem in items)
        for index, items in sorted(problems.items())
    )
    task = f"""La vérification a trouvé des problèmes dans le script ci-dessous. Réécris uniquement les scènes listées : supprime ou corrige chaque élément signalé en t'appuyant seulement sur le dossier, garde le ton, la longueur approximative et la continuité avec les scènes voisines. Renvoie chaque scène réécrite en entier avec son index.

{TRUTH_RULES}

{VISUAL_RULES}

Problèmes :
{listing}

Script actuel :
{json.dumps(script['scenes'], ensure_ascii=False, indent=1)}"""
    result = llm.json(dossier.as_prompt(), task, REVISION_SCHEMA)
    scenes = list(script["scenes"])
    for item in result["scenes"]:
        if 0 <= item["index"] < len(scenes):
            scenes[item["index"]] = item["scene"]
    return {**script, "scenes": scenes}
