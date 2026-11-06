// buildXYOption: the pure props + live-data → ECharts option mapping behind XYPlot.
import { describe, expect, it, vi } from 'vitest';

vi.mock('@slaclab/canopy-react', () => ({
  usePV: () => ({ connected: false, value: undefined }),
}));

const { buildXYOption, X_SYMBOL_PATH } = await import('./XYPlot.js');

type Obj = Record<string, unknown>;
interface Opt {
  series: Obj[];
  xAxis: Obj;
  yAxis: Obj[];
  legend?: { data: string[] };
  grid: Obj;
  animation: unknown;
  backgroundColor: unknown;
}

function opt(props: Obj, live: Obj = {}): Opt {
  return buildXYOption(props, live as never) as unknown as Opt;
}

function series0(curve: Obj, live?: Obj): Obj {
  return opt({ curves: [curve] }, live ? { 0: live } : {}).series[0]!;
}

const AXIS = {
  name: 'x',
  label: '',
  autoRange: false,
  logMode: false,
  minRange: 0,
  maxRange: 5,
  grid: true,
  visible: true,
};

describe('buildXYOption axes', () => {
  it('normalises min/max and marks an inverted range', () => {
    const o = opt({ xAxis: { ...AXIS, minRange: 10, maxRange: -10 }, yAxes: [AXIS] });
    expect(o.xAxis).toMatchObject({ min: -10, max: 10, inverse: true, type: 'value' });
    expect(o.yAxis[0]).toMatchObject({ min: 0, max: 5, inverse: false });
  });

  it('autoRange drops the bounds', () => {
    const o = opt({ xAxis: { ...AXIS, autoRange: true }, yAxes: [] });
    expect(o.xAxis).not.toHaveProperty('min');
    expect(o.xAxis).not.toHaveProperty('max');
  });

  it('logMode gives a log axis', () => {
    expect(opt({ xAxis: { ...AXIS, logMode: true } }).xAxis.type).toBe('log');
  });

  it('maps visible, label and grid', () => {
    const o = opt({ xAxis: { ...AXIS, visible: false, label: 'pos', grid: false } });
    expect(o.xAxis).toMatchObject({ show: false, name: 'pos', splitLine: { show: false } });
    expect(opt({ xAxis: AXIS }).xAxis).toMatchObject({ splitLine: { show: true } });
  });

  it('falls back to one autoscaling axis for yAxes [] and a missing xAxis', () => {
    const o = opt({ yAxes: [] });
    expect(o.yAxis).toHaveLength(1);
    expect(o.yAxis[0]).not.toHaveProperty('min');
    expect(o.xAxis).not.toHaveProperty('min');
    expect(o.xAxis.type).toBe('value');
  });

  it('shows the range-end labels on every axis', () => {
    const o = opt({ xAxis: AXIS, yAxes: [AXIS, { ...AXIS, name: 'y1' }] });
    for (const axis of [o.xAxis, ...o.yAxis]) {
      expect(axis.axisLabel).toMatchObject({ showMinLabel: true, showMaxLabel: true });
    }
    const f = opt({});
    for (const axis of [f.xAxis, ...f.yAxis]) {
      expect(axis.axisLabel).toMatchObject({ showMinLabel: true, showMaxLabel: true });
    }
  });

  it('clamps yAxisIndex to an existing axis', () => {
    const o = opt({
      yAxes: [
        { ...AXIS, name: 'y0' },
        { ...AXIS, name: 'y1' },
      ],
      curves: [
        { y_channel: 'A', yAxisName: 'y1' },
        { y_channel: 'B', yAxisName: 'nope' },
        { y_channel: 'C' },
      ],
    });
    expect(o.series.map((s) => s.yAxisIndex)).toEqual([1, 0, 0]);
    expect(opt({ yAxes: [], curves: [{ yAxisName: 'y1' }] }).series[0]!.yAxisIndex).toBe(0);
  });
});

describe('buildXYOption symbols', () => {
  it.each([
    ['circle', 'circle'],
    ['square', 'square'],
    ['diamond', 'diamond'],
    ['triangle', 'triangle'],
    ['o', 'circle'],
    ['s', 'square'],
    ['d', 'diamond'],
    ['t', 'triangle'],
    ['x', X_SYMBOL_PATH],
    ['+', 'circle'],
    ['star', 'circle'],
    ['p', 'circle'],
    ['h', 'circle'],
    ['bogus', 'circle'],
    ['none', 'none'],
  ])('%s → %s', (symbol, expected) => {
    expect(series0({ y_channel: 'Y', symbol }).symbol).toBe(expected);
  });

  it('pins the x polygon', () => {
    expect(X_SYMBOL_PATH).toBe(
      'path://M-1,-0.7L-0.7,-1L0,-0.3L0.7,-1L1,-0.7L0.3,0L1,0.7L0.7,1L0,0.3L-0.7,1L-1,0.7L-0.3,0Z'
    );
  });

  it('{symbol: null} is a line series with symbol none', () => {
    const s = series0({ y_channel: 'Y', symbol: null });
    expect(s.type).toBe('line');
    expect(s.symbol).toBe('none');
  });

  it('undefined symbol is none', () => {
    expect(series0({ y_channel: 'Y' }).symbol).toBe('none');
  });

  it("{traceType:'none', symbol:'none'} is a scatter with symbol none", () => {
    const s = series0({ y_channel: 'Y', traceType: 'none', symbol: 'none' });
    expect(s.type).toBe('scatter');
    expect(s.symbol).toBe('none');
  });

  it('never sets showSymbol', () => {
    expect(series0({ y_channel: 'Y', symbol: 'circle' })).not.toHaveProperty('showSymbol');
    expect(series0({ y_channel: 'Y', traceType: 'none' })).not.toHaveProperty('showSymbol');
  });
});

