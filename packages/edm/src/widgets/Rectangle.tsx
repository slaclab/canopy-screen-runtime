// activeRectangleClass, after EDM baselib/rectangle_obj.cc drawActive:
// XFillRectangle(x, y, w, h) when `fill`, then XDrawRectangle(x, y, w, h)
// with lineWidth/lineStyle. alarmPv drives rule colours and, with
// lineAlarm/fillAlarm, alarm colours; `invisible` draws nothing.

import { propBool, propInt, propStr } from '../model.js';
import { useEdmPv, useEdmScreen } from '../screen/context.js';
import type { EdmWidgetProps } from './registry.js';
import { SvgBox, XRectOutline, colorSpec, edmColor, geom, useVisibility } from './shared.js';

const CLS = 'activeRectangleClass';

export function Rectangle({ obj }: EdmWidgetProps) {
  const { palette } = useEdmScreen();
  const p = obj.props;
  const g = geom(p);
  const alarmPv = propStr(p, 'alarmPv');
  const alarm = useEdmPv(alarmPv, `${CLS}.alarmPv`);
  const visible = useVisibility(p, CLS);
  if (visible === null || (alarmPv?.trim() && !alarm)) return null;
  if (alarm && !alarm.connected)
    return <Unconnected {...g} color={edmColor(palette, undefined, { data: alarm })} />;
  if (!visible || propBool(p, 'invisible')) return null;

  const lineSpec = colorSpec(p, 'lineColor');
  const fillSpec = colorSpec(p, 'fillColor');
  const lw = propInt(p, 'lineWidth', 1);
  const fillShown = propBool(p, 'fill') && !palette.isInvisible(fillSpec, alarm?.num);
  const lineShown = !palette.isInvisible(lineSpec, alarm?.num);
  const fill = edmColor(palette, fillSpec, {
    data: alarm,
    alarmSensitive: propBool(p, 'fillAlarm'),
  });
  const line = edmColor(palette, lineSpec, {
    data: alarm,
    alarmSensitive: propBool(p, 'lineAlarm'),
  });
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
