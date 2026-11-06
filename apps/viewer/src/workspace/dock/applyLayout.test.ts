// The layout-tree -> dockview serializer and `applyLayout`, against a real dockview-core
// 7.0.2 built in jsdom (set up as in TileBar.test.tsx). Every drop, close and reopen
// case's result is applied over its starting layout and checked four ways: group sizes
// match `geometry` within 2 px, group ids are the tile ids, each group shows the tile's
// `showing` tab (with the tile's tabs in order), and the tile-bar portals survive the
// rebuild. Also pinned: the 40 px minimums on every panel entry and group, stored
// per-panel state kept, the bridge guard used for the apply, and focus kept across it.
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import {
  createDockview,
  markDockviewPackageLoaded,
  type DockviewApi,
  type IContentRenderer,
  type SerializedDockview,
} from 'dockview-core';
import { MIN_TILE_PX, applyLayout, toSerialized } from './applyLayout.js';
import { TileBar } from './TileBar.js';
import {
  TileBarPortals,
  createTileHeaderActions,
  createTileHeaderRegistry,
  type TileHeaderEntry,
  type TileHeaderRegistry,
} from './tabAdapter.js';
import { RECT_EPSILON, loadCases, type OpCase } from '@slaclab/canopy-dock-engine/cases';
import { geometry, isTile, normalize, tileIdsOf } from '@slaclab/canopy-dock-engine';
import type { Layout, Tile } from '@slaclab/canopy-dock-engine';

const roots: HTMLElement[] = [];
const apis: DockviewApi[] = [];
const DEFAULT_PX = { width: 1000, height: 600 };

function placeholder(): IContentRenderer {
  const element = document.createElement('div');
  return { element, init() {} };
}

function mountDock(px = DEFAULT_PX) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  roots.push(root);
  const registry = createTileHeaderRegistry();
  markDockviewPackageLoaded();
  const api = createDockview(root, {
    disableFloatingGroups: true,
    createComponent: placeholder,
    ...createTileHeaderActions(registry),
  });
  apis.push(api);
  api.layout(px.width, px.height);
  render(
    createElement(TileBarPortals<TileHeaderEntry>, {
      registry,
      renderBar: (entry: TileHeaderEntry) =>
        entry.slot === 'bar' && entry.showing !== null
          ? createElement(TileBar, {
              tile: entry.tile,
              tabs: entry.tabs,
              panelKey: entry.showing,
              title: entry.tabs.find((t) => t.key === entry.showing)?.title ?? entry.showing,
              focused: false,
              multiTile: true,
              documentFocused: true,
            })
          : null,
    })
  );
  return { root, api, registry };
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function apply(api: DockviewApi, layout: Layout | null, px = DEFAULT_PX): Promise<void> {
  await act(async () => {
    void applyLayout(api, layout, { dockPx: px });
  });
  await settle();
}

function tilesOf(layout: Layout | null): Tile[] {
  if (layout === null) return [];
  if (isTile(layout)) return [layout];
  return layout.items.flatMap(tilesOf);
}

/** The bar in `tile`'s group while it shows `key` (the bar carries its showing key). */
function barIn(api: DockviewApi, tile: string, key: string): HTMLElement | null {
  const group = api.groups.find((g) => g.id === tile);
  return (
    group?.element.querySelector<HTMLElement>(`.canopy-tile-bar[data-panel-key="${key}"]`) ?? null
  );
}

/** The keys the bar in `tile`'s group lists, or null when the group has no bar. */
function barTabsIn(api: DockviewApi, tile: string): string[] | null {
  const group = api.groups.find((g) => g.id === tile);
  const bar = group?.element.querySelector<HTMLElement>(`.canopy-tile-bar[data-tile="${tile}"]`);
  if (!bar) return null;
  return [...bar.querySelectorAll<HTMLElement>('.canopy-tile-bar__tab')].map(
    (t) => t.dataset.tabKey!
  );
}

