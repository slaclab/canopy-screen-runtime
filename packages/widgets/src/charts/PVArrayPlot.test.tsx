// PVArrayPlot: one scalar channel per sample, gaps (null) for disconnected,
// missing or non-numeric channels, scale applied to the values drawn, and the
// drawn values published on the root's data-plot-values.
import type React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { WidgetRendererProps } from '../registry/WidgetRegistry.js';

// name -> PV state; an unknown name is a never-connected channel. A
// disconnected PV keeps a value of 0, as the client leaves it.
const pvs: Record<string, { connected: boolean; value: unknown }> = {};
vi.mock('@slaclab/canopy-react', () => ({
  usePV: (name: string | undefined) =>
    (name !== undefined && pvs[name]) || { connected: false, value: undefined },
}));

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const captured: Obj[] = [];
vi.mock('echarts-for-react', () => ({
  default: (p: { option: Obj }) => {
    captured.push(p.option);
    return null;
  },
}));

const { PVArrayPlot, toScalarSample } = await import('./PVArrayPlot.js');
const Plot = PVArrayPlot as React.FC<WidgetRendererProps>;

function renderPlot(props: Record<string, unknown>) {
  return render(
    <Plot
      {...({
        id: 'w-1',
        layout: { x: 0, y: 0, width: 300, height: 200 },
        props,
        isSelected: false,
      } as WidgetRendererProps)}
    />
  );
}

function plotValues(container: HTMLElement): Record<string, (number | null)[]> {
  const root = container.querySelector('[data-plot-values]');
  if (!root) throw new Error('no data-plot-values root');
  return JSON.parse(root.getAttribute('data-plot-values')!);
}

function lastOption(): Obj {
  const o = captured.at(-1);
  if (!o) throw new Error('ReactECharts never rendered');
  return o;
}

afterEach(() => {
  cleanup();
  captured.length = 0;
  for (const k of Object.keys(pvs)) delete pvs[k];
});

describe('PVArrayPlot', () => {
  it('draws bars with a null gap for a disconnected channel (its value 0 is not drawn)', () => {
    pvs['BPM:1:X'] = { connected: true, value: 1.5e-6 };
    pvs['BPM:2:X'] = { connected: false, value: 0 };
    pvs['BPM:3:X'] = { connected: true, value: -2e-6 };
    const { container } = renderPlot({
      title: 'Orbit X',
      mode: 'bar',
      scale: 1e6,
      yAxes: [{ label: 'µm' }],
      curves: [{ name: 'X', color: '#1f77b4', y_channels: ['BPM:1:X', 'BPM:2:X', 'BPM:3:X'] }],
    });
    const values = plotValues(container).X!;
    expect(values).toHaveLength(3);
    expect(values[0]).toBeCloseTo(1.5);
    expect(values[1]).toBeNull();
    expect(values[2]).toBeCloseTo(-2);

    const option = lastOption();
    expect(option.series).toHaveLength(1);
    expect(option.series[0].type).toBe('bar');
    expect(option.series[0].data).toEqual(values);
    expect(option.series[0].itemStyle.color).toBe('#1f77b4');
    expect(option.xAxis.type).toBe('category');
    expect(option.xAxis.data).toEqual(['1', '2', '3']);
    expect(option.yAxis.name).toBe('µm');
    expect(option.title.text).toBe('Orbit X');
  });

  it('draws lines with gaps not bridged, one series per curve, legend when more than one', () => {
    pvs['A1'] = { connected: true, value: 1 };
    pvs['A2'] = { connected: true, value: 2 };
    pvs['B1'] = { connected: true, value: 3 };
    const { container } = renderPlot({
      mode: 'line',
      curves: [
        { name: 'A', y_channels: ['A1', 'A2'] },
        { name: 'B', y_channels: ['B1', 'B-DEAD'] },
      ],
    });
    expect(plotValues(container)).toEqual({ A: [1, 2], B: [3, null] });
    const option = lastOption();
    expect(option.series.map((s: Obj) => s.type)).toEqual(['line', 'line']);
    expect(option.series[1].connectNulls).toBe(false);
    expect(option.legend).toBeDefined();
    expect(option.title).toBeUndefined();
  });

  it('keeps a slot as a gap for a missing, empty or non-string channel entry', () => {
    pvs['C1'] = { connected: true, value: 4 };
    const { container } = renderPlot({
      mode: 'bar',
      curves: [{ name: 'C', y_channels: ['C1', '', 7, null] }],
    });
    expect(plotValues(container)).toEqual({ C: [4, null, null, null] });
  });

  it('is a gap for a connected but non-numeric value; numeric strings count', () => {
    pvs['S1'] = { connected: true, value: 'n/a' };
    pvs['S2'] = { connected: true, value: '2.5' };
    pvs['S3'] = { connected: true, value: Number.NaN };
    const { container } = renderPlot({
      mode: 'bar',
      curves: [{ name: 'S', y_channels: ['S1', 'S2', 'S3'] }],
    });
    expect(plotValues(container)).toEqual({ S: [null, 2.5, null] });
  });

  it('draws a real 0 from a connected channel', () => {
    pvs['Z'] = { connected: true, value: 0 };
    const { container } = renderPlot({ mode: 'bar', curves: [{ name: 'Z', y_channels: ['Z'] }] });
    expect(plotValues(container)).toEqual({ Z: [0] });
  });

  it('names an unnamed curve by position, defaults to line mode and scale 1', () => {
    pvs['P'] = { connected: true, value: 5 };
    const { container } = renderPlot({ curves: [{ y_channels: ['P'] }], scale: 'big' });
    expect(plotValues(container)).toEqual({ 'Curve 1': [5] });
    expect(lastOption().series[0].type).toBe('line');
  });

  it('takes the x axis name from xLabels[0] and sizes categories to the longest curve', () => {
    const { container } = renderPlot({
      mode: 'bar',
      xLabels: ['BPM'],
      curves: [
        { name: 'A', y_channels: ['a'] },
        { name: 'B', y_channels: ['b1', 'b2', 'b3'] },
      ],
    });
    expect(plotValues(container)).toEqual({ A: [null], B: [null, null, null] });
    expect(lastOption().xAxis.name).toBe('BPM');
    expect(lastOption().xAxis.data).toEqual(['1', '2', '3']);
  });

  it('renders an empty plot for absent or malformed curves', () => {
    const { container } = renderPlot({ curves: 'nope' });
    expect(plotValues(container)).toEqual({});
    expect(lastOption().series).toEqual([]);
  });
});

describe('toScalarSample', () => {
  it.each([
    [3, 3],
    [-0.5, -0.5],
    ['1e-3', 0.001],
    ['', null],
    ['  ', null],
    ['abc', null],
    [Number.POSITIVE_INFINITY, null],
    [[1, 2], null],
    [undefined, null],
    [null, null],
  ] as const)('%j -> %j', (input, expected) => {
    expect(toScalarSample(input)).toBe(expected);
  });
});
