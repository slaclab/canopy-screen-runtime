// activeExitButtonClass, shellCmdClass, activeMessageButtonClass and
// activeButtonClass. Behaviour matches EDM's baselib/exit_button.cc,
// shell_cmd.cc, message_button.cc and button.cc:
//   - all occupy (w+1) x (h+1) pixels, centre one label line at x + w/2 with
//     its top at y + h/2 - ascent/2 (clipped to w x h), and share EDM's bevel:
//     an inverted 1-px outer ring plus two raised rings; the pressed/on look
//     is the outer ring alone;
//   - exit button: flat unless `3d`, label not macro-expanded, closes the
//     display on press (any button); `invisible` still clickable;
//   - shell command: always bevelled; a browser cannot run the commands, so
//     the button is inert and lists them in its tooltip;
//   - message button: local pressed state (never read back from the PV),
//     push or toggle, press/release values converted by the PV's type, flat
//     mode with a botShadow border, optional password, closeOnPress/Release;
//   - button: state from controlPv/indicatorPv (enum, or a bit of an
//     integer with controlBitPos/readBitPos), on/off/inconsistent colours,
//     pvState or literal labels, toggle or push writes of 0/1.
// Written from that behaviour; no EDM code is copied.

import { useState } from 'react';
import { AlarmSeverity } from '@slaclab/canopy-client';
import { resolveFont } from '../config/fonts.js';
import { expandMacros } from '../macros.js';
import { propBool, propIndexedStrings, propInt, propStr } from '../model.js';
import type { EdmPvData } from '../pv/types.js';
import { useEdmPut, useEdmPv, useEdmScreen, useExpanded, usePhase } from '../screen/context.js';
import { CentredLabel, Face, Hotspot, XLines, raisedBevel } from './button.js';
import type { XLine } from './button.js';
import type { EdmWidgetProps } from './registry.js';
import { Unconnected } from './Rectangle.js';
import {
  SvgBox,
  XRectOutline,
  atof,
  atol,
  colorSpec,
  geom,
  idiv,
  pvProp,
  useVis,
} from './shared.js';

/** The pressed/on bevel: only the outer ring of the raised one. */
function sunkenBevel(
  x: number,
  y: number,
  w: number,
  h: number,
  top: string | undefined,
  bot: string | undefined
): XLine[] {
  return raisedBevel(x, y, w, h, top, bot).slice(0, 4);
}

export function ExitButton({ obj }: EdmWidgetProps) {
  const env = useEdmScreen();
  const { palette } = env;
  const p = obj.props;
  const g = geom(p);
  const { x, y, w, h } = g;
  const font = resolveFont(propStr(p, 'font'));
  const hotspot = (
    <Hotspot
      {...g}
      cls="activeExitButtonClass"
      title="Close this display"
      onPress={() => env.closeDisplay?.()}
    />
  );
  if (propBool(p, 'invisible')) return hotspot;
  return (
    <>
      <SvgBox x={x} y={y} w={w + 1} h={h + 1} clip>
        <Face {...g} color={palette.spec(colorSpec(p, 'bgColor'))} />
        {propBool(p, '3d') ? (
          <XLines
            lines={raisedBevel(
              x,
              y,
              w,
              h,
              palette.spec(colorSpec(p, 'topShadowColor')),
              palette.spec(colorSpec(p, 'botShadowColor'))
            )}
          />
        ) : null}
        <CentredLabel
          font={font}
          text={(propStr(p, 'label') ?? '').slice(0, 31)}
          tX={x + idiv(w, 2)}
          tY={y + idiv(h, 2) - idiv(font.ascent, 2)}
          fill={palette.spec(colorSpec(p, 'fgColor'))}
          clip={[x, y, w, h]}
        />
      </SvgBox>
      {hotspot}
    </>
  );
}