/** Every mismatch between the dock and `layout` (an empty list when they agree). */
function diffDock(
  api: DockviewApi,
  root: HTMLElement,
  registry: TileHeaderRegistry,
  layout: Layout | null,
  px: { width: number; height: number }
): string[] {
  const problems: string[] = [];
  const tiles = tilesOf(layout);
  const groupIds = api.groups.map((g) => g.id).sort();
  const tileIds = tileIdsOf(layout).sort();
  if (JSON.stringify(groupIds) !== JSON.stringify(tileIds)) {
    problems.push(`group ids ${JSON.stringify(groupIds)} != tile ids ${JSON.stringify(tileIds)}`);
  }
  const rects = layout === null ? {} : geometry(layout, { x: 0, y: 0, ...px }, MIN_TILE_PX).tiles;
  for (const tile of tiles) {
    const group = api.groups.find((g) => g.id === tile.tile);
    if (!group) continue;
    const views = group.panels.map((p) => p.id);
    if (JSON.stringify(views) !== JSON.stringify(tile.tabs)) {
      problems.push(`${tile.tile}: tabs ${JSON.stringify(views)} != ${JSON.stringify(tile.tabs)}`);
    }
    if (group.activePanel?.id !== tile.showing) {
      problems.push(`${tile.tile}: showing ${group.activePanel?.id} != ${tile.showing}`);
    }
    const rect = rects[tile.tile]!;
    if (Math.abs(group.api.width - rect.width) > RECT_EPSILON) {
      problems.push(`${tile.tile}: width ${group.api.width} != ${rect.width}`);
    }
    if (Math.abs(group.api.height - rect.height) > RECT_EPSILON) {
      problems.push(`${tile.tile}: height ${group.api.height} != ${rect.height}`);
    }
    const listed = barTabsIn(api, tile.tile);
    if (JSON.stringify(listed) !== JSON.stringify(tile.tabs)) {
      problems.push(
        `${tile.tile}: bar lists ${JSON.stringify(listed)} != ${JSON.stringify(tile.tabs)}`
      );
    }
  }
  const bars = root.querySelectorAll('.canopy-tile-bar').length;
  if (bars !== tiles.length) problems.push(`${bars} tile bars for ${tiles.length} tiles`);
  // Each tile mounts two header renderers: the bar and the right-hand actions.
  const entries = registry.getSnapshot().length;
  if (entries !== 2 * tiles.length) {
    problems.push(`${entries} registry entries for ${tiles.length} tiles`);
  }
  return problems;
}

function pxOf(c: OpCase): { width: number; height: number } {
  const op = c.op as {
    dock?: { px: typeof DEFAULT_PX };
    context?: { dock?: { px: typeof DEFAULT_PX } };
  };
  return op.dock?.px ?? op.context?.dock?.px ?? DEFAULT_PX;
}

afterEach(() => {
  cleanup();
  for (const api of apis.splice(0)) api.dispose();
  for (const root of roots.splice(0)) root.remove();
  vi.restoreAllMocks();
});

// --- the cases on a real dock ---------------------------------------------------

const replayed = (['drop', 'close', 'reopen'] as const).flatMap((kind) =>
  loadCases(kind).map((loaded) => [`${kind}/${loaded.file}`, loaded.data] as const)
);

describe('applyLayout replays every drop, close and reopen case (real dockview)', () => {
  it('covers each kind', () => {
    for (const kind of ['drop/', 'close/', 'reopen/']) {
      expect(replayed.some(([name]) => name.startsWith(kind))).toBe(true);
    }
  });

  it.each(replayed)('%s', async (_name, c) => {
    const px = pxOf(c);
    const { root, api, registry } = mountDock(px);
    await apply(api, c.before, px);
    expect(diffDock(api, root, registry, c.before, px)).toEqual([]);
    const after = c.after === 'unchanged' ? c.before : c.after;
    await apply(api, after, px);
    expect(diffDock(api, root, registry, after, px)).toEqual([]);
  });
});

// --- serializer ---------------------------------------------------------------------

