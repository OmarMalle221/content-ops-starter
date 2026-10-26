"""Métadonnées YouTube (description sourcée, chapitres, crédits) et mise en ligne."""

from __future__ import annotations

import json
import re
from pathlib import Path

from .sources import Dossier
from .text import format_timestamp

TITLE_MAX, DESCRIPTION_MAX, TAGS_MAX = 100, 5000, 480
MIN_CHAPTER_SECONDS = 10
CATEGORY_EDUCATION = "27"

TRANSPARENCY = (
    "🤖 Transparence : script rédigé avec l'aide d'une IA uniquement à partir des sources ci-dessus ; "
    "chaque affirmation a été vérifiée contre ces sources. Voix de synthèse. Photos d'archives réelles sous licence libre, aucune image générée par IA."
)


def chapters(segments) -> list[tuple[float, str]]:
    """Chapitres YouTube : départ à 0:00, au moins 3, chacun d'au moins 10 secondes."""
    merged: list[list] = []
    for segment in segments:
        if merged and merged[-1][1] == segment.chapter:
            merged[-1][2] += segment.duration
        else:
            merged.append([segment.start, segment.chapter, segment.duration])
    kept: list[list] = []
    for item in merged:
        # Un chapitre trop court rejoint le précédent (ou absorbe le suivant s'il est le premier).
        if kept and (item[2] < MIN_CHAPTER_SECONDS or kept[-1][2] < MIN_CHAPTER_SECONDS):
            kept[-1][2] += item[2]
        else:
            kept.append(item)
    if kept:
        kept[0][0] = 0.0
    return [(start, title) for start, title, _ in kept] if len(kept) >= 3 else []


def _tags(tags: list[str]) -> list[str]:
    kept, total = [], 0
    for tag in dict.fromkeys(t.strip() for t in tags if t.strip()):
        cost = len(tag) + (2 if " " in tag else 0) + (1 if kept else 0)
        if total + cost > TAGS_MAX:
            break
        kept.append(tag)
        total += cost
    return kept


def build_metadata(dossier: Dossier, script: dict, segments, channel: str) -> dict:
    title = script["titre"].strip()
    if len(title) > TITLE_MAX:
        title = title[:TITLE_MAX - 1].rstrip() + "…"
    consulted = dossier.data["genere_le"]
    used_images = {s["visuel"]["image"] for s in script["scenes"] if s["visuel"]["type"] == "image"}
    images = [image for image in dossier.data["images"] if image["id"] in used_images]

    chapter_lines = [f"{format_timestamp(start)} {name}" for start, name in chapters(segments)]
    source_lines = [
        f"[{number}] {source['titre']}" + (f" : {source['url']}" if source.get("url") else "")
        for number, source in enumerate(dossier.data["sources"], start=1)
    ]
    credit_lines = [
        f"• {image['titre']} — {image['auteur']} — {image['licence']} — {image['url_page']}" for image in images
    ]
    hashtags = " ".join(
        "#" + re.sub(r"\W", "", "".join(word.capitalize() for word in tag.split())) for tag in script["tags"][:3]
    )

    def assemble(summary: str, credits: list[str]) -> str:
        parts = [summary]
        if chapter_lines:
            parts.append("📌 Chapitres\n" + "\n".join(chapter_lines))
        parts.append(f"📚 Sources (consultées le {consulted})\n" + "\n".join(source_lines))
        if credits:
            parts.append("📷 Crédits photos (Wikimedia Commons)\n" + "\n".join(credits))
        parts.append(TRANSPARENCY)
        parts.append("Textes Wikipédia sous licence CC BY-SA 4.0 ; données Wikidata sous CC0.")
        if hashtags:
            parts.append(hashtags)
        return "\n\n".join(parts)

    description = assemble(script["resume"], credit_lines)
    if len(description) > DESCRIPTION_MAX:
        # Crédits raccourcis (auteur, licence, lien) avant de toucher au reste.
        short = [f"• {image['auteur']} — {image['licence']} — {image['url_page']}" for image in images]
        description = assemble(script["resume"], short)
    if len(description) > DESCRIPTION_MAX:
        description = description[:DESCRIPTION_MAX - 1] + "…"

    return {
        "titre": title,
        "titres_alternatifs": script["titres_alternatifs"],
        "description": description,
        "tags": _tags(script["tags"]),
        "categorie": CATEGORY_EDUCATION,
        "langue": "fr",
        "chapitres": chapter_lines,
        "duree_secondes": round(sum(segment.duration for segment in segments), 1),
    }


SCOPES = [
    "https://www.googleapis.com/auth/youtube.upload",
    "https://www.googleapis.com/auth/youtube.force-ssl",
]


def upload(project_dir: Path, client_secret: Path, privacy: str = "private", synthetic: bool = False,
           log=print) -> str:
    """Envoie la vidéo (privée par défaut), la miniature et les sous-titres. Renvoie l'id YouTube."""
    try:
        from google.auth.transport.requests import Request
        from google.oauth2.credentials import Credentials
        from google_auth_oauthlib.flow import InstalledAppFlow
        from googleapiclient.discovery import build
        from googleapiclient.errors import HttpError
        from googleapiclient.http import MediaFileUpload
    except ImportError as error:
        raise RuntimeError("Installez les dépendances YouTube : pip install -r requirements-youtube.txt") from error

    meta = json.loads((project_dir / "youtube.json").read_text(encoding="utf-8"))
    token_path = Path(".youtube-token.json")
    credentials = None
    if token_path.is_file():
        credentials = Credentials.from_authorized_user_file(str(token_path), SCOPES)
    if not credentials or not credentials.valid:
        if credentials and credentials.expired and credentials.refresh_token:
            credentials.refresh(Request())
        else:
            flow = InstalledAppFlow.from_client_secrets_file(str(client_secret), SCOPES)
            credentials = flow.run_local_server(port=0)
        token_path.write_text(credentials.to_json(), encoding="utf-8")

    youtube = build("youtube", "v3", credentials=credentials)
    body = {
        "snippet": {
            "title": meta["titre"],
            "description": meta["description"],
            "tags": meta["tags"],
            "categoryId": meta["categorie"],
            "defaultLanguage": meta["langue"],
            "defaultAudioLanguage": meta["langue"],
        },
        "status": {
            "privacyStatus": privacy,
            "selfDeclaredMadeForKids": False,
            "containsSyntheticMedia": synthetic,
        },
    }
    media = MediaFileUpload(str(project_dir / "video.mp4"), chunksize=8 * 1024 * 1024, resumable=True)
    request = youtube.videos().insert(part="snippet,status", body=body, media_body=media)
    response = None
    while response is None:
        status, response = request.next_chunk()
        if status:
            log(f"  Envoi : {int(status.progress() * 100)} %")
    video_id = response["id"]
    log(f"  Vidéo en ligne ({privacy}) : https://youtu.be/{video_id}")

    try:
        youtube.thumbnails().set(videoId=video_id, media_body=MediaFileUpload(str(project_dir / "miniature.jpg"))).execute()
        log("  Miniature ajoutée")
    except HttpError as error:
        log(f"  Miniature refusée (compte YouTube à vérifier par téléphone ?) : {error}")
    youtube.captions().insert(
        part="snippet",
        body={"snippet": {"videoId": video_id, "language": "fr", "name": "Français", "isDraft": False}},
        media_body=MediaFileUpload(str(project_dir / "sous-titres.srt"), mimetype="application/octet-stream"),
    ).execute()
    log("  Sous-titres ajoutés")
    return video_id
