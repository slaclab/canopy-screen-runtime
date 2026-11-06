// A base-hidden node (`visible: false` in its base props) is not mounted: it
// opens no PV subscription, compiles and subscribes no rule, renders none of
// its children and expands no embed, while a hidden embed still keeps its
// index in the instance keys of its siblings (the rule `walkMounted` pins).

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MockPVService } from '@slaclab/canopy-client';
import { PVServiceProvider } from '@slaclab/canopy-react';
import { registerBuiltinWidgets } from '@slaclab/canopy-screen-widgets';
import type { PropertyValue, Rule, ScreenJSON, WidgetNode } from '@slaclab/canopy-screen-ir';
import type { FormulaSpec } from '../formula.js';
import { FormulaSubscriberContext } from '../formula.js';
import { ScreenRenderer } from './ScreenRenderer.js';

/** Records every rule subscription a rendered screen asks for. */
class RecordingSubscriber {
  readonly specs: FormulaSpec[] = [];

  subscribe(spec: FormulaSpec): () => void {
    this.specs.push(spec);
    return () => {};
  }
}

const GEOMETRY = { x: 0, y: 0, width: 50, height: 20 };

function node(
  id: string,
  type: string,
  props: Record<string, PropertyValue>,
  extra: { children?: WidgetNode[]; rules?: Rule[] } = {}
): WidgetNode {
  return { id, type, props, geometry: GEOMETRY, ...extra };
}

function screenOf(id: string, children: WidgetNode[]): ScreenJSON {
  return {
    schemaVersion: '1.0',
    kind: 'screen',
    id,
    metadata: {
      title: id,
      source: { type: 'hand-authored' },
      size: { width: 200, height: 200 },
    },
    macros: [],
    root: node(`${id}-root`, 'absolute-canvas', {}, { children }),
  } as ScreenJSON;
}

const COLOR_RULE = {
  id: 'r-color',
  name: 'color-by-state',
  targetProperty: 'color',
  default: '#000000',
  pvs: [{ name: 'RULE:PV', trigger: true }],
  conditions: [{ expression: '{0} == 1', value: '#ff0000' }],
} as unknown as Rule;

/** A rule the compiler rejects, with a warning: `{5}` names no entry of `pvs`. */
const BROKEN_RULE = {
  id: 'r-broken',
  name: 'broken',
  targetProperty: 'color',
  default: '#000000',
  pvs: [{ name: 'RULE:PV', trigger: true }],
  conditions: [{ expression: '{5} == 1', value: '#ff0000' }],
} as unknown as Rule;

function label(visible: boolean | undefined, rules: Rule[]): ScreenJSON {
  const props: Record<string, PropertyValue> = { pv: 'LABEL:PV' };
  if (visible !== undefined) props.visible = visible;
  return screenOf('hidden-label', [node('lbl', 'pv-label', props, { rules })]);
}

let service: MockPVService;
let subscriber: RecordingSubscriber;

beforeAll(() => {
  registerBuiltinWidgets();
});

