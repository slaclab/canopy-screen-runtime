// The tabs reducer as the CANOPY layout holder (the dock layout plus the
// focused tile). After every action the holder keeps: a valid layout (or null),
// `keys` = keysOf(layout), a focused tile that exists (null exactly for an
// empty dock) and `active` = that tile's showing tab. Every action maps to one
// engine operation; drop, focusTile, closeTile, openSet, replaceLayout,
// restore and resized are the holder's own actions, and one-tile
// (chrome-off) mode keeps the dock to one tile.

import { describe, expect, it } from 'vitest';
import { keysOf, tileIdsOf, validateLayout } from '@slaclab/canopy-dock-engine';
import {
  DEFAULT_DOCK_PX,
  EMPTY_TABS,
  NO_DOCK,
  tabsStorageKey,
  TOO_MANY_FOR_SIDE,
  fromLayout,
  loadTabs,
  readTabs,
  stepTabs,
  tabsReducer,
  writeTabs,
  type Layout,
  type TabsAction,
  type TabsState,
} from './tabs.js';

function expectHolder(s: TabsState): void {
  if (s.layout === null) {
    expect(s.keys).toEqual([]);
    expect(s.focusedTile).toBeNull();
    expect(s.active).toBeNull();
    return;
  }
  expect(validateLayout(s.layout)).toEqual({ valid: true });
  expect(s.keys).toEqual(keysOf(s.layout));
  expect(tileIdsOf(s.layout)).toContain(s.focusedTile);
  const focused = findTile(s.layout, s.focusedTile!);
  expect(s.active).toBe(focused.showing);
}

function findTile(layout: Layout, id: string): { tabs: string[]; showing: string } {
  if ('tile' in layout) {
    if (layout.tile === id) return layout;
    throw new Error(`no tile ${id}`);
  }
  for (const item of layout.items) {
    try {
      return findTile(item, id);
    } catch {
      // next
    }
  }
  throw new Error(`no tile ${id}`);
}

/** Folds `actions`, checking the holder invariants after every step. */
function run(state: TabsState, ...actions: TabsAction[]): TabsState {
  expectHolder(state);
  return actions.reduce((s, action) => {
    const next = tabsReducer(s, action);
    expectHolder(next);
    return next;
  }, state);
}

/** t1 [a/1 a/2] showing a/1 | t2 [b/1], a row of halves. */
const T1: Layout = { tile: 't1', tabs: ['a/1', 'a/2'], showing: 'a/1', size: 0.5 };
const T2: Layout = { tile: 't2', tabs: ['b/1'], showing: 'b/1', size: 0.5 };
const TWO: Layout = { split: 'row', items: [T1, T2] };

const two = (focused: string = 't1'): TabsState => fromLayout(TWO, focused);

