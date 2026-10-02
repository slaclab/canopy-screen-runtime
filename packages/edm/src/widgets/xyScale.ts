// Axis arithmetic of EDM's X-Y graph (baselib/xygraph.cc with the scale
// helpers of edmlib/utility.cc): range rounding, scale widths, label values.
// Written from that behaviour; no EDM code is copied.

import type { EdmFont } from '../config/fonts.js';
import { textWidth } from '../config/fonts.js';
import { cFormat } from '../format.js';

export interface RoundedRange {
  readonly min: number;
  readonly max: number;
  /** Label intervals, majors per label, minors per major. */
  readonly n: number;
  readonly majors: number;
  readonly minors: number;
}

/** C remainder (sign of the dividend). */
const rem = (a: number, b: number) => a - b * Math.trunc(a / b);

function candidates(min: number, max: number, m: number) {
  const s = 10 ** -m;
  const i0 = Math.floor(min * s);
  const i1 = Math.ceil(max * s);
  const lowOf = (k: number) =>
    i0 >= 0 ? i0 - rem(i0, k) : rem(i0, k) === 0 ? i0 : i0 - k - rem(i0, k);
  const highOf = (k: number) =>
    i1 >= 0 ? (rem(i1, k) === 0 ? i1 : i1 + k - rem(i1, k)) : i1 + k + rem(i1, k);
  return [
    { low: i0, high: i1, inc: i1 - i0, majors: 5, minors: 2 },
    { low: lowOf(2), high: highOf(2), inc: (highOf(2) - lowOf(2)) / 2, majors: 2, minors: 2 },
    { low: lowOf(5), high: highOf(5), inc: (highOf(5) - lowOf(5)) / 5, majors: 5, minors: 2 },
  ];
}

/** EDM's range rounding ("get_scale_params1"): round limits and an automatic tick count. */
export function roundRange(min: number, max: number): RoundedRange {
  if (max <= min) max = min + 1;
  let m = Math.floor(Math.log10(max - min)) - 1;
  let c = candidates(min, max, m);
  if (!c.some((k) => k.inc < 8)) {
    m += 1;
    c = candidates(min, max, m);
  }
  let best = c[0];
  for (const k of c.slice(1)) if (Math.abs(k.inc - 6) < Math.abs(best.inc - 6)) best = k;
  return {
    min: best.low * 10 ** m,
    max: best.high * 10 ** m,
    n: best.inc,
    majors: best.majors,
    minors: best.minors,
  };
}

/** Tick label text: "0" for a value that is zero to the label step, else C %g. */
export function tickText(v: number, inc: number): string {
  return Math.abs(v) / inc < 1e-5 ? '0' : cFormat('%g', v);
}

/** Label values from a, stepping by repeated addition while v < b + inc/2. */
export function labelValues(a: number, b: number, n: number): number[] {
  const inc = (b - a) / n;
  const out: number[] = [];
  if (!(inc > 0)) return out;
  for (let v = a; v < b + inc / 2 && out.length < 1000; v += inc) out.push(v);
  return out;
}

/** Room for a y scale: widest label text (of every generated label) + LT + 6. */
export function yScaleWidth(font: EdmFont, a: number, b: number, n: number, LT: number): number {
  if (n < 1 || b <= a) return 10;
  const inc = (b - a) / n;
  const widest = Math.max(0, ...labelValues(a, b, n).map((v) => textWidth(font, tickText(v, inc))));
  return widest + LT + 6;
}

/** Half the wider end label of an x scale, + 6 (from the current, unrounded limits). */
export function xScaleMargin(font: EdmFont, a: number, b: number): number {
  return (
    Math.trunc(Math.max(textWidth(font, cFormat('%g', a)), textWidth(font, cFormat('%g', b))) / 2) +
    6
  );
}
