// activeXTextDspClass (Text Control) and its :noedit variant, and
// TextentryClass. Behaviour matches EDM's baselib/x_text_dsp_obj.cc and
// pvFactory/textupdate.cc (edmTextentryClass):
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
//   - nothing is drawn until the PVs connect (after 2 s: a 2-px outline in the
//     disconnected colour); a PV dropped later turns text and box to the
//     disconnected colour;
//   - nullPv/nullCondition: the text takes nullColor while the value equals
//     the null PV's (nullEqCtl) or the null PV is 0 (nullEq0), below alarm
//     colours; colorPv evaluates colour rules;
//   - `editable` (default 0): a click edits the value in place; Enter writes
//     it if it is a legal number for the channel's type (and inside the
//     display limits with clipToDspLimits), Escape or leaving cancels; enum
//     channels offer their states in a menu. EDM's separate entry dialog,
//     keypad, calendar and file selector are not reproduced;
//   - Textentry: a Motif text field with a 3-px highlight margin showing the
//     Textupdate text; Enter writes it (numbers by their numeric prefix).
// Written from that behaviour; no EDM code is copied.

import { useState } from 'react';
import { AlarmSeverity } from '@slaclab/canopy-client';
import { motifShadows } from '../config/motif.js';
import type { EdmFont } from '../config/fonts.js';
import { resolveFont, textWidth } from '../config/fonts.js';
import { cFormat } from '../format.js';
import { propBool, propInt, propStr } from '../model.js';
import type { EdmProps } from '../model.js';
import type { EdmPvData } from '../pv/types.js';
import { useEdmPut, useEdmPv, useEdmScreen, useExpanded, usePhase } from '../screen/context.js';
import { Hotspot, PopupMenu } from './button.js';
import type { EdmWidgetProps } from './registry.js';
import { textupdateText } from './Textupdate.js';
import {
  SHOWS_IN_HIDDEN_GROUP,
  SvgBox,
  TextRun,
  XRectOutline,
  alignOf,
  colorSpec,
  fontStyle,
  geom,
  idiv,
  pvProp,
  motifOrigin,
} from './shared.js';

