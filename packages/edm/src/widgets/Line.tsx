// activeLineClass (polyline / polygon). Behaviour matches EDM's
// baselib/line_obj.cc drawActive: XFillPolygon when `fill`, XDrawLines with
// lineWidth/lineStyle, `closePolygon` repeats the first point (3+ points),
// arrowheads 14 px long and 10 px wide at the first/last point, filled and
// outlined with the line width. X draws every line of width >= 1 as a band
// around the ideal line (butt caps, mitred joints, so an open line stops short
// of its far end pixel); only width 0 is the thin line that lights both ends.
// Written from that behaviour; no EDM code is copied.

import { propBool, propInt, propIntList, propStr } from '../model.js';
import { useEdmPv, useEdmScreen, usePhase } from '../screen/context.js';
import type { EdmWidgetProps } from './registry.js';
import { Unconnected } from './Rectangle.js';
import { SvgBox, X_PIXEL, colorSpec, edmColor, geom, pvProp, useVis } from './shared.js';

const CLS = 'activeLineClass';
const ARROW_LEN = 14;
const ARROW_HALF = 5;
/** X mitres a joint unless its angle is under 11 degrees: 1 / sin(5.5 deg). */
const X_MITER_LIMIT = 10.43;

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
  const alarmPv = pvProp(p, 'alarmPv');
  const alarm = useEdmPv(alarmPv, `${CLS}.alarmPv`);
  const { visible, data: vis, defined: hasVis } = useVis(p, CLS);
  const phase = usePhase([...(alarmPv ? [alarm] : []), ...(hasVis ? [vis] : [])]);
  if (phase === 'waiting') return null;
  if (phase === 'unconnected') return <Unconnected {...g} color={palette.disconnected()} />;
  if (!visible) return null;
  const down = [alarm, vis].some((d) => d && !d.connected);

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
  const fill = down
    ? palette.disconnected()
    : edmColor(palette, fillSpec, { data: alarm, alarmSensitive: propBool(p, 'fillAlarm') });
  const line = down
    ? palette.disconnected()
    : edmColor(palette, lineSpec, { data: alarm, alarmSensitive: propBool(p, 'lineAlarm') });
  const fillShown = propBool(p, 'fill') && (hasVis || !palette.isInvisible(fillSpec, alarm?.num));
  const lineShown = hasVis || !palette.isInvisible(lineSpec, alarm?.num);
  const dash = propStr(p, 'lineStyle') === 'dash' ? '4 4' : undefined;
  const arrows = propStr(p, 'arrows') ?? 'none';

  const minX = Math.min(...pts.map((q) => q[0])) - lw - ARROW_LEN;
  const minY = Math.min(...pts.map((q) => q[1])) - lw - ARROW_LEN;
  const maxX = Math.max(...pts.map((q) => q[0])) + lw + ARROW_LEN + 1;
  const maxY = Math.max(...pts.map((q) => q[1])) + lw + ARROW_LEN + 1;

  // Width 0: the pixels on the path, both ends included (a 1-px stroke through
  // pixel centres with square caps). Width >= 1: the band around the path.
  const thin = lw <= 0;
  const off = thin ? 0.5 : X_PIXEL;
  const at = (q: Pt) => `${q[0] + off},${q[1] + off}`;
  // X joins the ends of a line that returns to its first point.
  const last = pts[pts.length - 1];
  const closed = pts.length > 3 && pts[0][0] === last[0] && pts[0][1] === last[1];
  const stroke = {
    fill: 'none',
    stroke: line,
    strokeWidth: thin ? 1 : lw,
    strokeLinecap: thin ? ('square' as const) : ('butt' as const),
    strokeLinejoin: 'miter' as const,
    strokeMiterlimit: X_MITER_LIMIT,
    strokeDasharray: dash,
  };
  const heads: Pt[][] = [];
  if (n > 1 && (arrows === 'from' || arrows === 'both')) heads.push(arrowHead(pts[0], pts[1]));
  if (n > 1 && (arrows === 'to' || arrows === 'both'))
    heads.push(arrowHead(pts[n - 1], pts[n - 2]));

  return (
    <SvgBox x={minX} y={minY} w={maxX - minX} h={maxY - minY}>
      {fillShown && pts.length > 2 ? (
        <polygon
          points={pts.map((q) => `${q[0] + X_PIXEL},${q[1] + X_PIXEL}`).join(' ')}
          fill={fill}
          stroke="none"
        />
      ) : null}
      {lineShown && n > 1 ? (
        closed ? (
          <polygon points={pts.slice(0, -1).map(at).join(' ')} {...stroke} />
        ) : (
          <polyline points={pts.map(at).join(' ')} {...stroke} />
        )
      ) : null}
      {lineShown
        ? heads.map((h, i) => (
            <polygon
              key={i}
              points={h.slice(0, 3).map(at).join(' ')}
              fill={line}
              stroke={line}
              strokeWidth={thin ? 1 : lw}
              strokeLinejoin="miter"
              strokeMiterlimit={X_MITER_LIMIT}
            />
          ))
        : null}
    </SvgBox>
  );
}
