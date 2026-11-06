// The dock's persistence wiring, over the real
// holder (tabsReducer) and an in-memory localStorage. Pinned here: the load
// decision (no usable value, another version or an invalid value opens the
// default silently and leaves the key; reload prunes to the session's tabs and
// reopens nothing; a new session reopens the stored panels with their tool
// state; a saved dock comes back with the same tiles, tabs, showing tab and
// sizes; pending home screen on first open; `_canopyChrome=0` never reads),
// and the write side (`{version: 1, layout, panels}` from the holder, nothing
// before a trusted user event, each stored change writes once after 150 ms,
// focus alone is not stored, Reset persists, pagehide flushes).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { useReducer, useRef, type Dispatch } from 'react';
import {
  EMPTY_TABS,
  fromLayout,
  tabsReducer,
  type Layout,
  type TabsAction,
  type TabsState,
  type ToolInstance,
} from '../tabs.js';
import { dockStorageKey, readDock, writeDock, type StoredDock } from './storage.js';
import {
  PERSIST_DELAY_MS,
  dockValue,
  planDockLoad,
  useDockPersistence,
  type DockLoadInput,
  type DockPersistence,
} from './useDockPersistence.js';

const BASE = '/embed/';
const A = 'ops/a';
const B = 'ops/b';
const C = 'ops/c';
const TRACE = '@trace';
const TRACE2 = '@trace/2';
const TOOLS = ['trace', 'correlation'];

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key: string) => (data.has(key) ? (data.get(key) as string) : null),
    key: (index: number) => [...data.keys()][index] ?? null,
    removeItem: (key: string) => {
      data.delete(key);
    },
    setItem: (key: string, value: string) => {
      data.set(key, String(value));
    },
  };
}

let store: Storage;