export function ShellCmd({ obj }: EdmWidgetProps) {
  const env = useEdmScreen();
  const { palette } = env;
  const p = obj.props;
  const g = geom(p);
  const { x, y, w, h } = g;
  const font = resolveFont(propStr(p, 'font'));
  const label = useExpanded(propStr(p, 'buttonLabel') ?? '') ?? '';
  const n = Math.min(20, propInt(p, 'numCmds', 0));
  const cmds = propIndexedStrings(p, 'command');
  const labels = propIndexedStrings(p, 'commandLabel');
  const lines: string[] = [];
  for (let i = 0; i < n; i++) {
    const c = expandMacros(cmds[i] ?? '', env.macros);
    const l = expandMacros(labels[i] ?? '', env.macros);
    if (c) lines.push(l ? `${l}: ${c}` : c);
  }
  const hotspot = (
    <Hotspot
      {...g}
      cls="shellCmdClass"
      active={n > 0}
      denied
      title={`Shell command (cannot run in a browser):\n${lines.join('\n')}`}
    />
  );
  if (propBool(p, 'invisible')) return hotspot;
  return (
    <>
      <SvgBox x={x} y={y} w={w + 1} h={h + 1} clip>
        <Face {...g} color={palette.spec(colorSpec(p, 'bgColor'))} />
        <XLines
          lines={raisedBevel(
            x,
            y,
            w,
            h,
            palette.spec(colorSpec(p, 'topShadowColor')),
            palette.spec(colorSpec(p, 'botShadowColor'))
          )}
        />
        <CentredLabel
          font={font}
          text={label.slice(0, 127)}
          tX={x + idiv(w, 2)}
          tY={y + idiv(h, 2) - idiv(font.ascent, 2)}
          fill={palette.spec(colorSpec(p, 'fgColor'))}
          clip={[x, y, w, h]}
        />
      </SvgBox>
      {hotspot}
    </>
  );
}

const MSG = 'activeMessageButtonClass';

/** The value a message button writes for a press/release string, or null for "no write". */
export function messageValue(
  pv: EdmPvData | undefined,
  text: string,
  useEnumNumeric: boolean
): number | string | null {
  if (!text) return null;
  switch (pv?.type) {
    case 'integer':
      return atol(text);
    case 'string':
    case 'array':
      return text.slice(0, 39);
    case 'enum': {
      if (useEnumNumeric) return atol(text);
      const i = pv.enumChoices.indexOf(text);
      return i < 0 ? null : i;
    }
    default:
      return atof(text);
  }
}

