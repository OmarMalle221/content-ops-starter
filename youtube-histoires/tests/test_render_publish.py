import shutil
from pathlib import Path

import pytest

from histoires.config import Format
from histoires.publish import DESCRIPTION_MAX, build_metadata, chapters
from histoires.render import Segment, build_video, srt
from histoires.tts import Cue, SilentVoice, probe_duration, split_cue
from histoires.visuals import Fonts


def _segments(spec):
    segments, cursor = [], 0.0
    for chapter, duration in spec:
        segments.append(Segment("scene", chapter, duration, Path("x.mp4"), start=cursor))
        cursor += duration
    return segments


def test_chapters_follow_youtube_rules():
    segments = _segments([("Introduction", 12), ("Introduction", 3), ("Origines", 40), ("Bref", 4),
                          ("Combat", 60), ("Sources", 5)])
    result = chapters(segments)
    assert result[0] == (0.0, "Introduction")
    assert [name for _, name in result] == ["Introduction", "Origines", "Combat"]
    assert chapters(_segments([("A", 30), ("B", 30)])) == []


def test_split_cue_and_srt():
    cue = Cue(0.0, 6.0, " ".join(f"mot{i}" for i in range(30)))
    parts = split_cue(cue)
    assert len(parts) == 3 and parts[-1].end == pytest.approx(6.0)
    segment = Segment("scene", "A", 7.0, Path("x"), cues=parts, start=10.0)
    text = srt([segment])
    assert text.startswith("1\n00:00:10,300 --> 00:00:12,300\n")


def test_metadata_has_sources_credits_and_limits(dossier, script):
    segments = _segments([("Introduction", 20), ("Les origines", 30), ("Le combat", 30), ("L'héritage", 30)])
    meta = build_metadata(dossier, script, segments, "Chaîne Test")
    description = meta["description"]
    assert "0:00 Introduction" in description
    assert "https://fr.wikipedia.org/w/index.php?oldid=1" in description
    assert "Auteur Test — CC BY-SA 4.0" in description
    assert "Transparence" in description
    assert len(description) <= DESCRIPTION_MAX and len(meta["titre"]) <= 100

    script["resume"] = "x" * 6000
    assert len(build_metadata(dossier, script, segments, "Chaîne Test")["description"]) <= DESCRIPTION_MAX


@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="ffmpeg absent")
def test_full_render_offline(dossier, script, tmp_path):
    tiny = Format("test", 320, 180, 1)
    segments = build_video(tmp_path, dossier, script, tiny, SilentVoice(), "Chaîne Test", Fonts.find(),
                           log=lambda *_: None)
    video = tmp_path / "video.mp4"
    assert video.is_file()
    expected = sum(segment.duration for segment in segments)
    assert probe_duration(video) == pytest.approx(expected, abs=0.5)
    assert [s.kind for s in segments][:2] == ["scene", "titre"] and segments[-1].kind == "fin"
    assert (tmp_path / "sous-titres.srt").read_text(encoding="utf-8").startswith("1\n")
    assert (tmp_path / "miniature.jpg").is_file()
