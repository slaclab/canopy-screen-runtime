// The dock's gestures, against a real dockview-core 7.0.2 (made by createDock) in jsdom,
// driven by the real tabs reducer, the real bridge and real DOM drag events. Every drop is
// the engine's to decide; the dock refuses none itself. Pinned here: a drop on a tile's bar
// is a tab insert and on its content centre adds the dragged tabs to that tile (a tile holds
// any number of tabs); an edge splits; the last target under the pointer wins; the preview
// follows the drag and falls with it; a tile moves with its tabs, a tab on its own; a sole
// tab dropped on its own tile changes nothing; a sidebar row drops a closed screen as a new
// tab and an open one as that tab; `dragging` rises once on a drag's start and falls once on
// the first document drop, dragend or Escape.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { useCallback, useReducer, useRef, type Dispatch } from 'react';
import { createPortal } from 'react-dom';
import type { DockviewApi } from 'dockview-core';
import { fromLayout, tabsReducer, type TabsAction, type TabsState } from '../tabs.js';
import { keysOf, tileIdsOf } from '@slaclab/canopy-dock-engine';
import type { Layout, Tile, Source } from '@slaclab/canopy-dock-engine';
import { createDock } from './createDock.js';
import { TileBar } from './TileBar.js';
import { DOCK_SOURCE_MIME, clearDockDrag, dockDragStart } from './tabAdapter.js';
import { parseBrowserDrag, useDockBridge, type DockBridge } from './useDockBridge.js';

/** The dock root's client rect is (0, 0, SIZE, SIZE); every element's offset size is SIZE. */
const SIZE = 400;
const sizeProps = ['offsetWidth', 'offsetHeight'] as const;
/** A tile bar's height and a bar tab's width, in px. */
const BAR_H = 24;
const TAB_W = 60;

const tile = (id: string, ...tabs: string[]): Tile => ({ tile: id, tabs, showing: tabs[0]! });
const row = (...tiles: Tile[]): Layout => ({
  split: 'row',
  items: tiles.map((t) => ({ ...t, size: 1 / tiles.length })),
});

/** A | B, half each. */
const AB = row(tile('A', 'demo/a'), tile('B', 'demo/b'));
/** A (a, c) | B (b), half each. */
const ACB = row(tile('A', 'demo/a', 'demo/c'), tile('B', 'demo/b'));
/** One tile A with two tabs, a showing. */
const ONE = tile('A', 'demo/a', 'demo/b');
/** One tile A with its one tab. */
const SOLE = tile('A', 'demo/a');

/** Inside A's content (left half), in its right edge zone (clear of the A|B border). */
const A_RIGHT_EDGE = { clientX: 150, clientY: 200 };
/** A's content centre (left half). */
const A_CENTRE = { clientX: 100, clientY: 200 };
/** A's bottom edge zone (left half). */
const A_BOTTOM = { clientX: 100, clientY: 320 };
/** B's content centre and bottom edge zone (right half). */
const B_CENTRE = { clientX: 300, clientY: 200 };
const B_BOTTOM = { clientX: 300, clientY: 320 };
/** On A's bar, right of its tabs. */
const A_BAR = { clientX: 170, clientY: BAR_H / 2 };
/** On B's bar, right of its tab. */
const B_BAR = { clientX: 360, clientY: BAR_H / 2 };
/** The one tile's centre and right edge zone (the whole dock). */
const ONE_CENTRE = { clientX: 200, clientY: 200 };
const ONE_RIGHT_EDGE = { clientX: 370, clientY: 200 };

const roots: HTMLElement[] = [];
const apis: DockviewApi[] = [];

beforeEach(() => {
  // jsdom has no PointerEvent; dockview's drag source checks for it on dragstart.
  vi.stubGlobal('PointerEvent', class extends MouseEvent {});
  for (const prop of sizeProps) {
    Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get: () => SIZE });
  }
});

