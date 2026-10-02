// SLAC library controls: activeFreezeButtonClass (slaclib/freeze_button.cc)
// and mmvClass (slaclib/mmover.cc). Behaviour matches those files; written
// from that behaviour, no EDM code is copied.
//
// Freeze button: no PV. A face (fill + outline) in bgColor, frozenBgColor
// while frozen; with `3d`, EDM's standard 3-ring bevel; the label (or
// frozenLabel) centred on x + w/2 with its top at y + h/2 - ascent/2,
// clipped to w x h. A press strictly inside the box toggles the window's
// freeze: every object then keeps its values until unfrozen.
//
// mmv ("multi-mover"): an X sub-window (drawn above the canvas) filled with
// bgColor, holding one marker per control PV: a 60-degree pie slice of the
// circle of radius h (horizontal) or w (vertical) whose centre sits just
// outside the window edge, opening inwards. A marker's axis follows its PV
// over the PV's display range (limitsFromDb, or a missing scaleMin/scaleMax
// tag); the colour is ctrlNColor, the disconnected colour once that PV drops.
// Nothing but the background shows until a control connects. Dragging a
// marker writes the value under the pointer.

import { useRef, useState, useSyncExternalStore } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { resolveFont } from '../config/fonts.js';
import { propBool, propInt, propNum, propStr } from '../model.js';
import type { EdmPvData } from '../pv/types.js';
import { EdmFreeze } from '../screen/context.js';
import { useEdmPut, useEdmPv, useEdmScreen } from '../screen/context.js';
import { CentredLabel, Face, XLines, raisedBevel } from './button.js';
import type { EdmWidgetProps } from './registry.js';
import { SvgBox, colorSpec, edmColor, geom, idiv, pvProp } from './shared.js';

const NO_FREEZE = new EdmFreeze();

export function FreezeButton({ obj }: EdmWidgetProps) {
  const env = useEdmScreen();
  const { palette } = env;
  const freeze = env.freeze ?? NO_FREEZE;
  const frozen = useSyncExternalStore(freeze.subscribe, freeze.getFrozen, freeze.getFrozen);
  const p = obj.props;
  const { x, y, w, h } = geom(p);
  const font = resolveFont(propStr(p, 'font'));
  const face = palette.spec(colorSpec(p, frozen ? 'frozenBgColor' : 'bgColor'));
  const label = (frozen ? propStr(p, 'frozenLabel') : propStr(p, 'label')) ?? '';
  const top = palette.spec(colorSpec(p, 'topShadowColor'));
  const bot = palette.spec(colorSpec(p, 'botShadowColor'));
  return (
    <>
      <SvgBox x={x} y={y} w={w + 1} h={h + 1}>
        <Face x={x} y={y} w={w} h={h} color={face} />
        {propBool(p, '3d') ? <XLines lines={raisedBevel(x, y, w, h, top, bot)} /> : null}
        <CentredLabel
          font={font}
          text={label}
          tX={x + idiv(w, 2)}
          tY={y + idiv(h, 2) - idiv(font.ascent, 2)}
          fill={palette.spec(colorSpec(p, 'fgColor'))}
          clip={[x, y, w, h]}
        />
      </SvgBox>
      <div
        role="button"
        aria-pressed={frozen}
        data-edm-class="activeFreezeButtonClass"
        onMouseDown={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const px = e.clientX - r.left;
          const py = e.clientY - r.top;
          if (px > 0 && px < w && py > 0 && py < h) freeze.toggle();
        }}
        style={{
          position: 'absolute',
          left: x,
          top: y,
          width: w,
          height: h,
          pointerEvents: 'auto',
        }}
      />
    </>
  );
}

const MMV = 'mmvClass';
const TAN30 = Math.tan(Math.PI / 6);

/**
 * Window-local pixels of a marker (X filled pie slice of 60 degrees): `pos`
 * is the marker axis, `r` the radius; orientation 0 HorizTop, 1 VertLeft,
 * 2 HorizBot, 3 VertRight. Clipped to w x h.
 */
export function mmvMarker(
  orientation: number,
  pos: number,
  r: number,
  w: number,
  h: number
): [number, number][] {
  const out: [number, number][] = [];
  for (let d = 0; d <= r; d++) {
    for (let k = -r; k <= r; k++) {
      if (Math.abs(k) > d * TAN30 + 1e-9 || d * d + k * k > r * r) continue;
      const [px, py] =
        orientation === 0
          ? [pos + k, h - d]
          : orientation === 1
            ? [w - d, pos + k]
            : orientation === 2
              ? [pos + k, d]
              : [d, pos + k];
      if (px >= 0 && px < w && py >= 0 && py < h) out.push([px, py]);
    }
  }
  return out;
}

