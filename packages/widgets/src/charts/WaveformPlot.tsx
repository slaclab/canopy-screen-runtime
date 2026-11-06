// ECharts line plot of the configured curves, with live per-curve PV data.

import type { ComponentType, CSSProperties } from 'react';
import { useCallback, useMemo, useRef, useState } from 'react';
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
import { CurveSubscriber, dashFromLineStyle, type CurveData } from './curveData.js';
import { PLOT_COLORS, emphasisFor, themedAxisParts } from './plotTheme.js';

interface CurveConfig {
  y_channel?: string;
  x_channel?: string | null;
  name?: string;
  color?: string;
  lineStyle?: number;
  lineWidth?: number;
  yAxisName?: string;
}

interface AxisConfig {
  name?: string;
  label?: string;
  orientation?: string;
}

function asCurves(value: unknown): CurveConfig[] {
  if (!Array.isArray(value)) return [];
  return value.filter((c): c is CurveConfig => typeof c === 'object' && c !== null);
}

function asAxes(value: unknown): AxisConfig[] {
  if (!Array.isArray(value)) return [];
  return value.filter((a): a is AxisConfig => typeof a === 'object' && a !== null);
}

// PyDM plot titles are sometimes HTML; ECharts wants plain text.
function stripHtml(value: string): string {
  return value.replace(/<[^>]*>/g, '').trim();
}

export function WaveformPlot({ layout, props }: WidgetRendererProps) {
  const rawCurves = props.curves;
  const rawYAxes = props.yAxes;
  const title = props.title as string | undefined;
  const rawXLabels = props.xLabels;

  const curves = useMemo(() => asCurves(rawCurves), [rawCurves]);

  const [liveData, setLiveData] = useState<Record<number, CurveData>>({});
  const handleData = useCallback((index: number, data: CurveData) => {
    setLiveData((prev) => {
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

  const option = useMemo(() => {
    const yAxes = asAxes(rawYAxes);
    const xLabels = Array.isArray(rawXLabels) ? (rawXLabels as string[]) : [];
    const series = curves.map((c, i) => {
      const live = liveData[i];
      const y = live?.y ?? [];
      const x = live?.x;
      // [x, y] pairs when an x waveform is present, else y indexed by sample.
      const data = x && x.length === y.length ? y.map((v, j) => [x[j], v]) : y;
      return {
        name: c.name || c.y_channel || `Curve ${i + 1}`,
        type: 'line' as const,
        showSymbol: false,
        data,
        lineStyle: {
          color: c.color,
          width: c.lineWidth ?? 1,
          type: dashFromLineStyle(c.lineStyle),
        },
        itemStyle: { color: c.color },
        ...(emphasisFor(c.color) ? { emphasis: emphasisFor(c.color) } : {}),
      };
    });

    const anyX = curves.some((_c, i) => Boolean(liveData[i]?.x?.length));
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
        type: (anyX ? 'value' : 'category') as 'value' | 'category',
        name: xLabels[0] ?? '',
        ...themedAxisParts(),
        axisLabel: { fontSize: 9, color: PLOT_COLORS.text },
      },
      yAxis: {
        type: 'value' as const,
        name: yAxes[0]?.label ?? '',
        ...themedAxisParts(),
        axisLabel: { fontSize: 9, color: PLOT_COLORS.text },
      },
      legend:
        series.length > 1
          ? { bottom: 0, textStyle: { fontSize: 9, color: PLOT_COLORS.text } }
          : undefined,
      series,
    };
  }, [curves, liveData, rawYAxes, title, rawXLabels, chartFont]);

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
        />
      ))}
      <ReactECharts
        option={option}
        style={{ width: '100%', height: '100%' }}
        opts={{ renderer: 'svg' }}
        notMerge
      />
    </div>
  );
}
