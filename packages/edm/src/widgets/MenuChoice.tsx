// activeMenuButtonClass and activeChoiceButtonClass. Behaviour matches EDM's
// baselib/menu_button.cc and choiceButton/choice_button.cc:
//   - both show an enum PV's state; indicatorPv supplies the shown state when
//     present, controlPv the state strings and the write target; a non-enum
//     controlPv leaves only the unconnected outline; with both PVs a mismatch
//     paints inconsistentColor;
//   - menu button: EDM's raised bevel, an 11 x 11 "option" bump at
//     x + w - 20, the state label centred on x + w/2 - 10 and clipped to
//     columns x+3 .. x+w-21; the popup opens on button-1 release and writes
//     the chosen index;
//   - choice button: N equal buttons along the orientation with 3-px gaps
//     (the remainder widens the outer gaps), the selected one sunken in
//     selectColor, the others raised in bgColor; a press writes the index of
//     the segment under the pointer (the gap before a button belongs to it).
// Written from that behaviour; no EDM code is copied.

import { useState } from 'react';
import { AlarmSeverity } from '@slaclab/canopy-client';
import type { EdmPalette } from '../config/colors.js';
import { resolveFont } from '../config/fonts.js';
import type { EdmProps } from '../model.js';
import { propBool, propStr } from '../model.js';
import type { EdmPvData } from '../pv/types.js';
import { useEdmPut, useEdmPv, useEdmScreen, usePhase } from '../screen/context.js';
import { CentredLabel, Face, Hotspot, PopupMenu, XLines, raisedBevel } from './button.js';
import type { XLine } from './button.js';
import type { EdmWidgetProps } from './registry.js';
import { Unconnected } from './Rectangle.js';
import { SvgBox, colorSpec, geom, idiv, pvProp, useVis } from './shared.js';

/** The PVs, state and colours the two classes share. */
function useEnumControl(p: EdmProps, cls: string, palette: EdmPalette) {
  const controlPv = pvProp(p, 'controlPv');
  const indicatorPv = pvProp(p, 'indicatorPv');
  const colorPv = pvProp(p, 'colorPv');
  const ctl = useEdmPv(controlPv, `${cls}.controlPv`);
  const ind = useEdmPv(indicatorPv, `${cls}.indicatorPv`);
  const cpv = useEdmPv(colorPv, `${cls}.colorPv`);
  const { visible, data: vis, defined: hasVis } = useVis(p, cls);
  // A control PV that is not an enum never initialises (EDM: "illegal pv type").
  const ctlOk: EdmPvData | undefined =
    ctl?.connected && ctl.type !== 'enum' ? { ...ctl, connected: false } : ctl;
  const defined = [
    ...(controlPv ? [ctlOk] : []),
    ...(indicatorPv ? [ind] : []),
    ...(colorPv ? [cpv] : []),
    ...(hasVis ? [vis] : []),
  ];
  const phase = usePhase(defined);
  const value = Math.trunc(ctl?.num ?? 0);
  const readValue = Math.trunc(ind?.num ?? 0);
  const shown = indicatorPv ? readValue : controlPv ? value : -1;
  const inconsistent =
    controlPv && indicatorPv
      ? value !== readValue || !ctl?.connected || !ind?.connected
      : !controlPv && !indicatorPv;
  const strings = (controlPv ? ctl : ind)?.enumChoices ?? [];
  // fgColor: disconnected colour, then alarm colours (the control PV's
  // severity, else the indicator's), then the colorPv rule colour.
  const src = controlPv ? ctl : ind;
  const fgStatic = palette.spec(colorSpec(p, 'fgColor'));
  let fg = palette.spec(colorSpec(p, 'fgColor'), cpv?.num);
  if ([ctl, ind, cpv, vis].some((d) => d && !d.connected)) fg = palette.disconnected();
  else if (propBool(p, 'fgAlarm') && src && src.severity !== AlarmSeverity.NO_ALARM) {
    fg = palette.alarm[src.severity] ?? fg;
  }
  const bg = palette.spec(colorSpec(p, 'bgColor'), cpv?.num);
  const hiddenByColor =
    !hasVis &&
    !!colorPv &&
    ['fgColor', 'bgColor'].some((k) => palette.isInvisible(colorSpec(p, k), cpv?.num));
  return {
    controlPv,
    ctl,
    phase,
    hasPv: defined.length > 0,
    visible: visible === true && !hiddenByColor,
    shown,
    inconsistent,
    strings,
    fg,
    fgStatic,
    bg,
    writable: !!ctl?.connected && ctl.writable && ctl.type === 'enum',
  };
}

