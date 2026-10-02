// Helpers every EDM widget uses: geometry, visibility, colour and text drawn
// at EDM's pixel positions.

import { AlarmSeverity } from '@slaclab/canopy-client';
import type { CSSProperties, ReactNode } from 'react';
import type { EdmColorSpec, EdmPalette } from '../config/colors.js';
import { parseColorSpec } from '../config/colors.js';
import type { EdmFont } from '../config/fonts.js';
import { charWidth, textWidth } from '../config/fonts.js';
import type { EdmProps } from '../model.js';
import { propBool, propInt, propStr } from '../model.js';
import { useEdmPv } from '../screen/context.js';
import type { EdmPvData } from '../pv/types.js';

export interface Geom {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export function geom(p: EdmProps): Geom {
  return {
    x: propInt(p, 'x', 0),
    y: propInt(p, 'y', 0),
    w: propInt(p, 'w', 0),
    h: propInt(p, 'h', 0),
  };
}

export const colorSpec = (p: EdmProps, name: string): EdmColorSpec | undefined =>
  parseColorSpec(propStr(p, name));

/**
 * A PV-name property, or undefined when EDM treats it as absent: empty,
 * whitespace only, or starting with `#` (its "blank or comment" rule).
 */
export function pvProp(p: EdmProps, name: string): string | undefined {
  const v = propStr(p, name)?.trim();
  return v && !v.startsWith('#') ? v : undefined;
}

/** C atol: the leading integer, 0 when there is none. */
export function atol(s: string | undefined): number {
  const m = /^\s*[+-]?\d+/.exec(s ?? '');
  return m ? parseInt(m[0], 10) : 0;
}

/** C atof: the leading number, 0 when there is none (a macro, a PV name). */
export function atof(s: string | undefined): number {
  const n = parseFloat(s ?? '');
  return Number.isFinite(n) ? n : 0;
}

/**
 * EDM visibility (x_text_obj.cc executeDeferred and the same code in every
 * graphic): shown while visMin <= value < visMax, flipped by visInvert. true
 * without a visPv; null until the visPv first reports. `data` is the visPv's
 * state (undefined without one), for the object's connection phase.
 */
export function useVis(
  p: EdmProps,
  cls: string
): { visible: boolean | null; data: EdmPvData | undefined; defined: boolean } {
  const name = pvProp(p, 'visPv');
  const vis = useEdmPv(name, `${cls}.visPv`);
  if (!name) return { visible: true, data: undefined, defined: false };
  if (!vis) return { visible: null, data: vis, defined: true };
  if (!vis.connected) return { visible: false, data: vis, defined: true };
  const inside = vis.num >= atof(propStr(p, 'visMin')) && vis.num < atof(propStr(p, 'visMax'));
  return { visible: inside !== propBool(p, 'visInvert'), data: vis, defined: true };
}

export function useVisibility(p: EdmProps, cls: string): boolean | null {
  return useVis(p, cls).visible;
}

/**
 * A pvColorClass colour: the spec (a colour rule evaluated at `value`), then
 * EDM alarm colours when alarm-sensitive (colors.list `alarm {}`; noalarm
 * keeps the rule colour), the disconnected colour when the PV is down.
 */
export function edmColor(
  palette: EdmPalette,
  spec: EdmColorSpec | undefined,
  opts: { data?: EdmPvData; alarmSensitive?: boolean } = {}
): string | undefined {
  const { data, alarmSensitive } = opts;
  if (data && !data.connected) return palette.alarm[AlarmSeverity.DISCONNECTED] ?? '#ffffff';
  const base = palette.spec(spec, data?.num);
  // Alarm-sensitive: the severity's special colour; at NO_ALARM the "noalarm"
  // colour when the colour file defines one, else the (rule) colour itself.
  if (alarmSensitive && data) return palette.alarm[data.severity] ?? base;
  return base;
}

export function fontStyle(font: EdmFont): CSSProperties {
  return {
    fontFamily: font.family,
    fontSize: font.sizePx,
    fontWeight: font.weight,
    fontStyle: font.style,
    whiteSpace: 'pre',
    fontKerning: 'none',
    fontVariantLigatures: 'none',
  };
}

/**
 * One string at (x, baseline) with every glyph at its X advance: EDM's
 * XDrawString placement with the web font's glyph shapes.
 */
export function TextRun({
  font,
  text,
  x,
  y,
  fill,
}: {
  font: EdmFont;
  text: string;
  x: number;
  y: number;
  fill: string | undefined;
}) {
  if (!text) return null;
  const xs: number[] = [];
  let cx = x;
  for (let i = 0; i < text.length; i++) {
    xs.push(cx);
    cx += charWidth(font, text.charCodeAt(i));
  }
  return (
    <text x={xs.join(' ')} y={y} fill={fill ?? '#000000'} style={fontStyle(font)}>
      {text}
    </text>
  );
}

export type Align = 'left' | 'center' | 'right';

export function alignOf(p: EdmProps): Align {
  const a = propStr(p, 'fontAlign');
  return a === 'center' || a === 'right' ? a : 'left';
}

/**
 * Where an X coordinate sits in SVG space. X addresses pixel centres and, for
 * filled shapes and lines of width >= 1, lights the pixels whose centre is
 * inside the shape; a centre exactly on an edge counts only when the inside
 * is to its right or below it. SVG addresses pixel corners, so shapes are
 * drawn half a pixel in and nudged up-left by a sliver, which settles every
 * such tie the way X does (with crispEdges the browser samples centres too).
 */
export const X_PIXEL = 0.5 - 1 / 32;

/**
 * EDM draws an object's "not connected" outline before it checks whether the
 * object is enabled, so the outline shows even inside a hidden group. Groups
 * hide their members with `visibility`, and this style opts the outline out.
 */
export const SHOWS_IN_HIDDEN_GROUP: CSSProperties = { visibility: 'visible' };

/**
 * Where a Motif widget's window ends up: EDM's drawing surface is an
 * XmDrawingArea with Motif's default 10-px margins, so a child widget placed
 * left of (or above) them is moved to x = 10 (y = 10), its size unchanged.
 * Objects EDM draws itself are not moved.
 */
export const MOTIF_MARGIN = 10;
export function motifOrigin(x: number, y: number): { x: number; y: number } {
  return { x: Math.max(x, MOTIF_MARGIN), y: Math.max(y, MOTIF_MARGIN) };
}

/** C integer division (truncates toward zero). */
export const idiv = (a: number, b: number) => Math.trunc(a / b);

interface StringLayout {
  /** Lines with their EDM x and baseline. */
  readonly lines: readonly { text: string; x: number; y: number }[];
  readonly boxW: number;
  readonly boxH: number;
}

/**
 * utility.cc getStringBoxSize + XDrawStringsAligned: lines split at \n (or
 * \x01), each aligned within fieldWidth; the line step is ascent+descent, and
 * an empty line advances by the last non-empty line's height (0 before one).
 * `top` is the first baseline.
 */
export function layoutStrings(
  font: EdmFont,
  s: string,
  x: number,
  top: number,
  fieldWidth: number,
  align: Align
): StringLayout {
  const lines: { text: string; x: number; y: number }[] = [];
  let y = top;
  let charHeight = 0;
  let maxW = 2;
  let boxH = 0;
  const segs = s.replaceAll('\u0001', '\n').split('\n');
  segs.forEach((seg, i) => {
    const last = i === segs.length - 1;
    if (seg.length) {
      const sw = textWidth(font, seg);
      charHeight = font.ascent + font.descent;
      if (sw > maxW) maxW = sw;
      const sx =
        align === 'left'
          ? x
          : align === 'center'
            ? x + idiv(fieldWidth, 2) - idiv(sw, 2)
            : x + fieldWidth - sw;
      lines.push({ text: seg, x: sx, y });
    }
    if (!last || seg.length) boxH += charHeight;
    if (!last) y += charHeight;
  });
  return { lines, boxW: maxW, boxH };
}

/** Absolutely positioned SVG layer covering a box; `clip` hides overflow. */
export function SvgBox({
  x,
  y,
  w,
  h,
  clip,
  children,
  title,
  style,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  clip?: boolean;
  children: ReactNode;
  title?: string;
  style?: CSSProperties;
}) {
  return (
    <svg
      width={Math.max(0, w)}
      height={Math.max(0, h)}
      viewBox={`${x} ${y} ${Math.max(0, w)} ${Math.max(0, h)}`}
      shapeRendering="crispEdges"
      style={{
        position: 'absolute',
        left: x,
        top: y,
        overflow: clip ? 'hidden' : 'visible',
        pointerEvents: 'none',
        ...style,
      }}
    >
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  );
}

/**
 * XDrawRectangle(x, y, w, h): a thin (width 0/1) outline lights pixels x..x+w
 * and y..y+h; a wide one covers, per edge at coordinate c, the pixels p with
 * c - lw/2 <= p < c + lw/2 (X11 wide-line rule, mitred corners): c-1..c for
 * width 2, c-1..c+1 for width 3.
 */
export function XRectOutline({
  x,
  y,
  w,
  h,
  lineWidth,
  color,
  dash,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  lineWidth: number;
  color: string | undefined;
  dash?: boolean;
}) {
  if (!color) return null;
  // A solid outline is painted as a ring of whole pixels, which also covers
  // the degenerate w = 0 or h = 0 rectangle X draws as a line.
  if (lineWidth <= 1 && dash) {
    return (
      <rect
        x={x + 0.5}
        y={y + 0.5}
        width={Math.max(0, w)}
        height={Math.max(0, h)}
        fill="none"
        stroke={color}
        strokeWidth={1}
        strokeDasharray="4 4"
      />
    );
  }
  const lw = Math.max(1, lineWidth);
  const lo = (c: number) => Math.ceil(c - lw / 2);
  const hi = (c: number) => Math.ceil(c + lw / 2) - 1;
  const ox0 = lo(x);
  const oy0 = lo(y);
  const ox1 = hi(x + w) + 1;
  const oy1 = hi(y + h) + 1;
  const ix0 = hi(x) + 1;
  const iy0 = hi(y) + 1;
  const ix1 = lo(x + w);
  const iy1 = lo(y + h);
  if (dash) {
    return (
      <rect
        x={(ox0 + ix0) / 2}
        y={(oy0 + iy0) / 2}
        width={(ox1 + ix1) / 2 - (ox0 + ix0) / 2}
        height={(oy1 + iy1) / 2 - (oy0 + iy0) / 2}
        fill="none"
        stroke={color}
        strokeWidth={lw}
        strokeDasharray="4 4"
      />
    );
  }
  let d = `M${ox0} ${oy0}H${ox1}V${oy1}H${ox0}Z`;
  if (ix1 > ix0 && iy1 > iy0) d += `M${ix0} ${iy0}V${iy1}H${ix1}V${iy0}Z`;
  return <path d={d} fill={color} fillRule="evenodd" />;
}

/** C rint(): round half to even. */
export function rint(v: number): number {
  const r = Math.round(v);
  return Math.abs(v % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}
