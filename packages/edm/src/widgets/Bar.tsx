// activeBarClass. Behaviour matches EDM's baselib/bar.cc:
//   - value = indicatorPv - nullPv, clamped to the range (limitsFromDb: the
//     PV's display limits and precision, else min/max; equal limits become
//     min..min+1); the bar grows from `origin` (the minimum when blank);
//   - the bar area shrinks for a label (literal or the PV name), a scale
//     (room for its widest number on each side) and a border, with EDM's
//     exact insets; pixel positions use C rint (half to even);
//   - drawing: bgColor box, the bar as a filled plus outlined rectangle (so a
//     zero-length bar is still a 1-px line), the origin line, the scale
//     (label/major/minor ticks, numbers as %g), the label, the border;
//   - indicatorAlarm colours the bar, fgAlarm the label and border; nothing
//     is drawn until the PVs connect (after 2 s the top and left edge of a
//     box in the disconnected colour).
// Written from that behaviour; no EDM code is copied.

import type { ReactNode } from 'react';
import type { EdmFont } from '../config/fonts.js';
import { resolveFont, textWidth } from '../config/fonts.js';
import { cFormat } from '../format.js';
import { propBool, propStr } from '../model.js';
import { useEdmPv, useEdmScreen, useExpanded, usePhase } from '../screen/context.js';
import { XLines } from './button.js';
import type { XLine } from './button.js';
import type { EdmWidgetProps } from './registry.js';
import {
  SHOWS_IN_HIDDEN_GROUP,
  SvgBox,
  TextRun,
  XRectOutline,
  atof,
  atol,
  colorSpec,
  edmColor,
  geom,
  idiv,
  pvProp,
  rint,
} from './shared.js';

const CLS = 'activeBarClass';

