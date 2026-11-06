// Per-instance `formula://` channels: every rendered screen instance routes
// `formula://` names through its own formulas + macros, and gateway names to the
// ambient PVService, through a scope whose service identity is stable across re-renders.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MockPVService } from '@slaclab/canopy-client';
import { PVServiceProvider } from '@slaclab/canopy-react';
import { registerBuiltinWidgets } from '@slaclab/canopy-screen-widgets';
import type { FormulaDeclaration, ScreenJSON, WidgetNode } from '@slaclab/canopy-screen-ir';
import type { FormulaScalarValue, FormulaSpec, FormulaSubscribeOptions } from '../formula.js';
import { FormulaSubscriberContext } from '../formula.js';
import { ScreenRenderer } from './ScreenRenderer.js';

class StubSubscriber {
  readonly subscriptions: { spec: FormulaSpec; options: FormulaSubscribeOptions }[] = [];
  readonly unsubscribed: number[] = [];

  subscribe(spec: FormulaSpec, options: FormulaSubscribeOptions): () => void {
    const index = this.subscriptions.length;
    this.subscriptions.push({ spec, options });
    return () => this.unsubscribed.push(index);
  }

  /** Push a value to the live subscription whose input `{0}` is `channel`. */
  push(channel: string, value: FormulaScalarValue): void {
    const hits = this.subscriptions.filter(
      (s, i) => s.spec.bindings['0'] === channel && !this.unsubscribed.includes(i)
    );
    if (hits.length === 0) throw new Error(`no live subscription on ${channel}`);
    act(() => {
      for (const hit of hits) hit.options.onResult(value);
    });
  }
}

const OFF = 'rgb(82, 82, 82)';
const ON = 'rgb(36, 161, 72)';

const MEM_LOAD = {
  name: 'f-001',
  kind: 'scalar',
  expression: '{0} / {1} * 100',
  bindings: { '0': '${P}:MEM_MAX', '1': '${P}:MEM_FREE' },
} as FormulaDeclaration;

function led(id: string, pv: string, x = 0): WidgetNode {
  return {
    id,
    type: 'pv-led',
    props: { pv },
    geometry: { x, y: 0, width: 20, height: 20 },
  };
}

/** The `_host` shape: a MEM_LOAD formula over ${P} and an LED on formula://f-001. */
const hostChild: ScreenJSON = {
  schemaVersion: '1.0',
  kind: 'screen',
  id: '_host',
  metadata: { title: '_host', source: { type: 'hand-authored' }, size: { width: 100, height: 40 } },
  macros: [{ name: 'P', default: 'UNSET' }],
  formulas: [MEM_LOAD],
  root: {
    id: 'c-root',
    type: 'absolute-canvas',
    props: {},
    geometry: { x: 0, y: 0, width: 100, height: 40 },
    children: [led('c-led', 'formula://f-001')],
  },
} as ScreenJSON;

function embedNode(id: string, p: string, x: number): WidgetNode {
  return {
    id,
    type: 'embedded-display',
    props: { file: '_host.screen.json', macros: { P: p } },
    geometry: { x, y: 0, width: 100, height: 40 },
  };
}

/** Two instances of `_host` (P=A, P=B) plus a gateway LED on the top screen. */
const top: ScreenJSON = {
  schemaVersion: '1.0',
  kind: 'screen',
  id: 'top',
  metadata: { title: 'top', source: { type: 'hand-authored' }, size: { width: 300, height: 60 } },
  macros: [],
  root: {
    id: 't-root',
    type: 'absolute-canvas',
    props: {},
    geometry: { x: 0, y: 0, width: 300, height: 60 },
    children: [embedNode('t-a', 'A', 0), embedNode('t-b', 'B', 100), led('t-gw', 'GW:STAT', 250)],
  },
} as ScreenJSON;

let service: MockPVService;
let subscriber: StubSubscriber;
const resolveScreen = vi.fn(async () => hostChild);

beforeAll(() => {
  registerBuiltinWidgets();
});