/** The Text Control value string for a channel update. */
export function textControlValue(p: EdmProps, d: EdmPvData): string {
  const format = propStr(p, 'format') ?? 'default';
  const fieldLen = (propStr(p, 'fieldLen') ?? '').trim();
  const precAttr = propStr(p, 'precision');
  let value: string;
  let numeric = false;
  // `hex` turns a double channel into an integer one (truncated) from connect time.
  const type = d.type === 'double' && format === 'hex' ? 'integer' : d.type;
  switch (type) {
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

const LEGAL_FLOAT = /^\s*[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?\s*$/i;
const LEGAL_INT = /^\s*([+-]?\d+|0x[0-9a-f]+)\s*$/i;

/** The value a Text Control writes for typed text, or null when EDM writes nothing. */
export function textControlWrite(p: EdmProps, d: EdmPvData, text: string): number | string | null {
  const hex = propStr(p, 'format') === 'hex';
  let v: number | string;
  if (d.type === 'string' || d.type === 'array') return text.slice(0, 255);
  if (d.type === 'integer' || hex) {
    const t = hex && !/^\s*0x/i.test(text) ? `0x${text.trim()}` : text;
    if (!LEGAL_INT.test(t)) return null;
    v = /0x/i.test(t) ? parseInt(t.trim(), 16) : parseInt(t, 10);
  } else if (d.type === 'double') {
    if (!LEGAL_FLOAT.test(text)) return null;
    v = Number(text);
  } else return null;
  // clipToDspLimits rejects (does not clamp) values outside the display limits.
  if (propBool(p, 'clipToDspLimits') && (v < d.lowerLimit || v > d.upperLimit)) return null;
  return v;
}

/** An in-place text editor over a widget: Enter commits, Escape or blur cancels. */
function InlineEdit({
  x,
  y,
  w,
  h,
  font,
  initial,
  fg,
  bg,
  onCommit,
  onCancel,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  font: EdmFont;
  initial: string;
  fg: string | undefined;
  bg: string | undefined;
  onCommit: (text: string) => void;
  onCancel: () => void;
}) {
  return (
    <input
      data-edm-edit=""
      autoFocus
      defaultValue={initial}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={onCancel}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onCommit(e.currentTarget.value);
        else if (e.key === 'Escape') onCancel();
      }}
      style={{
        ...fontStyle(font),
        position: 'absolute',
        left: x,
        top: y,
        width: w,
        height: h,
        boxSizing: 'border-box',
        margin: 0,
        padding: '0 5px',
        border: '2px inset',
        borderRadius: 0,
        outline: 'none',
        color: fg,
        background: bg,
        zIndex: 10,
        pointerEvents: 'auto',
      }}
    />
  );
}

export function makeTextDsp(cls: string) {
  return function XTextDsp({ obj }: EdmWidgetProps) {
    const { palette, displayBg } = useEdmScreen();
    const p = obj.props;
    const g = geom(p);
    const font = resolveFont(propStr(p, 'font'));
    const controlPv = pvProp(p, 'controlPv');
    const colorPv = pvProp(p, 'colorPv');
    const nullPv = pvProp(p, 'nullPv');
    const pv = useEdmPv(controlPv, `${cls}.controlPv`);
    const cpv = useEdmPv(colorPv, `${cls}.colorPv`);
    const npv = useEdmPv(nullPv, `${cls}.nullPv`);
    const put = useEdmPut();
    const [editing, setEditing] = useState(false);
    const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
    const phase = usePhase([
      ...(controlPv ? [pv] : []),
      ...(colorPv ? [cpv] : []),
      ...(nullPv ? [npv] : []),
    ]);
    if (!controlPv) return null;
    if (phase !== 'init' || !pv) {
      // EDM's unconnected Text Control: a 2-px outline in the disconnected colour.
      return phase === 'unconnected' ? (
        <SvgBox x={g.x - 2} y={g.y - 2} w={g.w + 5} h={g.h + 5} style={SHOWS_IN_HIDDEN_GROUP}>
          <XRectOutline {...g} lineWidth={2} color={palette.disconnected()} />
        </SvgBox>
      ) : null;
    }
    const down = [pv, cpv, npv].some((d) => d && !d.connected);
    const text = textControlValue(p, pv);
    const fgAlarm = propBool(p, 'fgAlarm');
    const alarmed = fgAlarm && pv.severity !== AlarmSeverity.NO_ALARM;
    const ruleValue = cpv?.num;
    // Null colour: below alarm colours, above the normal (rule) colour.
    const nullMode = propStr(p, 'nullCondition') ?? 'nullEqCtl';
    const isNull =
      !!npv?.connected &&
      pv.type !== 'string' &&
      pv.type !== 'array' &&
      (nullMode === 'nullEqCtl'
        ? pv.num === npv.num
        : nullMode === 'nullEq0'
          ? npv.num === 0
          : false);
    const fgBase = isNull
      ? palette.spec(colorSpec(p, 'nullColor'))
      : palette.spec(colorSpec(p, 'fgColor'), ruleValue);
    const fgOwn = down ? palette.disconnected() : fgBase;
    const fgAlarmColor = down
      ? palette.disconnected()
      : alarmed
        ? (palette.alarm[pv.severity] ?? fgBase)
        : fgAlarm
          ? (palette.alarm[AlarmSeverity.NO_ALARM] ?? fgBase)
          : fgBase;
    const useAlarmBorder = propBool(p, 'useAlarmBorder') && fgAlarm;
    // With an alarm border the text keeps its own colour and the border alarms.
    const fg = useAlarmBorder ? fgOwn : fgAlarmColor;
    const bgOwn = palette.spec(colorSpec(p, 'bgColor'), ruleValue);
    const bg = down
      ? palette.disconnected()
      : propBool(p, 'bgAlarm') && pv.severity !== AlarmSeverity.NO_ALARM
        ? (palette.alarm[pv.severity] ?? bgOwn)
        : bgOwn;
    const useDisplayBg = propBool(p, 'useDisplayBg');
    const isWidget = propBool(p, 'motifWidget') && pv.type !== 'enum';

    const editable = propBool(p, 'editable');
    const writable = pv.connected && pv.writable;
    const field = isWidget ? motifBox(p, font) : g;
    const controls = editable ? (
      <>
        <Hotspot
          {...g}
          cls={cls}
          cursor="text"
          denied={!writable}
          onPress={(e) => {
            if (e.button !== 0 || !writable) return;
            if (pv.type === 'enum') setMenu({ x: e.clientX, y: e.clientY });
            else setEditing(true);
          }}
        />
        {editing ? (
          <InlineEdit
            {...field}
            font={font}
            initial={text.trim()}
            fg={palette.spec(colorSpec(p, 'fgColor'))}
            bg={useDisplayBg ? displayBg : bgOwn}
            onCancel={() => setEditing(false)}
            onCommit={(typed) => {
              const v = textControlWrite(p, pv, typed);
              if (v !== null) put(controlPv, v);
              setEditing(false);
            }}
          />
        ) : null}
        {menu ? (
          <PopupMenu
            at={menu}
            onClose={() => setMenu(null)}
            items={pv.enumChoices.map((label, i) => ({
              label,
              onSelect: () => put(controlPv, i),
            }))}
          />
        ) : null}
      </>
    ) : null;

    if (isWidget) {
      return (
        <>
          <MotifTextField
            {...field}
            font={font}
            text={text}
            fg={fg}
            bg={down ? palette.disconnected() : bgOwn}
            highlight={0}
            marginHeight={0}
            border={useAlarmBorder && alarmed && !down ? fgAlarmColor : undefined}
          />
          {controls}
        </>
      );
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
      <>
        <SvgBox x={g.x - 1} y={g.y - 1} w={g.w + 3} h={g.h + 3} clip={clip}>
          {!useDisplayBg ? (
            <rect x={g.x} y={g.y} width={g.w + 1} height={g.h + 1} fill={bg} />
          ) : null}
          <TextRun font={font} text={text} x={sx} y={sy} fill={fg} />
          {useAlarmBorder && alarmed && !down ? (
            <XRectOutline {...g} lineWidth={2} color={fgAlarmColor} />
          ) : null}
        </SvgBox>
        {controls}
      </>
    );
  };
}

/** Where EDM's Motif text field sits: pre-newPos files are 3 px higher and auto-height. */
function motifBox(p: EdmProps, font: EdmFont): { x: number; y: number; w: number; h: number } {
  const g = geom(p);
  const newPos = propBool(p, 'newPos');
  const autoHeight = propBool(p, 'autoHeight') || !newPos;
  const o = motifOrigin(g.x, newPos ? g.y : g.y - 3);
  return {
    x: o.x,
    y: o.y,
    w: g.w,
    h: autoHeight ? font.maxAscent + font.maxDescent + 4 : g.h,
  };
}

/**
 * Motif XmTextField look: an optional highlight margin (drawn in the display
 * background when unfocused), a 2-px sunken bevel in Motif's shadow colours
 * of `bg`, text 5 px inside the bevel on a baseline at the font's max ascent
 * below the top margin.
 */
function MotifTextField({
  x,
  y,
  w,
  h,
  font,
  text,
  fg,
  bg,
  highlight,
  marginHeight,
  border,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  font: EdmFont;
  text: string;
  fg: string | undefined;
  bg: string | undefined;
  highlight: number;
  marginHeight: number;
  /** An X window border (2 px, outside the widget, which moves in by 2): the alarm border. */
  border?: string;
}) {
  const { displayBg } = useEdmScreen();
  const sh = motifShadows(bg ?? '#ffffff');
  const bw = border ? 2 : 0;
  const ox = x + bw + highlight;
  const oy = y + bw + highlight;
  const iw = w - 2 * highlight;
  const ih = h - 2 * highlight;
  const r = (x0: number, y0: number, ww: number, hh: number, c: string, k: string) =>
    ww > 0 && hh > 0 ? (
      <rect key={k} x={ox + x0} y={oy + y0} width={ww} height={hh} fill={c} />
    ) : null;
  return (
    <SvgBox x={x} y={y} w={w + 2 * bw} h={h + 2 * bw} clip>
      {border ? <rect x={x} y={y} width={w + 4} height={h + 4} fill={border} /> : null}
      {highlight > 0 ? <rect x={x + bw} y={y + bw} width={w} height={h} fill={displayBg} /> : null}
      <rect x={ox} y={oy} width={Math.max(0, iw)} height={Math.max(0, ih)} fill={bg} />
      {r(0, 0, iw, 1, sh.bottom, 'd0')}
      {r(0, 1, iw - 1, 1, sh.bottom, 'd1')}
      {r(0, 2, 1, ih - 2, sh.bottom, 'd2')}
      {r(1, 2, 1, ih - 3, sh.bottom, 'd3')}
      {r(iw - 1, 1, 1, ih - 1, sh.top, 'l0')}
      {r(iw - 2, 2, 1, ih - 2, sh.top, 'l1')}
      {r(1, ih - 1, iw - 2, 1, sh.top, 'l2')}
      {r(2, ih - 2, iw - 4, 1, sh.top, 'l3')}
      <svg
        x={ox + 2}
        y={oy + 2}
        width={Math.max(0, iw - 4)}
        height={Math.max(0, ih - 4)}
        viewBox={`${ox + 2} ${oy + 2} ${Math.max(0, iw - 4)} ${Math.max(0, ih - 4)}`}
        overflow="hidden"
      >
        <TextRun
          font={font}
          text={text}
          x={ox + 7}
          y={oy + 2 + marginHeight + font.maxAscent}
          fill={fg}
        />
      </svg>
    </SvgBox>
  );
}

const ENTRY = 'TextentryClass';

/** What a Textentry writes for typed text (textupdate.cc text_entered_callback). */
export function textEntryWrite(
  mode: string | undefined,
  d: EdmPvData,
  text: string
): number | string {
  if (mode === 'hex') return parseInt(text, 16) || 0;
  if (mode === 'decimal' || mode === 'engineer' || mode === 'exp') return text;
  if (d.type === 'double' || d.type === 'integer') {
    const n = parseFloat(text);
    return Number.isFinite(n) ? n : 0;
  }
  return text;
}

export function Textentry({ obj }: EdmWidgetProps) {
  const { palette } = useEdmScreen();
  const p = obj.props;
  const g = geom(p);
  const font = resolveFont(propStr(p, 'font'));
  const controlPv = pvProp(p, 'controlPv');
  const colorPv = pvProp(p, 'colorPv');
  const pv = useEdmPv(controlPv, `${ENTRY}.controlPv`);
  const cpv = useEdmPv(colorPv, `${ENTRY}.colorPv`);
  const name = useExpanded(controlPv) ?? '';
  const put = useEdmPut();
  const [editing, setEditing] = useState(false);
  const valid = !!pv?.connected;
  const mode = propStr(p, 'displayMode');
  const text = valid ? textupdateText(pv, mode, propInt(p, 'precision', 0)) : `<${name}>`;
  // fgColor rule on colorPv (else the control PV); alarm colours with fgAlarm,
  // a missing or disconnected PV counting as INVALID.
  let fg = palette.spec(colorSpec(p, 'fgColor'), (colorPv ? cpv : pv)?.num);
  if (propBool(p, 'fgAlarm')) {
    const sev = valid ? pv.severity : AlarmSeverity.INVALID;
    if (sev !== AlarmSeverity.NO_ALARM) fg = palette.alarm[sev] ?? fg;
  }
  const bg = palette.spec(colorSpec(p, 'bgColor'));
  return (
    <>
      <MotifTextField
        {...g}
        font={font}
        text={text}
        fg={fg}
        bg={bg}
        highlight={3}
        marginHeight={5}
      />
      <Hotspot
        {...g}
        cls={ENTRY}
        active={!!controlPv}
        cursor="text"
        denied={valid && !pv.writable}
        onPress={(e) => {
          if (e.button === 0 && valid && pv.writable) setEditing(true);
        }}
      />
      {editing && valid ? (
        <InlineEdit
          x={g.x + 3}
          y={g.y + 3}
          w={g.w - 6}
          h={g.h - 6}
          font={font}
          initial={text}
          fg={fg}
          bg={bg}
          onCancel={() => setEditing(false)}
          onCommit={(typed) => {
            put(controlPv, textEntryWrite(mode, pv, typed));
            setEditing(false);
          }}
        />
      ) : null}
    </>
  );
}
