"""Montage : voix off + images animées (effet Ken Burns) → MP4, sous-titres, miniature."""

from __future__ import annotations

import json
import math
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

from .config import Format
from .sources import Dossier
from .tts import Cue, Narration
from .visuals import (
    Fonts, photo_credit, prepare_photo, render_card, render_outro, render_overlay, render_thumbnail, render_title,
)

ZOOM_SOURCE = 1.5  # images préparées plus grandes que la vidéo pour un zoom fluide
LEAD, TAIL, FADE = 0.3, 0.6, 0.35
TITLE_SECONDS, OUTRO_SECONDS = 3.0, 5.0


@dataclass
class Segment:
    kind: str  # scene | titre | fin
    chapter: str
    duration: float
    file: Path
    index: int | None = None
    cues: list[Cue] = field(default_factory=list)
    start: float = 0.0


def run_ffmpeg(args: list[str], cwd: Path | None = None) -> None:
    result = subprocess.run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", *args],
                            cwd=cwd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg a échoué : {result.stderr.strip()[-1500:]}")


def _ken_burns(index: int, frames: int, card: bool) -> tuple[str, str, str]:
    center_x, center_y = "(iw-iw/zoom)/2", "(ih-ih/zoom)/2"
    if card:
        return f"1+0.04*on/{frames}", center_x, center_y
    return [
        (f"1+0.10*on/{frames}", center_x, center_y),
        (f"1.10-0.10*on/{frames}", center_x, center_y),
        ("1.10", f"(iw-iw/zoom)*on/{frames}", center_y),
        ("1.10", f"(iw-iw/zoom)*(1-on/{frames})", center_y),
    ][index % 4]


def render_clip(background: Path, overlay: Path, audio: Path | None, duration: float, out: Path,
                width: int, height: int, fps: int, preset: str, motion: int = 0, card: bool = True) -> float:
    """Un plan : image animée + calque + voix (ou silence). Renvoie la durée exacte."""
    frames = math.ceil(duration * fps)
    duration = frames / fps
    zoom, x, y = _ken_burns(motion, frames, card)
    audio_input = ["-i", str(audio)] if audio else ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"]
    lead_ms = int(LEAD * 1000) if audio else 0
    graph = (
        f"[0:v]zoompan=z='{zoom}':x='{x}':y='{y}':d={frames}:s={width}x{height}:fps={fps},setsar=1[bg];"
        f"[bg][1:v]overlay=0:0[ov];"
        f"[ov]fade=t=in:st=0:d={FADE},fade=t=out:st={duration - FADE:.3f}:d={FADE},format=yuv420p[v];"
        f"[2:a]aresample=48000,aformat=channel_layouts=stereo,adelay={lead_ms}|{lead_ms},apad[a]"
    )
    run_ffmpeg([
        "-i", str(background), "-i", str(overlay), *audio_input,
        "-filter_complex", graph, "-map", "[v]", "-map", "[a]", "-t", f"{duration:.3f}", "-r", str(fps),
        "-c:v", "libx264", "-preset", preset, "-crf", "20", "-c:a", "aac", "-b:a", "192k", str(out),
    ])
    return duration


def _narrate(voice, text: str, dest: Path) -> Narration:
    """Synthèse avec cache : on ne régénère la voix que si le texte ou la voix change."""
    sidecar = dest.with_suffix(".json")
    if sidecar.is_file():
        cached = json.loads(sidecar.read_text(encoding="utf-8"))
        audio = Path(cached["audio"])
        if cached["text"] == text and cached["voice"] == voice.name and audio.is_file():
            return Narration(audio, cached["duration"], [Cue(**cue) for cue in cached["cues"]])
    narration = voice.synthesize(text, dest)
    sidecar.write_text(json.dumps({
        "text": text, "voice": voice.name, "audio": str(narration.audio), "duration": narration.duration,
        "cues": [cue.__dict__ for cue in narration.cues],
    }, ensure_ascii=False), encoding="utf-8")
    return narration


def srt(segments: list[Segment]) -> str:
    def stamp(seconds: float) -> str:
        millis = int(round(seconds * 1000))
        hours, millis = divmod(millis, 3_600_000)
        minutes, millis = divmod(millis, 60_000)
        secs, millis = divmod(millis, 1000)
        return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"

    blocks, number = [], 1
    for segment in segments:
        for cue in segment.cues:
            start, end = segment.start + LEAD + cue.start, segment.start + LEAD + cue.end
            blocks.append(f"{number}\n{stamp(start)} --> {stamp(end)}\n{cue.text}\n")
            number += 1
    return "\n".join(blocks)