beforeEach(() => {
  service = new MockPVService();
  service.connect();
  subscriber = new RecordingSubscriber();
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

describe('ScreenRenderer: base-hidden nodes', () => {
  it('opens no PV subscription and no rule subscription for a base-hidden pv-label with a rule', () => {
    const subscribe = vi.spyOn(service, 'subscribe');
    const { container } = render(wrap(<ScreenRenderer screen={label(false, [COLOR_RULE])} />));

    expect(subscribe).toHaveBeenCalledTimes(0);
    expect(subscriber.specs).toEqual([]);
    expect(container.querySelector('[data-node-id="lbl"]')).toBeNull();
    // The rest of the screen still mounts.
    expect(container.querySelector('[data-node-id="hidden-label-root"]')).not.toBeNull();
  });

  it('subscribes the same node when it is not base-hidden', () => {
    const subscribe = vi.spyOn(service, 'subscribe');
    const { container } = render(wrap(<ScreenRenderer screen={label(undefined, [COLOR_RULE])} />));

    expect(subscribe.mock.calls.map(([name]) => name)).toContain('LABEL:PV');
    expect(subscriber.specs).toHaveLength(1);
    expect(container.querySelector('[data-node-id="lbl"]')).not.toBeNull();
  });

  it('compiles no rule of a base-hidden node', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const compileWarnings = () =>
      warn.mock.calls.filter(([message]) => String(message).includes('failed to compile'));

    render(wrap(<ScreenRenderer screen={label(false, [BROKEN_RULE])} />));
    expect(compileWarnings()).toEqual([]);

    cleanup();
    render(wrap(<ScreenRenderer screen={label(true, [BROKEN_RULE])} />));
    expect(compileWarnings()).not.toEqual([]);
  });

  it('keeps a node whose `visible` is not the boolean false', () => {
    const doc = screenOf('not-hidden', [
      node('str', 'pv-label', { pv: 'STR:PV', visible: 'false' }),
      node('yes', 'pv-label', { pv: 'YES:PV', visible: true }),
    ]);
    const subscribe = vi.spyOn(service, 'subscribe');
    const { container } = render(wrap(<ScreenRenderer screen={doc} />));

    expect(container.querySelector('[data-node-id="str"]')).not.toBeNull();
    expect(container.querySelector('[data-node-id="yes"]')).not.toBeNull();
    expect(subscribe.mock.calls.map(([name]) => name)).toEqual(
      expect.arrayContaining(['STR:PV', 'YES:PV'])
    );
  });

  it('mounts nothing under a base-hidden container', () => {
    const doc = screenOf('hidden-group', [
      node(
        'grp',
        'group',
        { visible: false },
        { children: [node('inner', 'pv-label', { pv: 'INNER:PV' }, { rules: [COLOR_RULE] })] }
      ),
      node('outer', 'pv-label', { pv: 'OUTER:PV' }),
    ]);
    const subscribe = vi.spyOn(service, 'subscribe');
    const { container } = render(wrap(<ScreenRenderer screen={doc} />));

    expect(subscribe.mock.calls.map(([name]) => name)).not.toContain('INNER:PV');
    expect(subscribe.mock.calls.map(([name]) => name)).toContain('OUTER:PV');
    expect(subscriber.specs).toEqual([]);
    expect(container.querySelector('[data-node-id="grp"]')).toBeNull();
    expect(container.querySelector('[data-node-id="inner"]')).toBeNull();
  });

  it('expands no base-hidden embed and keys the visible one as the walk does', async () => {
    const leaf = (id: string, pv: string) => screenOf(id, [node(`${id}-pv`, 'pv-label', { pv })]);
    const screens: Record<string, ScreenJSON> = {
      'e1.screen.json': leaf('e1', 'E1:PV'),
      'e2.screen.json': leaf('e2', 'E2:PV'),
      'e3.screen.json': leaf('e3', 'E3:PV'),
    };
    const resolveScreen = vi.fn(async (ref: string) => {
      const found = screens[ref];
      if (!found) throw new Error(`404 ${ref}`);
      return found;
    });
    const top = screenOf('top', [
      node('E1', 'embedded-display', { file: 'e1.screen.json', visible: false }),
      node(
        'HC',
        'group',
        { visible: false },
        { children: [node('E2', 'embedded-display', { file: 'e2.screen.json' })] }
      ),
      node('E3', 'embedded-display', { file: 'e3.screen.json' }),
    ]);
    const subscribe = vi.spyOn(service, 'subscribe');
    const { container } = render(
      wrap(<ScreenRenderer screen={top} resolveScreen={resolveScreen} />)
    );

    await waitFor(() => {
      expect(container.querySelector('[data-node-id="e3-pv"]')).not.toBeNull();
    });
    expect(resolveScreen.mock.calls.map(([ref]) => ref)).toEqual(['e3.screen.json']);
    expect(container.querySelector('[data-node-id="e3-pv"]')?.getAttribute('data-instance')).toBe(
      '/1:E3'
    );
    expect(container.querySelector('[data-node-id="e3-pv"]')?.getAttribute('data-pv')).toBe(
      'E3:PV'
    );
    expect(container.querySelector('[data-node-id="E1"]')).toBeNull();
    expect(container.querySelector('[data-node-id="E2"]')).toBeNull();
    const subscribed = subscribe.mock.calls.map(([name]) => name);
    expect(subscribed).toContain('E3:PV');
    expect(subscribed).not.toContain('E1:PV');
    expect(subscribed).not.toContain('E2:PV');
  });
});