describe('the holder', () => {
  it('EMPTY_TABS is an empty dock', () => {
    expect(EMPTY_TABS.layout).toBeNull();
    expect(EMPTY_TABS.focusedTile).toBeNull();
    expectHolder(EMPTY_TABS);
  });

  it('fromLayout derives keys, focus and active; a missing tile falls back to the first', () => {
    const s = two('t2');
    expect(s.keys).toEqual(['a/1', 'a/2', 'b/1']);
    expect(s.active).toBe('b/1');
    expect(fromLayout(TWO, 't9').focusedTile).toBe('t1');
    expectHolder(s);
  });

  it('a first open gives an empty dock one tile t1', () => {
    const s = run(EMPTY_TABS, { type: 'open', key: 'a/1', mode: 'append' });
    expect(s.layout).toEqual({ tile: 't1', tabs: ['a/1'], showing: 'a/1' });
    expect(s.focusedTile).toBe('t1');
  });

  it('a new key opens as the showing tab of the focused tile, no size change (the open rule)', () => {
    const s = run(two('t2'), { type: 'open', key: 'c/1', mode: 'append' });
    expect(s.layout).toEqual({
      split: 'row',
      items: [T1, { tile: 't2', tabs: ['b/1', 'c/1'], showing: 'c/1', size: 0.5 }],
    });
    expect(s.active).toBe('c/1');
  });

  it('an open key is shown where it is and its tile focused', () => {
    const s = run(two('t2'), { type: 'open', key: 'a/2', mode: 'append' });
    expect(s.focusedTile).toBe('t1');
    expect(s.active).toBe('a/2');
    expect(s.keys).toEqual(['a/1', 'a/2', 'b/1']);
  });

  it('a screen replace takes the place of the active key in its own tile (replaceKey)', () => {
    const s = run(two('t2'), { type: 'open', key: 'b/9', mode: 'replace' });
    expect(s.layout).toEqual({
      split: 'row',
      items: [
        { tile: 't1', tabs: ['a/1', 'a/2'], showing: 'a/1', size: 0.5 },
        { tile: 't2', tabs: ['b/9'], showing: 'b/9', size: 0.5 },
      ],
    });
    expect(s.history).toEqual({ 'b/9': { back: ['b/1'], forward: [] } });
    const back = run(s, { type: 'historyBack', key: 'b/9' });
    expect(back.layout).toEqual(TWO);
    expect(back.active).toBe('b/1');
  });

  it('a replace naming a hidden target shows the new key in that slot', () => {
    const s = run(two('t2'), { type: 'open', key: 'a/9', mode: 'replace', target: 'a/2' });
    expect(s.keys).toEqual(['a/1', 'a/9', 'b/1']);
    expect(s.focusedTile).toBe('t1');
    expect(s.active).toBe('a/9');
  });

  it('focusTile focuses a tile; an unknown tile changes nothing', () => {
    const s = two();
    const next = run(s, { type: 'focusTile', tile: 't2' });
    expect(next.active).toBe('b/1');
    expect(tabsReducer(s, { type: 'focusTile', tile: 't9' })).toBe(s);
    expect(tabsReducer(s, { type: 'focusTile', tile: 't1' })).toBe(s);
  });

  it('focusing a tool tab promotes it in toolMru', () => {
    const s = run(fromLayout({ tile: 't1', tabs: ['a/1', '@trace'], showing: 'a/1' }), {
      type: 'focus',
      key: '@trace',
    });
    expect(s.toolMru).toEqual(['@trace']);
  });
});

describe('closes and undo', () => {
  it('closing a focused tile hands focus to the neighbour that took its space', () => {
    const s = run(two('t2'), { type: 'close', key: 'b/1' });
    expect(s.layout).toEqual({ tile: 't1', tabs: ['a/1', 'a/2'], showing: 'a/1' });
    expect(s.focusedTile).toBe('t1');
    expect(s.closedStack).toEqual([
      expect.objectContaining({ kind: 'tile', tile: 't2', neighbour: 't1', side: 'right' }),
    ]);
    // Undo puts the tile back on the side of its neighbour, under its own id.
    const back = run(s, { type: 'reopenClosed' });
    expect(back.layout).toEqual({ split: 'row', items: [T1, { ...T2, from: 't1' }] });
    expect(back.focusedTile).toBe('t2');
  });

  it('closeTile closes a tile with all its tabs as one entry, and one undo restores it', () => {
    const before = two();
    const s = run(before, { type: 'closeTile', tile: 't1' });
    expect(s.keys).toEqual(['b/1']);
    expect(s.closedStack).toHaveLength(1);
    const back = run(s, { type: 'reopenClosed' });
    expect(back.keys).toEqual(['a/1', 'a/2', 'b/1']);
    expect(findTile(back.layout!, 't1')).toMatchObject({ tabs: ['a/1', 'a/2'], showing: 'a/1' });
  });

  it('closeOthers and closeToRight act within the key’s tile', () => {
    const s = run(two(), { type: 'closeOthers', key: 'a/2' });
    expect(s.keys).toEqual(['a/2', 'b/1']);
    const r = run(two(), { type: 'closeToRight', key: 'a/1' });
    expect(r.keys).toEqual(['a/1', 'b/1']);
  });

  it('closeAll is one layout entry and one undo brings the whole dock back', () => {
    const s = run(two('t2'), { type: 'closeAll' });
    expect(s.layout).toBeNull();
    expect(s.closedStack).toHaveLength(1);
    const back = run(s, { type: 'reopenClosed' });
    expect(back.layout).toEqual(TWO);
    expect(back.closedStack).toEqual([]);
  });

  it('reopening a layout entry over a dock records the dock it replaces', () => {
    const s = run(
      two(),
      { type: 'closeAll' },
      { type: 'open', key: 'z/1', mode: 'append' },
      { type: 'reopenClosed' }
    );
    expect(s.layout).toEqual(TWO);
    expect(s.closedStack).toEqual([
      expect.objectContaining({
        kind: 'layout',
        layout: { tile: 't1', tabs: ['z/1'], showing: 'z/1' },
      }),
    ]);
  });
});