export function Mmv({ obj }: EdmWidgetProps) {
  const { palette } = useEdmScreen();
  const p = obj.props;
  const { x, y, w, h } = geom(p);
  const pvs = [pvProp(p, 'ctrl1Pv'), pvProp(p, 'ctrl2Pv')];
  const d1 = useEdmPv(pvs[0], `${MMV}.ctrl1Pv`);
  const d2 = useEdmPv(pvs[1], `${MMV}.ctrl2Pv`);
  const data = [d1, d2];
  const put = useEdmPut();
  const [dragging, setDragging] = useState<{ i: number; v: number } | null>(null);
  const grab = useRef<number | null>(null);

  const orientation = propInt(p, 'orientation', 0);
  const horizontal = orientation === 0 || orientation === 2;
  const T = horizontal ? w - h : h - w;
  const r = horizontal ? h : w;
  const fromDb = propBool(p, 'limitsFromDb');
  const tag = (k: string) => (propStr(p, k) === undefined ? null : propNum(p, k, 0));
  // The limits of the last control to connect apply to both markers.
  const limitsFrom = [...data].reverse().find((d) => d?.connected);
  const minFv =
    (fromDb || tag('scaleMin') === null) && limitsFrom
      ? limitsFrom.lowerLimit
      : (tag('scaleMin') ?? 0);
  const maxFv =
    (fromDb || tag('scaleMax') === null) && limitsFrom
      ? limitsFrom.upperLimit
      : (tag('scaleMax') ?? (limitsFrom ? 0 : 10));
  let factor = horizontal ? (maxFv - minFv) / T : (minFv - maxFv) / T;
  if (!factor || !Number.isFinite(factor)) factor = 1;
  const lo = Math.min(minFv, maxFv);
  const hi = Math.max(minFv, maxFv);
  const position = (v: number) => {
    const c = Math.min(Math.max(v, lo), hi);
    return horizontal
      ? Math.trunc((c - minFv) / factor + 0.5) + idiv(h, 2)
      : Math.trunc((c - maxFv) / factor + 0.5) + idiv(w, 2);
  };

  const anyConnected = data.some((d) => d?.connected);
  // The background is never connect-sensitive; bgAlarm follows control 1 once it is live.
  const bg = edmColor(palette, colorSpec(p, 'bgColor'), {
    data: d1?.connected ? d1 : undefined,
    alarmSensitive: propBool(p, 'bgAlarm'),
  });
  const markers: { i: number; pos: number; color: string | undefined }[] = [];
  if (anyConnected) {
    data.forEach((d: EdmPvData | undefined, i) => {
      if (!pvs[i]) return;
      const quarter = horizontal ? idiv((i ? 3 : 1) * w, 4) : idiv((i ? 3 : 1) * h, 4);
      const live = !!d?.connected;
      const v = dragging?.i === i ? dragging.v : d?.num;
      markers.push({
        i,
        pos: live && v !== undefined ? position(v) : quarter,
        color: live
          ? palette.spec(colorSpec(p, i ? 'ctrl2Color' : 'ctrl1Color'))
          : palette.disconnected(),
      });
    });
  }

  const valueAt = (e: ReactMouseEvent) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const m = horizontal ? e.clientX - rect.left : e.clientY - rect.top;
    const v = factor * (m - idiv(r, 2)) + (horizontal ? minFv : maxFv);
    return Math.min(Math.max(v, lo), hi);
  };
  const writable = !!d1?.connected && d1.writable;

  return (
    <div
      data-edm-class={MMV}
      style={{ position: 'absolute', left: x, top: y, width: w, height: h, zIndex: 1 }}
    >
      <svg width={w} height={h} shapeRendering="crispEdges" style={{ display: 'block' }}>
        <rect x={0} y={0} width={w} height={h} fill={bg} />
        {markers.map((mk) => (
          <path
            key={mk.i}
            d={mmvMarker(orientation, mk.pos, r, w, h)
              .map(([px, py]) => `M${px} ${py}h1v1h-1z`)
              .join('')}
            fill={mk.color}
          />
        ))}
      </svg>
      <div
        role="slider"
        aria-valuenow={d1?.num}
        onMouseDown={(e) => {
          if (e.button !== 0 || !writable) return;
          const rect = e.currentTarget.getBoundingClientRect();
          const m = horizontal ? e.clientX - rect.left : e.clientY - rect.top;
          const hit = markers.find((mk) => Math.abs(m - mk.pos) <= r / 2);
          if (hit) grab.current = hit.i;
        }}
        onMouseMove={(e) => {
          const i = grab.current;
          if (i === null) return;
          const v = valueAt(e);
          setDragging({ i, v });
          put(pvs[i], v);
        }}
        onMouseUp={() => {
          grab.current = null;
          setDragging(null);
        }}
        onMouseLeave={() => {
          grab.current = null;
          setDragging(null);
        }}
        style={{
          position: 'absolute',
          inset: 0,
          cursor: writable ? 'default' : 'not-allowed',
          pointerEvents: 'auto',
        }}
      />
    </div>
  );
}
