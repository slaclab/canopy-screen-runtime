// Phase C acceptance: a fixture screen whose conditional AND formula-driven
// rules update their target props reactively from a scripted stub subscriber,
// with the compiled specs pinned at the subscription boundary. Ladder
// subscriptions deliver ARM INDEXES; the hook maps them back onto the raw
// arms and resolves color roles against the active scheme.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MockPVService } from '@slaclab/canopy-client';
import { PVServiceProvider } from '@slaclab/canopy-react';
import { registerBuiltinWidgets, widgetRegistry } from '@slaclab/canopy-screen-widgets';
import { canopyDefaultFlat } from '@slaclab/canopy-screen-ir';
import type {
  FlatScheme,
  PropertyValue,
  Rule,
  RuleValue,
  ScreenJSON,
  WidgetNode,
} from '@slaclab/canopy-screen-ir';
import type { FormulaScalarValue, FormulaSpec, FormulaSubscribeOptions } from '../formula.js';
import { FormulaSubscriberContext } from '../formula.js';
import { ScreenRenderer } from '../render/ScreenRenderer.js';
import { FormulaError } from '../formula.js';
import { useWidgetRules, useWidgetRulesState } from './useWidgetRules.js';

class StubSubscriber {
  readonly subscriptions: { spec: FormulaSpec; options: FormulaSubscribeOptions }[] = [];
  readonly unsubscribed: number[] = [];

  subscribe(spec: FormulaSpec, options: FormulaSubscribeOptions): () => void {
    const index = this.subscriptions.length;
    this.subscriptions.push({ spec, options });
    return () => this.unsubscribed.push(index);
  }

  bySpecExpression(fragment: string): { spec: FormulaSpec; options: FormulaSubscribeOptions } {
    const hit = this.subscriptions.find((s) => s.spec.expression.includes(fragment));
    if (!hit) {
      throw new Error(
        `no subscription matching '${fragment}' in: ${this.subscriptions
          .map((s) => s.spec.expression)
          .join(' | ')}`
      );
    }
    return hit;
  }

  push(fragment: string, value: FormulaScalarValue): void {
    act(() => {
      this.bySpecExpression(fragment).options.onResult(value);
    });
  }

  fail(fragment: string, error: Error): void {
    act(() => {
      this.bySpecExpression(fragment).options.onError?.(error);
    });
  }
}

// A hand-authored fixture with both rule arms:
//  - w-lbl (text-label 'RB'): conditional rule → foregroundColor
//  - w-lbl: formula-driven rule → width (geometry target)
//  - w-hide (text-label 'HIDEME'): conditional rule → visible
const FIXTURE: ScreenJSON = {
  schemaVersion: '1.0',
  kind: 'screen',
  id: 'rules-fixture',
  metadata: {
    title: 'rules',
    source: { type: 'hand-authored' },
    size: { width: 400, height: 200 },
  },
  macros: [{ name: 'P', default: 'DEV:7' }],
  formulas: [
    { name: 'wsum', kind: 'scalar', expression: 'A + B', bindings: { A: '${P}:W1', B: '${P}:W2' } },
  ],
  root: {
    id: 'root',
    type: 'absolute-canvas',
    props: {},
    geometry: { x: 0, y: 0, width: 400, height: 200 },
    children: [
      {
        id: 'w-lbl',
        type: 'text-label',
        props: { text: 'RB', foregroundColor: '#ffffff' },
        geometry: { x: 10, y: 10, width: 100, height: 20 },
        rules: [
          {
            id: 'r-color',
            name: 'color-by-sev',
            targetProperty: 'foregroundColor',
            default: '#ffffff',
            pvs: [{ name: '${P}:SEVR', trigger: true }],
            conditions: [{ expression: '{0} > 1', value: '#ff0000' }],
          },
          {
            id: 'r-width',
            name: 'width-tracks-formula',
            targetProperty: 'width',
            default: 100,
            formula: 'wsum',
          },
        ],
      },
      {
        id: 'w-hide',
        type: 'text-label',
        props: { text: 'HIDEME' },
        geometry: { x: 10, y: 50, width: 100, height: 20 },
        rules: [
          {
            id: 'r-vis',
            name: 'visible-when-on',
            targetProperty: 'visible',
            default: true,
            pvs: [{ name: '${P}:ON', trigger: true }],
            conditions: [{ expression: '{0} == 0', value: false }],
          },
        ],
      },
    ],
  },
};

