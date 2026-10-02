// activeSliderClass. Behaviour matches EDM's baselib/slider.cc: a slider EDM
// draws itself inside a Motif frame:
//   - an etched-out 2-px frame (top shadow 2ndBgColor, bottom shadow black)
//     around a drawing area filled with bgColor; nothing else until the
//     control PV connects (no unconnected outline);
//   - a value row (control label, increment, control value), a trough in
//     2ndBgColor with the control pointer (a 60-degree wedge), the saved-value
//     line and a smaller read pointer, three ticks with the limits, and the
//     "save" / " rest" boxes; bgAlarm colours only the area below the trough;
//   - limits and precision from the PV per field (limitsFromDb, or a missing
//     tag); pointers clamp to the range, the saved value does not;
//   - button 1: save, restore, drag the pointer, or step by `increment`
//     toward the click with auto-repeat (500 ms, then faster; after ten
//     repeats steps of increment x incMultiplier); button 3 drags finely.
// Written from that behaviour; no EDM code is copied.

import { useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { resolveFont, textWidth } from '../config/fonts.js';
import { cFormat } from '../format.js';
import { propBool, propNum, propStr } from '../model.js';
import { useEdmPut, useEdmPv, useEdmScreen, useExpanded, usePhase } from '../screen/context.js';
import { ScaleText } from './barScale.js';
import { XLines } from './button.js';
import type { EdmWidgetProps } from './registry.js';
import { colorSpec, edmColor, geom, idiv, motifOrigin, pvProp } from './shared.js';

const CLS = 'activeSliderClass';
const TAN30 = Math.tan(Math.PI / 6);

/** Rows of a wedge pointing down with its apex row just above `base`: [row, left, right]. */
export function sliderWedge(c: number, base: number, r: number): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let d = 1; d <= r; d++) {
    const hw = Math.floor(Math.min(d * TAN30, Math.sqrt(r * r - (d - 0.5) * (d - 0.5))));
    out.push([base - d, c - hw, c + hw]);
  }
  return out;
}

/** An etched-out shadow of thickness 2 on a w x h box (Motif XmSHADOW_ETCHED_OUT). */
function EtchedFrame(props: {
  x: number;
  y: number;
  w: number;
  h: number;
  top: string | undefined;
  bottom: string | undefined;
}) {
  const { x, y, w, h, top, bottom } = props;
  const ring = (i: number, tl: string | undefined, br: string | undefined) => (
    <>
      <rect x={x + i} y={y + i} width={w - 1 - 2 * i} height={1} fill={tl} />
      <rect x={x + i} y={y + i} width={1} height={h - 1 - 2 * i} fill={tl} />
      <rect x={x + i} y={y + h - 1 - i} width={w - 2 * i} height={1} fill={br} />
      <rect x={x + w - 1 - i} y={y + i} width={1} height={h - 2 * i} fill={br} />
    </>
  );
  return (
    <>
      {ring(0, top, bottom)}
      {ring(1, bottom, top)}
    </>
  );
}

const REPEAT_MS = [500, 96, 91, 86, 81, 76, 71, 66, 61, 56, 51];

