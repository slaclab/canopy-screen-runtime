// Workspace tab model: canonical tab keys, the open/focus/close reducer,
// the load rules that merge stored tabs with the URL, and the
// guarded sessionStorage round trip under `canopy-viewer:tabs`. The tool
// instance rules (per-instance state, toolMru, the cap, the opening
// rules and the stored instances) are in tabs.tools.test.ts.

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EMPTY_TABS,
  MAX_CLOSED,
  MAX_HISTORY,
  TRACE_KEY,
  hasStoredTabs,
  loadTabs,
  parseTabKey,
  findClosed,
  mintClosedId,
  readTabs,
  reopenClosed,
  stepTabs,
  tabKey,
  tabsReducer,
  tabsStorageKey,
  writeTabs,
  type ClosedAction,
  type ClosedBy,
  type ClosedPanel,
  type TabsAction,
  type TabsState,
} from './tabs.js';

/**
 * The holder with every key in `keys` as a tab of one tile `t1`, showing
 * `active` (null: an empty dock, so `keys` must be empty too).
 */
function state(
  keys: string[],
  active: string | null = keys[0] ?? null,
  traceQuery: string | null = null
): TabsState {
  const toolMru = active !== null && active.startsWith('@') ? [active] : [];
  return {
    keys,
    active,
    layout: active === null ? null : { tile: 't1', tabs: [...keys], showing: active },
    focusedTile: active === null ? null : 't1',
    instances: traceQuery === null ? {} : { '@trace': { query: traceQuery } },
    toolMru,
    history: {},
    closedStack: [],
  };
}

const anyId = expect.any(String) as unknown as string;

/** The closedStack entry of one hidden or showing tab closed from tile t1. */
function tabEntry(
  key: string,
  index: number,
  showing = false,
  panels: Record<string, ClosedPanel> = {},
  closedBy: ClosedBy = 'you'
): ClosedAction {
  return { kind: 'tab', key, tile: 't1', index, showing, id: anyId, closedBy, panels };
}

/** The closedStack entry of tile t1 closed with its only tab. */
function tileEntry(key: string, panels: Record<string, ClosedPanel> = {}): ClosedAction {
  return {
    kind: 'tile',
    tile: 't1',
    tabs: [key],
    showing: key,
    neighbour: null,
    side: null,
    id: anyId,
    closedBy: 'you',
    panels,
  };
}

/** The closedStack entry of a group close within tile t1: [key, index, showing?]. */
function tabsEntry(...records: [string, number, boolean?][]): ClosedAction {
  return {
    kind: 'tabs',
    records: records.map(([key, index, showing]) => ({
      kind: 'tab' as const,
      key,
      tile: 't1',
      index,
      showing: showing === true,
    })),
    id: anyId,
    closedBy: 'you',
    panels: {},
  };
}

describe('tabKey', () => {
  it('is category/id without a query', () => {
    expect(tabKey('bts', 'overview')).toBe('bts/overview');
    expect(tabKey('bts', 'overview', '')).toBe('bts/overview');
  });

  it('keeps slashes inside the id', () => {
    expect(tabKey('bts', 'sub/panel')).toBe('bts/sub/panel');
  });

  it('strips embedded, theme, mode and _canopy* parameters', () => {
    expect(
      tabKey('bts', 'a', 'embedded=1&theme=dark&mode=edit&_canopyZoom=2&_canopyChrome=0')
    ).toBe('bts/a');
  });

  it('sorts the remaining macros by name', () => {
    expect(tabKey('bts', 'a', 'P=IOC:1&M=motor')).toBe(tabKey('bts', 'a', 'M=motor&P=IOC:1'));
    expect(tabKey('bts', 'a', 'P=IOC:1&M=motor')).toBe('bts/a?M=motor&P=IOC%3A1');
  });

  it('accepts a URLSearchParams and a leading "?"', () => {
    expect(tabKey('bts', 'a', new URLSearchParams('P=1&theme=dark'))).toBe('bts/a?P=1');
    expect(tabKey('bts', 'a', '?P=1')).toBe('bts/a?P=1');
  });

  it('keeps the last value of a repeated macro (as macrosFromSearch does)', () => {
    expect(tabKey('bts', 'a', 'P=1&P=2')).toBe('bts/a?P=2');
  });

  it('is case-sensitive about reserved names', () => {
    expect(tabKey('bts', 'a', 'Theme=dark')).toBe('bts/a?Theme=dark');
  });

  it('maps the reserved @trace category to @trace and ignores every query parameter', () => {
    expect(tabKey(TRACE_KEY, '')).toBe('@trace');
    expect(tabKey('@trace', '', 'pv=X&range=-1h&theme=dark')).toBe('@trace');
    expect(tabKey('@trace', 'anything', 'P=1')).toBe('@trace');
  });

  it('round-trips through parseTabKey', () => {
    expect(parseTabKey('bts/sub/panel?M=motor&P=IOC%3A1')).toEqual({
      kind: 'screen',
      category: 'bts',
      id: 'sub/panel',
      macros: { M: 'motor', P: 'IOC:1' },
      query: 'M=motor&P=IOC%3A1',
    });
    expect(parseTabKey('bts/a')).toEqual({
      kind: 'screen',
      category: 'bts',
      id: 'a',
      macros: {},
      query: '',
    });
    expect(parseTabKey('@trace')).toEqual({ kind: 'tool', tool: 'trace', instance: 1 });
    expect(parseTabKey('@correlation/2')).toEqual({
      kind: 'tool',
      tool: 'correlation',
      instance: 2,
    });
  });

  it('parseTabKey rejects keys without a category and id', () => {
    expect(parseTabKey('')).toBeNull();
    expect(parseTabKey('bts')).toBeNull();
    expect(parseTabKey('bts/')).toBeNull();
    expect(parseTabKey('/a')).toBeNull();
  });

  it('parseTabKey rejects unregistered and malformed tool keys', () => {
    expect(parseTabKey('@nope')).toBeNull();
    expect(parseTabKey('@trace/0')).toBeNull();
    expect(parseTabKey('@trace/x')).toBeNull();
  });
});