const COLOR_LADDER = '0 if ({0} > 1) else (-1)';
const VIS_LADDER = '0 if ({0} == 0) else (-1)';

let service: MockPVService;
let stub: StubSubscriber;

beforeAll(() => {
  registerBuiltinWidgets();
  // pv-tank copies its IR props verbatim to the catalog type PVTank, which the
  // builtins leave unregistered: a probe that prints the props it receives.
  // Assertions on it read props, never element.style: jsdom drops `var()`
  // and `light-dark()` from inline styles.
  widgetRegistry.register({
    type: 'PVTank',
    label: 'Probe',
    category: 'indicator',
    icon: 'x',
    defaultLayout: { x: 0, y: 0, width: 10, height: 10 },
    defaultProps: {},
    component: ({ id, props }: { id: string; props: Record<string, unknown> }) => (
      <pre data-testid={`probe-${id}`}>{JSON.stringify(props)}</pre>
    ),
    propsSchema: [],
  });
});

beforeEach(() => {
  service = new MockPVService();
  service.connect();
  stub = new StubSubscriber();
});

afterEach(() => {
  cleanup();
  service.disconnect();
});

function tree(doc: ScreenJSON, colorScheme?: FlatScheme) {
  return (
    <PVServiceProvider service={service}>
      <FormulaSubscriberContext.Provider value={stub}>
        <ScreenRenderer screen={doc} colorScheme={colorScheme} />
      </FormulaSubscriberContext.Provider>
    </PVServiceProvider>
  );
}

function renderScreen(doc: ScreenJSON, colorScheme?: FlatScheme) {
  return render(tree(doc, colorScheme));
}

function renderFixture() {
  return renderScreen(FIXTURE);
}

function labelBox(text: string): HTMLElement {
  // StaticLabel: span (text) inside the styled label div.
  const el = screen.getByText(text).parentElement;
  if (!el) throw new Error(`no parent for label '${text}'`);
  return el;
}

function wrapperOf(text: string): HTMLElement {
  // styled label div → absolute position wrapper div.
  const el = labelBox(text).parentElement;
  if (!el) throw new Error(`no wrapper for label '${text}'`);
  return el;
}

/**
 * A probe-widget screen with one conditional foregroundColor rule whose arm
 * `i` fires on `{0} == i+1`; `extraRules` are appended to the same widget.
 */
function probeDoc(
  base: PropertyValue,
  arms: readonly RuleValue[],
  fallback: RuleValue,
  extraRules: NonNullable<WidgetNode['rules']> = [],
  extraProps: Record<string, PropertyValue> = {}
): ScreenJSON {
  const node: WidgetNode = {
    id: 'w',
    type: 'pv-tank',
    props: { foregroundColor: base, ...extraProps },
    geometry: { x: 0, y: 0, width: 100, height: 20 },
    rules: [
      {
        id: 'r1',
        name: 'color',
        targetProperty: 'foregroundColor',
        default: fallback,
        pvs: arms.length > 0 ? [{ name: 'DEV:SEVR', trigger: true }] : [],
        conditions: arms.map((value, i) => ({ expression: `{0} == ${i + 1}`, value })),
      },
      ...extraRules,
    ],
  };
  return {
    schemaVersion: '1.0',
    kind: 'screen',
    id: 'probe',
    metadata: { title: 't', source: { type: 'hand-authored' }, size: { width: 300, height: 100 } },
    macros: [],
    root: {
      id: 'root',
      type: 'absolute-canvas',
      props: {},
      geometry: { x: 0, y: 0, width: 300, height: 100 },
      children: [node],
    },
  };
}

function probeProps(): Record<string, unknown> {
  return JSON.parse(screen.getByTestId('probe-w').textContent ?? '{}') as Record<string, unknown>;
}

// Object-literal types (not the ColorRole interface) so one constant serves
// both as a base PropertyValue and as a RuleValue arm.
const OK = { $role: 'OK', fallback: '#00ff00' } as const;
const MAJOR = { $role: 'MAJOR', fallback: '#ff0000' } as const;
const okIndex = canopyDefaultFlat.roles.indexOf('OK');
const majorIndex = canopyDefaultFlat.roles.indexOf('MAJOR');
const ONE_ARM = '0 if ({0} == 1) else (-1)';

