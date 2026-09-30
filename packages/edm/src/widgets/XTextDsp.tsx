// activeXTextDspClass (Text Control) and its :noedit variant. Behaviour
// matches EDM's baselib/x_text_dsp_obj.cc:
//   - value: doubles print with "%[fieldLen].[prec](f|e|g)" by `format`
//     (prec = the channel's PREC when limitsFromDb or no `precision`), integers
//     "%d" / "%X" / "0x%X", enums their label, strings as is; showUnits appends
//     " EGU" to numbers;
//   - drawn text: bgColor box (unless useDisplayBg), text at
//     y + ascent + h/2 - fontHeight/2, left/right inset by fontHeight/4 when
//     the box is filled; alarm border (2 px) with useAlarmBorder + fgAlarm;
//   - motifWidget (non-enum): a Motif text field — sunken 2-px bevel in Motif
//     shadow colours of bgColor, text left-aligned 7 px in, baseline at the
//     font's max ascent + 2; autoHeight (and pre-newPos files, which also sit
//     3 px higher) take the font height + 4;
//   - colorPv evaluates colour rules; `editable` defaults to 0 (display only).
// Written from that behaviour; no EDM code is copied. Writes are M1.

import { AlarmSeverity } from '@slaclab/canopy-client';
import { motifShadows } from '../config/motif.js';
import type { EdmFont } from '../config/fonts.js';
import { resolveFont, textWidth } from '../config/fonts.js';
import { cFormat } from '../format.js';
import { propBool, propStr } from '../model.js';
import type { EdmProps } from '../model.js';
import type { EdmPvData } from '../pv/types.js';
import { useEdmPv, useEdmScreen } from '../screen/context.js';
import type { EdmWidgetProps } from './registry.js';
import { SvgBox, TextRun, XRectOutline, alignOf, colorSpec, geom, idiv } from './shared.js';

/** The Text Control value string for a channel update. */
export function textControlValue(p: EdmProps, d: EdmPvData): string {
  const format = propStr(p, 'format') ?? 'default';
  const fieldLen = (propStr(p, 'fieldLen') ?? '').trim();
  const precAttr = propStr(p, 'precision');
  let value: string;
  let numeric = false;
  switch (d.type) {
    case 'double': {
      const prec =
        propBool(p, 'limitsFromDb') || precAttr === undefined || precAttr.trim() === ''
          ? (d.precision ?? 0)
          : Math.max(0, parseInt(precAttr, 10) || 0);
      const conv = format === 'exponential' ? 'e' : format === 'gfloat' ? 'g' : 'f';
      value = cFormat(`%${fieldLen}.${prec}${conv}`, d.num);
      numeric = true;
      break;
    }
    case 'integer': {
      const width = fieldLen || '-';
      value =
        format === 'hex'
          ? cFormat(propBool(p, 'useHexPrefix') ? `0x%${width}X` : `%${width}X`, d.num)
          : cFormat(`%${width}d`, d.num);
      numeric = true;
      break;
    }
    case 'enum':
      value = d.text;
      break;
    default:
      value = d.text;
  }
  if (numeric && propBool(p, 'showUnits') && d.units.trim() && value.trim()) value += ` ${d.units}`;
  return value;
}

