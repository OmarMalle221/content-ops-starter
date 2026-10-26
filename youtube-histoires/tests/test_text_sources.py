from pathlib import Path

from histoires.sources import (
    build_dossier, format_wikidata_time, image_from_info, parse_extract, wikidata_facts,
)
from histoires.text import find_numbers, find_quotes, format_timestamp, number_keys, slugify


def test_text_helpers():
    assert slugify("Wangari Maathai") == "wangari-maathai"
    assert find_quotes("Elle dit : « Un arbre planté aujourd'hui » puis « oui ».") == ["Un arbre planté aujourd'hui"]
    assert find_numbers("Le 1er avril 1977, 1978 et 30 000 arbres, au XXe siècle, 3e prix") == ["1977", "1978", "30 000"]
    assert number_keys("30 000") & number_keys("30,000")
    assert format_timestamp(0) == "0:00"
    assert format_timestamp(245.9) == "4:05"
    assert format_timestamp(3723) == "1:02:03"


def test_parse_extract_skips_annexes_and_chunks():
    long_paragraph = " ".join(f"Phrase numéro {i} assez longue pour remplir le passage." for i in range(40))
    extract = (
        "Introduction assez longue pour être gardée dans le dossier.\n\n"
        "== Biographie ==\n=== Enfance ===\nElle grandit dans un village au bord du fleuve.\n"
        f"{long_paragraph}\n"
        "== Notes et références ==\nRéférence 1 qui ne doit jamais apparaître ici.\n"
        "== Héritage ==\nSon œuvre continue aujourd'hui dans plusieurs pays."
    )
    passages = parse_extract(extract)
    sections = [section for section, _ in passages]
    assert sections[0] == "Introduction"
    assert "Notes et références" not in sections
    assert sections[-1] == "Héritage"
    assert all(len(text) <= 900 for _, text in passages)
    assert not any("Référence 1" in text for _, text in passages)


def test_wikidata_time_precisions():
    assert format_wikidata_time({"time": "+1940-04-01T00:00:00Z", "precision": 11}) == "1er avril 1940"
    assert format_wikidata_time({"time": "+2011-09-25T00:00:00Z", "precision": 11}) == "25 septembre 2011"
    assert format_wikidata_time({"time": "+1960-00-00T00:00:00Z", "precision": 9}) == "1960"
    assert format_wikidata_time({"time": "-0500-00-00T00:00:00Z", "precision": 9}) == "500 av. J.-C."


def _item(qid):
    return {"snaktype": "value", "datavalue": {"type": "wikibase-entityid", "value": {"id": qid}}}


def _time(value):
    return {"snaktype": "value", "datavalue": {"type": "time", "value": {"time": value, "precision": 9}}}


def test_wikidata_facts_with_qualifiers_and_ranks():
    entity = {"claims": {
        "P166": [
            {"mainsnak": _item("Q35637"), "rank": "normal", "qualifiers": {"P585": [_time("+2004-00-00T00:00:00Z")]}},
            {"mainsnak": _item("Q999"), "rank": "deprecated"},
        ],
        "P106": [{"mainsnak": _item("Q864503"), "rank": "normal"}],
    }}
    facts = dict(wikidata_facts(entity, {"Q35637": "prix Nobel de la paix", "Q864503": "biologiste"}))
    assert facts["Distinctions reçues"] == "prix Nobel de la paix (2004)"
    assert facts["Professions"] == "biologiste"


def _commons_page(title, license_name, width=2000, mime="image/jpeg"):
    return {"title": title, "imageinfo": [{
        "mime": mime, "width": width, "height": 1500, "url": f"https://up/{title}",
        "thumburl": f"https://up/thumb/{title}", "descriptionurl": f"https://commons/{title}",
        "extmetadata": {
            "LicenseShortName": {"value": license_name},
            "Artist": {"value": "<a href='x'>Jane Photographe</a>"},
            "ImageDescription": {"value": "<p>Portrait en 2001</p>"},
        },
    }]}