describe('rules end-to-end through a scripted subscriber', () => {
  it('subscribes with the exact compiled specs (macros resolved; ladders carry indexes)', () => {
    renderFixture();

    expect(stub.subscriptions).toHaveLength(3);
    expect(stub.subscriptions.map((s) => s.spec)).toEqual(
      expect.arrayContaining([
        {
          kind: 'scalar',
          expression: COLOR_LADDER,
          bindings: { '0': 'DEV:7:SEVR' },
        },
        {
          kind: 'scalar',
          expression: '{A} + {B}',
          bindings: { A: 'DEV:7:W1', B: 'DEV:7:W2' },
        },
        {
          kind: 'scalar',
          expression: VIS_LADDER,
          bindings: { '0': 'DEV:7:ON' },
        },
      ])
    );
  });

  it('maps a Formula Engine path arm index onto the rule arm and patches the target prop', () => {
    renderFixture();

    // Base color first (no result yet).
    expect(labelBox('RB').style.color).toBe('rgb(255, 255, 255)');

    stub.push(COLOR_LADDER, 0);
    expect(labelBox('RB').style.color).toBe('rgb(255, 0, 0)');

    stub.push(COLOR_LADDER, -1);
    expect(labelBox('RB').style.color).toBe('rgb(255, 255, 255)');
  });

  it('passes a formula-arm scalar through unmapped into geometry (width)', () => {
    renderFixture();

    expect(wrapperOf('RB').style.width).toBe('100px');
    // 250 is not an arm index; a formula-arm result IS the output.
    stub.push('{A} + {B}', 250);
    expect(wrapperOf('RB').style.width).toBe('250px');
    // 0 would be an arm index on a ladder; here it is a plain width.
    stub.push('{A} + {B}', 0);
    expect(wrapperOf('RB').style.width).toBe('0px');
  });

  it('composes visible by AND and unmounts/remounts the widget', () => {
    renderFixture();

    expect(screen.queryByText('HIDEME')).toBeTruthy();
    stub.push(VIS_LADDER, 0);
    expect(screen.queryByText('HIDEME')).toBeNull();
    stub.push(VIS_LADDER, -1);
    expect(screen.queryByText('HIDEME')).toBeTruthy();
  });

  it('ignores a ladder result that is not a valid arm index', () => {
    renderFixture();
    stub.push(COLOR_LADDER, 0);
    expect(labelBox('RB').style.color).toBe('rgb(255, 0, 0)');
    stub.push(COLOR_LADDER, 7);
    expect(labelBox('RB').style.color).toBe('rgb(255, 255, 255)');
    stub.push(COLOR_LADDER, '#ff0000');
    expect(labelBox('RB').style.color).toBe('rgb(255, 255, 255)');
  });

  it('applies static (default-only) rules without any subscriber', () => {
    const staticScreen: ScreenJSON = {
      ...FIXTURE,
      root: {
        id: 'root',
        type: 'absolute-canvas',
        props: {},
        geometry: { x: 0, y: 0, width: 400, height: 200 },
        children: [
          {
            id: 'w-static',
            type: 'text-label',
            props: { text: 'STATIC', foregroundColor: '#ffffff' },
            geometry: { x: 0, y: 0, width: 100, height: 20 },
            rules: [
              {
                id: 'r-s',
                name: 'static default',
                targetProperty: 'foregroundColor',
                default: '#123456',
                pvs: [],
                conditions: [],
              },
            ],
          },
        ],
      },
    };

    render(
      <PVServiceProvider service={service}>
        <ScreenRenderer screen={staticScreen} />
      </PVServiceProvider>
    );

    expect(labelBox('STATIC').style.color).toBe('rgb(18, 52, 86)');
  });

  it('cleans up subscriptions on unmount', () => {
    const { unmount } = renderFixture();
    expect(stub.subscriptions).toHaveLength(3);
    unmount();
    expect(stub.unsubscribed.toSorted()).toEqual([0, 1, 2]);
  });
});

