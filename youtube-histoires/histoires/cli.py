"""Ligne de commande : python -m histoires <commande> …"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

from .config import FORMATS, Settings
from .factcheck import fingerprint, verify, write_report
from .llm import LLMError
from .sources import Dossier, Http, SourceError, build_dossier
from .text import slugify, word_count


def _project(settings: Settings, value: str) -> Path:
    path = Path(value)
    if not (path / "dossier.json").is_file():
        path = settings.projects_dir / value
    if not (path / "dossier.json").is_file():
        raise SourceError(f"Projet introuvable : {value} (lancez d'abord « recherche »)")
    return path


def _read(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _write(path: Path, data: dict) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def cmd_recherche(args, settings: Settings) -> Path:
    project = settings.projects_dir / (args.nom or slugify(args.sujet))
    project.mkdir(parents=True, exist_ok=True)
    print(f"Recherche de sources pour « {args.sujet} »…")
    dossier = build_dossier(
        Http(settings.user_agent), args.sujet, project,
        languages=tuple(args.langues.split(",")),
        local_sources=tuple(Path(p) for p in args.source),
        image_limit=args.images,
    )
    dossier.save(project / "dossier.json")
    print(f"Dossier : {project / 'dossier.json'} ({len(dossier.data['passages'])} passages, "
          f"{len(dossier.data['images'])} images)")
    print("Vérifiez que l'article trouvé est bien la bonne personne avant d'écrire le script.")
    return project


def _claude(settings: Settings):
    from .llm import Claude

    return Claude(settings.model, settings.effort)


def _verify_and_save(llm, dossier: Dossier, script: dict, project: Path, rounds: int) -> bool:
    script, report = verify(llm, dossier, script, max_rounds=rounds)
    _write(project / "script.json", script)
    write_report(report, dossier, project)
    words = sum(word_count(scene["narration"]) for scene in script["scenes"])
    if report["statut"] == "valide":
        print(f"✅ Script vérifié : {len(script['scenes'])} scènes, {words} mots (≈ {words / 150:.1f} min)")
    else:
        print("❌ Des affirmations restent non confirmées : voir verification.md. Corrigez script.json puis "
              "lancez « verifier ».")
    return report["statut"] == "valide"


def cmd_ecrire(args, settings: Settings) -> bool:
    from .writer import write_script

    project = _project(settings, args.projet)
    dossier = Dossier.load(project / "dossier.json")
    fmt = FORMATS[args.format]
    llm = _claude(settings)
    print(f"Rédaction du script ({fmt.name}) avec {settings.model}…")
    script = write_script(llm, dossier, fmt, args.duree)
    script["format"] = fmt.name
    return _verify_and_save(llm, dossier, script, project, args.tours)


def cmd_verifier(args, settings: Settings) -> bool:
    project = _project(settings, args.projet)
    dossier = Dossier.load(project / "dossier.json")
    script = _read(project / "script.json")
    return _verify_and_save(_claude(settings), dossier, script, project, args.tours)


def cmd_video(args, settings: Settings) -> Path:
    from .publish import build_metadata
    from .render import build_video
    from .tts import EdgeVoice, SilentVoice
    from .visuals import Fonts

    if not shutil.which("ffmpeg"):
        raise RuntimeError("ffmpeg est introuvable : installez-le (https://ffmpeg.org/download.html).")
    project = _project(settings, args.projet)
    dossier = Dossier.load(project / "dossier.json")
    script = _read(project / "script.json")
    report_path = project / "verification.json"
    report = _read(report_path) if report_path.is_file() else None
    if not args.forcer:
        if not report or report["statut"] != "valide":
            raise RuntimeError("Script non validé par la vérification (voir verification.md). "
                               "Montage refusé ; --forcer pour passer outre.")
        if report["empreinte_script"] != fingerprint(script):
            raise RuntimeError("script.json a changé depuis la vérification : lancez « verifier » d'abord.")

    fmt = FORMATS[script.get("format", "long")]
    voice = SilentVoice() if args.muet else EdgeVoice(args.voix or settings.voice, settings.voice_rate)
    print(f"Montage {fmt.width}x{fmt.height}{' (brouillon)' if args.brouillon else ''}…")
    segments = build_video(
        project, dossier, script, fmt, voice, settings.channel_name,
        Fonts.find(settings.font, settings.font_bold), draft=args.brouillon,
        music=Path(args.musique) if args.musique else None, burn_subtitles=args.incruster_sous_titres,
    )
    meta = build_metadata(dossier, script, segments, settings.channel_name)
    meta["fichiers"] = {"video": "video.mp4", "miniature": "miniature.jpg", "sous_titres": "sous-titres.srt"}
    _write(project / "youtube.json", meta)
    (project / "description.txt").write_text(meta["description"] + "\n", encoding="utf-8")
    print(f"🎬 Vidéo prête : {project / 'video.mp4'} ({meta['duree_secondes'] / 60:.1f} min)")
    print(f"   Titre : {meta['titre']}")
    print("   Miniature, sous-titres, description et youtube.json dans le même dossier.")
    return project


def cmd_tout(args, settings: Settings) -> bool:
    project = cmd_recherche(args, settings)
    args.projet = str(project)
    if not cmd_ecrire(args, settings):
        return False
    cmd_video(args, settings)
    return True


def cmd_publier(args, settings: Settings) -> None:
    from .publish import upload

    project = _project(settings, args.projet)
    if not (project / "youtube.json").is_file():
        raise RuntimeError("Lancez « video » avant « publier ».")
    upload(project, Path(args.client_secret), args.visibilite, args.contenu_synthetique)


def cmd_voix(args, settings: Settings) -> None:
    from .tts import list_french_voices

    for voice in list_french_voices():
        print(f"{voice['ShortName']:<36} {voice['Gender']:<7} {voice['Locale']}")


def parser() -> argparse.ArgumentParser:
    main = argparse.ArgumentParser(prog="python -m histoires", description=__doc__)
    commands = main.add_subparsers(dest="commande", required=True)

    def research_options(command):
        command.add_argument("sujet", help="nom de la personne ou de l'histoire, ou identifiant Wikidata (Q…)")
        command.add_argument("--source", action="append", default=[], help="fichier texte de source personnelle")
        command.add_argument("--langues", default="fr,en", help="éditions de Wikipédia à lire (défaut : fr,en)")
        command.add_argument("--images", type=int, default=15, help="nombre maximal d'images (défaut : 15)")
        command.add_argument("--nom", help="nom du dossier de projet")

    def writing_options(command):
        command.add_argument("--format", choices=FORMATS, default="long", help="long (16:9) ou court (Shorts)")
        command.add_argument("--duree", type=float, help="durée visée en minutes")
        command.add_argument("--tours", type=int, default=2, help="tours de correction automatique (défaut : 2)")

    def video_options(command):
        command.add_argument("--voix", help="voix Edge, ex. fr-FR-DeniseNeural (voir « voix »)")
        command.add_argument("--muet", action="store_true", help="sans voix (test du montage hors ligne)")
        command.add_argument("--brouillon", action="store_true", help="rendu rapide en basse définition")
        command.add_argument("--musique", help="fichier audio de fond libre de droits")
        command.add_argument("--incruster-sous-titres", action="store_true", help="sous-titres gravés dans l'image")
        command.add_argument("--forcer", action="store_true", help="monter même si la vérification a échoué")

    command = commands.add_parser("recherche", help="construire le dossier de sources réelles")
    research_options(command)
    command.set_defaults(run=cmd_recherche)

    command = commands.add_parser("ecrire", help="écrire et vérifier le script avec l'IA")
    command.add_argument("projet")
    writing_options(command)
    command.set_defaults(run=cmd_ecrire)

    command = commands.add_parser("verifier", help="revérifier un script.json modifié à la main")
    command.add_argument("projet")
    command.add_argument("--tours", type=int, default=0, help="tours de correction automatique (défaut : 0)")
    command.set_defaults(run=cmd_verifier)

    command = commands.add_parser("video", help="voix off, montage, sous-titres, miniature, description")
    command.add_argument("projet")
    video_options(command)
    command.set_defaults(run=cmd_video)

    command = commands.add_parser("tout", help="recherche + script + vérification + vidéo")
    research_options(command)
    writing_options(command)
    video_options(command)
    command.set_defaults(run=cmd_tout)

    command = commands.add_parser("publier", help="mettre en ligne sur YouTube (privée par défaut)")
    command.add_argument("projet")
    command.add_argument("--client-secret", default="client_secret.json", help="identifiants OAuth Google")
    command.add_argument("--visibilite", choices=["private", "unlisted", "public"], default="private")
    command.add_argument("--contenu-synthetique", action="store_true",
                         help="déclarer la vidéo comme contenu modifié ou synthétique réaliste")
    command.set_defaults(run=cmd_publier)

    command = commands.add_parser("voix", help="lister les voix françaises disponibles")
    command.set_defaults(run=cmd_voix)
    return main


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        result = args.run(args, Settings())
    except (SourceError, LLMError, RuntimeError) as error:
        print(f"Erreur : {error}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130
    return 1 if result is False else 0
