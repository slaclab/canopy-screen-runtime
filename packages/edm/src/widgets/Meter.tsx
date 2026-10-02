// activeMeterClass. Behaviour matches EDM's baselib/meter.cc: an analog panel
// meter with a case, a face, radial ticks with their values and a needle:
//   - the sweep is meterAngle degrees, symmetric about 12 o'clock, the
//     maximum at the clockwise end; the face height, needle origin and radii
//     follow EDM's sizing formulas (room for the widest tick text, and for the
//     label below the face, which is always reserved);
//   - label ticks every 1/labelIntervals of the sweep with their values in
//     the scale format (max and min at the ends), major and minor ticks
//     between; the needle a 3-line spike (complexNeedle) or a line;
//   - limits from the PV with scaleLimitsFromDb, else scaleMin/scaleMax;
//     trackDelta shows the change since the first connection;
//   - caseAlarm / scaleAlarm / fgAlarm colour the case, the scale and the
//     needle; nothing until the PVs connect, then (after 2 s) the outline.
// Everything inside the face is clipped to it. Written from that behaviour;
// no EDM code is copied.

import { useState } from 'react';
import type { ReactNode } from 'react';
import { resolveFont, textWidth } from '../config/fonts.js';
import { cFormat } from '../format.js';
import { propBool, propNum, propStr } from '../model.js';
import { useEdmPv, useEdmScreen, useExpanded, usePhase } from '../screen/context.js';
import { ScaleText } from './barScale.js';
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
} from './shared.js';

const CLS = 'activeMeterClass';
const PI = 3.1415926535898;

/** Width-1 X lines through any points (the band rule), joined with X's mitres. */
function XPolyline({
  pts,
  color,
}: {
  pts: readonly [number, number][];
  color: string | undefined;
}) {
  if (!color || pts.length < 2) return null;
  return (
    <polyline
      points={pts.map(([a, b]) => `${a + X_PIXEL},${b + X_PIXEL}`).join(' ')}
      fill="none"
      stroke={color}
      strokeWidth={1}
      strokeLinecap="butt"
      strokeLinejoin="miter"
      strokeMiterlimit={10.43}
    />
  );
}