describe('a null arm or default means no output', () => {
  it('Formula Engine path: a null arm and a null default both leave the base prop', () => {
    renderScreen(probeDoc('#ffffff', [null, '#ff0000'], null));
    expect(probeProps().foregroundColor).toBe('#ffffff');

    stub.push('{0} == 1', 1); // arm 1 → '#ff0000'
    expect(probeProps().foregroundColor).toBe('#ff0000');
    stub.push('{0} == 1', 0); // arm 0 → null
    expect(probeProps().foregroundColor).toBe('#ffffff');
    stub.push('{0} == 1', 1);
    expect(probeProps().foregroundColor).toBe('#ff0000');
    stub.push('{0} == 1', -1); // default → null
    expect(probeProps().foregroundColor).toBe('#ffffff');
  });

  it('static path: a null default and a folded null arm both leave the base prop', () => {
    renderScreen(
      probeDoc('#ffffff', [], null, [
        {
          id: 'r2',
          name: 'folded to a null arm',
          targetProperty: 'foregroundColor',
          default: '#00ff00',
          pvs: [],
          conditions: [{ expression: '1 > 0', value: null }],
        },
      ])
    );
    expect(stub.subscriptions).toHaveLength(0);
    expect(probeProps().foregroundColor).toBe('#ffffff');
  });
});

describe('base and arm reach the widget as CSS strings (role or hex, each)', () => {
  const cases: {
    name: string;
    base: PropertyValue;
    arm: RuleValue;
    expectBase: string;
    expectArm: string;
  }[] = [
    {
      name: 'hex base, hex arm',
      base: '#ffffff',
      arm: '#ff0000',
      expectBase: '#ffffff',
      expectArm: '#ff0000',
    },
    {
      name: 'hex base, role arm',
      base: '#ffffff',
      arm: MAJOR,
      expectBase: '#ffffff',
      expectArm: `var(--cr-${majorIndex}, #ff0000)`,
    },
    {
      name: 'role base, hex arm',
      base: OK,
      arm: '#ff0000',
      expectBase: `var(--cr-${okIndex}, #00ff00)`,
      expectArm: '#ff0000',
    },
    {
      name: 'role base, role arm',
      base: OK,
      arm: MAJOR,
      expectBase: `var(--cr-${okIndex}, #00ff00)`,
      expectArm: `var(--cr-${majorIndex}, #ff0000)`,
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      renderScreen(probeDoc(c.base, [c.arm], null));
      expect(probeProps().foregroundColor).toBe(c.expectBase);
      // The subscription never carries a color.
      expect(stub.subscriptions[0]!.spec.expression).toBe(ONE_ARM);
      stub.push('{0} == 1', 0);
      expect(probeProps().foregroundColor).toBe(c.expectArm);
      stub.push('{0} == 1', -1);
      expect(probeProps().foregroundColor).toBe(c.expectBase);
    });
  }

  it('a static role default resolves against the scheme, not to its fallback', () => {
    renderScreen(probeDoc('#ffffff', [], MAJOR));
    expect(stub.subscriptions).toHaveLength(0);
    expect(probeProps().foregroundColor).toBe(`var(--cr-${majorIndex}, #ff0000)`);
  });

  it('an out-of-scheme role arm resolves to light-dark()', () => {
    renderScreen(
      probeDoc('#ffffff', [{ $role: 'site.x', fallback: '#101010', fallbackDark: '#efefef' }], null)
    );
    stub.push('{0} == 1', 0);
    expect(probeProps().foregroundColor).toBe('light-dark(#101010, #efefef)');
  });
});

describe('a scheme swap recolors rule outputs without resubscribing', () => {
  const schemeA: FlatScheme = {
    ...canopyDefaultFlat,
    roles: ['site.x', 'OK', 'MAJOR'],
    light: ['#000001', '#000002', '#000003'],
    dark: ['#000004', '#000005', '#000006'],
  };
  const schemeB: FlatScheme = {
    ...canopyDefaultFlat,
    roles: ['MAJOR', 'OK'],
    light: ['#000007', '#000008'],
    dark: ['#000009', '#00000a'],
  };

  it('live arm, static default and base all follow the new scheme; subscriptions untouched', () => {
    const doc = probeDoc(
      OK,
      [MAJOR],
      null,
      [
        {
          id: 'r-static',
          name: 'static role',
          targetProperty: 'backgroundColor',
          default: OK,
          pvs: [],
          conditions: [],
        },
      ],
      { backgroundColor: '#ffffff' }
    );

    const view = renderScreen(doc, schemeA);
    expect(stub.subscriptions).toHaveLength(1);
    stub.push('{0} == 1', 0);
    expect(probeProps()).toMatchObject({
      foregroundColor: 'var(--cr-2, #ff0000)',
      backgroundColor: 'var(--cr-1, #00ff00)',
    });

    view.rerender(tree(doc, schemeB));
    expect(probeProps()).toMatchObject({
      foregroundColor: 'var(--cr-0, #ff0000)',
      backgroundColor: 'var(--cr-1, #00ff00)',
    });
    expect(stub.subscriptions).toHaveLength(1);
    expect(stub.unsubscribed).toEqual([]);

    // The live result survives the swap: the default arm maps back to the base.
    stub.push('{0} == 1', -1);
    expect(probeProps().foregroundColor).toBe('var(--cr-1, #00ff00)');
    expect(stub.subscriptions).toHaveLength(1);
  });
});