describe('toSerialized', () => {
  const row: Layout = {
    split: 'row',
    items: [
      { tile: 't1', tabs: ['a', 'b'], showing: 'b', size: 0.25 },
      {
        split: 'column',
        size: 0.75,
        items: [
          { tile: 't2', tabs: ['c'], showing: 'c', size: 0.5 },
          { tile: 't3', tabs: ['d'], showing: 'd', size: 0.5, from: 't2' },
        ],
      },
    ],
  };

  it('maps tiles to groups, showing to the active view and fractions to px', () => {
    const s = toSerialized(row, { width: 1000, height: 600 });
    expect(s.grid).toMatchObject({ width: 1000, height: 600, orientation: 'HORIZONTAL' });
    expect(s.grid.root).toEqual({
      type: 'branch',
      size: 600,
      data: [
        { type: 'leaf', size: 250, data: { views: ['a', 'b'], activeView: 'b', id: 't1' } },
        {
          type: 'branch',
          size: 750,
          data: [
            { type: 'leaf', size: 300, data: { views: ['c'], activeView: 'c', id: 't2' } },
            { type: 'leaf', size: 300, data: { views: ['d'], activeView: 'd', id: 't3' } },
          ],
        },
      ],
    });
  });

  it('wraps a root Tile in a branch', () => {
    const s = toSerialized({ tile: 't4', tabs: ['x'], showing: 'x' }, { width: 800, height: 500 });
    expect(s.grid.root.type).toBe('branch');
    expect(s.grid.root.data).toEqual([
      { type: 'leaf', size: 800, data: { views: ['x'], activeView: 'x', id: 't4' } },
    ]);
  });

  it('a column root is a vertical grid', () => {
    const s = toSerialized(
      {
        split: 'column',
        items: [
          { tile: 't1', tabs: ['a'], showing: 'a' },
          { tile: 't2', tabs: ['b'], showing: 'b' },
        ],
      },
      { width: 800, height: 500 }
    );
    expect(s.grid.orientation).toBe('VERTICAL');
    expect((s.grid.root.data as { size: number }[]).map((n) => n.size)).toEqual([250, 250]);
  });

  it('serializes the empty dock', () => {
    const s = toSerialized(null, { width: 800, height: 500 });
    expect(s.grid.root).toEqual({ type: 'branch', data: [] });
    expect(s.panels).toEqual({});
  });

  it('puts the 40 px minimums on every panel entry and keeps stored per-panel state', () => {
    const s = toSerialized(row, DEFAULT_PX, {
      panels: {
        a: { id: 'a', contentComponent: 'screen', title: 'A', params: { url: '/a', zoom: 2 } },
        zz: { id: 'zz', contentComponent: 'screen' },
      },
      newPanel: (key) => ({ title: key.toUpperCase() }),
    });
    expect(Object.keys(s.panels).sort()).toEqual(['a', 'b', 'c', 'd']);
    for (const entry of Object.values(s.panels)) {
      expect(entry.minimumWidth).toBe(MIN_TILE_PX);
      expect(entry.minimumHeight).toBe(MIN_TILE_PX);
    }
    expect(s.panels.a).toMatchObject({
      id: 'a',
      contentComponent: 'screen',
      title: 'A',
      params: { url: '/a', zoom: 2 },
    });
    expect(s.panels.b).toMatchObject({ id: 'b', contentComponent: 'canopy-panel', title: 'B' });
  });

  it('sets the active group only to a tile that exists', () => {
    expect(toSerialized(row, DEFAULT_PX, { activeTile: 't3' }).activeGroup).toBe('t3');
    expect(toSerialized(row, DEFAULT_PX, { activeTile: 't9' }).activeGroup).toBeUndefined();
  });

  it('normalises first and never mutates its input', () => {
    const nested: Layout = {
      split: 'row',
      items: [
        { tile: 't1', tabs: ['a'], showing: 'a' },
        {
          split: 'row',
          items: [
            { tile: 't2', tabs: ['b'], showing: 'b' },
            { tile: 't3', tabs: ['c'], showing: 'c' },
          ],
        },
      ],
    };
    const copy = JSON.parse(JSON.stringify(nested));
    const s = toSerialized(nested, { width: 900, height: 600 });
    expect(nested).toEqual(copy);
    expect((s.grid.root.data as { type: string }[]).map((n) => n.type)).toEqual([
      'leaf',
      'leaf',
      'leaf',
    ]);
    expect(normalize(nested)).not.toBe(nested);
  });
});

// --- applyLayout on a real dock -----------------------------------------------------

const twoTiles: Layout = {
  split: 'row',
  items: [
    { tile: 't1', tabs: ['a', 'b'], showing: 'a', size: 0.5 },
    { tile: 't2', tabs: ['c'], showing: 'c', size: 0.5 },
  ],
};

describe('applyLayout', () => {
  it('gives every group the 40 px minimums', async () => {
    const { api } = mountDock();
    await apply(api, twoTiles);
    for (const group of api.groups) {
      expect(group.minimumWidth).toBe(MIN_TILE_PX);
      expect(group.minimumHeight).toBe(MIN_TILE_PX);
    }
  });

  it('keeps each panel its existing params and title across a re-layout', async () => {
    const { api } = mountDock();
    await act(async () => {
      api.addPanel({ id: 'a', component: 'placeholder', title: 'Screen A', params: { url: '/a' } });
      api.addPanel({ id: 'c', component: 'placeholder', title: 'Screen C', params: { url: '/c' } });
    });
    await apply(api, {
      split: 'column',
      items: [
        { tile: 't1', tabs: ['c'], showing: 'c' },
        { tile: 't2', tabs: ['a'], showing: 'a' },
      ],
    });
    expect(api.getPanel('a')!.params).toEqual({ url: '/a' });
    expect(api.getPanel('a')!.title).toBe('Screen A');
    expect(api.getPanel('c')!.params).toEqual({ url: '/c' });
    expect(api.getPanel('a')!.group.id).toBe('t2');
  });

  it('runs fromJSON through the caller’s guard', async () => {
    const { api } = mountDock();
    const fromJSON = vi.spyOn(api, 'fromJSON');
    const seen: SerializedDockview[] = [];
    let inside = false;
    const guard = (serialized: SerializedDockview) => {
      seen.push(serialized);
      inside = true;
      try {
        api.fromJSON(serialized);
        expect(inside).toBe(true);
      } finally {
        inside = false;
      }
    };
    await act(async () => {
      void applyLayout(api, twoTiles, { apply: guard });
    });
    expect(seen).toHaveLength(1);
    expect(fromJSON).toHaveBeenCalledTimes(1);
    expect(fromJSON).toHaveBeenCalledWith(seen[0]);
    expect(seen[0]!.grid.width).toBe(DEFAULT_PX.width);
  });

  it('sizes from the dock itself when no px are given', async () => {
    const { root, api, registry } = mountDock({ width: 700, height: 400 });
    await act(async () => {
      void applyLayout(api, twoTiles);
    });
    await settle();
    expect(diffDock(api, root, registry, twoTiles, { width: 700, height: 400 })).toEqual([]);
  });
});

