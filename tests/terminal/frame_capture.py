"""Reconstruct a pyte PTY frame as PNG/text/geometry; these are not OS screenshots."""
from __future__ import annotations

import json
import math
from pathlib import Path
import re

from PIL import Image, ImageDraw, ImageFont

ANSI = {
    "black": "#000000", "red": "#cd0000", "green": "#00cd00", "brown": "#cdcd00",
    "blue": "#0000ee", "magenta": "#cd00cd", "cyan": "#00cdcd", "white": "#e5e5e5",
    "brightblack": "#7f7f7f", "brightred": "#ff0000", "brightgreen": "#00ff00",
    "brightbrown": "#ffff00", "brightblue": "#5c5cff", "brightmagenta": "#ff00ff",
    "brightcyan": "#00ffff", "brightwhite": "#ffffff",
}


def color(value: str, fallback: str) -> str:
    if value in ANSI:
        return ANSI[value]
    if re.fullmatch(r"[0-9a-fA-F]{6}", value):
        return "#" + value
    return fallback


def font() -> tuple[ImageFont.FreeTypeFont | ImageFont.ImageFont, str]:
    for candidate in (
        "/System/Library/Fonts/Menlo.ttc", "/System/Library/Fonts/SFNSMono.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf", "DejaVuSansMono.ttf",
    ):
        try:
            return ImageFont.truetype(candidate, 16), candidate
        except OSError:
            pass
    return ImageFont.load_default(size=16), "Pillow default"


def save_frame(screen, directory: Path, stage: str) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    safe_stage = re.sub(r"[^a-zA-Z0-9_-]", "-", stage)
    base = directory / safe_stage
    face, face_name = font()
    cell_width = max(1, math.ceil(face.getlength("M")))
    box = face.getbbox("Mg")
    cell_height = max(20, box[3] - min(0, box[1]) + 4)
    image = Image.new("RGB", (screen.columns * cell_width, screen.lines * cell_height), "#171c21")
    draw = ImageDraw.Draw(image)
    rows = []
    for y in range(screen.lines):
        cells = []
        for x in range(screen.columns):
            char = screen.buffer[y][x]
            fg, bg = color(char.fg, "#d7d4c8"), color(char.bg, "#171c21")
            if char.reverse:
                fg, bg = bg, fg
            px, py = x * cell_width, y * cell_height
            draw.rectangle((px, py, px + cell_width - 1, py + cell_height - 1), fill=bg)
            if len(char.data) == 1 and 0x2800 <= ord(char.data) <= 0x28FF:
                # Menlo lacks Braille; render its eight-dot cell directly rather
                # than showing the font's missing-glyph rectangle in artifacts.
                dots = ord(char.data) - 0x2800
                for bit, (column, row) in enumerate(((0, 0), (0, 1), (0, 2), (1, 0), (1, 1), (1, 2), (0, 3), (1, 3))):
                    if dots & (1 << bit):
                        cx = px + cell_width * (0.3 if column == 0 else 0.7)
                        cy = py + 4 + row * (cell_height - 8) / 3
                        draw.ellipse((cx - 1, cy - 1, cx + 1, cy + 1), fill=fg)
            elif char.data:
                draw.text((px, py), char.data, font=face, fill=fg, stroke_width=0)
            if char.underscore:
                draw.line((px, py + cell_height - 2, px + cell_width - 1, py + cell_height - 2), fill=fg)
            cells.append({"column": x, "text": char.data, "foreground": fg, "background": bg,
                          "bold": char.bold, "italic": char.italics, "underline": char.underscore})
        rows.append({"row": y, "text": screen.display[y], "cells": cells})
    if not screen.cursor.hidden and 0 <= screen.cursor.x < screen.columns and 0 <= screen.cursor.y < screen.lines:
        x, y = screen.cursor.x * cell_width, screen.cursor.y * cell_height
        draw.rectangle((x, y, x + cell_width - 1, y + cell_height - 1), outline="#e6c98d", width=1)
    image.save(base.with_suffix(".png"))
    base.with_suffix(".txt").write_text("\n".join(screen.display))
    base.with_suffix(".json").write_text(json.dumps({
        "capture_kind": "reconstructed-pty-frame", "not_os_screenshot": True,
        "stage": stage, "columns": screen.columns, "rows": screen.lines,
        "cell_width": cell_width, "cell_height": cell_height, "font": face_name,
        "cursor": {"column": screen.cursor.x, "row": screen.cursor.y, "hidden": screen.cursor.hidden, "capture_style": "outline"},
        "lines": rows,
    }, indent=2))
    return base.with_suffix(".png")