export function makeTextDsp(cls: string) {
  return function XTextDsp({ obj }: EdmWidgetProps) {
    const { palette } = useEdmScreen();
    const p = obj.props;
    const g = geom(p);
    const font = resolveFont(propStr(p, 'font'));
    const pv = useEdmPv(propStr(p, 'controlPv'), `${cls}.controlPv`);
    const cpv = useEdmPv(propStr(p, 'colorPv'), `${cls}.colorPv`);
    if (!propStr(p, 'controlPv')?.trim()) return null;
    if (!pv) return null;
    if (!pv.connected) {
      // EDM's unconnected Text Control: a 2-px outline in the disconnected colour.
      return (
        <SvgBox x={g.x - 2} y={g.y - 2} w={g.w + 5} h={g.h + 5}>
          <XRectOutline
            {...g}
            lineWidth={2}
            color={palette.alarm[AlarmSeverity.DISCONNECTED] ?? '#ffffff'}
          />
        </SvgBox>
      );
    }
    const text = textControlValue(p, pv);
    const fgAlarm = propBool(p, 'fgAlarm');
    const alarmed = fgAlarm && pv.severity !== AlarmSeverity.NO_ALARM;
    const ruleValue = cpv?.num;
    const fgOwn = palette.spec(colorSpec(p, 'fgColor'), ruleValue);
    const fgAlarmColor = alarmed ? (palette.alarm[pv.severity] ?? fgOwn) : fgOwn;
    const useAlarmBorder = propBool(p, 'useAlarmBorder') && fgAlarm;
    // With an alarm border the text keeps its own colour and the border alarms.
    const fg = useAlarmBorder ? fgOwn : fgAlarmColor;
    const bgOwn = palette.spec(colorSpec(p, 'bgColor'), ruleValue);
    const bg =
      propBool(p, 'bgAlarm') && pv.severity !== AlarmSeverity.NO_ALARM
        ? (palette.alarm[pv.severity] ?? bgOwn)
        : bgOwn;
    const useDisplayBg = propBool(p, 'useDisplayBg');

    if (propBool(p, 'motifWidget') && pv.type !== 'enum') {
      return <MotifField obj={obj} font={font} text={text} fg={fg} bg={bgOwn} />;
    }

    const fontHeight = font.ascent + font.descent;
    const sw = textWidth(font, text);
    const inset = !useDisplayBg || useAlarmBorder ? idiv(fontHeight, 4) : 0;
    const align = alignOf(p);
    const sx =
      align === 'left'
        ? g.x + inset
        : align === 'center'
          ? g.x + idiv(g.w, 2) - idiv(sw, 2)
          : g.x + g.w - sw - inset;
    const sy = g.y + font.ascent + idiv(g.h, 2) - idiv(fontHeight, 2);
    const clip = !propBool(p, 'noExecuteClipMask');
    return (
      <SvgBox x={g.x - 1} y={g.y - 1} w={g.w + 3} h={g.h + 3} clip={clip}>
        {!useDisplayBg ? <rect x={g.x} y={g.y} width={g.w + 1} height={g.h + 1} fill={bg} /> : null}
        <TextRun font={font} text={text} x={sx} y={sy} fill={fg} />
        {useAlarmBorder && alarmed ? (
          <XRectOutline {...g} lineWidth={2} color={fgAlarmColor} />
        ) : null}
      </SvgBox>
    );
  };
}

/** Motif XmTextField look (shadow 2, marginWidth 5, marginHeight 0, no highlight). */
function MotifField({
  obj,
  font,
  text,
  fg,
  bg,
}: {
  obj: EdmWidgetProps['obj'];
  font: EdmFont;
  text: string;
  fg: string | undefined;
  bg: string | undefined;
}) {
  const p = obj.props;
  const g = geom(p);
  const newPos = propBool(p, 'newPos');
  const y = newPos ? g.y : g.y - 3;
  const autoHeight = propBool(p, 'autoHeight') || !newPos;
  const h = autoHeight ? font.maxAscent + font.maxDescent + 4 : g.h;
  const { x, w } = g;
  const sh = motifShadows(bg ?? '#ffffff');
  const r = (x0: number, y0: number, ww: number, hh: number, c: string, k: string) =>
    ww > 0 && hh > 0 ? (
      <rect key={k} x={x + x0} y={y + y0} width={ww} height={hh} fill={c} />
    ) : null;
  return (
    <SvgBox x={x} y={y} w={w} h={h} clip>
      <rect x={x} y={y} width={w} height={h} fill={bg} />
      {r(0, 0, w, 1, sh.bottom, 'd0')}
      {r(0, 1, w - 1, 1, sh.bottom, 'd1')}
      {r(0, 2, 1, h - 2, sh.bottom, 'd2')}
      {r(1, 2, 1, h - 3, sh.bottom, 'd3')}
      {r(w - 1, 1, 1, h - 1, sh.top, 'l0')}
      {r(w - 2, 2, 1, h - 2, sh.top, 'l1')}
      {r(1, h - 1, w - 2, 1, sh.top, 'l2')}
      {r(2, h - 2, w - 4, 1, sh.top, 'l3')}
      <svg
        x={x + 2}
        y={y + 2}
        width={Math.max(0, w - 4)}
        height={Math.max(0, h - 4)}
        viewBox={`${x + 2} ${y + 2} ${Math.max(0, w - 4)} ${Math.max(0, h - 4)}`}
        overflow="hidden"
      >
        <TextRun font={font} text={text} x={x + 7} y={y + 2 + font.maxAscent} fill={fg} />
      </svg>
    </SvgBox>
  );
}