describe('tabsReducer', () => {
  describe('open replace', () => {
    it('swaps the active key in place', () => {
      const next = tabsReducer(state(['a/1', 'a/2', 'a/3'], 'a/2'), {
        type: 'open',
        key: 'a/9',
        mode: 'replace',
      });
      expect(next.keys).toEqual(['a/1', 'a/9', 'a/3']);
      expect(next.active).toBe('a/9');
    });

    it('appends when there are no tabs', () => {
      const next = tabsReducer(EMPTY_TABS, { type: 'open', key: 'a/1', mode: 'replace' });
      expect(next).toEqual(state(['a/1'], 'a/1'));
    });

    it('appends while @trace is active', () => {
      const next = tabsReducer(state(['a/1', '@trace'], '@trace'), {
        type: 'open',
        key: 'a/2',
        mode: 'replace',
      });
      expect(next.keys).toEqual(['a/1', '@trace', 'a/2']);
      expect(next.active).toBe('a/2');
    });

    it('focuses an already-open key instead of duplicating it', () => {
      const next = tabsReducer(state(['a/1', 'a/2'], 'a/2'), {
        type: 'open',
        key: 'a/1',
        mode: 'replace',
      });
      expect(next.keys).toEqual(['a/1', 'a/2']);
      expect(next.active).toBe('a/1');
    });

    it('treats a different macro query as a different tab', () => {
      const next = tabsReducer(state(['a/1?P=1'], 'a/1?P=1'), {
        type: 'open',
        key: 'a/1?P=2',
        mode: 'append',
      });
      expect(next.keys).toEqual(['a/1?P=1', 'a/1?P=2']);
    });
  });

  describe('open append', () => {
    it('appends at the end and focuses', () => {
      const next = tabsReducer(state(['a/1', 'a/2'], 'a/1'), {
        type: 'open',
        key: 'a/3',
        mode: 'append',
      });
      expect(next.keys).toEqual(['a/1', 'a/2', 'a/3']);
      expect(next.active).toBe('a/3');
    });

    it('focuses an already-open key', () => {
      const next = tabsReducer(state(['a/1', 'a/2'], 'a/2'), {
        type: 'open',
        key: 'a/1',
        mode: 'append',
      });
      expect(next.keys).toEqual(['a/1', 'a/2']);
      expect(next.active).toBe('a/1');
    });
  });

  describe('focus', () => {
    it('activates an open key', () => {
      expect(tabsReducer(state(['a/1', 'a/2'], 'a/1'), { type: 'focus', key: 'a/2' }).active).toBe(
        'a/2'
      );
    });

    it('ignores a key that is not open', () => {
      const before = state(['a/1'], 'a/1');
      expect(tabsReducer(before, { type: 'focus', key: 'a/9' })).toBe(before);
    });
  });

  describe('close', () => {
    it('closing an inactive tab keeps the active one', () => {
      const next = tabsReducer(state(['a/1', 'a/2', 'a/3'], 'a/3'), { type: 'close', key: 'a/1' });
      expect(next).toEqual({ ...state(['a/2', 'a/3'], 'a/3'), closedStack: [tabEntry('a/1', 0)] });
    });

    it('closing the active tab focuses its right neighbour', () => {
      const next = tabsReducer(state(['a/1', 'a/2', 'a/3'], 'a/2'), { type: 'close', key: 'a/2' });
      expect(next.active).toBe('a/3');
    });

    it('closing the last-positioned active tab focuses its left neighbour', () => {
      const next = tabsReducer(state(['a/1', 'a/2', 'a/3'], 'a/3'), { type: 'close', key: 'a/3' });
      expect(next).toEqual({
        ...state(['a/1', 'a/2'], 'a/2'),
        closedStack: [tabEntry('a/3', 2, true)],
      });
    });

    it('closing the only tab leaves no active tab', () => {
      expect(tabsReducer(state(['a/1'], 'a/1'), { type: 'close', key: 'a/1' })).toEqual({
        ...state([], null),
        closedStack: [tileEntry('a/1')],
      });
    });

    it('ignores a key that is not open', () => {
      const before = state(['a/1'], 'a/1');
      expect(tabsReducer(before, { type: 'close', key: 'a/9' })).toBe(before);
    });

    it('keeps the stored trace query when @trace closes', () => {
      const next = tabsReducer(state(['@trace'], '@trace', 'pv=X'), {
        type: 'close',
        key: '@trace',
      });
      expect(next).toEqual({
        ...state([], null, 'pv=X'),
        toolMru: [],
        closedStack: [tileEntry('@trace', { '@trace': { instance: { query: 'pv=X' } } })],
      });
    });
  });

  describe('closeActive', () => {
    it('closes the active tab', () => {
      const next = tabsReducer(state(['a/1', 'a/2'], 'a/1'), { type: 'closeActive' });
      expect(next).toEqual({ ...state(['a/2'], 'a/2'), closedStack: [tabEntry('a/1', 0, true)] });
    });

    it('is a no-op without tabs', () => {
      expect(tabsReducer(EMPTY_TABS, { type: 'closeActive' })).toBe(EMPTY_TABS);
    });
  });

  describe('setQuery', () => {
    it('stores a query for the instance', () => {
      expect(
        tabsReducer(state(['@trace']), { type: 'setQuery', key: '@trace', query: 'pv=X&range=-1h' })
          .instances['@trace']?.query
      ).toBe('pv=X&range=-1h');
    });

    it('ignores a query over 4 KB', () => {
      const before = state(['@trace'], '@trace', 'pv=X');
      expect(
        tabsReducer(before, { type: 'setQuery', key: '@trace', query: 'pv=' + 'x'.repeat(4097) })
      ).toBe(before);
    });
  });

  it('never mutates the previous state', () => {
    const before = state(['a/1', 'a/2'], 'a/1');
    const snapshot = JSON.parse(JSON.stringify(before));
    tabsReducer(before, { type: 'open', key: 'a/3', mode: 'replace' });
    tabsReducer(before, { type: 'close', key: 'a/1' });
    expect(before).toEqual(snapshot);
  });
});

