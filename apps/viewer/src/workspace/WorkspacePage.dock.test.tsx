// The workspace's dock wiring on the layout holder.
// Pinned here: the content box holds the dock root, then the overlay layer
// with one item per mounted panel in strip order, then the drop preview; the
// read-only test surface (data-showing, data-layout and canopyDockLayout() on
// the dock root, nothing else); the two flags (`showing` shows a screen or
// frame and makes it report, `focused` prints and titles the document; an
// unmounted screen's report is dropped); every layout change goes through the
// reducer and reaches dockview from it (a drop, held while the drag is live;
// every close; Undo, ⌘⇧T and Recently closed; Reset); a showing screen
// mounts once across those; tab-missing inside its own tile; tile bars only
// with two or more tiles; and chrome off: one tile, no dock.
//
// ScreenPage is a probe that counts its mounts per tab key. The real
// createDock and useDockBridge run (dockview-core in jsdom); both are wrapped
// pass-through only to reach the api and the bridge. Multi-tile docks are
// seeded through the stored dock value (a reload), or made by a drop.

import { createElement, useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import type { NavigateFunction } from 'react-router-dom';
import type { DockviewApi } from 'dockview-core';
import type { Manifest } from '../api.js';
import type { TraceConfig } from '../config.js';
import { EmbedThemeContext } from '../pages/EmbedPage.js';
import { ZoomProvider } from '../ZoomContext.js';
import type { DockBridge } from './dock/useDockBridge.js';
import type { Layout, Source } from '@slaclab/canopy-dock-engine';
import { dockDragStart } from './dock/tabAdapter.js';
import { isMac } from '../screenActions/shortcuts.js';
import { DOCK_VERSION, readDock, removeDock, writeDock } from './dock/storage.js';
import { tabsStorageKey } from './tabs.js';
import { WorkspacePage, resetTiles } from './WorkspacePage.js';

const probe = vi.hoisted(() => {
  // Node 26's unusable global localStorage shadows jsdom's (see WorkspacePage.test.tsx).
  const g = globalThis as { localStorage?: Storage };
  if (typeof g.localStorage?.getItem !== 'function') {
    const data = new Map<string, string>();
    const storage: Storage = {
      get length() {
        return data.size;
      },
      clear: () => data.clear(),
      getItem: (key) => data.get(key) ?? null,
      key: (index) => [...data.keys()][index] ?? null,
      removeItem: (key) => void data.delete(key),
      setItem: (key, value) => void data.set(key, String(value)),
    };
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  }
  return {
    /** Mounts per screen (`<category>/<id>`). */
    mounts: new Map<string, number>(),
    /** Screens (`<category>/<id>`) that report no title. */
    silent: new Set<string>(),
    api: null as DockviewApi | null,
    bridge: null as DockBridge | null,
    creates: 0,
    /** Whether the probe reports its open screen (which gives its bar actions). */
    reportScreen: false,
    /** Screens (`<category>/<id>`) whose reload action ran, in order. */
    reloads: [] as string[],
    /** Mounted useShortcuts calls: each is one window keydown listener. */
    shortcutMounts: 0,
  };
});

vi.mock('../screenActions/shortcuts.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../screenActions/shortcuts.js')>();
  return {
    ...actual,
    useShortcuts: (...args: Parameters<typeof actual.useShortcuts>) => {
      useEffect(() => {
        probe.shortcutMounts += 1;
        return () => {
          probe.shortcutMounts -= 1;
        };
      }, []);
      actual.useShortcuts(...args);
    },
  };
});

vi.mock('../pages/ScreenPage.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../pages/ScreenPage.js')>();
  function ScreenProbe(props: {
    category?: string;
    id?: string;
    active?: boolean;
    onTitle?: (title: string) => void;
    onScreen?: (screen: unknown) => void;
  }) {
    const name = `${props.category ?? ''}/${props.id ?? ''}`;
    // With reportScreen: the open screen, with a document (download, ⌘S) and
    // a reload that records which screen it reloaded.
    const { onScreen } = props;
    useEffect(() => {
      if (!probe.reportScreen) return;
      onScreen?.({
        category: props.category ?? '',
        id: props.id ?? '',
        title: `Rendered ${props.id ?? ''}`,
        macros: {},
        element: null,
        documentUrl: `https://host/doc/${name}.screen.json`,
        reload: () => probe.reloads.push(name),
      });
    }, [onScreen, name, props.category, props.id]);
    useEffect(() => {
      probe.mounts.set(name, (probe.mounts.get(name) ?? 0) + 1);
      // Mount-only on purpose: a remount is what this counts.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    // Reports its title like ScreenPage: on mount and to every new callback.
    const { onTitle } = props;
    useEffect(() => {
      if (!probe.silent.has(name)) onTitle?.(`Rendered ${props.id ?? ''}`);
    }, [onTitle, name, props.id]);
    return createElement('div', {
      'data-testid': 'screen-probe',
      'data-id': props.id,
      'data-print': String(props.active),
      'data-reports': String(onTitle !== undefined),
    });
  }
  return { ...actual, ScreenPage: ScreenProbe };
});

vi.mock('./dock/createDock.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./dock/createDock.js')>();
  return {
    ...actual,
    createDock: (root: HTMLElement) => {
      const api = actual.createDock(root);
      probe.api = api;
      probe.creates += 1;
      return api;
    },
  };
});

vi.mock('./dock/useDockBridge.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./dock/useDockBridge.js')>();
  return {
    ...actual,
    useDockBridge: (...args: Parameters<typeof actual.useDockBridge>) => {
      const bridge = actual.useDockBridge(...args);
      probe.bridge = bridge;
      return bridge;
    },
  };
});

const MANIFEST: Manifest = {
  screens: [
    {
      id: 'knob',
      kind: 'ir',
      title: 'Knob device',
      category: 'bts',
      path: 'screens/bts/knob.screen.json',
    },
    {
      id: 'magnet',
      kind: 'ir',
      title: 'Magnet',
      category: 'common',
      path: 'screens/common/magnet.screen.json',
    },
    {
      id: 'gun',
      kind: 'ir',
      title: 'Gun',
      category: 'common',
      path: 'screens/common/gun.screen.json',
    },
  ],
};

const TRACE: TraceConfig = { path: 'trace/', query: 'pv=A&range=-1h' };
const BASE = 'https://host/screens';

const KNOB = 'bts/knob';
const MAGNET = 'common/magnet';
const GUN = 'common/gun';

