// Phase C acceptance: a fixture screen whose conditional AND formula-driven
// rules update their target props reactively from a scripted stub subscriber,
// with the compiled specs pinned at the subscription boundary.

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { MockPVService } from '@slaclab/canopy-client';
import { PVServiceProvider } from '@slaclab/canopy-react';
import { registerBuiltinWidgets } from '@slaclab/canopy-screen-widgets';
import type { ScreenJSON } from '@slaclab/canopy-screen-ir';
import type { FormulaScalarValue, FormulaSpec, FormulaSubscribeOptions } from '../formula.js';
import { FormulaSubscriberContext } from '../formula.js';
import { ScreenRenderer } from '../render/ScreenRenderer.js';

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

function renderFixture() {
  return render(
    <PVServiceProvider service={service}>
      <FormulaSubscriberContext.Provider value={stub}>
        <ScreenRenderer screen={FIXTURE} />
      </FormulaSubscriberContext.Provider>
    </PVServiceProvider>
  );
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

describe('rules end-to-end through a scripted subscriber', () => {
  it('subscribes with the exact compiled specs (macros resolved before subscribing)', () => {
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
