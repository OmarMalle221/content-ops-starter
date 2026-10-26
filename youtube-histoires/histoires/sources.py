"""Recherche : construit le dossier de sources réelles d'un sujet.

Sources utilisées, toutes publiques et traçables :
- Wikipédia (fr, puis en) : texte intégral de l'article, découpé en passages numérotés,
  avec l'identifiant de révision pour pouvoir citer la version exacte consultée ;
- Wikidata : faits structurés (dates, lieux, distinctions, fonctions…) ;
- Wikimedia Commons : images sous licence libre, avec auteur et licence pour les crédits ;
- vos propres fichiers texte (articles, interviews) passés avec --source.
"""

from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .text import MONTHS_FR, split_sentences, strip_html

COMMONS_API = "https://commons.wikimedia.org/w/api.php"
WIKIDATA_API = "https://www.wikidata.org/w/api.php"

SKIPPED_SECTIONS = {
    "notes et références", "références", "notes", "liens externes", "bibliographie",
    "voir aussi", "articles connexes", "annexes", "filmographie", "discographie",
    "publications", "œuvres", "references", "external links", "further reading",
    "see also", "notes and references", "bibliography", "sources", "citations",
}

# Propriétés Wikidata retenues (personnes et événements).
WIKIDATA_PROPERTIES = {
    "P569": "Date de naissance",
    "P19": "Lieu de naissance",
    "P570": "Date de décès",
    "P20": "Lieu de décès",
    "P27": "Nationalité",
    "P1412": "Langues parlées",
    "P106": "Professions",
    "P69": "Études",
    "P108": "Employeurs",
    "P39": "Fonctions occupées",
    "P463": "Membre de",
    "P54": "Équipes sportives",
    "P166": "Distinctions reçues",
    "P800": "Œuvres ou réalisations notables",
    "P1449": "Surnoms",
    "P585": "Date",
    "P580": "Début",
    "P582": "Fin",
    "P276": "Lieu",
    "P17": "Pays",
}
QUALIFIERS = ("P585", "P580", "P582")

LICENSE_OK = re.compile(r"^(cc0|public domain|pd\b|pd-|cc[ -]by(?:-sa)?[ -]?\d|attribution)", re.I)
MIN_IMAGE_WIDTH = 640
IMAGE_WIDTH = 1920  # largeur de vignette standard Wikimedia


class SourceError(RuntimeError):
    pass


class Http:
    """Client HTTP minimal avec User-Agent identifiable et nouvelles tentatives."""

    def __init__(self, user_agent: str):
        import requests

        self._requests = requests
        self.session = requests.Session()
        self.session.headers["User-Agent"] = user_agent

    def get_json(self, url: str, **params: Any) -> dict:
        params.setdefault("format", "json")
        params.setdefault("formatversion", "2")
        for attempt in range(4):
            try:
                response = self.session.get(url, params=params, timeout=30)
            except self._requests.RequestException as error:
                if attempt == 3:
                    raise SourceError(f"Impossible de joindre {url} : {error}") from error
            else:
                if response.status_code == 200:
                    return response.json()
                if response.status_code not in (429, 500, 502, 503, 504) or attempt == 3:
                    raise SourceError(f"{url} a répondu {response.status_code}")
            time.sleep(2 ** attempt)
        raise AssertionError("inaccessible")

    def download(self, url: str, dest: Path) -> None:
        response = self.session.get(url, timeout=60)
        if response.status_code != 200:
            raise SourceError(f"Téléchargement impossible ({response.status_code}) : {url}")
        dest.write_bytes(response.content)