beforeEach(() => {
  probe.mounts.clear();
  probe.silent.clear();
  document.title = 'Viewer';
  probe.api = null;
  probe.bridge = null;
  probe.creates = 0;
  probe.reportScreen = false;
  probe.reloads = [];
  // jsdom has no PointerEvent; dockview's drag source checks for it on dragstart.
  if (typeof PointerEvent === 'undefined')
    vi.stubGlobal('PointerEvent', class extends MouseEvent {});
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(MANIFEST), { status: 200 }))
  );
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const store of [globalThis.sessionStorage, globalThis.localStorage]) {
    try {
      store?.clear();
    } catch {
      // Storage unavailable: nothing to clear.
    }
  }
});

/** The router's navigate, captured for a navigation from outside the workspace. */
const router: { navigate: NavigateFunction | null } = { navigate: null };
function NavigateProbe() {
  const navigate = useNavigate();
  useEffect(() => {
    router.navigate = navigate;
  }, [navigate]);
  return null;
}

function renderAt(path: string, options: { trace?: TraceConfig; views?: boolean } = {}) {
  const config = options.trace
    ? { trace: options.trace, ...(options.views ? { views: { path: 'views' } } : {}) }
    : undefined;
  return render(
    <MemoryRouter initialEntries={[path]}>
      <NavigateProbe />
      <ZoomProvider>
        <EmbedThemeContext.Provider
          value={{ mode: 'dark', id: 'dark', anchorRef: { current: null } }}
        >
          <WorkspacePage screensBaseUrl={BASE} config={config} />
        </EmbedThemeContext.Provider>
      </ZoomProvider>
    </MemoryRouter>
  );
}

/** The session's tabs (a reload): without a stored dock, one tile of them all. */
function storeTabs(keys: string[], active: string | null) {
  sessionStorage.setItem(tabsStorageKey('/'), JSON.stringify({ keys, active }));
}

/** The stored dock a reload lays out (pruned to the session's tabs). */
function storeDock(layout: Layout) {
  // writeDock skips a value equal to the last one it saw; start clean.
  removeDock('/');
  writeDock('/', { version: DOCK_VERSION, layout, panels: {} });
}

const tile = (id: string, ...tabs: string[]): Layout => ({ tile: id, tabs, showing: tabs[0]! });

function dockRoot(): HTMLElement & { canopyDockLayout?: () => unknown } {
  return screen.getByTestId('workspace-dock');
}

/** The showing keys in strip order (the dock root's data-showing). */
function showing(): string[] {
  return JSON.parse(dockRoot().dataset.showing ?? 'null') as string[];
}

/** The holder's layout (the dock root's data-layout). */
function holder(): Layout | null {
  return JSON.parse(dockRoot().dataset.layout ?? 'null') as Layout | null;
}

/** What dockview shows: per group, its panels in order. */
function groups(): string[][] {
  return probe.api!.groups.map((group) => group.panels.map((panel) => panel.id));
}

/**
 * The open tabs in strip order: the strip's with one tile (or none),
 * else every tile bar's, tile by tile.
 */
function tabEls(): HTMLElement[] {
  const row = screen.queryByRole('tablist', { name: 'Open tabs' });
  if (row) return within(row).queryAllByRole('tab');
  return [
    ...document.querySelectorAll<HTMLElement>(
      '[data-testid="tile-bar"] [role="tab"][data-tab-key]'
    ),
  ];
}

/** A tab's manifest title (the strip's own title text; a tile bar shows the reported one). */
function titleOf(tab: HTMLElement): string {
  return TITLES[tab.dataset.tabKey ?? ''] ?? tab.getAttribute('title') ?? '';
}

/** The open tabs' titles in strip order. */
function stripKeys(): string[] {
  return tabEls().map(titleOf);
}

/** The open tab titled `name`, in the strip or in its tile's bar. */
function stripTab(name: RegExp): HTMLElement {
  const tab = tabEls().find((t) => name.test(titleOf(t)));
  if (!tab) throw new Error(`no tab ${name}`);
  return tab;
}

/** Shows the tab titled `name` and focuses its tile: a press and a click on its tab. */
function pick(name: RegExp) {
  const tab = stripTab(name);
  fireEvent.pointerDown(tab);
  fireEvent.mouseDown(tab);
  fireEvent.click(tab);
}

/** Closes the tab titled `name` with its own × (the strip's or its tile bar's). */
function closeTab(name: RegExp) {
  fireEvent.click(stripTab(name).querySelector('button')!);
}

/** Opens the window menu (☰) and finds its entry `label`. */
async function windowMenuItem(label: string): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole('button', { name: 'Window menu' }));
  await screen.findAllByRole('menuitem');
  return screen
    .getAllByRole('menuitem')
    .find((m) => (m.getAttribute('title') ?? m.textContent) === label)!;
}

/** The overlay items, in DOM order, by tab key. */
function itemKeys(): string[] {
  return [...document.querySelectorAll<HTMLElement>('.canopy-dock-overlay__item')].map(
    (el) => el.dataset.tabKey ?? ''
  );
}

function screenOf(key: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    `.canopy-dock-overlay__item[data-tab-key="${key}"] > .workspace__screen`
  );
}

/** Mounted screen keys, in DOM order. */
function mountedKeys(): string[] {
  return [...document.querySelectorAll<HTMLElement>('.workspace__screen')].map(
    (el) => el.dataset.tabKey ?? ''
  );
}

/** The tile bar whose showing tab is `key`. */
function bar(key: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(
    `[data-testid="tile-bar"][data-panel-key="${key}"]`
  );
  if (!el) throw new Error(`no bar for ${key}`);
  return el;
}

/** The header actions of the tile whose showing tab is `key`. */
function actions(key: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(
    `[data-testid="tile-actions"][data-tile="${bar(key).dataset.tile}"]`
  );
  if (!el) throw new Error(`no actions for ${key}`);
  return el;
}

/** The title the header of `key`'s tile shows, or null without one. */
function headerTitle(key: string): string | null {
  const header = document.querySelector<HTMLElement>(
    `[data-testid="tile-bar"][data-panel-key="${key}"]`
  )
    ? actions(key).querySelector('[data-testid="screen-header-title"]')
    : null;
  // The header's title text comes before its detail span.
  return header?.childNodes[0]?.textContent ?? null;
}

/** The dock root's client box, which hit testing reads. */
const DOCK_W = 1000;
const DOCK_H = 800;