describe('loadTabs', () => {
  const on = { tools: ['trace'] };

  it('restores stored keys and focuses a URL key that is already open', () => {
    const { state: s } = loadTabs(state(['a/1', 'a/2'], 'a/1'), 'a/2', on);
    expect(s).toEqual(state(['a/1', 'a/2'], 'a/2'));
  });

  it('appends a URL key that is not stored (never replaces)', () => {
    const { state: s } = loadTabs(state(['a/1', 'a/2'], 'a/1'), 'a/3', on);
    expect(s.keys).toEqual(['a/1', 'a/2', 'a/3']);
    expect(s.active).toBe('a/3');
  });

  it('bare /embed/ with stored keys focuses the stored active', () => {
    const { state: s } = loadTabs(state(['a/1', 'a/2'], 'a/2'), null, on);
    expect(s.active).toBe('a/2');
  });

  it('bare /embed/ with a stale stored active falls back to the first key', () => {
    const { state: s } = loadTabs(
      {
        keys: ['a/1'],
        active: 'a/9',
        layout: { tile: 't1', tabs: ['a/1'], showing: 'a/1' },
        focusedTile: 't1',
        instances: {},
        toolMru: [],
      },
      null,
      on
    );
    expect(s.active).toBe('a/1');
  });

  it('bare /embed/ without stored keys is empty', () => {
    expect(loadTabs(EMPTY_TABS, null, on)).toEqual({ state: EMPTY_TABS, warnings: [] });
  });

  it('a fresh bare /embed/ with trace enabled opens @trace', () => {
    const { state: s, warnings } = loadTabs(EMPTY_TABS, null, { ...on, fresh: true });
    expect(s).toEqual(state(['@trace'], '@trace'));
    expect(warnings).toEqual([]);
  });

  it('a fresh bare /embed/ without trace stays empty', () => {
    expect(loadTabs(EMPTY_TABS, null, { tools: [], fresh: true }).state).toEqual(EMPTY_TABS);
  });

  it('a fresh URL key opens only that key', () => {
    expect(loadTabs(EMPTY_TABS, 'a/1', { ...on, fresh: true }).state).toEqual(
      state(['a/1'], 'a/1')
    );
  });

  it('a non-fresh bare /embed/ with no stored keys stays empty', () => {
    expect(loadTabs(EMPTY_TABS, null, { ...on, fresh: false }).state).toEqual(EMPTY_TABS);
  });

  it('keeps the stored trace query', () => {
    expect(loadTabs(state(['@trace'], '@trace', 'pv=X'), null, on).state.instances).toEqual({
      '@trace': { query: 'pv=X' },
    });
  });

  it('drops a stored @trace with a warning when trace is not configured', () => {
    const { state: s, warnings } = loadTabs(state(['a/1', '@trace'], '@trace'), null, {
      tools: [],
    });
    expect(s).toEqual(state(['a/1'], 'a/1'));
    expect(warnings).toHaveLength(1);
  });

  it('drops a URL @trace with a warning when trace is not configured', () => {
    const { state: s, warnings } = loadTabs(state(['a/1'], 'a/1'), '@trace', {
      tools: [],
    });
    expect(s).toEqual(state(['a/1'], 'a/1'));
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('opens @trace from the URL when trace is configured', () => {
    const { state: s, warnings } = loadTabs(EMPTY_TABS, '@trace', on);
    expect(s).toEqual(state(['@trace'], '@trace'));
    expect(warnings).toEqual([]);
  });
});

/** What writeTabs stores of a state: never the layout (the dock store holds that). */
function record(s: TabsState) {
  return { keys: s.keys, active: s.active, instances: s.instances, toolMru: s.toolMru };
}

/**
 * What readTabs gives back for a stored non-empty record: `s` without an
 * empty history or closedStack (both are stored only when non-empty).
 */
function reread(s: TabsState): TabsState {
  const { history, closedStack, ...rest } = s;
  const out: TabsState = { ...rest };
  if (history !== undefined && Object.keys(history).length > 0) out.history = history;
  if (closedStack !== undefined && closedStack.length > 0) out.closedStack = closedStack;
  return out;
}

describe('readTabs / writeTabs', () => {
  afterEach(() => {
    try {
      sessionStorage.clear();
    } catch {
      // ignore
    }
    vi.unstubAllGlobals();
  });

  it('uses the canopy-viewer:tabs record, keyed by the mount', () => {
    expect(tabsStorageKey('/')).toBe('canopy-viewer:tabs:/');
  });

  it('keys the record by the mount: two mounts never see each other', () => {
    const alice = state(['a/1']);
    const bob = state(['b/1']);
    writeTabs(alice, '/u/alice/panel/canopy/');
    writeTabs(bob, '/u/bob/panel/canopy');
    expect(readTabs('/u/alice/panel/canopy')).toEqual(reread(alice));
    expect(readTabs('/u/bob/panel/canopy/')).toEqual(reread(bob));
    expect(hasStoredTabs('/u/carol/panel/canopy')).toBe(false);
    expect(readTabs('/u/carol/panel/canopy')).toEqual(EMPTY_TABS);
    expect(JSON.parse(sessionStorage.getItem(tabsStorageKey('/u/alice/panel/canopy'))!)).toEqual(
      record(alice)
    );
  });

  it('the root keeps its own key, untouched by any mount', () => {
    writeTabs(state(['a/1']), '/u/alice/panel/canopy');
    expect(hasStoredTabs()).toBe(false);
    expect(hasStoredTabs('/')).toBe(false);
    expect(readTabs()).toEqual(EMPTY_TABS);
    const root = state(['r/1']);
    writeTabs(root);
    expect(JSON.parse(sessionStorage.getItem(tabsStorageKey('/'))!)).toEqual(record(root));
    expect(readTabs('/u/alice/panel/canopy')).toEqual(reread(state(['a/1'])));
  });

  it('round-trips a state', () => {
    const s = state(['a/1', '@trace', '@correlation/2'], '@trace', 'pv=X&range=-1h');
    s.instances['@correlation/2'] = { query: '', view: 'correlation_v' };
    writeTabs(s);
    // The layout is never stored; read back, the keys are one tile again.
    const { keys, active, instances, toolMru } = s;
    expect(JSON.parse(sessionStorage.getItem(tabsStorageKey('/')) ?? 'null')).toEqual({
      keys,
      active,
      instances,
      toolMru,
    });
    expect(readTabs()).toEqual(reread(s));
  });

  it('hasStoredTabs tells a stored empty set from nothing stored', () => {
    expect(hasStoredTabs()).toBe(false);
    writeTabs(EMPTY_TABS);
    expect(hasStoredTabs()).toBe(true);
  });

  it('hasStoredTabs is false when sessionStorage throws', () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => {
        throw new Error('denied');
      },
    });
    expect(hasStoredTabs()).toBe(false);
  });

  it('reads an empty state when nothing is stored', () => {
    expect(readTabs()).toEqual(EMPTY_TABS);
  });

  it.each([
    ['unparseable JSON', '{nope'],
    ['a non-object', '[1,2]'],
    ['null', 'null'],
    ['keys that are not an array', JSON.stringify({ keys: 'a/1', active: 'a/1', instances: {} })],
  ])('reads an empty state from %s', (_label, raw) => {
    sessionStorage.setItem(tabsStorageKey('/'), raw);
    expect(readTabs()).toEqual(EMPTY_TABS);
  });

  it('drops non-string and duplicate keys', () => {
    sessionStorage.setItem(
      tabsStorageKey('/'),
      JSON.stringify({ keys: ['a/1', 3, 'a/1', '', 'a/2'], active: 'a/2' })
    );
    expect(readTabs()).toEqual(reread(state(['a/1', 'a/2'], 'a/2')));
  });

  it('shows the first key when the stored active is not among the keys', () => {
    sessionStorage.setItem(tabsStorageKey('/'), JSON.stringify({ keys: ['a/1'], active: 'a/9' }));
    expect(readTabs().active).toBe('a/1');
    expect(readTabs().layout).toEqual({ tile: 't1', tabs: ['a/1'], showing: 'a/1' });
  });

  it('defaults an invalid or oversized instance query to null (the config default)', () => {
    sessionStorage.setItem(
      tabsStorageKey('/'),
      JSON.stringify({ keys: [], active: null, instances: { '@trace': { query: 7 } } })
    );
    expect(readTabs().instances['@trace']?.query).toBeNull();
    sessionStorage.setItem(
      tabsStorageKey('/'),
      JSON.stringify({
        keys: [],
        active: null,
        instances: { '@trace': { query: 'pv=' + 'x'.repeat(4097) } },
      })
    );
    expect(readTabs().instances['@trace']?.query).toBeNull();
  });

  it('survives a missing sessionStorage', () => {
    vi.stubGlobal('sessionStorage', undefined);
    expect(readTabs()).toEqual(EMPTY_TABS);
    expect(() => writeTabs(state(['a/1']))).not.toThrow();
  });

  it('survives a throwing sessionStorage', () => {
    const throwing = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
    };
    vi.stubGlobal('sessionStorage', throwing);
    expect(readTabs()).toEqual(EMPTY_TABS);
    expect(() => writeTabs(state(['a/1']))).not.toThrow();
  });
});

