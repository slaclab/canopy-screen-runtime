// The tile bar and its portal adapters, against a real dockview-core
// 7.0.2 built in jsdom. Pinned here: one bar per tile however many tabs it holds, mounted
// as the group's prefix header action with dockview's own tabs hidden; the bar lists the
// tile's tabs and marks the showing one; a tab click shows it and its × closes it; the tabs
// and the grip start drags through `dockDragStart`, which records `{tab}`/`{tile}` in module
// state; the showing tab's controls sit in the right header actions; the bar is a keyboard
// tablist and the tile's one tab stop; its tab rects are measured for hit testing;
// `tileBarsShown` (bars from two tiles on); portals never leak across a fromJSON rebuild; and the
// stylesheet is anchored on the bar's own classes.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { useContext, useLayoutEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  createDockview,
  markDockviewPackageLoaded,
  type DockviewApi,
  type IContentRenderer,
} from 'dockview-core';
import {
  TILE_GRIP_TITLE,
  TILE_TAB_CLOSE_TITLE,
  TILE_ACTIONS_CAP,
  TILE_BAR_CAP,
  TILE_HEADER_FIT,
  TILE_TABS_MIN_PX,
  HEADER_ROW,
  TileActions,
  TileHeaderContext,
  TileBar,
  measureTabRects,
  revealScrollLeft,
  shareTileHeader,
  tileHeaderCaps,
  tileBarHairline,
  tileBarsShown,
  tileTabId,
  type TileBarProps,
} from './TileBar.js';
import {
  DOCK_SOURCE_MIME,
  TileBarPortals,
  clearDockDrag,
  createTileHeaderActions,
  createTileHeaderRegistry,
  dockDragSource,
  dockDragStart,
  onDockDragStart,
  type TileHeaderEntry,
  type TileHeaderRegistry,
} from './tabAdapter.js';

const roots: HTMLElement[] = [];
const apis: DockviewApi[] = [];

function placeholder(): IContentRenderer {
  const element = document.createElement('div');
  return { element, init() {} };
}

interface Calls {
  shown: string[];
  closed: string[];
}

interface HeaderDockOptions {
  /** Render bars only when this holds (the `tileBarsShown` checks); defaults to always. */
  barsWhen?: (api: DockviewApi) => boolean;
  /** The bars' `onFocus`. */
  onFocus?: (key: string) => void;
}

/** A real dock wired with the header-action adapter, its portals rendered by React. */
function mountHeaderDock(options: HeaderDockOptions = {}) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  roots.push(root);
  const registry: TileHeaderRegistry = createTileHeaderRegistry();
  const calls: Calls = { shown: [], closed: [] };
  markDockviewPackageLoaded();
  const api = createDockview(root, {
    disableFloatingGroups: true,
    createComponent: placeholder,
    ...createTileHeaderActions(registry),
  });
  apis.push(api);
  const renderEntry = (entry: TileHeaderEntry) => {
    if (options.barsWhen && !options.barsWhen(api)) return null;
    if (entry.slot === 'actions') {
      return (
        <TileActions
          tile={entry.tile}
          header={<button type="button">{`controls ${entry.showing}`}</button>}
          menu={entry.tile === api.groups[api.groups.length - 1]?.id ? <span>☰</span> : undefined}
        />
      );
    }
    if (entry.showing === null) return null;
    const showing = entry.tabs.find((t) => t.key === entry.showing)!;
    return (
      <TileBar
        tile={entry.tile}
        tabs={entry.tabs}
        panelKey={showing.key}
        title={showing.title}
        focused={false}
        multiTile={true}
        documentFocused={true}
        onFocus={options.onFocus}
        onShow={(key) => {
          calls.shown.push(key);
          entry.activate(key);
        }}
        onCloseTab={(key) => calls.closed.push(key)}
      />
    );
  };
  render(<TileBarPortals registry={registry} renderBar={renderEntry} />);
  return { root, api, registry, calls };
}

/** Flush React updates and the adapter's microtask/MutationObserver re-application. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Tile A holds a, a2, a3 (a showing); tile B, to its right, holds b. */
async function twoTiles(options: HeaderDockOptions = {}) {
  const dock = mountHeaderDock(options);
  await act(async () => {
    dock.api.addPanel({ id: 'a', component: 'placeholder', title: 'Screen A' });
    dock.api.addPanel({
      id: 'b',
      component: 'placeholder',
      title: 'Screen B',
      position: { referencePanel: 'a', direction: 'right' },
    });
    const groupA = dock.api.getPanel('a')!.group;
    dock.api.addPanel({
      id: 'a2',
      component: 'placeholder',
      title: 'Tool A2',
      position: { referenceGroup: groupA },
      inactive: true,
    });
    dock.api.addPanel({
      id: 'a3',
      component: 'placeholder',
      title: 'Tool A3',
      position: { referenceGroup: groupA },
      inactive: true,
    });
  });
  await settle();
  return dock;
}

function groupIdOf(api: DockviewApi, key: string): string {
  return api.getPanel(key)!.group.id;
}

function barOf(root: HTMLElement, tile: string): HTMLElement {
  const bar = root.querySelector<HTMLElement>(`.canopy-tile-bar[data-tile="${tile}"]`);
  if (!bar) throw new Error(`no bar for ${tile}`);
  return bar;
}

function tabOf(bar: HTMLElement, key: string): HTMLElement {
  const tab = bar.querySelector<HTMLElement>(`.canopy-tile-bar__tab[data-tab-key="${key}"]`);
  if (!tab) throw new Error(`no tab ${key}`);
  return tab;
}

function tabKeys(bar: HTMLElement): string[] {
  return [...bar.querySelectorAll<HTMLElement>('.canopy-tile-bar__tab')].map(
    (t) => t.dataset.tabKey!
  );
}