beforeEach(() => {
  store = memoryStorage();
  vi.stubGlobal('localStorage', store);
  document.documentElement.removeAttribute('data-canopy-storage-scope');
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const key = () => dockStorageKey(BASE);
const raw = () => store.getItem(key());

function stored(value: unknown): void {
  store.setItem(key(), typeof value === 'string' ? value : JSON.stringify(value));
}

/** Two tiles side by side: t1 [A, C] showing C (0.3), t2 [B] (0.7) split from t1. */
const TWO_TILES: Layout = {
  split: 'row',
  items: [
    { tile: 't1', tabs: [A, C], showing: C, size: 0.3 },
    { tile: 't2', tabs: [B], showing: B, size: 0.7, from: 't1' },
  ],
};

/** A session with `keys` open as tabs of one tile, showing `active`. */
function session(keys: string[], active: string | null, instances = {}): TabsState {
  const showing = active ?? keys[0];
  return fromLayout(showing === undefined ? null : { tile: 't1', tabs: keys, showing }, null, {
    ...EMPTY_TABS,
    instances,
  });
}

function input(over: Partial<DockLoadInput> = {}): DockLoadInput {
  return {
    chrome: true,
    basename: BASE,
    stored: EMPTY_TABS,
    urlKey: null,
    tools: TOOLS,
    newSession: false,
    ...over,
  };
}

describe('planDockLoad', () => {
  it('a bare first visit opens the data browser; a deep link suppresses it', () => {
    const first = input({ newSession: true });
    expect(planDockLoad(first).state.keys).toEqual([TRACE]);
    const linked = planDockLoad({ ...first, suppressFirstVisit: true });
    expect(linked.state.keys).toEqual([]);
    expect(linked.warnings).toEqual([]);
  });

  it('no stored value: the session tabs are one tile showing the active tab, silently', () => {
    const load = planDockLoad(input({ stored: session([A, B], B) }));
    expect(load.warnings).toEqual([]);
    expect(load.state.layout).toEqual({ tile: 't1', tabs: [A, B], showing: B });
    expect(load.state.active).toBe(B);
    expect(raw()).toBeNull();
  });

  it.each([
    ['non-JSON', '{not json'],
    [
      'a dockview grid under another version',
      {
        version: 0,
        grid: { grid: { root: { type: 'branch', data: [] } }, panels: {} },
        panels: { [A]: { kind: 'screen', strip: 0 } },
      },
    ],
    ['version 3', { version: 3, layout: TWO_TILES, panels: {} }],
    ['an invalid layout', { version: 1, layout: { tile: 'x', tabs: [A] }, panels: {} }],
  ])('%s: the default layout, no warning, the key left as it is', (_label, value) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stored(value);
    const before = raw();
    const load = planDockLoad(input({ stored: session([A, B], A) }));
    expect(load.warnings).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
    expect(raw()).toBe(before);
    expect(load.state.layout).toEqual({ tile: 't1', tabs: [A, B], showing: A });
    // A new session with nothing usable stored: the first-visit default.
    expect(planDockLoad(input({ newSession: true })).state.keys).toEqual([TRACE]);
  });

  it('reload: the same tiles, tabs, showing tab and sizes come back', () => {
    stored({ version: 1, layout: TWO_TILES, panels: {} });
    const load = planDockLoad(input({ stored: session([A, C, B], B) }));
    expect(load.warnings).toEqual([]);
    expect(load.state.layout).toEqual(TWO_TILES);
    expect(load.state.keys).toEqual([A, C, B]);
    expect(load.state.active).toBe(B);
  });

  it('reload prunes a closed tab and never reopens it; an open tab it lacks joins a tile', () => {
    stored({ version: 1, layout: TWO_TILES, panels: {} });
    const load = planDockLoad(input({ stored: session([A, B, 'ops/d'], B) }));
    expect(load.state.keys).not.toContain(C);
    expect(load.state.keys.sort()).toEqual([A, B, 'ops/d'].sort());
    const tiles = load.state.layout as { items: { tabs: string[] }[] };
    expect(tiles.items.map((t) => t.tabs.filter((k) => k !== 'ops/d'))).toEqual([[A], [B]]);
    expect(load.state.active).toBe(B);
  });

  it('reload whose stored keys are all closed: the session tabs as one tile, key left', () => {
    stored({ version: 1, layout: { tile: 't1', tabs: [C], showing: C }, panels: {} });
    const before = raw();
    const load = planDockLoad(input({ stored: session([A, B], A) }));
    expect(load.warnings).toEqual([]);
    expect(raw()).toBe(before);
    expect(load.state.keys).toEqual([A, B]);
    expect(load.state.active).toBe(A);
  });

  it('new session reopens the stored panels with tool query, view, member and title', () => {
    const layout: Layout = {
      split: 'column',
      items: [
        { tile: 't1', tabs: [A, TRACE], showing: TRACE, size: 0.5 },
        { tile: 't2', tabs: [TRACE2], showing: TRACE2, size: 0.5 },
      ],
    };
    stored({
      version: 1,
      layout,
      panels: {
        [A]: { kind: 'screen' },
        [TRACE]: { kind: 'tool', view: 'v1', query: 'pv=X' },
        [TRACE2]: { kind: 'tool', query: 'pv=SR:A', from: 'tool:trace?pv=SR:A', title: 'Ring A' },
      },
    });
    const load = planDockLoad(input({ newSession: true }));
    expect(load.warnings).toEqual([]);
    expect(load.state.layout).toEqual(layout);
    expect(load.state.keys).toEqual([A, TRACE, TRACE2]);
    expect(load.state.instances[TRACE]).toEqual({ query: 'pv=X', view: 'v1' });
    expect(load.state.instances[TRACE2]).toEqual({
      query: 'pv=SR:A',
      from: 'tool:trace?pv=SR:A',
      title: 'Ring A',
    });
    expect(load.pendingHome).toBeUndefined();
  });

  it('new session drops a stored tool that is not configured, with one warning', () => {
    stored({
      version: 1,
      layout: { tile: 't1', tabs: [A, '@correlation'], showing: A },
      panels: { [A]: { kind: 'screen' }, '@correlation': { kind: 'tool', query: '' } },
    });
    const load = planDockLoad(input({ newSession: true, tools: ['trace'] }));
    expect(load.state.keys).toEqual([A]);
    expect(load.warnings).toHaveLength(1);
  });

  it('new session with a deep link: the stored dock comes back and the link is shown', () => {
    stored({ version: 1, layout: TWO_TILES, panels: {} });
    const load = planDockLoad(input({ newSession: true, urlKey: 'ops/d' }));
    expect(load.state.keys).toContain('ops/d');
    expect(load.state.keys).toEqual(expect.arrayContaining([A, B, C]));
    expect(load.state.active).toBe('ops/d');
  });

  it('a stored empty dock on reload: the session tabs as one tile, showing its active tab', () => {
    stored({ version: 1, layout: null, panels: {} });
    const load = planDockLoad(input({ stored: session([A, B], B) }));
    expect(load.state.layout).toEqual({ tile: 't1', tabs: [A, B], showing: B });
  });

  describe('home screen on first open', () => {
    it('a first visit with nothing stored opens nothing and reports pendingHome', () => {
      const load = planDockLoad(input({ newSession: true, homeOnFirstOpen: true }));
      expect(load.state.keys).toEqual([]);
      expect(load.pendingHome).toBe(true);
    });

    it('a first visit with an unreadable value is a default first visit too', () => {
      stored({ version: 0, grid: {}, panels: {} });
      const load = planDockLoad(input({ newSession: true, homeOnFirstOpen: true }));
      expect(load.pendingHome).toBe(true);
      expect(load.warnings).toEqual([]);
    });

    it('a stored workspace restores as it is, without @trace or pendingHome', () => {
      stored({ version: 1, layout: TWO_TILES, panels: {} });
      const load = planDockLoad(input({ newSession: true, homeOnFirstOpen: true }));
      expect(load.state.layout).toEqual(TWO_TILES);
      expect(load.state.keys).not.toContain(TRACE);
      expect(load.pendingHome).toBeUndefined();
    });

    it('a stored workspace whose tabs all fail to reopen opens nothing, no pendingHome', () => {
      stored({
        version: 1,
        layout: { tile: 't1', tabs: ['@correlation'], showing: '@correlation' },
        panels: {},
      });
      const load = planDockLoad(
        input({ newSession: true, homeOnFirstOpen: true, tools: ['trace'] })
      );
      expect(load.state.keys).toEqual([]);
      expect(load.pendingHome).toBeUndefined();
    });
  });

  it('_canopyChrome=0 never reads the stored layout', () => {
    stored({ version: 1, layout: TWO_TILES, panels: {} });
    const getItem = vi.spyOn(store, 'getItem');
    const load = planDockLoad(input({ chrome: false, urlKey: B, newSession: true }));
    expect(getItem).not.toHaveBeenCalled();
    expect(load.state.keys).toEqual([B]);
  });
});

describe('dockValue', () => {
  it('is the holder layout plus one reopen record per open panel', () => {
    const instances: Record<string, ToolInstance> = {
      [TRACE]: { query: 'pv=Y', view: 'v9', epoch: 3 },
      [TRACE2]: { query: null, from: 'tool:trace' as ToolInstance['from'], title: 'Bare' },
      '@correlation': { query: 'x=1' },
    };
    const layout: Layout = {
      split: 'row',
      items: [
        { tile: 't1', tabs: [A, TRACE], showing: A, size: 0.5 },
        { tile: 't2', tabs: [TRACE2, '@correlation'], showing: TRACE2, size: 0.5 },
      ],
    };
    const state = fromLayout(layout, 't2', { ...EMPTY_TABS, instances });
    expect(dockValue(state)).toEqual({
      version: 1,
      layout,
      panels: {
        [A]: { kind: 'screen' },
        [TRACE]: { kind: 'tool', query: 'pv=Y', view: 'v9' },
        [TRACE2]: { kind: 'tool', from: 'tool:trace', title: 'Bare' },
        // A plain tool instance reopens blank.
        '@correlation': { kind: 'tool', query: '' },
      },
    });
  });

  it('an empty dock stores layout null', () => {
    expect(dockValue(EMPTY_TABS)).toEqual({ version: 1, layout: null, panels: {} });
  });

  it('round-trips through a new session with the same tiles, tabs, showing and sizes', () => {
    const state = fromLayout(TWO_TILES, 't2', EMPTY_TABS);
    writeDock(BASE, dockValue(state));
    const load = planDockLoad(input({ newSession: true }));
    expect(load.state.layout).toEqual(TWO_TILES);
  });
});

// --- The write side, over the real holder. ---

interface Handle {
  state: TabsState;
  dispatch: Dispatch<TabsAction>;
  persistence: DockPersistence;
  workspace: HTMLElement;
}

function mount(initial: TabsState, opts: { enabled?: boolean } = {}) {
  const handle = {} as Handle;
  function Harness() {
    const [state, dispatch] = useReducer(tabsReducer, initial);
    const workspace = useRef<HTMLDivElement>(null);
    const persistence = useDockPersistence({
      state,
      basename: BASE,
      enabled: opts.enabled ?? true,
      root: workspace,
      // jsdom marks every dispatched event untrusted; the test's own flag stands in.
      isTrusted: (event) => (event as Event & { trusted?: boolean }).trusted === true,
    });
    Object.assign(handle, { state, dispatch, persistence });
    return <div ref={workspace} data-testid="ws" />;
  }
  const view = render(<Harness />);
  handle.workspace = view.getByTestId('ws');
  return handle;
}

/** A pointer or key event inside the workspace, trusted or not. */
function userEvent(target: HTMLElement, type: 'pointerdown' | 'keydown', trusted = true) {
  const event = new Event(type, { bubbles: true }) as Event & { trusted?: boolean };
  event.trusted = trusted;
  target.dispatchEvent(event);
}

async function settle(ms = 0) {
  await act(async () => {
    await Promise.resolve();
    vi.advanceTimersByTime(ms);
    await Promise.resolve();
  });
}

const SPLIT: Layout = {
  split: 'row',
  items: [
    { tile: 't1', tabs: [A], showing: A, size: 0.5 },
    { tile: 't2', tabs: [B], showing: B, size: 0.5 },
  ],
};

const resizedSplit: Layout = {
  split: 'row',
  items: [
    { tile: 't1', tabs: [A], showing: A, size: 0.25 },
    { tile: 't2', tabs: [B], showing: B, size: 0.75 },
  ],
};

describe('useDockPersistence', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  function setItemSpy() {
    return vi.spyOn(store, 'setItem');
  }

  it('writes nothing after mount and holder changes without a user event', async () => {
    const setItem = setItemSpy();
    const handle = mount(session([A, B], A));
    act(() => handle.dispatch({ type: 'replaceLayout', layout: SPLIT }));
    await settle(500);
    expect(handle.state.layout).toEqual(SPLIT);
    expect(setItem).not.toHaveBeenCalled();
  });

  it('an untrusted event does not arm writing', async () => {
    const setItem = setItemSpy();
    const handle = mount(session([A, B], A));
    userEvent(handle.workspace, 'pointerdown', false);
    act(() => handle.dispatch({ type: 'replaceLayout', layout: SPLIT }));
    await settle(500);
    expect(setItem).not.toHaveBeenCalled();
  });

  it('a layout change after a trusted pointer event writes the holder once, after 150 ms', async () => {
    const setItem = setItemSpy();
    const handle = mount(session([A, B], A));
    userEvent(handle.workspace, 'pointerdown');
    act(() => handle.dispatch({ type: 'replaceLayout', layout: SPLIT }));
    await settle(PERSIST_DELAY_MS - 1);
    expect(setItem).not.toHaveBeenCalled();
    await settle(1);
    await settle(500);
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(readDock(BASE)).toEqual({
      version: 1,
      layout: SPLIT,
      panels: { [A]: { kind: 'screen' }, [B]: { kind: 'screen' } },
    } satisfies StoredDock);
  });

  it('a sash resize (sizes only) after a trusted key event writes the new sizes', async () => {
    const handle = mount(fromLayout(SPLIT, 't1', EMPTY_TABS));
    userEvent(handle.workspace, 'keydown');
    const setItem = setItemSpy();
    act(() => handle.dispatch({ type: 'resized', layout: resizedSplit }));
    await settle(PERSIST_DELAY_MS + 50);
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(readDock(BASE)?.layout).toEqual(resizedSplit);
  });

  it('a showing-tab change writes; a tile focus change alone does not', async () => {
    const two: Layout = { tile: 't1', tabs: [A, B], showing: A };
    const handle = mount(fromLayout(SPLIT, 't1', EMPTY_TABS));
    userEvent(handle.workspace, 'pointerdown');
    const setItem = setItemSpy();
    act(() => handle.dispatch({ type: 'focusTile', tile: 't2' }));
    await settle(PERSIST_DELAY_MS + 50);
    expect(handle.state.focusedTile).toBe('t2');
    expect(setItem).not.toHaveBeenCalled();

    act(() => handle.dispatch({ type: 'replaceLayout', layout: two }));
    await settle(PERSIST_DELAY_MS + 50);
    act(() => handle.dispatch({ type: 'focus', key: B }));
    await settle(PERSIST_DELAY_MS + 50);
    expect(setItem).toHaveBeenCalledTimes(2);
    expect(readDock(BASE)?.layout).toEqual({ tile: 't1', tabs: [A, B], showing: B });
  });

  it("a change of an open tool's view writes once, with the view and its query", async () => {
    const handle = mount(session([TRACE], TRACE, { [TRACE]: { query: null } }));
    userEvent(handle.workspace, 'pointerdown');
    const setItem = setItemSpy();
    act(() => handle.dispatch({ type: 'load', key: TRACE, query: 'pv=Y', view: 'v9' }));
    await settle(PERSIST_DELAY_MS + 50);
    expect(handle.state.instances[TRACE]?.view).toBe('v9');
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(readDock(BASE)?.panels[TRACE]).toEqual({ kind: 'tool', view: 'v9', query: 'pv=Y' });
  });

  it('schedule(true) (Reset) arms and persists the holder', async () => {
    const handle = mount(session([A, B], A));
    act(() => handle.dispatch({ type: 'replaceLayout', layout: SPLIT }));
    await settle(500);
    expect(raw()).toBeNull();
    act(() => handle.persistence.schedule(true));
    await settle(PERSIST_DELAY_MS + 50);
    expect(readDock(BASE)?.layout).toEqual(SPLIT);
  });

  it('disabled (_canopyChrome=0) never writes, even when armed', async () => {
    const setItem = setItemSpy();
    const handle = mount(session([A, B], A), { enabled: false });
    userEvent(handle.workspace, 'pointerdown');
    act(() => handle.dispatch({ type: 'replaceLayout', layout: SPLIT }));
    act(() => handle.persistence.schedule(true));
    await settle(500);
    expect(setItem).not.toHaveBeenCalled();
  });

  it('an unchanged value is not written again', async () => {
    const handle = mount(session([A], A));
    userEvent(handle.workspace, 'pointerdown');
    act(() => handle.persistence.schedule());
    await settle(PERSIST_DELAY_MS + 50);
    expect(raw()).not.toBeNull();
    const setItem = setItemSpy();
    writeDock(BASE, dockValue(handle.state));
    act(() => handle.persistence.schedule());
    await settle(PERSIST_DELAY_MS + 50);
    expect(setItem).not.toHaveBeenCalled();
  });

  it('pagehide flushes a pending write at once', async () => {
    const handle = mount(session([A, B], A));
    userEvent(handle.workspace, 'pointerdown');
    act(() => handle.dispatch({ type: 'replaceLayout', layout: SPLIT }));
    await settle(10);
    expect(raw()).toBeNull();
    window.dispatchEvent(new Event('pagehide'));
    expect(readDock(BASE)?.layout).toEqual(SPLIT);
  });
});