/** A drag event at `point` (jsdom has no DragEvent). */
function dragEvent(type: string, point: { clientX: number; clientY: number }): MouseEvent {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...point });
  Object.defineProperty(event, 'dataTransfer', { value: null });
  return event;
}

/**
 * Drags `source` over the dock root to `point` and drops it there. Returns the
 * holder's tile count and dockview's group count right after the drop, before
 * the drag has ended (its end runs a turn later).
 */
function dropAt(source: Source, point: { clientX: number; clientY: number }) {
  const root = dockRoot();
  root.getBoundingClientRect = () => new DOMRect(0, 0, DOCK_W, DOCK_H);
  dockDragStart(source, null);
  act(() => {
    root.dispatchEvent(dragEvent('dragover', point));
  });
  act(() => {
    root.dispatchEvent(dragEvent('drop', point));
  });
  return { groups: probe.api!.groups.length };
}

/** Inside the one tile, in its right edge zone. */
const RIGHT_EDGE = { clientX: DOCK_W - 60, clientY: DOCK_H / 2 };

/** KNOB | MAGNET, MAGNET focused (the session's active). */
async function twoScreens() {
  storeTabs([KNOB, MAGNET], MAGNET);
  storeDock({ split: 'row', items: [tile('a', KNOB), tile('b', MAGNET)] });
  renderAt('/embed/');
  await screen.findAllByTestId('screen-probe');
  await waitFor(() => expect(showing()).toEqual([KNOB, MAGNET]));
  await waitFor(() => expect(groups()).toEqual([[KNOB], [MAGNET]]));
}

const TITLES: Record<string, string> = {
  [KNOB]: 'Knob device',
  [MAGNET]: 'Magnet',
  [GUN]: 'Gun',
  '@trace': 'Data Browser',
};

/** The holder and dockview agree, every open key is in a tile, every showing screen is mounted. */
function expectInvariants() {
  const layout = holder();
  const open = tabEls().map((tab) => tab.dataset.tabKey ?? '');
  const placed = groups().flat();
  expect([...placed].sort()).toEqual([...open].sort());
  for (const key of showing().filter((k) => !k.startsWith('@'))) {
    expect(mountedKeys()).toContain(key);
  }
  expect(groups().length).toBe(layout === null ? 0 : tileCount(layout));
}

function tileCount(layout: Layout): number {
  return 'tile' in layout ? 1 : layout.items.reduce((n, item) => n + tileCount(item), 0);
}