export function MessageButton({ obj }: EdmWidgetProps) {
  const env = useEdmScreen();
  const { palette } = env;
  const p = obj.props;
  const g = geom(p);
  const { x, y, w, h } = g;
  const controlPv = pvProp(p, 'controlPv');
  const colorPv = pvProp(p, 'colorPv');
  const pv = useEdmPv(controlPv, `${MSG}.controlPv`);
  const cpv = useEdmPv(colorPv, `${MSG}.colorPv`);
  const { visible, data: vis, defined: hasVis } = useVis(p, MSG);
  const put = useEdmPut();
  const [pressed, setPressed] = useState(false);
  const onLabel = useExpanded(propStr(p, 'onLabel') ?? '') ?? '';
  const offLabel = useExpanded(propStr(p, 'offLabel') ?? '') ?? '';
  const pressValue = useExpanded(propStr(p, 'pressValue') ?? '') ?? '';
  const releaseValue = useExpanded(propStr(p, 'releaseValue') ?? '') ?? '';
  const defined = [...(controlPv ? [pv] : []), ...(colorPv ? [cpv] : []), ...(hasVis ? [vis] : [])];
  const phase = usePhase(defined);

  const toggle = propBool(p, 'toggle');
  const password = (propStr(p, 'password') ?? '').trim();
  const usePassword = password !== '' && password !== '*';
  const useEnumNumeric = propBool(p, 'useEnumNumeric');
  const writable = !!pv?.connected && pv.writable;
  const write = (text: string) => {
    const v = messageValue(pv, text, useEnumNumeric);
    if (v !== null) put(controlPv, v);
  };
  const press = () => {
    const now = toggle ? !pressed : true;
    setPressed(now);
    if (now) write(pressValue);
    else if (toggle) write(releaseValue);
    if (propBool(p, 'closeOnPress')) env.closeDisplay?.();
  };
  const release = () => {
    if (!toggle) {
      setPressed(false);
      write(releaseValue);
    }
    if (propBool(p, 'closeOnRelease')) env.closeDisplay?.();
  };
  const hotspot = (
    <Hotspot
      {...g}
      cls={MSG}
      active={!!controlPv && visible !== false}
      denied={!writable}
      onPress={(e) => {
        if (e.button !== 0 || !writable || visible !== true) return;
        if (usePassword) {
          // EDM pops up a masked entry form; a prompt stands in for it.
          const typed = window.prompt('Password');
          if (typed === null) return;
          if (typed !== password) {
            window.alert('Incorrect Password');
            return;
          }
          press();
          if (!toggle && !propBool(p, 'closeOnPress')) release();
          return;
        }
        press();
      }}
      onRelease={() => {
        if (!writable || visible !== true || usePassword) return;
        release();
      }}
    />
  );

  if (phase !== 'init') {
    return (
      <>
        {phase === 'unconnected' ? <Unconnected {...g} color={palette.disconnected()} /> : null}
        {hotspot}
      </>
    );
  }
  // colorPv rules on onColor, offColor and fgColor; an "invisible" result hides the button.
  const specs = ['onColor', 'offColor', 'fgColor'].map((k) => colorSpec(p, k));
  const hiddenByColor = !hasVis && !!colorPv && specs.some((s) => palette.isInvisible(s, cpv?.num));
  if (propBool(p, 'invisible') || !visible || hiddenByColor) return hotspot;

  const down = defined.some((d) => d && !d.connected);
  const fill = down
    ? palette.disconnected()
    : palette.spec(colorSpec(p, pressed ? 'onColor' : 'offColor'), cpv?.num);
  const ts = palette.spec(colorSpec(p, 'topShadowColor'));
  const bs = palette.spec(colorSpec(p, 'botShadowColor'));
  const is3d = propBool(p, '3d');
  const font = resolveFont(propStr(p, 'font'));
  return (
    <>
      <SvgBox x={x} y={y} w={w + 1} h={h + 1} clip>
        <rect x={x} y={y} width={w} height={h} fill={fill} />
        <XRectOutline {...g} lineWidth={1} color={is3d ? fill : bs} />
        {is3d ? <XLines lines={(pressed ? sunkenBevel : raisedBevel)(x, y, w, h, ts, bs)} /> : null}
        <CentredLabel
          font={font}
          text={(pressed ? onLabel : offLabel).slice(0, 26)}
          tX={x + idiv(w, 2)}
          tY={y + idiv(h, 2) - idiv(font.ascent, 2)}
          fill={palette.spec(colorSpec(p, 'fgColor'), cpv?.num)}
          clip={[x, y, w, h]}
        />
      </SvgBox>
      {hotspot}
    </>
  );
}

const BTN = 'activeButtonClass';

/** EDM reads button PVs as C ints; with a bit position, as that bit (31 reads 0). */
function buttonValue(d: EdmPvData | undefined, bit: number | null): number {
  const v = Math.trunc(d?.num ?? 0) | 0;
  if (bit === null) return v;
  return (v & (1 << bit)) > 0 ? 1 : 0;
}