function apply(start: TabsState, ...actions: TabsAction[]): TabsState {
  return actions.reduce(tabsReducer, start);
}

/** `n` replace opens of `a/1`..`a/n` into the active slot, from `a/0`. */
function replaced(n: number): TabsState {
  let s = state(['a/0'], 'a/0');
  for (let i = 1; i <= n; i += 1)
    s = tabsReducer(s, { type: 'open', key: `a/${i}`, mode: 'replace' });
  return s;
}

describe('per-slot history', () => {
  it('EMPTY_TABS carries an empty history and closedStack', () => {
    expect(EMPTY_TABS.history).toEqual({});
    expect(EMPTY_TABS.closedStack).toEqual([]);
  });

  it('a screen replace pushes the replaced key onto the new key, in the same swap', () => {
    const s = tabsReducer(state(['a/1', 'a/2'], 'a/2'), {
      type: 'open',
      key: 'b/1',
      mode: 'replace',
    });
    expect(s.keys).toEqual(['a/1', 'b/1']);
    expect(s.history).toEqual({ 'b/1': { back: ['a/2'], forward: [] } });
  });

  it('carries the replaced slot back stack over and clears forward', () => {
    let s = apply(
      state(['a/1'], 'a/1'),
      { type: 'open', key: 'a/2', mode: 'replace' },
      { type: 'open', key: 'a/3', mode: 'replace' },
      { type: 'historyBack', key: 'a/3' }
    );
    expect(s.history).toEqual({ 'a/2': { back: ['a/1'], forward: ['a/3'] } });
    s = tabsReducer(s, { type: 'open', key: 'a/9', mode: 'replace' });
    expect(s.history).toEqual({ 'a/9': { back: ['a/1', 'a/2'], forward: [] } });
  });

  it(`caps the back stack at ${MAX_HISTORY}, dropping the oldest`, () => {
    const s = replaced(MAX_HISTORY + 2);
    const back = s.history![`a/${MAX_HISTORY + 2}`]!.back;
    expect(back).toHaveLength(MAX_HISTORY);
    expect(back[0]).toBe('a/2');
    expect(back[MAX_HISTORY - 1]).toBe(`a/${MAX_HISTORY + 1}`);
  });

  it(`caps the forward stack at ${MAX_HISTORY}`, () => {
    let s = replaced(MAX_HISTORY + 2);
    for (let i = 0; i < MAX_HISTORY + 2; i += 1) {
      s = tabsReducer(s, { type: 'historyBack', key: s.active! });
    }
    const entry = s.history![s.active!]!;
    expect(entry.back).toEqual([]);
    expect(entry.forward).toHaveLength(MAX_HISTORY);
  });

  it('an append records nothing', () => {
    const s = tabsReducer(state(['a/1'], 'a/1'), { type: 'open', key: 'a/2', mode: 'append' });
    expect(s.history).toEqual({});
  });

  it('a tool replacing a screen gains no history and the screen history goes', () => {
    const s = apply(
      state(['a/1'], 'a/1'),
      { type: 'open', key: 'a/2', mode: 'replace' },
      { type: 'open', key: '@trace', mode: 'replace' }
    );
    expect(s.keys).toEqual(['@trace']);
    expect(s.history).toEqual({});
  });

  it('a screen opened over a tool appends and records nothing', () => {
    const s = tabsReducer(state(['@trace'], '@trace'), {
      type: 'open',
      key: 'a/1',
      mode: 'replace',
    });
    expect(s.keys).toEqual(['@trace', 'a/1']);
    expect(s.history).toEqual({});
  });

  it('a Trace load is not recorded', () => {
    const before = tabsReducer(state(['a/1'], 'a/1'), {
      type: 'open',
      key: 'a/2',
      mode: 'replace',
    });
    const s = apply(
      before,
      { type: 'load', key: '@trace', query: 'pv=A', view: null },
      { type: 'load', key: '@trace', query: 'pv=B', view: null }
    );
    expect(s.history).toEqual(before.history);
    expect(s.history!['@trace']).toBeUndefined();
  });

  it('historyBack swaps the slot in place and focuses it; historyForward returns', () => {
    const start = tabsReducer(state(['x/1', 'a/1', 'x/2'], 'a/1'), {
      type: 'open',
      key: 'a/2',
      mode: 'replace',
    });
    const back = tabsReducer(start, { type: 'historyBack', key: 'a/2' });
    expect(back.keys).toEqual(['x/1', 'a/1', 'x/2']);
    expect(back.active).toBe('a/1');
    expect(back.history).toEqual({ 'a/1': { back: [], forward: ['a/2'] } });
    const forward = tabsReducer(back, { type: 'historyForward', key: 'a/1' });
    expect(forward.keys).toEqual(['x/1', 'a/2', 'x/2']);
    expect(forward.active).toBe('a/2');
    expect(forward.history).toEqual({ 'a/2': { back: ['a/1'], forward: [] } });
  });

  it('historyBack to a key open elsewhere focuses it and removes the entry', () => {
    const s = apply(
      state(['a/1'], 'a/1'),
      { type: 'open', key: 'a/2', mode: 'replace' },
      { type: 'open', key: 'a/1', mode: 'append' }
    );
    expect(s.keys).toEqual(['a/2', 'a/1']);
    const next = tabsReducer(s, { type: 'historyBack', key: 'a/2' });
    expect(next.keys).toEqual(['a/2', 'a/1']);
    expect(next.active).toBe('a/1');
    expect(next.history).toEqual({});
  });

  it('historyForward to a key open elsewhere focuses it and removes the entry', () => {
    const s = apply(
      state(['a/1'], 'a/1'),
      { type: 'open', key: 'a/2', mode: 'replace' },
      { type: 'historyBack', key: 'a/2' },
      { type: 'open', key: 'a/2', mode: 'append' }
    );
    expect(s.keys).toEqual(['a/1', 'a/2']);
    const next = tabsReducer(s, { type: 'historyForward', key: 'a/1' });
    expect(next.keys).toEqual(['a/1', 'a/2']);
    expect(next.active).toBe('a/2');
    expect(next.history!['a/1']).toBeUndefined();
  });

  it('Back or Forward with nothing to go to, on a tool or a closed key, changes nothing', () => {
    const s = tabsReducer(state(['a/1', '@trace'], 'a/1'), {
      type: 'open',
      key: 'a/2',
      mode: 'replace',
    });
    expect(tabsReducer(s, { type: 'historyForward', key: 'a/2' })).toBe(s);
    expect(tabsReducer(s, { type: 'historyBack', key: '@trace' })).toBe(s);
    expect(tabsReducer(s, { type: 'historyBack', key: 'a/9' })).toBe(s);
    expect(tabsReducer(state(['a/1']), { type: 'historyBack', key: 'a/1' })).toEqual(
      state(['a/1'])
    );
  });

  it('closing a tab drops its history from the open set', () => {
    const s = apply(
      state(['a/1', 'b/1'], 'a/1'),
      { type: 'open', key: 'a/2', mode: 'replace' },
      { type: 'close', key: 'a/2' }
    );
    expect(s.history).toEqual({});
  });

  it('a replace pushes nothing onto closedStack', () => {
    const s = replaced(3);
    expect(s.closedStack).toEqual([]);
  });
});

