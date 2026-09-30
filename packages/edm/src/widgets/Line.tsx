// activeLineClass (polyline / polygon). Behaviour matches EDM's
// baselib/line_obj.cc drawActive: XFillPolygon when `fill`, XDrawLines with
// lineWidth/lineStyle, `closePolygon` repeats the first point (3+ points),
// arrowheads 14 px long and 10 px wide at the first/last point. Written from
// that behaviour; no EDM code is copied.

import { propBool, propInt, propIntList, propStr } from '../model.js';
import { useEdmPv, useEdmScreen } from '../screen/context.js';
import type { EdmWidgetProps } from './registry.js';
import { Unconnected } from './Rectangle.js';
import { SvgBox, colorSpec, edmColor, geom, useVisibility } from './shared.js';

const CLS = 'activeLineClass';
const ARROW_LEN = 14;
const ARROW_HALF = 5;

type Pt = readonly [number, number];

/** C rint(): round half to even. */
const rint = (v: number) => {
  const r = Math.round(v);
  return Math.abs(v % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
};

/** Arrowhead at `tip`, pointing away from `from`. */
export function arrowHead(tip: Pt, from: Pt): Pt[] {
  const dx = from[0] - tip[0];
  const dy = from[1] - tip[1];
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const bx = tip[0] + ARROW_LEN * ux;
  const by = tip[1] + ARROW_LEN * uy;
  return [
    tip,
    [rint(bx - ARROW_HALF * uy), rint(by + ARROW_HALF * ux)],
    [rint(bx + ARROW_HALF * uy), rint(by - ARROW_HALF * ux)],
    tip,
  ];
}

export function Line({ obj }: EdmWidgetProps) {
  const { palette } = useEdmScreen();
  const p = obj.props;
  const g = geom(p);
  const alarmPv = propStr(p, 'alarmPv');
  const alarm = useEdmPv(alarmPv, `${CLS}.alarmPv`);
  const visible = useVisibility(p, CLS);
  if (visible === null || (alarmPv?.trim() && !alarm)) return null;
  if (alarm && !alarm.connected)
    return <Unconnected {...g} color={edmColor(palette, undefined, { data: alarm })} />;
  if (!visible) return null;

  const xs = propIntList(p, 'xPoints');
  const ys = propIntList(p, 'yPoints');
  let n = propInt(p, 'numPoints', 0) || Math.min(xs.length, ys.length);
  n = Math.min(n, xs.length, ys.length);
  if (n < 1) return null;
  const pts: Pt[] = [];
  for (let i = 0; i < n; i++) pts.push([xs[i], ys[i]]);
  if (n > 2 && propBool(p, 'closePolygon')) pts.push(pts[0]);

  const lineSpec = colorSpec(p, 'lineColor');
  const fillSpec = colorSpec(p, 'fillColor');
  const lw = propInt(p, 'lineWidth', 1);
  const fill = edmColor(palette, fillSpec, {
    data: alarm,
    alarmSensitive: propBool(p, 'fillAlarm'),
  });
  const line = edmColor(palette, lineSpec, {
    data: alarm,
    alarmSensitive: propBool(p, 'lineAlarm'),
  });
  const fillShown = propBool(p, 'fill') && !palette.isInvisible(fillSpec, alarm?.num);
  const lineShown = !palette.isInvisible(lineSpec, alarm?.num);
  const dash = propStr(p, 'lineStyle') === 'dash' ? '4 4' : undefined;
  const arrows = propStr(p, 'arrows') ?? 'none';

  const minX = Math.min(...pts.map((q) => q[0])) - lw - ARROW_LEN;
  const minY = Math.min(...pts.map((q) => q[1])) - lw - ARROW_LEN;
  const maxX = Math.max(...pts.map((q) => q[0])) + lw + ARROW_LEN + 1;
  const maxY = Math.max(...pts.map((q) => q[1])) + lw + ARROW_LEN + 1;

  // Thin lines (width 0/1) light the pixels on the path, endpoints included:
  // stroke through pixel centres with square caps. Wide lines follow X's rule
  // (pixel centres inside the stroke polygon): stroke the corner coordinates.
  const thin = lw <= 1;
  const off = thin ? 0.5 : 0;
  const path = pts.map((q) => `${q[0] + off},${q[1] + off}`).join(' ');
  const heads: Pt[][] = [];
  if (n > 1 && (arrows === 'from' || arrows === 'both')) heads.push(arrowHead(pts[0], pts[1]));
  if (n > 1 && (arrows === 'to' || arrows === 'both'))
    heads.push(arrowHead(pts[n - 1], pts[n - 2]));

  return (
    <SvgBox x={minX} y={minY} w={maxX - minX} h={maxY - minY}>
      {fillShown && pts.length > 2 ? (
        <polygon points={pts.map((q) => `${q[0]},${q[1]}`).join(' ')} fill={fill} stroke="none" />
      ) : null}
      {lineShown && n > 1 ? (
        <polyline
          points={path}
          fill="none"
          stroke={line}
          strokeWidth={thin ? 1 : lw}
          strokeLinecap={thin ? 'square' : 'butt'}
          strokeLinejoin="miter"
          strokeDasharray={dash}
        />
      ) : null}
      {lineShown
        ? heads.map((h, i) => (
            <polygon
              key={i}
              points={h.map((q) => `${q[0] + off},${q[1] + off}`).join(' ')}
              fill={line}
              stroke={line}
              strokeWidth={thin ? 1 : lw}
              strokeLinejoin="miter"
            />
          ))
        : null}
    </SvgBox>
  );
}
