// menuMuxClass. Behaviour matches EDM's baselib/menu_mux.cc; written from
// that behaviour, no EDM code is copied. Drawn like the menu button (face,
// EDM's bevel, the option bump, the current item's symbolTag centred left of
// the bump, "?" out of range). The current item comes from controlPv (clamped
// to the items) or, without one, from initialState; choosing an item writes
// its index (or selects it locally). Its macro set reaches the window's other
// objects through the window's mux layer (screen/mux.ts).

import { useEffect, useState } from 'react';
import { AlarmSeverity } from '@slaclab/canopy-client';
import { resolveFont } from '../config/fonts.js';
import { propBool, propStr } from '../model.js';
import { useEdmPut, useEdmPv, useEdmScreen, usePhase } from '../screen/context.js';
import { muxDefinition } from '../screen/mux.js';
import { CentredLabel, Face, Hotspot, PopupMenu, XLines, raisedBevel } from './button.js';
import type { XLine } from './button.js';
import type { EdmWidgetProps } from './registry.js';
import { Unconnected } from './Rectangle.js';
import { SvgBox, colorSpec, edmColor, geom, idiv, pvProp } from './shared.js';

const CLS = 'menuMuxClass';

export function MenuMux({ obj }: EdmWidgetProps) {
  const env = useEdmScreen();
  const { palette } = env;
  const p = obj.props;
  const g = geom(p);
  const { x, y, w, h } = g;
  const controlPv = pvProp(p, 'controlPv');
  const pv = useEdmPv(controlPv, `${CLS}.controlPv`);
  const put = useEdmPut();
  const phase = usePhase(controlPv ? [pv] : []);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const def = muxDefinition(obj);
  const n = def.labels.length;
  const fromPv = pv?.connected ? Math.min(Math.max(Math.trunc(pv.num), 0), Math.max(n - 1, 0)) : 0;
  const current = controlPv ? fromPv : (env.mux?.current(obj) ?? 0);
  // Tell the window which item the PV selected (its macros follow).
  const mux = env.mux;
  const live = !!controlPv && !!pv?.connected;
  useEffect(() => {
    if (live && mux && mux.current(obj) !== fromPv) mux.select(obj, fromPv);
  }, [live, mux, obj, fromPv]);

  if (controlPv && phase !== 'init') {
    return phase === 'unconnected' ? <Unconnected {...g} color={palette.disconnected()} /> : null;
  }
  if (controlPv && !pv?.connected) return null;

  const font = resolveFont(propStr(p, 'font'));
  const data = controlPv ? pv : undefined;
  const bg = edmColor(palette, colorSpec(p, 'bgColor'), {
    data,
    alarmSensitive: propBool(p, 'bgAlarm'),
  });
  const fg =
    data && propBool(p, 'fgAlarm') && data.severity !== AlarmSeverity.NO_ALARM
      ? (palette.alarm[data.severity] ?? palette.spec(colorSpec(p, 'fgColor')))
      : palette.spec(colorSpec(p, 'fgColor'));
  const ts = palette.spec(colorSpec(p, 'topShadowColor'));
  const bs = palette.spec(colorSpec(p, 'botShadowColor'));
  const bx = x + w - 20;
  const by = y + idiv(h, 2) - 5;
  const bump: XLine[] = [
    [bx, by + 10, bx, by, ts],
    [bx, by, bx + 10, by, ts],
    [bx + 10, by, bx + 10, by + 10, bs],
    [bx + 10, by + 10, bx, by + 10, bs],
  ];
  const label = current >= 0 && current < n ? def.labels[current] : '?';
  const writable = controlPv ? !!pv?.connected && pv.writable : true;
  return (
    <>
      <SvgBox x={x} y={y} w={w + 1} h={h + 1} clip>
        <Face {...g} color={bg} />
        <XLines lines={[...raisedBevel(x, y, w, h, ts, bs), ...bump]} />
        <CentredLabel
          font={font}
          text={label}
          tX={x + idiv(w, 2) - 10}
          tY={y + idiv(h, 2) - idiv(font.ascent, 2)}
          fill={fg}
          clip={[x + 3, y, w - 23, h]}
        />
      </SvgBox>
      <Hotspot
        {...g}
        cls={CLS}
        denied={!writable}
        onRelease={(e) => {
          if (e.button === 0 && writable) setMenu({ x: e.clientX, y: e.clientY });
        }}
      />
      {menu ? (
        <PopupMenu
          at={menu}
          onClose={() => setMenu(null)}
          items={def.labels.map((l, i) => ({
            label: l,
            onSelect: () => (controlPv ? put(controlPv, i) : env.mux?.select(obj, i)),
          }))}
        />
      ) : null}
    </>
  );
}