export function Button({ obj }: EdmWidgetProps) {
  const { palette } = useEdmScreen();
  const p = obj.props;
  const g = geom(p);
  const { x, y, w, h } = g;
  const controlPv = pvProp(p, 'controlPv');
  const indicatorPv = pvProp(p, 'indicatorPv');
  const colorPv = pvProp(p, 'colorPv');
  const ctl = useEdmPv(controlPv, `${BTN}.controlPv`);
  const ind = useEdmPv(indicatorPv, `${BTN}.indicatorPv`);
  const cpv = useEdmPv(colorPv, `${BTN}.colorPv`);
  const { visible, data: vis, defined: hasVis } = useVis(p, BTN);
  const put = useEdmPut();

  const bitOf = (k: string) =>
    propStr(p, k) === undefined ? null : Math.max(0, Math.min(31, propInt(p, k, 0)));
  const ctlBit = bitOf('controlBitPos');
  const readBit = bitOf('readBitPos');
  // Enum PVs always; integer/real only in bit mode. Anything else never connects.
  const accepted = (d: EdmPvData | undefined, bit: number | null) =>
    d?.connected && !(d.type !== 'enum' && bit === null) ? d : d && { ...d, connected: false };
  const ctlOk = accepted(ctl, ctlBit);
  const indOk = accepted(ind, readBit);
  const defined = [
    ...(controlPv ? [ctlOk] : []),
    ...(indicatorPv ? [indOk] : []),
    ...(colorPv ? [cpv] : []),
    ...(hasVis ? [vis] : []),
  ];
  const phase = usePhase(defined);

  const toggle = (propStr(p, 'buttonType') ?? 'toggle') === 'toggle';
  const allUp = defined.every((d) => d?.connected);
  const writable = !!ctl?.connected && ctl.writable && allUp;
  const word = Math.trunc(ctl?.num ?? 0) | 0;
  const hotspot = (
    <Hotspot
      {...g}
      cls={BTN}
      active={!!controlPv && phase === 'init' && visible === true}
      denied={!writable}
      onPress={(e) => {
        if (e.button !== 0 || !writable) return;
        if (ctlBit === null) put(controlPv, toggle ? (word === 0 ? 1 : 0) : 1);
        else put(controlPv, toggle ? word ^ (1 << ctlBit) : word | (1 << ctlBit));
      }}
      onRelease={() => {
        if (!writable || toggle) return;
        put(controlPv, ctlBit === null ? 0 : word & ~(1 << ctlBit));
      }}
    />
  );

  if (phase !== 'init') {
    return phase === 'unconnected' ? <Unconnected {...g} color={palette.disconnected()} /> : null;
  }
  const specs = ['onColor', 'offColor', 'fgColor'].map((k) => colorSpec(p, k));
  const hiddenByColor = !hasVis && !!colorPv && specs.some((s) => palette.isInvisible(s, cpv?.num));
  if (propBool(p, 'invisible') || !visible || hiddenByColor) return hotspot;

  let cV = buttonValue(ctl, ctlBit);
  const rV = buttonValue(ind, readBit);
  let colorKey: 'onColor' | 'offColor' | 'inconsistentColor';
  if (controlPv && indicatorPv) {
    colorKey = cV !== rV ? 'inconsistentColor' : cV === 0 ? 'offColor' : 'onColor';
  } else if (indicatorPv) {
    colorKey = rV === 0 ? 'offColor' : 'onColor';
    cV = rV;
  } else if (controlPv) {
    colorKey = cV === 0 ? 'offColor' : 'onColor';
  } else {
    colorKey = 'inconsistentColor';
    cV = 0;
  }
  const down = [ctl, ind, ...(colorKey === 'inconsistentColor' ? [] : [cpv])].some(
    (d) => d && !d.connected
  );
  const fill = down
    ? palette.disconnected()
    : palette.spec(colorSpec(p, colorKey), colorKey === 'inconsistentColor' ? undefined : cpv?.num);
  const on = cV !== 0;

  let label: string;
  if ((propStr(p, 'labelType') ?? 'pvState') === 'literal') {
    label = (on ? propStr(p, 'onLabel') : propStr(p, 'offLabel')) ?? '';
  } else {
    const states = (indicatorPv ? ind : ctl)?.enumChoices ?? [];
    label = on ? (states.length >= 2 ? states[1] : '1') : states.length >= 1 ? states[0] : '0';
  }
  // Alarm-sensitive label: the indicator's severity, else the control PV's.
  const sev = (indicatorPv ? ind : ctl)?.severity ?? AlarmSeverity.NO_ALARM;
  let fg = palette.spec(colorSpec(p, 'fgColor'), cpv?.num);
  if (
    propBool(p, 'fgAlarm') &&
    sev !== AlarmSeverity.NO_ALARM &&
    sev !== AlarmSeverity.DISCONNECTED
  ) {
    fg = palette.alarm[sev] ?? fg;
  }
  const ts = palette.spec(colorSpec(p, 'topShadowColor'));
  const bs = palette.spec(colorSpec(p, 'botShadowColor'));
  const font = resolveFont(propStr(p, 'font'));
  return (
    <>
      <SvgBox x={x} y={y} w={w + 1} h={h + 1} clip>
        <Face {...g} color={fill} />
        {propBool(p, '3d') ? (
          <XLines lines={(on ? sunkenBevel : raisedBevel)(x, y, w, h, ts, bs)} />
        ) : null}
        <CentredLabel
          font={font}
          text={label.slice(0, 26)}
          tX={x + idiv(w, 2)}
          tY={y + idiv(h, 2) - idiv(font.ascent, 2)}
          fill={fg}
          clip={[x, y, w, h]}
        />
      </SvgBox>
      {hotspot}
    </>
  );
}