@dataclass
class Dossier:
    data: dict

    @property
    def passages(self) -> dict[str, dict]:
        return {p["id"]: p for p in self.data["passages"]}

    @property
    def sources(self) -> dict[str, dict]:
        return {s["id"]: s for s in self.data["sources"]}

    @property
    def images(self) -> dict[str, dict]:
        return {i["id"]: i for i in self.data["images"]}

    def save(self, path: Path) -> None:
        path.write_text(json.dumps(self.data, ensure_ascii=False, indent=2), encoding="utf-8")

    @classmethod
    def load(cls, path: Path) -> "Dossier":
        return cls(json.loads(path.read_text(encoding="utf-8")))

    def as_prompt(self) -> str:
        """Le dossier tel que l'IA le lit : sources, passages, images."""
        lines = [f"# DOSSIER DE SOURCES — {self.data['sujet']}", "", "## Sources"]
        for source in self.data["sources"]:
            lines.append(f"[{source['id']}] {source['titre']} — {source['url']}")
        lines += ["", "## Passages"]
        for passage in self.data["passages"]:
            section = f" · {passage['section']}" if passage.get("section") else ""
            lines.append(f"[{passage['id']}] ({passage['source']}{section}) {passage['texte']}")
        lines += ["", "## Images disponibles (Wikimedia Commons)"]
        for image in self.data["images"]:
            details = " — ".join(
                part for part in (image["titre"], image.get("description"), image.get("date")) if part
            )
            lines.append(f"[{image['id']}] {details}")
        if not self.data["images"]:
            lines.append("(aucune image libre trouvée : utilise des cartes)")
        return "\n".join(lines)


# --- Wikipédia ---------------------------------------------------------------


def parse_extract(extract: str) -> list[tuple[str, str]]:
    """Découpe un extrait « explaintext » en (section, paragraphe), sans les annexes."""
    section, skipping = "", False
    paragraphs: list[tuple[str, str]] = []
    for raw in extract.splitlines():
        line = raw.strip()
        heading = re.match(r"^(=+)\s*(.+?)\s*\1$", line)
        if heading:
            level, title = len(heading.group(1)), heading.group(2)
            if level == 2:
                section = title
                skipping = title.lower() in SKIPPED_SECTIONS
            elif not skipping and title.lower() in SKIPPED_SECTIONS:
                skipping = True
            continue
        if skipping or len(line) < 25:
            continue
        for chunk in _chunk(line):
            paragraphs.append((section or "Introduction", chunk))
    return paragraphs


def _chunk(paragraph: str, limit: int = 900) -> list[str]:
    if len(paragraph) <= limit:
        return [paragraph]
    chunks, current = [], ""
    for sentence in split_sentences(paragraph):
        if current and len(current) + len(sentence) > limit:
            chunks.append(current)
            current = sentence
        else:
            current = f"{current} {sentence}".strip()
    if current:
        chunks.append(current)
    return chunks


def find_wikipedia_title(http: Http, lang: str, subject: str) -> str | None:
    data = http.get_json(
        f"https://{lang}.wikipedia.org/w/api.php",
        action="query", list="search", srsearch=subject, srlimit=1, srnamespace=0,
    )
    hits = data.get("query", {}).get("search", [])
    return hits[0]["title"] if hits else None


def fetch_wikipedia(http: Http, lang: str, title: str) -> dict:
    data = http.get_json(
        f"https://{lang}.wikipedia.org/w/api.php",
        action="query", titles=title, redirects=1,
        prop="extracts|pageprops|revisions|info",
        explaintext=1, exsectionformat="wiki", ppprop="wikibase_item",
        rvprop="ids|timestamp", inprop="url",
    )
    page = data["query"]["pages"][0]
    if page.get("missing"):
        raise SourceError(f"Page Wikipédia ({lang}) introuvable : {title}")
    revision = page["revisions"][0]
    return {
        "titre": page["title"],
        "extrait": page.get("extract", ""),
        "qid": page.get("pageprops", {}).get("wikibase_item"),
        "revision": revision["revid"],
        "revision_date": revision.get("timestamp", ""),
        "url": page["fullurl"],
    }


# --- Wikidata ----------------------------------------------------------------