describe('WorkspacePage dock', () => {
  it('puts the overlay layer right after the dock root, with one item per mounted panel, then the drop preview', async () => {
    renderAt(`/embed/${KNOB}`);
    await screen.findByTestId('screen-probe');
    const root = dockRoot();
    expect(root.parentElement!.classList.contains('workspace__content')).toBe(true);
    expect(root.nextElementSibling!.classList.contains('canopy-dock-overlay')).toBe(true);
    expect(root.querySelector('.canopy-dock')).not.toBeNull();
    expect(itemKeys()).toEqual([KNOB]);
    const item = document.querySelector<HTMLElement>('.canopy-dock-overlay__item')!;
    expect(item.dataset.focused).toBe('true');
    expect(screenOf(KNOB)!.dataset.active).toBe('true');
    // No drag, no preview painted.
    expect(document.querySelector('.canopy-drop-preview')).toBeNull();
  });

  it('exposes data-showing, data-layout and canopyDockLayout() on the dock root, and nothing else', async () => {
    renderAt(`/embed/${KNOB}`);
    await screen.findByTestId('screen-probe');
    const root = dockRoot();
    expect(showing()).toEqual([KNOB]);
    expect(holder()).toMatchObject({ tabs: [KNOB], showing: KNOB });
    const layout = root.canopyDockLayout!() as { panels: Record<string, unknown> };
    expect(layout).toEqual(probe.api!.toJSON());
    expect(Object.keys(layout.panels)).toEqual([KNOB]);
    // Read-only and invisible to enumeration: a property, not an API.
    expect(Object.keys(root)).not.toContain('canopyDockLayout');
    const dataset = Object.keys(root.dataset).sort();
    expect(dataset).toEqual(['layout', 'showing', 'testid']);
    expect(root.hasAttribute('data-docked')).toBe(false);
  });

  it('a strip click on a hidden tab shows it in its tile; the old one stays mounted, hidden', async () => {
    storeTabs([KNOB, MAGNET], KNOB);
    renderAt('/embed/');
    await screen.findByTestId('screen-probe');
    // One tile holding both tabs, Knob showing.
    expect(groups()).toEqual([[KNOB, MAGNET]]);
    pick(/Magnet/);
    await waitFor(() => expect(showing()).toEqual([MAGNET]));
    expect(groups()).toEqual([[KNOB, MAGNET]]);
    expect(probe.api!.groups[0]!.activePanel?.id).toBe(MAGNET);
    const knob = screenOf(KNOB)!;
    expect(knob.classList.contains('workspace__screen--hidden')).toBe(true);
    expect(knob.getAttribute('aria-hidden')).toBe('true');
    expect(knob.hasAttribute('inert')).toBe(true);
    expect(screenOf(MAGNET)!.dataset.active).toBe('true');
    expect(probe.mounts.get(KNOB)).toBe(1);
  });

  it('lays out a stored dock: every showing screen reports, only the focused one prints', async () => {
    await twoScreens();
    for (const key of [KNOB, MAGNET]) {
      const el = screenOf(key)!;
      expect(el.classList.contains('workspace__screen--hidden')).toBe(false);
      expect(el.hasAttribute('inert')).toBe(false);
      expect(el.getAttribute('aria-hidden')).toBeNull();
      expect(el.querySelector<HTMLElement>('[data-testid="screen-probe"]')!.dataset.reports).toBe(
        'true'
      );
    }
    expect(screenOf(MAGNET)!.dataset.active).toBe('true');
    expect(screenOf(KNOB)!.dataset.active).toBe('false');
    expect(
      screenOf(MAGNET)!.querySelector<HTMLElement>('[data-testid="screen-probe"]')!.dataset.print
    ).toBe('true');
    expect(
      screenOf(KNOB)!.querySelector<HTMLElement>('[data-testid="screen-probe"]')!.dataset.print
    ).toBe('false');
    expectInvariants();
  });

  it('gives each of two tiles its own bar and header, with its own screen title', async () => {
    await twoScreens();
    await waitFor(() => expect(headerTitle(KNOB)).toBe('Rendered knob'));
    await waitFor(() => expect(headerTitle(MAGNET)).toBe('Rendered magnet'));
    expect(bar(KNOB).dataset.tile).toBe('a');
    expect(bar(MAGNET).dataset.tile).toBe('b');
    // The bar lists its tile's tabs.
    expect(
      within(bar(KNOB))
        .getAllByRole('tab')
        .map((t) => t.getAttribute('title'))
    ).toEqual(['Rendered knob']);
    // Focus moves to Knob's tile: the reports and headers stay.
    pick(/Knob device/);
    await waitFor(() => expect(screenOf(KNOB)!.dataset.active).toBe('true'));
    expect(headerTitle(MAGNET)).toBe('Rendered magnet');
    expect(headerTitle(KNOB)).toBe('Rendered knob');
  });

  it('shows no tile bar with one tile; the header sits above the content', async () => {
    probe.reportScreen = true;
    storeTabs([KNOB, MAGNET], KNOB);
    renderAt('/embed/');
    await screen.findByTestId('screen-probe');
    await waitFor(() => expect(screen.getAllByTestId('screen-header')).toHaveLength(1));
    expect(document.querySelector('[data-testid="tile-bar"]')).toBeNull();
    expect(document.querySelector('[data-testid="tile-actions"] *')).toBeNull();
    const header = screen.getByTestId('screen-header');
    expect(header.closest('.workspace__content')).toBeNull();
    expect(header.closest('.workspace__main')).not.toBeNull();
  });

  it('gives the document the focused tile title, switching with focus', async () => {
    await twoScreens();
    await waitFor(() => expect(document.title).toBe('Rendered magnet'));
    pick(/Knob device/);
    await waitFor(() => expect(document.title).toBe('Rendered knob'));
    // The page's own title comes back with the workspace gone.
    cleanup();
    expect(document.title).toBe('Viewer');
  });

  it("drops a hidden screen's report when it unmounts", async () => {
    storeTabs([KNOB, MAGNET], KNOB);
    renderAt('/embed/');
    await screen.findByTestId('screen-probe');
    await waitFor(() => expect(document.title).toBe('Rendered knob'));
    // Magnet shows in the tile: Knob stays mounted, hidden, reporting nothing.
    pick(/Magnet/);
    await waitFor(() => expect(showing()).toEqual([MAGNET]));
    expect(
      screenOf(KNOB)!.querySelector<HTMLElement>('[data-testid="screen-probe"]')!.dataset.reports
    ).toBe('false');
    // Closing Knob's tab unmounts it; a remount that reports nothing shows
    // the manifest title, not the dropped report.
    closeTab(/^Knob device$/);
    await waitFor(() => expect(screenOf(KNOB)).toBeNull());
    probe.silent.add(KNOB);
    const tree = screen.getByRole('navigation', { name: 'Screens' });
    fireEvent.click(within(tree).getByText('Knob device'));
    await waitFor(() => expect(showing()).toEqual([KNOB]));
    await waitFor(() => expect(probe.mounts.get(KNOB)).toBe(2));
    await waitFor(() => expect(document.title).toBe('Knob device'));
  });

  it('a drop goes through the reducer, and dockview follows only once the drag has ended', async () => {
    storeTabs([KNOB, MAGNET], KNOB);
    renderAt('/embed/');
    await screen.findByTestId('screen-probe');
    expect(groups()).toEqual([[KNOB, MAGNET]]);
    // Magnet's strip tab dragged to the tile's right edge.
    const during = dropAt({ tab: MAGNET }, RIGHT_EDGE);
    // The holder has split; dockview still shows the one tile while the drag is live.
    expect(tileCount(holder()!)).toBe(2);
    expect(during.groups).toBe(1);
    await waitFor(() => expect(groups()).toEqual([[KNOB], [MAGNET]]));
    expect(showing()).toEqual([KNOB, MAGNET]);
    expect(probe.mounts.get(KNOB)).toBe(1);
    expect(probe.mounts.get(MAGNET)).toBe(1);
    expectInvariants();
  });

  it('a screen-browser row dragged to an edge opens its screen there', async () => {
    renderAt(`/embed/${KNOB}`);
    await screen.findByTestId('screen-probe');
    const tree = screen.getByRole('navigation', { name: 'Screens' });
    await waitFor(() => expect(within(tree).getByText('Gun')).toBeTruthy());
    const row = within(tree).getByText('Gun').closest<HTMLElement>('[draggable="true"]')!;
    fireEvent.dragStart(row);
    const root = dockRoot();
    root.getBoundingClientRect = () => new DOMRect(0, 0, DOCK_W, DOCK_H);
    act(() => {
      root.dispatchEvent(dragEvent('dragover', RIGHT_EDGE));
    });
    act(() => {
      root.dispatchEvent(dragEvent('drop', RIGHT_EDGE));
    });
    // The drop opens the screen asynchronously; a loaded host can take over 1 s.
    await waitFor(() => expect(groups()).toEqual([[KNOB], [GUN]]), { timeout: 5_000 });
    expect(stripKeys()).toEqual(['Knob device', 'Gun']);
    expectInvariants();
  });

  it('keeps the holder and dockview in step across opening, focusing and closing', async () => {
    await twoScreens();
    expectInvariants();
    // A tree click replaces the focused tile's screen (Magnet's); Magnet closes.
    const tree = screen.getByRole('navigation', { name: 'Screens' });
    await waitFor(() => expect(within(tree).getByText('Gun')).toBeTruthy());
    fireEvent.click(within(tree).getByText('Gun'));
    await waitFor(() => expect(showing()).toEqual([KNOB, GUN]));
    await waitFor(() => expect(groups()).toEqual([[KNOB], [GUN]]));
    expectInvariants();
    // Closing Gun, its tile's only tab, removes the tile.
    closeTab(/^Gun$/);
    await waitFor(() => expect(groups()).toEqual([[KNOB]]));
    expect(stripKeys()).toEqual(['Knob device']);
    expectInvariants();
  });

  it("a tile bar tab's × closes that tab through the one close path, with Undo", async () => {
    await twoScreens();
    fireEvent.click(within(bar(KNOB)).getByRole('button', { name: /^Close tab: / }));
    await waitFor(() => expect(groups()).toEqual([[MAGNET]]));
    expect(screen.getByTestId('canopy-toast').textContent).toContain('Closed 1 tab');
    fireEvent.click(
      within(screen.getByTestId('canopy-toast')).getByRole('button', { name: 'Undo' })
    );
    await waitFor(() => expect(groups()).toEqual([[KNOB], [MAGNET]]));
    expectInvariants();
  });

  it('a showing screen mounts once across opening and closing another tab and across Reset', async () => {
    await twoScreens();
    const knob = screenOf(KNOB);
    // Open in new tab: a tab of the focused tile (Magnet's), shown there.
    const tree = screen.getByRole('navigation', { name: 'Screens' });
    await waitFor(() => expect(within(tree).getByText('Gun')).toBeTruthy());
    fireEvent.contextMenu(within(tree).getByText('Gun'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Open in new tab' }));
    await waitFor(() => expect(groups()).toEqual([[KNOB], [MAGNET, GUN]]));
    expect(showing()).toEqual([KNOB, GUN]);
    expect(probe.mounts.get(KNOB)).toBe(1);

    closeTab(/^Gun$/);
    await waitFor(() => expect(groups()).toEqual([[KNOB], [MAGNET]]));
    expect(probe.mounts.get(KNOB)).toBe(1);

    fireEvent.click(await windowMenuItem('Reset layout'));
    await waitFor(() =>
      expect(screen.getByTestId('canopy-toast').textContent).toContain('Layout reset')
    );
    expect(groups()).toEqual([[KNOB], [MAGNET]]);
    expect(probe.mounts.get(KNOB)).toBe(1);
    expect(probe.mounts.get(MAGNET)).toBe(1);
    expect(screenOf(KNOB)).toBe(knob);
  });

  it('shows "No tab open" only when nothing is open', async () => {
    renderAt(`/embed/${KNOB}`);
    await screen.findByTestId('screen-probe');
    expect(screen.queryByTestId('workspace-empty')).toBeNull();
    closeTab(/^Knob device$/);
    expect(screen.getByTestId('workspace-empty').textContent).toContain('No tab open');
    expect(screen.queryByTestId('dock-watermark')).toBeNull();
    expect(showing()).toEqual([]);
    expect(holder()).toBeNull();
    await waitFor(() => expect(groups()).toEqual([]));
  });

  it('shows tab-missing for a showing screen the manifest lacks inside its own tile', async () => {
    storeTabs([KNOB, 'bts/gone'], KNOB);
    storeDock({ split: 'row', items: [tile('a', KNOB), tile('b', 'bts/gone')] });
    renderAt('/embed/');
    await screen.findByTestId('screen-probe');
    const missing = await screen.findByTestId('tab-missing');
    expect(missing.closest<HTMLElement>('.canopy-dock-overlay__item')!.dataset.tabKey).toBe(
      'bts/gone'
    );
    // The other tile keeps its screen.
    expect(screenOf(KNOB)).not.toBeNull();
    fireEvent.click(within(missing).getByRole('button', { name: 'Close tab' }));
    await waitFor(() => expect(groups()).toEqual([[KNOB]]));
    expect(screen.queryByTestId('tab-missing')).toBeNull();
  });

  it('shows a tool frame in its own tile beside a focused screen and tells it it is visible', async () => {
    storeTabs(['@trace', KNOB, MAGNET], KNOB);
    storeDock({ split: 'row', items: [tile('a', '@trace'), tile('b', KNOB, MAGNET)] });
    renderAt('/embed/', { trace: TRACE });
    await screen.findAllByTestId('screen-probe');
    const frame = document.querySelector<HTMLIFrameElement>('iframe.workspace-trace')!;
    expect(frame.closest<HTMLElement>('.canopy-dock-overlay__item')!.dataset.tabKey).toBe('@trace');
    await waitFor(() => expect(showing()).toEqual(['@trace', KNOB]));
    // Not focused, still showing: shown, and visible to its page.
    expect(frame.style.visibility).toBe('');
    expect(frame.dataset.visible).toBe('true');
    // Its tile gets another tab, shown: the frame is hidden, still the same one.
    pick(/Magnet/);
    await waitFor(() => expect(showing()).toEqual(['@trace', MAGNET]));
    const dropped = dropAt({ tab: MAGNET }, { clientX: DOCK_W / 4, clientY: DOCK_H / 2 });
    expect(dropped.groups).toBe(2);
    await waitFor(() => expect(groups()).toEqual([['@trace', MAGNET], [KNOB]]));
    expect(document.querySelector('iframe.workspace-trace')).toBe(frame);
    expect(frame.style.visibility).toBe('hidden');
    expect(frame.dataset.visible).toBe('false');
  });

  it('builds no dock with chrome off', async () => {
    renderAt(`/embed/${KNOB}?_canopyChrome=0`);
    await screen.findByTestId('screen-probe');
    expect(screen.queryByTestId('workspace-dock')).toBeNull();
    expect(document.querySelector('.canopy-dock-overlay')).toBeNull();
    expect(probe.creates).toBe(0);
    expect(document.querySelector('.workspace__screen')!.parentElement!.classList).toContain(
      'workspace__content'
    );
  });

  it('chrome off keeps one tile: a second screen opens as its tab, shown alone, and nothing docks', async () => {
    renderAt(`/embed/${KNOB}?_canopyChrome=0`);
    await screen.findByTestId('screen-probe');
    act(() => {
      void router.navigate!(`/embed/${MAGNET}`);
    });
    await waitFor(() => expect(mountedKeys()).toEqual([KNOB, MAGNET]));
    const at = (key: string) =>
      document.querySelector<HTMLElement>(`.workspace__screen[data-tab-key="${key}"]`)!;
    expect(at(MAGNET).classList.contains('workspace__screen--hidden')).toBe(false);
    expect(at(MAGNET).dataset.active).toBe('true');
    expect(at(KNOB).classList.contains('workspace__screen--hidden')).toBe(true);
    expect(at(KNOB).hasAttribute('inert')).toBe(true);
    expect(probe.creates).toBe(0);
    expect(probe.api).toBeNull();
    expect(screen.queryByTestId('workspace-dock')).toBeNull();
    expect(document.querySelector('[data-testid="tile-bar"]')).toBeNull();
  });
});

describe('resetTiles', () => {
  it('lays every tile out as an equal column, tabs and showing kept', () => {
    const nested: Layout = {
      split: 'row',
      items: [
        { split: 'column', items: [tile('a', KNOB), tile('c', GUN)], size: 0.6 },
        { ...tile('b', MAGNET, '@trace'), size: 0.4 },
      ],
    };
    expect(resetTiles(nested)).toEqual({
      split: 'row',
      items: [
        { tile: 'a', tabs: [KNOB], showing: KNOB, size: 1 / 3 },
        { tile: 'c', tabs: [GUN], showing: GUN, size: 1 / 3 },
        { tile: 'b', tabs: [MAGNET, '@trace'], showing: MAGNET, size: 1 / 3 },
      ],
    });
  });

  it('has nothing to lay out below two tiles', () => {
    expect(resetTiles(null)).toBeNull();
    expect(resetTiles(tile('a', KNOB, MAGNET))).toBeNull();
  });
});

// Every screen tile's header has its own actions and zoom;
// the workspace binds the one shortcut listener, for the focused tile.
describe('WorkspacePage tile bar actions', () => {
  const barActions = (key: string) =>
    Array.from(actions(key).querySelectorAll<HTMLElement>('[data-screen-action]')).map(
      (b) => b.dataset.screenAction
    );

  /** KNOB | MAGNET | GUN side by side; GUN has focus. */
  async function threeTiles() {
    probe.reportScreen = true;
    storeTabs([KNOB, MAGNET, GUN], GUN);
    storeDock({ split: 'row', items: [tile('a', KNOB), tile('b', MAGNET), tile('c', GUN)] });
    renderAt('/embed/');
    await screen.findAllByTestId('screen-probe');
    await waitFor(() => expect(groups()).toEqual([[KNOB], [MAGNET], [GUN]]));
    await waitFor(() => expect(screenOf(GUN)!.dataset.active).toBe('true'));
    for (const key of [KNOB, MAGNET, GUN]) {
      await waitFor(() => expect(barActions(key)).toEqual(['reload', 'download', 'copy-link']));
    }
  }

  function pressSave(): KeyboardEvent {
    const e = new KeyboardEvent('keydown', {
      key: 's',
      code: 'KeyS',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(e);
    return e;
  }

  const fetchedDocs = () =>
    vi
      .mocked(fetch)
      .mock.calls.map(([url]) => String(url))
      .filter((url) => url.startsWith('https://host/doc/'));

  it('gives every screen tile its own actions and zoom, with exactly one shortcut listener', async () => {
    await threeTiles();
    for (const key of [KNOB, MAGNET, GUN]) {
      expect(within(actions(key)).getAllByTestId('screen-header')).toHaveLength(1);
      expect(within(actions(key)).getByTestId('zoom-percent')).toBeTruthy();
      // Plain buttons with native titles; nothing a header opens renders in it.
      for (const button of actions(key).querySelectorAll<HTMLElement>('[data-screen-action]')) {
        expect(button.tagName).toBe('BUTTON');
        expect(button.getAttribute('title')).toBeTruthy();
      }
      expect(actions(key).querySelector('[role="tooltip"]')).toBeNull();
    }
    expect(probe.shortcutMounts).toBe(1);
    // Focus moves: still the one listener.
    pick(/Knob device/);
    await waitFor(() => expect(screenOf(KNOB)!.dataset.active).toBe('true'));
    expect(probe.shortcutMounts).toBe(1);
  });

  it("runs a shortcut on the focused tile's action only", async () => {
    await threeTiles();
    let e: KeyboardEvent;
    await act(async () => {
      e = pressSave();
    });
    expect(e!.defaultPrevented).toBe(true);
    await waitFor(() => expect(fetchedDocs()).toEqual([`https://host/doc/${GUN}.screen.json`]));
    // Focus moves to Knob: the next ⌘S downloads Knob's screen only. That
    // download fails, so its outcome is a status text to look for.
    vi.mocked(fetch).mockImplementation(async (url) =>
      String(url).startsWith('https://host/doc/')
        ? new Response('', { status: 404, statusText: 'Not Found' })
        : new Response(JSON.stringify(MANIFEST), { status: 200 })
    );
    pick(/Knob device/);
    await waitFor(() => expect(screenOf(KNOB)!.dataset.active).toBe('true'));
    await act(async () => {
      pressSave();
    });
    await waitFor(() =>
      expect(fetchedDocs()).toEqual([
        `https://host/doc/${GUN}.screen.json`,
        `https://host/doc/${KNOB}.screen.json`,
      ])
    );
    // The shortcut's outcome shows in the focused tile's header, not another's.
    await waitFor(() =>
      expect(within(actions(KNOB)).getByTestId('screen-action-status').textContent).toBe(
        'Download screen failed: 404 Not Found fetching the screen'
      )
    );
    expect(within(actions(GUN)).getByTestId('screen-action-status').textContent).toBe('');
    expect(within(actions(MAGNET)).getByTestId('screen-action-status').textContent).toBe('');
  });

  it('acts on its own tile when an action in an unfocused header is clicked', async () => {
    await threeTiles();
    const reload = actions(KNOB).querySelector<HTMLElement>('[data-screen-action="reload"]')!;
    await act(async () => {
      fireEvent.pointerDown(reload);
      fireEvent.click(reload);
    });
    await waitFor(() => expect(probe.reloads).toEqual([KNOB]));
    const middle = actions(MAGNET).querySelector<HTMLElement>('[data-screen-action="reload"]')!;
    await act(async () => {
      fireEvent.click(middle);
    });
    await waitFor(() => expect(probe.reloads).toEqual([KNOB, MAGNET]));
  });

  it('binds no shortcut with chrome off', async () => {
    probe.reportScreen = true;
    renderAt(`/embed/${KNOB}?_canopyChrome=0`);
    await screen.findByTestId('screen-probe');
    await act(async () => {
      expect(pressSave().defaultPrevented).toBe(false);
    });
    expect(fetchedDocs()).toEqual([]);
  });
});

// Save view sits in every tool tile's header and saves that
// tile's instance. The header holds the button only; the dialog renders
// outside the dock. A save writes the stored layout again.
describe('WorkspacePage Save view in tool tiles', () => {
  const FIRST = '@trace';
  const SECOND = '@trace/2';
  let views: { id: string; name: string; kind?: string; query: string }[];
  let writes: { url: string; body: unknown }[];

  beforeEach(() => {
    views = [];
    writes = [];
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (!url.includes('/views')) return new Response(JSON.stringify(MANIFEST), { status: 200 });
      if (method === 'GET') return new Response(JSON.stringify({ views }), { status: 200 });
      const id = decodeURIComponent(url.slice(url.lastIndexOf('/') + 1));
      const body = JSON.parse(String(init?.body)) as { name: string; query: string };
      writes.push({ url, body });
      const view = { id, ...body };
      views = [...views.filter((v) => v.id !== id), view];
      return new Response(JSON.stringify(view), { status: 201 });
    });
  });

  const saveButton = (key: string) =>
    within(actions(key)).getByRole('button', { name: 'Save view' });

  const focusedKey = () =>
    document.querySelector<HTMLElement>('.canopy-dock-overlay__item[data-focused="true"]')?.dataset
      .tabKey;

  const storedInstances = () =>
    (
      JSON.parse(sessionStorage.getItem(tabsStorageKey('/')) ?? '{}') as {
        instances?: Record<string, { query?: string; view?: string }>;
      }
    ).instances ?? {};

  /** Two data browser tiles side by side; SECOND has focus. */
  async function twoTools() {
    sessionStorage.setItem(
      tabsStorageKey('/'),
      JSON.stringify({
        keys: [FIRST, SECOND],
        active: SECOND,
        instances: { [FIRST]: { query: 'pv=FIRST:PV' }, [SECOND]: { query: 'pv=SECOND:PV' } },
      })
    );
    storeDock({ split: 'row', items: [tile('a', FIRST), tile('b', SECOND)] });
    renderAt('/embed/', { trace: TRACE, views: true });
    await waitFor(() => expect(groups()).toEqual([[FIRST], [SECOND]]));
    await waitFor(() => expect(focusedKey()).toBe(SECOND));
    await waitFor(() => expect(saveButton(FIRST)).toBeTruthy());
    await waitFor(() => expect(saveButton(SECOND)).toBeTruthy());
  }

  it('puts one Save view button in every tool tile, and there is no strip row', async () => {
    await twoTools();
    for (const key of [FIRST, SECOND]) {
      expect(within(actions(key)).getAllByRole('button', { name: 'Save view' })).toHaveLength(1);
      // The bar shows its tab's title.
      expect(within(bar(key)).getByRole('tab').getAttribute('title')).not.toBe('');
    }
    // Two tiles: each has its bar, and the strip row is gone.
    expect(document.querySelector('.workspace__strip')).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Save view' })).toHaveLength(2);
  });

  it('gives a screen tile no Save view', async () => {
    storeTabs([KNOB, FIRST], KNOB);
    storeDock({ split: 'row', items: [tile('a', KNOB), tile('b', FIRST)] });
    renderAt('/embed/', { trace: TRACE, views: true });
    await screen.findByTestId('screen-probe');
    await waitFor(() => expect(saveButton(FIRST)).toBeTruthy());
    expect(within(actions(KNOB)).queryByRole('button', { name: 'Save view' })).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Save view' })).toHaveLength(1);
  });

  it('offers no Save view without saved views', async () => {
    storeTabs([FIRST, SECOND], FIRST);
    storeDock({ split: 'row', items: [tile('a', FIRST), tile('b', SECOND)] });
    renderAt('/embed/', { trace: TRACE });
    await waitFor(() => expect(bar(FIRST)).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Save view' })).toBeNull();
  });

  it('renders the dialog outside every tile bar and outside the dock', async () => {
    await twoTools();
    fireEvent.click(saveButton(FIRST));
    const name = await screen.findByLabelText('Name');
    const modal = name.closest<HTMLElement>('.cds--modal')!;
    expect(modal).not.toBeNull();
    for (const el of document.querySelectorAll(
      '[data-testid="tile-bar"], [data-testid="tile-actions"]'
    )) {
      expect(el.contains(modal)).toBe(false);
      expect(el.contains(name)).toBe(false);
      expect(el.querySelector('.cds--modal, [role="dialog"], [role="tooltip"]')).toBeNull();
    }
    expect(dockRoot().contains(modal)).toBe(false);
    expect(document.querySelector('.canopy-dock-overlay')!.contains(modal)).toBe(false);
    expect(modal.closest('.workspace__content')).toBeNull();
    // A child of the workspace root itself, as the plot dialog is.
    expect(modal.closest('[data-testid="workspace"]')).toBe(screen.getByTestId('workspace'));
    expect(modal.closest('.workspace__main')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByLabelText('Name')).toBeNull());
  });

  it("saves the instance of the tile that asked, not the focused one's", async () => {
    await twoTools();
    // A click without a press: focus stays on SECOND.
    fireEvent.click(saveButton(FIRST));
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'First view' } });
    expect(focusedKey()).toBe(SECOND);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toEqual({
      url: 'http://localhost:3000/views/first-view',
      body: { name: 'First view', query: 'pv=FIRST:PV' },
    });
    await waitFor(() => expect(storedInstances()[FIRST]?.view).toBe('first-view'));
    expect(storedInstances()[SECOND]?.view ?? null).toBeNull();
    expect(focusedKey()).toBe(SECOND);
    await waitFor(() => expect(screen.queryByLabelText('Name')).toBeNull());
    expect(within(actions(FIRST)).getByTestId('save-view-status').textContent).toContain(
      'First view'
    );
    expect(within(actions(SECOND)).getByTestId('save-view-status').textContent).toBe('');
  });

  it('writes the stored layout after a save', async () => {
    await twoTools();
    const before = JSON.stringify(readDock('/'));
    fireEvent.click(saveButton(SECOND));
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Second view' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    await waitFor(() => {
      const stored = readDock('/');
      expect(stored?.panels[SECOND]).toMatchObject({ kind: 'tool', view: 'second-view' });
    });
    const stored = readDock('/')!;
    expect(JSON.stringify(stored)).not.toBe(before);
    expect(Object.keys(stored.panels).sort()).toEqual([FIRST, SECOND]);
    expect((stored.panels[FIRST] as { view?: string }).view).toBeUndefined();
  });

  it('closes the dialog when its tab is closed', async () => {
    await twoTools();
    fireEvent.click(saveButton(FIRST));
    await screen.findByLabelText('Name');
    fireEvent.click(tabEls()[0]!.querySelector('button')!);
    await waitFor(() => expect(groups()).toEqual([[SECOND]]));
    expect(screen.queryByLabelText('Name')).toBeNull();
  });

  it('puts Save view above the content with one tile', async () => {
    storeTabs([FIRST], FIRST);
    renderAt('/embed/', { trace: TRACE, views: true });
    const button = await screen.findByRole('button', { name: 'Save view' });
    expect(probe.creates).toBe(1);
    expect(button.closest('.workspace__strip')).toBeNull();
    expect(button.closest('.workspace__content')).toBeNull();
    expect(button.closest('.workspace__main')).not.toBeNull();
  });
});

