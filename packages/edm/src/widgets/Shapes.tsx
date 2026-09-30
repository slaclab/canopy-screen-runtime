// activeCircleClass, activeArcClass and ByteClass. Behaviour matches EDM's
// baselib/circle_obj.cc, baselib/arc_obj.cc and pvFactory/byte.cc:
//   - circle: XFillArc then XDrawArc of the ellipse inscribed in (x, y, w, h);
//   - arc: the same with startAngle/totalAngle (degrees, counter-clockwise
//     from 3 o'clock, parametric on the ellipse; units of 1/64 degree rounded
//     as EDM does), fillMode chord or pie; only the curve is stroked;
//   - both: alarmPv feeds colour rules and alarm colours, the "invisible"
//     colour hides a part when there is no visPv, nothing is drawn until the
//     PVs connect (1-px box in the disconnected colour after 2 s);
//   - byte: numBits cells along the longer side (boundaries in float32, as
//     EDM computes them), big- or little-endian, on/off colours (a rule
//     onColor gives rule(1)/rule(0)), on cells take the alarm colour, a full
//     grid of dividers in lineColor on top.
// Written from that behaviour; no EDM code is copied.

import { AlarmSeverity } from '@slaclab/canopy-client';
import { propBool, propInt, propNum, propStr } from '../model.js';
import { useEdmPv, useEdmScreen, usePhase } from '../screen/context.js';
import { XLines } from './button.js';
import type { XLine } from './button.js';
import type { EdmWidgetProps } from './registry.js';
import { Unconnected } from './Rectangle.js';
import { SvgBox, colorSpec, edmColor, geom, pvProp, useVis } from './shared.js';

/** Degrees → X's 1/64-degree units, with EDM's (int)(deg * 64 + 0.5). */
const angleUnits = (deg: number) => Math.trunc(deg * 64 + 0.5);

function makeArc(cls: string, isArc: boolean) {
  return function ArcShape({ obj }: EdmWidgetProps) {
    const { palette } = useEdmScreen();
    const p = obj.props;
    const g = geom(p);
    const alarmPv = pvProp(p, 'alarmPv');
    const alarm = useEdmPv(alarmPv, `${cls}.alarmPv`);
    const { visible, data: vis, defined: hasVis } = useVis(p, cls);
    const phase = usePhase([...(alarmPv ? [alarm] : []), ...(hasVis ? [vis] : [])]);
    if (phase === 'waiting') return null;
    if (phase === 'unconnected') return <Unconnected {...g} color={palette.disconnected()} />;
    if (!visible) return null;

    const down = [alarm, vis].some((d) => d && !d.connected);
    const lineSpec = colorSpec(p, 'lineColor');
    const fillSpec = colorSpec(p, 'fillColor');
    const line = down
      ? palette.disconnected()
      : edmColor(palette, lineSpec, {
          data: alarm,
          alarmSensitive: propBool(p, 'lineAlarm'),
        });
    const fill = down
      ? palette.disconnected()
      : edmColor(palette, fillSpec, {
          data: alarm,
          alarmSensitive: propBool(p, 'fillAlarm'),
        });
    const fillShown = propBool(p, 'fill') && (hasVis || !palette.isInvisible(fillSpec, alarm?.num));
    const lineShown = hasVis || !palette.isInvisible(lineSpec, alarm?.num);
    const lw = Math.max(1, propInt(p, 'lineWidth', 1));
    const dash = propStr(p, 'lineStyle') === 'dash' ? '4 4' : undefined;

    // X addresses pixel centres: the ellipse inscribed in (x, y, w, h) has its
    // centre at (x + w/2, y + h/2) there, half a pixel further in SVG space.
    const cx = g.x + g.w / 2 + 0.5;
    const cy = g.y + g.h / 2 + 0.5;
    const rx = g.w / 2;
    const ry = g.h / 2;
    const pad = lw + 1;
    const box = { x: g.x - pad, y: g.y - pad, w: g.w + 2 * pad + 1, h: g.h + 2 * pad + 1 };

    const a1 = isArc ? angleUnits(propNum(p, 'startAngle', 0)) : 0;
    const a2 = isArc ? angleUnits(propNum(p, 'totalAngle', 180)) : 23040;
    if (Math.abs(a2) >= 23040) {
      return (
        <SvgBox {...box}>
          {fillShown ? <ellipse cx={cx} cy={cy} rx={rx} ry={ry} fill={fill} /> : null}
          {lineShown ? (
            <ellipse
              cx={cx}
              cy={cy}
              rx={rx}
              ry={ry}
              fill="none"
              stroke={line}
              strokeWidth={lw}
              strokeDasharray={dash}
            />
          ) : null}
        </SvgBox>
      );
    }
    if (a2 === 0) return null;
    const pt = (units: number): [number, number] => {
      const t = (units / 64) * (Math.PI / 180);
      return [cx + rx * Math.cos(t), cy - ry * Math.sin(t)];
    };
    const [sx, sy] = pt(a1);
    const [ex, ey] = pt(a1 + a2);
    const large = Math.abs(a2) > 11520 ? 1 : 0;
    const sweep = a2 > 0 ? 0 : 1; // positive = counter-clockwise on screen
    const curve = `M${sx} ${sy}A${rx} ${ry} 0 ${large} ${sweep} ${ex} ${ey}`;
    const pie = propStr(p, 'fillMode') === 'pie';
    return (
      <SvgBox {...box}>
        {fillShown ? (
          <path
            d={pie ? `M${cx} ${cy}L${sx} ${sy}${curve.slice(curve.indexOf('A'))}Z` : `${curve}Z`}
            fill={fill}
          />
        ) : null}
        {lineShown ? (
          <path d={curve} fill="none" stroke={line} strokeWidth={lw} strokeDasharray={dash} />
        ) : null}
      </SvgBox>
    );
  };
}