const MENU = 'activeMenuButtonClass';

export function MenuButton({ obj }: EdmWidgetProps) {
  const { palette } = useEdmScreen();
  const p = obj.props;
  const g = geom(p);
  const { x, y, w, h } = g;
  const s = useEnumControl(p, MENU, palette);
  const put = useEdmPut();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [armed, setArmed] = useState(false);

  if (!s.hasPv) return null;
  if (s.phase !== 'init') {
    return s.phase === 'unconnected' ? <Unconnected {...g} color={palette.disconnected()} /> : null;
  }
  if (!s.visible) return null;

  const font = resolveFont(propStr(p, 'font'));
  const ts = palette.spec(colorSpec(p, 'topShadowColor'));
  const bs = palette.spec(colorSpec(p, 'botShadowColor'));
  const face = s.inconsistent ? palette.spec(colorSpec(p, 'inconsistentColor')) : s.bg;
  const bx = x + w - 20;
  const by = y + idiv(h, 2) - 5;
  const bump: XLine[] = [
    [bx, by + 10, bx, by, ts],
    [bx, by, bx + 10, by, ts],
    [bx + 10, by, bx + 10, by + 10, bs],
    [bx + 10, by + 10, bx, by + 10, bs],
  ];
  const label = s.shown >= 0 && s.shown < s.strings.length ? s.strings[s.shown] : '?';
  return (
    <>
      <SvgBox x={x} y={y} w={w + 1} h={h + 1} clip>
        <Face {...g} color={face} />
        <XLines lines={[...raisedBevel(x, y, w, h, ts, bs), ...bump]} />
        <CentredLabel
          font={font}
          text={label}
          tX={x + idiv(w, 2) - 10}
          tY={y + idiv(h, 2) - idiv(font.ascent, 2)}
          fill={s.fg}
          clip={[x + 3, y, w - 23, h]}
        />
      </SvgBox>
      <Hotspot
        {...g}
        cls={MENU}
        active={!!s.controlPv}
        denied={!s.writable}
        onPress={(e) => setArmed(e.button === 0 && s.writable)}
        onRelease={(e) => {
          if (armed && e.button === 0 && s.writable) setMenu({ x: e.clientX, y: e.clientY });
          setArmed(false);
        }}
      />
      {menu ? (
        <PopupMenu
          at={menu}
          onClose={() => setMenu(null)}
          items={(s.ctl?.enumChoices ?? []).slice(0, 16).map((label, i) => ({
            label,
            onSelect: () => put(s.controlPv, i),
          }))}
        />
      ) : null}
    </>
  );
}

const CHOICE = 'activeChoiceButtonClass';

/** Button origins along the main axis, size and count (choice_button layout). */
export function choiceLayout(
  start: number,
  length: number,
  n: number
): { pos: number[]; size: number; extraAt: boolean[] } {
  if (n <= 0) return { pos: [], size: 0, extraAt: [] };
  let size = idiv(length - (n - 1) * 3, n);
  const extra = length - n * size - (n - 1) * 3;
  if (size < 3) size = 3;
  const lowExtra = idiv(extra, 2);
  const highExtra = n - 1 - lowExtra - (extra % 2);
  const pos: number[] = [];
  const extraAt: boolean[] = [];
  let at = start;
  for (let i = 0; i < n; i++) {
    pos.push(at);
    const e = i < lowExtra || i >= highExtra;
    extraAt.push(e);
    at += size + 3 + (e ? 1 : 0);
  }
  return { pos, size, extraAt };
}

