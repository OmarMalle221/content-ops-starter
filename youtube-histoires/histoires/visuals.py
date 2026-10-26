"""Images de la vidéo : photos recadrées, cartes de texte, calques, miniature."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps

BG_TOP = (16, 26, 43)
BG_BOTTOM = (5, 8, 14)
ACCENT = (242, 179, 61)
TEXT = (246, 242, 233)
MUTED = (184, 191, 203)

FONT_CANDIDATES = {
    False: [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/TTF/DejaVuSans.ttf",
        "/Library/Fonts/Arial.ttf",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "C:/Windows/Fonts/arial.ttf",
    ],
    True: [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
        "/Library/Fonts/Arial Bold.ttf",
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "C:/Windows/Fonts/arialbd.ttf",
    ],
}


@dataclass
class Fonts:
    regular: str | None
    bold: str | None

    @classmethod
    def find(cls, regular: str = "", bold: str = "") -> "Fonts":
        def pick(preferred: str, is_bold: bool) -> str | None:
            for path in [preferred, *FONT_CANDIDATES[is_bold]]:
                if path and Path(path).is_file():
                    return path
            return None

        found_regular = pick(regular, False)
        return cls(found_regular, pick(bold, True) or found_regular)

    def get(self, size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
        path = self.bold if bold else self.regular
        if path:
            return ImageFont.truetype(path, size)
        return ImageFont.load_default(size)  # police intégrée à Pillow (≥ 10.1)


def _unit(width: int, height: int) -> float:
    return min(width, height) / 1080


def background(width: int, height: int) -> Image.Image:
    top = Image.new("RGB", (width, height), BG_TOP)
    bottom = Image.new("RGB", (width, height), BG_BOTTOM)
    mask = Image.linear_gradient("L").resize((width, height))
    return Image.composite(bottom, top, mask)


def _wrap(draw: ImageDraw.ImageDraw, text: str, font, max_width: int) -> list[str]:
    lines: list[str] = []
    for paragraph in text.split("\n"):
        current = ""
        for word in paragraph.split():
            candidate = f"{current} {word}".strip()
            if not current or draw.textlength(candidate, font=font) <= max_width:
                current = candidate
            else:
                lines.append(current)
                current = word
        lines.append(current)
    return lines


def fit_text(draw, text: str, fonts: Fonts, max_width: int, max_height: int, size: int,
             bold: bool = True, min_size: int = 12, spacing: float = 1.18):
    """Plus grande taille de police (≤ size) pour que le texte tienne dans la boîte."""
    while True:
        font = fonts.get(size, bold)
        lines = _wrap(draw, text, font, max_width)
        line_height = int(size * spacing)
        widest = max((draw.textlength(line, font=font) for line in lines), default=0)
        if (len(lines) * line_height <= max_height and widest <= max_width) or size <= min_size:
            return font, lines, line_height
        size = max(min_size, int(size * 0.92))


def _draw_lines(draw, lines, font, line_height, x, y, fill, anchor_center=True, width=0, stroke=0):
    for number, line in enumerate(lines):
        if anchor_center:
            line_x = x + (width - draw.textlength(line, font=font)) / 2
        else:
            line_x = x
        draw.text((line_x, y + number * line_height), line, font=font, fill=fill,
                  stroke_width=stroke, stroke_fill=(0, 0, 0))


def prepare_photo(src: Path, width: int, height: int) -> Image.Image:
    """Photo plein cadre ; si son format diffère trop, posée sur un fond flou d'elle-même."""
    photo = ImageOps.exif_transpose(Image.open(src)).convert("RGB")
    ratio, target = photo.width / photo.height, width / height
    if abs(ratio - target) / target < 0.18:
        return ImageOps.fit(photo, (width, height), Image.LANCZOS)
    blurred = ImageOps.fit(photo, (width, height), Image.LANCZOS).filter(ImageFilter.GaussianBlur(width // 40))
    canvas = Image.blend(blurred, Image.new("RGB", (width, height), BG_BOTTOM), 0.55)
    foreground = ImageOps.contain(photo, (int(width * 0.94), int(height * 0.94)), Image.LANCZOS)
    canvas.paste(foreground, ((width - foreground.width) // 2, (height - foreground.height) // 2))
    return canvas


def render_card(kind: str, text: str, caption: str, width: int, height: int, fonts: Fonts) -> Image.Image:
    image = background(width, height)
    draw = ImageDraw.Draw(image)
    u = _unit(width, height)
    margin = int(width * 0.1)
    box_width = width - 2 * margin
    if kind == "carte_citation":
        quote_font = fonts.get(int(260 * u), True)
        draw.text((margin - 20 * u, height * 0.16), "«", font=quote_font, fill=ACCENT)
        font, lines, line_height = fit_text(draw, text, fonts, box_width, int(height * 0.5), int(70 * u), bold=False)
        top = (height - len(lines) * line_height) / 2 - 30 * u
        _draw_lines(draw, lines, font, line_height, margin, top, TEXT, width=box_width)
        if caption:
            author_font = fonts.get(int(44 * u), True)
            label = f"— {caption}"
            draw.text(((width - draw.textlength(label, font=author_font)) / 2,
                       top + len(lines) * line_height + 50 * u), label, font=author_font, fill=ACCENT)
        return image

    big_size = 220 if kind == "carte_date" else 120
    font, lines, line_height = fit_text(draw, text, fonts, box_width, int(height * 0.42), int(big_size * u))
    caption_font, caption_lines, caption_height = fit_text(
        draw, caption, fonts, box_width, int(height * 0.25), int(54 * u), bold=False
    )
    total = len(lines) * line_height + (60 * u + len(caption_lines) * caption_height if caption else 0)
    top = (height - total) / 2
    _draw_lines(draw, lines, font, line_height, margin, top, ACCENT if kind == "carte_date" else TEXT, width=box_width)
    rule_y = top + len(lines) * line_height + 22 * u
    draw.rectangle([width / 2 - 60 * u, rule_y, width / 2 + 60 * u, rule_y + 6 * u], fill=ACCENT)
    if caption:
        _draw_lines(draw, caption_lines, caption_font, caption_height, margin, rule_y + 40 * u, MUTED, width=box_width)
    return image


def render_title(title: str, channel: str, width: int, height: int, fonts: Fonts) -> Image.Image:
    image = background(width, height)
    draw = ImageDraw.Draw(image)
    u = _unit(width, height)
    margin = int(width * 0.1)
    label_font = fonts.get(int(36 * u), True)
    label = "HISTOIRE VRAIE"
    font, lines, line_height = fit_text(draw, title, fonts, width - 2 * margin, int(height * 0.45), int(100 * u))
    top = (height - len(lines) * line_height) / 2
    label_width = draw.textlength(label, font=label_font)
    draw.text(((width - label_width) / 2, top - 90 * u), label, font=label_font, fill=ACCENT)
    _draw_lines(draw, lines, font, line_height, margin, top, TEXT, width=width - 2 * margin)
    channel_font = fonts.get(int(32 * u))
    draw.text(((width - draw.textlength(channel, font=channel_font)) / 2, top + len(lines) * line_height + 50 * u),
              channel, font=channel_font, fill=MUTED)
    return image


def render_outro(channel: str, width: int, height: int, fonts: Fonts) -> Image.Image:
    return render_card(
        "carte_fait",
        "Toutes les sources sont en description",
        f"Wikipédia · Wikidata · Wikimedia Commons\n{channel}",
        width, height, fonts,
    )


def render_overlay(width: int, height: int, fonts: Fonts, chapter: str, caption: str = "", credit: str = "") -> Image.Image:
    """Calque transparent : chapitre et légende en haut (le bas reste aux sous-titres), crédit photo discret."""
    layer = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    u = _unit(width, height)
    margin = int(56 * u)
    vertical = height > width
    cursor = margin * (2.2 if vertical else 1)  # les Shorts couvrent le haut de l'écran
    if chapter:
        font = fonts.get(int(30 * u), True)
        draw.rectangle([margin, cursor, margin + 8 * u, cursor + 40 * u], fill=ACCENT)
        draw.text((margin + 24 * u, cursor + 2 * u), chapter.upper(), font=font, fill=TEXT,
                  stroke_width=max(1, int(2 * u)), stroke_fill=(0, 0, 0))
        cursor += 64 * u
    if caption:
        font, lines, line_height = fit_text(draw, caption, fonts, int(width * (0.8 if vertical else 0.55)),
                                            int(height * 0.15), int(36 * u), bold=False)
        text_width = max(draw.textlength(line, font=font) for line in lines)
        band_bottom = cursor + len(lines) * line_height + 24 * u
        draw.rectangle([margin - 16 * u, cursor, margin + text_width + 16 * u, band_bottom], fill=(0, 0, 0, 150))
        _draw_lines(draw, lines, font, line_height, margin, cursor + 10 * u, TEXT, anchor_center=False)
        cursor = band_bottom + 16 * u
    if credit:
        font = fonts.get(int(20 * u))
        while draw.textlength(credit, font=font) > width - 2 * margin and len(credit) > 20:
            credit = credit[:-4] + "…"
        x = width - margin - draw.textlength(credit, font=font)
        y = cursor if vertical else height - margin
        draw.text((x, y), credit, font=font, fill=(235, 235, 235, 230), stroke_width=max(1, int(2 * u)),
                  stroke_fill=(0, 0, 0, 200))
    return layer


def photo_credit(image: dict) -> str:
    return f"Photo : {image['auteur']} · {image['licence']} · Wikimedia Commons"


def render_thumbnail(photo: Path | None, hook: str, fonts: Fonts, width: int = 1280, height: int = 720) -> Image.Image:
    """Miniature : la photo à droite, l'accroche en gros à gauche sur un dégradé sombre."""
    image = ImageOps.fit(Image.open(photo).convert("RGB"), (width, height), Image.LANCZOS, centering=(0.65, 0.35)) \
        if photo else background(width, height)
    shade = Image.linear_gradient("L").rotate(-90).resize((width, height))
    shade = shade.point(lambda value: int(value * 0.92))
    image = Image.composite(Image.new("RGB", (width, height), BG_BOTTOM), image, shade)
    draw = ImageDraw.Draw(image)
    margin = int(width * 0.05)
    font, lines, line_height = fit_text(draw, hook.upper(), fonts, int(width * 0.55), int(height * 0.7), 130,
                                        spacing=1.05)
    top = (height - len(lines) * line_height) / 2
    for number, line in enumerate(lines):
        color = ACCENT if number == len(lines) - 1 else TEXT
        draw.text((margin, top + number * line_height), line, font=font, fill=color, stroke_width=6,
                  stroke_fill=(0, 0, 0))
    return image