def format_wikidata_time(value: dict) -> str:
    """'+1940-04-01T00:00:00Z' (précision 11) → '1er avril 1940'."""
    match = re.match(r"([+-])(\d+)-(\d\d)-(\d\d)", value["time"])
    if not match:
        return value["time"]
    sign, year, month, day = match.group(1), int(match.group(2)), int(match.group(3)), int(match.group(4))
    precision = value.get("precision", 11)
    era = " av. J.-C." if sign == "-" else ""
    if precision >= 11 and month and day:
        day_label = "1er" if day == 1 else str(day)
        return f"{day_label} {MONTHS_FR[month - 1]} {year}{era}"
    if precision == 10 and month:
        return f"{MONTHS_FR[month - 1]} {year}{era}"
    if precision == 9:
        return f"{year}{era}"
    if precision == 8:
        return f"années {year // 10 * 10}{era}"
    century = (year - 1) // 100 + 1
    return f"{century}e siècle{era}"


def _label(entity: dict) -> str:
    labels = entity.get("labels", {})
    for lang in ("fr", "en"):
        if lang in labels:
            return labels[lang]["value"]
    return entity.get("id", "")


def _snak_value(snak: dict, labels: dict[str, str]) -> str | None:
    if snak.get("snaktype") != "value":
        return None
    datavalue = snak["datavalue"]
    kind, value = datavalue["type"], datavalue["value"]
    if kind == "wikibase-entityid":
        return labels.get(value["id"], value["id"])
    if kind == "time":
        return format_wikidata_time(value)
    if kind == "monolingualtext":
        return value["text"]
    if kind == "quantity":
        return value["amount"].lstrip("+")
    if kind == "string":
        return value
    return None


def _entity_ids(claims: dict) -> set[str]:
    ids = set()
    for prop in WIKIDATA_PROPERTIES:
        for claim in claims.get(prop, []):
            snak = claim["mainsnak"]
            if snak.get("snaktype") == "value" and snak["datavalue"]["type"] == "wikibase-entityid":
                ids.add(snak["datavalue"]["value"]["id"])
    return ids


def wikidata_facts(entity: dict, labels: dict[str, str]) -> list[tuple[str, str]]:
    """Faits lisibles (libellé, valeurs) à partir d'une entité Wikidata."""
    facts = []
    claims = entity.get("claims", {})
    for prop, label in WIKIDATA_PROPERTIES.items():
        values = []
        for claim in claims.get(prop, []):
            if claim.get("rank") == "deprecated":
                continue
            value = _snak_value(claim["mainsnak"], labels)
            if not value:
                continue
            dates = []
            for qualifier in QUALIFIERS:
                for snak in claim.get("qualifiers", {}).get(qualifier, []):
                    qualifier_value = _snak_value(snak, labels)
                    if qualifier_value:
                        dates.append(qualifier_value)
            values.append(f"{value} ({' – '.join(dates)})" if dates else value)
        if values:
            facts.append((label, " ; ".join(dict.fromkeys(values))))
    return facts


def fetch_wikidata(http: Http, qid: str) -> dict:
    data = http.get_json(
        WIKIDATA_API, action="wbgetentities", ids=qid,
        props="claims|labels|descriptions|sitelinks", languages="fr|en",
    )
    entity = data["entities"][qid]
    if "missing" in entity:
        raise SourceError(f"Entité Wikidata introuvable : {qid}")
    ids = sorted(_entity_ids(entity.get("claims", {})))
    labels: dict[str, str] = {}
    for start in range(0, len(ids), 50):
        batch = http.get_json(
            WIKIDATA_API, action="wbgetentities", ids="|".join(ids[start:start + 50]),
            props="labels", languages="fr|en",
        )
        labels.update({key: _label(value) for key, value in batch["entities"].items()})
    entity["_labels"] = labels
    return entity


def _claim_strings(entity: dict, prop: str) -> list[str]:
    values = []
    for claim in entity.get("claims", {}).get(prop, []):
        snak = claim["mainsnak"]
        if snak.get("snaktype") == "value" and snak["datavalue"]["type"] == "string":
            values.append(snak["datavalue"]["value"])
    return values


# --- Wikimedia Commons -------------------------------------------------------


