// `fox://<name>` widget channels end-to-end through the renderer: the
// screen's formulas (with its effective macros) are subscribed through the
// ambient FormulaSubscriber and the result feeds the widget like a PV value;
// embedded screens evaluate their OWN formulas; mock mode (no Fox) and
// unresolvable names degrade to the disconnected placeholder.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { LocalPVService, MockPVService, RoutedPVService } from '@slaclab/canopy-client';
import type { PVService } from '@slaclab/canopy-client';
import { PVServiceProvider } from '@slaclab/canopy-react';
import { registerBuiltinWidgets } from '@slaclab/canopy-screen-widgets';
import type { FormulaDeclaration, ScreenJSON, WidgetNode } from '@slaclab/canopy-screen-ir';
import type { FormulaSpec, FormulaSubscribeOptions, FormulaSubscriber } from '../formula.js';
import { FormulaSubscriberContext } from '../formula.js';
import { createLocalAwareFormulaSubscriber } from '../rules/localFormula.js';
import { ScreenRenderer } from './ScreenRenderer.js';

class StubSubscriber implements FormulaSubscriber {
  readonly subscriptions: { spec: FormulaSpec; options: FormulaSubscribeOptions }[] = [];

  subscribe(spec: FormulaSpec, options: FormulaSubscribeOptions): () => void {
    this.subscriptions.push({ spec, options });
    return () => {};
  }

  push(bindingFragment: string, value: number): void {
    const hit = this.subscriptions.find((s) =>
      Object.values(s.spec.bindings).some((b) => b.includes(bindingFragment))
    );
    if (!hit) throw new Error(`no formula subscription bound to '${bindingFragment}'`);
    act(() => hit.options.onResult(value, { severity: 'NO_ALARM' }));
  }
}

function label(id: string, pv: string, y = 10): WidgetNode {
  return {
    id,
    type: 'pv-label',
    props: { pv },
    geometry: { x: 10, y, width: 120, height: 20 },
  };
}

function screenDoc(
  id: string,
  formulas: FormulaDeclaration[],
  children: WidgetNode[],
  macroDefault?: Record<string, string>
): ScreenJSON {
  return {
    schemaVersion: '1.0',
    kind: 'screen',
    id,
    metadata: { title: id, source: { type: 'hand-authored' }, size: { width: 400, height: 300 } },
    macros: Object.entries(macroDefault ?? {}).map(([name, value]) => ({ name, default: value })),
    formulas,
    root: {
      id: `${id}-root`,
      type: 'absolute-canvas',
      props: {},
      geometry: { x: 0, y: 0, width: 400, height: 300 },
      children,
    },
  };
}

// The rvc300-fee shape: EDM `CALC\{100*(A-B)/A}($(DEV):X, $(DEV):Y)`.
const PCT: FormulaDeclaration = {
  name: 'f-001',
  kind: 'scalar',
  expression: '100*(A-B)/A',
  bindings: { A: '${DEV}:GetActualValueRaw', B: '${DEV}:GetPressSetpointRaw' },
};

let pv: MockPVService;
let stub: StubSubscriber;
let warn: MockInstance<(...args: unknown[]) => void>;

beforeAll(() => {
  registerBuiltinWidgets();
});

beforeEach(() => {
  pv = new MockPVService();
  pv.connect();
  stub = new StubSubscriber();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  pv.disconnect();
  warn.mockRestore();
});

function withServices(
  children: ReactNode,
  service: PVService = pv,
  subscriber: FormulaSubscriber | null = stub
) {
  return (
    <PVServiceProvider service={service}>
      <FormulaSubscriberContext.Provider value={subscriber}>
        {children}
      </FormulaSubscriberContext.Provider>
    </PVServiceProvider>
  );
}