describe('buildXYOption line rule and colour', () => {
  it('a dashed line series with square symbols carries the colour at series level', () => {
    const s = series0({
      y_channel: 'Y',
      traceType: 'line',
      lineStyle: 2,
      symbol: 'square',
      color: '#00ff00',
      lineWidth: 3,
    });
    expect(s.type).toBe('line');
    expect(s.lineStyle).toEqual({ type: 'dashed', width: 3 });
    expect(s.symbol).toBe('square');
    expect(s.color).toBe('#00ff00');
    expect(s.connectNulls).toBe(false);
  });

  it('{lineStyle: 4} is a dash-dot array', () => {
    expect((series0({ y_channel: 'Y', lineStyle: 4 }).lineStyle as Obj).type).toEqual([8, 4, 2, 4]);
  });

  it('absent traceType with lineStyle 0 is a scatter series at full opacity', () => {
    const s = series0({ y_channel: 'Y', lineStyle: 0 });
    expect(s.type).toBe('scatter');
    expect(s.itemStyle).toEqual({ opacity: 1 });
    expect(s).not.toHaveProperty('lineStyle');
  });

  it('omits colour when the curve has none', () => {
    expect(series0({ y_channel: 'Y' })).not.toHaveProperty('color');
  });

  it('passes symbolSize through', () => {
    expect(series0({ y_channel: 'Y', symbol: 'circle', symbolSize: 7 }).symbolSize).toBe(7);
  });
});

describe('buildXYOption layout and legend', () => {
  it('sets the compact grid, transparent background and no animation', () => {
    const o = opt({});
    expect(o.grid).toEqual({ left: 4, right: 8, top: 8, bottom: 4, containLabel: true });
    expect(opt({ title: 'T' }).grid.top).toBe(28);
    expect(o.animation).toBe(false);
    expect(o.backgroundColor).toBe('transparent');
  });

  it('shows a legend only when showLegend is true', () => {
    const o = opt({ showLegend: true, curves: [{ name: 'a', y_channel: 'Y' }] });
    expect(o.legend!.data).toContain('a');
    expect(opt({})).not.toHaveProperty('legend');
    expect(opt({ showLegend: false, curves: [{ y_channel: 'Y' }] })).not.toHaveProperty('legend');
  });

  it('names a nameless curve after its y channel, else by index', () => {
    const o = opt({ curves: [{ name: '', y_channel: 'Y' }, {}] });
    expect(o.series[0]!.name).toBe('Y');
    expect(o.series[1]!.name).toBe('Curve 2');
  });
});

describe('buildXYOption data', () => {
  const XY = { x_channel: 'X', y_channel: 'Y' };

  it('plots y over the index while x has not arrived', () => {
    expect(series0(XY, { y: [0.3] }).data).toEqual([[0, 0.3]]);
  });

  it('pairs x with y', () => {
    expect(series0(XY, { y: [0.3], x: [0.2] }).data).toEqual([[0.2, 0.3]]);
  });

  it('truncates to the shorter array', () => {
    expect(series0(XY, { y: [1, 2, 3], x: [10, 20] }).data).toEqual([
      [10, 1],
      [20, 2],
    ]);
  });

  it('uses the index without an x channel', () => {
    expect(series0({ y_channel: 'Y' }, { y: [1, 2] }).data).toEqual([
      [0, 1],
      [1, 2],
    ]);
  });

  it('keeps a gap in place', () => {
    expect(series0(XY, { y: [1, null, 3], x: [10, 20, 30] }).data).toEqual([
      [10, 1],
      null,
      [30, 3],
    ]);
    expect(series0(XY, { y: [1, 2], x: [null, 20] }).data).toEqual([null, [20, 2]]);
  });

  it('is empty before any data', () => {
    expect(series0(XY).data).toEqual([]);
  });
});

describe('buildXYOption _bpm fixture', () => {
  const bpm = {
    title: '',
    curves: [
      {
        x_channel: '${BPM_X}',
        y_channel: '${BPM_Y}',
        name: '',
        color: '#ff0000',
        symbol: 'circle',
        symbolSize: 7,
        traceType: 'none',
        lineWidth: 1,
        lineStyle: 1,
        yAxisName: 'y0',
      },
    ],
    xAxis: {
      name: 'x',
      label: '',
      autoRange: false,
      logMode: false,
      minRange: 10,
      maxRange: -10,
      grid: true,
      visible: true,
    },
    yAxes: [
      {
        name: 'y0',
        label: '',
        autoRange: false,
        logMode: false,
        minRange: -10,
        maxRange: 10,
        grid: true,
        visible: true,
      },
    ],
    showLegend: false,
  };

  it('is a red opaque scatter on an inverted -10..10 x axis', () => {
    const o = opt(bpm, { 0: { y: [0.3], x: [0.2] } });
    expect(o.xAxis).toMatchObject({ min: -10, max: 10, inverse: true });
    expect(o.yAxis[0]).toMatchObject({ min: -10, max: 10, inverse: false });
    const s = o.series[0]!;
    expect(s.type).toBe('scatter');
    expect(s.color).toBe('#ff0000');
    expect(s.symbol).toBe('circle');
    expect(s.symbolSize).toBe(7);
    expect(s.itemStyle).toEqual({ opacity: 1 });
    expect(s).not.toHaveProperty('lineStyle');
    expect(s.data).toEqual([[0.2, 0.3]]);
    expect(o).not.toHaveProperty('legend');
  });
});