def image_from_info(page: dict) -> dict | None:
    """Fiche image (licence, auteur, URL) ou None si inutilisable."""
    info = (page.get("imageinfo") or [None])[0]
    if not info or info.get("mime") not in ("image/jpeg", "image/png"):
        return None
    if info.get("width", 0) < MIN_IMAGE_WIDTH:
        return None
    meta = {key: strip_html(str(value.get("value", ""))) for key, value in info.get("extmetadata", {}).items()}
    license_name = meta.get("LicenseShortName", "")
    if not LICENSE_OK.match(license_name):
        return None
    title = page["title"]
    return {
        "fichier": title,
        "titre": re.sub(r"\.(jpe?g|png)$", "", title.removeprefix("File:"), flags=re.I),
        "description": meta.get("ImageDescription", "")[:300],
        "date": meta.get("DateTimeOriginal", "")[:40],
        "auteur": meta.get("Artist") or meta.get("Credit") or "Auteur inconnu",
        "licence": license_name,
        "licence_url": meta.get("LicenseUrl", ""),
        "restrictions": meta.get("Restrictions", ""),
        "url": info.get("thumburl") or info["url"],
        "url_page": info.get("descriptionurl", ""),
        "largeur": info.get("width"),
        "hauteur": info.get("height"),
    }


def fetch_commons_images(http: Http, files: list[str], category: str | None, limit: int) -> list[dict]:
    titles = [f if f.startswith("File:") else f"File:{f}" for f in files]
    if category:
        data = http.get_json(
            COMMONS_API, action="query", list="categorymembers",
            cmtitle=f"Category:{category}", cmtype="file", cmlimit=50,
        )
        titles += [member["title"] for member in data.get("query", {}).get("categorymembers", [])]
    titles = list(dict.fromkeys(titles))
    images: list[dict] = []
    for start in range(0, len(titles), 50):
        if len(images) >= limit:
            break
        data = http.get_json(
            COMMONS_API, action="query", titles="|".join(titles[start:start + 50]),
            prop="imageinfo", iiprop="url|size|mime|extmetadata", iiurlwidth=IMAGE_WIDTH,
            iiextmetadatalanguage="fr",
            iiextmetadatafilter="LicenseShortName|LicenseUrl|Artist|Credit|ImageDescription|DateTimeOriginal|Restrictions",
        )
        query = data.get("query", {})
        pages = {page["title"]: page for page in query.get("pages", [])}
        renamed = {item["from"]: item["to"] for item in query.get("normalized", [])}
        for title in titles[start:start + 50]:
            page = pages.get(renamed.get(title, title))
            image = image_from_info(page) if page else None
            if image:
                images.append(image)
    return images[:limit]


# --- Sources personnelles ----------------------------------------------------


def read_local_source(path: Path) -> tuple[dict, list[str]]:
    """Fichier texte : en-têtes facultatifs « Titre: », « URL: », « Date: » puis le texte."""
    meta = {"titre": path.stem, "url": "", "date": ""}
    lines = path.read_text(encoding="utf-8").splitlines()
    while lines and re.match(r"^(titre|url|date|auteur)\s*:", lines[0], re.I):
        key, value = lines.pop(0).split(":", 1)
        meta[key.strip().lower()] = value.strip()
    text = "\n".join(lines)
    paragraphs = [re.sub(r"\s+", " ", p).strip() for p in re.split(r"\n\s*\n", text)]
    return meta, [chunk for p in paragraphs if len(p) >= 25 for chunk in _chunk(p)]


# --- Assemblage --------------------------------------------------------------