export const Circle = makeArc('activeCircleClass', false);
export const Arc = makeArc('activeArcClass', true);

const BYTE = 'ByteClass';

/** Cell boundaries b_0..b_N as EDM computes them: origin + i * (extent / N) in float32, truncated. */
export function byteBoundaries(origin: number, extent: number, n: number): number[] {
  const len = Math.fround(extent / n);
  const out = [origin];
  for (let i = 1; i <= n; i++) {
    out.push(Math.trunc(Math.fround(Math.fround(origin) + Math.fround(Math.fround(i) * len))));
  }
  return out;
}

export function Byte({ obj }: EdmWidgetProps) {
  const { palette } = useEdmScreen();
  const p = obj.props;
  const g = geom(p);
  const { x, y, w, h } = g;
  const controlPv = pvProp(p, 'controlPv');
  const pv = useEdmPv(controlPv, `${BYTE}.controlPv`);
  const n = Math.max(1, Math.min(16, propInt(p, 'numBits', 16)));
  const shift = Math.max(0, Math.min(31, propInt(p, 'shift', 0)));
  const little = propStr(p, 'endian') === 'little';
  const horizontal = w > h;
  const b = horizontal ? byteBoundaries(x, w, n) : byteBoundaries(y, h, n);

  // Colours are fixed at load: a rule onColor gives rule(1) / rule(0).
  const onSpec = colorSpec(p, 'onColor');
  const onRule = palette.isRule(onSpec);
  const onBase = palette.spec(onSpec, onRule ? 1 : undefined);
  const off = onRule ? palette.spec(onSpec, 0) : palette.spec(colorSpec(p, 'offColor'));
  const lineColor = palette.spec(colorSpec(p, 'lineColor'));
  const valid = !!pv?.connected;
  // On cells take the PV's alarm colour (none / minor / major / else invalid).
  let on = onBase;
  if (valid && pv.severity !== AlarmSeverity.NO_ALARM) {
    on =
      palette.alarm[
        pv.severity === AlarmSeverity.MINOR || pv.severity === AlarmSeverity.MAJOR
          ? pv.severity
          : AlarmSeverity.INVALID
      ] ?? onBase;
  }
  const value = valid ? ((Math.trunc(pv.num) | 0) >> shift) & ((1 << n) - 1) : 0;

  const cells = [];
  for (let i = 0; i < n; i++) {
    const bit = little ? i : n - 1 - i;
    // Before the first value (and when disconnected) EDM fills the whole area
    // with one colour, in practice black.
    const c = !valid ? '#000000' : (value >> bit) & 1 ? on : off;
    cells.push(
      horizontal ? (
        <rect key={i} x={b[i]} y={y} width={Math.max(0, b[i + 1] - b[i])} height={h} fill={c} />
      ) : (
        <rect key={i} x={x} y={b[i]} width={w} height={Math.max(0, b[i + 1] - b[i])} fill={c} />
      )
    );
  }
  const lw = propInt(p, 'lineWidth', 1);
  const grid: XLine[] = [];
  for (let i = 0; i <= n; i++) {
    grid.push(horizontal ? [b[i], y, b[i], y + h, lineColor] : [x, b[i], x + w, b[i], lineColor]);
  }
  if (horizontal) grid.push([x, y, x + w, y, lineColor], [x, y + h, x + w, y + h, lineColor]);
  else grid.push([x, y, x, y + h, lineColor], [x + w, y, x + w, y + h, lineColor]);

  if (!controlPv) return null;
  return (
    <SvgBox x={x - lw} y={y - lw} w={w + 2 * lw + 1} h={h + 2 * lw + 1}>
      {cells}
      {lw <= 1 ? (
        <XLines lines={grid} />
      ) : (
        grid.map(([x1, y1, x2, y2], i) => (
          <line
            key={i}
            x1={x1}
            y1={y1}
            x2={x2}
            y2={y2}
            stroke={lineColor}
            strokeWidth={lw}
            strokeDasharray={propStr(p, 'lineStyle') === 'dash' ? '4 4' : undefined}
          />
        ))
      )}
    </SvgBox>
  );
}