describe('closedStack (engine close records)', () => {
  it('close and closeActive each push one entry', () => {
    const s = apply(
      state(['a/1', 'a/2', 'a/3'], 'a/1'),
      { type: 'close', key: 'a/3' },
      { type: 'closeActive' }
    );
    expect(s.closedStack).toEqual([tabEntry('a/3', 2), tabEntry('a/1', 0, true)]);
  });

  it('closes a screen with its history', () => {
    const s = apply(
      state(['a/1', 'b/1'], 'a/1'),
      { type: 'open', key: 'a/2', mode: 'replace' },
      { type: 'close', key: 'a/2' }
    );
    expect(s.closedStack).toEqual([
      tabEntry('a/2', 0, true, { 'a/2': { history: { back: ['a/1'], forward: [] } } }),
    ]);
  });

  it('closes a tool with its instance state, never its epoch', () => {
    const s = apply(
      state(['a/1'], 'a/1'),
      { type: 'newInstance', tool: 'trace', query: 'pv=A', view: 'v' },
      { type: 'close', key: '@trace' }
    );
    expect(s.closedStack).toEqual([
      tabEntry('@trace', 1, true, { '@trace': { instance: { query: 'pv=A', view: 'v' } } }),
    ]);
  });

  it("closeOthers closes the tile's other tabs as one entry and shows the kept one", () => {
    const s = tabsReducer(state(['a/1', 'a/2', 'a/3'], 'a/1'), { type: 'closeOthers', key: 'a/2' });
    expect(s.keys).toEqual(['a/2']);
    expect(s.active).toBe('a/2');
    expect(s.layout).toEqual({ tile: 't1', tabs: ['a/2'], showing: 'a/2' });
    expect(s.closedStack).toEqual([tabsEntry(['a/1', 0, true], ['a/3', 2])]);
  });

  it('closeToRight closes the tabs right of the key as one entry', () => {
    const s = tabsReducer(state(['a/1', 'a/2', 'a/3', 'a/4'], 'a/4'), {
      type: 'closeToRight',
      key: 'a/2',
    });
    expect(s.keys).toEqual(['a/1', 'a/2']);
    expect(s.active).toBe('a/2');
    expect(s.closedStack).toEqual([tabsEntry(['a/3', 2], ['a/4', 3, true])]);
  });

  it('closeAll closes the whole dock as one layout entry', () => {
    const before = state(['a/1', 'a/2'], 'a/2');
    const s = tabsReducer(before, { type: 'closeAll' });
    expect(s.keys).toEqual([]);
    expect(s.active).toBeNull();
    expect(s.layout).toBeNull();
    expect(s.focusedTile).toBeNull();
    expect(s.closedStack).toEqual([
      { kind: 'layout', layout: before.layout, id: anyId, closedBy: 'you', panels: {} },
    ]);
    const back = tabsReducer(s, { type: 'reopenClosed' });
    expect(back.layout).toEqual(before.layout);
    expect(back.active).toBe('a/2');
    expect(back.closedStack).toEqual([]);
  });

  it('a close that closes nothing pushes nothing', () => {
    const s = state(['a/1', 'a/2'], 'a/2');
    expect(tabsReducer(s, { type: 'closeToRight', key: 'a/2' })).toBe(s);
    expect(tabsReducer(s, { type: 'closeOthers', key: 'a/9' })).toBe(s);
    expect(tabsReducer(s, { type: 'closeTile', tile: 't9' })).toBe(s);
    expect(tabsReducer(EMPTY_TABS, { type: 'closeAll' })).toBe(EMPTY_TABS);
  });

  it('focus pushes nothing', () => {
    const s = tabsReducer(state(['a/1', 'a/2'], 'a/1'), { type: 'focus', key: 'a/2' });
    expect(s.closedStack).toEqual([]);
  });

  it(`keeps the newest ${MAX_CLOSED} entries`, () => {
    let s = state([], null);
    for (let i = 0; i < MAX_CLOSED + 2; i += 1) {
      s = apply(s, { type: 'open', key: `a/${i}`, mode: 'append' }, { type: 'closeActive' });
    }
    expect(s.closedStack).toHaveLength(MAX_CLOSED);
    expect(s.closedStack![0]).toEqual(tileEntry('a/2'));
    expect(s.closedStack![MAX_CLOSED - 1]).toEqual(tileEntry(`a/${MAX_CLOSED + 1}`));
  });

  // A reopened tab returns at its old index in its tile.
  it('reopenClosed re-inserts the last closed screen at its index with its history and shows it', () => {
    const closedState = apply(
      state(['a/1', 'b/1'], 'a/1'),
      { type: 'open', key: 'a/2', mode: 'replace' },
      { type: 'close', key: 'a/2' }
    );
    const s = tabsReducer(closedState, { type: 'reopenClosed' });
    expect(s.keys).toEqual(['a/2', 'b/1']);
    expect(s.active).toBe('a/2');
    expect(s.history).toEqual({ 'a/2': { back: ['a/1'], forward: [] } });
    expect(s.closedStack).toEqual([]);
    expect(tabsReducer(s, { type: 'historyBack', key: 'a/2' }).keys).toEqual(['a/1', 'b/1']);
  });

  it('reopenClosed pops one entry at a time and reopens a whole group', () => {
    const s = apply(
      state(['a/1', 'a/2', 'a/3'], 'a/1'),
      { type: 'close', key: 'a/1' },
      { type: 'closeOthers', key: 'a/3' },
      { type: 'reopenClosed' }
    );
    expect(s.keys).toEqual(['a/2', 'a/3']);
    expect(s.closedStack).toEqual([tabEntry('a/1', 0, true)]);
    expect(tabsReducer(s, { type: 'reopenClosed' }).keys).toEqual(['a/1', 'a/2', 'a/3']);
  });

  it('reopenClosed shows a screen that is open again instead of duplicating it', () => {
    const s = apply(
      state(['a/1', 'a/2'], 'a/2'),
      { type: 'close', key: 'a/1' },
      { type: 'open', key: 'a/1', mode: 'append' },
      { type: 'focus', key: 'a/2' },
      { type: 'reopenClosed' }
    );
    expect(s.keys).toEqual(['a/2', 'a/1']);
    expect(s.active).toBe('a/1');
  });

  it('reopenClosed brings a tool back as a new instance at a fresh id', () => {
    const s = apply(
      state(['a/1'], 'a/1'),
      { type: 'newInstance', tool: 'correlation', query: 'x=A&y=B', view: 'c' },
      { type: 'newInstance', tool: 'correlation' },
      { type: 'close', key: '@correlation' },
      { type: 'newInstance', tool: 'correlation' },
      { type: 'reopenClosed' }
    );
    // @correlation went to the blank instance opened after the close, so
    // the reopened entry takes the next free id, at its old index.
    expect(s.keys).toEqual(['a/1', '@correlation/3', '@correlation/2', '@correlation']);
    expect(s.active).toBe('@correlation/3');
    expect(s.instances['@correlation/3']).toMatchObject({ query: 'x=A&y=B', view: 'c' });
    expect(s.instances['@correlation/3']!.epoch).toBeGreaterThan(0);
    expect(s.toolMru[0]).toBe('@correlation/3');
  });

  it(`reopenClosed skips tool entries at MAX_TOOL_INSTANCES and names them once`, () => {
    let s = state(['a/1'], 'a/1');
    for (let i = 0; i < 10; i += 1) s = tabsReducer(s, { type: 'newInstance', tool: 'trace' });
    s = apply(s, { type: 'closeOthers', key: 'a/1' }, { type: 'open', key: 'b/1', mode: 'append' });
    for (let i = 0; i < 9; i += 1) s = tabsReducer(s, { type: 'newInstance', tool: 'trace' });
    const result = reopenClosed(s);
    expect(result.skipped).toHaveLength(9);
    expect(stepTabs(s, { type: 'reopenClosed' }).skipped).toHaveLength(9);
    const next = tabsReducer(s, { type: 'reopenClosed' });
    expect(next.keys.filter((k) => k.startsWith('@trace'))).toHaveLength(10);
    expect(next.closedStack).toEqual([]);
  });

  it('reopenClosed with nothing closed changes nothing', () => {
    const s = state(['a/1']);
    expect(tabsReducer(s, { type: 'reopenClosed' })).toBe(s);
    expect(reopenClosed(s).skipped).toEqual([]);
  });
});

