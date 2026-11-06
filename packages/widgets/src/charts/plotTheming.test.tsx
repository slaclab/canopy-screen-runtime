// Plot chrome theming for XYPlot and WaveformPlot: light-dark() constants whose light
// arm is the ECharts 6.1.0 default, emphasis pinned to the series colour, SVG renderer,
// and role CSS strings passed through to the option untouched.
import type React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { WidgetRendererProps } from '../registry/WidgetRegistry.js';

vi.mock('@slaclab/canopy-react', () => ({
  usePV: () => ({ connected: false, value: undefined }),
}));

interface Captured {
  option: Record<string, unknown>;
  opts?: { renderer?: string };
}
const captured: Captured[] = [];
vi.mock('echarts-for-react', () => ({
  default: (p: Captured) => {
    captured.push({ option: p.option, opts: p.opts });
    return null;
  },
}));

const { buildXYOption, XYPlot } = await import('./XYPlot.js');
const { PLOT_COLORS } = await import('./plotTheme.js');
const { WaveformPlot } = await import('./WaveformPlot.js');
const XY = XYPlot as React.FC<WidgetRendererProps>;
const Wave = WaveformPlot as React.FC<WidgetRendererProps>;

afterEach(() => {
  cleanup();
  captured.length = 0;
});

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

// ECharts 6.1.0 defaults (echarts/lib/visual/tokens.js), the colours drawn today.
const ECHARTS_DEFAULT = {
  title: '#3c3c41', // tokens.color.primary (neutral80)
  axisLabel: '#54555a', // tokens.color.axisLabel (neutral70)
  legendText: '#54555a', // tokens.color.secondary (neutral70)
  axisLine: '#54555a', // tokens.color.axisLine (neutral70)
  splitLine: '#dbdee4', // tokens.color.axisSplitLine (neutral15)
};

function lightArm(value: string): string {
  const m = /^light-dark\(\s*([^,]+?)\s*,\s*([^)]+?)\s*\)$/.exec(value);
  if (!m) throw new Error(`not a light-dark() string: ${value}`);
  return m[1]!;
}

const base: WidgetRendererProps = {
  id: 'w-1',
  layout: { x: 0, y: 0, width: 200, height: 100 },
  props: {},
  isSelected: false,
} as WidgetRendererProps;

function lastOf(): Captured {
  const c = captured.at(-1);
  if (!c) throw new Error('ReactECharts never rendered');
  return c;
}

describe('PLOT_COLORS', () => {
  it('light arms equal the ECharts defaults rendered today', () => {
    expect(lightArm(PLOT_COLORS.title)).toBe(ECHARTS_DEFAULT.title);
    expect(lightArm(PLOT_COLORS.text)).toBe(ECHARTS_DEFAULT.axisLabel);
    expect(lightArm(PLOT_COLORS.text)).toBe(ECHARTS_DEFAULT.legendText);
    expect(lightArm(PLOT_COLORS.axisLine)).toBe(ECHARTS_DEFAULT.axisLine);
    expect(lightArm(PLOT_COLORS.splitLine)).toBe(ECHARTS_DEFAULT.splitLine);
  });

  it('dark arms are Carbon g100 values', () => {
    expect(PLOT_COLORS.title).toBe('light-dark(#3c3c41, #f4f4f4)');
    expect(PLOT_COLORS.text).toBe('light-dark(#54555a, #c6c6c6)');
    expect(PLOT_COLORS.axisLine).toBe('light-dark(#54555a, #6f6f6f)');
    expect(PLOT_COLORS.splitLine).toBe('light-dark(#dbdee4, #393939)');
  });
});

