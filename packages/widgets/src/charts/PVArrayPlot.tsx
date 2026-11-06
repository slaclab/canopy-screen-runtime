// ECharts bar or line plot of scalar PVs gathered into arrays: each curve lists
// one channel per sample (`y_channels`), so a BPM row or a magnet family plots
// as one series. A disconnected, missing or non-numeric channel is a gap
// (`null`), never a stale or zero value. The root element carries the values as
// drawn in `data-plot-values`, the hook a headless walk samples.

import type { ComponentType, CSSProperties } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
// echarts-for-react is CJS; under NodeNext + verbatimModuleSyntax its default
// import isn't typed as a callable component, so resolve it at runtime below.
import * as EChartsReactModule from 'echarts-for-react';
import { usePV } from '@slaclab/canopy-react';
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
import { PLOT_COLORS, emphasisFor, themedAxisParts } from './plotTheme.js';

interface ArrayCurveConfig {
  name?: string;
  color?: string;
  y_channels?: unknown;
}

interface AxisConfig {
  name?: string;
  label?: string;
}

function asCurves(value: unknown): ArrayCurveConfig[] {
  if (!Array.isArray(value)) return [];
  return value.filter((c): c is ArrayCurveConfig => typeof c === 'object' && c !== null);
}

function asAxes(value: unknown): AxisConfig[] {
  if (!Array.isArray(value)) return [];
  return value.filter((a): a is AxisConfig => typeof a === 'object' && a !== null);
}

/** A curve's channel list; a non-string or empty entry keeps its slot as a gap. */
function channelsOf(curve: ArrayCurveConfig): (string | undefined)[] {
  if (!Array.isArray(curve.y_channels)) return [];
  return curve.y_channels.map((ch) => (typeof ch === 'string' && ch !== '' ? ch : undefined));
}

/** The display name of a curve, also its key in `data-plot-values`. */
export function arrayCurveName(curve: ArrayCurveConfig, index: number): string {
  return curve.name || `Curve ${index + 1}`;
}

/** One sample from a PV value: a finite number or numeric string, else a gap. */
export function toScalarSample(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// PyDM-style titles are sometimes HTML; ECharts wants plain text.
function stripHtml(value: string): string {
  return value.replace(/<[^>]*>/g, '').trim();
}

interface SampleSubscriberProps {
  slot: string;
  channel: string | undefined;
  onSample: (slot: string, value: number | null) => void;
}

// One stable component per channel (not usePV in a loop) so the hook count is
// constant across renders. The connection state decides a gap: the client
// keeps a disconnected PV's last kind with an empty value (a scalar reads 0),
// so the value alone cannot tell a real 0 from a dead channel.
function SampleSubscriber({ slot, channel, onSample }: SampleSubscriberProps): null {
  const pv = usePV(channel);
  const sample = channel !== undefined && pv.connected ? toScalarSample(pv.value) : null;
  useEffect(() => {
    onSample(slot, sample);
  }, [slot, sample, onSample]);
  return null;
}

export function PVArrayPlot({ layout, props }: WidgetRendererProps) {
  const rawCurves = props.curves;
  const rawYAxes = props.yAxes;
  const rawXLabels = props.xLabels;
  const title = typeof props.title === 'string' ? props.title : undefined;
  const mode = props.mode === 'bar' ? 'bar' : 'line';
  const scale = typeof props.scale === 'number' && Number.isFinite(props.scale) ? props.scale : 1;

  const curves = useMemo(() => asCurves(rawCurves), [rawCurves]);
  const channels = useMemo(() => curves.map(channelsOf), [curves]);

  // Latest sample per slot `<curve>:<index>`; an absent slot is a gap.
  const [samples, setSamples] = useState<Record<string, number | null>>({});
  const handleSample = useCallback((slot: string, value: number | null) => {
    setSamples((prev) =>
      prev[slot] === value && slot in prev ? prev : { ...prev, [slot]: value }
    );
  }, []);

  // The values as drawn: scaled, one entry per channel slot, null for a gap.
  const drawn = useMemo(
    () =>
      channels.map((list, ci) =>
        list.map((ch, j) => {
          const v = ch === undefined ? null : (samples[`${ci}:${j}`] ?? null);
          return v === null ? null : v * scale;
        })
      ),
    [channels, samples, scale]
  );

  const plotValues = useMemo(() => {
    const out: Record<string, (number | null)[]> = {};
    curves.forEach((c, i) => {
      out[arrayCurveName(c, i)] = drawn[i] ?? [];
    });
    return JSON.stringify(out);
  }, [curves, drawn]);

  // Chart text does not inherit CSS: draw with the wrapper's own family, named
  // only once it has loaded so the option changes (and the chart redraws) then.
  const wrapperRef = useRef<HTMLDivElement>(null);
  const { fontFamily, ready } = useChartFont(wrapperRef);
  const chartFont = ready ? fontFamily : undefined;

  const option = useMemo(() => {
    const yAxes = asAxes(rawYAxes);
    const xLabels = Array.isArray(rawXLabels) ? rawXLabels : [];
    const xName = typeof xLabels[0] === 'string' ? xLabels[0] : '';
    const length = drawn.reduce((m, d) => Math.max(m, d.length), 0);
    const series = curves.map((c, i) => ({
      name: arrayCurveName(c, i),
      type: mode,
      data: drawn[i] ?? [],
      ...(mode === 'line' ? { showSymbol: true, symbolSize: 4, connectNulls: false } : {}),
      lineStyle: mode === 'line' ? { color: c.color, width: 1 } : undefined,
      itemStyle: { color: c.color },
      ...(emphasisFor(c.color) ? { emphasis: emphasisFor(c.color) } : {}),
    }));
    return {
      backgroundColor: 'transparent',
      animation: false,
      textStyle: { fontFamily: chartFont },
      title: title
        ? {
            text: stripHtml(title),
            left: 'center',
            textStyle: { fontSize: 11, color: PLOT_COLORS.title },
          }
        : undefined,
      grid: { left: 48, right: 16, top: title ? 32 : 16, bottom: 28 },
      tooltip: { trigger: 'axis' as const },
      xAxis: {
        type: 'category' as const,
        name: xName,
        data: Array.from({ length }, (_v, j) => String(j + 1)),
        ...themedAxisParts(),
        axisLabel: { fontSize: 9, color: PLOT_COLORS.text },
      },
      yAxis: {
        type: 'value' as const,
        name: yAxes[0]?.label ?? yAxes[0]?.name ?? '',
        ...themedAxisParts(),
        axisLabel: { fontSize: 9, color: PLOT_COLORS.text },
      },
      legend:
        series.length > 1
          ? { bottom: 0, textStyle: { fontSize: 9, color: PLOT_COLORS.text } }
          : undefined,
      series,
    };
  }, [curves, drawn, mode, rawYAxes, rawXLabels, title, chartFont]);

  return (
    <div
      ref={wrapperRef}
      data-plot-values={plotValues}
      style={{ width: layout.width, height: layout.height, overflow: 'hidden' }}
    >
      {channels.map((list, ci) =>
        list.map((ch, j) => (
          <SampleSubscriber
            key={`${ci}:${j}`}
            slot={`${ci}:${j}`}
            channel={ch}
            onSample={handleSample}
          />
        ))
      )}
      <ReactECharts
        option={option}
        style={{ width: '100%', height: '100%' }}
        opts={{ renderer: 'svg' }}
        notMerge
      />
    </div>
  );
}
