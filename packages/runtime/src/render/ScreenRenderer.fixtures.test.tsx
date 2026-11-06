// Acceptance: every IR fixture renders under the runtime with mock PV data.
// Fixtures come from the builder/screen-ir conformance corpus:
//  - p1_widgets.screen.json      (edl-converter golden output)
//  - formula-driven.screen.json  (formula arm + formula:// refs)
//  - simple.screen.json          (importer fixture: containers, unknown widget)
//  - vacuum-system.screen.json   (example: rules, embedded display, macros)
// Under a gate that refuses machine writes, an action wrapper whose list holds
// a machine write_pv renders inert with no click handler; navigation-only and
// local-write lists stay live; a gate that makes no statement changes nothing.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MockPVService } from '@slaclab/canopy-client';
import { PVServiceProvider } from '@slaclab/canopy-react';
import { WriteGate, registerBuiltinWidgets } from '@slaclab/canopy-screen-widgets';
import type { WriteGateService } from '@slaclab/canopy-screen-widgets';
import { canopyDefaultFlat } from '@slaclab/canopy-screen-ir';
import type { PropertyValue, ScreenJSON, WidgetNode } from '@slaclab/canopy-screen-ir';
import { ActionHostContext } from '../actions/ActionHostContext.js';
import type { ActionHost } from '../actions/ActionHostContext.js';
import { ScreenRenderer } from './ScreenRenderer.js';
import { FixturePVService } from '../pv/FixturePVService.js';
import { FormulaSubscriberContext } from '../formula.js';
import type { FormulaSubscribeOptions, FormulaSubscriber } from '../formula.js';
import { FormulaError } from '../formula.js';
import { act } from '@testing-library/react';

import p1 from '../../test/fixtures/p1_widgets.screen.json' with { type: 'json' };
import formulaDriven from '../../test/fixtures/formula-driven.screen.json' with { type: 'json' };
import simple from '../../test/fixtures/simple.screen.json' with { type: 'json' };
import vacuum from '../../test/fixtures/vacuum-system.screen.json' with { type: 'json' };

