// activeRectangleClass, after EDM baselib/rectangle_obj.cc drawActive:
// XFillRectangle(x, y, w, h) when `fill`, then XDrawRectangle(x, y, w, h)
// with lineWidth/lineStyle. alarmPv drives rule colours and, with
// lineAlarm/fillAlarm, alarm colours; `invisible` draws nothing.

import { propBool, propInt, propStr } from '../model.js';
import { useEdmPv, useEdmScreen, usePhase } from '../screen/context.js';
import type { EdmWidgetProps } from './registry.js';
import { SvgBox, XRectOutline, colorSpec, edmColor, geom, pvProp, useVis } from './shared.js';

const CLS = 'activeRectangleClass';

export function Rectangle({ obj }: EdmWidgetProps) {
  const { palette } = useEdmScreen();
  const p = obj.props;
  const g = geom(p);
  const alarmPv = pvProp(p, 'alarmPv');
  const alarm = useEdmPv(alarmPv, `${CLS}.alarmPv`);
  const { visible, data: vis, defined: hasVis } = useVis(p, CLS);
  const phase = usePhase([...(alarmPv ? [alarm] : []), ...(hasVis ? [vis] : [])]);
  // EDM draws nothing until every PV has connected, then (after 2 s) a 1-px
  // outline in the disconnected colour; once initialised, a dropped PV
  // repaints the shape in the disconnected colour.
  if (phase === 'waiting') return null;
  if (phase === 'unconnected') return <Unconnected {...g} color={palette.disconnected()} />;
  if (!visible || propBool(p, 'invisible')) return null;
  const down = [alarm, vis].some((d) => d && !d.connected);

  const lineSpec = colorSpec(p, 'lineColor');
  const fillSpec = colorSpec(p, 'fillColor');
  const lw = propInt(p, 'lineWidth', 1);
  // The "invisible" colour hides a part only when there is no visPv.
  const fillShown = propBool(p, 'fill') && (hasVis || !palette.isInvisible(fillSpec, alarm?.num));
  const lineShown = hasVis || !palette.isInvisible(lineSpec, alarm?.num);
  const fill = down
    ? palette.disconnected()
    : edmColor(palette, fillSpec, { data: alarm, alarmSensitive: propBool(p, 'fillAlarm') });
  const line = down
    ? palette.disconnected()
    : edmColor(palette, lineSpec, { data: alarm, alarmSensitive: propBool(p, 'lineAlarm') });
  const pad = Math.max(1, lw);
  return (
    <SvgBox x={g.x - pad} y={g.y - pad} w={g.w + 2 * pad + 1} h={g.h + 2 * pad + 1}>
      {fillShown ? (
        <rect x={g.x} y={g.y} width={Math.max(0, g.w)} height={Math.max(0, g.h)} fill={fill} />
      ) : null}
      {lineShown ? (
        <XRectOutline
          {...g}
          lineWidth={lw}
          color={line}
          dash={propStr(p, 'lineStyle') === 'dash'}
        />
      ) : null}
    </SvgBox>
  );
}

/** EDM's unconnected look for graphics: a 1-px outline in the disconnected colour. */
export function Unconnected({
  x,
  y,
  w,
  h,
  color,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  color?: string;
}) {
  return (
    <SvgBox x={x - 1} y={y - 1} w={w + 3} h={h + 3}>
      <XRectOutline x={x} y={y} w={w} h={h} lineWidth={1} color={color} />
    </SvgBox>
  );
}
