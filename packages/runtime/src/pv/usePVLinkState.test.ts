// usePVLinkState: the link state of a node's machine channels, read from the
// per-instance service's getSnapshot / subscribe (usePV starts disconnected,
// so it cannot tell "no data yet" from "dead"). Also the node-level rules of
// render/linkState.ts that combine it with a node's rules.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { createElement } from 'react';
import type { ReactNode } from 'react';
import { PVServiceContext } from '@slaclab/canopy-react';
import type { FormulaDeclaration } from '@slaclab/canopy-screen-ir';
import type { PVData, PVListener, PVService } from '@slaclab/canopy-screen-widgets';
import { linkChannels, linkStateOf, usePVLinkState } from './usePVLinkState.js';
import {
  combineLinkStates,
  drawsCue,
  nodeLinkChannels,
  ruleLinkState,
} from '../render/linkState.js';

afterEach(cleanup);

function data(connected: boolean, value = 0): PVData {
  return {
    value,
    displayValue: String(value),
    severity: (connected ? 0 : 4) as PVData['severity'],
    connected,
    timestamp: 0,
    units: '',
    precision: 0,
    lowerLimit: 0,
    upperLimit: 0,
  };
}

/** A scripted service: pending until the test pushes a snapshot. */
function scripted() {
  const snapshots = new Map<string, PVData>();
  const listeners = new Map<string, Set<PVListener>>();
  const subscribed: string[] = [];
  const service: PVService = {
    subscribe(name, listener) {
      subscribed.push(name);
      let set = listeners.get(name);
      if (!set) listeners.set(name, (set = new Set()));
      set.add(listener);
      const snap = snapshots.get(name);
      if (snap) listener(snap);
      return () => set.delete(listener);
    },
    getSnapshot: (name) => snapshots.get(name),
    put: () => {},
    connect: () => {},
    disconnect: () => {},
    isConnected: true,
  };
  const push = (name: string, d: PVData) =>
    act(() => {
      snapshots.set(name, d);
      for (const l of listeners.get(name) ?? []) l(d);
    });
  const live = (name: string) => listeners.get(name)?.size ?? 0;
  return { service, push, subscribed, live };
}

function withService(service: PVService | null) {
  return ({ children }: { children: ReactNode }) =>
    createElement(PVServiceContext.Provider, { value: service as never }, children);
}

describe('linkStateOf / linkChannels', () => {
  it('pending while any channel has no snapshot', () => {
    expect(linkStateOf([undefined])).toBe('pending');
    expect(linkStateOf([data(true), undefined])).toBe('pending');
    expect(linkStateOf([data(false), undefined])).toBe('pending');
  });

  it('connected / partial / disconnected over delivered snapshots; null for none', () => {
    expect(linkStateOf([data(true), data(true)])).toBe('connected');
    expect(linkStateOf([data(true), data(false)])).toBe('partial');
    expect(linkStateOf([data(false), data(false)])).toBe('disconnected');
    expect(linkStateOf([])).toBeNull();
  });

  it('skips loc:// and blanks, keeps formula://, trims and dedupes', () => {
    expect(linkChannels([' A ', 'loc://x', '', 'formula://f-1', 'A', 'B'])).toEqual([
      'A',
      'formula://f-1',
      'B',
    ]);
  });
});

describe('usePVLinkState', () => {
  it('is pending until the first snapshot, then follows the snapshots', () => {
    const { service, push } = scripted();
    const { result } = renderHook(() => usePVLinkState(['A', 'B']), {
      wrapper: withService(service),
    });
    expect(result.current).toBe('pending');
    push('A', data(true));
    expect(result.current).toBe('pending');
    push('B', data(false));
    expect(result.current).toBe('partial');
    push('B', data(true));
    expect(result.current).toBe('connected');
    push('A', data(false));
    push('B', data(false));
    expect(result.current).toBe('disconnected');
  });

  it('reads an existing snapshot at once (no pending flash)', () => {
    const { service, push } = scripted();
    push('A', data(false));
    const { result } = renderHook(() => usePVLinkState(['A']), {
      wrapper: withService(service),
    });
    expect(result.current).toBe('disconnected');
  });

  it('never subscribes loc:// names; loc:// only is null (not machine-bound)', () => {
    const { service, subscribed } = scripted();
    const { result } = renderHook(() => usePVLinkState(['loc://a', 'loc://b']), {
      wrapper: withService(service),
    });
    expect(result.current).toBeNull();
    expect(subscribed).toEqual([]);
  });

  it('includes formula:// channels', () => {
    const { service, push, subscribed } = scripted();
    const { result } = renderHook(() => usePVLinkState(['formula://f-1', 'loc://x']), {
      wrapper: withService(service),
    });
    expect(subscribed).toEqual(['formula://f-1']);
    push('formula://f-1', data(false));
    expect(result.current).toBe('disconnected');
  });

  it('sets state only on change: a value update with the same link state re-renders nothing', () => {
    const { service, push } = scripted();
    let renders = 0;
    renderHook(
      () => {
        renders += 1;
        return usePVLinkState(['A']);
      },
      { wrapper: withService(service) }
    );
    push('A', data(true, 1));
    const after = renders;
    push('A', data(true, 2));
    push('A', data(true, 3));
    expect(renders).toBe(after);
  });

  it('keeps its subscriptions across a fresh array of the same names; releases on unmount', () => {
    const { service, live } = scripted();
    const subscribe = vi.spyOn(service, 'subscribe');
    const { rerender, unmount } = renderHook(({ names }) => usePVLinkState(names), {
      wrapper: withService(service),
      initialProps: { names: ['A'] },
    });
    rerender({ names: ['A'] });
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(live('A')).toBe(1);
    unmount();
    expect(live('A')).toBe(0);
  });

  it('is disconnected without a PVService in context', () => {
    const { result } = renderHook(() => usePVLinkState(['A']), { wrapper: withService(null) });
    expect(result.current).toBe('disconnected');
  });
});

