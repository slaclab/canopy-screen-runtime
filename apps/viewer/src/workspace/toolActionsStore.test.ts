// toolActionsStore: canopy:tool-actions parsing, the per-tab report store and
// canopy:tool-invoke posting.

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TOOL_ACTIONS,
  TOOL_INVOKE,
  createToolActionsStore,
  invokeToolAction,
  parseToolActions,
  toolActionsStore,
} from './toolActionsStore.js';
import type { ToolActionsReport } from './toolActionsStore.js';

const REPORT = {
  type: TOOL_ACTIONS,
  version: 1,
  state: '2 curves · live',
  actions: [
    { id: 'import', label: 'Import…', kind: 'button', disabled: false, shortcut: 'primary+O' },
    { id: 'post-elog', label: 'Post to E-Log', kind: 'button', disabled: 'No plot yet' },
    { id: 'view-mode', label: 'Plots as grid', kind: 'toggle', pressed: true },
  ],
  links: { docs: 'https://docs.example/trace', bug: 'https://bugs.example/new' },
};

function report(over: Record<string, unknown> = {}): ToolActionsReport {
  const r = parseToolActions({ ...REPORT, ...over });
  if (!r) throw new Error('not a report');
  return r;
}

function frameWith(post = vi.fn()): HTMLIFrameElement {
  return { contentWindow: { postMessage: post } } as unknown as HTMLIFrameElement;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseToolActions', () => {
  it('keeps the report fields and drops the type', () => {
    expect(parseToolActions(REPORT)).toEqual({
      version: 1,
      state: '2 curves · live',
      actions: [
        { id: 'import', label: 'Import…', kind: 'button', disabled: false, shortcut: 'primary+O' },
        { id: 'post-elog', label: 'Post to E-Log', kind: 'button', disabled: 'No plot yet' },
        { id: 'view-mode', label: 'Plots as grid', kind: 'toggle', pressed: true },
      ],
      links: { docs: 'https://docs.example/trace', bug: 'https://bugs.example/new' },
    });
  });

  it('returns a frozen report', () => {
    const r = report();
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.actions)).toBe(true);
    expect(Object.isFrozen(r.actions[0])).toBe(true);
    expect(Object.isFrozen(r.links)).toBe(true);
  });

  it('rejects other types, versions and a missing actions list', () => {
    expect(parseToolActions({ ...REPORT, type: 'canopy:trace-ready' })).toBeNull();
    expect(parseToolActions({ ...REPORT, version: 2 })).toBeNull();
    expect(parseToolActions({ ...REPORT, version: '1' })).toBeNull();
    expect(parseToolActions({ ...REPORT, actions: undefined })).toBeNull();
    expect(parseToolActions({ ...REPORT, actions: {} })).toBeNull();
    expect(parseToolActions(TOOL_ACTIONS)).toBeNull();
    expect(parseToolActions(null)).toBeNull();
  });

  it('drops malformed entries one by one and duplicate ids', () => {
    const r = report({
      actions: [
        { id: 'a', label: 'A', kind: 'button' },
        { label: 'no id', kind: 'button' },
        { id: 'b', kind: 'button' },
        { id: 'c', label: 'C', kind: 'menu' },
        { id: 42, label: 'D', kind: 'button' },
        null,
        'e',
        { id: 'a', label: 'A again', kind: 'toggle' },
        { id: 'f', label: 'F', kind: 'toggle', pressed: 'yes', disabled: true, shortcut: 7 },
      ],
    });
    expect(r.actions).toEqual([
      { id: 'a', label: 'A', kind: 'button' },
      { id: 'f', label: 'F', kind: 'toggle' },
    ]);
  });

  it('keeps only http(s) links and tolerates missing ones', () => {
    expect(
      report({ links: { docs: 'javascript:alert(1)', bug: 'https://b.example/' } }).links
    ).toEqual({
      bug: 'https://b.example/',
    });
    expect(report({ links: undefined }).links).toEqual({});
    expect(report({ links: { docs: 3 } }).links).toEqual({});
  });

  it('omits a non-string state and clips long strings', () => {
    expect(report({ state: 5 })).not.toHaveProperty('state');
    const long = 'x'.repeat(500);
    const r = report({ state: long, actions: [{ id: 'a', label: long, kind: 'button' }] });
    expect(r.state).toHaveLength(120);
    expect(r.actions[0]!.label).toHaveLength(120);
  });
});

