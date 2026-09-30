#!/usr/bin/env python3
"""Convert the X11 Adobe 75 dpi bitmap fonts (BDF) EDM draws with into web fonts whose
outlines are the bitmap's pixels, one WOFF2 per EDM font tag, plus the @font-face sheet.

At CSS font-size = the font's pixel size, one font pixel is exactly one CSS pixel, so text
rendered at integer positions reproduces EDM's glyphs pixel for pixel on every platform
(no hinting, nothing for antialiasing to soften: every edge lies on a pixel boundary).

    git clone https://gitlab.freedesktop.org/xorg/font/adobe-75dpi.git
    uv run --with fonttools --with brotli scripts/gen-bitmap-fonts.py adobe-75dpi fonts

Output: fonts/<slug>.woff2, fonts/bitmap.css (one @font-face per tag, family "edm <tag>")
and src/config/bitmapFonts.generated.ts (the tags that have a bitmap font).

Tags follow edmlib/font_pkg.cc: family-weight-slant-size with slant r or i and size =
POINT_SIZE / 10, e.g. "helvetica-bold-r-12.0". Only Latin-1 (32..255) is kept: EDM's
fonts.list names the iso8859-1 fonts.

The fonts are (c) 1984-1989, 1994 Adobe Systems Incorporated and (c) 1988, 1994 Digital
Equipment Corporation; their permission notice (adobe-75dpi/COPYING) allows modification
and redistribution and is written to fonts/COPYING.
"""

from __future__ import annotations

import re
import shutil
import sys
from pathlib import Path

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen

UNITS_PER_PIXEL = 64
FAMILIES = {"Helvetica", "Courier", "Times", "New Century Schoolbook"}


def parse_bdf(path: Path) -> dict:
    props: dict[str, str] = {}
    glyphs = []
    cur = None
    in_bitmap = False
    for line in path.read_text(encoding="latin-1").splitlines():
        if cur is None:
            m = re.match(r"^([A-Z_]+)\s+(.*)$", line)
            if m and m.group(1) != "STARTCHAR":
                props[m.group(1)] = m.group(2).strip().strip('"')
            if line.startswith("STARTCHAR"):
                cur = {"name": line.split(None, 1)[1], "rows": []}
            continue
        if line.startswith("ENCODING"):
            cur["enc"] = int(line.split()[1])
        elif line.startswith("DWIDTH"):
            cur["dwidth"] = int(line.split()[1])
        elif line.startswith("BBX"):
            cur["bbx"] = tuple(int(v) for v in line.split()[1:5])
        elif line.startswith("BITMAP"):
            in_bitmap = True
        elif line.startswith("ENDCHAR"):
            glyphs.append(cur)
            cur = None
            in_bitmap = False
        elif in_bitmap:
            cur["rows"].append(line.strip())
    return {"props": props, "glyphs": glyphs}


def rectangles(g: dict) -> list[tuple[int, int, int, int]]:
    """Pixel runs of a glyph as (x0, y0, x1, y1) in pixels, y up from the baseline;
    identical runs on consecutive rows merge into one rectangle."""
    w, h, xoff, yoff = g["bbx"]
    out = []
    active: dict[tuple[int, int], int] = {}  # run -> top y where it started
    for r, row in enumerate(g["rows"] + [""]):
        bits = bin(int(row, 16))[2:].zfill(len(row) * 4)[:w] if row else ""
        runs = set()
        c = 0
        while c < len(bits):
            if bits[c] == "1":
                c0 = c
                while c < len(bits) and bits[c] == "1":
                    c += 1
                runs.add((c0, c))
            else:
                c += 1
        y_top = yoff + h - r  # top edge of this row
        for run in list(active):
            if run not in runs:
                out.append((xoff + run[0], y_top, xoff + run[1], active.pop(run)))
        for run in runs:
            active.setdefault(run, y_top)
    return out