describe('drop (planDrop)', () => {
  it('a tab dropped on an edge splits off a new tile, focused', () => {
    const s = run(two(), {
      type: 'drop',
      source: { tab: 'a/2' },
      target: { tile: 't2', edge: 'bottom' },
    });
    expect(s.keys).toEqual(['a/1', 'b/1', 'a/2']);
    expect(s.active).toBe('a/2');
    expect(s.closedStack).toEqual([]);
  });

  it('a new key dropped on a tile centre opens there as a tab', () => {
    const s = run(two(), {
      type: 'drop',
      source: { new: 'c/1' },
      target: { tile: 't2', zone: 'centre' },
    });
    expect(findTile(s.layout!, 't2')).toMatchObject({ tabs: ['b/1', 'c/1'], showing: 'c/1' });
    expect(s.focusedTile).toBe('t2');
  });

  it('a self-drop or an unknown target changes nothing', () => {
    const s = two();
    expect(
      tabsReducer(s, {
        type: 'drop',
        source: { tile: 't2' },
        target: { tile: 't2', zone: 'centre' },
      })
    ).toBe(s);
    expect(
      tabsReducer(s, {
        type: 'drop',
        source: { tab: 'a/1' },
        target: { tile: 't9', zone: 'centre' },
      })
    ).toBe(s);
  });

  it('a whole tile dropped on an outer edge moves the tile', () => {
    const s = run(two(), { type: 'drop', source: { tile: 't1' }, target: { outer: 'right' } });
    expect(s.keys).toEqual(['b/1', 'a/1', 'a/2']);
    expect(s.active).toBe('a/1');
  });

  it('a drop that would leave a tile under 40 px is refused by the engine', () => {
    const s = run(two(), { type: 'resized', dock: { width: 100, height: 60 } });
    expect(s.dockPx).toEqual({ width: 100, height: 60 });
    expect(
      tabsReducer(s, {
        type: 'drop',
        source: { tab: 'a/2' },
        target: { tile: 't2', edge: 'right' },
      })
    ).toBe(s);
  });
});

describe('openSet', () => {
  it('as tabs: one new tile with every member, beside the focused tile', () => {
    const s = run(two('t2'), { type: 'openSet', members: ['c/1', 'c/2', 'b/1'], as: 'tabs' });
    // b/1 is open already, so it is not opened twice.
    expect(findTile(s.layout!, 't3')).toMatchObject({ tabs: ['c/1', 'c/2'], showing: 'c/1' });
    expect(s.focusedTile).toBe('t3');
  });

  it('as side: the focused tile shares its span with the members', () => {
    const s = run(fromLayout({ tile: 't1', tabs: ['a/1'], showing: 'a/1' }), {
      type: 'openSet',
      members: ['c/1', 'c/2'],
      as: 'side',
    });
    expect(tileIdsOf(s.layout)).toEqual(['t1', 't2', 't3']);
    expect(s.dockPx).toBeUndefined();
    expect(DEFAULT_DOCK_PX.width).toBeGreaterThan(120);
  });

  it('as side, too many for an agent: refused, state unchanged; a person gets tabs and a notice', () => {
    const tiny = run(fromLayout({ tile: 't1', tabs: ['a/1'], showing: 'a/1' }), {
      type: 'resized',
      dock: { width: 100, height: 60 },
    });
    const members = ['c/1', 'c/2', 'c/3', 'c/4', 'c/5'];
    const agent = stepTabs(tiny, { type: 'openSet', members, as: 'side', caller: 'agent' });
    expect(agent.refusal).toBe(TOO_MANY_FOR_SIDE);
    expect(agent.state).toBe(tiny);
    const person = stepTabs(tiny, { type: 'openSet', members, as: 'side' });
    expect(person.notice).toBe(TOO_MANY_FOR_SIDE);
    expect(person.state.keys).toEqual(['a/1', ...members]);
    expectHolder(person.state);
  });

  it('as layout: the collection replaces the dock as one undo entry, skipped members pruned', () => {
    const before = two();
    const step = stepTabs(before, {
      type: 'openSet',
      members: ['c/1', 'c/2', 'c/3'],
      as: 'layout',
      collection: { split: 'column', items: [{ tabs: ['c/1', 'c/3'] }, { tabs: ['c/2'] }] },
      skip: ['c/3'],
    });
    expect(step.skipped).toEqual(['c/3']);
    expect(step.state.layout).toEqual({
      split: 'column',
      items: [
        { tile: 't1', tabs: ['c/1'], showing: 'c/1', size: 0.5 },
        { tile: 't2', tabs: ['c/2'], showing: 'c/2', size: 0.5 },
      ],
    });
    expectHolder(step.state);
    expect(step.state.closedStack).toEqual([
      expect.objectContaining({ kind: 'layout', layout: TWO }),
    ]);
    expect(run(step.state, { type: 'reopenClosed' }).layout).toEqual(TWO);
  });

  it('skips tool members over the cap and seeds the instances of the tools it opens', () => {
    const step = stepTabs(EMPTY_TABS, {
      type: 'openSet',
      members: ['@trace', '@nope', 'x'],
      as: 'tabs',
      instances: { '@trace': { query: 'pv=A', from: 'tool:trace?pv=A' as never, title: 'A' } },
    });
    expect(step.state.keys).toEqual(['@trace']);
    expect(step.skipped).toEqual(['@nope', 'x']);
    expect(step.state.instances['@trace']).toMatchObject({ query: 'pv=A', title: 'A' });
  });
});