def test_image_license_filter():
    image = image_from_info(_commons_page("File:Portrait.jpg", "CC BY-SA 3.0"))
    assert image["auteur"] == "Jane Photographe"
    assert image["description"] == "Portrait en 2001"
    assert image["titre"] == "Portrait"
    assert image_from_info(_commons_page("File:A.jpg", "Public domain"))
    assert image_from_info(_commons_page("File:B.jpg", "GFDL")) is None
    assert image_from_info(_commons_page("File:C.jpg", "CC BY 4.0", width=300)) is None
    assert image_from_info(_commons_page("File:D.svg", "CC0", mime="image/svg+xml")) is None


class FakeHttp:
    """Répond comme les API Wikimedia, à partir des paramètres de la requête."""

    def __init__(self):
        self.downloads = []

    def get_json(self, url, **params):
        if "wikipedia.org" in url and params.get("list") == "search":
            return {"query": {"search": [{"title": "Awa Exemple"}]}}
        if "wikipedia.org" in url:
            lang = url.split("//")[1][:2]
            return {"query": {"pages": [{
                "title": params["titles"], "fullurl": f"https://{lang}.wikipedia.org/wiki/x",
                "extract": f"Paragraphe d'introduction en {lang} assez long pour être gardé.",
                "pageprops": {"wikibase_item": "Q0"}, "revisions": [{"revid": 42, "timestamp": "2026-10-01T00:00:00Z"}],
            }]}}
        if "wikidata.org" in url and params["props"] == "labels":
            return {"entities": {"Q5": {"id": "Q5", "labels": {"fr": {"value": "agronome"}}}}}
        if "wikidata.org" in url:
            return {"entities": {"Q0": {
                "id": "Q0", "labels": {"fr": {"value": "Awa Exemple"}},
                "descriptions": {"fr": {"value": "agronome fictive"}},
                "sitelinks": {"frwiki": {"title": "Awa Exemple"}, "enwiki": {"title": "Awa Example"}},
                "claims": {
                    "P106": [{"mainsnak": _item("Q5"), "rank": "normal"}],
                    "P18": [{"mainsnak": {"snaktype": "value", "datavalue": {"type": "string", "value": "Portrait.jpg"}}}],
                    "P373": [{"mainsnak": {"snaktype": "value", "datavalue": {"type": "string", "value": "Awa Exemple"}}}],
                },
            }}}
        if params.get("list") == "categorymembers":
            return {"query": {"categorymembers": [{"title": "File:Portrait.jpg"}, {"title": "File:Signature.png"}]}}
        if params.get("prop") == "imageinfo":
            return {"query": {"pages": [
                _commons_page("File:Portrait.jpg", "CC BY-SA 4.0"),
                _commons_page("File:Signature.png", "GFDL", mime="image/png"),
            ]}}
        raise AssertionError(f"requête inattendue : {url} {params}")

    def download(self, url, dest: Path):
        self.downloads.append(url)
        dest.write_bytes(b"jpeg")


def test_build_dossier_end_to_end(tmp_path):
    http = FakeHttp()
    dossier = build_dossier(http, "Awa Exemple", tmp_path, log=lambda *_: None)
    data = dossier.data
    assert [s["type"] for s in data["sources"]] == ["wikipedia", "wikipedia", "wikidata"]
    assert data["sources"][0]["url"] == "https://fr.wikipedia.org/w/index.php?oldid=42"
    assert "S3-P2" in dossier.passages and dossier.passages["S3-P2"]["texte"] == "Professions : agronome"
    assert [image["id"] for image in data["images"]] == ["I1"]  # la signature GFDL est écartée
    assert (tmp_path / "images" / "I1.jpg").is_file()
    prompt = dossier.as_prompt()
    assert "[S1-P1]" in prompt and "[I1] Portrait" in prompt