describe('node link state (render/linkState)', () => {
  const NO_MACROS = {};

  it('machineBound: a non-loc prop channel (formula:// included) or a non-loc rule channel', () => {
    const rule = (name: string) =>
      ({
        id: 'r',
        name: 'r',
        targetProperty: 'visible',
        default: true,
        pvs: [{ name, trigger: true }],
        conditions: [],
      }) as never;
    expect(nodeLinkChannels({ type: 'pv-led' }, { pv: 'A' }, [], NO_MACROS)).toEqual({
      channels: ['A'],
      propChannels: ['A'],
      ruleBound: false,
      machineBound: true,
    });
    expect(
      nodeLinkChannels({ type: 'pv-led' }, { pv: 'formula://f-1' }, [], NO_MACROS).machineBound
    ).toBe(true);
    expect(
      nodeLinkChannels({ type: 'pv-led' }, { pv: 'loc://x' }, [], NO_MACROS).machineBound
    ).toBe(false);
    expect(
      nodeLinkChannels({ type: 'text-label', rules: [rule('loc://x')] }, {}, [], NO_MACROS)
        .machineBound
    ).toBe(false);
    const ruleOnly = nodeLinkChannels({ type: 'text-label', rules: [rule('${P}:X')] }, {}, [], {
      P: 'D',
    });
    expect(ruleOnly).toEqual({
      channels: [],
      propChannels: [],
      ruleBound: true,
      machineBound: true,
    });
  });

  it('channels: every prop channel, unique, in prop order, loc:// and formula:// kept', () => {
    const plot = nodeLinkChannels(
      { type: 'waveform-plot' },
      {
        curves: [
          { y_channel: 'A' },
          { y_channel: 'loc://b' },
          { y_channel: 'formula://c' },
          { y_channel: 'A' },
        ],
      },
      [],
      NO_MACROS
    );
    expect(plot.channels).toEqual(['A', 'loc://b', 'formula://c']);
    expect(plot.propChannels).toEqual(['A', 'formula://c']);
    expect(nodeLinkChannels({ type: 'text-label' }, { text: 'x' }, [], NO_MACROS).channels).toEqual(
      []
    );
  });

  it('a formula rule is bound through its bindings', () => {
    const formulas = [
      { name: 'f', kind: 'scalar', expression: '{0}', bindings: { '0': 'GW:A' } },
    ] as unknown as FormulaDeclaration[];
    const formulaRule = { id: 'r', name: 'r', targetProperty: 'text', formula: 'f' } as never;
    expect(
      nodeLinkChannels({ type: 'text-label', rules: [formulaRule] }, {}, formulas, NO_MACROS)
        .ruleBound
    ).toBe(true);
  });

  it('ruleLinkState: pending until settled, disconnected while stale or with no result', () => {
    expect(ruleLinkState({ settled: false, stale: false, delivered: false })).toBe('pending');
    expect(ruleLinkState({ settled: true, stale: false, delivered: true })).toBe('connected');
    expect(ruleLinkState({ settled: true, stale: true, delivered: false })).toBe('disconnected');
    // A non-retryable error with no result; no subscriber; nothing compiled.
    expect(ruleLinkState({ settled: true, stale: false, delivered: false })).toBe('disconnected');
  });

  it('combineLinkStates: prop channels lead; disagreeing sides read partial', () => {
    expect(combineLinkStates(null, null)).toBeNull();
    expect(combineLinkStates('connected', null)).toBe('connected');
    expect(combineLinkStates(null, 'pending')).toBe('pending');
    expect(combineLinkStates('pending', 'disconnected')).toBe('pending');
    expect(combineLinkStates('disconnected', 'pending')).toBe('disconnected');
    expect(combineLinkStates('disconnected', 'disconnected')).toBe('disconnected');
    expect(combineLinkStates('connected', 'disconnected')).toBe('partial');
    expect(combineLinkStates('partial', 'connected')).toBe('partial');
  });

  it('only partial and disconnected draw the cue', () => {
    expect(drawsCue('partial')).toBe(true);
    expect(drawsCue('disconnected')).toBe(true);
    expect(drawsCue('pending')).toBe(false);
    expect(drawsCue('connected')).toBe(false);
    expect(drawsCue(null)).toBe(false);
  });
});