def build_dossier(
    http: Http,
    subject: str,
    project_dir: Path,
    languages: tuple[str, ...] = ("fr", "en"),
    local_sources: tuple[Path, ...] = (),
    image_limit: int = 15,
    log=print,
) -> Dossier:
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    sources: list[dict] = []
    passages: list[dict] = []

    def add_source(entry: dict, texts: list[tuple[str, str]]) -> None:
        source_id = f"S{len(sources) + 1}"
        sources.append({"id": source_id, "consulte_le": now, **entry})
        for number, (section, text) in enumerate(texts, start=1):
            passages.append({"id": f"{source_id}-P{number}", "source": source_id, "section": section, "texte": text})

    # 1. Trouver l'article principal et l'entité Wikidata (sujet en clair ou identifiant Q…).
    qid = subject if re.fullmatch(r"Q\d+", subject) else None
    pages: dict[str, dict] = {}
    if qid:
        entity = fetch_wikidata(http, qid)
    else:
        title = find_wikipedia_title(http, languages[0], subject)
        if not title:
            raise SourceError(f"Aucun article Wikipédia ({languages[0]}) trouvé pour « {subject} ».")
        pages[languages[0]] = fetch_wikipedia(http, languages[0], title)
        main_qid = pages[languages[0]]["qid"]
        entity = fetch_wikidata(http, main_qid) if main_qid else None

    # 2. Articles Wikipédia dans les autres langues, via les liens Wikidata.
    for lang in languages:
        link = (entity or {}).get("sitelinks", {}).get(f"{lang}wiki")
        if lang not in pages and link:
            pages[lang] = fetch_wikipedia(http, lang, link["title"])
    if not pages:
        raise SourceError(f"Aucun article Wikipédia lié à {subject}.")
    for lang in languages:
        if lang not in pages:
            continue
        page = pages[lang]
        texts = parse_extract(page["extrait"])
        add_source(
            {
                "type": "wikipedia",
                "langue": lang,
                "titre": f"Wikipédia ({lang}) — {page['titre']} (révision {page['revision']} du {page['revision_date'][:10]})",
                "url": f"https://{lang}.wikipedia.org/w/index.php?oldid={page['revision']}",
                "licence": "CC BY-SA 4.0",
            },
            texts,
        )
        log(f"  Wikipédia ({lang}) : « {page['titre']} », {len(texts)} passages")

    # 3. Faits Wikidata.
    images: list[dict] = []
    if entity:
        labels = entity.pop("_labels", {})
        description = entity.get("descriptions", {}).get("fr", entity.get("descriptions", {}).get("en", {}))
        facts = wikidata_facts(entity, labels)
        texts = [("Wikidata", f"{label} : {value}") for label, value in facts]
        if description:
            texts.insert(0, ("Wikidata", f"Description : {_label(entity)}, {description['value']}"))
        add_source(
            {
                "type": "wikidata",
                "titre": f"Wikidata — {_label(entity)} ({entity['id']})",
                "url": f"https://www.wikidata.org/wiki/{entity['id']}",
                "licence": "CC0",
            },
            texts,
        )
        log(f"  Wikidata {entity['id']} : {_label(entity)} — {description.get('value', 'sans description')}"
            f" ({len(facts)} propriétés)")
        category = (_claim_strings(entity, "P373") or [None])[0]
        images = fetch_commons_images(http, _claim_strings(entity, "P18"), category, image_limit)

    # 4. Sources personnelles.
    for path in local_sources:
        meta, chunks = read_local_source(path)
        title = meta["titre"] + (f" ({meta['date']})" if meta.get("date") else "")
        add_source(
            {"type": "personnelle", "titre": title, "url": meta.get("url", ""), "licence": ""},
            [("", chunk) for chunk in chunks],
        )
        log(f"  Source personnelle « {meta['titre']} » : {len(chunks)} passages")

    if not passages:
        raise SourceError("Le dossier est vide : aucune source exploitable.")

    # 5. Téléchargement des images.
    image_dir = project_dir / "images"
    image_dir.mkdir(parents=True, exist_ok=True)
    kept = []
    for image in images:
        image_id = f"I{len(kept) + 1}"
        suffix = ".png" if image["url"].lower().endswith(".png") else ".jpg"
        dest = image_dir / f"{image_id}{suffix}"
        try:
            http.download(image["url"], dest)
        except SourceError as error:
            log(f"  Image ignorée ({error})")
            continue
        kept.append({"id": image_id, "chemin": str(dest.relative_to(project_dir)), **image})
    log(f"  Wikimedia Commons : {len(kept)} images libres")

    return Dossier(
        {
            "sujet": _label(entity) if entity else next(iter(pages.values()))["titre"],
            "wikidata": entity["id"] if entity else None,
            "genere_le": now,
            "sources": sources,
            "passages": passages,
            "images": kept,
        }
    )