describe('replaceLayout, restore and resized', () => {
  const ONE: Layout = { tile: 't1', tabs: ['z/1', '@trace'], showing: '@trace' };

  it('replaceLayout replaces the dock as one undo entry', () => {
    const s = run(two(), { type: 'replaceLayout', layout: ONE });
    expect(s.layout).toEqual(ONE);
    expect(s.closedStack).toHaveLength(1);
    expect(run(s, { type: 'reopenClosed' }).layout).toEqual(TWO);
  });

  it('restore puts a saved dock in without an undo entry; an invalid one changes nothing', () => {
    const s = run(EMPTY_TABS, { type: 'restore', layout: TWO, focusedTile: 't2' });
    expect(s.layout).toEqual(TWO);
    expect(s.active).toBe('b/1');
    expect(s.closedStack).toEqual([]);
    const bad = { tile: 't1', tabs: [], showing: 'x' } as unknown as Layout;
    expect(tabsReducer(s, { type: 'restore', layout: bad })).toBe(s);
  });

  it('restore prunes keys that cannot open here', () => {
    const s = run(EMPTY_TABS, {
      type: 'restore',
      layout: { tile: 't1', tabs: ['a/1', '@nope'], showing: '@nope' },
    });
    expect(s.layout).toEqual({ tile: 't1', tabs: ['a/1'], showing: 'a/1' });
  });

  it('resized takes new sizes only; a different tree is ignored', () => {
    const s = two();
    const sized: Layout = {
      split: 'row',
      items: [
        { tile: 't1', tabs: ['a/1', 'a/2'], showing: 'a/1', size: 0.3 },
        { tile: 't2', tabs: ['b/1'], showing: 'b/1', size: 0.7 },
      ],
    };
    const next = run(s, { type: 'resized', layout: sized });
    expect(next.layout).toEqual(sized);
    expect(next.closedStack).toEqual([]);
    expect(tabsReducer(s, { type: 'resized', layout: ONE })).toBe(s);
    expect(tabsReducer(s, { type: 'resized' })).toBe(s);
  });
});