/** Elements reachable with Tab inside an element (jsdom has no layout; tabindex rules only). */
function tabStops(scope: Element): Element[] {
  const candidates = scope.querySelectorAll('a[href], button, input, select, textarea, [tabindex]');
  return [...candidates].filter((el) => {
    if ((el as HTMLElement).closest('[style*="display: none"]')) return false;
    const attr = el.getAttribute('tabindex');
    if (attr !== null) return Number(attr) >= 0;
    return !(el as HTMLButtonElement).disabled;
  });
}

/** A minimal DataTransfer (jsdom has none). */
function transfer() {
  const data = new Map<string, string>();
  return {
    effectAllowed: 'none',
    dropEffect: 'none',
    get types() {
      return [...data.keys()];
    },
    setData: (type: string, value: string) => void data.set(type, value),
    getData: (type: string) => data.get(type) ?? '',
    clearData: () => data.clear(),
    setDragImage: () => {},
  };
}

afterEach(() => {
  cleanup();
  clearDockDrag();
  for (const api of apis.splice(0)) api.dispose();
  for (const root of roots.splice(0)) root.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('one bar per tile (header actions on a real dockview)', () => {
  it('mounts one bar per tile in the prefix header action, listing the tile’s tabs', async () => {
    const { root, api } = await twoTiles();
    const bars = root.querySelectorAll('.canopy-tile-bar');
    expect(bars).toHaveLength(2);
    for (const bar of bars) {
      expect(bar.parentElement!.classList.contains('canopy-tile-bar-host')).toBe(true);
      expect(bar.parentElement!.parentElement!.classList.contains('dv-pre-actions-container')).toBe(
        true
      );
    }
    const a = barOf(root, groupIdOf(api, 'a'));
    expect(tabKeys(a)).toEqual(['a', 'a2', 'a3']);
    expect(tabOf(a, 'a2').textContent).toContain('Tool A2');
    expect(tabKeys(barOf(root, groupIdOf(api, 'b')))).toEqual(['b']);
  });

  it('marks the showing tab and follows the group’s active panel', async () => {
    const { root, api } = await twoTiles();
    const tile = groupIdOf(api, 'a');
    const showing = () =>
      [...barOf(root, tile).querySelectorAll<HTMLElement>('[aria-selected="true"]')].map(
        (t) => t.dataset.tabKey
      );
    expect(showing()).toEqual(['a']);
    expect(barOf(root, tile).getAttribute('aria-activedescendant')).toBe(tileTabId('a'));
    expect(tabOf(barOf(root, tile), 'a').classList).toContain('canopy-tile-bar__tab--showing');
    await act(async () => api.getPanel('a3')!.api.setActive());
    await settle();
    expect(showing()).toEqual(['a3']);
    expect(barOf(root, tile).dataset.panelKey).toBe('a3');
    expect(barOf(root, tile).getAttribute('aria-activedescendant')).toBe(tileTabId('a3'));
  });

  it('hides dockview’s own tabs and void container, so N tabs never give N bars', async () => {
    const { root, api } = await twoTiles();
    const check = () => {
      const lists = root.querySelectorAll<HTMLElement>('.dv-tabs-container');
      expect(lists.length).toBe(api.groups.length);
      for (const list of lists) {
        const hidden = list.closest<HTMLElement>('[style*="display: none"]');
        expect(hidden).not.toBeNull();
        expect(list.hasAttribute('role')).toBe(false);
      }
      for (const voidEl of root.querySelectorAll<HTMLElement>('.dv-void-container')) {
        expect(voidEl.style.display).toBe('none');
      }
      // Every role=tab in the dock is a tile bar's.
      for (const tab of root.querySelectorAll('[role="tab"]')) {
        expect(tab.closest('.canopy-tile-bar')).not.toBeNull();
      }
      expect(root.querySelectorAll('[role="tablist"]')).toHaveLength(api.groups.length);
    };
    check();
    await act(async () => api.getPanel('a2')!.api.setActive());
    await settle();
    check();
    await act(async () => api.fromJSON(api.toJSON()));
    await settle();
    check();
  });

  it('puts the showing tab’s controls and the ☰ slot in the right header actions', async () => {
    const { root, api } = await twoTiles();
    const actions = root.querySelectorAll<HTMLElement>('.canopy-tile-bar__actions');
    expect(actions).toHaveLength(2);
    for (const el of actions) {
      expect(el.closest('.dv-right-actions-container')).not.toBeNull();
    }
    const a = root.querySelector<HTMLElement>(
      `.canopy-tile-bar__actions[data-tile="${groupIdOf(api, 'a')}"]`
    )!;
    expect(a.querySelector('.canopy-tile-bar__header')!.textContent).toBe('controls a');
    await act(async () => api.getPanel('a2')!.api.setActive());
    await settle();
    expect(a.querySelector('.canopy-tile-bar__header')!.textContent).toBe('controls a2');
    expect(root.querySelectorAll('.canopy-tile-bar__menu')).toHaveLength(1);
  });

  it('a press or a focus move in an unfocused tile’s actions focuses that tile', async () => {
    const onFocus = vi.fn<(key: string) => void>();
    const { root, api } = await twoTiles({ onFocus });
    const actionsOf = (tile: string) =>
      root.querySelector<HTMLElement>(`.canopy-tile-bar__actions[data-tile="${tile}"]`)!;
    const controlB = actionsOf(groupIdOf(api, 'b')).querySelector('button')!;
    // A press on a header control: its pointerdown is stopped, the capture phase still reports.
    fireEvent.pointerDown(controlB);
    expect(onFocus).toHaveBeenLastCalledWith('b');
    // A focus move from the keyboard (Tab onto the control).
    const controlA = actionsOf(groupIdOf(api, 'a')).querySelector('button')!;
    act(() => controlA.focus());
    expect(onFocus).toHaveBeenLastCalledWith('a');
    // The showing tab follows the tile's bar.
    await act(async () => api.getPanel('a2')!.api.setActive());
    await settle();
    fireEvent.pointerDown(actionsOf(groupIdOf(api, 'a')).querySelector('button')!);
    expect(onFocus).toHaveBeenLastCalledWith('a2');
  });

  it('a press or a focus move on the ☰ menu slot never moves the focused tile', async () => {
    const onFocus = vi.fn<(key: string) => void>();
    const { root } = await twoTiles({ onFocus });
    const menu = root.querySelector<HTMLElement>('.canopy-tile-bar__menu')!;
    const actions = menu.closest<HTMLElement>('.canopy-tile-bar__actions')!;
    // The ☰ sits in a tile's actions beside that tile's header controls.
    expect(actions.querySelector('.canopy-tile-bar__header button')).not.toBeNull();
    const item = menu.firstElementChild as HTMLElement;
    fireEvent.pointerDown(item);
    fireEvent.focusIn(item);
    fireEvent.pointerDown(menu);
    expect(onFocus).not.toHaveBeenCalled();
    // The header control of the same tile still focuses it.
    fireEvent.pointerDown(actions.querySelector('.canopy-tile-bar__header button')!);
    expect(onFocus).toHaveBeenCalledTimes(1);
  });

  it('a tab click shows that tab; a click on the showing tab does nothing', async () => {
    const { root, api, calls } = await twoTiles();
    const bar = barOf(root, groupIdOf(api, 'a'));
    fireEvent.click(tabOf(bar, 'a2'));
    await settle();
    expect(calls.shown).toEqual(['a2']);
    expect(api.getPanel('a2')!.group.activePanel?.id).toBe('a2');
    fireEvent.click(tabOf(barOf(root, groupIdOf(api, 'a')), 'a2'));
    expect(calls.shown).toEqual(['a2']);
  });

  it('a tab’s × closes that tab only, and never through dockview', async () => {
    const { root, api, calls } = await twoTiles();
    const bar = barOf(root, groupIdOf(api, 'a'));
    const close = tabOf(bar, 'a3').querySelector('button')!;
    expect(close.getAttribute('title')).toBe(TILE_TAB_CLOSE_TITLE);
    fireEvent.click(close);
    expect(calls.closed).toEqual(['a3']);
    expect(calls.shown).toEqual([]);
    expect(api.panels.map((p) => p.id).sort()).toEqual(['a', 'a2', 'a3', 'b']);
  });

  it('a tab dragstart records {tab: key}; the grip records {tile: id}; dragend clears', async () => {
    const { root, api } = await twoTiles();
    const tile = groupIdOf(api, 'a');
    const bar = barOf(root, tile);
    const started: unknown[] = [];
    const off = onDockDragStart((source) => started.push(source));
    try {
      const dt = transfer();
      const tab = tabOf(bar, 'a2');
      expect(tab.getAttribute('draggable')).toBe('true');
      fireEvent.dragStart(tab, { dataTransfer: dt });
      expect(dockDragSource()).toEqual({ tab: 'a2' });
      expect(JSON.parse(dt.getData(DOCK_SOURCE_MIME))).toEqual({ tab: 'a2' });
      expect(dt.getData('text/plain')).toBe('a2');
      expect(dt.effectAllowed).toBe('move');
      fireEvent.dragEnd(tab);
      expect(dockDragSource()).toBeNull();

      const grip = bar.querySelector<HTMLElement>('.canopy-tile-bar__grip')!;
      expect(grip.getAttribute('draggable')).toBe('true');
      expect(grip.getAttribute('title')).toBe(TILE_GRIP_TITLE);
      const gripDt = transfer();
      fireEvent.dragStart(grip, { dataTransfer: gripDt });
      expect(dockDragSource()).toEqual({ tile });
      expect(JSON.parse(gripDt.getData(DOCK_SOURCE_MIME))).toEqual({ tile });
      fireEvent.dragEnd(grip);
      expect(dockDragSource()).toBeNull();
      expect(started).toEqual([{ tab: 'a2' }, { tile }]);
    } finally {
      off();
    }
  });

  it('every tile has a grip, also with one tab', async () => {
    const { root } = await twoTiles();
    for (const bar of root.querySelectorAll('.canopy-tile-bar')) {
      expect(bar.querySelectorAll('.canopy-tile-bar__grip')).toHaveLength(1);
      expect(bar.firstElementChild!.classList).toContain('canopy-tile-bar__grip');
    }
  });

  it('rebuilds on fromJSON without leaking portals', async () => {
    const { root, api, registry } = await twoTiles();
    const before = registry.getSnapshot().map((e) => e.element);
    await act(async () => api.fromJSON(api.toJSON()));
    await settle();
    const after = registry.getSnapshot();
    expect(after).toHaveLength(4);
    expect(
      after
        .filter((e) => e.slot === 'bar')
        .map((e) => e.tile)
        .sort()
    ).toEqual(api.groups.map((g) => g.id).sort());
    for (const element of before) {
      expect(after.some((e) => e.element === element)).toBe(false);
      expect(element.querySelector('.canopy-tile-bar')).toBeNull();
    }
    expect(root.querySelectorAll('.canopy-tile-bar')).toHaveLength(2);
  });

  it('removes a tile’s portals with its group, and every portal with the dock', async () => {
    const { root, api, registry } = await twoTiles();
    await act(async () => api.removePanel(api.getPanel('b')!));
    await settle();
    expect(
      registry
        .getSnapshot()
        .map((e) => e.slot)
        .sort()
    ).toEqual(['actions', 'bar']);
    expect(root.querySelectorAll('.canopy-tile-bar')).toHaveLength(1);
    await act(async () => api.dispose());
    apis.splice(apis.indexOf(api), 1);
    await settle();
    expect(registry.getSnapshot()).toEqual([]);
  });

  it('follows a title change', async () => {
    const { root, api } = await twoTiles();
    await act(async () => api.getPanel('a2')!.api.setTitle('Renamed'));
    await settle();
    expect(tabOf(barOf(root, groupIdOf(api, 'a')), 'a2').textContent).toContain('Renamed');
  });

  it('has one tab stop per tile: the bar', async () => {
    const { api } = await twoTiles();
    for (const group of api.groups) {
      const header = group.element.querySelector('.dv-tabs-and-actions-container')!;
      const stops = tabStops(header).filter((el) => !el.closest('.canopy-tile-bar__actions'));
      expect(stops).toHaveLength(1);
      expect(stops[0]!.classList.contains('canopy-tile-bar')).toBe(true);
    }
  });

  it.each(['Delete', 'Backspace'])(
    '%s on a focused bar closes the showing tab through the callback only',
    async (key) => {
      const { root, api, calls } = await twoTiles();
      const bar = barOf(root, groupIdOf(api, 'a'));
      bar.focus();
      expect(document.activeElement).toBe(bar);
      const reached = vi.fn();
      api.getPanel('a')!.group.element.addEventListener('keydown', reached);
      fireEvent.keyDown(bar, { key });
      await settle();
      expect(calls.closed).toEqual(['a']);
      expect(reached).not.toHaveBeenCalled();
      expect(api.panels).toHaveLength(4);
    }
  );

  it('arrow keys, Home and End show the other tabs (wrapping)', async () => {
    const { root, api, calls } = await twoTiles();
    const tile = groupIdOf(api, 'a');
    const press = async (key: string) => {
      fireEvent.keyDown(barOf(root, tile), { key });
      await settle();
    };
    await press('ArrowRight');
    await press('ArrowRight');
    await press('ArrowRight');
    await press('ArrowLeft');
    await press('End');
    await press('Home');
    expect(calls.shown).toEqual(['a2', 'a3', 'a', 'a3', 'a']);
    expect(api.getPanel('a')!.group.activePanel?.id).toBe('a');
  });
});

describe('measureTabRects', () => {
  it('returns each header row’s rect and its tabs’ rects in order, keyed by tile id', async () => {
    const { root, api } = await twoTiles();
    const at = (x: number, y: number, width: number, height: number) =>
      ({ x, y, left: x, top: y, width, height, right: x + width, bottom: y + height }) as DOMRect;
    const tile = groupIdOf(api, 'a');
    const bar = barOf(root, tile);
    vi.spyOn(bar, 'getBoundingClientRect').mockReturnValue(at(0, 0, 200, 28));
    // The whole header row (tabs and the screen's toolbar) is the bar the engine sees.
    vi.spyOn(bar.closest(HEADER_ROW)!, 'getBoundingClientRect').mockReturnValue(at(0, 0, 300, 49));
    ['a', 'a2', 'a3'].forEach((key, i) =>
      vi.spyOn(tabOf(bar, key), 'getBoundingClientRect').mockReturnValue(at(20 + 80 * i, 0, 80, 28))
    );
    const rects = measureTabRects(root);
    expect(Object.keys(rects).sort()).toEqual(api.groups.map((g) => g.id).sort());
    expect(rects[tile]).toEqual({
      barRect: { x: 0, y: 0, width: 300, height: 49 },
      tabRects: [
        { x: 20, y: 0, width: 80, height: 28 },
        { x: 100, y: 0, width: 80, height: 28 },
        { x: 180, y: 0, width: 80, height: 28 },
      ],
    });
    expect(rects[groupIdOf(api, 'b')]!.tabRects).toHaveLength(1);
  });
});

describe('dockDragStart', () => {
  it('records the strip’s {tab} source with or without a transfer', () => {
    dockDragStart({ tab: 'k' }, null);
    expect(dockDragSource()).toEqual({ tab: 'k' });
    dockDragStart({ new: 'n' }, transfer() as unknown as DataTransfer);
    expect(dockDragSource()).toEqual({ new: 'n' });
    clearDockDrag();
    expect(dockDragSource()).toBeNull();
  });

  it('is cleared by a dragend anywhere in the document', () => {
    dockDragStart({ tab: 'k' }, null);
    document.body.dispatchEvent(new Event('dragend', { bubbles: true }));
    expect(dockDragSource()).toBeNull();
  });
});

describe('tileBarsShown', () => {
  it('bars from two tiles on, embedded in a host page and standalone alike', () => {
    expect(tileBarsShown(0)).toBe(false);
    expect(tileBarsShown(1)).toBe(false);
    expect(tileBarsShown(2)).toBe(true);
    expect(tileBarsShown(3)).toBe(true);
  });

  it.each(['right', 'below'] as const)(
    'on a real dock: no bar at one tile of two tabs, bars at two tiles (split %s), none again at one',
    async (direction) => {
      const dock = mountHeaderDock({ barsWhen: (api) => tileBarsShown(api.groups.length) });
      const barCount = () => dock.root.querySelectorAll('.canopy-tile-bar').length;
      await act(async () => {
        dock.api.addPanel({ id: 'a', component: 'placeholder', title: 'Screen A' });
        dock.api.addPanel({
          id: 'a2',
          component: 'placeholder',
          title: 'Screen A2',
          position: { referencePanel: 'a' },
        });
      });
      await settle();
      expect(dock.api.groups).toHaveLength(1);
      expect(barCount()).toBe(0);
      await act(async () => {
        dock.api.addPanel({
          id: 'b',
          component: 'placeholder',
          title: 'Screen B',
          position: { referencePanel: 'a', direction },
        });
      });
      await settle();
      expect(barCount()).toBe(2);
      await act(async () => dock.api.removePanel(dock.api.getPanel('b')!));
      await settle();
      expect(barCount()).toBe(0);
    }
  );
});

describe('TileBar', () => {
  const base: TileBarProps = {
    tile: 't1',
    tabs: [
      { key: 'k', title: 'Title' },
      { key: 'j', title: 'Other' },
    ],
    panelKey: 'k',
    title: 'Title',
    focused: true,
    multiTile: true,
    documentFocused: true,
  };

  it('is a tablist and the one tab stop; tabs carry their state and close buttons', () => {
    render(<TileBar {...base} />);
    const bar = screen.getByTestId('tile-bar');
    expect(bar.getAttribute('role')).toBe('tablist');
    expect(bar.getAttribute('tabindex')).toBe('0');
    expect(bar.dataset.tile).toBe('t1');
    expect(bar.dataset.panelKey).toBe('k');
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.getAttribute('aria-selected'))).toEqual(['true', 'false']);
    expect(tabs[0]!.id).toBe(tileTabId('k'));
    expect(bar.getAttribute('aria-activedescendant')).toBe(tileTabId('k'));
    expect(tabs[0]!.getAttribute('aria-controls')).toBe('canopy-tile-panel-k');
    const closes = screen.getAllByTitle(TILE_TAB_CLOSE_TITLE);
    expect(closes).toHaveLength(2);
    for (const close of closes) {
      expect(close.tagName).toBe('BUTTON');
      expect(close.getAttribute('tabindex')).toBe('-1');
    }
    expect(tabStops(bar.parentElement!)).toEqual([bar]);
  });

  it('defaults to the one tab panelKey/title and has no grip without a tile', () => {
    render(<TileBar panelKey="x" title="X" focused={false} multiTile={false} documentFocused />);
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['X']);
    expect(document.querySelector('.canopy-tile-bar__grip')).toBeNull();
  });

  it('the one-tab ×, without onCloseTab, calls onRemove', () => {
    const onRemove = vi.fn();
    render(
      <TileBar
        panelKey="x"
        title="X"
        focused={false}
        multiTile={false}
        documentFocused
        onRemove={onRemove}
      />
    );
    fireEvent.click(screen.getByTitle(TILE_TAB_CLOSE_TITLE));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it('labels each tab with the tile title id the panel root is labelled by', () => {
    render(<TileBar {...base} />);
    expect(document.getElementById('canopy-tile-title-j')?.textContent).toBe('Other');
  });

  it('stops pointerdown from its buttons but not from a tab or the grip', () => {
    render(
      <div>
        <TileBar {...base} />
      </div>
    );
    const parent = screen.getByTestId('tile-bar').parentElement!;
    const native = vi.fn();
    parent.addEventListener('pointerdown', native);
    fireEvent.pointerDown(screen.getAllByTitle(TILE_TAB_CLOSE_TITLE)[0]!);
    expect(native).not.toHaveBeenCalled();
    fireEvent.pointerDown(screen.getAllByRole('tab')[1]!);
    fireEvent.pointerDown(screen.getByTitle(TILE_GRIP_TITLE));
    expect(native).toHaveBeenCalledTimes(2);
  });

  it('modified arrows and keys on a button keep their own meaning', () => {
    const onShow = vi.fn();
    const onCloseTab = vi.fn();
    render(<TileBar {...base} onShow={onShow} onCloseTab={onCloseTab} />);
    const bar = screen.getByTestId('tile-bar');
    fireEvent.keyDown(bar, { key: 'ArrowRight', shiftKey: true });
    fireEvent.keyDown(screen.getAllByTitle(TILE_TAB_CLOSE_TITLE)[0]!, { key: 'Delete' });
    expect(onShow).not.toHaveBeenCalled();
    expect(onCloseTab).not.toHaveBeenCalled();
    fireEvent.keyDown(bar, { key: 'ArrowRight' });
    expect(onShow).toHaveBeenCalledWith('j');
  });

  const flags = [false, true];
  const table = flags.flatMap((focused) =>
    flags.flatMap((multiTile) =>
      flags.map((documentFocused) => [focused, multiTile, documentFocused] as const)
    )
  );

  it.each(table)(
    'hairline: focused=%s multiTile=%s documentFocused=%s',
    (focused, multiTile, documentFocused) => {
      const expected = focused && multiTile && documentFocused;
      expect(tileBarHairline(focused, multiTile, documentFocused)).toBe(expected);
      render(
        <TileBar
          {...base}
          focused={focused}
          multiTile={multiTile}
          documentFocused={documentFocused}
        />
      );
      const bar = screen.getByTestId('tile-bar');
      expect(bar.classList.contains('canopy-tile-bar--focused')).toBe(expected);
    }
  );

  it('renders nothing that floats', () => {
    render(
      <>
        <TileBar {...base} />
        <TileActions tile="t1" header={<span>h</span>} menu={<span>☰</span>} />
      </>
    );
    expect(
      document.querySelector('[role="dialog"], [role="tooltip"], [popover], dialog')
    ).toBeNull();
  });

  it('TileActions renders the header before the menu, each only when given', () => {
    const { rerender } = render(
      <TileActions tile="t1" header={<span>h</span>} menu={<span>m</span>} />
    );
    const actions = screen.getByTestId('tile-actions');
    expect([...actions.children].map((c) => c.className)).toEqual([
      'canopy-tile-bar__header',
      'canopy-tile-bar__menu',
    ]);
    rerender(<TileActions tile="t1" />);
    expect(screen.getByTestId('tile-actions').children).toHaveLength(0);
  });

  it('TileActions tells its header, and only its header, that it sits in a tile bar', () => {
    function Probe({ id }: { id: string }) {
      const fit = useContext(TileHeaderContext);
      const text = fit === null ? 'standalone' : `${fit.zoomButtonPx}/${fit.triggerPx}`;
      return <span data-testid={id}>{text}</span>;
    }
    render(
      <>
        <TileActions tile="t1" header={<Probe id="header" />} menu={<Probe id="menu" />} />
        <Probe id="outside" />
      </>
    );
    expect(screen.getByTestId('header').textContent).toBe(
      `${TILE_HEADER_FIT.zoomButtonPx}/${TILE_HEADER_FIT.triggerPx}`
    );
    expect(screen.getByTestId('menu').textContent).toBe('standalone');
    expect(screen.getByTestId('outside').textContent).toBe('standalone');
  });

  it('TileActions reports its own panelKey and onFocus when given, without a bar', () => {
    const onFocus = vi.fn<(key: string) => void>();
    render(
      <TileActions
        tile="t1"
        panelKey="demo/x"
        onFocus={onFocus}
        header={<button type="button">zoom</button>}
      />
    );
    fireEvent.pointerDown(screen.getByRole('button', { name: 'zoom' }));
    expect(onFocus).toHaveBeenCalledWith('demo/x');
  });
});

// The bar and the right header actions share the tile's header row. The actions take
// their content width up to what leaves the tab list its own width or half the row; the tab
// list takes the rest and scrolls, the showing tab and its × kept in view. jsdom lays nothing
// out, so the sizes are stubbed on the elements.
describe('the header row is shared', () => {
  function size(
    el: Element,
    sizes: Partial<Record<'clientWidth' | 'scrollWidth' | 'offsetWidth', number>>
  ) {
    for (const [name, value] of Object.entries(sizes)) {
      Object.defineProperty(el, name, { configurable: true, value });
    }
  }
  function box(el: Element, left: number, width: number) {
    el.getBoundingClientRect = () =>
      ({
        left,
        right: left + width,
        width,
        x: left,
        y: 0,
        top: 0,
        bottom: 28,
        height: 28,
      }) as DOMRect;
  }

  it('tileHeaderCaps: the actions get all but the tab list, the tab list keeps at least half', () => {
    // Tabs that fit in half the row keep their width; the actions may take the rest.
    expect(tileHeaderCaps(600, 200, 300)).toEqual({ actions: 400, bar: 300 });
    // Tabs wider than half the row: the actions may take half; the bar gets what they leave.
    expect(tileHeaderCaps(600, 900, 300)).toEqual({ actions: 300, bar: 300 });
    // One 96 px tab always fits, even past half the row.
    expect(tileHeaderCaps(227, 121, 114)).toEqual({ actions: 107, bar: 113 });
    // Short actions leave the tab list everything else.
    expect(tileHeaderCaps(700, 900, 120)).toEqual({ actions: 350, bar: 580 });
    // Whole pixels, never more than the row.
    const caps = tileHeaderCaps(341.6, 100.4, 241.2);
    expect(Number.isInteger(caps.actions) && Number.isInteger(caps.bar)).toBe(true);
    expect(caps.bar + 241.2).toBeLessThanOrEqual(341.6);
  });

  it('revealScrollLeft keeps the showing tab, × included, inside the list', () => {
    // Already in view: unchanged.
    expect(revealScrollLeft(0, 200, 50, 80)).toBe(0);
    // Right of the view: its right end (the ×) lands on the view's right edge.
    expect(revealScrollLeft(0, 200, 300, 80)).toBe(180);
    // Left of the view: its left edge lands on the view's left edge.
    expect(revealScrollLeft(250, 200, 100, 80)).toBe(100);
    // Wider than the view: the right end, where the × is, stays in view.
    expect(revealScrollLeft(0, 60, 100, 97)).toBe(137);
  });

  it('lists the tabs in one scrolling tab list after the grip', () => {
    render(
      <TileBar
        tile="t1"
        tabs={[
          { key: 'a', title: 'A' },
          { key: 'b', title: 'B' },
        ]}
        panelKey="b"
        title="B"
        focused={false}
        multiTile
        documentFocused
      />
    );
    const bar = screen.getByTestId('tile-bar');
    const list = bar.querySelector('.canopy-tile-bar__tabs')!;
    expect(list).not.toBeNull();
    expect([...bar.children].map((c) => c.className)).toEqual([
      'canopy-tile-bar__grip',
      'canopy-tile-bar__tabs',
    ]);
    expect(
      [...list.querySelectorAll('[role="tab"]')].map((t) => t.getAttribute('data-tab-key'))
    ).toEqual(['a', 'b']);
  });

  it('scrolls the showing tab into view when it changes, without scrolling the page', () => {
    const tabs = [
      { key: 'a', title: 'A' },
      { key: 'b', title: 'B' },
      { key: 'c', title: 'C' },
    ];
    const props = {
      tile: 't1',
      tabs,
      title: 'A',
      focused: false,
      multiTile: true,
      documentFocused: true,
    };
    const { rerender } = render(<TileBar {...props} panelKey="a" />);
    const bar = screen.getByTestId('tile-bar');
    const list = bar.querySelector<HTMLElement>('.canopy-tile-bar__tabs')!;
    size(list, { clientWidth: 100, scrollWidth: 300 });
    box(list, 20, 100);
    const tabEls = [...list.querySelectorAll<HTMLElement>('[role="tab"]')];
    // Laid out at 0, 100, 200 in the list's content (minus the current scroll).
    tabEls.forEach((t, i) => {
      t.getBoundingClientRect = () => {
        const left = 20 + i * 100 - list.scrollLeft;
        return {
          left,
          right: left + 100,
          width: 100,
          x: left,
          y: 0,
          top: 0,
          bottom: 28,
          height: 28,
        } as DOMRect;
      };
    });
    // jsdom has no scrollIntoView; a stub records any call (one would scroll the page too).
    const pageScroll = vi.fn();
    Element.prototype.scrollIntoView = pageScroll;
    rerender(<TileBar {...props} panelKey="c" title="C" />);
    expect(list.scrollLeft).toBe(200);
    rerender(<TileBar {...props} panelKey="a" />);
    expect(list.scrollLeft).toBe(0);
    expect(pageScroll).not.toHaveBeenCalled();
    delete (Element.prototype as Partial<Element>).scrollIntoView;
  });

  it('a vertical wheel over an overflowing tab list scrolls it sideways', () => {
    render(<TileBar tile="t1" panelKey="a" title="A" focused={false} multiTile documentFocused />);
    const list = screen
      .getByTestId('tile-bar')
      .querySelector<HTMLElement>('.canopy-tile-bar__tabs')!;
    size(list, { clientWidth: 100, scrollWidth: 300 });
    const wheel = new WheelEvent('wheel', { deltaY: 40, bubbles: true, cancelable: true });
    list.dispatchEvent(wheel);
    expect(list.scrollLeft).toBe(40);
    expect(wheel.defaultPrevented).toBe(true);
    // Nothing to scroll: the page keeps the wheel.
    size(list, { clientWidth: 300, scrollWidth: 300 });
    const free = new WheelEvent('wheel', { deltaY: 40, bubbles: true, cancelable: true });
    list.dispatchEvent(free);
    expect(free.defaultPrevented).toBe(false);
  });

  /** A dockview header row as the adapter builds it: the bar's host, then the actions' host. */
  function headerRow(
    tabsNatural: number,
    actionsWidth: number,
    rowWidth: number,
    tabs?: TileBarProps['tabs']
  ) {
    const row = document.createElement('div');
    row.className = 'dv-tabs-and-actions-container';
    const prefix = row.appendChild(document.createElement('div'));
    const right = row.appendChild(document.createElement('div'));
    document.body.appendChild(row);
    roots.push(row);
    render(
      <TileBar
        tile="t1"
        tabs={tabs}
        panelKey="a"
        title="A"
        focused={false}
        multiTile
        documentFocused
      />,
      { container: prefix }
    );
    render(<TileActions tile="t1" header={<span>h</span>} menu={<span>m</span>} />, {
      container: right,
    });
    const bar = row.querySelector<HTMLElement>('.canopy-tile-bar')!;
    const list = bar.querySelector<HTMLElement>('.canopy-tile-bar__tabs')!;
    const actions = row.querySelector<HTMLElement>('.canopy-tile-bar__actions')!;
    size(row, { clientWidth: rowWidth });
    // The grip and padding are 24 px; the tab list is clipped to 50 px. Each tab's title would
    // take its share of the rest (30 px of chrome around it and the 2 px the share adds),
    // clamped to 96..220 per tab.
    size(bar, { offsetWidth: 74 });
    size(list, { clientWidth: 50, scrollWidth: 50 });
    const shown = [...list.querySelectorAll<HTMLElement>('.canopy-tile-bar__tab')];
    for (const tab of shown) {
      size(tab, { offsetWidth: 40 });
      const title = tab.querySelector<HTMLElement>('.canopy-tile-bar__title')!;
      size(title, { clientWidth: 10, scrollWidth: (tabsNatural - 24) / shown.length - 32 });
    }
    box(actions, rowWidth - actionsWidth, actionsWidth);
    return { row, bar, actions };
  }

  it('shareTileHeader caps the actions and the bar on their own elements', () => {
    const { bar, actions } = headerRow(200, 300, 600);
    shareTileHeader(bar);
    expect(actions.style.getPropertyValue(TILE_ACTIONS_CAP)).toBe('400px');
    expect(bar.style.getPropertyValue(TILE_BAR_CAP)).toBe('300px');
  });

  it('shareTileHeader from the actions finds the same bar', () => {
    const two = [
      { key: 'a', title: 'A' },
      { key: 'b', title: 'B' },
    ];
    const { bar, actions } = headerRow(900, 300, 600, two);
    shareTileHeader(actions);
    expect(actions.style.getPropertyValue(TILE_ACTIONS_CAP)).toBe('300px');
    expect(bar.style.getPropertyValue(TILE_BAR_CAP)).toBe('300px');
  });

  // The tabs come first: a lone tab keeps its whole width up to what leaves the header its
  // floor (◀ ▶, the zoom button, "⋯"), and never less than one 96 px tab.
  it('tileHeaderCaps: a lone tab keeps its width up to what leaves the header its floor', () => {
    // Plenty of room: the tab list keeps its natural width, the header takes the rest.
    expect(tileHeaderCaps(1600, 170, 0, 168, true).actions).toBe(1430);
    // A lone tab may take more than half the row, as long as the floor stays.
    expect(tileHeaderCaps(335, 170, 0, 160, true).actions).toBe(165);
    // The floor beats the tab's width, down to the list's minimum.
    expect(tileHeaderCaps(335, 240, 0, 292, true).actions).toBe(335 - TILE_TABS_MIN_PX);
    // The minimum: the grip (20 px), the bar's 4 px padding and one 96 px tab.
    expect(TILE_TABS_MIN_PX).toBe(20 + 4 + 96);
  });

  it('shareTileHeader adds the actions’ own extras to the header floor it was given', () => {
    const { bar, actions } = headerRow(300, 200, 800);
    const slot = actions.querySelector('.canopy-tile-bar__header')!;
    // The ☰ menu, the gap and the padding: 124 px beside the header slot.
    box(slot, 800 - 200, 76);
    // One tab is at most 220 px: the list keeps 244, the header takes the rest.
    actions.dataset.headerNeed = '168';
    shareTileHeader(bar);
    expect(actions.style.getPropertyValue(TILE_ACTIONS_CAP)).toBe('556px');
    actions.dataset.headerNeed = '600';
    shareTileHeader(bar);
    expect(actions.style.getPropertyValue(TILE_ACTIONS_CAP)).toBe(`${800 - TILE_TABS_MIN_PX}px`);
  });

  it('shareTileHeader gives several tabs no more than half the row', () => {
    const tabs = [
      { key: 'a', title: 'A' },
      { key: 'b', title: 'B' },
    ];
    const { bar, actions } = headerRow(700, 300, 800, tabs);
    box(actions.querySelector('.canopy-tile-bar__header')!, 800 - 300, 256);
    actions.dataset.headerNeed = '168';
    shareTileHeader(bar);
    expect(actions.style.getPropertyValue(TILE_ACTIONS_CAP)).toBe('400px');
  });

  it('a header reports its need through the tile context, which shares the row again', () => {
    function Needy({ need }: { need: number }) {
      const fit = useContext(TileHeaderContext);
      useLayoutEffect(() => fit?.reportNeed?.(need), [fit, need]);
      return <span>h</span>;
    }
    const { rerender } = render(<TileActions tile="t1" header={<Needy need={310} />} />);
    const actions = screen.getByTestId('tile-actions');
    expect(actions.dataset.headerNeed).toBe('310');
    rerender(<TileActions tile="t1" header={<Needy need={0} />} />);
    expect(actions.dataset.headerNeed).toBeUndefined();
  });

  it('shareTileHeader leaves a bar outside a header row, or an unlaid-out row, alone', () => {
    render(<TileBar tile="t9" panelKey="a" title="A" focused={false} multiTile documentFocused />);
    const lone = document.querySelector<HTMLElement>('.canopy-tile-bar[data-tile="t9"]')!;
    shareTileHeader(lone);
    expect(lone.style.getPropertyValue(TILE_BAR_CAP)).toBe('');
    const { bar, actions } = headerRow(200, 300, 0);
    shareTileHeader(bar);
    expect(actions.style.getPropertyValue(TILE_ACTIONS_CAP)).toBe('');
    expect(bar.style.getPropertyValue(TILE_BAR_CAP)).toBe('');
  });
});

describe('TileBar.css', () => {
  const require = createRequire(import.meta.url);
  const css = readFileSync(require.resolve('./TileBar.css'), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    ''
  );
  const rules = css
    .split('}')
    .map((rule) => rule.split('{'))
    .filter(([selector]) => selector!.trim() !== '')
    .map(([selector, body = '']) => ({ selector: selector!.trim(), body }));

  it('anchors every selector on the bar class and never on dockview', () => {
    expect(rules.length).toBeGreaterThan(0);
    for (const { selector } of rules) {
      for (const part of selector.split(',')) {
        expect(part.trim()).toMatch(/^\.canopy-tile-bar(?![\w-]*-host)/);
      }
      expect(selector).not.toMatch(/\.dv-|\.canopy-dock/);
    }
  });

  it('uses host contract colours only and makes no stacking context', () => {
    for (const { body } of rules) {
      expect(body).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgb|hsl/);
      // `z-index: auto` is allowed: it takes a stacking context away (a Carbon header's).
      expect(body.replace(/z-index\s*:\s*auto\b/g, '')).not.toMatch(
        /\b(z-index|transform|contain|filter|isolation|will-change)\s*:/
      );
      expect(body).not.toMatch(/position\s*:\s*(fixed|sticky)/);
      for (const found of body.matchAll(/var\((--[\w-]+)/g)) {
        expect(found[1]).toMatch(/^--canopy-/);
      }
    }
  });

  it('styles the grip, the tabs, the showing tab and the actions', () => {
    const selectors = rules.map((r) => r.selector);
    for (const name of [
      '.canopy-tile-bar__grip',
      '.canopy-tile-bar__tab',
      '.canopy-tile-bar__tab--showing',
      '.canopy-tile-bar__actions',
    ]) {
      expect(selectors).toContain(name);
    }
  });
  /** The declarations of the rule whose selector is exactly `selector`. */
  function body(selector: string): string {
    return rules.find((r) => r.selector === selector)?.body ?? '';
  }

  it('the tab list scrolls sideways and its tabs keep their width', () => {
    expect(body('.canopy-tile-bar__tabs')).toMatch(/overflow-x\s*:\s*auto/);
    expect(body('.canopy-tile-bar__tabs')).toMatch(/min-width\s*:\s*0/);
    expect(body('.canopy-tile-bar__tab')).toMatch(/flex\s*:\s*none/);
  });

  it('the bar and the actions are capped by the shares the script measures', () => {
    expect(body('.canopy-tile-bar')).toMatch(/max-width\s*:\s*var\(--canopy-tile-bar-cap/);
    expect(body('.canopy-tile-bar__actions')).toMatch(
      /max-width\s*:\s*var\(--canopy-tile-actions-cap/
    );
    // A screen header is given the whole lane, so it can grow back as it widens.
    expect(body('.canopy-tile-bar__actions:has(.screen-header--tile)')).toMatch(
      /width\s*:\s*var\(--canopy-tile-actions-cap/
    );
  });

  it('a tile header shows no SCREEN label: the tab names the screen', () => {
    expect(body('.canopy-tile-bar__header .canopy-header__name')).toMatch(/display\s*:\s*none/);
  });

  it('the "More controls" button in a tile is as wide as TILE_HEADER_FIT counts', () => {
    const more = body('.canopy-tile-bar__header .screen-header__more');
    const rem = `${TILE_HEADER_FIT.triggerPx / 16}rem`;
    expect(more).toMatch(new RegExp(`(^|;)\\s*width\\s*:\\s*${rem}`));
    expect(more).toMatch(new RegExp(`inline-size\\s*:\\s*${rem}`));
    expect(more).toMatch(new RegExp(`min-width\\s*:\\s*${rem}`));
  });

  it('the zoom button in a tile is as wide as TILE_HEADER_FIT counts', () => {
    const button = body('.canopy-tile-bar__header .screen-header__zoom-menu');
    const rem = `${TILE_HEADER_FIT.zoomButtonPx / 16}rem`;
    expect(button).toMatch(new RegExp(`(^|;)\\s*width\\s*:\\s*${rem}`));
    expect(button).toMatch(new RegExp(`min-width\\s*:\\s*${rem}`));
  });

  it('a tab is 96 to 220 px wide, never a letter', () => {
    const tab = body('.canopy-tile-bar__tab');
    expect(tab).toMatch(/min-width\s*:\s*6rem/);
    expect(tab).toMatch(/max-width\s*:\s*min\(13\.75rem, 100%\)/);
  });
});
