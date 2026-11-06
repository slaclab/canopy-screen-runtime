// Chart text font: canvas and SVG chart text does not inherit CSS, so each chart
// hands ECharts the family its own wrapper computes, once that family has
// loaded. The option content changes exactly then, which is what makes
// echarts-for-react (it deep-compares options) redraw with the loaded face.
import type React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import type { WidgetRendererProps } from '../registry/WidgetRegistry.js';

vi.mock('@slaclab/canopy-react', () => ({
  usePV: () => ({ connected: false, value: undefined }),
}));

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const captured: Obj[] = [];
vi.mock('echarts-for-react', () => ({
  default: (p: { option: Obj }) => {
    captured.push(p.option);
    return null;
  },
}));

const { WaveformPlot } = await import('./WaveformPlot.js');
const { PVArrayPlot } = await import('./PVArrayPlot.js');
const { XYPlot } = await import('./XYPlot.js');

// The family the host page gives the wrapper. jsdom has no FontFaceSet, so the
// load is stubbed and settled by hand; the shell requests a family once per
// document, hence one family per case.
let style: HTMLStyleElement;
let settle: () => void;
let load: ReturnType<typeof vi.fn>;

function hostFont(family: string): void {
  style = document.createElement('style');
  style.textContent = `div { font-family: "${family}", sans-serif; }`;
  document.head.appendChild(style);
}

beforeEach(() => {
  load = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        settle = resolve;
      })
  );
  Object.defineProperty(document, 'fonts', { value: { load }, configurable: true });
});

afterEach(() => {
  cleanup();
  style?.remove();
  Reflect.deleteProperty(document, 'fonts');
  captured.length = 0;
});

function lastOption(): Obj {
  const o = captured.at(-1);
  if (!o) throw new Error('ReactECharts never rendered');
  return o;
}

async function fontLoaded(): Promise<void> {
  await act(async () => {
    settle();
    await Promise.resolve();
    await Promise.resolve();
  });
}

const CASES: [string, React.FC<WidgetRendererProps>, Record<string, unknown>][] = [
  [
    'WaveformPlot',
    WaveformPlot as React.FC<WidgetRendererProps>,
    { title: 'Wave', curves: [{ y_channel: 'a' }, { y_channel: 'b' }] },
  ],
  [
    'PVArrayPlot',
    PVArrayPlot as React.FC<WidgetRendererProps>,
    { title: 'Array', curves: [{ name: 'row', y_channels: ['a', 'b'] }] },
  ],
  [
    'XYPlot',
    XYPlot as React.FC<WidgetRendererProps>,
    { title: 'XY', curves: [{ x_channel: 'a', y_channel: 'b' }] },
  ],
];

describe('chart font', () => {
  it.each(CASES)(
    "%s draws with its wrapper's family once that family has loaded",
    async (name, Chart, props) => {
      const family = `Host ${name}`;
      hostFont(family);

      const { container } = render(
        <Chart
          {...({
            id: 'w-1',
            layout: { x: 0, y: 0, width: 300, height: 200 },
            props,
            isSelected: false,
          } as WidgetRendererProps)}
        />
      );
      const wrapper = container.firstElementChild as HTMLElement;
      const computed = getComputedStyle(wrapper).fontFamily;
      expect(computed).toContain(family);

      // Loading: the family was requested, and the chart names no font yet.
      expect(load).toHaveBeenCalledTimes(1);
      expect(load.mock.calls[0]![0]).toContain(family);
      const before = lastOption();
      expect(before.textStyle).toEqual({ fontFamily: undefined });

      await fontLoaded();

      const after = lastOption();
      expect(after.textStyle).toEqual({ fontFamily: computed });
      expect(after).not.toEqual(before);
      // The font is the only thing the load changed.
      expect({ ...after, textStyle: before.textStyle }).toEqual(before);
    }
  );
});
