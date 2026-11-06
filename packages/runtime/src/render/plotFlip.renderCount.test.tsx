// A theme flip recolours an x-y plot whose series colours are roles without
// rendering the plot again: the role resolves to a `var(--cr-<i>, …)` string,
// and only the root's data-theme changes on a flip. The runtime resolves every
// widget through the registry, so a counting component registered as XYPlot
// sees each render the real plot would. A production bundle exposes no render
// count, which is why this lives here and not in the viewer's e2e spec.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { MockPVService } from '@slaclab/canopy-client';
import { PVServiceProvider } from '@slaclab/canopy-react';
import type { ScreenJSON } from '@slaclab/canopy-screen-ir';
import {
  registerBuiltinWidgets,
  widgetRegistry,
  type WidgetDefinition,
  type WidgetRendererProps,
} from '@slaclab/canopy-screen-widgets';
import { ScreenRenderer } from './ScreenRenderer.js';
import { setMode } from '../theme/modeStore.js';

const axis = (name: string) => ({
  name,
  label: '',
  autoRange: false,
  logMode: false,
  minRange: -10,
  maxRange: 10,
  grid: true,
  visible: true,
});

const curve = (n: number, role: string, traceType: string) => ({
  x_channel: `PLOT:X${n}`,
  y_channel: `PLOT:Y${n}`,
  name: '',
  color: { $role: role, fallback: '#000000', fallbackDark: '#000000' },
  symbol: 'circle',
  symbolSize: 7,
  traceType,
  lineWidth: 1,
  lineStyle: 1,
  yAxisName: 'y0',
});

const doc = {
  schemaVersion: '1.1',
  kind: 'screen',
  id: 'plot-flip',
  metadata: { title: 't', source: { type: 'hand-authored' }, size: { width: 200, height: 160 } },
  macros: [],
  root: {
    id: 'root',
    type: 'absolute-canvas',
    props: {},
    geometry: { x: 0, y: 0, width: 200, height: 160 },
    children: [
      {
        id: 'w-xy',
        type: 'xy-plot',
        geometry: { x: 0, y: 0, width: 200, height: 160 },
        props: {
          title: '',
          curves: [curve(1, 'OK', 'line'), curve(2, 'MAJOR', 'none')],
          xAxis: axis('x'),
          yAxes: [axis('y0')],
          showLegend: false,
        },
      },
    ],
  },
} as unknown as ScreenJSON;

let real: WidgetDefinition;
let renders = 0;
let lastCurves: unknown;
let service: MockPVService;

beforeAll(() => {
  registerBuiltinWidgets();
  real = widgetRegistry.get('XYPlot')!;
  expect(real).toBeDefined();
  const RealXYPlot = real.component;
  function CountingXYPlot(props: WidgetRendererProps) {
    renders += 1;
    lastCurves = props.props.curves;
    return <RealXYPlot {...props} />;
  }
  widgetRegistry.register({ ...real, component: CountingXYPlot });
});

afterAll(() => {
  widgetRegistry.register(real);
});

beforeEach(() => {
  renders = 0;
  lastCurves = undefined;
  setMode('light');
  service = new MockPVService();
  service.connect();
});

afterEach(() => {
  cleanup();
  service.disconnect();
  setMode('light');
});

function renderScreen() {
  return render(
    <PVServiceProvider service={service}>
      <ScreenRenderer screen={doc} />
    </PVServiceProvider>
  );
}

describe('x-y plot theme flip', () => {
  it('renders the plot on mount with role colours as CSS variables', () => {
    renderScreen();
    expect(renders).toBeGreaterThanOrEqual(1);
    const colours = (lastCurves as { color: unknown }[]).map((c) => c.color);
    expect(colours).toHaveLength(2);
    for (const colour of colours) {
      expect(colour).toMatch(/^var\(--cr-\d+, #[0-9a-f]{6,8}\)$/);
    }
  });

  it('re-renders the plot zero times across mode-store flips', () => {
    const root = renderScreen().getByTestId('screen-root');
    expect(renders).toBeGreaterThanOrEqual(1);
    const before = lastCurves;
    renders = 0;

    act(() => setMode('dark'));
    expect(root.dataset.theme).toBe('dark');
    act(() => setMode('light'));
    expect(root.dataset.theme).toBe('light');
    act(() => setMode('dark'));
    expect(root.dataset.theme).toBe('dark');

    expect(renders).toBe(0);
    expect(lastCurves).toBe(before);
  });

  it('counts through the registry: the probe is what the renderer resolves', () => {
    expect(widgetRegistry.get('XYPlot')!.component).not.toBe(real.component);
    renderScreen();
    expect(renders).toBeGreaterThanOrEqual(1);
  });
});
