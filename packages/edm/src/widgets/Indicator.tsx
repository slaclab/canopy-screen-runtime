// activeIndicatorClass. Behaviour matches EDM's indicator/indicator.cc: a
// bar-like widget that shows the value as a triangular pointer:
//   - value = indicatorPv - nullPv; limits and precision from the PV with
//     limitsFromDb, else min/max (equal limits become min..min+1);
//   - the travel is the bar area shrunk by halfWidth at both ends; in range a
//     pointer (apex toward the scale, or away with pointerOpposite), below or
//     above the range an arrowhead at that end (not clamped);
//   - the bar's scale, but tick text in the scale format and precision;
//   - background fill only, pointer in indicatorColor (indicatorAlarm), label
//     and border in fgColor (fgAlarm); all clipped to (x-1, y-1, w+2, h+2);
//     nothing until the PVs connect, then (after 2 s) the unclipped outline.
// Written from that behaviour; no EDM code is copied.

import { resolveFont, textWidth } from '../config/fonts.js';
import { cFormat } from '../format.js';
import { propBool, propInt, propStr } from '../model.js';
import { useEdmPv, useEdmScreen, useExpanded, usePhase } from '../screen/context.js';
import { ScaleText, barScale } from './barScale.js';
import { XLines } from './button.js';
import type { EdmWidgetProps } from './registry.js';
import { Unconnected } from './Rectangle.js';
import {
  SvgBox,
  XRectOutline,
  X_PIXEL,
  atof,
  atol,
  colorSpec,
  edmColor,
  geom,
  idiv,
  pvProp,
  rint,
} from './shared.js';

const CLS = 'activeIndicatorClass';

type Pt = [number, number];