describe('history and closedStack persistence', () => {
  afterEach(() => {
    sessionStorage.clear();
  });

  function withBoth(): TabsState {
    return apply(
      state(['a/1', 'b/1'], 'a/1'),
      { type: 'open', key: 'a/2', mode: 'replace' },
      { type: 'load', key: '@trace/2', query: 'pv=A', view: 'v' },
      { type: 'close', key: '@trace/2' },
      { type: 'close', key: 'b/1' }
    );
  }

  it('writeTabs stores history and closedStack (no epoch), readTabs reads them back', () => {
    const s = withBoth();
    writeTabs(s);
    const raw = JSON.parse(sessionStorage.getItem(tabsStorageKey('/'))!);
    expect(raw.history).toEqual({ 'a/2': { back: ['a/1'], forward: [] } });
    const [first, second] = s.closedStack!;
    expect(raw.closedStack).toEqual([
      {
        kind: 'tab',
        key: '@trace/2',
        tile: 't1',
        index: 2,
        showing: true,
        id: first!.id,
        closedBy: 'you',
        panels: { '@trace/2': { instance: { query: 'pv=A', view: 'v' } } },
      },
      {
        kind: 'tab',
        key: 'b/1',
        tile: 't1',
        index: 1,
        // Closing the showing @trace/2 (last) showed its left neighbour b/1.
        showing: true,
        id: second!.id,
        closedBy: 'you',
        panels: {},
      },
    ]);
    const back = readTabs();
    expect(back.history).toEqual(s.history);
    expect(back.closedStack).toEqual(s.closedStack);
  });

  it('writeTabs omits an empty history and closedStack', () => {
    writeTabs(state(['a/1']));
    const raw = JSON.parse(sessionStorage.getItem(tabsStorageKey('/'))!);
    expect('history' in raw).toBe(false);
    expect('closedStack' in raw).toBe(false);
  });

  it('writeTabs -> readTabs -> loadTabs keeps both for the stored keys', () => {
    const s = withBoth();
    writeTabs(s);
    const { state: loaded } = loadTabs(readTabs(), null, { tools: ['trace'] });
    expect(loaded.keys).toEqual(['a/2']);
    expect(loaded.history).toEqual({ 'a/2': { back: ['a/1'], forward: [] } });
    expect(loaded.closedStack).toEqual(s.closedStack);
    expect(tabsReducer(loaded, { type: 'reopenClosed' }).keys).toEqual(['a/2', 'b/1']);
  });

  it('loadTabs drops history whose key is not a stored key', () => {
    const stored = {
      ...state(['a/1'], 'a/1'),
      history: { 'a/9': { back: ['a/8'], forward: [] } },
    };
    expect(loadTabs(stored, null, { tools: [] }).state.history).toEqual({});
  });

  it('parseStored drops history of unstored keys, tool keys and bad entries', () => {
    sessionStorage.setItem(
      tabsStorageKey('/'),
      JSON.stringify({
        keys: ['a/1', 'a/2', '@trace'],
        active: 'a/1',
        history: {
          'a/1': { back: ['x/1', 7, '@trace', 'bad'], forward: 'nope' },
          'a/2': { back: [], forward: [] },
          'a/9': { back: ['x/1'], forward: [] },
          '@trace': { back: ['x/1'], forward: [] },
        },
        closedStack: [
          {
            kind: 'tab',
            key: 'b/1',
            tile: 't2',
            index: 0,
            showing: true,
            panels: {
              'b/1': { history: { back: ['b/0'] } },
              'z/1': { history: { back: ['z/0'] } },
            },
          },
          {
            kind: 'tile',
            tile: 't3',
            tabs: ['@trace/1', '@nope', 3],
            showing: '@nope',
            neighbour: 't1',
            side: 'up',
            panels: { '@trace/1': { instance: { query: 'pv=Z', epoch: 4 } } },
          },
          { kind: 'tabs', records: [] },
          { kind: 'tab', key: 3, tile: 't1', index: 0 },
          { kind: 'layout', layout: { tile: 't1', tabs: [], showing: 'x' } },
          'junk',
        ],
      })
    );
    const s = readTabs();
    expect(s.history).toEqual({ 'a/1': { back: ['x/1'], forward: [] } });
    expect(s.closedStack).toEqual([
      {
        kind: 'tab',
        key: 'b/1',
        tile: 't2',
        index: 0,
        showing: true,
        id: anyId,
        closedBy: 'you',
        panels: { 'b/1': { history: { back: ['b/0'], forward: [] } } },
      },
      {
        kind: 'tile',
        tile: 't3',
        tabs: ['@trace'],
        showing: '@trace',
        neighbour: 't1',
        side: null,
        id: anyId,
        closedBy: 'you',
        panels: { '@trace': { instance: { query: 'pv=Z' } } },
      },
    ]);
  });

  // A stored tile record keeps its share so reopen restores its size; a
  // missing or bad one is dropped and reopen halves the neighbour.
  it('parseStored keeps a tile record share and drops a bad one', () => {
    const tile = (tile: string, share: unknown) => ({
      kind: 'tile',
      tile,
      tabs: [`${tile}/1`],
      showing: `${tile}/1`,
      neighbour: 't9',
      side: 'left',
      ...(share === undefined ? {} : { share }),
    });
    sessionStorage.setItem(
      tabsStorageKey('/'),
      JSON.stringify({
        keys: ['a/1'],
        active: 'a/1',
        closedStack: [tile('t1', 0.35), tile('t2', 1.5), tile('t3', 'x'), tile('t4', undefined)],
      })
    );
    const stack = readTabs().closedStack!;
    expect(stack.map((e) => (e.kind === 'tile' ? e.share : 'not a tile'))).toEqual([
      0.35,
      undefined,
      undefined,
      undefined,
    ]);
    expect(stack.filter((e) => e.kind === 'tile' && 'share' in e)).toHaveLength(1);
  });

  it(`parseStored keeps the newest ${MAX_HISTORY} history keys and ${MAX_CLOSED} entries`, () => {
    const many = Array.from({ length: 15 }, (_, i) => `x/${i}`);
    sessionStorage.setItem(
      tabsStorageKey('/'),
      JSON.stringify({
        keys: ['a/1'],
        active: 'a/1',
        history: { 'a/1': { back: many, forward: many } },
        closedStack: many.map((key) => ({ kind: 'tab', key, tile: 't1', index: 0 })),
      })
    );
    const s = readTabs();
    expect(s.history!['a/1']!.back).toEqual(many.slice(-MAX_HISTORY));
    expect(s.history!['a/1']!.forward).toEqual(many.slice(-MAX_HISTORY));
    expect(s.closedStack).toHaveLength(MAX_CLOSED);
    expect(s.closedStack![0]).toEqual(tabEntry('x/5', 0));
  });
});