export function Slider({ obj }: EdmWidgetProps) {
  const { palette } = useEdmScreen();
  const p = obj.props;
  const g = geom(p);
  const { x, y } = motifOrigin(g.x, g.y);
  const { w, h } = g;
  const controlPv = pvProp(p, 'controlPv');
  const indicatorPv = pvProp(p, 'indicatorPv');
  const savedPv = pvProp(p, 'savedValuePv');
  const ctl = useEdmPv(controlPv, `${CLS}.controlPv`);
  const ind = useEdmPv(indicatorPv, `${CLS}.indicatorPv`);
  const saved = useEdmPv(savedPv, `${CLS}.savedValuePv`);
  const cLabelType = propStr(p, 'controlLabelType') ?? 'literal';
  const rLabelType = propStr(p, 'readLabelType') ?? 'literal';
  const cLabelS = useExpanded(propStr(p, 'controlLabel') ?? '') ?? '';
  const rLabelS = useExpanded(propStr(p, 'readLabel') ?? '') ?? '';
  const cLabelPv = useEdmPv(
    cLabelType === 'pvLabel' ? propStr(p, 'controlLabel') : undefined,
    `${CLS}.controlLabel`
  );
  const rLabelPv = useEdmPv(
    rLabelType === 'pvLabel' ? propStr(p, 'readLabel') : undefined,
    `${CLS}.readLabel`
  );
  const ctlName = useExpanded(controlPv) ?? '';
  const indName = useExpanded(indicatorPv) ?? '';
  const put = useEdmPut();
  // Initialised once the control PV has connected.
  const phase = usePhase(controlPv ? [ctl] : [undefined]);
  const [local, setLocal] = useState<number | null>(null);
  const [localSaved, setLocalSaved] = useState<number | null>(null);
  const [firstValue, setFirstValue] = useState<number | null>(null);
  if (firstValue === null && ctl?.connected) setFirstValue(ctl.num);
  const repeat = useRef<{ timer: ReturnType<typeof setTimeout>; n: number } | null>(null);
  const drag = useRef<{ fine: boolean; lastX: number } | null>(null);

  const adjW = w - 4;
  const adjH = h - 4;
  const font = resolveFont(propStr(p, 'font'));
  const fh = font.ascent + font.descent;
  const shade = palette.spec(colorSpec(p, '2ndBgColor'));
  const bgStatic = palette.spec(colorSpec(p, 'bgColor'));
  const frame = <EtchedFrame x={x} y={y} w={w} h={h} top={shade} bottom="#000000" />;
  const init = phase === 'init' && !!ctl;

  const valueAreaH = Math.trunc(2.5 * fh);
  const labelAreaH = 2 * fh;
  const controlAreaH = Math.max(10, adjH - valueAreaH - labelAreaH);
  const controlAreaW = adjW - 40;
  const controlW = controlAreaW - controlAreaH;
  const controlY = valueAreaH + 1;
  const controlH = controlAreaH - 2;
  const readH = idiv(controlH, 2);
  const xOfs = idiv(adjW - controlW, 2);
  const troughX = idiv(adjW - controlAreaW, 2);
  const markX1 = idiv(adjW, 2) - 4;
  const markX0 = markX1 - textWidth(font, 'save');
  const restoreX0 = idiv(adjW, 2) + 4;
  const restoreX1 = restoreX0 + textWidth(font, ' res');
  const markY1 = valueAreaH + controlAreaH + labelAreaH - 2;
  const markY0 = markY1 - fh;

  let body = null;
  let minFv = 0;
  let maxFv = 10;
  let factor = 1;
  let controlV = 0;
  let controlX = 0;
  const tag = (k: string) => (propStr(p, k) === undefined ? null : propNum(p, k, 0));
  const fromDb = propBool(p, 'limitsFromDb');
  const clampV = (u: number) =>
    maxFv > minFv ? Math.min(Math.max(u, minFv), maxFv) : Math.min(Math.max(u, maxFv), minFv);
  const pos = (u: number) => Math.trunc((u - minFv) / factor + 0.5) + xOfs;

  if (init) {
    minFv = fromDb || tag('scaleMin') === null ? ctl.lowerLimit : (tag('scaleMin') ?? 0);
    maxFv = fromDb || tag('scaleMax') === null ? ctl.upperLimit : (tag('scaleMax') ?? 0);
    factor = (maxFv - minFv) / controlW || 1;
    const precision =
      fromDb || tag('precision') === null ? (ctl.precision ?? 0) : Math.trunc(tag('precision')!);
    const conv = { GFloat: 'g', Exponential: 'e' }[propStr(p, 'displayFormat') ?? 'FFloat'] ?? 'f';
    const fmt = (v: number, prec: number) => cFormat(`%.${prec}${conv}`, v).slice(0, 14);
    controlV = local ?? ctl.num;
    controlX = pos(clampV(controlV));
    const savedV = localSaved ?? (saved?.connected ? saved.num : (firstValue ?? controlV));
    const savedX = pos(savedV);
    const down = !ctl.connected;
    const fg = down ? palette.disconnected() : palette.spec(colorSpec(p, 'fgColor'));
    const bgLower = edmColor(palette, colorSpec(p, 'bgColor'), {
      data: ctl.connected ? ctl : undefined,
      alarmSensitive: propBool(p, 'bgAlarm'),
    });
    const control = down
      ? palette.disconnected()
      : edmColor(palette, colorSpec(p, 'controlColor'), {
          data: ctl,
          alarmSensitive: propBool(p, 'controlAlarm'),
        });
    const controlStatic = palette.spec(colorSpec(p, 'controlColor'));
    const indicator =
      indicatorPv && down
        ? palette.disconnected()
        : edmColor(palette, colorSpec(p, 'indicatorColor'), {
            data: ind?.connected ? ind : undefined,
            alarmSensitive: propBool(p, 'indicatorAlarm'),
          });
    const indicatorStatic = palette.spec(colorSpec(p, 'indicatorColor'));
    const readPrecision =
      fromDb || tag('precision') === null ? (ind?.precision ?? 0) : Math.trunc(tag('precision')!);
    const readV = ind?.connected ? ind.num : 0;
    const readX = pos(clampV(readV));
    const cLabel =
      cLabelType === 'pvName'
        ? ctlName
        : cLabelType === 'pvLabel'
          ? cLabelPv?.connected
            ? cLabelPv.text.slice(0, 39)
            : cLabelS
          : cLabelS;
    const rLabel =
      rLabelType === 'pvName'
        ? indName
        : rLabelType === 'pvLabel'
          ? rLabelPv?.connected
            ? rLabelPv.text.slice(0, 39)
            : rLabelS
          : rLabelS;
    const wedge = (c: number, base: number, r: number, fill: string | undefined) =>
      sliderWedge(c, base, r).map(([row, l, rt]) => (
        <rect key={`${c}:${row}`} x={l} y={row} width={rt - l + 1} height={1} fill={fill} />
      ));
    const ty0 = valueAreaH + controlAreaH + 4;
    const ty1 = valueAreaH + controlAreaH + idiv(labelAreaH, 2) - 4;
    const textY = valueAreaH + controlAreaH + idiv(labelAreaH, 2) - 2;
    const incString = fmt(propNum(p, 'increment', 0), precision);
    body = (
      <>
        <rect x={troughX} y={valueAreaH} width={controlAreaW} height={controlAreaH} fill={shade} />
        <rect
          x={0}
          y={valueAreaH + controlAreaH}
          width={w}
          height={Math.max(0, h - valueAreaH - controlAreaH)}
          fill={bgLower}
        />
        {controlPv ? (
          <>
            {wedge(controlX, controlY + controlH, controlH, control)}
            <XLines lines={[[savedX, controlY, savedX, controlY + controlH, control]]} />
          </>
        ) : null}
        {indicatorPv ? wedge(readX, controlY + idiv(controlH, 2) + readH, readH, indicator) : null}
        <XLines
          lines={[xOfs, xOfs + idiv(controlW, 2), xOfs + controlW].map((t) => [t, ty1, t, ty0, fg])}
        />
        <ScaleText
          font={font}
          text={cFormat('%-g', minFv)}
          at={xOfs}
          top={textY}
          align="begin"
          fill={fg}
        />
        <ScaleText
          font={font}
          text={cFormat('%-g', maxFv)}
          at={adjW - xOfs}
          top={textY}
          align="end"
          fill={fg}
        />
        <ScaleText
          font={font}
          text={fmt(controlV, precision)}
          at={adjW - 2}
          top={2}
          align="end"
          fill={controlStatic}
          bg={shade}
        />
        <ScaleText
          font={font}
          text={incString}
          at={idiv(w, 2)}
          top={2}
          align="center"
          fill={controlStatic}
          bg={shade}
        />
        <ScaleText
          font={font}
          text="save"
          at={markX1}
          top={markY0}
          align="end"
          fill={fg}
          bg={shade}
        />
        <ScaleText
          font={font}
          text=" rest"
          at={restoreX0}
          top={markY0}
          align="begin"
          fill={fg}
          bg={shade}
        />
        {cLabel ? (
          <ScaleText font={font} text={cLabel} at={2} top={2} align="begin" fill={control} />
        ) : null}
        {indicatorPv ? (
          <ScaleText
            font={font}
            text={fmt(readV, readPrecision)}
            at={adjW - 2}
            top={4 + fh}
            align="end"
            fill={indicatorStatic}
            bg={shade}
          />
        ) : null}
        {rLabel ? (
          <ScaleText font={font} text={rLabel} at={2} top={4 + fh} align="begin" fill={indicator} />
        ) : null}
      </>
    );
  }

  const writable = init && ctl.connected && ctl.writable;
  const write = (v: number) => {
    setLocal(v);
    put(controlPv, v);
  };
  const stopRepeat = () => {
    if (repeat.current) clearTimeout(repeat.current.timer);
    repeat.current = null;
    drag.current = null;
    setLocal(null);
  };
  const step = (up: boolean) => {
    const inc = propNum(p, 'increment', 0);
    const mult = propNum(p, 'incMultiplier', 0);
    let v = local ?? controlV;
    const once = (n: number) => {
      const d = n > 10 ? inc * mult : inc;
      v = clampV(v + (up ? d : -d));
      write(v);
      repeat.current = {
        n: n + 1,
        timer: setTimeout(() => once(n + 1), REPEAT_MS[Math.min(n, REPEAT_MS.length - 1)] ?? 46),
      };
    };
    once(0);
  };
  const local2 = (e: ReactMouseEvent) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { u: e.clientX - r.left - 2, v: e.clientY - r.top - 2 };
  };

  return (
    <>
      <svg
        x={x}
        y={y}
        width={w}
        height={h}
        shapeRendering="crispEdges"
        style={{ position: 'absolute', left: x, top: y, overflow: 'hidden', zIndex: 1 }}
        viewBox={`${x} ${y} ${w} ${h}`}
      >
        {frame}
        <svg
          x={x + 2}
          y={y + 2}
          width={Math.max(0, adjW)}
          height={Math.max(0, adjH)}
          viewBox={`0 0 ${Math.max(0, adjW)} ${Math.max(0, adjH)}`}
          overflow="hidden"
        >
          <rect x={0} y={0} width={w} height={h} fill={bgStatic} />
          {body}
        </svg>
      </svg>
      <div
        role="slider"
        data-edm-class={CLS}
        aria-valuenow={init ? controlV : undefined}
        onMouseDown={(e) => {
          if (!writable || (e.button !== 0 && e.button !== 2)) return;
          const { u, v } = local2(e);
          if (e.button === 2) {
            if (Math.abs(u - controlX) < controlAreaH / 2) drag.current = { fine: true, lastX: u };
            return;
          }
          if (u > markX0 && u < markX1 && v > markY0 && v < markY1) {
            if (savedPv && saved?.connected) put(savedPv, controlV);
            else setLocalSaved(controlV);
          } else if (u > restoreX0 && u < restoreX1 && v > markY0 && v < markY1) {
            write(localSaved ?? (saved?.connected ? saved.num : (firstValue ?? controlV)));
          } else if (
            Math.abs(u - controlX) < controlAreaH / 2 &&
            v > valueAreaH &&
            v < valueAreaH + controlAreaH
          ) {
            drag.current = { fine: false, lastX: u };
          } else if (v > valueAreaH) {
            step(u > controlX + controlAreaH / 2);
          }
        }}
        onMouseMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const { u } = local2(e);
          if (d.fine) {
            const inc = propNum(p, 'increment', 0);
            const delta = Math.abs(u - d.lastX) * inc;
            write(clampV((local ?? controlV) + (e.shiftKey ? -delta : delta)));
            d.lastX = u;
          } else {
            write(clampV(factor * (u - xOfs) + minFv));
          }
        }}
        onMouseUp={stopRepeat}
        onMouseLeave={stopRepeat}
        onContextMenu={(e) => e.preventDefault()}
        style={{
          position: 'absolute',
          left: x,
          top: y,
          width: w,
          height: h,
          zIndex: 1,
          cursor: writable || !init ? 'default' : 'not-allowed',
          pointerEvents: 'auto',
        }}
      />
    </>
  );
}
