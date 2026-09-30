// activeMotifSliderClass. Behaviour matches EDM's baselib/motifSlider.cc:
//   - a bgColor frame (w x h) with optional label, limits and value text rows
//     above (horizontal) or beside (vertical) a Motif XmScale;
//   - limits and precision come from the PV per field (limitsFromDb, or a
//     missing scaleMin/scaleMax/precision tag), limits print as %g, the value
//     with displayFormat/precision; the thumb is clamped to the range while
//     the value text shows the true number;
//   - dragging the thumb writes the value under the pointer; a click in the
//     trough steps by `increment` toward the click (nothing when it is 0);
//   - nothing is drawn until the PV connects (a 1-px box in the disconnected
//     colour after 2 s); bgAlarm colours the frame.
// The scale itself is a Motif widget in EDM, so its trough, bevels and 30-px
// thumb are drawn here from Motif's default look, not from EDM code.
// Written from that behaviour; no EDM code is copied.

import { useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { resolveFont, textWidth } from '../config/fonts.js';
import { cFormat } from '../format.js';
import { propBool, propNum, propStr } from '../model.js';
import { useEdmPut, useEdmPv, useEdmScreen, useExpanded, usePhase } from '../screen/context.js';
import type { EdmWidgetProps } from './registry.js';
import { Unconnected } from './Rectangle.js';
import { SvgBox, TextRun, colorSpec, edmColor, geom, idiv, pvProp } from './shared.js';

const CLS = 'activeMotifSliderClass';
const THUMB = 30;

export function MotifSlider({ obj }: EdmWidgetProps) {
  const { palette } = useEdmScreen();
  const p = obj.props;
  const g = geom(p);
  const { x, y, w, h } = g;
  const controlPv = pvProp(p, 'controlPv');
  const pv = useEdmPv(controlPv, `${CLS}.controlPv`);
  const name = useExpanded(controlPv) ?? '';
  const literal = useExpanded(propStr(p, 'controlLabel') ?? '') ?? '';
  const put = useEdmPut();
  const phase = usePhase(controlPv ? [pv] : [undefined]);
  const drag = useRef<{ grab: number } | null>(null);
  const [local, setLocal] = useState<number | null>(null);

  if (phase !== 'init' || !pv) {
    return phase === 'unconnected' || !controlPv ? (
      <Unconnected {...g} color={palette.disconnected()} />
    ) : null;
  }

  const font = resolveFont(propStr(p, 'font'));
  const fh = font.ascent + font.descent;
  const horizontal = (propStr(p, 'orientation') ?? 'horizontal') !== 'vertical';
  const fromDb = propBool(p, 'limitsFromDb');
  const tag = (k: string) => (propStr(p, k) === undefined ? null : propNum(p, k, 0));
  const minFv = fromDb || tag('scaleMin') === null ? pv.lowerLimit : (tag('scaleMin') as number);
  const maxFv = fromDb || tag('scaleMax') === null ? pv.upperLimit : (tag('scaleMax') as number);
  const precision =
    fromDb || tag('precision') === null
      ? (pv.precision ?? 0)
      : Math.trunc(tag('precision') as number);
  const conv = { exponential: 'e', gfloat: 'g' }[propStr(p, 'displayFormat') ?? 'ffloat'] ?? 'f';
  const valueText = (v: number) => cFormat(`%.${precision}${conv}`, v).slice(0, 13);
  const lo = Math.min(minFv, maxFv);
  const hi = Math.max(minFv, maxFv);
  const clampV = (v: number) => Math.min(Math.max(v, lo), hi);
  const value = local ?? pv.num;
  const frac = maxFv === minFv ? 0 : (clampV(value) - minFv) / (maxFv - minFv);

  const showLabel = propBool(p, 'showLabel');
  const showLimits = propBool(p, 'showLimits');
  const showValue = propBool(p, 'showValue');
  const labelType = propStr(p, 'controlLabelType') ?? 'literal';
  const label = labelType === 'literal' ? literal : name;
  const labelH = showLabel ? fh : 0;
  const limitsH = showLimits || showValue ? fh : 0;

  let scaleX: number;
  let scaleW: number;
  let scaleY: number;
  if (horizontal) {
    scaleX = 1;
    scaleW = w - 2;
    scaleY = labelH + limitsH + 1;
  } else {
    if (showLimits || showValue) {
      scaleX = Math.trunc(0.6 * w);
      scaleW = w - scaleX - 2;
      if (scaleW < 14) {
        scaleW = 14;
        scaleX = w - 16;
      }
    } else {
      scaleX = 1;
      scaleW = w - 2;
    }
    scaleY = labelH + 1;
  }
  const scaleH = h - scaleY - 2;

  // Motif XmScale: a 2-px highlight margin, a 2-px sunken trough bevel, then
  // the trough interior with a 30-px raised thumb.
  const ts = palette.spec(colorSpec(p, 'topShadowColor'));
  const bs = palette.spec(colorSpec(p, 'botShadowColor'));
  const trough = palette.spec(colorSpec(p, '2ndBgColor'));
  const bg = edmColor(palette, colorSpec(p, 'bgColor'), {
    data: pv,
    alarmSensitive: propBool(p, 'bgAlarm'),
  });
  const bgStatic = palette.spec(colorSpec(p, 'bgColor'));
  const fg = palette.spec(colorSpec(p, 'fgColor'));
  const tx = x + scaleX + 2;
  const ty = y + scaleY + 2;
  const tw = scaleW - 4;
  const th = scaleH - 4;
  const ix = tx + 2;
  const iy = ty + 2;
  const iw = tw - 4;
  const ih = th - 4;
  const travel = Math.max(0, (horizontal ? iw : ih) - THUMB);
  const off = Math.round(frac * travel);
  const thumb = horizontal
    ? { x: ix + off, y: iy, w: Math.min(THUMB, iw), h: ih }
    : { x: ix, y: iy + travel - off, w: iw, h: Math.min(THUMB, ih) };

  const bevel = (bx: number, by: number, bw: number, bh: number, a?: string, b?: string) => (
    <>
      <rect x={bx} y={by} width={bw} height={2} fill={a} />
      <rect x={bx} y={by} width={2} height={bh} fill={a} />
      <polygon
        points={`${bx + bw},${by} ${bx + bw},${by + bh} ${bx},${by + bh} ${bx + 2},${by + bh - 2} ${bx + bw - 2},${by + bh - 2} ${bx + bw - 2},${by + 2}`}
        fill={b}
      />
    </>
  );

  const text = (s: string, at: number, top: number, align: 'begin' | 'center' | 'end') => {
    const sw = textWidth(font, s);
    const left = align === 'begin' ? at : align === 'center' ? at - idiv(sw, 2) : at - sw;
    return <TextRun font={font} text={s} x={x + left} y={y + top + font.ascent} fill={fg} />;
  };
  const mid = idiv(scaleH, 2) + scaleY - Math.trunc(0.5 * fh);

  const writable = pv.connected && pv.writable;
  const increment = propNum(p, 'increment', 0);
  const valueAt = (e: ReactMouseEvent, grab: number) => {
    const r = e.currentTarget.getBoundingClientRect();
    const along = horizontal ? e.clientX - r.left - 4 - grab : r.bottom - e.clientY - 4 - grab;
    const f = travel > 0 ? Math.min(1, Math.max(0, along / travel)) : 0;
    return minFv + f * (maxFv - minFv);
  };
  const write = (v: number) => {
    const c = clampV(v);
    setLocal(c);
    put(controlPv, c);
  };

  return (
    <>
      <SvgBox x={x} y={y} w={w + 1} h={h + 1} clip>
        <rect x={x} y={y} width={w + 1} height={h + 1} fill={bg} />
        {showLabel && label
          ? horizontal
            ? text(label, 2, 0, 'begin')
            : text(label, w - 2, 0, 'end')
          : null}
        {showLimits
          ? horizontal
            ? text(cFormat('%g', minFv).slice(0, 13), 2, labelH, 'begin')
            : text(cFormat('%g', minFv).slice(0, 13), scaleX, h - 2 - limitsH, 'end')
          : null}
        {showLimits
          ? horizontal
            ? text(cFormat('%g', maxFv).slice(0, 13), w - 2, labelH, 'end')
            : text(cFormat('%g', maxFv).slice(0, 13), scaleX, scaleY, 'end')
          : null}
        {showValue
          ? horizontal
            ? text(valueText(value), idiv(w, 2), labelH, 'center')
            : text(valueText(value), scaleX, mid, 'end')
          : null}
        <rect x={x + scaleX} y={y + scaleY} width={scaleW} height={scaleH} fill={bgStatic} />
        {bevel(tx, ty, tw, th, bs, ts)}
        <rect x={ix} y={iy} width={Math.max(0, iw)} height={Math.max(0, ih)} fill={trough} />
        <rect x={thumb.x} y={thumb.y} width={thumb.w} height={thumb.h} fill={bgStatic} />
        {bevel(thumb.x, thumb.y, thumb.w, thumb.h, ts, bs)}
        {horizontal ? (
          <>
            <rect
              x={thumb.x + idiv(thumb.w, 2) - 1}
              y={thumb.y + 2}
              width={1}
              height={thumb.h - 4}
              fill={bs}
            />
            <rect
              x={thumb.x + idiv(thumb.w, 2)}
              y={thumb.y + 2}
              width={1}
              height={thumb.h - 4}
              fill={ts}
            />
          </>
        ) : (
          <>
            <rect
              x={thumb.x + 2}
              y={thumb.y + idiv(thumb.h, 2) - 1}
              width={thumb.w - 4}
              height={1}
              fill={bs}
            />
            <rect
              x={thumb.x + 2}
              y={thumb.y + idiv(thumb.h, 2)}
              width={thumb.w - 4}
              height={1}
              fill={ts}
            />
          </>
        )}
      </SvgBox>
      <div
        role="slider"
        data-edm-class={CLS}
        aria-valuenow={value}
        aria-valuemin={minFv}
        aria-valuemax={maxFv}
        onMouseDown={(e) => {
          if (e.button !== 0 || !writable) return;
          const r = e.currentTarget.getBoundingClientRect();
          const along = horizontal ? e.clientX - r.left - 4 : r.bottom - e.clientY - 4;
          if (along >= off && along <= off + THUMB) {
            drag.current = { grab: along - off };
          } else if (increment !== 0) {
            // A trough click steps toward the pointer.
            const up = along > off === maxFv > minFv;
            write(value + (up ? increment : -increment));
          }
        }}
        onMouseMove={(e) => {
          if (drag.current) write(valueAt(e, drag.current.grab));
        }}
        onMouseUp={() => {
          drag.current = null;
          setLocal(null);
        }}
        onMouseLeave={() => {
          drag.current = null;
          setLocal(null);
        }}
        style={{
          position: 'absolute',
          left: x + scaleX,
          top: y + scaleY,
          width: scaleW,
          height: scaleH,
          cursor: writable ? 'default' : 'not-allowed',
          pointerEvents: 'auto',
        }}
      />
    </>
  );
}