describe('one undo store: ids, closers, single and group records', () => {
  afterEach(() => {
    sessionStorage.clear();
  });

  const ids = (s: TabsState) => (s.closedStack ?? []).map((entry) => entry.id);

  it('every close records an id and its closer (default you)', () => {
    const s = apply(
      state(['a/1', 'a/2', 'a/3'], 'a/1'),
      { type: 'close', key: 'a/2', closed: { id: 'g-1', closedBy: 'agent' } },
      { type: 'closeActive' }
    );
    expect(s.closedStack).toEqual([
      { ...tabEntry('a/2', 1, false, {}, 'agent'), id: 'g-1' },
      tabEntry('a/1', 0, true),
    ]);
    expect(ids(s)[1]).toMatch(/^u-/);
  });

  it('never holds two entries under one id, minted or given', () => {
    let s = state([], null);
    for (let i = 0; i < 25; i += 1) {
      s = apply(s, { type: 'open', key: `a/${i}`, mode: 'append' }, { type: 'closeActive' });
    }
    s = apply(
      s,
      { type: 'open', key: 'b/1', mode: 'append' },
      { type: 'close', key: 'b/1', closed: { id: ids(s)[0] } }
    );
    expect(new Set(ids(s)).size).toBe(MAX_CLOSED);
    const taken = s.closedStack!;
    expect(taken.map((e) => e.id)).not.toContain(mintClosedId(taken));
  });

  it('reopenClosed(id) restores that entry and leaves the newer ones', () => {
    const s = apply(
      state(['a/1', 'a/2', 'a/3'], 'a/3'),
      { type: 'close', key: 'a/1', closed: { id: 'agent-1', closedBy: 'agent' } },
      { type: 'close', key: 'a/2', closed: { id: 'you-1' } }
    );
    expect(findClosed(s)?.id).toBe('you-1');
    expect(findClosed(s, 'agent-1')?.closedBy).toBe('agent');
    const next = tabsReducer(s, { type: 'reopenClosed', id: 'agent-1' });
    expect(next.keys).toEqual(['a/1', 'a/3']);
    expect(ids(next)).toEqual(['you-1']);
    // The operator's later close stands; its own reopen puts a/2 back at the
    // index it had then (0) and does not duplicate a/1.
    expect(tabsReducer(next, { type: 'reopenClosed' }).keys).toEqual(['a/2', 'a/1', 'a/3']);
  });

  it('reopenClosed with an unknown id changes nothing', () => {
    const s = tabsReducer(state(['a/1', 'a/2'], 'a/1'), { type: 'close', key: 'a/2' });
    expect(tabsReducer(s, { type: 'reopenClosed', id: 'nope' })).toBe(s);
    expect(reopenClosed(s, 'nope')).toEqual({ state: s, skipped: [], reopened: [] });
  });

  it('clamps an old index past the end of the tile', () => {
    const s = apply(
      state(['a/1', 'a/2', 'a/3'], 'a/1'),
      { type: 'close', key: 'a/3' },
      { type: 'closeOthers', key: 'a/1' },
      { type: 'reopenClosed', id: undefined }
    );
    // a/2 is back at 1; a/3's entry (index 2) is still on the stack.
    expect(s.keys).toEqual(['a/1', 'a/2']);
    const t = tabsReducer(tabsReducer(s, { type: 'close', key: 'a/2' }), {
      type: 'reopenClosed',
      id: ids(s)[0],
    });
    expect(t.keys).toEqual(['a/1', 'a/3']);
  });

  it('a tool keeps its instance number when that is free', () => {
    const s = apply(
      state(['a/1'], 'a/1'),
      { type: 'newInstance', tool: 'trace', query: 'pv=A' },
      { type: 'newInstance', tool: 'trace', query: 'pv=B' },
      { type: 'open', key: 'a/2', mode: 'append' },
      { type: 'close', key: '@trace/2' },
      { type: 'reopenClosed' }
    );
    expect(s.keys).toEqual(['a/1', '@trace', '@trace/2', 'a/2']);
    expect(s.instances['@trace/2']).toMatchObject({ query: 'pv=B' });
    expect(s.active).toBe('@trace/2');
  });

  it('reopenClosed reports what came back under which key', () => {
    const s = apply(
      state(['a/1', '@trace'], 'a/1'),
      { type: 'closeOthers', key: 'a/1' },
      { type: 'open', key: '@trace', mode: 'append' }
    );
    expect(reopenClosed(s).reopened).toEqual([{ key: '@trace', as: '@trace/2' }]);
  });

  it('round-trips ids, closers and group records through the session record', () => {
    const s = apply(state(['a/1', 'a/2', 'a/3'], 'a/1'), {
      type: 'closeToRight',
      key: 'a/1',
      closed: { id: 'g-7', closedBy: 'agent' },
    });
    writeTabs(s);
    expect(JSON.parse(sessionStorage.getItem(tabsStorageKey('/'))!).closedStack).toEqual([
      {
        kind: 'tabs',
        records: [
          { kind: 'tab', key: 'a/2', tile: 't1', index: 1, showing: false },
          { kind: 'tab', key: 'a/3', tile: 't1', index: 2, showing: false },
        ],
        id: 'g-7',
        closedBy: 'agent',
        panels: {},
      },
    ]);
    expect(readTabs().closedStack).toEqual(s.closedStack);
  });

  it('a layout entry is stored and read back', () => {
    const s = tabsReducer(state(['a/1', 'a/2'], 'a/1'), { type: 'closeAll', closed: { id: 'L1' } });
    writeTabs(s);
    expect(readTabs().closedStack).toEqual(s.closedStack);
  });

  it('drops the records from before the layout holder; a duplicate id gets a fresh one', () => {
    sessionStorage.setItem(
      tabsStorageKey('/'),
      JSON.stringify({
        keys: ['a/1', 'a/2'],
        active: 'a/1',
        closedStack: [
          { tabs: [{ key: 'b/1' }] },
          { id: 'old', closedBy: 'agent', tabs: [{ key: 'b/4', index: 0 }] },
          { id: 'L', kind: 'layout', grid: {} },
          { id: 'dup', kind: 'tab', key: 'b/2', tile: 't1', index: 1 },
          { id: 'dup', closedBy: 'agent', kind: 'tab', key: 'b/3', tile: 't1', index: 0 },
        ],
      })
    );
    const s = readTabs();
    expect(s.closedStack).toEqual([
      { ...tabEntry('b/2', 1), id: 'dup' },
      tabEntry('b/3', 0, false, {}, 'agent'),
    ]);
    expect(ids(s)[1]).not.toBe('dup');
  });
});
