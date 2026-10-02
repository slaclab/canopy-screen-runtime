// Motif's default 3-D shadow colours for a widget background (the colour
// calculation of Motif's Xm/Visual.c, with its default thresholds and
// factors). EDM's Motif text fields (Text Control with motifWidget) get their
// bevel from this, e.g. white → #cccccc / #999999, #c8c8c8 → #e8e8e8 / #6f6f6f,
// which matches EDM screenshots to ±1.

import { firstColor } from './colors.js';

const MAX = 65535;
const LITE_THRESHOLD = 0.93 * MAX;
const DARK_THRESHOLD = 0.2 * MAX;
const F = {
  lite: { bs: 0.4, ts: 0.2 },
  dark: { bs: 0.3, ts: 0.5 },
  lo: { bs: 0.6, ts: 0.5 },
  hi: { bs: 0.4, ts: 0.6 },
};

function rgb16(css: string): [number, number, number] {
  // Motif computes the shadows once, from the colour the widget starts with.
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(firstColor(css));
  if (!m) return [0xc8c8, 0xc8c8, 0xc8c8];
  return [m[1], m[2], m[3]].map((h) => parseInt(h, 16) * 257) as [number, number, number];
}

const css = (c: number[]) =>
  '#' +
  c
    .map((v) => (Math.max(0, Math.min(MAX, Math.trunc(v))) >> 8).toString(16).padStart(2, '0'))
    .join('');

/** Motif brightness: 1/4 intensity + 3/4 luminosity. */
function brightness([r, g, b]: [number, number, number]): number {
  const intensity = (r + g + b) / 3;
  const luminosity = 0.3 * r + 0.59 * g + 0.11 * b;
  return 0.25 * intensity + 0.75 * luminosity;
}

export function motifShadows(bg: string): { top: string; bottom: string } {
  const c = rgb16(bg);
  const br = brightness(c);
  if (br < DARK_THRESHOLD) {
    // Dark backgrounds: shadows are lighter shades.
    return {
      top: css(c.map((v) => v + F.dark.ts * (MAX - v))),
      bottom: css(c.map((v) => v + F.dark.bs * (MAX - v))),
    };
  }
  if (br > LITE_THRESHOLD) {
    return {
      top: css(c.map((v) => v - v * F.lite.ts)),
      bottom: css(c.map((v) => v - v * F.lite.bs)),
    };
  }
  const bsF = F.lo.bs + (br * (F.hi.bs - F.lo.bs)) / MAX;
  const tsF = F.lo.ts + (br * (F.hi.ts - F.lo.ts)) / MAX;
  return {
    top: css(c.map((v) => v + tsF * (MAX - v))),
    bottom: css(c.map((v) => v - bsF * v)),
  };
}