describe('WorkspacePage undo: one closed stack through the reducer', () => {
  /** (Knob over Gun) | Magnet; Gun focused. */
  const NESTED: Layout = {
    split: 'row',
    items: [
      { split: 'column', items: [tile('a', KNOB), tile('c', GUN)], size: 0.5 },
      { ...tile('b', MAGNET), size: 0.5 },
    ],
  };

  async function threeTiles() {
    storeTabs([KNOB, MAGNET, GUN], GUN);
    storeDock(NESTED);
    renderAt('/embed/');
    await screen.findAllByTestId('screen-probe');
    await waitFor(() => expect(groups()).toEqual([[KNOB], [GUN], [MAGNET]]));
  }

  /** The holder's tree with tile ids and sizes dropped: its shape and tabs. */
  function shape(layout: Layout | null = holder()): unknown {
    if (layout === null) return null;
    if ('tile' in layout) return layout.tabs;
    return { [layout.split]: layout.items.map((item) => shape(item)) };
  }

  const NESTED_SHAPE = { row: [{ column: [[KNOB], [GUN]] }, [MAGNET]] };

  function toast(): HTMLElement {
    return screen.getByTestId('canopy-toast');
  }

  function reopenShortcut() {
    fireEvent.keyDown(window, {
      key: 'T',
      shiftKey: true,
      metaKey: isMac,
      ctrlKey: !isMac,
    });
  }

  async function recentlyClosed(): Promise<HTMLElement> {
    return windowMenuItem('Recently closed');
  }

  it("a tab's × offers Undo, which brings the tile back where it was", async () => {
    await threeTiles();
    expect(shape()).toEqual(NESTED_SHAPE);
    closeTab(/^Gun$/);
    await waitFor(() => expect(stripKeys()).toEqual(['Knob device', 'Magnet']));
    await waitFor(() => expect(groups()).toEqual([[KNOB], [MAGNET]]));
    expect(toast().textContent).toContain('Closed 1 tab');
    fireEvent.click(within(toast()).getByRole('button', { name: 'Undo' }));
    // The strip follows the layout's order.
    await waitFor(() => expect(stripKeys()).toEqual(['Knob device', 'Gun', 'Magnet']));
    expect(shape()).toEqual(NESTED_SHAPE);
    await waitFor(() => expect(groups()).toEqual([[KNOB], [GUN], [MAGNET]]));
    expectInvariants();
  });

  it('Recently closed reopens a chosen group; ⌘⇧T reopens the newest', async () => {
    await threeTiles();
    closeTab(/^Gun$/);
    await waitFor(() => expect(stripKeys()).not.toContain('Gun'));
    closeTab(/^Knob device$/);
    await waitFor(() => expect(stripKeys()).toEqual(['Magnet']));
    await waitFor(() => expect(groups()).toEqual([[MAGNET]]));
    // Gun's group (the older one).
    const recent = await recentlyClosed();
    fireEvent.click(recent);
    fireEvent.click(within(recent).getByRole('menuitem', { name: 'Gun · you' }));
    await waitFor(() => expect(stripKeys()).toContain('Gun'));
    await waitFor(() => expect(groups().flat().sort()).toEqual([GUN, MAGNET].sort()));
    reopenShortcut();
    await waitFor(() => expect(stripKeys()).toEqual(['Knob device', 'Magnet', 'Gun']));
    await waitFor(() => expect(groups().flat().sort()).toEqual([GUN, KNOB, MAGNET].sort()));
    // Nothing left to reopen.
    reopenShortcut();
    expect(stripKeys()).toEqual(['Knob device', 'Magnet', 'Gun']);
    expectInvariants();
  });

  it('Reset layout offers "Layout reset · Undo", which restores the layout it replaced', async () => {
    await threeTiles();
    fireEvent.click(await windowMenuItem('Reset layout'));
    await waitFor(() => expect(shape()).toEqual({ row: [[KNOB], [GUN], [MAGNET]] }));
    await waitFor(() => expect(groups()).toEqual([[KNOB], [GUN], [MAGNET]]));
    expect(toast().textContent).toContain('Layout reset');
    fireEvent.click(within(toast()).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(shape()).toEqual(NESTED_SHAPE));
    expect(probe.mounts.get(KNOB)).toBe(1);
    expect(probe.api!.toJSON().grid.root.data).toHaveLength(2);
    expectInvariants();
  });

  it('a layout group restores the whole layout it recorded, tabs closed since included', async () => {
    await threeTiles();
    fireEvent.click(await windowMenuItem('Reset layout'));
    await waitFor(() => expect(shape()).toEqual({ row: [[KNOB], [GUN], [MAGNET]] }));
    closeTab(/^Gun$/);
    await waitFor(() => expect(stripKeys()).toEqual(['Knob device', 'Magnet']));
    // The close's toast replaced the reset's; the window menu's list still has the layout group.
    expect(toast().textContent).toContain('Closed 1 tab');
    const recent = await recentlyClosed();
    const entries = [...recent.querySelectorAll('[role="menu"] [role="menuitem"]')].map((m) =>
      m.getAttribute('title')
    );
    expect(entries).toEqual(['Gun · you', 'Layout reset · you']);
    fireEvent.click(recent);
    fireEvent.click(within(recent).getByRole('menuitem', { name: 'Layout reset · you' }));
    // The layout before the reset, Gun back in it.
    await waitFor(() => expect(shape()).toEqual(NESTED_SHAPE));
    expect(stripKeys()).toEqual(['Knob device', 'Gun', 'Magnet']);
    await waitFor(() => expect(groups()).toEqual([[KNOB], [GUN], [MAGNET]]));
    expect(probe.mounts.get(KNOB)).toBe(1);
    expectInvariants();
  });

  it('Close all records one group that names its tabs, and Undo brings the dock back', async () => {
    await threeTiles();
    fireEvent.click(await windowMenuItem('Close all'));
    await waitFor(() => expect(groups()).toEqual([]));
    expect(screen.getByTestId('workspace-empty')).toBeTruthy();
    fireEvent.click(within(toast()).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(shape()).toEqual(NESTED_SHAPE));
    await waitFor(() => expect(groups()).toEqual([[KNOB], [GUN], [MAGNET]]));
    expectInvariants();
  });
});