/** The live-data cue: a dashed outline in the scheme's DISCONNECTED role. */
const CUE_OUTLINE = /^1px dashed var\(--cr-\d+, #da1e28\)$/;

let service: MockPVService;

beforeAll(() => {
  registerBuiltinWidgets();
});

beforeEach(() => {
  // Real timers: the embedded-screen tests await resolveScreen promises via
  // waitFor. MockPVService's simulation intervals are cleared by disconnect.
  service = new MockPVService();
  service.connect();
});

afterEach(() => {
  cleanup();
  service.disconnect();
});

function wrap(children: ReactNode) {
  return <PVServiceProvider service={service}>{children}</PVServiceProvider>;
}

describe('ScreenRenderer — fixture corpus', () => {
  it('renders the edl-converter golden fixture (p1_widgets)', () => {
    const { container } = render(wrap(<ScreenRenderer screen={p1 as unknown as ScreenJSON} />));

    const root = screen.getByTestId('screen-root');
    expect(root.dataset.screenId).toBe('screen');
    // The top root carries the scheme hook and the mirrored (unseeded) mode.
    expect(root.classList.contains('canopy-screen')).toBe(true);
    expect(root.dataset.scheme).toBe(canopyDefaultFlat.meta.flatHash);
    expect(root.dataset.theme).toBe('light');
    expect(root.style.colorScheme).toBe('light');
    // related-display-button degrades to a labeled button.
    expect(screen.getByText('Open')).toBeTruthy();
    // Nothing crashed.
    expect(container.querySelectorAll('[data-testid="widget-error"]')).toHaveLength(0);
  });

  it('renders the formula-driven fixture with rules inert (no subscriber)', () => {
    const { container } = render(
      wrap(<ScreenRenderer screen={formulaDriven as unknown as ScreenJSON} />)
    );
    expect(screen.getByTestId('screen-root').dataset.screenId).toBe('formula-driven');
    expect(container.querySelectorAll('[data-testid="widget-error"]')).toHaveLength(0);
  });

  it('renders the importer fixture (simple): containers, labels, unknown widget placeholder', () => {
    const { container } = render(wrap(<ScreenRenderer screen={simple as unknown as ScreenJSON} />));

    // StaticLabel and nested group-box child button.
    expect(screen.getByText('Status')).toBeTruthy();
    expect(screen.getByText('Go')).toBeTruthy();
    // unknown-widget renders a labeled placeholder, never a crash.
    const placeholder = screen.getByTestId('widget-placeholder');
    expect(placeholder.textContent).toContain('activeRectangleClass');
    expect(container.querySelectorAll('[data-testid="widget-error"]')).toHaveLength(0);
  });

  it('renders the vacuum example, resolving its embedded display with chained macros', async () => {
    const motorScreen: ScreenJSON = {
      schemaVersion: '1.0',
      kind: 'template',
      id: 'motor-control',
      metadata: {
        title: 'Motor',
        source: { type: 'hand-authored' },
        size: { width: 400, height: 200 },
      },
      macros: [{ name: 'MOTOR' }],
      root: {
        id: 'm-001',
        type: 'absolute-canvas',
        props: {},
        geometry: { x: 0, y: 0, width: 400, height: 200 },
        children: [
          {
            id: 'm-002',
            type: 'text-label',
            props: { text: 'Motor ${MOTOR}' },
            geometry: { x: 0, y: 0, width: 200, height: 20 },
          },
        ],
      },
    };
    const resolveScreen = vi.fn().mockResolvedValue(motorScreen);

    render(
      wrap(
        <ScreenRenderer screen={vacuum as unknown as ScreenJSON} resolveScreen={resolveScreen} />
      )
    );

    expect(resolveScreen).toHaveBeenCalledWith('motor-control.screen.json');
    // Embedded node macros { MOTOR: "${PREFIX}:M1" } resolve against the
    // parent's PREFIX default DEMO:VAC1 before flowing into the child.
    await waitFor(() => {
      expect(screen.getByText('Motor DEMO:VAC1:M1')).toBeTruthy();
    });
    expect(screen.getByTestId('embedded-screen').dataset.screenId).toBe('motor-control');
    // Only the top root is a scheme root; the embedded screen inherits.
    const embedded = screen.getByTestId('embedded-screen');
    expect(embedded.classList.contains('canopy-screen')).toBe(false);
    expect(embedded.dataset.scheme).toBeUndefined();
    expect(embedded.dataset.theme).toBeUndefined();
    expect(document.querySelectorAll('.canopy-screen')).toHaveLength(1);
  });

  it('substitutes caller macro overrides across props (vacuum with PREFIX override)', async () => {
    const resolveScreen = vi.fn().mockResolvedValue({
      schemaVersion: '1.0',
      kind: 'screen',
      id: 'sub',
      metadata: { title: 's', source: { type: 'hand-authored' }, size: { width: 10, height: 10 } },
      macros: [{ name: 'MOTOR', default: 'unset' }],
      root: {
        id: 's-root',
        type: 'text-label',
        props: { text: '${MOTOR}' },
        geometry: { x: 0, y: 0, width: 10, height: 10 },
      },
    } satisfies ScreenJSON);

    render(
      wrap(
        <ScreenRenderer
          screen={vacuum as unknown as ScreenJSON}
          macros={{ PREFIX: 'XX00:9' }}
          resolveScreen={resolveScreen}
        />
      )
    );

    await waitFor(() => {
      expect(screen.getByText('XX00:9:M1')).toBeTruthy();
    });
  });
});

// ── Fixture mode (`?_canopyPv=fixture`): the live-data cue ──────────────────
//
// The viewer serves every channel from a FixturePVService in fixture mode; a
// PV recorded disconnected (or absent) renders as a dead gateway PV does.

describe('ScreenRenderer — fixture mode: disconnected widgets are marked, never 0', () => {
  const fixture = new FixturePVService({
    pvs: {
      'LIVE:LED': 1,
      'LIVE:VAL': 42,
      'LIVE:RB': 1,
      'DEAD:LED': { value: 0, connected: false },
      'DEAD:VAL': { value: 0, connected: false },
      // DEAD:* names below are absent: absent reads disconnected.
    },
  });

  const node = (
    id: string,
    type: string,
    props: Record<string, unknown>,
    extra: Partial<WidgetNodeLike> = {}
  ): WidgetNodeLike => ({
    id,
    type,
    props,
    geometry: { x: 0, y: 0, width: 60, height: 20 },
    ...extra,
  });

  interface WidgetNodeLike {
    id: string;
    type: string;
    props: Record<string, unknown>;
    geometry: { x: number; y: number; width: number; height: number };
    rules?: unknown[];
    children?: WidgetNodeLike[];
  }

  const deadRule = {
    id: 'r1',
    name: 'colour',
    targetProperty: 'foregroundColor',
    default: '#ffffff',
    pvs: [{ name: 'DEAD:RULE', trigger: true }],
    conditions: [{ expression: '{0} == 1', value: '#ff0000' }],
  };

  const cueScreen = (children: WidgetNodeLike[]): ScreenJSON =>
    ({
      schemaVersion: '1.0',
      kind: 'screen',
      id: 'cue',
      macros: [],
      metadata: {
        title: 'cue',
        source: { type: 'hand-authored' },
        size: { width: 400, height: 400 },
      },
      root: {
        id: 'root',
        type: 'absolute-canvas',
        props: {},
        geometry: { x: 0, y: 0, width: 400, height: 400 },
        children,
      },
    }) as unknown as ScreenJSON;

  const SCREEN = cueScreen([
    node('led-live', 'pv-led', { pv: 'LIVE:LED' }),
    node('led-dead', 'pv-led', { pv: 'DEAD:LED' }),
    node('byte-dead', 'pv-byte-led', { pv: 'DEAD:BYTE', numBits: 4 }),
    node('chk-dead', 'pv-checkbox', { pv: 'DEAD:CHK', label: 'Enable' }),
    node('meter-dead', 'pv-meter', { pv: 'DEAD:VAL' }),
    node('meter-live', 'pv-meter', { pv: 'LIVE:VAL', min: 0, max: 100 }),
    node('bar-dead', 'pv-progress-bar', { pv: 'DEAD:VAL', min: 0, max: 100 }),
    node('slider-dead', 'pv-slider', { pv: 'DEAD:VAL', min: 0, max: 100 }),
    node('btn-rb-dead', 'pv-button', {
      pv: 'DEAD:CTRL',
      readbackPV: 'DEAD:RB',
      label: 'SW',
      onImage: 'on.png',
      offImage: 'off.png',
    }),
    node('btn-rb-live', 'pv-button', {
      pv: 'LIVE:CTRL',
      readbackPV: 'LIVE:RB',
      label: 'SW',
      onImage: 'on.png',
      offImage: 'off.png',
    }),
    node('btn-ctrl', 'pv-button', { pv: 'DEAD:CTRL', label: 'Go' }),
    node('mixed', 'pv-label', { pv: 'LIVE:VAL', alarmPV: 'DEAD:VAL' }),
    node('local', 'pv-led', { pv: 'loc://flag' }),
    node('label', 'text-label', { text: 'static' }),
    node('rule-only', 'text-label', { text: 'ruled' }, { rules: [deadRule] }),
  ]);

  function wrapFixture(children: ReactNode, subscriber: FormulaSubscriber | null = null) {
    return (
      <PVServiceProvider service={fixture as never}>
        <FormulaSubscriberContext.Provider value={subscriber}>
          {children}
        </FormulaSubscriberContext.Provider>
      </PVServiceProvider>
    );
  }

  const wrapperOf = (container: HTMLElement, id: string) =>
    container.querySelector<HTMLElement>(`[data-node-id="${id}"]`)!;

  it('puts data-node-id and data-instance on every node', () => {
    const { container } = render(wrapFixture(<ScreenRenderer screen={SCREEN} />));
    for (const id of ['root', 'led-live', 'label', 'local', 'rule-only', 'btn-ctrl']) {
      const el = wrapperOf(container, id);
      expect(el, id).not.toBeNull();
      expect(el.dataset.instance, id).toBe('');
    }
  });

  it('names every prop channel in data-pv, loc:// included, rules excluded', () => {
    const { container } = render(wrapFixture(<ScreenRenderer screen={SCREEN} />));
    const pv = (id: string) => wrapperOf(container, id).dataset.pv;
    expect(pv('led-live')).toBe('LIVE:LED');
    expect(pv('mixed')).toBe('LIVE:VAL DEAD:VAL');
    expect(pv('btn-rb-live')).toBe('LIVE:CTRL LIVE:RB');
    expect(pv('local')).toBe('loc://flag');
    expect(pv('label')).toBeUndefined();
    expect(pv('rule-only')).toBeUndefined();
    expect(pv('root')).toBeUndefined();
  });

  it('carries the channel as subscribed: macros expanded', () => {
    const withMacros = cueScreen([node('m', 'pv-label', { pv: '${P}:VAL' })]);
    const { container } = render(
      wrapFixture(<ScreenRenderer screen={withMacros} macros={{ P: 'LIVE' }} />)
    );
    expect(wrapperOf(container, 'm').dataset.pv).toBe('LIVE:VAL');
  });

  it('marks machine-bound nodes only, and outlines partial / disconnected ones', () => {
    const { container } = render(wrapFixture(<ScreenRenderer screen={SCREEN} />));
    const state = (id: string) => wrapperOf(container, id).dataset.pvState;
    expect(state('led-live')).toBe('connected');
    expect(state('meter-live')).toBe('connected');
    expect(state('led-dead')).toBe('disconnected');
    expect(state('btn-ctrl')).toBe('disconnected');
    expect(state('mixed')).toBe('partial');
    // loc:// only, static: not machine-bound, no state attribute.
    expect(state('local')).toBeUndefined();
    expect(state('label')).toBeUndefined();
    expect(state('root')).toBeUndefined();

    for (const id of ['led-dead', 'mixed', 'btn-ctrl']) {
      const style = wrapperOf(container, id).style;
      expect(style.outline, id).toMatch(CUE_OUTLINE);
      expect(style.outlineOffset, id).toBe('-1px');
    }
    expect(wrapperOf(container, 'led-live').style.outline).toBe('');
  });

  it('draws no state and no value for a disconnected own PV (closes the "renders 0" gap)', () => {
    const { container } = render(wrapFixture(<ScreenRenderer screen={SCREEN} />));
    for (const id of [
      'led-dead',
      'byte-dead',
      'chk-dead',
      'meter-dead',
      'bar-dead',
      'slider-dead',
      'btn-rb-dead',
    ]) {
      const w = wrapperOf(container, id);
      expect(w.dataset.pvState, id).toBe('disconnected');
      expect(w.querySelector('[data-pv-nostate="true"]'), id).not.toBeNull();
      expect(w.querySelector('img'), id).toBeNull();
    }
    // The meter draws no needle and no number; the live one does.
    expect(wrapperOf(container, 'meter-dead').querySelector('.carbon-pv-meter__needle')).toBeNull();
    expect(wrapperOf(container, 'meter-dead').textContent).not.toContain('0');
    expect(wrapperOf(container, 'meter-live').querySelector('.carbon-pv-meter__needle')).not.toBe(
      null
    );
    // No Carbon slider thumb, progress fill or checkbox input.
    expect(wrapperOf(container, 'slider-dead').querySelector('input')).toBeNull();
    expect(wrapperOf(container, 'bar-dead').querySelector('.cds--progress-bar')).toBeNull();
    expect(wrapperOf(container, 'chk-dead').querySelector('input')).toBeNull();
    // A live readback keeps its state image; a control-only button renders as before.
    const live = wrapperOf(container, 'btn-rb-live');
    expect(live.querySelector('[data-pv-nostate]')).toBeNull();
    expect(live.querySelector('img')?.getAttribute('src')).toBe('on.png');
    const ctrl = wrapperOf(container, 'btn-ctrl');
    expect(ctrl.querySelector('[data-pv-nostate]')).toBeNull();
    expect(ctrl.textContent).toBe('Go');
    expect(wrapperOf(container, 'led-live').querySelector('[data-pv-nostate]')).toBeNull();
  });

  it('a rule-only node is pending until its first rule result or error, then follows it', () => {
    const subs: FormulaSubscribeOptions[] = [];
    const subscriber: FormulaSubscriber = {
      subscribe: (_spec, options) => {
        subs.push(options);
        return () => {};
      },
    };
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { container } = render(wrapFixture(<ScreenRenderer screen={SCREEN} />, subscriber));
    const ruled = () => wrapperOf(container, 'rule-only');
    expect(ruled().dataset.pvState).toBe('pending');
    expect(ruled().style.outline).toBe('');

    act(() => subs.at(-1)!.onResult(0));
    expect(ruled().dataset.pvState).toBe('connected');
    act(() => subs.at(-1)!.onError?.(new FormulaError('input_disconnected', 'gone', true)));
    expect(ruled().dataset.pvState).toBe('disconnected');
    expect(ruled().style.outline).toMatch(CUE_OUTLINE);
    act(() => subs.at(-1)!.onResult(1));
    expect(ruled().dataset.pvState).toBe('connected');
  });

  it('a rule-only node rendered without a FormulaSubscriber is disconnected at once', () => {
    const { container } = render(wrapFixture(<ScreenRenderer screen={SCREEN} />));
    expect(wrapperOf(container, 'rule-only').dataset.pvState).toBe('disconnected');
  });

  it('an embedded instance carries its instance key', async () => {
    const child = cueScreen([node('c-led', 'pv-led', { pv: 'DEAD:LED' })]);
    const top = cueScreen([node('emb', 'embedded-display', { file: 'child.screen.json' })]);
    const { container } = render(
      wrapFixture(<ScreenRenderer screen={top} resolveScreen={async () => child} />)
    );
    await waitFor(() => expect(wrapperOf(container, 'c-led')).not.toBeNull());
    const led = wrapperOf(container, 'c-led');
    expect(led.dataset.instance).toBe('/0:emb');
    expect(led.dataset.pvState).toBe('disconnected');
    expect(wrapperOf(container, 'emb').dataset.instance).toBe('');
  });
});

// ── Write-inert action wrappers ────────────────────────────────────────────

describe('ScreenRenderer — write-inert action wrappers', () => {
  const REASON = 'Simulator is kept read-only for this login';

  /** A gate with a writes state the test sets, counting runs. */
  function statedGate(disabled: boolean) {
    let state = Object.freeze({ disabled, reason: disabled ? REASON : null });
    const listeners = new Set<() => void>();
    const runs: unknown[] = [];
    const gate: WriteGateService = {
      confirmWrites: () => false,
      run: async (writes) => {
        runs.push(writes);
        return [];
      },
      writes: () => state,
      subscribeWrites(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const set = (next: boolean) =>
      act(() => {
        state = Object.freeze({ disabled: next, reason: next ? REASON : null });
        for (const l of [...listeners]) l();
      });
    return { gate, runs, set };
  }

  function makeHost() {
    return {
      resolveManifest: vi.fn<ActionHost['resolveManifest']>(() => '/view/panel'),
      navigate: vi.fn<ActionHost['navigate']>(),
      openWindow: vi.fn<ActionHost['openWindow']>(),
      close: vi.fn<ActionHost['close']>(),
      showError: vi.fn<ActionHost['showError']>(),
    } satisfies ActionHost;
  }

  function actionDoc(actions: unknown[], macros: ScreenJSON['macros'] = []): ScreenJSON {
    const node: WidgetNode = {
      id: 'b1',
      type: 'regular-button',
      props: { label: 'Go', actions: actions as unknown as PropertyValue },
      geometry: { x: 10, y: 10, width: 100, height: 30 },
    };
    return {
      schemaVersion: '1.0',
      kind: 'screen',
      id: 'inert',
      metadata: {
        title: 'inert',
        source: { type: 'hand-authored' },
        size: { width: 200, height: 60 },
      },
      macros,
      root: {
        id: 'inert-root',
        type: 'absolute-canvas',
        props: {},
        geometry: { x: 0, y: 0, width: 200, height: 60 },
        children: [node],
      },
    };
  }

  function renderUnder(gate: WriteGateService | null, doc: ScreenJSON, host: ActionHost) {
    const renderer = <ScreenRenderer screen={doc} />;
    return render(
      wrap(
        <ActionHostContext.Provider value={host}>
          {gate ? <WriteGate.Provider value={gate}>{renderer}</WriteGate.Provider> : renderer}
        </ActionHostContext.Provider>
      )
    );
  }

  const OPEN = { type: 'open_display', file: 'panel.screen.json', target: 'tab' };
  const WRITE = { type: 'write_pv', pvName: 'SYS:A', value: 1 };
  const LOCAL = { type: 'write_pv', pvName: 'loc://flag', value: 1 };

  function described(el: Element): string | undefined {
    return (
      document.getElementById(el.getAttribute('aria-describedby') ?? '')?.textContent ?? undefined
    );
  }

  it('a machine write plus navigation is inert: aria-disabled, the reason, and a click runs nothing', async () => {
    const { gate, runs } = statedGate(true);
    const host = makeHost();
    const put = vi.spyOn(service, 'put');
    const { container } = renderUnder(gate, actionDoc([WRITE, OPEN]), host);

    const wrapper = container.querySelector('[data-node-id="b1"]') as HTMLElement;
    expect(wrapper.getAttribute('aria-disabled')).toBe('true');
    expect(wrapper.title).toBe(REASON);
    const btn = screen.getByRole('button', { name: 'Go' });
    expect(btn.getAttribute('aria-disabled')).toBe('true');
    expect(btn.title).toBe(REASON);
    expect(described(btn)).toBe(REASON);
    btn.focus();
    expect(document.activeElement).toBe(btn);

    fireEvent.click(btn);
    fireEvent.click(wrapper);
    await new Promise((r) => setTimeout(r, 0));
    expect(runs).toHaveLength(0);
    expect(put).not.toHaveBeenCalled();
    expect(host.resolveManifest).not.toHaveBeenCalled();
    expect(host.navigate).not.toHaveBeenCalled();
    expect(host.openWindow).not.toHaveBeenCalled();
    expect(host.showError).not.toHaveBeenCalled();
  });

  it('a list of only navigation and loc:// writes stays live and runs', async () => {
    const { gate } = statedGate(true);
    const host = makeHost();
    const put = vi.spyOn(service, 'put');
    const { container } = renderUnder(gate, actionDoc([OPEN, LOCAL]), host);

    expect(container.querySelector('[aria-disabled="true"]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put.mock.calls[0][0]).toBe('loc://flag');
    await waitFor(() => expect(host.resolveManifest).toHaveBeenCalledTimes(1));
  });

  it('a write whose macro expands to a local channel stays live', () => {
    const { gate } = statedGate(true);
    const { container } = renderUnder(
      gate,
      actionDoc(
        [{ type: 'write_pv', pvName: '${CH}', value: 1 }],
        [{ name: 'CH', default: 'formula://x' }]
      ),
      makeHost()
    );
    expect(container.querySelector('[aria-disabled="true"]')).toBeNull();
  });

  it('a write whose macro expands to a machine channel is inert', () => {
    const { gate } = statedGate(true);
    const { container } = renderUnder(
      gate,
      actionDoc(
        [{ type: 'write_pv', pvName: '${P}:A', value: 1 }],
        [{ name: 'P', default: 'SYS' }]
      ),
      makeHost()
    );
    expect(container.querySelectorAll('[aria-disabled="true"]').length).toBeGreaterThan(0);
  });

  it('goes live on the state that says so, and its click runs the list', async () => {
    const { gate, runs, set } = statedGate(true);
    const host = makeHost();
    const { container } = renderUnder(gate, actionDoc([WRITE, OPEN]), host);
    set(false);
    expect(container.querySelector('[aria-disabled="true"]')).toBeNull();
    expect(container.querySelector('[data-node-id="b1"]')?.hasAttribute('title')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    await waitFor(() => expect(runs).toHaveLength(1));
    set(true);
    expect(screen.getByRole('button', { name: 'Go' }).getAttribute('aria-disabled')).toBe('true');
  });

  it('with a gate that makes no statement, or no gate, no fixture renders anything inert', () => {
    const legacy: WriteGateService = { confirmWrites: () => true, run: async () => [] };
    for (const fixture of [p1, formulaDriven, simple, vacuum]) {
      for (const gate of [legacy, null]) {
        const { container, unmount } = renderUnder(
          gate,
          fixture as unknown as ScreenJSON,
          makeHost()
        );
        expect(container.querySelector('[aria-disabled]')).toBeNull();
        unmount();
      }
    }
    const { container } = renderUnder(legacy, actionDoc([WRITE, OPEN]), makeHost());
    expect(container.querySelector('[aria-disabled]')).toBeNull();
  });
});
