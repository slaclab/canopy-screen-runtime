// xyGraphClass. Behaviour matches EDM's baselib/xygraph.cc; written from
// that behaviour, no EDM code is copied.
//
//   - traces: XY (x and y PVs) or chronological (y only, x = element index or
//     sample count); vectors when a PV has more than one element (nPv limits
//     the count), else one point per update;
//   - nothing is drawn until every x/y PV has connected (no outline);
//   - axes: fromUser (the tags), fromPv (the PVs' display limits) or
//     AutoScale (grown to the data, then refitted with a 2 % margin), ticks
//     from EDM's range rounding; the plot area is laid out around the scales,
//     title and labels exactly as EDM does (the y label rotated, its letters
//     two widths apart); margins in the display background, the plot area in
//     bgColor;
//   - traces drawn in index order, clipped inside the plot area, as lines
//     (X's wide-line model), points, needles, with circle/square/diamond
//     symbols; opMode plot keeps first/last/min/max per pixel column.

import { useState } from 'react';
import type { ReactNode } from 'react';
import { parseColorSpec } from '../config/colors.js';
import { resolveFont, textWidth } from '../config/fonts.js';
import { expandMacros } from '../macros.js';
import { propBool, propIndexedInts, propIndexedStrings, propInt, propStr } from '../model.js';
import type { EdmProps } from '../model.js';
import type { EdmPvData } from '../pv/types.js';
import { useEdmPvList, useEdmScreen } from '../screen/context.js';
import { ScaleText } from './barScale.js';
import { XLines } from './button.js';
import type { XLine } from './button.js';
import type { EdmWidgetProps } from './registry.js';
import { SvgBox, XRectOutline, X_PIXEL, colorSpec, geom, idiv, rint } from './shared.js';
import { labelValues, roundRange, tickText, xScaleMargin, yScaleWidth } from './xyScale.js';

const CLS = 'xyGraphClass';
const MAX_TRACES = 20;

const blankOrComment = (s: string) => {
  const t = s.trim();
  return !t || t.startsWith('#');
};
const unq = (s: string | undefined) => (s ?? '').replace(/^"(.*)"$/, '$1');
const enumTag = (p: EdmProps, k: string, def: string) => unq(propStr(p, k)) || def;
const numTag = (p: EdmProps, k: string): number | null => {
  const v = propStr(p, k);
  if (v === undefined) return null;
  const n = Number(unq(v));
  return Number.isFinite(n) ? n : 0;
};

type Pt = [number, number];
type AxisKey = 'x' | 'y' | 'y2';

interface Axis {
  readonly shown: boolean;
  /** Current (displayed) limits and the rounded ones the ticks start from. */
  readonly cur: [number, number];
  readonly adj: [number, number];
  readonly auto: { n: number; majors: number; minors: number };
  readonly draw: { n: number; majors: number; minors: number };
  readonly grids: { label: boolean; major: boolean; minor: boolean };
}

interface TraceDef {
  readonly i: number;
  readonly kind: 'xy' | 'chrono';
  readonly style: string;
  readonly thickness: number;
  readonly dash: boolean;
  readonly symbol: string;
  readonly plotMode: boolean;
  readonly y2: boolean;
  readonly color: string | undefined;
  readonly y?: EdmPvData;
  readonly x?: EdmPvData;
  readonly n?: EdmPvData;
  /** mzxyGraph: [LOPR, HOPR] from the companion PVs. */
  readonly limits?: [number, number];
}

const EPICS_EPOCH_MS = Date.UTC(1990, 0, 1);
const two = (n: number) => String(n).padStart(2, '0');