// ── useWidgetRulesState: outputs, stale, settled, delivered ─────────────────

const outage = () => new FormulaError('FORMULA_INPUT_OUTAGE', 'DEV:SEVR disconnected', true);
const terminal = () => new FormulaError('FORMULA_INVALID', 'bad spec', false);

const ladderRule = (id: string, pv: string, target = 'foregroundColor'): Rule =>
  ({
    id,
    name: id,
    targetProperty: target,
    default: '#ffffff',
    pvs: [{ name: pv, trigger: true }],
    conditions: [{ expression: '{0} == 1', value: '#ff0000' }],
  }) as Rule;

const staticRule: Rule = {
  id: 'r-static',
  name: 'static',
  targetProperty: 'backgroundColor',
  default: '#123456',
  pvs: [],
  conditions: [],
} as Rule;

const brokenRule: Rule = {
  id: 'r-broken',
  name: 'broken',
  targetProperty: 'width',
  default: 1,
  formula: 'nope',
} as Rule;

// Stable identities, as the hook's callers must pass (the renderer memoizes).
const NO_MACROS = {};
const NO_FORMULAS: never[] = [];

function withStub({ children }: { children: ReactNode }) {
  return (
    <FormulaSubscriberContext.Provider value={stub}>{children}</FormulaSubscriberContext.Provider>
  );
}

function renderRules(rules: readonly Rule[], wrapper: typeof withStub | undefined = withStub) {
  return renderHook(() => useWidgetRulesState(rules, NO_FORMULAS, NO_MACROS), { wrapper });
}