afterEach(() => {
  cleanup();
  clearDockDrag();
  for (const api of apis.splice(0)) api.dispose();
  for (const root of roots.splice(0)) root.remove();
  for (const prop of sizeProps)
    delete (HTMLElement.prototype as unknown as Record<string, unknown>)[prop];
  vi.unstubAllGlobals();
});

interface Handle {
  state: TabsState;
  dispatch: Dispatch<TabsAction>;
  bridge: DockBridge;
  /** Every `dragging` value the bridge rendered with, in order. */
  dragging: boolean[];
}

/** The tiles of a single tile or a one-level row, left to right. */
function tilesOf(layout: Layout): Tile[] {
  return 'tile' in layout ? [layout] : layout.items.map((item) => item as Tile);
}

const rect = (x: number, y: number, width: number, height: number) =>
  ({ x, y, left: x, top: y, width, height, right: x + width, bottom: y + height }) as DOMRect;

/**
 * Mounts the bridge over the real reducer and a dock made by createDock holding `layout`,
 * focus on tile A. `bars`: a TileBar per tile of `layout` (static), laid out over the top of
 * each tile's column.
 */
function mount(layout: Layout, opts: { bars?: boolean } = {}) {
  const root = document.createElement('div');
  root.getBoundingClientRect = () => rect(0, 0, SIZE, SIZE);
  document.body.appendChild(root);
  roots.push(root);
  const api = createDock(root);
  api.layout(SIZE, SIZE, true);
  apis.push(api);
  const barHost = document.createElement('div');
  root.appendChild(barHost);
  const spy = vi.fn<(action: TabsAction) => void>();
  const handle = { dragging: [] as boolean[] } as Handle;
  const initial: TabsState = { ...fromLayout(layout, 'A'), dockPx: { width: SIZE, height: SIZE } };
  const tiles = tilesOf(layout);
  function Harness() {
    const [state, dispatch] = useReducer(tabsReducer, initial);
    const raw = useRef(dispatch);
    raw.current = dispatch;
    const bridgeDispatch = useCallback((action: TabsAction) => {
      spy(action);
      raw.current(action);
    }, []);
    const bridge = useDockBridge(api, state, bridgeDispatch, { root });
    handle.state = state;
    handle.dispatch = dispatch;
    handle.bridge = bridge;
    if (handle.dragging.at(-1) !== bridge.dragging) handle.dragging.push(bridge.dragging);
    return opts.bars
      ? createPortal(
          <>
            {tiles.map((t) => (
              <TileBar
                key={t.tile}
                tile={t.tile}
                tabs={t.tabs.map((key) => ({ key, title: key }))}
                panelKey={t.showing}
                title={t.showing}
                focused={t.tile === 'A'}
                multiTile
                documentFocused
              />
            ))}
          </>,
          barHost
        )
      : null;
  }
  render(<Harness />);
  if (opts.bars) {
    const width = SIZE / tiles.length;
    tiles.forEach((t, i) => {
      const bar = root.querySelector<HTMLElement>(`.canopy-tile-bar[data-tile="${t.tile}"]`)!;
      bar.getBoundingClientRect = () => rect(i * width, 0, width, BAR_H);
      bar.querySelectorAll<HTMLElement>('.canopy-tile-bar__tab').forEach((tab, j) => {
        tab.getBoundingClientRect = () => rect(i * width + j * TAB_W, 0, TAB_W, BAR_H);
      });
    });
  }
  spy.mockClear();
  return { root, api, spy, handle };
}

type Mounted = ReturnType<typeof mount>;

/** A minimal DataTransfer: jsdom has none. */
function transfer(data: Record<string, string> = {}): DataTransfer {
  const store = { ...data };
  return {
    get types() {
      return Object.keys(store);
    },
    getData: (type: string) => store[type] ?? '',
    setData: (type: string, value: string) => {
      store[type] = value;
    },
    clearData: () => {},
    setDragImage: () => {},
    effectAllowed: 'all',
    dropEffect: 'none',
    items: { length: 0 },
    files: { length: 0 },
  } as unknown as DataTransfer;
}

