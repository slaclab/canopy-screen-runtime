// TextupdateClass (pvFactory text update). Behaviour matches EDM's
// pvFactory/textupdate.cc (get_current_values, redraw_text):
//   - text: displayMode default → the channel's own string (enum label,
//     string, or cvtDoubleToString(value, PREC) + " " + EGU; integers "%d");
//     decimal/exp/engineer/hex use the object's `precision` (default 0);
//     disconnected → "<pvname>";
//   - `fill` paints bgColor over x, y, w, h; lineWidth > 0 draws a border in
//     the text colour, hidden at NO_ALARM when lineAlarm;
//   - text colour = fgColor, a colour rule evaluated on colorPv (else the
//     control PV), alarm colours when fgAlarm;
//   - x by fontAlign (C integer arithmetic), baseline y + (ascent + h)/2,
//     clipped to the object.

import { AlarmSeverity } from '@slaclab/canopy-client';
import { resolveFont, textWidth } from '../config/fonts.js';
import {
  cvtDoubleToExpString,
  cvtDoubleToString,
  cvtLongToHexString,
  expNotation,
} from '../format.js';
import { propBool, propInt, propStr } from '../model.js';
import type { EdmPvData } from '../pv/types.js';
import { useEdmPv, useEdmScreen, useExpanded } from '../screen/context.js';
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
} from './shared.js';

const CLS = 'TextupdateClass';

/** The channel's own string (pvFactory PVValue::get_string). */
export function pvString(d: EdmPvData): string {
  const units = d.units ? ` ${d.units}` : '';
  switch (d.type) {
    case 'enum':
      return d.text;
    case 'string':
    case 'array':
      return d.text;
    case 'integer':
      return `${Math.trunc(d.num)}${units}`;
    default:
      return `${cvtDoubleToString(d.num, d.precision ?? 0)}${units}`;
  }
}

export function textupdateText(d: EdmPvData, mode: string | undefined, precision: number): string {
  const numeric = d.type === 'double' || d.type === 'integer';
  if (numeric) {
    switch (mode) {
      case 'exp':
        return cvtDoubleToExpString(d.num, precision);
      case 'engineer':
        return expNotation(d.num, precision);
      case 'hex':
        return cvtLongToHexString(d.num);
      case 'decimal':
        return cvtDoubleToString(d.num, precision);
    }
  }
  return pvString(d);
}

/**
 * A POSIX extended regular expression as EDM's regex classes apply it: the
 * displayed text is capture group 1 of the match (empty without one), the
 * whole text when nothing matches or the pattern is invalid. Translated to
 * a JS RegExp for the common cases (bracket classes; `\d` is a literal d).
 */
export function applyRegExpr(text: string, pattern: string): string {
  if (!pattern) return text;
  const js = pattern
    .replaceAll('[:digit:]', '0-9')
    .replaceAll('[:alpha:]', 'A-Za-z')
    .replaceAll('[:alnum:]', 'A-Za-z0-9')
    .replaceAll('[:upper:]', 'A-Z')
    .replaceAll('[:lower:]', 'a-z')
    .replaceAll('[:space:]', '\\s')
    .replaceAll('[:xdigit:]', '0-9A-Fa-f')
    .replace(/\\d/g, 'd');
  let re: RegExp;
  try {
    re = new RegExp(js, 's');
  } catch {
    return text;
  }
  const m = re.exec(text);
  if (!m) return text;
  return m[1] ?? '';
}

export function Textupdate(props: EdmWidgetProps) {
  return <TextupdateBody {...props} cls={CLS} />;
}

/**
 * RegTextupdateClass (pvFactory/regTextupdate.cc): Textupdate with `regExpr`
 * applied to the text (at most 79 characters), and drawn even inside a
 * hidden group (its redraw never checks whether it is enabled).
 */
export function RegTextupdate(props: EdmWidgetProps) {
  return <TextupdateBody {...props} cls="RegTextupdateClass" reg />;
}

function TextupdateBody({ obj, cls, reg }: EdmWidgetProps & { cls: string; reg?: boolean }) {
  const { palette } = useEdmScreen();
  const p = obj.props;
  const g = geom(p);
  const font = resolveFont(propStr(p, 'font'));
  const controlPv = propStr(p, 'controlPv');
  const colorPv = propStr(p, 'colorPv');
  const pv = useEdmPv(controlPv, `${cls}.controlPv`);
  const cpv = useEdmPv(colorPv, `${cls}.colorPv`);
  const expandedName = useExpanded(controlPv) ?? '';

  const valid = !!pv?.connected;
  let text = valid
    ? textupdateText(pv, propStr(p, 'displayMode'), propInt(p, 'precision', 0))
    : `<${expandedName}>`;
  if (reg) {
    text = text.slice(0, 79);
    if (valid) text = applyRegExpr(text, propStr(p, 'regExpr') ?? '');
  }
  const fgSpec = colorSpec(p, 'fgColor');
  const ruleSrc = colorPv?.trim() ? cpv : pv;
  let fg: string | undefined;
  if (!valid) fg = palette.alarm[AlarmSeverity.DISCONNECTED] ?? '#ffffff';
  else {
    fg = palette.spec(fgSpec, ruleSrc?.num);
    if (propBool(p, 'fgAlarm') && pv.severity !== AlarmSeverity.NO_ALARM)
      fg = palette.alarm[pv.severity] ?? fg;
  }
  // Fill is evaluated statically (the fill colour never follows a PV).
  const bg = edmColor(palette, colorSpec(p, 'bgColor'));
  const lineAlarm = propBool(p, 'lineAlarm');
  let lw = propInt(p, 'lineWidth', 0);
  if (lineAlarm && lw <= 0) lw = 1;
  const showLine = lw > 0 && !(lineAlarm && valid && pv.severity === AlarmSeverity.NO_ALARM);
  // The border uses the fg colour index as a static colour, alarm-sensitive via lineAlarm.
  const line = !valid
    ? fg
    : lineAlarm && pv.severity !== AlarmSeverity.NO_ALARM
      ? (palette.alarm[pv.severity] ?? palette.spec(fgSpec))
      : palette.spec(fgSpec);

  const tw = textWidth(font, text);
  const align = alignOf(p);
  const tx = align === 'left' ? g.x : align === 'center' ? g.x + idiv(g.w - tw, 2) : g.x + g.w - tw;
  const ty = g.y + idiv(font.ascent + g.h, 2);
  const pad = Math.max(1, lw);

  return (
    <SvgBox
      x={g.x - pad}
      y={g.y - pad}
      w={g.w + 2 * pad + 1}
      h={g.h + 2 * pad + 1}
      style={reg ? SHOWS_IN_HIDDEN_GROUP : undefined}
    >
      {propBool(p, 'fill') ? <rect x={g.x} y={g.y} width={g.w} height={g.h} fill={bg} /> : null}
      {showLine ? <XRectOutline {...g} lineWidth={lw} color={line} /> : null}
      <svg
        x={g.x}
        y={g.y}
        width={Math.max(0, g.w)}
        height={Math.max(0, g.h)}
        viewBox={`${g.x} ${g.y} ${Math.max(0, g.w)} ${Math.max(0, g.h)}`}
        overflow="hidden"
      >
        <TextRun font={font} text={text} x={tx} y={ty} fill={fg} />
      </svg>
    </SvgBox>
  );
}