export function Indicator({ obj }: EdmWidgetProps) {
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
  const phase = usePhase(indicatorPv ? [ind, ...(nullPv ? [nul] : [])] : [undefined]);
  if (phase !== 'init' || !ind) {
    return phase === 'unconnected' ? <Unconnected {...g} color={palette.disconnected()} /> : null;
  }

  const font = resolveFont(propStr(p, 'font'));
  const fh = font.ascent + font.descent;
  const horizontal = (propStr(p, 'orientation') ?? 'horizontal') !== 'vertical';
  const showScale = propBool(p, 'showScale');
  const border = propBool(p, 'border');
  const pvNameLabel = propStr(p, 'labelType') === 'pvName';
  const rawLabel = propStr(p, 'label') ?? '';
  const L = rawLabel !== '' || pvNameLabel;
  const e = Math.max(0, propInt(p, 'halfWidth', 0));
  const fromDb = propBool(p, 'limitsFromDb');
  const readMin = fromDb ? ind.lowerLimit : atof(minS);
  let readMax = fromDb ? ind.upperLimit : atof(maxS);
  if (readMax === readMin) readMax = readMin + 1;
  const precision = fromDb ? (ind.precision ?? 0) : atol(propStr(p, 'precision'));
  const conv = { GFloat: 'g', Exponential: 'e' }[propStr(p, 'scaleFormat') ?? 'FFloat'] ?? 'f';
  const F = (v: number) => cFormat(`%.${precision}${conv}`, v);
  const S = Math.max(textWidth(font, F(readMin)), textWidth(font, F(readMax)));
  const R = rint(0.5 * fh);

  // Layout.
  let areaX = x;
  let areaW = w;
  let top = y;
  let H = 0;
  let bottom = 0;
  let areaH = 0;
  if (horizontal) {
    let minH = 2;
    if (L) {
      minH += fh + 5;
      top += fh + 5;
      if (border) {
        minH += 9;
        top += 5;
        areaX = x + 5;
        areaW = w - 9;
      }
    } else if (border && showScale) {
      minH += 9;
      top += 5;
    }
    if (showScale) {
      minH += 2 * fh + 5;
      areaX = x + idiv(S, 2) + 3;
      areaW = w - S - 6;
    }
    const inset = border && !showScale && (rawLabel === '' || pvNameLabel);
    if (inset) {
      minH += 9;
      top += 5;
      areaX = x + 5;
      areaW = w - 9;
    }
    h = Math.max(h, minH);
    H = h;
    if (L) H -= fh + 5 + (border ? 9 : 0);
    if (showScale) H -= 2 * fh + 5;
    if (inset) H -= 9;
    areaX += e;
    areaW -= 2 * e;
  } else {
    let minW = 2;
    let minH = 10;
    if (L) minH += fh + 5;
    if (showScale) {
      minH += fh;
      minW += 4 + S + 10 + R;
    } else if (border) {
      minH += 8;
      minW += 4;
    }
    w = Math.max(w, minW);
    h = Math.max(h, minH);
    areaH = h;
    bottom = y + h;
    if (L) areaH -= Math.trunc(1.5 * fh) - 5;
    if (showScale) areaH -= fh;
    else if (border) areaH -= 8;
    if (showScale) {
      bottom -= R;
      areaW -= 4 + S + 8 + R;
      areaX += 2 + S + 8 + R;
    } else if (border) {
      bottom -= 4;
      areaW -= 9;
      areaX += 5;
    }
    bottom -= e;
    areaH -= 2 * e;
  }

  // Value -> pointer.
  const v = ind.num - (nul?.connected ? nul.num : 0);
  const factor = (horizontal ? areaW : areaH) / (readMax - readMin);
  const d = (u: number) => Math.trunc(factor * u + 0.5);
  const pos = readMax >= readMin;
  type Shape = 'LT' | 'GT' | 'PTR';
  let shape: Shape;
  let along: number;
  const low = horizontal ? areaX : bottom;
  const high = horizontal ? areaX + areaW : bottom - areaH;
  const sign = horizontal ? 1 : -1;
  if (pos) {
    if (v < readMin) [shape, along] = ['LT', low];
    else if (v > readMax) [shape, along] = ['GT', high];
    else [shape, along] = ['PTR', low + sign * d(v - readMin)];
  } else if (v < readMax) [shape, along] = ['GT', high];
  else if (v > readMin) [shape, along] = ['LT', low];
  else [shape, along] = ['PTR', high + sign * d(v - readMax)];

  let poly: Pt[];
  if (horizontal) {
    const W2 = idiv(H, 2);
    let ee = Math.max(e, 5);
    if (ee > W2) ee = Math.max(W2, 2);
    const ix = along;
    if (shape === 'LT')
      poly = [
        [ix + 2 * ee, top],
        [ix, top + W2],
        [ix + 2 * ee, top + H],
      ];
    else if (shape === 'GT')
      poly = [
        [ix - 2 * ee, top],
        [ix, top + W2],
        [ix - 2 * ee, top + H],
      ];
    else if (!propInt(p, 'pointerOpposite', 0))
      poly = [
        [ix - e, top],
        [ix, top + H],
        [ix + e, top],
      ];
    else
      poly = [
        [ix - e, top + H],
        [ix, top],
        [ix + e, top + H],
      ];
  } else {
    const W = areaW;
    const W2 = idiv(W, 2);
    let ee = Math.max(e, 5);
    if (ee > W2) ee = Math.max(W2, 2);
    const iy = along;
    if (shape === 'LT')
      poly = [
        [areaX + W, iy - 2 * ee],
        [areaX + W2, iy],
        [areaX, iy - 2 * ee],
      ];
    else if (shape === 'GT')
      poly = [
        [areaX + W, iy + 2 * ee],
        [areaX + W2, iy],
        [areaX, iy + 2 * ee],
      ];
    else if (!propInt(p, 'pointerOpposite', 0))
      poly = [
        [areaX + W, iy - e],
        [areaX, iy],
        [areaX + W, iy + e],
      ];
    else
      poly = [
        [areaX, iy - e],
        [areaX + W, iy],
        [areaX, iy + e],
      ];
  }

  const down = [ind, nul].some((dd) => dd && !dd.connected);
  const pointerColor = down
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
  const { ticks, labels } = barScale({
    show: showScale,
    font,
    horizontal,
    readMin,
    readMax,
    labelTicks: atol(propStr(p, 'labelTicks')),
    majorTicks: atol(propStr(p, 'majorTicks')),
    minorTicks: atol(propStr(p, 'minorTicks')),
    areaX,
    areaY: bottom,
    areaW,
    areaH,
    sy: top + H + 3,
    fg: fgStatic,
    bg,
    format: F,
  });
  const labelText = pvNameLabel ? name : literal;
  const thin = shape === 'PTR' && e === 0;

  return (
    <SvgBox x={x - 1} y={y - 1} w={w + 2} h={h + 2} clip>
      <rect x={x} y={y} width={Math.max(0, w)} height={Math.max(0, h)} fill={bg} />
      {thin ? (
        <XLines lines={[[poly[0][0], poly[0][1], poly[1][0], poly[1][1], pointerColor]]} />
      ) : (
        <polygon
          points={poly.map(([px, py]) => `${px + X_PIXEL},${py + X_PIXEL}`).join(' ')}
          fill={pointerColor}
        />
      )}
      <XLines lines={ticks} />
      {labels}
      {labelText ? (
        horizontal ? (
          <ScaleText
            font={font}
            text={labelText}
            at={x + 2}
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
