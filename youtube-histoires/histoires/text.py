"""Petits utilitaires texte partagés (slug, normalisation, citations, nombres)."""

from __future__ import annotations

import html
import re
import unicodedata

_SPACES = re.compile(r"[\s   ]+")
_QUOTES = re.compile(r"«\s*(.+?)\s*»|“(.+?)”|\"(.+?)\"", re.S)
# Nombre isolé : pas collé à une lettre (exclut 1er, 3e, XXe, 4x4).
_NUMBER = re.compile(
    r"(?<![\w-])(?:\d{1,3}(?:[   .]\d{3})+(?:,\d+)?|\d+(?:,\d+)?)(?![\wÀ-ÿ])"
)

MONTHS_FR = [
    "janvier", "février", "mars", "avril", "mai", "juin",
    "juillet", "août", "septembre", "octobre", "novembre", "décembre",
]


def slugify(value: str) -> str:
    value = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode()
    value = re.sub(r"[^a-zA-Z0-9]+", "-", value).strip("-").lower()
    return value or "sujet"


def strip_html(value: str) -> str:
    value = re.sub(r"<[^>]+>", " ", value or "")
    return _SPACES.sub(" ", html.unescape(value)).strip()


def normalize(value: str) -> str:
    """Forme comparable d'un texte : casse, apostrophes, espaces, ponctuation."""
    value = unicodedata.normalize("NFKC", value).lower()
    value = value.replace("’", "'").replace("‘", "'").replace("ʼ", "'")
    value = re.sub(r"[«»“”\"…]", " ", value)
    value = re.sub(r"[^\w' ]+", " ", value)
    return _SPACES.sub(" ", value).strip()


def find_quotes(value: str, min_words: int = 3) -> list[str]:
    """Citations entre guillemets d'au moins `min_words` mots."""
    quotes = []
    for match in _QUOTES.finditer(value or ""):
        quote = next(group for group in match.groups() if group)
        if len(quote.split()) >= min_words:
            quotes.append(quote.strip())
    return quotes


def number_keys(token: str) -> set[str]:
    """Formes possibles d'un nombre écrit (30 000, 30.000, 30,000 → 30000)."""
    compact = _SPACES.sub("", token)
    return {compact, re.sub(r"[.,]", "", compact)}


def find_numbers(value: str, min_value: int = 10) -> list[str]:
    numbers = []
    for match in _NUMBER.finditer(value or ""):
        token = match.group(0).strip(" .,")
        digits = re.sub(r"\D", "", token)
        if digits and int(digits) >= min_value:
            numbers.append(token)
    return numbers


def numbers_in(value: str) -> set[str]:
    keys: set[str] = set()
    for token in find_numbers(value, min_value=0):
        keys |= number_keys(token)
    return keys


def split_sentences(value: str) -> list[str]:
    parts = re.split(r"(?<=[.!?…])\s+(?=[A-ZÀ-ÖØ-Ý«\"“0-9])", value.strip())
    return [part.strip() for part in parts if part.strip()]


def word_count(value: str) -> int:
    return len(re.findall(r"\w+", value or ""))


def format_timestamp(seconds: float) -> str:
    """Horodatage de chapitre YouTube : 0:00, 4:05, 1:02:03."""
    total = int(seconds)
    hours, rest = divmod(total, 3600)
    minutes, secs = divmod(rest, 60)
    return f"{hours}:{minutes:02d}:{secs:02d}" if hours else f"{minutes}:{secs:02d}"