function fire(
  target: Element | Document,
  type: string,
  dataTransfer: DataTransfer,
  point = B_CENTRE
): MouseEvent {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...point });
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

async function turn(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function groupOf(m: Mounted, id: string): HTMLElement {
  const group = m.api.groups.find((g) => g.id === id);
  if (!group) throw new Error(`no group ${id}`);
  return group.element;
}

function dvTab(m: Mounted, id: string): HTMLElement {
  return groupOf(m, id).querySelector<HTMLElement>('.dv-tab')!;
}

/** The element a drop at a point lands on: a content container, or a bar. */
function content(m: Mounted, id: string): HTMLElement {
  return groupOf(m, id).querySelector<HTMLElement>('.dv-content-container')!;
}

function bar(m: Mounted, id: string): HTMLElement {
  return m.root.querySelector<HTMLElement>(`.canopy-tile-bar[data-tile="${id}"]`)!;
}

function grip(m: Mounted, id: string): HTMLElement {
  return bar(m, id).querySelector<HTMLElement>('.canopy-tile-bar__grip')!;
}

function barTab(m: Mounted, key: string): HTMLElement {
  return m.root.querySelector<HTMLElement>(`.canopy-tile-bar__tab[data-tab-key="${key}"]`)!;
}

function drops(m: Mounted): TabsAction[] {
  return m.spy.mock.calls.map(([action]) => action).filter((a) => a.type === 'drop');
}

/** Every overlay any group or the api would show, recorded after the bridge ran. */
function overlays(m: Mounted): { defaultPrevented: boolean }[] {
  const seen: { defaultPrevented: boolean }[] = [];
  for (const group of m.api.groups) group.model.onWillShowOverlay((e) => seen.push(e));
  m.api.onWillShowOverlay((e) => seen.push(e));
  return seen;
}

/** The holder's tiles, each as its tabs. */
function tabsByTile(m: Mounted): string[][] {
  const layout = m.handle.state.layout;
  if (layout === null) return [];
  const find = (node: Layout, id: string): Tile | null => {
    if ('tile' in node) return node.tile === id ? node : null;
    for (const item of node.items) {
      const hit = find(item, id);
      if (hit) return hit;
    }
    return null;
  };
  return tileIdsOf(layout).map((id) => find(layout, id)!.tabs);
}

/** What dockview shows: per group, its panels in order. */
function groups(m: Mounted): string[][] {
  return m.api.groups.map((group) => group.panels.map((panel) => panel.id));
}

/** Starts a drag of the dock's own (strip, sidebar) kind: the page's dragstart handlers. */
function startOwn(source: Source): DataTransfer {
  const dataTransfer = transfer();
  act(() => dockDragStart(source, dataTransfer));
  return dataTransfer;
}

/** dragenter, then a dragover at each point of `path` on `target`; no drop. */
function hover(
  target: Element,
  dataTransfer: DataTransfer,
  path: { clientX: number; clientY: number }[]
) {
  fire(target, 'dragenter', dataTransfer, path[0]);
  for (const point of path) fire(target, 'dragover', dataTransfer, point);
}

/** Drops at `point` on `target`, then ends the drag on `source` and lets the apply run. */
async function release(
  target: Element,
  dataTransfer: DataTransfer,
  point: { clientX: number; clientY: number },
  source: Element | Document = document
) {
  fire(target, 'dragover', dataTransfer, point);
  fire(target, 'drop', dataTransfer, point);
  fire(source, 'dragend', dataTransfer, point);
  await turn();
}

describe('dock gestures: drop targets', () => {
  it('names a bar drop a tab insert, the content centre a centre drop and a content edge a split', () => {
    const m = mount(AB, { bars: true });
    const dataTransfer = transfer();
    fire(grip(m, 'B'), 'dragstart', dataTransfer);
    hover(bar(m, 'A'), dataTransfer, [A_BAR]);
    expect(m.handle.bridge.preview.target).toMatchObject({ tile: 'A', zone: 'tab' });
    hover(content(m, 'A'), dataTransfer, [A_CENTRE]);
    expect(m.handle.bridge.preview.target).toEqual({ tile: 'A', zone: 'centre' });
    hover(content(m, 'A'), dataTransfer, [A_RIGHT_EDGE]);
    expect(m.handle.bridge.preview.target).toEqual({ tile: 'A', edge: 'right' });
  });
});

describe('dock gestures: a centre or bar drop adds a tab', () => {
  it('the bridge decides every drop: each dockview overlay is prevented and one drop dispatched', async () => {
    const m = mount(AB, { bars: true });
    const seen = overlays(m);
    const dataTransfer = transfer();
    fire(grip(m, 'B'), 'dragstart', dataTransfer);
    hover(content(m, 'A'), dataTransfer, [A_CENTRE]);
    await release(content(m, 'A'), dataTransfer, A_CENTRE, grip(m, 'B'));
    expect(seen.every((e) => e.defaultPrevented)).toBe(true);
    expect(drops(m)).toEqual([
      expect.objectContaining({ source: { tile: 'B' }, target: { tile: 'A', zone: 'centre' } }),
    ]);
  });

  it("a tile dropped on another tile's bar joins it, its tabs inserted there", async () => {
    const m = mount(AB, { bars: true });
    const dataTransfer = transfer();
    fire(grip(m, 'B'), 'dragstart', dataTransfer);
    hover(bar(m, 'A'), dataTransfer, [A_BAR]);
    await release(bar(m, 'A'), dataTransfer, A_BAR, grip(m, 'B'));
    expect(tabsByTile(m)).toEqual([['demo/a', 'demo/b']]);
    expect(groups(m)).toEqual([['demo/a', 'demo/b']]);
  });

  it("a tile dropped on another tile's content centre adds its tabs there, leaving one tile", async () => {
    const m = mount(AB, { bars: true });
    const dataTransfer = transfer();
    fire(grip(m, 'B'), 'dragstart', dataTransfer);
    hover(content(m, 'A'), dataTransfer, [A_CENTRE]);
    await release(content(m, 'A'), dataTransfer, A_CENTRE, grip(m, 'B'));
    expect(tabsByTile(m)).toEqual([['demo/a', 'demo/b']]);
    expect(groups(m)).toHaveLength(1);
    expect(groups(m)[0]!.sort()).toEqual(['demo/a', 'demo/b']);
  });

  it("a tile-bar tab dropped on another tile's bar becomes a tab of that tile", async () => {
    const m = mount(ACB, { bars: true });
    const dataTransfer = transfer();
    fire(barTab(m, 'demo/c'), 'dragstart', dataTransfer);
    hover(bar(m, 'B'), dataTransfer, [B_BAR]);
    await release(bar(m, 'B'), dataTransfer, B_BAR, barTab(m, 'demo/c'));
    expect(tabsByTile(m)).toEqual([['demo/a'], ['demo/b', 'demo/c']]);
    expect(m.handle.state.active).toBe('demo/c');
  });

  it('a strip tab dropped on a tile centre or bar becomes a tab there', async () => {
    for (const [at, point] of [
      ['centre', B_CENTRE],
      ['bar', B_BAR],
    ] as const) {
      const m = mount(ACB, { bars: true });
      const dataTransfer = startOwn({ tab: 'demo/c' });
      const target = at === 'bar' ? bar(m, 'B') : content(m, 'B');
      hover(target, dataTransfer, [point]);
      await release(target, dataTransfer, point);
      expect(tabsByTile(m), at).toEqual([['demo/a'], ['demo/b', 'demo/c']]);
      cleanup();
      clearDockDrag();
    }
  });
});

describe('dock gestures: the last target wins', () => {
  it('the preview follows the pointer from a centre to an edge; the drop there splits', async () => {
    const m = mount(AB, { bars: true });
    const dataTransfer = transfer();
    fire(grip(m, 'B'), 'dragstart', dataTransfer);
    hover(content(m, 'A'), dataTransfer, [A_CENTRE]);
    expect(m.handle.bridge.preview.target).toEqual({ tile: 'A', zone: 'centre' });
    hover(content(m, 'A'), dataTransfer, [A_BOTTOM]);
    expect(m.handle.bridge.preview.target).toEqual({ tile: 'A', edge: 'bottom' });
    await release(content(m, 'A'), dataTransfer, A_BOTTOM, grip(m, 'B'));
    // B under A: two tiles in a column.
    expect(tabsByTile(m)).toEqual([['demo/a'], ['demo/b']]);
    expect(m.handle.state.layout).toMatchObject({ split: 'column' });
  });

  it("a hover over one tile's centre does not change a drop on another tile's edge", async () => {
    const m = mount(ACB, { bars: true });
    const dataTransfer = transfer();
    fire(barTab(m, 'demo/c'), 'dragstart', dataTransfer);
    hover(content(m, 'B'), dataTransfer, [B_CENTRE]);
    hover(content(m, 'A'), dataTransfer, [A_BOTTOM]);
    await release(content(m, 'A'), dataTransfer, A_BOTTOM, barTab(m, 'demo/c'));
    expect(keysOf(m.handle.state.layout).sort()).toEqual(['demo/a', 'demo/b', 'demo/c']);
    expect(tabsByTile(m)).toEqual([['demo/a'], ['demo/c'], ['demo/b']]);
  });

  it('a tile drag that crosses an edge and is released on the centre adds its tabs', async () => {
    const m = mount(AB, { bars: true });
    const dataTransfer = transfer();
    fire(grip(m, 'B'), 'dragstart', dataTransfer);
    hover(content(m, 'A'), dataTransfer, [A_BOTTOM, A_CENTRE]);
    await release(content(m, 'A'), dataTransfer, A_CENTRE, grip(m, 'B'));
    expect(tabsByTile(m)).toEqual([['demo/a', 'demo/b']]);
  });

  it('a strip drag over the centre, released on an edge, splits there', async () => {
    const m = mount(ONE);
    const dataTransfer = startOwn({ tab: 'demo/b' });
    hover(content(m, 'A'), dataTransfer, [ONE_CENTRE, ONE_RIGHT_EDGE]);
    await release(content(m, 'A'), dataTransfer, ONE_RIGHT_EDGE);
    expect(tabsByTile(m)).toEqual([['demo/a'], ['demo/b']]);
    expect(groups(m)).toEqual([['demo/a'], ['demo/b']]);
  });

  it("a strip drag that crosses an edge, released on its own tile's centre, splits nothing", async () => {
    const m = mount(ONE);
    const dataTransfer = startOwn({ tab: 'demo/b' });
    hover(content(m, 'A'), dataTransfer, [ONE_RIGHT_EDGE, ONE_CENTRE]);
    await release(content(m, 'A'), dataTransfer, ONE_CENTRE);
    // Still one tile with both tabs; the dropped tab is the one it shows.
    expect(tabsByTile(m)).toEqual([['demo/a', 'demo/b']]);
    expect(m.handle.state.active).toBe('demo/b');
    expect(groups(m)).toEqual([['demo/a', 'demo/b']]);
  });
});

describe('dock gestures: the drop preview', () => {
  it('falls with the drag', async () => {
    const m = mount(AB, { bars: true });
    const dataTransfer = transfer();
    fire(grip(m, 'B'), 'dragstart', dataTransfer);
    hover(content(m, 'A'), dataTransfer, [A_RIGHT_EDGE]);
    expect(m.handle.bridge.preview.result).not.toBeNull();
    fire(document, 'dragend', dataTransfer);
    // The drag ends a turn later (the root's drop handler still reads the source).
    await turn();
    expect(m.handle.bridge.preview.target).toBeNull();
    expect(m.handle.bridge.preview.result).toBeNull();
  });

  it("a tile drag previews a tab insert over another tile's bar", () => {
    const m = mount(AB, { bars: true });
    const dataTransfer = transfer();
    fire(grip(m, 'B'), 'dragstart', dataTransfer);
    hover(bar(m, 'A'), dataTransfer, [A_BAR]);
    expect(m.handle.bridge.preview.target).toMatchObject({ tile: 'A', zone: 'tab' });
    expect(m.handle.bridge.preview.result).not.toBeNull();
  });

  it('a tile drag previews a centre drop over a tile centre and a split at its edge', () => {
    const m = mount(AB, { bars: true });
    const dataTransfer = transfer();
    fire(grip(m, 'B'), 'dragstart', dataTransfer);
    hover(content(m, 'A'), dataTransfer, [A_CENTRE]);
    expect(m.handle.bridge.preview.target).toEqual({ tile: 'A', zone: 'centre' });
    expect(m.handle.bridge.preview.result).not.toBeNull();
    hover(content(m, 'A'), dataTransfer, [A_RIGHT_EDGE]);
    expect(m.handle.bridge.preview.target).toEqual({ tile: 'A', edge: 'right' });
    expect(m.handle.bridge.preview.result).not.toBeNull();
  });

  it('a strip drag previews a centre drop over a tile centre and a split at its edge', () => {
    const m = mount(ACB, { bars: true });
    const dataTransfer = startOwn({ tab: 'demo/c' });
    hover(content(m, 'B'), dataTransfer, [B_CENTRE]);
    expect(m.handle.bridge.preview.target).toEqual({ tile: 'B', zone: 'centre' });
    expect(m.handle.bridge.preview.result).not.toBeNull();
    hover(content(m, 'B'), dataTransfer, [B_BOTTOM]);
    expect(m.handle.bridge.preview.target).toEqual({ tile: 'B', edge: 'bottom' });
    expect(m.handle.bridge.preview.result).not.toBeNull();
  });
});

describe('dock gestures: moves', () => {
  it('ignores a foreign drop without a dock source', async () => {
    const m = mount(AB);
    const before = m.handle.state.layout;
    const dataTransfer = transfer({ 'text/plain': 'demo/b' });
    hover(content(m, 'A'), dataTransfer, [A_RIGHT_EDGE]);
    await release(content(m, 'A'), dataTransfer, A_RIGHT_EDGE);
    expect(drops(m)).toEqual([]);
    expect(m.handle.state.layout).toBe(before);
  });

  it("a tile dragged to another tile's edge moves with its tabs and is focused", async () => {
    const m = mount(ACB, { bars: true });
    const dataTransfer = transfer();
    fire(grip(m, 'A'), 'dragstart', dataTransfer);
    hover(content(m, 'B'), dataTransfer, [B_BOTTOM]);
    await release(content(m, 'B'), dataTransfer, B_BOTTOM, grip(m, 'A'));
    // A under B, its tabs and showing tab kept.
    expect(tabsByTile(m)).toEqual([['demo/b'], ['demo/a', 'demo/c']]);
    expect(m.handle.state.focusedTile).toBe('A');
    expect(m.handle.state.active).toBe('demo/a');
  });

  it("a sole tab dropped on its own tile's edge changes nothing", async () => {
    const m = mount(SOLE);
    const before = m.handle.state.layout;
    const dataTransfer = startOwn({ tab: 'demo/a' });
    hover(content(m, 'A'), dataTransfer, [ONE_RIGHT_EDGE]);
    await release(content(m, 'A'), dataTransfer, ONE_RIGHT_EDGE);
    expect(m.handle.state.layout).toEqual(before);
    expect(groups(m)).toEqual([['demo/a']]);
  });

  it("a hidden tab dragged to its tile's edge splits off a tile of its own, focused", async () => {
    const m = mount(ONE);
    const dataTransfer = startOwn({ tab: 'demo/b' });
    hover(content(m, 'A'), dataTransfer, [ONE_RIGHT_EDGE]);
    await release(content(m, 'A'), dataTransfer, ONE_RIGHT_EDGE);
    expect(tabsByTile(m)).toEqual([['demo/a'], ['demo/b']]);
    expect(m.handle.state.active).toBe('demo/b');
  });

  it("a tile-bar tab dragged to another tile's edge moves only that tab, focused", async () => {
    const m = mount(ACB, { bars: true });
    const dataTransfer = transfer();
    fire(barTab(m, 'demo/c'), 'dragstart', dataTransfer);
    hover(content(m, 'B'), dataTransfer, [B_BOTTOM]);
    await release(content(m, 'B'), dataTransfer, B_BOTTOM, barTab(m, 'demo/c'));
    expect(tabsByTile(m)).toEqual([['demo/a'], ['demo/b'], ['demo/c']]);
    expect(m.handle.state.active).toBe('demo/c');
  });
});

describe('dock gestures: dragging (iframe shield)', () => {
  it('prevents the overlays of groups a later apply adds', async () => {
    const m = mount(ONE);
    act(() =>
      m.handle.dispatch({
        type: 'drop',
        source: { tab: 'demo/b' },
        target: { tile: 'A', edge: 'right' },
        dock: { width: SIZE, height: SIZE },
      })
    );
    await turn();
    expect(m.api.groups).toHaveLength(2);
    const seen = overlays(m);
    const [, second] = m.api.groups;
    const dataTransfer = transfer();
    fire(dvTab(m, m.api.groups[0]!.id), 'dragstart', dataTransfer);
    hover(second!.element.querySelector('.dv-content-container')!, dataTransfer, [B_CENTRE]);
    expect(seen.every((e) => e.defaultPrevented)).toBe(true);
  });

  it('rises on a tile-bar tab drag start and falls on a document dragend', async () => {
    const m = mount(ACB, { bars: true });
    const dataTransfer = transfer();
    fire(barTab(m, 'demo/c'), 'dragstart', dataTransfer);
    expect(m.handle.bridge.dragging).toBe(true);
    fire(document, 'dragend', dataTransfer);
    await turn();
    expect(m.handle.bridge.dragging).toBe(false);
  });

  it('rises on a strip drag start, writes the dock source, and falls on a document drop', async () => {
    const m = mount(ONE);
    const dataTransfer = startOwn({ tab: 'demo/b' });
    expect(m.handle.bridge.dragging).toBe(true);
    expect(JSON.parse(dataTransfer.getData(DOCK_SOURCE_MIME))).toEqual({ tab: 'demo/b' });
    expect(dataTransfer.getData('text/plain')).toBe('demo/b');
    fire(document, 'drop', dataTransfer);
    await turn();
    expect(m.handle.bridge.dragging).toBe(false);
  });

  it('rises on a grip drag start and falls on Escape', async () => {
    const m = mount(AB, { bars: true });
    fire(grip(m, 'B'), 'dragstart', transfer());
    expect(m.handle.bridge.dragging).toBe(true);
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await turn();
    expect(m.handle.bridge.dragging).toBe(false);
  });

  it('rises at most once per drag and falls once', async () => {
    const m = mount(AB, { bars: true });
    const dataTransfer = transfer();
    fire(grip(m, 'B'), 'dragstart', dataTransfer);
    hover(content(m, 'A'), dataTransfer, [A_CENTRE, A_RIGHT_EDGE, A_BOTTOM]);
    fire(content(m, 'A'), 'drop', dataTransfer, A_BOTTOM);
    fire(grip(m, 'B'), 'dragend', dataTransfer);
    fire(document, 'dragend', dataTransfer);
    await turn();
    expect(m.handle.dragging).toEqual([false, true, false]);
  });
});

describe('dock gestures: sidebar drops', () => {
  it('a row of an open key drops as that tab: it moves to the edge', async () => {
    const m = mount(ACB, { bars: true });
    const dataTransfer = startOwn({ new: 'demo/c' });
    hover(content(m, 'B'), dataTransfer, [B_BOTTOM]);
    await release(content(m, 'B'), dataTransfer, B_BOTTOM);
    expect(tabsByTile(m)).toEqual([['demo/a'], ['demo/b'], ['demo/c']]);
    expect(m.handle.state.keys).toHaveLength(3);
  });

  it("a row of a tile's sole tab dropped on that tile changes nothing", async () => {
    const m = mount(SOLE);
    const before = m.handle.state.layout;
    const dataTransfer = startOwn({ new: 'demo/a' });
    hover(content(m, 'A'), dataTransfer, [ONE_RIGHT_EDGE]);
    await release(content(m, 'A'), dataTransfer, ONE_RIGHT_EDGE);
    expect(m.handle.state.layout).toEqual(before);
  });

  it('a closed screen dropped on a tile edge opens in a tile there, focused', async () => {
    const m = mount(AB);
    const dataTransfer = startOwn({ new: 'demo/z' });
    hover(content(m, 'A'), dataTransfer, [A_RIGHT_EDGE]);
    await release(content(m, 'A'), dataTransfer, A_RIGHT_EDGE);
    expect(tabsByTile(m)).toEqual([['demo/a'], ['demo/z'], ['demo/b']]);
    expect(m.handle.state.active).toBe('demo/z');
    expect(groups(m)).toEqual([['demo/a'], ['demo/z'], ['demo/b']]);
  });

  it('a browser payload that is no drag is ignored', async () => {
    expect(parseBrowserDrag('demo/z')).toBeNull();
    const m = mount(AB);
    const dataTransfer = transfer({ 'text/plain': 'demo/z' });
    hover(content(m, 'A'), dataTransfer, [A_RIGHT_EDGE]);
    await release(content(m, 'A'), dataTransfer, A_RIGHT_EDGE);
    expect(drops(m)).toEqual([]);
    expect(m.handle.state.keys).toEqual(['demo/a', 'demo/b']);
  });

  it('a closed screen dropped on a tile centre or bar becomes a tab there', async () => {
    for (const [at, point] of [
      ['centre', B_CENTRE],
      ['bar', B_BAR],
    ] as const) {
      const m = mount(AB, { bars: true });
      const dataTransfer = startOwn({ new: 'demo/z' });
      const target = at === 'bar' ? bar(m, 'B') : content(m, 'B');
      hover(target, dataTransfer, [point]);
      await release(target, dataTransfer, point);
      expect(tabsByTile(m), at).toEqual([['demo/a'], ['demo/b', 'demo/z']]);
      expect(m.handle.state.active, at).toBe('demo/z');
      cleanup();
      clearDockDrag();
    }
  });

  it('a row drag start writes the source as JSON and its key as text, and raises the shield', () => {
    const m = mount(AB);
    const dataTransfer = startOwn({ new: 'demo/z' });
    expect(JSON.parse(dataTransfer.getData(DOCK_SOURCE_MIME))).toEqual({ new: 'demo/z' });
    expect(dataTransfer.getData('text/plain')).toBe('demo/z');
    expect(m.handle.bridge.dragging).toBe(true);
  });
});

describe('parseBrowserDrag', () => {
  it('reads a member or a saved view and rejects anything else', () => {
    expect(parseBrowserDrag('{"screen":"a/b"}')).toEqual({ screen: 'a/b' });
    expect(parseBrowserDrag('{"screen":"a/b","macros":{"M":"1"},"extra":1}')).toEqual({
      screen: 'a/b',
      macros: { M: '1' },
    });
    expect(parseBrowserDrag('{"tool":"trace"}')).toEqual({ tool: 'trace' });
    expect(parseBrowserDrag('{"tool":"trace","query":"pv=A","name":"A"}')).toEqual({
      tool: 'trace',
      query: 'pv=A',
      name: 'A',
    });
    expect(parseBrowserDrag('{"kind":"view","id":"v1"}')).toEqual({ kind: 'view', id: 'v1' });
    for (const bad of [
      '',
      'a/b',
      '{"kind":"screen"}',
      '{"kind":"screen","key":"a/b"}',
      '{"kind":"view","id":7}',
      '{"kind":"other","key":"x"}',
      '{"screen":"a/b","tool":"trace"}',
      '{"screen":""}',
      '{"tool":"trace","query":1}',
      '[]',
      'null',
    ]) {
      expect(parseBrowserDrag(bad), bad).toBeNull();
    }
  });
});