/** A string with its top at `top`, aligned begin/center/end on `at`. */
function ScaleText({
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

export function Bar({ obj }: EdmWidgetProps) {
  const { palette } = useEdmScreen();
  const p = obj.props;
  const g = geom(p);
  const { x, y } = g;
  let { w, h } = g;
  const indicatorPv = pvProp(p, 'indicatorPv');
  const nullPv = pvProp(p, 'nullPv');
  const ind = useEdmPv(indicatorPv, `${CLS}.indicatorPv`);
  const nul = useEdmPv(nullPv, `${CLS}.nullPv`);
  const name = useExpanded(indicatorPv) ?? '';
  const literal = useExpanded(propStr(p, 'label') ?? '') ?? '';
  const minS = useExpanded(propStr(p, 'min') ?? '') ?? '';
  const maxS = useExpanded(propStr(p, 'max') ?? '') ?? '';
  const originS = useExpanded(propStr(p, 'origin') ?? '') ?? '';
  const phase = usePhase([...(indicatorPv ? [ind] : []), ...(nullPv ? [nul] : [])]);

  if (phase !== 'init' || !indicatorPv || !ind) {
    if (phase === 'waiting') return null;
    // The unconnected box is clipped to w x h: only its top and left edges show.
    return (
      <SvgBox x={x} y={y} w={w} h={h} clip style={SHOWS_IN_HIDDEN_GROUP}>
        <XRectOutline {...g} lineWidth={1} color={palette.disconnected()} />
      </SvgBox>
    );
  }

  const font = resolveFont(propStr(p, 'font'));
  const fh = font.ascent + font.descent;
  const horizontal = (propStr(p, 'orientation') ?? 'horizontal') !== 'vertical';
  const showScale = propBool(p, 'showScale');
  const border = propBool(p, 'border');
  const pvNameLabel = propStr(p, 'labelType') === 'pvName';
  const hasLabel = (propStr(p, 'label') ?? '') !== '' || pvNameLabel;
  const fromDb = propBool(p, 'limitsFromDb');

  const readMin = fromDb ? ind.lowerLimit : atof(minS);
  let readMax = fromDb ? ind.upperLimit : atof(maxS);
  const precision = fromDb ? (ind.precision ?? 0) : atol(propStr(p, 'precision'));
  if (readMax === readMin) readMax = readMin + 1;
  const origin = originS.trim() === '' ? readMin : atof(originS);
  const conv = { GFloat: 'g', Exponential: 'e' }[propStr(p, 'scaleFormat') ?? 'FFloat'] ?? 'f';
  const fmt = (v: number) => cFormat(`%.${precision}${conv}`, v);
  const S = Math.max(textWidth(font, fmt(readMin)), textWidth(font, fmt(readMax)));
  const R = Math.trunc(rint(0.5 * fh));

  // Layout (updateDimensions).
  let areaX = x;
  let areaY = y;
  let areaW = w;
  let areaH = h;
  let barX = x;
  let barY = y;
  let barW = w;
  let barH = h;
  if (horizontal) {
    let minH = 2;
    if (hasLabel) {
      minH += rint(1.5 * fh);
      barY += fh + 5;
      barH -= fh + 5;
      areaX = x + 5;
      areaW = w - 9;
      if (border && !showScale) {
        minH += 5;
        barH -= 5;
      }
    }
    if (showScale) {
      minH += 2 * fh + 9;
      barY += 5;
      barH -= 2 * fh + 9;
      areaX = x + idiv(S, 2) + 3;
      areaW = w - S - 6;
    }
    if (border && !showScale && ((propStr(p, 'label') ?? '') === '' || pvNameLabel)) {
      minH += 11;
      barY += 5;
      barH -= 9;
      areaX = x + 5;
      areaW = w - 9;
    }
    if (h < minH) {
      barH += minH - h;
      h = minH;
    }
  } else {
    const minW = 2 + (hasLabel ? fh + 5 : 0) + (showScale ? S + 13 + R : border ? 10 : 0);
    const minH = 10 + (hasLabel ? fh + 5 : 0) + (showScale ? fh : border ? 8 : 0);
    w = Math.max(w, minW);
    h = Math.max(h, minH);
    areaH = h;
    areaY = y + h;
    areaW = w;
    if (hasLabel) areaH -= Math.trunc(1.5 * fh) - 5;
    if (showScale) {
      areaH -= fh;
      areaY -= R;
      areaW -= S + 12 + R;
      areaX += S + 10 + R;
    } else if (border) {
      areaH -= 8;
      areaY -= 4;
      areaW -= 9;
      areaX += 5;
    }
    barX = areaX;
    barW = areaW;
  }

  // Value → pixels.
  const L = horizontal ? areaW : areaH;
  const pos = Math.trunc(readMax - readMin) >= 0;
  let v = ind.num - (nul?.connected ? nul.num : 0);
  if (pos) v = Math.min(Math.max(v, readMin), readMax);
  else v = Math.max(Math.min(v, readMin), readMax);
  const d = (u: number) => {
    const t = (u - readMin) / (readMax - readMin);
    return Math.trunc(rint(L * (pos ? t : 1 - t) + 0.5));
  };
  const loc = (u: number) =>
    horizontal
      ? pos
        ? areaX + d(u)
        : areaX + areaW - d(u)
      : pos
        ? areaY - d(u)
        : areaY - areaH + d(u);
  const originLoc = loc(origin);
  const edgeLoc = loc(v);
  const above = pos ? v > origin : v < origin;
  if (horizontal) {
    barX = above ? originLoc : edgeLoc;
    barW = Math.abs(originLoc - edgeLoc);
  } else {
    barY = above ? edgeLoc : originLoc;
    barH = Math.abs(originLoc - edgeLoc);
  }

  const down = [ind, nul].some((dd) => dd && !dd.connected);
  const barColor = down
    ? palette.disconnected()
    : edmColor(palette, colorSpec(p, 'indicatorColor'), {
        data: ind,
        alarmSensitive: propBool(p, 'indicatorAlarm'),
      });
  const fg = down
    ? palette.disconnected()
    : edmColor(palette, colorSpec(p, 'fgColor'), {
        data: ind,
        alarmSensitive: propBool(p, 'fgAlarm'),
      });
  const fgStatic = palette.spec(colorSpec(p, 'fgColor'));
  const bg = palette.spec(colorSpec(p, 'bgColor'));

  // Scale.
  const scale: ReactNode[] = [];
  const ticks: XLine[] = [];
  const labelTicks = atol(propStr(p, 'labelTicks'));
  if (showScale && labelTicks >= 1) {
    const majorTicks = atol(propStr(p, 'majorTicks'));
    const minorTicks = atol(propStr(p, 'minorTicks'));
    const TL = Math.trunc(0.8 * Math.abs(fh - 2));
    const TM = Math.trunc(0.7 * TL);
    const Tm = Math.trunc(0.4 * TL);
    const lo = pos ? readMin : -readMin;
    const hi = pos ? readMax : -readMax;
    const inc = (hi - lo) / labelTicks;
    const sy = y + h - 2 * fh - 1;
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
      scale.push(
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
      horizontal
        ? [areaX, sy, areaX + areaW, sy, fgStatic]
        : [ax, areaY - areaH, ax, areaY, fgStatic]
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
  }

  const labelText = pvNameLabel ? name : literal;
  return (
    <SvgBox x={x - 1} y={y - 1} w={w + 3} h={h + 3}>
      <svg
        x={x}
        y={y}
        width={Math.max(0, w)}
        height={Math.max(0, h)}
        viewBox={`${x} ${y} ${Math.max(0, w)} ${Math.max(0, h)}`}
        overflow="hidden"
      >
        <rect x={x} y={y} width={w + 1} height={h + 1} fill={bg} />
        <rect
          x={barX}
          y={barY}
          width={Math.max(0, barW) + 1}
          height={Math.max(0, barH) + 1}
          fill={barColor}
        />
        <XLines
          lines={[
            horizontal
              ? [originLoc, barY, originLoc, barY + barH, barColor]
              : [barX, originLoc, barX + barW, originLoc, barColor],
          ]}
        />
      </svg>
      <XLines lines={ticks} />
      {scale}
      {labelText ? (
        horizontal ? (
          <ScaleText
            font={font}
            text={labelText}
            at={areaX}
            top={y + 2 + (border ? 2 : 0)}
            align="begin"
            fill={fg}
          />
        ) : (
          <ScaleText
            font={font}
            text={labelText}
            at={areaX + areaW}
            top={y + Math.trunc(0.25 * fh) + (border ? 2 : 0)}
            align="end"
            fill={fg}
          />
        )
      ) : null}
      {border ? <XRectOutline x={x} y={y} w={w} h={h} lineWidth={1} color={fg} /> : null}
    </SvgBox>
  );
}