describe('XYPlot chrome', () => {
  const AXIS = { name: 'y', label: 'Y', autoRange: true, grid: true };
  const o = buildXYOption(
    {
      title: 'T',
      showLegend: true,
      xAxis: { label: 'X' },
      yAxes: [AXIS],
      curves: [{ y_channel: 'a' }],
    },
    {}
  ) as unknown as Obj;

  it('colours the title and legend', () => {
    expect(o.title.textStyle.color).toBe(PLOT_COLORS.title);
    expect(o.title.textStyle.fontSize).toBe(11);
    expect(o.legend.textStyle.color).toBe(PLOT_COLORS.text);
  });

  it('colours every axis: line, label, name and grid', () => {
    for (const axis of [o.xAxis, ...o.yAxis]) {
      expect(axis.axisLine.lineStyle.color).toBe(PLOT_COLORS.axisLine);
      expect(axis.axisLabel.color).toBe(PLOT_COLORS.text);
      expect(axis.nameTextStyle.color).toBe(PLOT_COLORS.text);
      expect(axis.splitLine.lineStyle.color).toBe(PLOT_COLORS.splitLine);
    }
    expect(o.yAxis[0].splitLine.show).toBe(true);
    expect(o.xAxis.axisLabel).toMatchObject({ showMinLabel: true, showMaxLabel: true });
  });

  it('pins emphasis colours to the series colour, for line and scatter', () => {
    const colours = ['#ff0000', 'var(--cr-3, #00ff00)', 'light-dark(#000000, #ffffff)'];
    const x = buildXYOption(
      {
        curves: [
          { y_channel: 'a', color: colours[0], traceType: 'line' },
          { y_channel: 'b', color: colours[1], traceType: 'scatter' },
          { y_channel: 'c', color: colours[2] },
        ],
      },
      {}
    ) as unknown as Obj;
    x.series.forEach((s: Obj, i: number) => {
      expect(s.color).toBe(colours[i]);
      expect(s.emphasis).toEqual({
        lineStyle: { color: colours[i] },
        itemStyle: { color: colours[i] },
      });
    });
  });

  it('passes var() and light-dark() strings through unchanged', () => {
    const x = buildXYOption(
      { curves: [{ y_channel: 'a', color: 'var(--cr-7, #123456)' }] },
      {}
    ) as unknown as Obj;
    expect(JSON.stringify(x)).toContain('var(--cr-7, #123456)');
    expect(JSON.stringify(x)).toContain(PLOT_COLORS.axisLine);
  });

  it('pins the SVG renderer and puts the option through unchanged', () => {
    render(<XY {...base} props={{ curves: [{ color: 'var(--cr-1, #abcdef)' }] }} />);
    const c = lastOf();
    expect(c.opts?.renderer).toBe('svg');
    expect((c.option as Obj).series[0].emphasis.itemStyle.color).toBe('var(--cr-1, #abcdef)');
  });
});

describe('WaveformPlot chrome', () => {
  const props = {
    title: '<b>Wave</b>',
    xLabels: ['t'],
    yAxes: [{ label: 'V' }],
    curves: [
      { y_channel: 'a', color: 'var(--cr-2, #112233)' },
      { y_channel: 'b', color: 'light-dark(#000000, #ffffff)' },
    ],
  };

  it('pins the SVG renderer', () => {
    render(<Wave {...base} props={props} />);
    expect(lastOf().opts?.renderer).toBe('svg');
  });

  it('colours title, axes and legend', () => {
    render(<Wave {...base} props={props} />);
    const o = lastOf().option as Obj;
    expect(o.title.textStyle).toEqual({ fontSize: 11, color: PLOT_COLORS.title });
    for (const axis of [o.xAxis, o.yAxis]) {
      expect(axis.axisLine.lineStyle.color).toBe(PLOT_COLORS.axisLine);
      expect(axis.axisLabel).toEqual({ fontSize: 9, color: PLOT_COLORS.text });
      expect(axis.nameTextStyle.color).toBe(PLOT_COLORS.text);
      expect(axis.splitLine.lineStyle.color).toBe(PLOT_COLORS.splitLine);
    }
    expect(o.legend.textStyle).toEqual({ fontSize: 9, color: PLOT_COLORS.text });
  });

  it('pins emphasis to the series colour and passes role strings through', () => {
    render(<Wave {...base} props={props} />);
    const o = lastOf().option as Obj;
    props.curves.forEach((c, i) => {
      const s = o.series[i];
      expect(s.lineStyle.color).toBe(c.color);
      expect(s.itemStyle.color).toBe(c.color);
      expect(s.emphasis).toEqual({ lineStyle: { color: c.color }, itemStyle: { color: c.color } });
    });
  });
});
