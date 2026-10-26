"""Réglages lus dans l'environnement (voir .env.example)."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


def _load_dotenv(path: Path) -> None:
    """Charge un fichier .env simple (CLE=valeur) sans écraser l'environnement."""
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip("\"'"))


_load_dotenv(Path.cwd() / ".env")


def _env(name: str, default: str) -> str:
    return os.environ.get(name) or default


@dataclass(frozen=True)
class Format:
    name: str
    width: int
    height: int
    minutes: float

    @property
    def vertical(self) -> bool:
        return self.height > self.width


FORMATS = {
    "long": Format("long", 1920, 1080, 8),
    "court": Format("court", 1080, 1920, 0.85),
}


@dataclass(frozen=True)
class Settings:
    model: str = field(default_factory=lambda: _env("HISTOIRES_MODELE", "claude-opus-5-5"))
    effort: str = field(default_factory=lambda: _env("HISTOIRES_EFFORT", "high"))
    voice: str = field(default_factory=lambda: _env("HISTOIRES_VOIX", "fr-FR-HenriNeural"))
    voice_rate: str = field(default_factory=lambda: _env("HISTOIRES_DEBIT_VOIX", "-4%"))
    font: str = field(default_factory=lambda: _env("HISTOIRES_POLICE", ""))
    font_bold: str = field(default_factory=lambda: _env("HISTOIRES_POLICE_GRASSE", ""))
    projects_dir: Path = field(default_factory=lambda: Path(_env("HISTOIRES_PROJETS", "projets")))
    channel_name: str = field(default_factory=lambda: _env("HISTOIRES_CHAINE", "Histoires Vraies"))
    # Wikimedia demande un User-Agent qui permet de vous contacter.
    contact: str = field(
        default_factory=lambda: _env(
            "HISTOIRES_CONTACT", "https://github.com/omarmalle221/content-ops-starter"
        )
    )

    @property
    def user_agent(self) -> str:
        return f"youtube-histoires/0.1 ({self.contact})"