export function Meter({ obj }: EdmWidgetProps) {
  const { palette } = useEdmScreen();
  const p = obj.props;
  const g = geom(p);
  const { x, y, w, h } = g;
  const readPv = pvProp(p, 'readPv');
  const labelType = propStr(p, 'labelType') ?? 'literal';
  const labelS = useExpanded(propStr(p, 'label') ?? '') ?? '';
  const read = useEdmPv(readPv, `${CLS}.readPv`);
  const labelPv = useEdmPv(
    labelType === 'pvLabel' && labelS.trim() ? propStr(p, 'label') : undefined,
    `${CLS}.label`
  );
  const name = useExpanded(readPv) ?? '';
  const minS = useExpanded(propStr(p, 'scaleMin') ?? '') ?? '';
  const maxS = useExpanded(propStr(p, 'scaleMax') ?? '') ?? '';
  const hasLabelPv = labelType === 'pvLabel' && !!labelS.trim();
  const phase = usePhase([...(readPv ? [read] : []), ...(hasLabelPv ? [labelPv] : [])]);
  const [base, setBase] = useState<number | null>(null);
  if (base === null && read?.connected) setBase(read.num);

  if (!readPv && !hasLabelPv) return null;
  if (phase !== 'init' || !read) {
    return phase === 'unconnected' ? <Unconnected {...g} color={palette.disconnected()} /> : null;
  }

  const sfont = resolveFont(propStr(p, 'scaleFontTag'));
  const lfont = resolveFont(propStr(p, 'labelFontTag'));
  const sfh = sfont.ascent + sfont.descent;
  const sfa = sfont.ascent;
  const lfh = lfont.ascent + lfont.descent;
  let prec = atol(propStr(p, 'scalePrecision'));
  if (prec < 0 || prec > 10) prec = 1;
  const conv = { GFloat: 'g', Exponential: 'e' }[propStr(p, 'scaleFormat') ?? 'FFloat'] ?? 'f';
  const fmt = (v: number) => cFormat(`%.${prec}${conv}`, v);
  const readMin = read.lowerLimit;
  let readMax = read.upperLimit;
  if (readMax <= readMin) readMax = readMin + 1;
  const fromDb = propBool(p, 'scaleLimitsFromDb');
  const smin = fromDb ? readMin : atof(minS);
  let smax = fromDb ? readMax : atof(maxS);

  const T = (PI * propNum(p, 'meterAngle', 180)) / 180;
  const D = PI / 2 - T / 2;
  const faceX = x + 5;
  const faceY = y + 5;
  const faceW = w - 10;
  let faceH = h - 9 - lfh;
  const minText = fmt(smin);
  const maxText = fmt(smax);
  const LI = Math.max(atol(propStr(p, 'labelIntervals')), 1);
  const inc = (smax - smin) / LI;
  const SW = Math.max(
    textWidth(sfont, minText),
    textWidth(sfont, maxText),
    textWidth(sfont, fmt(smax - inc)),
    textWidth(sfont, fmt(smin + inc))
  );
  let Hn = 0.5 * faceW - 4 - SW;
  if (D > 0) Hn /= Math.cos(D);
  let vf: number;
  let Vn: number;
  if (D > 0) {
    vf = 1.1 * (1 - 0.6 * D);
    Vn = (faceH - sfh - 4) / vf;
  } else {
    vf = 1 - Math.sin(D);
    Vn = (faceH - sfh - 12) / vf;
  }
  let N: number;
  if (Vn < Hn) N = Vn;
  else {
    N = Hn;
    const ve = vf * N + sfh + 12;
    if (1.1 * ve < faceH) faceH = Math.trunc(ve);
  }
  const Ox = faceX + idiv(faceW, 2);
  const Oy = faceY + Math.trunc(N + 4 + sfh);
  const LT = Math.min(0.8 * sfh, 15);
  const R = N - LT;
  const Ln = 0.98 * R;
  const TM = 0.7 * LT;
  const Tm = 0.4 * LT;
  const P = (r: number, a: number): [number, number] => [
    Math.trunc(Ox + r * Math.cos(a)),
    Math.trunc(Oy - r * Math.sin(a)),
  ];

  const v = read.num - (propBool(p, 'trackDelta') ? (base ?? read.num) : 0);
  if (smax - smin < 1e-6 * (v - smin)) smax = smin + 1;
  const an = Math.min(Math.max(D + T * (1 - (v - smin) / (smax - smin)), D), D + T);

  const down = !read.connected;
  const caseColor = down
    ? palette.disconnected()
    : edmColor(palette, colorSpec(p, 'caseColor'), {
        data: read,
        alarmSensitive: propBool(p, 'caseAlarm'),
      });
  const scaleColor = down
    ? palette.disconnected()
    : edmColor(palette, colorSpec(p, 'scaleColor'), {
        data: read,
        alarmSensitive: propBool(p, 'scaleAlarm'),
      });
  const needle = down
    ? palette.disconnected()
    : edmColor(palette, colorSpec(p, 'fgColor'), {
        data: read,
        alarmSensitive: propBool(p, 'fgAlarm'),
      });
  const face = palette.spec(colorSpec(p, 'bgColor'));
  const labelColor = palette.spec(colorSpec(p, 'labelColor'));
  const ts = palette.spec(colorSpec(p, 'topShadowColor'));
  const bs = palette.spec(colorSpec(p, 'botShadowColor'));
  const labelText =
    labelType === 'pvName'
      ? name
      : labelType === 'pvLabel'
        ? labelPv?.connected
          ? labelPv.text
          : ''
        : labelS;

  // Scale.
  const scale = [];
  if (propBool(p, 'showScale')) {
    let a = D;
    let sv = smax;
    let k = 0;
    while (a <= 1.001 * (D + T) && k < 1000) {
      const far = P(R + LT, a);
      scale.push(<XPolyline key={`l${k}`} pts={[far, P(R, a)]} color={scaleColor} />);
      let text: string;
      let at: number;
      let top: number;
      let align: 'begin' | 'center' | 'end';
      if (a < D + 0.001)
        [text, at, top, align] = [maxText, far[0] + 2, far[1] - idiv(sfa, 2), 'begin'];
      else if (a <= 1.5) [text, at, top, align] = [fmt(sv), far[0] + 2, far[1] - sfa, 'begin'];
      else if (a <= 1.65) [text, at, top, align] = [fmt(sv), far[0], far[1] - sfa - 2, 'center'];
      else if (a <= D + T - 0.001)
        [text, at, top, align] = [fmt(sv), far[0] - 2, far[1] - sfa, 'end'];
      else [text, at, top, align] = [minText, far[0] - 2, far[1] - idiv(sfa, 2), 'end'];
      scale.push(
        <ScaleText
          key={`t${k}`}
          font={sfont}
          text={text}
          at={at}
          top={top}
          align={align}
          fill={scaleColor}
        />
      );
      a += T / LI;
      sv -= inc;
      k++;
    }
    const major = atol(propStr(p, 'majorIntervals'));
    const minor = atol(propStr(p, 'minorIntervals'));
    if (major > 0) {
      const ma = T / LI / major;
      const mi = ma / Math.max(minor, 1);
      let b = D;
      let n = 0;
      while (b < 0.99 * (D + T) && n < 1000) {
        for (let i = 0; i < major; i++) {
          if (minor > 1) {
            for (let j = 1; j < minor; j++) {
              const c = b + j * mi + i * ma;
              scale.push(
                <XPolyline
                  key={`m${n}:${i}:${j}`}
                  pts={[P(R + Tm, c), P(R, c)]}
                  color={scaleColor}
                />
              );
            }
          }
          if (i > 0) {
            const c = b + i * ma;
            scale.push(
              <XPolyline key={`M${n}:${i}`} pts={[P(R + TM, c), P(R, c)]} color={scaleColor} />
            );
          }
        }
        b += T / LI;
        n++;
      }
    }
  }
  const tip = P(Ln, an);
  const needlePts: [number, number][] = propBool(p, 'complexNeedle')
    ? [[Ox - 1, Oy], tip, [Ox + 1, Oy], [Ox, Oy - 1], tip, [Ox, Oy + 1]]
    : [tip, [Ox, Oy]];
  const is3d = propBool(p, '3d');
  const lx = x + idiv(w, 2);
  const ltop = faceY + faceH + 2;
  const faceClip = (content: ReactNode) => (
    <svg
      x={faceX}
      y={faceY}
      width={Math.max(0, faceW)}
      height={Math.max(0, faceH)}
      viewBox={`${faceX} ${faceY} ${Math.max(0, faceW)} ${Math.max(0, faceH)}`}
      overflow="hidden"
    >
      {content}
    </svg>
  );

  return (
    <SvgBox x={x} y={y} w={w + 1} h={h + 1}>
      <rect x={x} y={y} width={Math.max(0, w)} height={Math.max(0, h)} fill={caseColor} />
      <rect
        x={faceX}
        y={faceY}
        width={Math.max(0, faceW)}
        height={Math.max(0, faceH)}
        fill={face}
      />
      {labelText ? (
        <svg
          x={faceX}
          y={ltop}
          width={Math.max(0, faceW)}
          height={lfh + 4}
          viewBox={`${faceX} ${ltop} ${Math.max(0, faceW)} ${lfh + 4}`}
          overflow="hidden"
        >
          <ScaleText
            font={lfont}
            text={labelText}
            at={lx}
            top={ltop}
            align="center"
            fill={labelColor}
          />
        </svg>
      ) : null}
      {is3d ? (
        <>
          <XRectOutline x={x} y={y} w={w} h={h} lineWidth={1} color={ts} />
          <XRectOutline x={faceX} y={faceY} w={faceW} h={faceH} lineWidth={1} color={ts} />
          <XLines
            lines={[
              [x, y + h, x + w, y + h, bs],
              [x + w, y, x + w, y + h, bs],
              [faceX, faceY, faceX, faceY + faceH, bs],
              [faceX, faceY, faceX + faceW, faceY, bs],
            ]}
          />
        </>
      ) : null}
      {faceClip(
        <>
          {scale}
          <XPolyline pts={needlePts} color={needle} />
        </>
      )}
    </SvgBox>
  );
}