/** A dateTime axis label: local "HH:MM:SS[.ff]" and "MM-DD-YYYY" of the EPICS epoch + v s. */
export function timeLabel(v: number): [string, string] {
  const whole = Math.floor(v);
  const ff = rint((v - whole) * 100);
  const d = new Date(EPICS_EPOCH_MS + whole * 1000);
  const t = `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
  return [
    ff > 0 ? `${t}.${two(ff)}` : t,
    `${two(d.getMonth() + 1)}-${two(d.getDate())}-${d.getFullYear()}`,
  ];
}

/** Load-time repair of a configured range (only with traces). */
function repaired(min: number | null, max: number | null): [number, number] {
  const a = min ?? 0;
  let b = max ?? 0;
  if (a >= b) b = 2 * a;
  if (a >= b) b = a + 1;
  return [a, b];
}

/** The elements a trace PV contributes (nPv limits the count). */
function elements(d: EdmPvData | undefined, n: EdmPvData | undefined): readonly number[] {
  if (!d?.connected) return [];
  const all = d.values ?? [d.num];
  const ts = n?.connected ? Math.trunc(n.num) : 0;
  return ts > 0 && ts <= all.length ? all.slice(0, ts) : all;
}

export function XyGraph(props: EdmWidgetProps) {
  return <Graph {...props} cls={CLS} mz={false} />;
}

/**
 * mzxyGraphClass (slaclib/mz_xygraph.cc): SLAC's copy of the X-Y graph. Each
 * y trace also connects <yPv>.HOPR and .LOPR, whose values are its fromPv
 * limits; traces without a colour use the colour alias trace<i>; and its
 * patch writes per-trace flags past a 2-entry array, so a vector trace at
 * index 6 with an integer (or absent) y2Min resets x and the used y axes to a
 * locked 0..1, with the end labels black on white (as EDM shows them).
 */
export function MzXyGraph(props: EdmWidgetProps) {
  return <Graph {...props} cls="mzxyGraphClass" mz />;
}

function Graph({ obj, cls: CLS, mz }: EdmWidgetProps & { cls: string; mz: boolean }) {
  const env = useEdmScreen();
  const { palette, displayBg } = env;
  const p = obj.props;
  const { x: ox, y: oy, w, h } = geom(p);
  const numTraces = Math.min(MAX_TRACES, Math.max(0, propInt(p, 'numTraces', 0)));
  const xPvs = propIndexedStrings(p, 'xPv');
  const yPvs = propIndexedStrings(p, 'yPv');
  const nPvs = propIndexedStrings(p, 'nPv');
  const ex = (s: string | undefined) => expandMacros(unq(s), env.macros);

  // PVs in EDM's order: trace control, reset, trigger, then y, x, n per trace.
  const names: string[] = [];
  const bys: string[] = [];
  const add = (raw: string | undefined, prop: string) => {
    const r = unq(raw);
    if (blankOrComment(ex(r))) return -1;
    names.push(r);
    bys.push(`${CLS}.${prop}`);
    return names.length - 1;
  };
  const ctlIdx = add(propStr(p, 'traceCtlPv'), 'traceCtlPv');
  add(propStr(p, 'resetPv'), 'resetPv');
  add(propStr(p, 'triggerPv'), 'triggerPv');
  const slots: {
    kind: 'xy' | 'chrono' | 'invalid';
    y: number;
    x: number;
    n: number;
    hopr: number;
    lopr: number;
  }[] = [];
  for (let i = 0; i < numTraces; i++) {
    const rawX = unq(xPvs[i]);
    const rawY = unq(yPvs[i]);
    const kind =
      !blankOrComment(rawX) && !blankOrComment(rawY)
        ? 'xy'
        : !blankOrComment(rawY)
          ? 'chrono'
          : 'invalid';
    let yi = -1;
    let xi = -1;
    let hopr = -1;
    let lopr = -1;
    if (kind !== 'invalid' && !blankOrComment(ex(rawY))) {
      yi = add(rawY, 'yPv');
      if (mz) {
        hopr = add(`${ex(rawY).trim()}.HOPR`, 'yPv.companion');
        lopr = add(`${ex(rawY).trim()}.LOPR`, 'yPv.companion');
      }
      if (kind === 'xy') xi = add(rawX, 'xPv');
    }
    const ni = add(nPvs[i], 'nPv');
    slots.push({ kind, y: yi, x: xi, n: ni, hopr, lopr });
  }
  const data = useEdmPvList(names, bys);

  // Scalar traces collect one point per update.
  const [acc, setAcc] = useState<{
    seen: readonly unknown[];
    pts: Record<number, Pt[]>;
    count: number;
  }>({ seen: [], pts: {}, count: 0 });
  const live = slots.every(
    (s) => (s.y < 0 || data[s.y]?.connected) && (s.x < 0 || data[s.x]?.connected)
  );

  const styles = propIndexedStrings(p, 'plotStyle').map(unq);
  const thick = propIndexedInts(p, 'lineThickness');
  const lineStyles = propIndexedStrings(p, 'lineStyle').map(unq);
  const symbols = propIndexedStrings(p, 'plotSymbolType').map(unq);
  const opModes = propIndexedStrings(p, 'opMode').map(unq);
  const useY2 = propIndexedInts(p, 'useY2Axis');
  const colours = propIndexedStrings(p, 'plotColor');
  const nPts = propInt(p, 'nPts', 2);
  const lastN = enumTag(p, 'plotMode', 'plotNPtsAndStop') === 'plotLastNPts';

  const traces: TraceDef[] = [];
  slots.forEach((s, i) => {
    if (s.kind === 'invalid' || s.y < 0) return;
    traces.push({
      i,
      kind: s.kind,
      style: styles[i] || 'line',
      thickness: Math.max(1, thick[i] ?? 1),
      dash: lineStyles[i] === 'dash',
      symbol: symbols[i] || 'none',
      plotMode: opModes[i] === 'plot',
      y2: !!useY2[i],
      color: colours[i]
        ? palette.spec(parseColorSpec(colours[i]))
        : mz
          ? (palette.cssByName(`trace${i}`) ?? palette.css(0))
          : palette.css(0),
      limits:
        s.hopr >= 0
          ? [
              data[s.lopr]?.connected ? data[s.lopr]!.num : 0,
              data[s.hopr]?.connected ? data[s.hopr]!.num : 0,
            ]
          : undefined,
      y: data[s.y],
      x: s.x >= 0 ? data[s.x] : undefined,
      n: s.n >= 0 ? data[s.n] : undefined,
    });
  });

  // Points per trace (data coordinates).
  const vectorOf = (t: TraceDef) =>
    t.style === 'single point' || elements(t.y, t.n).length > 1 || (t.x?.values?.length ?? 0) > 1;
  if (live && acc.seen !== data) {
    const pts = { ...acc.pts };
    let count = acc.count;
    for (const t of traces) {
      if (vectorOf(t) || !t.y?.connected) continue;
      const list = [...(pts[t.i] ?? [])];
      if (nPts <= 0) continue;
      if (!lastN && list.length >= nPts) continue;
      list.push([t.kind === 'xy' ? (t.x?.num ?? 0) : count, t.y.num]);
      if (lastN && list.length > nPts)
        list.splice(0, Math.max(1, Math.trunc(0.1 * Math.max(nPts, 2))));
      pts[t.i] = list;
      count++;
    }
    setAcc({ seen: data, pts, count });
  }
  if (!live || numTraces === 0 || traces.length === 0) return null;

  const hidden = ctlIdx >= 0 && data[ctlIdx]?.connected ? Math.trunc(data[ctlIdx].num) : 0;
  const visible = traces.filter((t) => !(hidden & (1 << t.i)));
  const pointsOf = (t: TraceDef): Pt[] => {
    if (!vectorOf(t)) return acc.pts[t.i] ?? [];
    const ys = elements(t.y, t.n);
    if (t.kind === 'chrono') return ys.map((v, k) => [k, v]);
    const xs = elements(t.x, undefined);
    const n = Math.min(xs.length, ys.length);
    return ys.slice(0, n).map((v, k) => [xs[k], v]);
  };
  const tracePts = new Map(visible.map((t) => [t.i, pointsOf(t)]));
  const anyVector = visible.some(vectorOf);

  // Axis ranges.
  const font = resolveFont(propStr(p, 'font'));
  const fh = font.ascent + font.descent;
  const show = {
    x: propBool(p, 'showXAxis'),
    y: propBool(p, 'showYAxis'),
    y2: propBool(p, 'showY2Axis'),
  };
  const tagPrefix: Record<AxisKey, string> = { x: 'x', y: 'y', y2: 'y2' };
  const allChrono = traces.every((t) => t.kind === 'chrono');
  const srcOf = (a: AxisKey) => {
    const s = enumTag(p, `${tagPrefix[a]}AxisSrc`, 'fromPv');
    if (a === 'x' && s === 'fromPv' && (allChrono || traces[0]?.kind === 'chrono'))
      return 'AutoScale';
    return s;
  };
  const onAxis = (a: AxisKey) =>
    a === 'x' ? visible : visible.filter((t) => (a === 'y2') === t.y2);
  const dataSpan = (a: AxisKey): [number, number] | null => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const t of onAxis(a)) {
      for (const pt of tracePts.get(t.i) ?? []) {
        const v = a === 'x' ? pt[0] : pt[1];
        if (Number.isNaN(v)) continue;
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
    }
    return lo <= hi ? [lo, hi] : null;
  };
  const axes = {} as Record<AxisKey, Axis>;
  const keys: AxisKey[] = ['x', 'y', 'y2'];
  const configured = (a: AxisKey) =>
    repaired(numTag(p, `${tagPrefix[a]}Min`), numTag(p, `${tagPrefix[a]}Max`));
  // Start-up limits; AutoScale axes then grow to the data and, if any grew,
  // every AutoScale axis is refitted with a 2 % margin.
  const cur: Record<AxisKey, [number, number]> = { x: [0, 1], y: [0, 1], y2: [0, 1] };
  const before: Record<AxisKey, number> = { x: 0, y: 0, y2: 0 };
  let grew = false;
  for (const a of keys) {
    const src = srcOf(a);
    const [tmin, tmax] = configured(a);
    if (src === 'fromUser') cur[a] = [tmin, tmax];
    else if (src === 'fromPv') {
      const lims = onAxis(a).flatMap((t): [number, number][] => {
        if (a !== 'x' && t.limits) return [t.limits];
        const d = a === 'x' ? t.x : t.y;
        return d?.connected ? [[d.lowerLimit, d.upperLimit]] : [];
      });
      cur[a] = lims.length
        ? [Math.min(...lims.map((l) => l[0])), Math.max(...lims.map((l) => l[1]))]
        : [0, 1];
    } else {
      const r = roundRange(Math.min(tmin, 0), Math.max(tmax, 0));
      cur[a] = [r.min, r.max];
      const span = dataSpan(a);
      if (span && (span[0] < cur[a][0] || span[1] > cur[a][1])) {
        const g2 = roundRange(Math.min(cur[a][0], span[0]), Math.max(cur[a][1], span[1]));
        cur[a] = [g2.min, g2.max];
        grew = true;
      }
      before[a] = cur[a][0];
    }
  }
  if (grew) {
    for (const a of keys) {
      if (srcOf(a) !== 'AutoScale') continue;
      const span = dataSpan(a);
      if (!span) continue;
      const [dmin, dmax] = span;
      let lo: number;
      let hi: number;
      if (a === 'x') {
        lo = dmin - 0.02 * Math.abs(dmax - before.x);
        hi = dmax + 0.02 * Math.abs(dmax - lo);
      } else {
        lo = dmin - 0.02 * (dmax - dmin);
        hi = dmax + 0.02 * (dmax - dmin);
      }
      const r = roundRange(lo, hi);
      cur[a] = [r.min, r.max];
    }
  }
  // autoScaleBothDirections: every second an AutoScale axis whose data fill
  // too little of it is refitted to the data.
  if (propBool(p, 'autoScaleBothDirections')) {
    const pct = numTag(p, 'autoScaleThreshPct');
    const thresh = pct === null ? 0.5 : 0.01 * pct;
    for (let pass = 0; pass < 4; pass++) {
      for (const a of keys) {
        if (srcOf(a) !== 'AutoScale') continue;
        const span = dataSpan(a);
        if (!span || span[1] === span[0]) continue;
        const curSpan = Math.abs(cur[a][1] - cur[a][0]);
        if ((curSpan - Math.abs(span[1] - span[0])) / curSpan <= thresh) continue;
        const lo = span[0] - 0.02 * Math.abs(span[1] - cur[a][0]);
        const hi = span[1] + 0.02 * Math.abs(span[1] - lo);
        const r = roundRange(lo, hi);
        cur[a] = [r.min, r.max];
      }
    }
  }
  const locked = new Set<AxisKey>();
  if (mz) {
    const y2Min = numTag(p, 'y2Min');
    const t6 = visible.find((t) => t.i === 6);
    if (t6 && vectorOf(t6) && Number.isInteger(y2Min ?? 0)) {
      for (const a of keys) {
        if (a === 'x' || onAxis(a).length) {
          cur[a] = [0, 1];
          locked.add(a);
        }
      }
    }
  }
  for (const a of keys) {
    const pre = tagPrefix[a];
    const r = roundRange(cur[a][0], cur[a][1]);
    const smooth = propInt(p, `${pre}AxisSmoothing`, 0) === 1;
    const adj: [number, number] = smooth ? [cur[a][0], cur[a][1]] : [r.min, r.max];
    const auto = { n: r.n, majors: r.majors, minors: r.minors };
    const user = propInt(p, `${pre}UserSpecScaleDiv`, 0) === 1;
    const draw = user
      ? {
          n: Math.max(1, numTag(p, `${pre}LabelIntervals`) ?? 0),
          majors: numTag(p, `${pre}MajorsPerLabel`) ?? 0,
          minors: numTag(p, `${pre}MinorsPerMajor`) ?? 0,
        }
      : auto;
    axes[a] = {
      shown: show[a],
      cur: cur[a],
      adj,
      auto,
      draw,
      grids: {
        label: propBool(p, `${pre}ShowLabelGrid`),
        major: propBool(p, `${pre}ShowMajorGrid`),
        minor: propBool(p, `${pre}ShowMinorGrid`),
      },
    };
  }

  // Plot-area layout.
  const LT = (shown: boolean) => Math.trunc(0.8 * Math.abs((shown ? fh : 1) - 2));
  let ly1 = show.y
    ? yScaleWidth(font, axes.y.adj[0], axes.y.adj[1], axes.y.auto.n, LT(true)) + 4
    : 0;
  let ly2 = show.y2
    ? yScaleWidth(font, axes.y2.adj[0], axes.y2.adj[1], axes.y2.auto.n, LT(true)) + 2
    : 0;
  const timeDate =
    enumTag(p, 'xAxisStyle', 'linear') === 'time' &&
    enumTag(p, 'xAxisTimeFormat', 'seconds') === 'dateTime';
  const hx = show.x ? Math.trunc(1.4 * fh) + (timeDate ? fh : 0) : 0;
  const lx = !show.x
    ? 0
    : timeDate
      ? idiv(textWidth(font, '00-00-0000'), 2) + 6 + 1
      : xScaleMargin(font, axes.x.cur[0], axes.x.cur[1]) + 1;
  if (show.y && !show.y2) ly2 = 10;
  if (show.y2 && !show.y) ly1 = 10;
  ly1 = Math.max(ly1, lx);
  ly2 = Math.max(ly2, lx);
  const b = propBool(p, 'border') ? 1 : 0;
  const title = ex(propStr(p, 'graphTitle'));
  const xLabel = ex(propStr(p, 'xLabel'));
  const yLabel = ex(propStr(p, 'yLabel'));
  const tInc = title.trim() ? fh + 1 : show.y || show.y2 ? idiv(fh, 2) + 1 : 0;
  const xlInc = xLabel.trim() ? fh + 1 : !show.x && (show.y || show.y2) ? idiv(fh, 2) + 1 : 0;
  const ylInc = show.y && yLabel.trim() ? fh + 1 : 0;
  const y2Label = ex(propStr(p, 'y2Label'));
  const y2lInc = show.y2 && y2Label.trim() ? fh + 1 : 0;
  const X = ly1 + b + ylInc;
  const W = w - 2 * b - ylInc - ly1 - ly2 - y2lInc;
  const Y = b + Math.trunc(1.5 * tInc);
  const H = h - 2 * b - Math.trunc(1.5 * tInc) - Math.trunc(1.5 * xlInc) - Math.trunc(1.5 * hx);

  const fg = palette.spec(colorSpec(p, 'fgColor'));
  const gridColor = palette.spec(colorSpec(p, 'gridColor'));
  const plotBg = palette.spec(colorSpec(p, 'bgColor'));

  // Axes: lines (solid), dashed minor grids, labels.
  const solid: XLine[] = [];
  const dashed: XLine[] = [];
  const texts: ReactNode[] = [];
  const drawAxis = (a: 'x' | 'y', withText: boolean, onlyGrid = false) => {
    const ax = axes[a];
    const { n, majors, minors } = ax.draw;
    let [amin, amax] = ax.adj;
    const neg = amin > amax;
    if (neg) [amin, amax] = [-amin, -amax];
    let inc = (amax - amin) / n;
    if (!(inc > 0)) inc = 1;
    const len = a === 'x' ? W : H;
    if (len < 1 || n < 1 || amax === amin) return;
    const [cmin, cmax] = ax.cur;
    const lt = LT(ax.shown);
    const mt = Math.trunc(0.7 * lt);
    const mn = Math.trunc(0.4 * lt);
    const f = len / (cmax - cmin);
    const time = a === 'x' && timeDate;
    const at = time
      ? (v: number) => Math.trunc(rint(((v - amin) * len) / (amax - amin) + X))
      : a === 'x'
        ? (() => {
            const off = Math.trunc(rint((amin - cmin) * f + X));
            return (v: number) => Math.trunc(rint((v - amin) * f + off));
          })()
        : (() => {
            const yb = Y + H;
            const off = Math.trunc(rint(yb - (amin - cmin) * f));
            return (v: number) => Math.trunc(rint(off - (v - amin) * f));
          })();
    const inRange = (c: number) => (a === 'x' ? c >= X && c <= X + W : c >= Y && c <= Y + H);
    const ya = Y + H;
    const tick = (c: number, t: number) => {
      if (!ax.shown || onlyGrid) return;
      solid.push(
        a === 'x'
          ? [ox + c, oy + ya, ox + c, oy + ya + t, fg]
          : [ox + X, oy + c, ox + X - t, oy + c, fg]
      );
    };
    const grid = (c: number, dash: boolean) => {
      const line: XLine =
        a === 'x'
          ? [ox + c, oy + ya, ox + c, oy + ya - H, gridColor]
          : [ox + X, oy + c, ox + X + W, oy + c, gridColor];
      (dash ? dashed : solid).push(line);
    };
    if (ax.shown && !onlyGrid) {
      solid.push(
        a === 'x'
          ? [ox + X, oy + ya, ox + X + W, oy + ya, fg]
          : [ox + X, oy + Y + H, ox + X, oy + Y, fg]
      );
    }
    let lastLabel = amin;
    // A dateTime axis stops half a step short, then labels the last value
    // without a grid line.
    let values = labelValues(amin, amax, n);
    if (time) {
      values = [];
      let v = amin;
      for (; v < amax - inc / 2 && values.length < 1000; v += inc) values.push(v);
      values.push(v);
    }
    const inRangeIdx = values.map((v) => inRange(at(v)));
    const firstIn = inRangeIdx.indexOf(true);
    const lastIn = inRangeIdx.lastIndexOf(true);
    values.forEach((v, k) => {
      const c = at(v);
      const isLast = time && k === values.length - 1;
      // A locked (box) limit shows its end labels black on white.
      const boxed = locked.has(a) && (k === firstIn || k === lastIn);
      const tf = boxed ? '#000000' : fg;
      const tb = boxed ? '#ffffff' : displayBg;
      if (inRange(c)) {
        tick(c, lt);
        if (ax.grids.label && k !== 0 && !isLast) grid(c, false);
        if (ax.shown && withText && !onlyGrid && time) {
          const [tl, dl] = timeLabel(v);
          const top = oy + ya + Math.trunc(1.2 * lt);
          texts.push(
            <g key={`${a}${k}`}>
              <ScaleText
                font={font}
                text={tl}
                at={ox + c}
                top={top}
                align="center"
                fill={tf}
                bg={tb}
              />
              <ScaleText
                font={font}
                text={dl}
                at={ox + c}
                top={top + fh}
                align="center"
                fill={tf}
                bg={tb}
              />
            </g>
          );
        } else if (ax.shown && withText && !onlyGrid) {
          const text = tickText(neg ? -v : v, inc);
          texts.push(
            a === 'x' ? (
              <ScaleText
                key={`${a}${k}`}
                font={font}
                text={text}
                at={ox + c}
                top={oy + ya + Math.trunc(1.2 * lt)}
                align="center"
                fill={tf}
                bg={tb}
              />
            ) : (
              <ScaleText
                key={`${a}${k}`}
                font={font}
                text={text}
                at={ox + X - Math.trunc(1.2 * lt)}
                top={oy + c - Math.trunc(0.5 * fh)}
                align="end"
                fill={tf}
                bg={tb}
              />
            )
          );
        }
        if (ax.shown) lastLabel = v;
      }
      if (majors > 0) {
        const step = inc / majors;
        let mv = v;
        for (let j = 0; j < majors; j++) {
          if (j > 0) {
            const mc = at(mv);
            if (inRange(mc)) {
              tick(mc, mt);
              if (ax.grids.major) grid(mc, false);
            }
          }
          if (minors > 0) {
            const ms = step / minors;
            let nv = mv;
            for (let q = 1; q < minors; q++) {
              nv += ms;
              const nc = at(nv);
              if (inRange(nc)) {
                tick(nc, mn);
                if (ax.grids.minor) grid(nc, true);
              }
            }
          }
          mv += step;
        }
      }
    });
    // Y redraws the last label's grid line without skipping the first label.
    if (a === 'y' && ax.grids.label) {
      const c = at(lastLabel);
      if (inRange(c)) grid(c, false);
    }
  };
  drawAxis('y', true);
  drawAxis('x', true);
  // A vector update redraws the scales of axes with grids (X, then Y).
  if (anyVector) {
    const gx = axes.x.grids;
    const gy = axes.y.grids;
    if (gx.label || gx.major || gx.minor) drawAxis('x', true, false);
    if (gy.label || gy.major || gy.minor) drawAxis('y', true, false);
  }

  // Traces (data -> pixels, relative to the widget).
  const fx = W / (axes.x.cur[1] - axes.x.cur[0]);
  const pxOf = (xv: number) =>
    Math.max(-16000, Math.min(16000, rint((xv - axes.x.cur[0]) * fx + X)));
  const traceNodes = visible.map((t) => {
    const yax = t.y2 ? axes.y2 : axes.y;
    const fy = H / (yax.cur[1] - yax.cur[0]);
    const pyOf = (yv: number) =>
      Math.max(-16000, Math.min(16000, H - rint((yv - yax.cur[0]) * fy - Y)));
    const yZero = pyOf(0);
    const raw = (tracePts.get(t.i) ?? []).filter(
      ([a2, b2]) => !Number.isNaN(a2) && !Number.isNaN(b2)
    );
    let pts: Pt[] = raw.map(([xv, yv]) => [pxOf(xv), pyOf(yv)]);
    if (t.plotMode) {
      const cols = new Map<
        number,
        { first: Pt; last: Pt; firstX: number; lastX: number; min: number; max: number; n: number }
      >();
      raw.forEach(([xv], k) => {
        const [px, py] = pts[k];
        if (px < X || px > X + W) return;
        const c = cols.get(px);
        if (!c)
          cols.set(px, {
            first: [px, py],
            last: [px, py],
            firstX: xv,
            lastX: xv,
            min: py,
            max: py,
            n: 1,
          });
        else {
          if (xv < c.firstX) [c.first, c.firstX] = [[px, py], xv];
          if (xv >= c.lastX) [c.last, c.lastX] = [[px, py], xv];
          c.min = Math.min(c.min, py);
          c.max = Math.max(c.max, py);
          c.n++;
        }
      });
      pts = [...cols.keys()]
        .sort((a2, b2) => a2 - b2)
        .flatMap((px) => {
          const c = cols.get(px)!;
          if (c.n === 1) return [c.first];
          if (c.n === 2) return [c.first, c.last];
          return [c.first, [px, c.max] as Pt, [px, c.min] as Pt, c.last];
        });
    } else {
      pts = pts.filter((q, k) => k === 0 || q[0] !== pts[k - 1][0] || q[1] !== pts[k - 1][1]);
    }
    const color = t.color;
    const abs = (q: Pt): Pt => [ox + q[0], oy + q[1]];
    const s = 2 + t.thickness;
    const symbolNodes =
      t.symbol === 'none'
        ? []
        : pts.map((q, k) => {
            const [cx, cy] = abs(q);
            if (t.symbol === 'circle')
              return (
                <ellipse
                  key={`s${k}`}
                  cx={cx + 0.5}
                  cy={cy + 0.5}
                  rx={s}
                  ry={s}
                  fill="none"
                  stroke={color}
                  strokeWidth={1}
                />
              );
            if (t.symbol === 'square')
              return (
                <XRectOutline
                  key={`s${k}`}
                  x={cx - s}
                  y={cy - s}
                  w={2 * s}
                  h={2 * s}
                  lineWidth={1}
                  color={color}
                />
              );
            const d = Math.trunc(1.4 * s);
            const seg = (a1: Pt, a2: Pt, kk: string) => (
              <polyline
                key={kk}
                points={[a1, a2].map(([u, v]) => `${u + X_PIXEL},${v + X_PIXEL}`).join(' ')}
                fill="none"
                stroke={color}
                strokeWidth={1}
              />
            );
            return (
              <g key={`s${k}`}>
                {seg([cx, cy + d], [cx + d, cy], 'a')}
                {seg([cx + d, cy], [cx, cy - d], 'b')}
                {seg([cx, cy - d], [cx - d, cy], 'c')}
                {seg([cx - d, cy], [cx, cy + d], 'd')}
              </g>
            );
          });
    let lineNode: ReactNode = null;
    if (t.style === 'line' || t.style === 'needle') {
      const path: Pt[] =
        t.style === 'needle'
          ? pts.flatMap(
              ([px, py]) =>
                [
                  [px, yZero],
                  [px, py],
                  [px, yZero],
                ] as Pt[]
            )
          : pts;
      if (path.length >= 2)
        lineNode = (
          <polyline
            points={path
              .map((q) => abs(q))
              .map(([u, v]) => `${u + X_PIXEL},${v + X_PIXEL}`)
              .join(' ')}
            fill="none"
            stroke={color}
            strokeWidth={t.thickness}
            strokeLinecap="butt"
            strokeLinejoin="miter"
            strokeMiterlimit={10.43}
            strokeDasharray={t.dash ? '4 4' : undefined}
          />
        );
    } else if (t.symbol === 'none') {
      lineNode = pts.map((q, k) => {
        const [u, v] = abs(q);
        return <rect key={k} x={u} y={v} width={1} height={1} fill={color} />;
      });
    }
    return (
      <g key={t.i}>
        {symbolNodes}
        {lineNode}
      </g>
    );
  });

  // Title and labels.
  const labels: ReactNode[] = [];
  if (title.trim())
    labels.push(
      <ScaleText
        key="t"
        font={font}
        text={title}
        at={ox + X + idiv(W, 2)}
        top={oy + idiv(fh, 2)}
        align="center"
        fill={fg}
      />
    );
  if (xLabel.trim())
    labels.push(
      <ScaleText
        key="xl"
        font={font}
        text={xLabel}
        at={ox + X + idiv(W, 2)}
        top={oy + h - idiv(3 * fh, 2)}
        align="center"
        fill={fg}
      />
    );
  if (show.y && yLabel.trim()) {
    let lY = Y + idiv(H + 2 * textWidth(font, yLabel), 2);
    [...yLabel].forEach((ch, k) => {
      labels.push(
        <g key={`yl${k}`} transform={`translate(${ox + fh},${oy + lY}) rotate(-90)`}>
          <ScaleText font={font} text={ch} at={0} top={-font.ascent} align="begin" fill={fg} />
        </g>
      );
      lY -= 2 * textWidth(font, ch);
    });
  }
  const pab: XLine[] = [];
  if (propBool(p, 'plotAreaBorder')) {
    pab.push([ox + X, oy + Y, ox + X + W, oy + Y, fg]);
    if (!show.x) pab.push([ox + X, oy + Y + H, ox + X + W, oy + Y + H, fg]);
    if (!show.y) pab.push([ox + X, oy + Y, ox + X, oy + Y + H, fg]);
    if (!show.y2) pab.push([ox + X + W, oy + Y, ox + X + W, oy + Y + H, fg]);
  }

  return (
    <SvgBox x={ox} y={oy} w={w + 1} h={h + 1} clip>
      <rect x={ox} y={oy} width={w + 1} height={h + 1} fill={displayBg} />
      <rect
        x={ox + X}
        y={oy + Y}
        width={Math.max(0, W + 1)}
        height={Math.max(0, H + 1)}
        fill={plotBg}
      />
      {b ? <XRectOutline x={ox} y={oy} w={w} h={h} lineWidth={1} color={fg} /> : null}
      <XLines lines={solid} />
      {dashed.map(([x1, y1, x2, y2, c], k) => (
        <line
          key={`d${k}`}
          x1={x1 + X_PIXEL}
          y1={y1 + X_PIXEL}
          x2={x2 + X_PIXEL}
          y2={y2 + X_PIXEL}
          stroke={c}
          strokeWidth={1}
          strokeDasharray="4 4"
        />
      ))}
      {texts}
      {labels}
      <svg
        x={ox + X + 1}
        y={oy + Y}
        width={Math.max(0, W - 2)}
        height={Math.max(0, H)}
        viewBox={`${ox + X + 1} ${oy + Y} ${Math.max(0, W - 2)} ${Math.max(0, H)}`}
        overflow="hidden"
      >
        {traceNodes}
      </svg>
      <XLines lines={pab} />
    </SvgBox>
  );
}
