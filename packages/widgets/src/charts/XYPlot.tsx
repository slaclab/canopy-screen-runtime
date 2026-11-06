// ECharts XY plot (x/y channel pairs per curve) with PyDM-shaped curves and axes.

import type { ComponentType, CSSProperties } from 'react';
import { useCallback, useMemo, useRef, useState } from 'react';
import type { EChartsOption } from 'echarts';
// echarts-for-react is CJS; under NodeNext + verbatimModuleSyntax its default
// import isn't typed as a callable component, so resolve it at runtime below.
import * as EChartsReactModule from 'echarts-for-react';
import { useChartFont } from '@slaclab/canopy-shell';

interface EChartsProps {
  option: unknown;
  style?: CSSProperties;
  opts?: { renderer?: 'svg' | 'canvas' };
  notMerge?: boolean;
}
const _mod = EChartsReactModule as unknown as { default?: unknown };
const ReactECharts = (_mod.default ?? EChartsReactModule) as ComponentType<EChartsProps>;
import type { WidgetRendererProps } from '../registry/WidgetRegistry.js';
import { CurveSubscriber, dashFromLineStyle, toSamples, type CurveData } from './curveData.js';
import { PLOT_COLORS, emphasisFor, themedAxisParts } from './plotTheme.js';

interface XYCurve {
  x_channel?: string | null;
  y_channel?: string;
  name?: string;
  color?: string;
  symbol?: string | null;
  symbolSize?: number;
  traceType?: string;
  lineWidth?: number;
  lineStyle?: number;
  yAxisName?: string;
}

interface XYAxis {
  name?: string;
  label?: string;
  autoRange?: boolean;
  logMode?: boolean;
  minRange?: number;
  maxRange?: number;
  grid?: boolean;
  visible?: boolean;
}

/** Closed "x" polygon: scatter symbols are fill-only, so the cross is an outline shape. */
export const X_SYMBOL_PATH =
  'path://M-1,-0.7L-0.7,-1L0,-0.3L0.7,-1L1,-0.7L0.3,0L1,0.7L0.7,1L0,0.3L-0.7,1L-1,0.7L-0.3,0Z';

const SYMBOLS: Record<string, string> = {
  circle: 'circle',
  o: 'circle',
  square: 'square',
  s: 'square',
  diamond: 'diamond',
  d: 'diamond',
  triangle: 'triangle',
  t: 'triangle',
  x: X_SYMBOL_PATH,
};

/** Curve symbol name (Phoebus or PyDM) to an ECharts symbol; unknown names draw circles. */
function symbolFor(symbol: string | null | undefined): string {
  if (symbol === undefined || symbol === null || symbol === 'none') return 'none';
  return SYMBOLS[symbol] ?? 'circle';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asCurves(value: unknown): XYCurve[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isObject) as XYCurve[];
}

function asAxes(value: unknown): XYAxis[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isObject) as XYAxis[];
}