describe('useWidgetRulesState', () => {
  it('a live rule: unsettled, then a result settles; a retryable error is stale and drops to base', () => {
    const rules = [ladderRule('r1', 'DEV:SEVR')];
    const { result } = renderRules(rules);
    expect(result.current).toEqual({
      outputs: [undefined],
      stale: false,
      settled: false,
      delivered: false,
    });

    stub.push('{0} == 1', 0);
    expect(result.current).toEqual({
      outputs: ['#ff0000'],
      stale: false,
      settled: true,
      delivered: true,
    });

    stub.fail('{0} == 1', outage());
    expect(result.current).toEqual({
      outputs: [undefined],
      stale: true,
      settled: true,
      delivered: false,
    });

    // The next result, even the same arm, clears stale and restores the output.
    stub.push('{0} == 1', 0);
    expect(result.current).toEqual({
      outputs: ['#ff0000'],
      stale: false,
      settled: true,
      delivered: true,
    });
  });

  it('the onError path settles: a retryable error before any result is stale and settled', () => {
    const { result } = renderRules([ladderRule('r1', 'DEV:SEVR')]);
    stub.fail('{0} == 1', outage());
    expect(result.current).toEqual({
      outputs: [undefined],
      stale: true,
      settled: true,
      delivered: false,
    });
  });

  it('a non-retryable error settles without stale and keeps the last output', () => {
    const { result } = renderRules([ladderRule('r1', 'DEV:SEVR')]);
    stub.fail('{0} == 1', terminal());
    expect(result.current).toEqual({
      outputs: [undefined],
      stale: false,
      settled: true,
      delivered: false,
    });

    stub.push('{0} == 1', 0);
    stub.fail('{0} == 1', terminal());
    expect(result.current).toEqual({
      outputs: ['#ff0000'],
      stale: false,
      settled: true,
      delivered: true,
    });

    // A plain Error (no retryable flag) is not retryable either.
    stub.fail('{0} == 1', new Error('mixed locals'));
    expect(result.current.stale).toBe(false);
  });

  it('only the stale rule drops to base; the node is stale while any live rule is', () => {
    const rules = [ladderRule('r1', 'DEV:A'), ladderRule('r2', 'DEV:B', 'backgroundColor')];
    const { result } = renderRules(rules);
    expect(result.current.settled).toBe(false);
    act(() => {
      stub.subscriptions[0]!.options.onResult(0);
    });
    // One live rule delivering is enough to settle the node.
    expect(result.current).toEqual({
      outputs: ['#ff0000', undefined],
      stale: false,
      settled: true,
      delivered: true,
    });

    act(() => {
      stub.subscriptions[1]!.options.onResult(0);
    });
    act(() => {
      stub.subscriptions[1]!.options.onError?.(outage());
    });
    expect(result.current).toEqual({
      outputs: ['#ff0000', undefined],
      stale: true,
      settled: true,
      delivered: true,
    });

    act(() => {
      stub.subscriptions[1]!.options.onResult(0);
    });
    expect(result.current).toEqual({
      outputs: ['#ff0000', '#ff0000'],
      stale: false,
      settled: true,
      delivered: true,
    });
  });

  it('static rules count as settled; with a live rule beside them the node waits for it', () => {
    const only = renderRules([staticRule]);
    expect(only.result.current).toEqual({
      outputs: ['#123456'],
      stale: false,
      settled: true,
      delivered: false,
    });
    expect(stub.subscriptions).toHaveLength(0);
    only.unmount();

    const mixed = renderRules([staticRule, ladderRule('r1', 'DEV:SEVR')]);
    expect(mixed.result.current).toEqual({
      outputs: ['#123456', undefined],
      stale: false,
      settled: false,
      delivered: false,
    });
    stub.fail('{0} == 1', outage());
    // Stale resets the live rule's output only; the static output stays.
    expect(mixed.result.current).toEqual({
      outputs: ['#123456', undefined],
      stale: true,
      settled: true,
      delivered: false,
    });
  });

  it('settled at once when every rule fails to compile, with no rules, or with no subscriber', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(renderRules([brokenRule]).result.current).toEqual({
        outputs: [undefined],
        stale: false,
        settled: true,
        delivered: false,
      });
      expect(renderRules([]).result.current).toEqual({
        outputs: [],
        stale: false,
        settled: true,
        delivered: false,
      });
      const lone = [ladderRule('r1', 'DEV:SEVR')];
      const noSubscriber = renderHook(() => useWidgetRulesState(lone, NO_FORMULAS, NO_MACROS));
      expect(noSubscriber.result.current).toEqual({
        outputs: [undefined],
        stale: false,
        settled: true,
        delivered: false,
      });
    } finally {
      warn.mockRestore();
    }
  });

  it('a failed compile beside a live rule does not settle the node by itself', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { result } = renderRules([brokenRule, ladderRule('r1', 'DEV:SEVR')]);
      expect(result.current.settled).toBe(false);
      stub.push('{0} == 1', -1);
      expect(result.current).toEqual({
        outputs: [undefined, '#ffffff'],
        stale: false,
        settled: true,
        delivered: true,
      });
    } finally {
      warn.mockRestore();
    }
  });

  it('useWidgetRules keeps its signature and returns the outputs', () => {
    const rules = [ladderRule('r1', 'DEV:SEVR')];
    const { result } = renderHook(() => useWidgetRules(rules, NO_FORMULAS, NO_MACROS), {
      wrapper: withStub,
    });
    expect(result.current).toEqual([undefined]);
    stub.push('{0} == 1', 0);
    expect(result.current).toEqual(['#ff0000']);
    stub.fail('{0} == 1', outage());
    expect(result.current).toEqual([undefined]);
  });

  it('end to end: a stale rule returns the widget to its base prop until the next result', () => {
    renderScreen(probeDoc(OK, [MAJOR], null));
    stub.push(ONE_ARM, 0);
    expect(probeProps().foregroundColor).toBe('var(--cr-' + majorIndex + ', #ff0000)');
    stub.fail(ONE_ARM, outage());
    expect(probeProps().foregroundColor).toBe('var(--cr-' + okIndex + ', #00ff00)');
    stub.push(ONE_ARM, 0);
    expect(probeProps().foregroundColor).toBe('var(--cr-' + majorIndex + ', #ff0000)');
  });
});
