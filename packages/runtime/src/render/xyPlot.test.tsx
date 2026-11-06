// XYPlot mounted through ScreenRenderer: DOM-only checks (subscriptions, SVG
// painter, no placeholder). Option-level checks live in XYPlot.test.ts —
// getInstanceByDom is unusable here (ESM vs CJS echarts instances).

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import type { PVData, PVListener, PVService } from '@slaclab/canopy-client';
import { DISCONNECTED_PV } from '@slaclab/canopy-client';
import { PVServiceProvider } from '@slaclab/canopy-react';
import { registerBuiltinWidgets } from '@slaclab/canopy-screen-widgets';
import type { ScreenJSON } from '@slaclab/canopy-screen-ir';
import { ScreenRenderer } from './ScreenRenderer.js';

beforeAll(() => registerBuiltinWidgets());
afterEach(() => cleanup());

/** A PVService serving a fixed scalar per PV name. */
class ScalarStubService implements PVService {
  readonly isConnected = true;
  subscribed: string[] = [];
  private values: Record<string, number>;
  constructor(values: Record<string, number>) {
    this.values = values;
  }
  private data(pvName: string): PVData {
    return { ...DISCONNECTED_PV, connected: true, value: this.values[pvName] ?? 0 };
  }
  subscribe(pvName: string, listener: PVListener): () => void {
    this.subscribed.push(pvName);
    listener(this.data(pvName));
    return () => {};
  }
  put(): void {}
  getSnapshot(pvName: string): PVData | undefined {
    return this.data(pvName);
  }
  connect(): void {}
  disconnect(): void {}
}

function screenWithXY(): ScreenJSON {
  return {
    schemaVersion: '1.0',
    kind: 'screen',
    id: 'xy',
    metadata: { title: 't', source: { type: 'hand-authored' }, size: { width: 140, height: 140 } },
    macros: [],
    root: {
      id: 'root',
      type: 'absolute-canvas',
      props: {},
      geometry: { x: 0, y: 0, width: 140, height: 140 },
      children: [
        {
          id: 'w-xy',
          type: 'xy-plot',
          geometry: { x: 0, y: 0, width: 140, height: 140 },
          props: {
            title: '',
            curves: [
              {
                x_channel: 'BPM:X',
                y_channel: 'BPM:Y',
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
          },
        },
      ],
    },
  } as ScreenJSON;
}

describe('XYPlot live data', () => {
  it('subscribes to both channels and paints with the SVG renderer', async () => {
    const service = new ScalarStubService({ 'BPM:X': 0.2, 'BPM:Y': 0.3 });
    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(
        <PVServiceProvider service={service}>
          <ScreenRenderer screen={screenWithXY()} />
        </PVServiceProvider>
      ));
    });

    expect(service.subscribed).toContain('BPM:X');
    expect(service.subscribed).toContain('BPM:Y');
    expect(container.querySelectorAll('[data-testid="widget-placeholder"]')).toHaveLength(0);
    expect(container.querySelectorAll('[data-testid="widget-error"]')).toHaveLength(0);
    expect(container.querySelector('svg')).not.toBeNull();
    expect(container.querySelector('canvas')).toBeNull();
  });
});