// Plot titles are sometimes HTML; ECharts wants plain text.
function stripHtml(value: string): string {
  return value.replace(/<[^>]*>/g, '').trim();
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** An [x, y] point when both are finite, else a gap in place. */
function pair(a: number | null | undefined, b: number | null | undefined): [number, number] | null {
  return isFiniteNumber(a) && isFiniteNumber(b) ? [a, b] : null;
}

/** One ECharts axis; `undefined` gives the autoscaling default axis. */
function axisOption(axis: XYAxis | undefined): Record<string, unknown> {
  const parts = themedAxisParts();
  const out: Record<string, unknown> = {
    type: axis?.logMode ? 'log' : 'value',
    ...parts,
    axisLabel: { ...parts.axisLabel, showMinLabel: true, showMaxLabel: true },
  };
  if (!axis) return out;
  if (!axis.autoRange && isFiniteNumber(axis.minRange) && isFiniteNumber(axis.maxRange)) {
    out.min = Math.min(axis.minRange, axis.maxRange);
    out.max = Math.max(axis.minRange, axis.maxRange);
    out.inverse = axis.minRange > axis.maxRange;
  }
  if (axis.visible === false) out.show = false;
  if (axis.label) out.name = axis.label;
  if (typeof axis.grid === 'boolean') out.splitLine = { ...parts.splitLine, show: axis.grid };
  return out;
}

function seriesData(curve: XYCurve, live: CurveData | undefined): ([number, number] | null)[] {
  const y = live?.y ?? [];
  const x = live?.x;
  if (curve.x_channel && x) {
    return y.slice(0, Math.min(x.length, y.length)).map((v, i) => pair(x[i], v));
  }
  return y.map((v, i) => pair(i, v));
}

/** Pure ECharts option for an `xy-plot` from its props and the sampled live data per curve. */
export function buildXYOption(
  props: Record<string, unknown>,
  live: Record<number, CurveData>
): EChartsOption {
  const curves = asCurves(props.curves);
  const yAxes = asAxes(props.yAxes);
  const xAxis = isObject(props.xAxis) ? (props.xAxis as XYAxis) : undefined;
  const title = typeof props.title === 'string' ? stripHtml(props.title) : '';

  const series = curves.map((c, i) => {
    const axisIndex = yAxes.findIndex((a) => a.name === c.yAxisName);
    const isLine = c.traceType === 'line' || (c.traceType === undefined && c.lineStyle !== 0);
    const s: Record<string, unknown> = {
      name: c.name || c.y_channel || `Curve ${i + 1}`,
      type: isLine ? 'line' : 'scatter',
      symbol: symbolFor(c.symbol),
      yAxisIndex: axisIndex >= 0 ? axisIndex : 0,
      data: seriesData(c, live[i]),
    };
    if (c.color) s.color = c.color;
    const emphasis = emphasisFor(c.color);
    if (emphasis) s.emphasis = emphasis;
    if (isFiniteNumber(c.symbolSize)) s.symbolSize = c.symbolSize;
    if (isLine) {
      s.lineStyle = { type: dashFromLineStyle(c.lineStyle), width: c.lineWidth ?? 1 };
      s.connectNulls = false;
    } else {
      s.itemStyle = { opacity: 1 };
    }
    return s;
  });

  const option: Record<string, unknown> = {
    backgroundColor: 'transparent',
    animation: false,
    grid: { left: 4, right: 8, top: title ? 28 : 8, bottom: 4, containLabel: true },
    xAxis: axisOption(xAxis),
    yAxis: yAxes.length > 0 ? yAxes.map((a) => axisOption(a)) : [axisOption(undefined)],
    series,
  };
  if (title) {
    option.title = {
      text: title,
      left: 'center',
      textStyle: { fontSize: 11, color: PLOT_COLORS.title },
    };
  }
  if (props.showLegend === true) {
    option.legend = {
      data: series.map((s) => s.name as string),
      textStyle: { color: PLOT_COLORS.text },
    };
  }
  return option as EChartsOption;
}

export function XYPlot({ layout, props }: WidgetRendererProps) {
  const rawCurves = props.curves;
  const curves = useMemo(() => asCurves(rawCurves), [rawCurves]);

  const [live, setLive] = useState<Record<number, CurveData>>({});
  const handleData = useCallback((index: number, data: CurveData) => {
    setLive((prev) => {
      const cur = prev[index];
      if (cur && cur.y === data.y && cur.x === data.x) return prev;
      return { ...prev, [index]: data };
    });
  }, []);

  // Chart text does not inherit CSS: draw with the wrapper's own family, named
  // only once it has loaded so the option changes (and the chart redraws) then.
  const wrapperRef = useRef<HTMLDivElement>(null);
  const { fontFamily, ready } = useChartFont(wrapperRef);
  const chartFont = ready ? fontFamily : undefined;

  const option = useMemo(
    () => ({ ...buildXYOption(props, live), textStyle: { fontFamily: chartFont } }),
    [props, live, chartFont]
  );

  return (
    <div
      ref={wrapperRef}
      style={{ width: layout.width, height: layout.height, overflow: 'hidden' }}
    >
      {curves.map((c, i) => (
        <CurveSubscriber
          key={i}
          index={i}
          yChannel={c.y_channel}
          xChannel={c.x_channel ?? undefined}
          onData={handleData}
          sample={toSamples}
        />
      ))}
      <ReactECharts
        option={option}
        opts={{ renderer: 'svg' }}
        notMerge
        style={{ width: '100%', height: '100%' }}
      />
    </div>
  );
}
