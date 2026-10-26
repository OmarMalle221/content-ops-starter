"""Voix off : synthèse vocale et repères de sous-titres."""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
from dataclasses import dataclass
from pathlib import Path

from .text import split_sentences, word_count

MAX_CUE_WORDS = 12


@dataclass
class Cue:
    start: float
    end: float
    text: str


@dataclass
class Narration:
    audio: Path
    duration: float
    cues: list[Cue]


def probe_duration(path: Path) -> float:
    output = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", str(path)],
        check=True, capture_output=True, text=True,
    ).stdout
    return float(json.loads(output)["format"]["duration"])


def split_cue(cue: Cue, max_words: int = MAX_CUE_WORDS) -> list[Cue]:
    """Coupe une phrase longue en sous-titres lisibles, au prorata des mots."""
    words = cue.text.split()
    if len(words) <= max_words:
        return [cue]
    parts = -(-len(words) // max_words)
    size = -(-len(words) // parts)
    chunks = [words[i:i + size] for i in range(0, len(words), size)]
    span, cursor, cues = cue.end - cue.start, cue.start, []
    for chunk in chunks:
        end = cursor + span * len(chunk) / len(words)
        cues.append(Cue(cursor, end, " ".join(chunk)))
        cursor = end
    return cues


class EdgeVoice:
    """Voix neuronales Microsoft Edge (gratuites, sans clé). Exemple : fr-FR-HenriNeural."""

    def __init__(self, voice: str, rate: str = "+0%"):
        self.voice, self.rate = voice, rate
        self.name = f"edge:{voice}:{rate}"

    def synthesize(self, text: str, dest: Path) -> Narration:
        cues = asyncio.run(self._run(text, dest))
        duration = probe_duration(dest)
        if not cues:
            cues = [Cue(0, duration, text)]
        return Narration(dest, duration, [part for cue in cues for part in split_cue(cue)])

    async def _run(self, text: str, dest: Path) -> list[Cue]:
        import edge_tts

        for attempt in range(3):
            cues: list[Cue] = []
            try:
                communicate = edge_tts.Communicate(
                    text, self.voice, rate=self.rate, boundary="SentenceBoundary",
                    proxy=os.environ.get("HTTPS_PROXY") or None,
                )
                with dest.open("wb") as audio:
                    async for chunk in communicate.stream():
                        if chunk["type"] == "audio":
                            audio.write(chunk["data"])
                        elif chunk["type"] == "SentenceBoundary":
                            start = chunk["offset"] / 1e7
                            cues.append(Cue(start, start + chunk["duration"] / 1e7, chunk["text"]))
                return cues
            except Exception:  # noqa: BLE001 - service distant : on réessaie puis on remonte l'erreur
                if attempt == 2:
                    raise
                await asyncio.sleep(2 ** attempt)
        return []


class SilentVoice:
    """Voix muette pour tester le montage sans réseau : durée estimée à 2,5 mots/s."""

    words_per_second = 2.5
    name = "silence"

    def synthesize(self, text: str, dest: Path) -> Narration:
        sentences = split_sentences(text) or [text]
        cues, cursor = [], 0.0
        for sentence in sentences:
            length = max(1.0, word_count(sentence) / self.words_per_second)
            cues.append(Cue(cursor, cursor + length, sentence))
            cursor += length
        dest = dest.with_suffix(".wav")
        subprocess.run(
            ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi",
             "-i", "anullsrc=r=24000:cl=mono", "-t", f"{cursor:.3f}", str(dest)],
            check=True,
        )
        return Narration(dest, cursor, [part for cue in cues for part in split_cue(cue)])


def list_french_voices() -> list[dict]:
    import edge_tts

    voices = asyncio.run(edge_tts.list_voices())
    return [voice for voice in voices if voice["Locale"].startswith("fr-")]
