// EDM font tags ("helvetica-bold-r-12.0": family-weight-slant-pointsize, as
// edmlib/font_pkg.cc names the fonts fonts.list resolves) → a web font plus
// the X11 bitmap metrics EDM lays text out with.
//
// Text geometry (baseline, alignment offsets, per-glyph advances) always
// comes from the X metrics, so strings land where EDM puts them. Glyph shapes
// come from pixel-outline web fonts converted from the same X bitmap fonts
// (fonts/bitmap.css, scripts/gen-bitmap-fonts.py), which reproduce EDM's
// glyphs pixel for pixel at the font's pixel size. Tags without one (sizes the
// X server scales, fallbacks) use the metric-compatible outline families
// Arimo/Tinos/Cousine (Liberation), as does a browser that fails to load the
// bitmap font.

import { BITMAP_FONT_TAGS } from './bitmapFonts.generated.js';
import { X_FONT_METRICS } from './xFontMetrics.generated.js';

export interface XFontMetricsRaw {
  readonly xlfd: string;
  readonly pixel: number;
  readonly ascent: number;
  readonly descent: number;
  /** max_bounds ascent/descent: what Motif widgets lay text out with. */
  readonly maxAscent: number;
  readonly maxDescent: number;
  readonly capHeight: number | null;
  readonly xHeight: number | null;
  /** Comma-separated advance widths of chars 0..255. */
  readonly widths: string;
}

export interface EdmFont {
  /** The tag as written in the .edl. */
  readonly tag: string;
  /** The tag whose X metrics are used (differs when EDM would fall back). */
  readonly resolvedTag: string;
  readonly family: string;
  readonly weight: 'normal' | 'bold';
  readonly style: 'normal' | 'italic';
  /** CSS font-size, px. */
  readonly sizePx: number;
  readonly ascent: number;
  readonly descent: number;
  readonly maxAscent: number;
  readonly maxDescent: number;
  /** Advance width per char code 0..255. */
  readonly widths: readonly number[];
  /** True when the tag had no X metrics of its own (EDM would not load it). */
  readonly fallback: boolean;
  /**
   * True when the first family is the pixel-outline web font of the X bitmap
   * font itself (fonts/bitmap.css): glyphs then match EDM pixel for pixel.
   */
  readonly bitmap: boolean;
}

const FAMILIES: Record<string, string> = {
  helvetica: "Arimo, 'Liberation Sans', Helvetica, Arial, sans-serif",
  courier: "Cousine, 'Liberation Mono', Courier, monospace",
  times: "Tinos, 'Liberation Serif', Times, serif",
  // No metric clone in the Liberation set; glyph positions still come from
  // the X metrics.
  'new century schoolbook': "'TeX Gyre Schola', 'Century Schoolbook', Tinos, serif",
  utopia: "Tinos, 'Liberation Serif', serif",
};

/** The default EDM font (edmlib/font_pkg.cc defSiteFontTag). */
export const DEFAULT_FONT_TAG = 'helvetica-medium-r-10.0';

const cache = new Map<string, EdmFont>();

export function parseFontTag(
  tag: string
): { family: string; weight: string; slant: string; size: number } | null {
  const m = /^(.+)-([a-z]+)-([a-z])-(\d+(?:\.\d+)?)$/i.exec(tag.trim());
  if (!m) return null;
  return {
    family: m[1].toLowerCase(),
    weight: m[2].toLowerCase(),
    slant: m[3],
    size: Number(m[4]),
  };
}

/**
 * A tag EDM could not load (Utopia is absent from the X server; odd sizes)
 * takes the nearest-size Helvetica of the same weight and slant.
 */
function fallbackTag(tag: string): string {
  const p = parseFontTag(tag);
  const weight = p?.weight === 'bold' ? 'bold' : 'medium';
  const slant = p?.slant === 'r' || !p ? 'r' : 'i';
  const want = p?.size ?? 10;
  let best = DEFAULT_FONT_TAG;
  let bestD = Infinity;
  for (const t of Object.keys(X_FONT_METRICS)) {
    const q = parseFontTag(t);
    if (!q || q.family !== 'helvetica' || q.weight !== weight || q.slant !== slant) continue;
    const d = Math.abs(q.size - want);
    if (d < bestD) {
      bestD = d;
      best = t;
    }
  }
  return best;
}

export function resolveFont(tag: string | undefined): EdmFont {
  const key = tag?.trim() || DEFAULT_FONT_TAG;
  const hit = cache.get(key);
  if (hit) return hit;
  const own = X_FONT_METRICS[key];
  const resolvedTag = own ? key : fallbackTag(key);
  const m = X_FONT_METRICS[resolvedTag] ?? X_FONT_METRICS[DEFAULT_FONT_TAG];
  const p = parseFontTag(key);
  const q = parseFontTag(resolvedTag);
  const fam = own ? (p?.family ?? 'helvetica') : (q?.family ?? 'helvetica');
  const bitmap = BITMAP_FONT_TAGS.has(resolvedTag);
  const outline = FAMILIES[fam] ?? FAMILIES.helvetica;
  const font: EdmFont = {
    tag: key,
    resolvedTag,
    family: bitmap ? `'edm ${resolvedTag}', ${outline}` : outline,
    weight: (own ? p : q)?.weight === 'bold' ? 'bold' : 'normal',
    style: (own ? p : q)?.slant === 'r' ? 'normal' : 'italic',
    sizePx: m.pixel,
    ascent: m.ascent,
    descent: m.descent,
    maxAscent: m.maxAscent,
    maxDescent: m.maxDescent,
    widths: m.widths.split(',').map(Number),
    fallback: !own,
    bitmap,
  };
  cache.set(key, font);
  return font;
}

/** CSS font shorthand of a font, e.g. for `document.fonts.load()`. */
export function cssFont(font: EdmFont): string {
  const style = font.style === 'italic' ? 'italic ' : '';
  const weight = font.weight === 'bold' ? 'bold ' : '';
  return `${style}${weight}${font.sizePx}px ${font.family}`;
}

/** XTextWidth: sum of per-char advances (chars beyond Latin-1 use '?'). */
export function textWidth(font: EdmFont, s: string): number {
  let w = 0;
  for (let i = 0; i < s.length; i++) w += charWidth(font, s.charCodeAt(i));
  return w;
}

export function charWidth(font: EdmFont, code: number): number {
  return font.widths[code < 256 ? code : 63] ?? 0;
}