describe('createToolActionsStore', () => {
  it('stores a report per tab', () => {
    const store = createToolActionsStore();
    const a = report();
    const b = report({ state: 'paused', actions: [] });
    store.set('trace:1', a);
    store.set('correlation:1', b);
    expect(store.get('trace:1')).toBe(a);
    expect(store.get('correlation:1')).toBe(b);
    expect(store.get('nope')).toBeNull();
    expect(store.getSnapshot()).toEqual({ 'trace:1': a, 'correlation:1': b });
  });

  it('replaces a tab report whole', () => {
    const store = createToolActionsStore();
    store.set('t', report());
    const next = report({ state: undefined, actions: [{ id: 'x', label: 'X', kind: 'button' }] });
    store.set('t', next);
    expect(store.get('t')).toBe(next);
    expect(store.get('t')!.actions.map((a) => a.id)).toEqual(['x']);
    expect(store.get('t')).not.toHaveProperty('state');
  });

  it('replaces the frozen snapshot only on a change and notifies subscribers', () => {
    const store = createToolActionsStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    const first = store.getSnapshot();
    expect(Object.isFrozen(first)).toBe(true);
    const r = report();
    store.set('t', r);
    const second = store.getSnapshot();
    expect(second).not.toBe(first);
    expect(Object.isFrozen(second)).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    store.set('t', r);
    store.clear('other');
    expect(store.getSnapshot()).toBe(second);
    expect(listener).toHaveBeenCalledTimes(1);
    store.clear('t');
    expect(store.getSnapshot()).toEqual({});
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    store.set('t', r);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('invoke posts the exact canopy:tool-invoke message to the tab frame', () => {
    const store = createToolActionsStore();
    const postA = vi.fn();
    const postB = vi.fn();
    store.registerFrame('a', frameWith(postA));
    store.registerFrame('b', frameWith(postB));
    expect(store.invoke('b', 'export-csv')).toBe(true);
    expect(postB).toHaveBeenCalledExactlyOnceWith(
      { type: 'canopy:tool-invoke', id: 'export-csv' },
      window.location.origin
    );
    expect(postA).not.toHaveBeenCalled();
  });

  it('invoke returns false without a registered frame', () => {
    const store = createToolActionsStore();
    expect(store.invoke('a', 'import')).toBe(false);
    const post = vi.fn();
    const unregister = store.registerFrame('a', frameWith(post));
    unregister();
    expect(store.invoke('a', 'import')).toBe(false);
    expect(post).not.toHaveBeenCalled();
  });

  it('a stale unregister leaves a newer frame for the same tab in place', () => {
    const store = createToolActionsStore();
    const oldPost = vi.fn();
    const newPost = vi.fn();
    const unregisterOld = store.registerFrame('a', frameWith(oldPost));
    store.registerFrame('a', frameWith(newPost));
    unregisterOld();
    expect(store.invoke('a', 'import')).toBe(true);
    expect(newPost).toHaveBeenCalledOnce();
    expect(oldPost).not.toHaveBeenCalled();
  });
});

describe('invokeToolAction', () => {
  it('posts through the page store', () => {
    expect(TOOL_INVOKE).toBe('canopy:tool-invoke');
    const post = vi.fn();
    const unregister = toolActionsStore.registerFrame('page-tab', frameWith(post));
    try {
      expect(invokeToolAction('page-tab', 'print')).toBe(true);
      expect(post).toHaveBeenCalledExactlyOnceWith(
        { type: TOOL_INVOKE, id: 'print' },
        window.location.origin
      );
    } finally {
      unregister();
    }
  });
});