export function ChoiceButton({ obj }: EdmWidgetProps) {
  const { palette } = useEdmScreen();
  const p = obj.props;
  const g = geom(p);
  const { x, y, w, h } = g;
  const s = useEnumControl(p, CHOICE, palette);
  const put = useEdmPut();

  if (!s.hasPv) return null;
  if (s.phase !== 'init') {
    return s.phase === 'unconnected' ? <Unconnected {...g} color={palette.disconnected()} /> : null;
  }
  if (!s.visible) return null;

  const horizontal = propStr(p, 'orientation') === 'horizontal';
  const n = s.strings.length;
  const lay = choiceLayout(horizontal ? x : y, horizontal ? w : h, n);
  const bW = horizontal ? lay.size : Math.max(3, w);
  const bH = horizontal ? Math.max(3, h) : lay.size;
  const font = resolveFont(propStr(p, 'font'));
  const ts = palette.spec(colorSpec(p, 'topShadowColor'));
  const bs = palette.spec(colorSpec(p, 'botShadowColor'));
  const selectFill = palette.spec(
    colorSpec(p, s.inconsistent ? 'inconsistentColor' : 'selectColor')
  );
  const lines: XLine[] = [];
  const faces = lay.pos.map((at, i) => {
    const bx = horizontal ? at : x;
    const by = horizontal ? y : at;
    const selected = i === s.shown;
    if (selected) {
      lines.push(
        [bx, by, bx + bW, by, bs],
        [bx, by, bx, by + bH, bs],
        [bx + bW, by, bx + bW, by + bH, ts],
        [bx, by + bH, bx + bW, by + bH, ts]
      );
    } else {
      lines.push(
        [bx, by, bx + bW, by, ts],
        [bx + 1, by + 1, bx + bW - 1, by + 1, ts],
        [bx, by, bx, by + bH, ts],
        [bx + 1, by + 1, bx + 1, by + bH - 1, ts],
        [bx + bW, by, bx + bW, by + bH, bs],
        [bx, by + bH, bx + bW, by + bH, bs]
      );
    }
    return { bx, by, selected, i };
  });

  return (
    <>
      <SvgBox x={x} y={y} w={w + 1} h={h + 1}>
        <rect x={x} y={y} width={w} height={h} fill={palette.spec(colorSpec(p, 'bgColor'))} />
        {faces.map((f) => (
          <rect
            key={f.i}
            x={f.bx}
            y={f.by}
            width={bW}
            height={bH}
            fill={f.selected ? selectFill : s.bg}
          />
        ))}
        <XLines lines={lines} />
        {faces.map((f) => (
          <CentredLabel
            key={f.i}
            font={font}
            text={s.strings[f.i] ?? ''}
            tX={f.bx + idiv(bW, 2)}
            tY={f.by + idiv(bH, 2) - idiv(font.ascent, 2)}
            fill={f.selected ? s.fg : s.fgStatic}
            clip={[f.bx + 1, f.by + 1, bW - 2, bH - 2]}
          />
        ))}
      </SvgBox>
      <Hotspot
        {...g}
        cls={CHOICE}
        active={!!s.controlPv}
        denied={!s.writable}
        onPress={(e) => {
          if (e.button !== 0 || !s.writable || n === 0) return;
          const r = e.currentTarget.getBoundingClientRect();
          const at = horizontal ? x + 1 + (e.clientX - r.left) : y + 1 + (e.clientY - r.top);
          let pick = n - 1;
          for (let i = 0; i < n; i++) {
            if (at < lay.pos[i] + lay.size + (lay.extraAt[i] ? 1 : 0)) {
              pick = i;
              break;
            }
          }
          put(s.controlPv, pick);
        }}
      />
    </>
  );
}