// Disconnection is asserted through carbon mode's '---' placeholder (edm mode
// draws EDM's empty outlined box instead; see renderMode.test.tsx).
describe('fox:// widget channels', () => {
  it('evaluates the screen formula with caller macros and shows the result', () => {
    const doc = screenDoc('pct', [PCT], [label('w-040', 'fox://f-001')], { DEV: 'UNSET' });
    render(
      withServices(
        <ScreenRenderer screen={doc} macros={{ DEV: 'DEMO:VAC:GAUGE1' }} renderMode="carbon" />
      )
    );

    expect(screen.getByText('---')).toBeTruthy();
    expect(stub.subscriptions.map((s) => s.spec)).toEqual([
      {
        kind: 'scalar',
        expression: '100*({A}-{B})/{A}',
        bindings: {
          A: 'DEMO:VAC:GAUGE1:GetActualValueRaw',
          B: 'DEMO:VAC:GAUGE1:GetPressSetpointRaw',
        },
      },
    ]);

    stub.push('GetActualValueRaw', (100 * (1.731 - 1.759)) / 1.731);
    expect(screen.getByText('-1.61756')).toBeTruthy();
    expect(screen.queryByText('---')).toBeNull();
  });

  it("formats with the label's authored precision (formula channels carry none)", () => {
    const doc = screenDoc(
      'pct',
      [PCT],
      [
        {
          id: 'w-040',
          type: 'pv-label',
          props: { pv: 'fox://f-001', precision: 3, showUnits: true },
          geometry: { x: 192, y: 172, width: 88, height: 28 },
        },
      ],
      { DEV: 'DEMO:VAC:GAUGE1' }
    );
    render(withServices(<ScreenRenderer screen={doc} />));
    stub.push('GetActualValueRaw', (100 * (1.731 - 1.759)) / 1.731);
    expect(screen.getByText('-1.618')).toBeTruthy();
  });

  it('shares one subscription between widgets reading the same formula', () => {
    const doc = screenDoc(
      'pct',
      [PCT],
      [label('a', 'fox://f-001', 10), label('b', 'fox://f-001', 40)],
      { DEV: 'D' }
    );
    render(withServices(<ScreenRenderer screen={doc} />));
    expect(stub.subscriptions).toHaveLength(1);
    stub.push('D:GetActualValueRaw', 12);
    expect(screen.getAllByText('12')).toHaveLength(2);
  });

  it('embedded screens evaluate their own formulas with their own macros', async () => {
    const child = screenDoc(
      'child',
      [{ name: 'f-001', expression: 'A * 2', bindings: { A: '${P}:CHILD' } }],
      [label('c-lbl', 'fox://f-001')]
    );
    const host = screenDoc(
      'host',
      [{ name: 'f-001', expression: 'A + 1', bindings: { A: '${P}:HOST' } }],
      [
        label('h-lbl', 'fox://f-001'),
        {
          id: 'h-embed',
          type: 'embedded-display',
          props: { file: 'child.screen.json', macros: { P: '${P}:SUB' } },
          geometry: { x: 10, y: 100, width: 300, height: 150 },
        },
      ],
      { P: 'TOP' }
    );
    const resolveScreen = vi.fn().mockResolvedValue(child);
    render(withServices(<ScreenRenderer screen={host} resolveScreen={resolveScreen} />));
    await screen.findByTestId('embedded-screen');

    expect(stub.subscriptions.map((s) => s.spec)).toEqual(
      expect.arrayContaining([
        { kind: 'scalar', expression: '{A} + 1', bindings: { A: 'TOP:HOST' } },
        { kind: 'scalar', expression: '{A} * 2', bindings: { A: 'TOP:SUB:CHILD' } },
      ])
    );
    expect(stub.subscriptions).toHaveLength(2);

    stub.push('TOP:HOST', 101);
    stub.push('TOP:SUB:CHILD', 202);
    expect(screen.getByText('101')).toBeTruthy();
    expect(screen.getByText('202')).toBeTruthy();
  });

  it('plain PV channels still read the page PV service', () => {
    const doc = screenDoc('mixed', [PCT], [label('pv', 'DEV:PRESSURE')], { DEV: 'D' });
    const subscribe = vi.spyOn(pv, 'subscribe');
    render(withServices(<ScreenRenderer screen={doc} />));
    expect(subscribe).toHaveBeenCalledWith('DEV:PRESSURE', expect.any(Function));
    expect(stub.subscriptions).toHaveLength(0);
  });

  it('unknown formula names render disconnected with a warning (no crash)', () => {
    const doc = screenDoc('bad', [PCT], [label('w', 'fox://missing')], { DEV: 'D' });
    render(withServices(<ScreenRenderer screen={doc} renderMode="carbon" />));
    expect(screen.getByText('---')).toBeTruthy();
    expect(screen.queryByTestId('widget-error')).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("'missing'"));
  });

  it('mock mode (no Fox): gateway formulas stay disconnected, loc:// formulas evaluate locally', () => {
    const locals = new LocalPVService();
    locals.connect();
    const page = new RoutedPVService({ 'loc://': locals }, pv);
    const mockSubscriber = createLocalAwareFormulaSubscriber(locals, null);
    const doc = screenDoc(
      'mock',
      [
        PCT,
        {
          name: 'sum',
          expression: 'A + B',
          bindings: { A: 'loc://a?type=int&init=2', B: 'loc://b?type=int&init=3' },
        },
      ],
      [label('pct', 'fox://f-001', 10), label('sum', 'fox://sum', 40)],
      { DEV: 'D' }
    );
    render(withServices(<ScreenRenderer screen={doc} renderMode="carbon" />, page, mockSubscriber));

    expect(screen.getByText('---')).toBeTruthy();
    expect(screen.getByText('5')).toBeTruthy();
    expect(screen.queryByTestId('widget-error')).toBeNull();
  });
});