beforeEach(() => {
  service = new MockPVService();
  service.connect();
  subscriber = new StubSubscriber();
});

afterEach(() => {
  cleanup();
  service.disconnect();
  vi.restoreAllMocks();
});

function wrap(children: ReactNode) {
  return (
    <PVServiceProvider service={service}>
      <FormulaSubscriberContext.Provider value={subscriber}>
        {children}
      </FormulaSubscriberContext.Provider>
    </PVServiceProvider>
  );
}

async function renderTop() {
  const utils = render(wrap(<ScreenRenderer screen={top} resolveScreen={resolveScreen} />));
  // An instance subscribes its formulas in an effect after it mounts, so the element alone does not imply the subscription.
  await waitFor(() => {
    expect(utils.getAllByTestId('embedded-screen')).toHaveLength(2);
    expect(subscriber.subscriptions).toHaveLength(2);
  });
  return utils;
}

function instanceLeds(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[data-testid="embedded-screen"]')].map(
    (el) => el.querySelector<HTMLElement>('.carbon-pv-led')!
  );
}

describe('per-instance formula:// routing', () => {
  it('subscribes each embedded instance against its own macros', async () => {
    await renderTop();
    const inputs = subscriber.subscriptions.map((s) => s.spec.bindings['0']).sort();
    expect(inputs).toEqual(['A:MEM_MAX', 'B:MEM_MAX']);
    expect(subscriber.subscriptions.map((s) => s.spec.bindings['1']).sort()).toEqual([
      'A:MEM_FREE',
      'B:MEM_FREE',
    ]);
  });

  it('flips each LED only on its own instance', async () => {
    const { container } = await renderTop();
    // Before a first result each LED has no state (no fill), never OFF.
    let [ledA, ledB] = instanceLeds(container);
    expect(ledA!.dataset.pvNostate).toBe('true');
    expect(ledB!.dataset.pvNostate).toBe('true');

    subscriber.push('A:MEM_MAX', 42);
    [ledA, ledB] = instanceLeds(container);
    expect(ledA!.style.backgroundColor).toBe(ON);
    expect(ledB!.dataset.pvNostate).toBe('true');

    subscriber.push('B:MEM_MAX', 7);
    subscriber.push('A:MEM_MAX', 0);
    [ledA, ledB] = instanceLeds(container);
    expect(ledA!.style.backgroundColor).toBe(OFF);
    expect(ledB!.style.backgroundColor).toBe(ON);
  });

  it('forwards non-formula names to the parent service and never formula names', async () => {
    const subscribe = vi.spyOn(service, 'subscribe');
    await renderTop();
    const names = subscribe.mock.calls.map((c) => c[0]);
    expect(names).toContain('GW:STAT');
    expect(names.some((n) => n.startsWith('formula://'))).toBe(false);
  });

  it('a parent re-render with unchanged inputs does not resubscribe', async () => {
    const unsubscribes: string[] = [];
    const subscribe = vi.spyOn(service, 'subscribe');
    subscribe.mockImplementation((name, listener) => {
      const off = MockPVService.prototype.subscribe.call(service, name, listener);
      return () => {
        unsubscribes.push(name);
        off();
      };
    });
    const { rerender } = await renderTop();
    const subscribesBefore = subscribe.mock.calls.length;
    const formulaBefore = subscriber.subscriptions.length;
    expect(subscribesBefore).toBeGreaterThan(0);

    rerender(wrap(<ScreenRenderer screen={top} resolveScreen={resolveScreen} />));
    rerender(wrap(<ScreenRenderer screen={top} resolveScreen={resolveScreen} />));

    expect(subscribe.mock.calls.length).toBe(subscribesBefore);
    expect(unsubscribes).toEqual([]);
    expect(subscriber.subscriptions.length).toBe(formulaBefore);
    expect(subscriber.unsubscribed).toEqual([]);
  });

  it('releases formula subscriptions on unmount', async () => {
    const { unmount } = await renderTop();
    unmount();
    expect(subscriber.unsubscribed.sort()).toEqual([0, 1]);
  });
});