def build_video(project_dir: Path, dossier: Dossier, script: dict, fmt: Format, voice, channel: str,
                fonts: Fonts, draft: bool = False, music: Path | None = None, burn_subtitles: bool = False,
                log=print) -> list[Segment]:
    width, height = (fmt.width * 2 // 3, fmt.height * 2 // 3) if draft else (fmt.width, fmt.height)
    fps, preset = (25, "veryfast") if draft else (30, "medium")
    big = (int(width * ZOOM_SOURCE), int(height * ZOOM_SOURCE))
    build = project_dir / "build"
    for name in ("audio", "images", "plans"):
        (build / name).mkdir(parents=True, exist_ok=True)
    images = dossier.images

    def frame_paths(name: str) -> tuple[Path, Path]:
        return build / "images" / f"{name}.png", build / "images" / f"{name}_calque.png"

    segments: list[Segment] = []
    for index, scene in enumerate(script["scenes"]):
        log(f"  Plan {index + 1}/{len(script['scenes'])} : {scene['chapitre']}")
        narration = _narrate(voice, scene["narration"], build / "audio" / f"scene_{index:02d}.mp3")
        background, overlay = frame_paths(f"scene_{index:02d}")
        visual = scene["visuel"]
        image = images.get(visual["image"]) if visual["type"] == "image" else None
        if image:
            prepare_photo(project_dir / image["chemin"], *big).save(background)
            render_overlay(width, height, fonts, scene["chapitre"], visual["legende"], photo_credit(image)).save(overlay)
        else:
            kind = visual["type"] if visual["type"] != "image" else "carte_fait"
            text = visual["texte"] or scene["chapitre"]
            render_card(kind, text, visual["legende"], *big, fonts).save(background)
            render_overlay(width, height, fonts, scene["chapitre"]).save(overlay)
        clip = build / "plans" / f"scene_{index:02d}.mp4"
        duration = render_clip(background, overlay, narration.audio, LEAD + narration.duration + TAIL, clip,
                               width, height, fps, preset, motion=index, card=image is None)
        segments.append(Segment("scene", scene["chapitre"], duration, clip, index, narration.cues))

        if index == 0 and not fmt.vertical:  # pas de carte titre dans un Short : l'accroche enchaîne
            background, overlay = frame_paths("titre")
            render_title(script["titre"], channel, *big, fonts).save(background)
            render_overlay(width, height, fonts, "").save(overlay)
            clip = build / "plans" / "titre.mp4"
            duration = render_clip(background, overlay, None, TITLE_SECONDS, clip, width, height, fps, preset)
            segments.append(Segment("titre", scene["chapitre"], duration, clip))

    background, overlay = frame_paths("fin")
    render_outro(channel, *big, fonts).save(background)
    render_overlay(width, height, fonts, "").save(overlay)
    clip = build / "plans" / "fin.mp4"
    outro = OUTRO_SECONDS / 2 if fmt.vertical else OUTRO_SECONDS
    duration = render_clip(background, overlay, None, outro, clip, width, height, fps, preset)
    segments.append(Segment("fin", "Sources", duration, clip))

    cursor = 0.0
    for segment in segments:
        segment.start = cursor
        cursor += segment.duration

    log("  Assemblage…")
    listing = build / "plans.txt"
    listing.write_text(
        "".join("file '{}'\n".format(str(segment.file.resolve()).replace("'", "'\\''")) for segment in segments),
        encoding="utf-8",
    )
    assembled = build / "assemblage.mp4"
    run_ffmpeg(["-f", "concat", "-safe", "0", "-i", str(listing), "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
                str(assembled)])

    (project_dir / "sous-titres.srt").write_text(srt(segments), encoding="utf-8")

    if music:
        log("  Mixage de la musique…")
        mixed = build / "avec_musique.mp4"
        run_ffmpeg([
            "-i", str(assembled), "-stream_loop", "-1", "-i", str(music), "-filter_complex",
            f"[1:a]volume=0.08,afade=t=out:st={max(0, cursor - 3):.2f}:d=3[m];"
            "[0:a][m]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[a]",
            "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-t", f"{cursor:.3f}",
            str(mixed),
        ])
        assembled = mixed

    final = project_dir / "video.mp4"
    if burn_subtitles:
        log("  Incrustation des sous-titres…")
        # Unités libass (hauteur de référence 288) ; en Short, au-dessus de l'interface du bas.
        size, margin = (13, 70) if fmt.vertical else (16, 24)
        style = f"FontName=DejaVu Sans,FontSize={size},Outline=2,Shadow=0,MarginV={margin}"
        run_ffmpeg(["-i", str(assembled.resolve()), "-vf", f"subtitles=sous-titres.srt:force_style='{style}'",
                    "-c:v", "libx264", "-preset", preset, "-crf", "20", "-c:a", "copy", "-movflags", "+faststart",
                    "video.mp4"], cwd=project_dir)
    else:
        run_ffmpeg(["-i", str(assembled), "-c", "copy", "-movflags", "+faststart", str(final)])

    thumbnail_image = next(
        (images[s["visuel"]["image"]] for s in script["scenes"] if s["visuel"]["image"] in images),
        next(iter(images.values()), None),
    )
    render_thumbnail(project_dir / thumbnail_image["chemin"] if thumbnail_image else None,
                     script["accroche_miniature"], fonts).save(project_dir / "miniature.jpg", quality=90)
    return segments