describe('one-tile (chrome-off) mode', () => {
  const single = (): TabsState =>
    ({ ...fromLayout({ tile: 't1', tabs: ['a/1'], showing: 'a/1' }), oneTile: true }) as TabsState;

  it('opens become tabs of the one tile', () => {
    const s = run(
      single(),
      { type: 'open', key: 'a/2', mode: 'append' },
      { type: 'open', key: '@trace', mode: 'append' }
    );
    expect(s.layout).toEqual({ tile: 't1', tabs: ['a/1', 'a/2', '@trace'], showing: '@trace' });
  });

  it('drops and layout-replacing sets are refused as no_dock', () => {
    const s = single();
    const dropped = stepTabs(s, {
      type: 'drop',
      source: { new: 'b/1' },
      target: { tile: 't1', edge: 'right' },
    });
    expect(dropped).toEqual({ state: s, refusal: NO_DOCK });
    const set = stepTabs(s, {
      type: 'openSet',
      members: ['b/1'],
      as: 'layout',
      collection: { tabs: ['b/1'] },
    });
    expect(set).toEqual({ state: s, refusal: NO_DOCK });
    expect(stepTabs(s, { type: 'replaceLayout', layout: TWO })).toEqual({
      state: s,
      refusal: NO_DOCK,
    });
  });

  it('a set as tabs or side stays one tile, showing the first member', () => {
    for (const as of ['tabs', 'side'] as const) {
      const s = run(single(), { type: 'openSet', members: ['b/1', 'b/2'], as });
      expect(tileIdsOf(s.layout)).toHaveLength(1);
      expect(s.keys).toEqual(['a/1', 'b/1', 'b/2']);
      expect(s.active).toBe('b/1');
    }
  });

  it('a restored multi-tile dock collapses into one tile', () => {
    const s = run(single(), { type: 'restore', layout: TWO, focusedTile: 't2' });
    expect(s.layout).toEqual({ tile: 't2', tabs: ['a/1', 'a/2', 'b/1'], showing: 'b/1' });
  });

  it('loadTabs sets the mode', () => {
    const { state } = loadTabs(EMPTY_TABS, 'a/1', { tools: [], oneTile: true });
    expect(state.oneTile).toBe(true);
    expect(
      stepTabs(state, { type: 'drop', source: { tab: 'a/1' }, target: { outer: 'left' } }).refusal
    ).toBe(NO_DOCK);
  });
});

describe('loadTabs with a stored dock', () => {
  const stored = fromLayout({ tile: 't1', tabs: ['a/1', 'a/2', 'b/1'], showing: 'a/2' });

  it('without a stored layout every key is a tab of one tile, showing the stored active', () => {
    const { state } = loadTabs(stored, null, { tools: [] });
    expect(state.layout).toEqual({ tile: 't1', tabs: ['a/1', 'a/2', 'b/1'], showing: 'a/2' });
  });

  it('reload: the stored layout, pruned to the open keys; open keys it lacks join the focused tile', () => {
    const layout: Layout = {
      split: 'row',
      items: [
        { tile: 't1', tabs: ['a/1', 'gone/1'], showing: 'a/1', size: 0.5 },
        { tile: 't2', tabs: ['b/1'], showing: 'b/1', size: 0.5 },
      ],
    };
    const { state } = loadTabs(stored, null, { tools: [], layout: { layout, focusedTile: 't2' } });
    expectHolder(state);
    expect(findTile(state.layout!, 't1').tabs).toEqual(['a/1']);
    expect(findTile(state.layout!, 't2').tabs).toEqual(['b/1', 'a/2']);
    // The session's own active key is shown (where it is).
    expect(state.active).toBe('a/2');
  });

  it('an invalid stored layout is ignored', () => {
    const bad = { tile: 't1', tabs: [] } as unknown as Layout;
    const { state } = loadTabs(stored, null, { tools: [], layout: { layout: bad } });
    expect(state.layout).toEqual({ tile: 't1', tabs: ['a/1', 'a/2', 'b/1'], showing: 'a/2' });
  });

  it('new session: the stored layout is reopened with its tool state', () => {
    const layout: Layout = {
      split: 'column',
      items: [
        { tile: 't1', tabs: ['x/1'], showing: 'x/1', size: 0.5 },
        { tile: 't2', tabs: ['@trace/1'], showing: '@trace/1', size: 0.5 },
      ],
    };
    const { state } = loadTabs(EMPTY_TABS, null, {
      tools: ['trace'],
      reopen: { panels: [{ key: '@trace', query: 'pv=A' }], layout, focusedTile: 't2' },
    });
    expectHolder(state);
    expect(state.keys).toEqual(['x/1', '@trace']);
    expect(state.active).toBe('@trace');
    expect(state.instances['@trace']).toEqual({ query: 'pv=A' });
  });
});

describe('storage', () => {
  it('the layout, focusedTile, dockPx and oneTile are never written to sessionStorage', () => {
    writeTabs({ ...two(), dockPx: { width: 10, height: 10 }, oneTile: true });
    const raw = JSON.parse(sessionStorage.getItem(tabsStorageKey('/'))!);
    expect(Object.keys(raw).sort()).toEqual(['active', 'instances', 'keys', 'toolMru']);
    expect(readTabs().layout).toEqual({ tile: 't1', tabs: ['a/1', 'a/2', 'b/1'], showing: 'a/1' });
    sessionStorage.clear();
  });
});
