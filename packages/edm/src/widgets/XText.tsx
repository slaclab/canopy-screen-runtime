// activeXTextClass (static text), after EDM baselib/x_text_obj.cc
// createFromFile / drawActive / updateDimensions.

import { resolveFont } from '../config/fonts.js';
import { propBool, propInt, propStr, propText } from '../model.js';
import { useEdmPv, useEdmScreen, useExpanded, usePhase } from '../screen/context.js';
import type { EdmWidgetProps } from './registry.js';
import {
  SHOWS_IN_HIDDEN_GROUP,
  SvgBox,
  TextRun,
  XRectOutline,
  alignOf,
  colorSpec,
  edmColor,
  geom,
  idiv,
  layoutStrings,
  pvProp,
  useVis,
} from './shared.js';

const CLS = 'activeXTextClass';

export function XText({ obj }: EdmWidgetProps) {
  const { palette } = useEdmScreen();
  const p = obj.props;
  const g = geom(p);
  const font = resolveFont(propStr(p, 'font'));
  const raw = propText(p, 'value') ?? '';
  const text = useExpanded(raw) ?? '';
  const alarmPv = pvProp(p, 'alarmPv');
  const alarm = useEdmPv(alarmPv, `${CLS}.alarmPv`);
  const { visible, data: vis, defined: hasVis } = useVis(p, CLS);
  const phase = usePhase([...(alarmPv ? [alarm] : []), ...(hasVis ? [vis] : [])]);
  const fgSpec = colorSpec(p, 'fgColor');
  const bgSpec = colorSpec(p, 'bgColor');

  // Static text is gated by visibility only: with a visPv it stays hidden
  // until that connects; with just an alarmPv it shows its static colours at
  // once. While not initialised, after 2 s EDM draws the string alone in the
  // disconnected colour; a PV dropped later recolours text and box.
  const init = phase === 'init';
  const placeholder = phase === 'unconnected';
  if (!init && hasVis && !placeholder) return null;
  if (init && !visible) return null;

  const live = init ? alarm : undefined;
  const down = init && [alarm, vis].some((d) => d && !d.connected);
  const fgAlarm = propBool(p, 'fgAlarm');
  const bgAlarm = propBool(p, 'bgAlarm');
  const fg =
    placeholder || down
      ? palette.disconnected()
      : edmColor(palette, fgSpec, { data: live, alarmSensitive: fgAlarm });
  const bg = down
    ? palette.disconnected()
    : edmColor(palette, bgSpec, { data: live, alarmSensitive: bgAlarm });
  // drawActive draws everything under fgVisibility (the fg colour is not the
  // colors.list "invisible" static); only without a visPv.
  if (init && !hasVis && palette.isInvisible(fgSpec, alarm?.num)) return null;

  const align = alignOf(p);
  // updateDimensions: box size of the (multi-line) string, then its first
  // baseline centred in the object. autoSize sizes the object to the string
  // twice: at load to the raw string (x kept), then on activation to the
  // macro-expanded one, keeping the centre or right edge of the loaded box.
  const probe = layoutStrings(font, text || ' ', g.x, 0, g.w, align);
  let { x, w, h } = g;
  if (propBool(p, 'autoSize')) {
    const loaded = layoutStrings(font, raw || ' ', g.x, 0, g.w, align);
    if (align === 'center') x = x - idiv(probe.boxW, 2) + idiv(loaded.boxW, 2);
    else if (align === 'right') x = x - probe.boxW + loaded.boxW;
    w = probe.boxW;
    h = probe.boxH;
  }
  const stringY = g.y + font.ascent + idiv(h, 2) - idiv(probe.boxH, 2);
  const lay = layoutStrings(font, text, x, stringY, w, align);
  const border = propBool(p, 'border');
  const lt = Math.max(0, propInt(p, 'lineWidth', 1));

  return (
    <SvgBox x={x} y={g.y} w={w} h={h} clip style={placeholder ? SHOWS_IN_HIDDEN_GROUP : undefined}>
      {!propBool(p, 'useDisplayBg') && !placeholder ? (
        <rect x={x} y={g.y} width={w} height={h} fill={bg} />
      ) : null}
      {lay.lines.map((l, i) => (
        <TextRun key={i} font={font} text={l.text} x={l.x} y={l.y} fill={fg} />
      ))}
      {border && !placeholder ? (
        <XRectOutline
          x={x + idiv(lt, 2)}
          y={g.y + idiv(lt, 2)}
          w={w - lt}
          h={h - lt}
          lineWidth={lt}
          color={fg}
        />
      ) : null}
    </SvgBox>
  );
}
