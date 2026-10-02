// activeSlacBarClass. Behaviour matches EDM's slaclib/slacBar.cc, SLAC's copy
// of an older activeBarClass; the tags are the bar's, the drawing differs:
//   - value = indicatorPv - nullPv; limits and precision from the PV with
//     limitsFromDb, else min/max (equal limits become min..min+1); a blank
//     origin is the minimum, and the origin is clamped into the range;
//   - the bar is measured from the origin with separate factors on either
//     side (extent rounded half up, clamped at the range ends) and is filled
//     only, so a zero-length bar draws nothing;
//   - vertical bars get an origin line in the bar colour across the whole
//     object (from the scale axis, or x, to x + w - 1); horizontal ones none;
//   - layout: EDM's insets for label, scale and border (the horizontal ones
//     differ from activeBarClass), the scale is the bar's;
//   - indicatorAlarm colours the bar and origin line, fgAlarm the label and
//     border; nothing is drawn until the PVs connect, then (after 2 s) the
//     whole 1-px outline in the disconnected colour, unclipped.
// Written from that behaviour; no EDM code is copied.

import { resolveFont, textWidth } from '../config/fonts.js';
import { cFormat } from '../format.js';
import { propBool, propStr } from '../model.js';
import { useEdmPv, useEdmScreen, useExpanded, usePhase } from '../screen/context.js';
import { ScaleText, barScale } from './barScale.js';
import { XLines } from './button.js';
import type { EdmWidgetProps } from './registry.js';
import { Unconnected } from './Rectangle.js';
import {
  SvgBox,
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

const CLS = 'activeSlacBarClass';

export interface SlacBarExtent {
  /** Offset of the origin from the readMin end. */
  readonly oL: number;
  /** First offset the bar covers and its length (0: nothing). */
  readonly start: number;
  readonly ext: number;
}

/** Where the bar lies along an area of length L (offsets from the readMin end). */
export function slacBarExtent(
  v: number,
  readMin: number,
  readMax: number,
  origin: number,
  L: number
): SlacBarExtent {
  const normal = readMax >= readMin;
  const o = normal
    ? Math.min(Math.max(origin, readMin), readMax)
    : Math.max(Math.min(origin, readMin), readMax);
  const oL = Math.trunc(rint(((o - readMin) * L) / (readMax - readMin)));
  const far = normal ? v >= o : v < o;
  if (far) {
    if (o === readMax) return { oL, start: oL, ext: 0 };
    const kF = (L - oL) / (readMax - o);
    const t = kF * (v - o);
    const ext = t > L - oL ? L - oL : Math.trunc(t + 0.5);
    return { oL, start: oL, ext: Math.max(0, ext) };
  }
  if (o === readMin) return { oL, start: oL, ext: 0 };
  const kN = oL / (readMin - o);
  const ext = Math.max(0, Math.min(oL, Math.trunc((v - o) * kN + 0.5)));
  return { oL, start: oL - ext, ext };
}

export function SlacBar({ obj }: EdmWidgetProps) {
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
  // Without an indicator PV the bar never initialises.
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
  const hasLabel = rawLabel !== '' || pvNameLabel;
  const fromDb = propBool(p, 'limitsFromDb');

  const readMin = fromDb ? ind.lowerLimit : atof(minS);
  let readMax = fromDb ? ind.upperLimit : atof(maxS);
  if (readMax === readMin) readMax = readMin + 1;
  const precision = fromDb ? (ind.precision ?? 0) : atol(propStr(p, 'precision'));
  const origin = originS.trim() === '' ? readMin : atof(originS);
  const conv = { GFloat: 'g', Exponential: 'e' }[propStr(p, 'scaleFormat') ?? 'FFloat'] ?? 'f';
  const fmt = (v: number) => cFormat(`%.${precision}${conv}`, v);
  const S = Math.max(textWidth(font, fmt(readMin)), textWidth(font, fmt(readMax)));
  const R = Math.trunc(rint(0.5 * fh));

  // Layout.
  let areaX: number;
  let areaY = 0;
  let areaW: number;
  let areaH = 0;
  let barY = y;
  let barH = 0;
  if (horizontal) {
    areaX = x;
    areaW = w;
    let minH = 2;
    if (hasLabel) {
      minH += fh + 5;
      barY += fh + 5;
      if (border) {
        minH += 9;
        barY += 5;
        areaX = x + 5;
        areaW = w - 9;
      }
    } else if (border && showScale) {
      minH += 9;
      barY += 5;
    }
    if (showScale) {
      minH += 2 * fh + 5;
      areaX = x + idiv(S, 2) + 3;
      areaW = w - S - 6;
    }
    const inset = border && !showScale && (rawLabel === '' || pvNameLabel);
    if (inset) {
      minH += 9;
      barY += 5;
      areaX = x + 5;
      areaW = w - 9;
    }
    h = Math.max(h, minH);
    barH =
      h -
      (hasLabel ? fh + 5 + (border ? 9 : 0) : 0) -
      (showScale ? 2 * fh + 5 : 0) -
      (inset ? 9 : 0);
  } else {
    w = Math.max(w, 2 + (showScale ? 4 + S + 10 + R : border ? 4 : 0));
    h = Math.max(h, 10 + (hasLabel ? fh + 5 : 0) + (showScale ? fh : border ? 8 : 0));
    areaH = h - (hasLabel ? Math.trunc(1.5 * fh) - 5 : 0) - (showScale ? fh : border ? 8 : 0);
    areaY = y + h - (showScale ? R : border ? 4 : 0);
    areaX = x + (showScale ? S + 10 + R : border ? 5 : 0);
    areaW = w - (showScale ? S + 12 + R : border ? 9 : 0);
  }

  const v = ind.num - (nul?.connected ? nul.num : 0);
  const { start, ext } = slacBarExtent(v, readMin, readMax, origin, horizontal ? areaW : areaH);

  const down = [ind, nul].some((d) => d && !d.connected);
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

  const length = horizontal ? areaW : areaH;
  const { ticks, labels } = barScale({
    show: showScale && length >= 1,
    font,
    horizontal,
    readMin,
    readMax,
    labelTicks: atol(propStr(p, 'labelTicks')),
    majorTicks: atol(propStr(p, 'majorTicks')),
    minorTicks: atol(propStr(p, 'minorTicks')),
    areaX,
    areaY,
    areaW,
    areaH,
    sy: barY + barH + 3,
    fg: fgStatic,
    bg,
  });

  // The vertical origin line, from the clamped origin with rint (it can miss
  // the bar's end by a row at an exact .5, as in EDM).
  const normal = readMax >= readMin;
  const o = normal
    ? Math.min(Math.max(origin, readMin), readMax)
    : Math.max(Math.min(origin, readMin), readMax);
  const oy = Math.trunc(rint(areaY - ((o - readMin) * areaH) / (readMax - readMin)));
  const ox = border || showScale ? areaX - 4 : x;
  const labelText = pvNameLabel ? name : literal;

  return (
    <SvgBox x={x - 1} y={y - 1} w={w + 3} h={h + 3}>
      <rect x={x} y={y} width={Math.max(0, w)} height={Math.max(0, h)} fill={bg} />
      {ext > 0 ? (
        horizontal ? (
          <rect x={areaX + start} y={barY} width={ext} height={Math.max(0, barH)} fill={barColor} />
        ) : (
          <rect
            x={areaX}
            y={areaY - start - ext}
            width={Math.max(0, areaW)}
            height={ext}
            fill={barColor}
          />
        )
      ) : null}
      {horizontal ? null : <XLines lines={[[ox, oy, x + w, oy, barColor]]} />}
      <XLines lines={ticks} />
      {labels}
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
