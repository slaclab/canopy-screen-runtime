// The two load paths of the dock, at reducer
// level. A reload (`layout`) reopens nothing: the dock is the stored layout
// pruned to the open keys, and an open key the layout lacks joins the stored
// focused tile as a tab (no tab is ever parked outside a tile). A new session
// (`reopen`) brings the stored keys back, validated like stored tabs, before
// the URL key and before the fresh data-browser rule. Focus precedence on
// both: URL key, then the session's active key, then the stored focused
// tile. One `it` per load case, plus the rules those cases rest on.

import { describe, expect, it } from 'vitest';
import { MAX_TOOL_INSTANCES } from './tools.js';
import { keysOf, tileIdsOf, validateLayout } from '@slaclab/canopy-dock-engine';
import { EMPTY_TABS, loadTabs, type Layout, type TabsState } from './tabs.js';

/** The tile `id` of `layout`. */
function tileOf(layout: Layout, id: string): { tabs: string[]; showing: string } {
  if ('tile' in layout) {
    if (layout.tile === id) return layout;
    throw new Error(`no tile ${id}`);
  }
  for (const item of layout.items) {
    if (tileIdsOf(item).includes(id)) return tileOf(item, id);
  }
  throw new Error(`no tile ${id}`);
}

/** The holder invariants: keys = keysOf(layout), active = the focused tile's showing tab. */
function expectInvariants(s: TabsState): void {
  if (s.layout === null) {
    expect(s.keys).toEqual([]);
    expect(s.active).toBeNull();
    expect(s.focusedTile).toBeNull();
    return;
  }
  expect(validateLayout(s.layout)).toEqual({ valid: true });
  expect(s.keys).toEqual(keysOf(s.layout));
  expect(s.active).toBe(tileOf(s.layout, s.focusedTile!).showing);
}

/** The tabs of every tile, in layout order. */
function tiles(s: TabsState): string[][] {
  if (s.layout === null) return [];
  return tileIdsOf(s.layout).map((id) => tileOf(s.layout!, id).tabs);
}

/** A session's stored tabs as readTabs returns them (the layout is not stored there). */
function session(keys: string[], active: string | null = keys[0] ?? null): TabsState {
  return { ...EMPTY_TABS, keys, active };
}

/** A row of one tile per entry, tile ids t1, t2, ... */
function row(...tabs: string[][]): Layout {
  const items = tabs.map((t, i) => ({ tile: `t${i + 1}`, tabs: t, showing: t[0]! }));
  if (items.length === 1) return items[0]!;
  return { split: 'row', items: items.map((item) => ({ ...item, size: 1 / items.length })) };
}

const TOOLS = ['trace', 'correlation'] as const;

describe('loadTabs: reload with a stored layout', () => {
  it('a layout naming a closed key does not reopen it', () => {
    const { state, warnings } = loadTabs(session(['a/1', 'b/2'], 'a/1'), null, {
      tools: TOOLS,
      layout: { layout: row(['a/1'], ['c/3']), focusedTile: 't2' },
    });
    expectInvariants(state);
    expect(state.keys).not.toContain('c/3');
    // c/3's tile is gone with it; b/2 joins the remaining tile as a tab.
    expect(tiles(state)).toEqual([['a/1', 'b/2']]);
    expect(state.active).toBe('a/1');
    expect(warnings).toEqual([]);
  });

  it('keeps every key in its stored tile, and an unplaced key joins the focused tile', () => {
    const { state } = loadTabs(session(['a/1', 'b/2', 'c/3'], 'c/3'), null, {
      tools: TOOLS,
      layout: { layout: row(['c/3'], ['a/1']), focusedTile: 't2' },
    });
    expectInvariants(state);
    expect(tiles(state)).toEqual([['c/3'], ['a/1', 'b/2']]);
    // The session's active tab wins over the stored focused tile.
    expect(state.active).toBe('c/3');
    expect(state.focusedTile).toBe('t1');
  });

  it('an empty stored layout with tabs open puts them in one tile, none parked', () => {
    const { state, warnings } = loadTabs(session(['a/1', 'b/2'], null), null, {
      tools: TOOLS,
      layout: { layout: null },
    });
    expectInvariants(state);
    expect(state.keys).toEqual(['a/1', 'b/2']);
    expect(tiles(state)).toEqual([['a/1', 'b/2']]);
    expect(state.active).toBe('a/1');
    expect(warnings).toEqual([]);
  });

  it('falls back to the stored focused tile when the session has no active tab', () => {
    const { state } = loadTabs(session(['a/1', 'b/2', 'c/3'], null), null, {
      tools: TOOLS,
      layout: { layout: row(['a/1'], ['b/2']), focusedTile: 't2' },
    });
    expectInvariants(state);
    expect(tiles(state)).toEqual([['a/1'], ['b/2', 'c/3']]);
    expect(state.focusedTile).toBe('t2');
    expect(state.active).toBe('b/2');
  });

  it('focuses the tile of a URL key without changing the tiles', () => {
    const { state } = loadTabs(session(['a/1', 'b/2'], 'a/1'), 'b/2', {
      tools: TOOLS,
      layout: { layout: row(['a/1'], ['b/2']), focusedTile: 't1' },
    });
    expectInvariants(state);
    expect(tiles(state)).toEqual([['a/1'], ['b/2']]);
    expect(state.focusedTile).toBe('t2');
    expect(state.active).toBe('b/2');
  });

  it('a session active the layout lacks joins the focused tile and shows there', () => {
    const { state } = loadTabs(session(['a/1', 'b/2', 'c/3'], 'c/3'), null, {
      tools: TOOLS,
      layout: { layout: row(['a/1'], ['b/2']), focusedTile: 't2' },
    });
    expectInvariants(state);
    expect(tiles(state)).toEqual([['a/1'], ['b/2', 'c/3']]);
    expect(state.focusedTile).toBe('t2');
    expect(state.active).toBe('c/3');
  });

  it('without a layout option every open key is a tab of one tile', () => {
    const { state } = loadTabs(session(['a/1', 'b/2'], null), null, { tools: TOOLS });
    expectInvariants(state);
    expect(state.layout).toEqual({ tile: 't1', tabs: ['a/1', 'b/2'], showing: 'a/1' });
    expect(state.active).toBe('a/1');
  });
});

