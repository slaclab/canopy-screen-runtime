// The scale of EDM's bars (activeBarClass, activeSlacBarClass): an axis,
// label ticks with their numbers (%g, image text), major and minor ticks.
// Behaviour matches the scale drawing EDM's bar.cc and slacBar.cc share;
// written from that behaviour, no EDM code is copied.

import type { ReactNode } from 'react';
import type { EdmFont } from '../config/fonts.js';
import { textWidth } from '../config/fonts.js';
import { cFormat } from '../format.js';
import type { XLine } from './button.js';
import { TextRun, idiv, rint } from './shared.js';

/** A string with its top at `top`, aligned begin/center/end on `at`; image text when `bg`. */
export function ScaleText({
  font,
  text,
  at,
  top,
  align,
  fill,
  bg,
}: {
  font: EdmFont;
  text: string;
  at: number;
  top: number;
  align: 'begin' | 'center' | 'end';
  fill: string | undefined;
  bg?: string;
}) {
  const tw = textWidth(font, text);
  const left = align === 'begin' ? at : align === 'center' ? at - idiv(tw, 2) : at - tw;
  return (
    <>
      {bg ? (
        <rect x={left} y={top} width={tw} height={font.ascent + font.descent} fill={bg} />
      ) : null}
      <TextRun font={font} text={text} x={left} y={top + font.ascent} fill={fill} />
    </>
  );
}

export interface BarScaleArgs {
  readonly show: boolean;
  readonly font: EdmFont;
  readonly horizontal: boolean;
  readonly readMin: number;
  readonly readMax: number;
  readonly labelTicks: number;
  readonly majorTicks: number;
  readonly minorTicks: number;
  readonly areaX: number;
  /** Vertical: the bottom edge (exclusive) of the bar area. */
  readonly areaY: number;
  readonly areaW: number;
  readonly areaH: number;
  /** Horizontal: the axis row. */
  readonly sy: number;
  readonly fg: string | undefined;
  readonly bg: string | undefined;
}

/** Lines and labels of a bar scale; nothing unless shown with labelTicks >= 1. */
export function barScale(a: BarScaleArgs): { ticks: XLine[]; labels: ReactNode[] } {
  const { font, horizontal, areaX, areaY, areaW, areaH, sy, fg: fgStatic, bg } = a;
  const labels: ReactNode[] = [];
  const ticks: XLine[] = [];

  if (!a.show || a.labelTicks < 1) return { ticks, labels };
  const { majorTicks, minorTicks, labelTicks } = a;
  const fh = font.ascent + font.descent;
  const pos = Math.trunc(a.readMax - a.readMin) >= 0;
  const TL = Math.trunc(0.8 * Math.abs(fh - 2));
  const TM = Math.trunc(0.7 * TL);
  const Tm = Math.trunc(0.4 * TL);
  const lo = pos ? a.readMin : -a.readMin;
  const hi = pos ? a.readMax : -a.readMax;
  const inc = (hi - lo) / labelTicks;
  const ax = areaX - 4;
  const at = (val: number) =>
    horizontal
      ? Math.trunc(rint(((val - lo) * areaW) / (hi - lo) + areaX))
      : Math.trunc(rint(areaY - ((val - lo) * areaH) / (hi - lo)));
  const tick = (val: number, len: number) => {
    const c = at(val);
    ticks.push(horizontal ? [c, sy, c, sy + len, fgStatic] : [ax - len, c, ax, c, fgStatic]);
    return c;
  };
  const label = (val: number, k: number) => {
    const c = tick(val, TL);
    const shown = pos ? val : -val;
    const text = Math.abs(val) / Math.abs(inc) < 1e-5 ? '0' : cFormat('%g', shown);
    labels.push(
      horizontal ? (
        <ScaleText
          key={k}
          font={font}
          text={text}
          at={c}
          top={sy + Math.trunc(1.2 * TL)}
          align="center"
          fill={fgStatic}
          bg={bg}
        />
      ) : (
        <ScaleText
          key={k}
          font={font}
          text={text}
          at={ax - Math.trunc(1.2 * TL)}
          top={c - Math.trunc(0.5 * fh)}
          align="end"
          fill={fgStatic}
          bg={bg}
        />
      )
    );
  };
  ticks.push(
    horizontal ? [areaX, sy, areaX + areaW, sy, fgStatic] : [ax, areaY - areaH, ax, areaY, fgStatic]
  );
  let val = lo;
  let k = 0;
  const inner = (start: number) => {
    if (majorTicks <= 0) return;
    const mInc = inc / majorTicks;
    for (let m = 0; m < majorTicks; m++) {
      if (m > 0) tick(start + m * mInc, TM);
      if (minorTicks > 0) {
        for (let j = 1; j < minorTicks; j++) tick(start + m * mInc + (j * mInc) / minorTicks, Tm);
      }
    }
  };
  while (val < hi - inc / 2 && k < 1000) {
    label(val, k++);
    inner(val);
    val += inc;
  }
  label(val, k);
  return { ticks, labels };
}
