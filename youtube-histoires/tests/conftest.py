"""Données de test FICTIVES (« Awa Exemple » n'existe pas) : aucun appel réseau."""

from __future__ import annotations

import copy
import json
import sys
from pathlib import Path

import pytest
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from histoires.sources import Dossier  # noqa: E402

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture
def dossier(tmp_path: Path) -> Dossier:
    data = json.loads((FIXTURES / "dossier_fictif.json").read_text(encoding="utf-8"))
    (tmp_path / "images").mkdir()
    for number, (width, height) in enumerate([(1600, 900), (800, 1200)], start=1):
        image = Image.linear_gradient("L").resize((width, height)).convert("RGB")
        image.save(tmp_path / "images" / f"I{number}.jpg")
    return Dossier(data)


@pytest.fixture
def script() -> dict:
    return copy.deepcopy(json.loads((FIXTURES / "script_fictif.json").read_text(encoding="utf-8")))


class FakeLLM:
    """Rejoue des réponses préparées, dans l'ordre, et garde les consignes reçues."""

    def __init__(self, responses: list[dict]):
        self.responses = list(responses)
        self.tasks: list[str] = []

    def json(self, dossier_prompt: str, task: str, schema: dict, max_tokens: int = 64000) -> dict:
        self.tasks.append(task)
        return self.responses.pop(0)


@pytest.fixture
def fake_llm():
    return FakeLLM