// --- focus ----------------------------------------------------------------------------

const closeNext = loadCases('close').find(
  (c) => c.file === 'close-showing-tab-shows-next.json'
)!.data;

describe('applyLayout keeps focus', () => {
  /** twoTiles with t1 showing b, so t1's bar carries b. */
  const showingB: Layout = {
    split: 'row',
    items: [
      { tile: 't1', tabs: ['a', 'b'], showing: 'b', size: 0.5 },
      { tile: 't2', tabs: ['c'], showing: 'c', size: 0.5 },
    ],
  };

  it('a tab closed by keyboard leaves focus on the neighbour tab', async () => {
    const { api } = mountDock();
    await apply(api, closeNext.before);
    const closing = barIn(api, 't2', 'e')!;
    closing.focus();
    expect(document.activeElement).toBe(closing);
    // Delete on a focused tab closes it through the engine's result.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Delete') return;
      void applyLayout(api, closeNext.after as Layout, { dockPx: DEFAULT_PX });
    };
    document.addEventListener('keydown', onKey, true);
    try {
      await act(async () => {
        closing.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
      });
      await settle();
    } finally {
      document.removeEventListener('keydown', onKey, true);
    }
    expect(api.getPanel('e')).toBeUndefined();
    const neighbour = barIn(api, 't2', 'f')!;
    expect(neighbour).not.toBeNull();
    expect(document.activeElement).toBe(neighbour);
  });

  it('a focused tab stays focused, re-found by tile and key after the rebuild', async () => {
    const { api } = mountDock();
    await apply(api, showingB);
    const before = barIn(api, 't1', 'b')!;
    before.focus();
    let restored: Promise<boolean> = Promise.resolve(false);
    await act(async () => {
      restored = applyLayout(
        api,
        { ...showingB, items: [...(showingB as { items: Layout[] }).items].reverse() },
        { dockPx: DEFAULT_PX }
      );
    });
    await settle();
    expect(await restored).toBe(true);
    const after = barIn(api, 't1', 'b')!;
    expect(after).not.toBe(before);
    expect(document.activeElement).toBe(after);
  });

  it('a focused tab that moved tiles hands focus to the showing tab of its new tile', async () => {
    const { api } = mountDock();
    await apply(api, showingB);
    barIn(api, 't1', 'b')!.focus();
    await apply(api, {
      split: 'row',
      items: [
        { tile: 't1', tabs: ['a'], showing: 'a', size: 0.5 },
        { tile: 't2', tabs: ['c', 'b'], showing: 'c', size: 0.5 },
      ],
    });
    expect(document.activeElement).toBe(barIn(api, 't2', 'c'));
  });

  it('the terminal’s xterm outside the tabs keeps focus', async () => {
    const { api } = mountDock();
    await apply(api, twoTiles);
    const xterm = document.createElement('textarea');
    xterm.className = 'xterm-helper-textarea';
    document.body.appendChild(xterm);
    roots.push(xterm);
    xterm.focus();
    await apply(api, { tile: 't1', tabs: ['a', 'b', 'c'], showing: 'c' });
    expect(document.activeElement).toBe(xterm);
  });

  it('nothing focused stays nothing focused', async () => {
    const { api } = mountDock();
    await apply(api, twoTiles);
    (document.activeElement as HTMLElement | null)?.blur();
    let restored: Promise<boolean> = Promise.resolve(true);
    await act(async () => {
      restored = applyLayout(api, null, { dockPx: DEFAULT_PX });
    });
    expect(await restored).toBe(false);
    expect(document.activeElement).toBe(document.body);
  });
});