describe('loadTabs: new session reopens the stored dock', () => {
  it('layout A|B on a bare /embed/ with the data browser configured', () => {
    const { state, warnings } = loadTabs(EMPTY_TABS, null, {
      tools: TOOLS,
      fresh: true,
      reopen: {
        panels: [{ key: 'a/1' }, { key: 'b/2' }],
        layout: row(['a/1'], ['b/2']),
        focusedTile: 't2',
      },
    });
    expectInvariants(state);
    expect(state.keys).toEqual(['a/1', 'b/2']);
    expect(state.keys).not.toContain('@trace');
    expect(tiles(state)).toEqual([['a/1'], ['b/2']]);
    expect(state.active).toBe('b/2');
    expect(warnings).toEqual([]);
  });

  it('a deep link to a key the dock lacks opens as a tab of the focused tile', () => {
    const { state } = loadTabs(EMPTY_TABS, 'c/3', {
      tools: TOOLS,
      fresh: true,
      reopen: {
        panels: [{ key: 'a/1' }, { key: 'b/2' }],
        layout: row(['a/1'], ['b/2']),
        focusedTile: 't2',
      },
    });
    expectInvariants(state);
    expect(state.keys).toEqual(['a/1', 'b/2', 'c/3']);
    expect(tiles(state)).toEqual([['a/1'], ['b/2', 'c/3']]);
    expect(state.focusedTile).toBe('t2');
    expect(state.active).toBe('c/3');
  });

  it('a deep link to a reopened key focuses its tile', () => {
    const { state } = loadTabs(EMPTY_TABS, 'a/1', {
      tools: TOOLS,
      fresh: true,
      reopen: {
        panels: [{ key: 'a/1' }, { key: 'b/2' }],
        layout: row(['a/1'], ['b/2']),
        focusedTile: 't2',
      },
    });
    expectInvariants(state);
    expect(tiles(state)).toEqual([['a/1'], ['b/2']]);
    expect(state.focusedTile).toBe('t1');
    expect(state.active).toBe('a/1');
  });

  it('reopens the stored tabs in their tile and seeds tool instances with {query, view}', () => {
    const { state } = loadTabs(EMPTY_TABS, null, {
      tools: TOOLS,
      fresh: true,
      reopen: {
        panels: [
          { key: '@trace', query: 'pv=X', view: 'v1' },
          { key: 'a/1' },
          { key: '@correlation/2', query: '' },
        ],
        layout: row(['@trace', 'a/1', '@correlation/2']),
        focusedTile: 't1',
      },
    });
    expectInvariants(state);
    expect(state.keys).toEqual(['@trace', 'a/1', '@correlation/2']);
    expect(tiles(state)).toEqual([['@trace', 'a/1', '@correlation/2']]);
    expect(state.active).toBe('@trace');
    expect(state.instances['@trace']).toEqual({ query: 'pv=X', view: 'v1' });
    expect(state.instances['@correlation/2']).toEqual({ query: '' });
    // Seeded, not loaded: no epoch, so each frame mounts once.
    expect(state.instances['@trace']?.epoch).toBeUndefined();
  });

  it('drops unconfigured or unknown tools with one warning each', () => {
    const { state, warnings } = loadTabs(EMPTY_TABS, null, {
      tools: ['trace'],
      fresh: true,
      reopen: {
        panels: [{ key: '@correlation' }, { key: '@nope' }, { key: 'a/1' }],
        layout: row(['@correlation'], ['a/1']),
        focusedTile: 't1',
      },
    });
    expectInvariants(state);
    expect(state.keys).toEqual(['a/1']);
    expect(tiles(state)).toEqual([['a/1']]);
    expect(state.active).toBe('a/1');
    expect(state.instances).toEqual({});
    expect(warnings).toHaveLength(2);
  });

  it('applies the per-tool instance cap', () => {
    const panels = Array.from({ length: MAX_TOOL_INSTANCES + 1 }, (_, i) => ({
      key: i === 0 ? '@trace' : `@trace/${i + 1}`,
    }));
    const { state, warnings } = loadTabs(EMPTY_TABS, null, {
      tools: TOOLS,
      reopen: { panels, layout: null },
    });
    expectInvariants(state);
    expect(state.keys).toHaveLength(MAX_TOOL_INSTANCES);
    expect(state.keys).not.toContain(`@trace/${MAX_TOOL_INSTANCES + 1}`);
    expect(warnings).toHaveLength(1);
  });

  it('the fresh data-browser rule fires only when nothing was reopened', () => {
    const { state } = loadTabs(EMPTY_TABS, null, {
      tools: ['trace'],
      fresh: true,
      reopen: { panels: [{ key: '@correlation' }], layout: row(['@correlation']) },
    });
    expectInvariants(state);
    expect(state.keys).toEqual(['@trace']);
    expect(tiles(state)).toEqual([['@trace']]);
  });
});