def build(bdf: dict, out: Path) -> str | None:
    p = bdf["props"]
    if p.get("FAMILY_NAME") not in FAMILIES:
        return None
    px = int(p["PIXEL_SIZE"])
    slant = "r" if p["SLANT"].upper() == "R" else "i"
    tag = f'{p["FAMILY_NAME"].lower()}-{p["WEIGHT_NAME"].lower()}-{slant}-{int(p["POINT_SIZE"]) / 10:.1f}'
    s = UNITS_PER_PIXEL
    names = [".notdef"]
    cmap = {}
    glyf = {}
    metrics = {}
    pen = TTGlyphPen(None)
    glyf[".notdef"] = pen.glyph()
    metrics[".notdef"] = (px * s // 2, 0)
    for g in bdf["glyphs"]:
        enc = g.get("enc", -1)
        if not 32 <= enc <= 255:
            continue
        name = f"c{enc:03d}"
        pen = TTGlyphPen(None)
        rects = rectangles(g)
        for x0, y0, x1, y1 in rects:
            pen.moveTo((x0 * s, y0 * s))
            pen.lineTo((x0 * s, y1 * s))
            pen.lineTo((x1 * s, y1 * s))
            pen.lineTo((x1 * s, y0 * s))
            pen.closePath()
        names.append(name)
        cmap[enc] = name
        glyf[name] = pen.glyph()
        metrics[name] = (g["dwidth"] * s, min((r[0] for r in rects), default=0) * s)
    ascent = int(p["FONT_ASCENT"])
    descent = int(p["FONT_DESCENT"])
    fb = FontBuilder(unitsPerEm=px * s, isTTF=True)
    fb.setupGlyphOrder(names)
    fb.setupCharacterMap(cmap)
    fb.setupGlyf(glyf)
    fb.setupHorizontalMetrics(metrics)
    fb.setupHorizontalHeader(ascent=ascent * s, descent=-descent * s)
    fb.setupNameTable({"familyName": f"edm {tag}", "styleName": "Regular"})
    fb.setupOS2(sTypoAscender=ascent * s, sTypoDescender=-descent * s, sTypoLineGap=0,
                usWinAscent=ascent * s, usWinDescent=descent * s)
    fb.setupPost()
    # No grid-fitting at any size: the outlines already sit on the pixel grid.
    font = fb.font
    from fontTools.ttLib import newTable

    gasp = newTable("gasp")
    gasp.version = 1
    gasp.gaspRange = {0xFFFF: 0x000A}  # grayscale + symmetric smoothing, no gridfit
    font["gasp"] = gasp
    font.flavor = "woff2"
    slug = "edm-" + re.sub(r"[^a-z0-9]+", "-", tag.removesuffix(".0")).strip("-")
    font.save(out / f"{slug}.woff2")
    return tag, slug


def main():
    src, out = Path(sys.argv[1]), Path(sys.argv[2])
    out.mkdir(parents=True, exist_ok=True)
    built = {}
    for f in sorted(src.glob("*.bdf")):
        r = build(parse_bdf(f), out)
        if r and r[0] not in built:
            built[r[0]] = r[1]
    shutil.copyfile(src / "COPYING", out / "COPYING")
    css = ["/* Generated by scripts/gen-bitmap-fonts.py: pixel-outline web fonts of the X11 Adobe",
           "   75 dpi bitmap fonts (see COPYING). One family per EDM font tag. Do not edit. */"]
    for tag, slug in sorted(built.items()):
        # Weight/style descriptors match what the renderer asks for, so a missing font file
        # falls back to the bold/italic face of the outline family.
        weight = 700 if "-bold-" in tag else 400
        style = "italic" if "-i-" in tag else "normal"
        css.append(f"@font-face {{ font-family: 'edm {tag}'; src: url('./{slug}.woff2') format('woff2'); "
                   f"font-weight: {weight}; font-style: {style}; font-display: block; }}")
    (out / "bitmap.css").write_text("\n".join(css) + "\n")
    ts = ["// Generated by scripts/gen-bitmap-fonts.py. Do not edit.",
          "// EDM font tags that have a pixel-outline web font (fonts/bitmap.css).", "",
          "export const BITMAP_FONT_TAGS: ReadonlySet<string> = new Set(["]
    ts += [f"  '{tag}'," for tag in sorted(built)]
    ts += ["]);", ""]
    (out.parent / "src" / "config" / "bitmapFonts.generated.ts").write_text("\n".join(ts))
    total = sum((out / f"{s}.woff2").stat().st_size for s in built.values())
    print(f"{len(built)} fonts, {total / 1024:.0f} KiB -> {out}")


if __name__ == "__main__":
    main()
