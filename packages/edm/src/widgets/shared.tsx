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

/** C atof: the leading number, 0 when there is none (a macro, a PV name). */
export function atof(s: string | undefined): number {
  const n = parseFloat(s ?? '');
  return Number.isFinite(n) ? n : 0;
}

/**
 * EDM visibility (x_text_obj.cc executeDeferred and the same code in every
 * graphic): shown while visMin <= value < visMax, flipped by visInvert. true
 * without a visPv; null until the visPv first reports.
 */
export function useVisibility(p: EdmProps, cls: string): boolean | null {
  const vis = useEdmPv(propStr(p, 'visPv'), `${cls}.visPv`);
  if (!propStr(p, 'visPv')?.trim()) return true;
  if (!vis) return null;
  if (!vis.connected) return false;
  const inside = vis.num >= atof(propStr(p, 'visMin')) && vis.num < atof(propStr(p, 'visMax'));
  return inside !== propBool(p, 'visInvert');
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
  if (alarmSensitive && data && data.severity !== AlarmSeverity.NO_ALARM) {
    return palette.alarm[data.severity] ?? base;
  }
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
 * and y..y+h; a wide one covers, per edge at coordinate c, the pixels whose
 * centres fall in [c - lw/2, c + lw/2) (X11 wide-line rule, mitred corners).
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
  if (lineWidth <= 1) {
    return (
      <rect
        x={x + 0.5}
        y={y + 0.5}
        width={Math.max(0, w)}
        height={Math.max(0, h)}
        fill="none"
        stroke={color}
        strokeWidth={1}
        strokeDasharray={dash ? '4 4' : undefined}
      />
    );
  }
  const lo = (c: number) => Math.ceil(c - lineWidth / 2 - 0.5);
  const hi = (c: number) => Math.ceil(c + lineWidth / 2 - 0.5) - 1;
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
        strokeWidth={lineWidth}
        strokeDasharray="4 4"
      />
    );
  }
  let d = `M${ox0} ${oy0}H${ox1}V${oy1}H${ox0}Z`;
  if (ix1 > ix0 && iy1 > iy0) d += `M${ix0} ${iy0}V${iy1}H${ix1}V${iy0}Z`;
  return <path d={d} fill={color} fillRule="evenodd" />;
}
