// The strip row, the tile bars and the ☰ window menu, host-embedded and
// standalone alike. Pinned here: the strip row shows only with one tile and
// is then that tile's bar:
// its tabs, and at its right end the ☰ (standalone, the target badge just
// left of it); a strip tab dropped on the strip moves within the tile through
// the dock bridge. With two or more tiles there is no strip row and every
// tile has a bar; the one ☰ (and the badge) sits at the right end of the bar
// of the tile at the dock's top-right corner. With 1, 2 and 4 tiles every
// window action is reachable by mouse (the ☰) and by keyboard (⌥M / Alt+M,
// then the menu's own keys). Reset layout is a window-menu entry, not a strip button.
//
// Host-embedded is the real isHostEmbedded(): `?embedded=true` on the page URL
// and a parent window, stubbed through window.parent's getter. ScreenPage is a
// probe reporting its open screen, so screen bars carry their actions.

import { createElement, useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { DockviewApi } from 'dockview-core';
import type { Manifest } from '../api.js';
import { createBackendBadgeStore } from '../backendBadge.js';
import { EmbedThemeContext } from '../pages/EmbedPage.js';
import { ServicesContext } from '../services.js';
import type { ViewerServices } from '../services.js';
import { ZoomProvider } from '../ZoomContext.js';
import type { DockBridge } from './dock/useDockBridge.js';
import { DOCK_VERSION, removeDock, writeDock } from './dock/storage.js';
import type { Layout } from '@slaclab/canopy-dock-engine';
import { CLOSE_ALL, RECENTLY_CLOSED, RESET_LAYOUT, WINDOW_MENU } from './dock/WindowMenu.js';
import { resetHostEmbeddedForTests } from './host/hostEmbed.js';
import { tabsStorageKey } from './tabs.js';
import { WorkspacePage } from './WorkspacePage.js';

const probe = vi.hoisted(() => {
  // Node 26's unusable global localStorage/sessionStorage shadow jsdom's.
  const memory = (): Storage => {
    const data = new Map<string, string>();
    return {
      get length() {
        return data.size;
      },
      clear: () => data.clear(),
      getItem: (key) => data.get(key) ?? null,
      key: (index) => [...data.keys()][index] ?? null,
      removeItem: (key) => void data.delete(key),
      setItem: (key, value) => void data.set(key, String(value)),
    };
  };
  const g = globalThis as { localStorage?: Storage; sessionStorage?: Storage };
  for (const name of ['localStorage', 'sessionStorage'] as const) {
    if (typeof g[name]?.getItem === 'function') continue;
    Object.defineProperty(globalThis, name, { configurable: true, value: memory() });
  }
  return {
    api: null as DockviewApi | null,
    bridge: null as DockBridge | null,
  };
});

vi.mock('../pages/ScreenPage.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../pages/ScreenPage.js')>();
  function ScreenProbe(props: {
    category?: string;
    id?: string;
    onTitle?: (title: string) => void;
    onScreen?: (screen: unknown) => void;
  }) {
    const name = `${props.category ?? ''}/${props.id ?? ''}`;
    const { onScreen, onTitle } = props;
    useEffect(() => {
      onScreen?.({
        category: props.category ?? '',
        id: props.id ?? '',
        title: `Rendered ${props.id ?? ''}`,
        macros: {},
        element: null,
        documentUrl: `https://host/doc/${name}.screen.json`,
        reload: () => {},
      });
    }, [onScreen, name, props.category, props.id]);
    useEffect(() => {
      onTitle?.(`Rendered ${props.id ?? ''}`);
    }, [onTitle, props.id]);
    return createElement('div', { 'data-testid': 'screen-probe', 'data-id': props.id });
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
    { id: 'gun', kind: 'ir', title: 'Gun', category: 'bts', path: 'screens/bts/gun.screen.json' },
    { id: 'bpm', kind: 'ir', title: 'BPM', category: 'bts', path: 'screens/bts/bpm.screen.json' },
  ],
};

const BASE = 'https://host/screens';
const KNOB = 'bts/knob';
const MAGNET = 'common/magnet';
const GUN = 'bts/gun';
const BPM = 'bts/bpm';

const FAKE_PARENT = { postMessage: () => {} } as unknown as Window;

/** Make the page host-embedded: a parent window and `?embedded=true`. */
function hostEmbed(): void {
  vi.spyOn(window, 'parent', 'get').mockReturnValue(FAKE_PARENT);
  window.history.replaceState(null, '', '/?embedded=true');
}

function clearStorage(): void {
  for (const store of [globalThis.sessionStorage, globalThis.localStorage]) {
    try {
      store?.clear();
    } catch {
      // Storage unavailable: nothing to clear.
    }
  }
}

beforeEach(() => {
  resetHostEmbeddedForTests();
  probe.api = null;
  probe.bridge = null;
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
  window.history.replaceState(null, '', '/');
  resetHostEmbeddedForTests();
  clearStorage();
});

/** The page, with a backend store whose badge shows a label (standalone). */
function renderAt(path: string) {
  const backend = createBackendBadgeStore({
    backend: { name: 'example', label: 'Simulator', notice: null },
    binding: 'va@3',
  });
  const services = { backend } as unknown as ViewerServices;
  return render(
    <ServicesContext.Provider value={services}>
      <MemoryRouter initialEntries={[path]}>
        <ZoomProvider>
          <EmbedThemeContext.Provider
            value={{ mode: 'dark', id: 'dark', anchorRef: { current: null } }}
          >
            <WorkspacePage screensBaseUrl={BASE} />
          </EmbedThemeContext.Provider>
        </ZoomProvider>
      </MemoryRouter>
    </ServicesContext.Provider>
  );
}

function storeTabs(keys: string[], active: string | null) {
  sessionStorage.setItem(tabsStorageKey('/'), JSON.stringify({ keys, active }));
}

function storeDock(layout: Layout) {
  // writeDock skips a value equal to the last one it saw; start clean.
  removeDock('/');
  writeDock('/', { version: DOCK_VERSION, layout, panels: {} });
}

const tile = (id: string, ...tabs: string[]): Layout => ({ tile: id, tabs, showing: tabs[0]! });

/** The tile layouts these tests run at, keyed by tile count, and their top-right tile. */
const LAYOUTS: Record<1 | 2 | 4, { keys: string[]; layout: Layout; topRight: string }> = {
  1: { keys: [KNOB, MAGNET], layout: tile('a', KNOB, MAGNET), topRight: 'a' },
  2: {
    keys: [KNOB, MAGNET],
    layout: { split: 'row', items: [tile('a', KNOB), tile('b', MAGNET)] },
    topRight: 'b',
  },
  4: {
    keys: [KNOB, MAGNET, GUN, BPM],
    layout: {
      split: 'row',
      items: [
        { split: 'column', items: [tile('a', KNOB), tile('b', MAGNET)] },
        { split: 'column', items: [tile('c', GUN), tile('d', BPM)] },
      ],
    },
    topRight: 'c',
  },
};

/** Open the page at `count` tiles. */
async function openAt(count: 1 | 2 | 4) {
  const { keys, layout } = LAYOUTS[count];
  storeTabs(keys, keys[0]!);
  storeDock(layout);
  renderAt('/embed/');
  await screen.findAllByTestId('screen-probe');
  await waitFor(() => expect(probe.api).not.toBeNull());
  await waitFor(() => expect(tileCount()).toBe(count));
  await settle();
}

function stripRow(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.workspace__strip');
}

function strip(): HTMLElement {
  const el = stripRow();
  if (!el) throw new Error('no strip row');
  return el;
}

function layout(): Layout | null {
  return JSON.parse(screen.getByTestId('workspace-dock').dataset.layout ?? 'null') as Layout | null;
}

function tileCount(): number {
  const count = (node: Layout | null): number =>
    node === null ? 0 : 'tile' in node ? 1 : node.items.reduce((n, i) => n + count(i), 0);
  return count(layout());
}

function bridge(): DockBridge {
  if (!probe.bridge) throw new Error('no bridge');
  return probe.bridge;
}

const bars = () =>
  [...document.querySelectorAll<HTMLElement>('[data-testid="tile-bar"]')].map(
    (el) => el.dataset.panelKey ?? ''
  );

/** Screen headers in the document (a bar's, or the header row's). */
const headers = () => document.querySelectorAll('[data-testid="screen-header-title"]').length;

/** Every ☰ in the document. */
const menus = () => screen.queryAllByRole('button', { name: WINDOW_MENU });

/** Let the dock's renderers attach and the portals settle. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** The ☰ menu's top-level entries, by title, with their disabled state. */
async function menuEntries(): Promise<Record<string, boolean>> {
  await screen.findAllByRole('menuitem');
  const entries: Record<string, boolean> = {};
  for (const item of screen.getAllByRole('menuitem')) {
    if (item.parentElement?.closest('[role="menuitem"]')) continue;
    entries[item.getAttribute('title') ?? item.textContent ?? ''] =
      item.getAttribute('aria-disabled') === 'true';
  }
  return entries;
}

function pressShortcut() {
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'µ', code: 'KeyM', altKey: true, bubbles: true })
    );
  });
}

describe('workspace strip row (one tile)', () => {
  it('standalone: tabs, the target badge, then the ☰ at the right end; no Reset button', async () => {
    renderAt(`/embed/${KNOB}`);
    await screen.findByTestId('screen-probe');
    await waitFor(() => expect(probe.api).not.toBeNull());
    const row = strip();
    expect(row.querySelector('[role="tablist"][aria-label="Open tabs"]')).not.toBeNull();
    await waitFor(() => expect(row.querySelector('.target-badge')).not.toBeNull());
    expect(row.lastElementChild?.getAttribute('aria-label')).toBe(WINDOW_MENU);
    expect(row.querySelector('.target-badge')!.nextElementSibling).toBe(row.lastElementChild);
    expect(row.querySelector('.tab-strip__reset')).toBeNull();
    expect(screen.queryByRole('button', { name: RESET_LAYOUT })).toBeNull();
    expect(menus()).toHaveLength(1);
  });

  it('host-embedded: the tabs and the ☰, no target badge', async () => {
    hostEmbed();
    renderAt(`/embed/${KNOB}`);
    await screen.findByTestId('screen-probe');
    await waitFor(() => expect(probe.api).not.toBeNull());
    await settle();
    const row = strip();
    expect(row.querySelector('[role="tablist"][aria-label="Open tabs"]')).not.toBeNull();
    expect(row.querySelector('.target-badge')).toBeNull();
    expect(row.lastElementChild?.getAttribute('aria-label')).toBe(WINDOW_MENU);
    expect(screen.queryByRole('status', { name: /^Data connection/ })).toBeNull();
  });

  it('is the one tile’s bar for drops: a strip tab dropped later in the strip moves there', async () => {
    await openAt(1);
    const root = screen.getByTestId('workspace-dock');
    root.getBoundingClientRect = () => new DOMRect(0, 40, 1000, 760);
    const list = strip().querySelector<HTMLElement>('[role="tablist"]')!;
    list.getBoundingClientRect = () => new DOMRect(0, 0, 900, 30);
    const tabs = [...list.querySelectorAll<HTMLElement>('[role="tab"]')];
    tabs.forEach((t, i) => (t.getBoundingClientRect = () => new DOMRect(i * 120, 0, 120, 30)));
    const drag = (type: string, target: Element, clientX: number) => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY: 15 });
      Object.defineProperty(event, 'dataTransfer', { value: null });
      act(() => {
        target.dispatchEvent(event);
      });
      return event;
    };
    drag('dragstart', tabs[0]!, 60);
    expect(drag('dragover', list, 400).defaultPrevented).toBe(true);
    expect(drag('drop', list, 400).defaultPrevented).toBe(true);
    await waitFor(() => expect(layout()).toMatchObject({ tile: 'a', tabs: [MAGNET, KNOB] }));
    drag('dragend', tabs[0]!, 400);
    expect(bridge().dragging).toBe(false);
  });
});

describe.each([false, true])('the ☰ window menu (host-embedded: %s)', (hosted) => {
  beforeEach(() => {
    if (hosted) hostEmbed();
  });

  it('two tiles: no strip row; the one ☰ ends the top-right tile’s bar', async () => {
    await openAt(2);
    expect(stripRow()).toBeNull();
    expect(menus()).toHaveLength(1);
    const actions = menus()[0]!.closest<HTMLElement>('[data-testid="tile-actions"]');
    expect(actions?.dataset.tile).toBe(LAYOUTS[2].topRight);
    expect(menus()[0]!.closest('.canopy-tile-bar__menu')).not.toBeNull();
    if (hosted) expect(actions!.querySelector('.target-badge')).toBeNull();
    else await waitFor(() => expect(actions!.querySelector('.target-badge')).not.toBeNull());
  });

  it('four tiles: the ☰ is on the top tile of the right column only', async () => {
    await openAt(4);
    expect(stripRow()).toBeNull();
    expect(menus()).toHaveLength(1);
    expect(menus()[0]!.closest<HTMLElement>('[data-testid="tile-actions"]')?.dataset.tile).toBe(
      LAYOUTS[4].topRight
    );
  });

  it.each([1, 2, 4] as const)(
    '%s tile(s): every window action is reachable by mouse and by keyboard',
    async (count) => {
      await openAt(count);
      // Mouse: the ☰ opens the menu.
      fireEvent.click(menus()[0]!);
      const entries = await menuEntries();
      expect(entries[RESET_LAYOUT]).toBe(count < 2);
      expect(entries[RECENTLY_CLOSED]).toBe(true);
      expect(entries[CLOSE_ALL]).toBe(false);
      fireEvent.keyDown(screen.getAllByRole('menuitem')[0]!, { key: 'Escape' });
      await waitFor(() => expect(screen.queryAllByRole('menuitem')).toHaveLength(0));
      expect(document.activeElement).toBe(menus()[0]);
      // Keyboard: ⌥M / Alt+M opens it from anywhere, focus inside the menu.
      (document.activeElement as HTMLElement | null)?.blur();
      pressShortcut();
      await screen.findAllByRole('menuitem');
      await waitFor(() => expect(document.activeElement?.closest('[role="menu"]')).not.toBeNull());
      // Enter on Close all runs it (Carbon fires on Enter's keyup).
      const closeAll = screen.getByRole('menuitem', { name: CLOSE_ALL });
      fireEvent.keyDown(closeAll, { key: 'Enter' });
      fireEvent.keyUp(closeAll, { key: 'Enter' });
      await waitFor(() => expect(layout()).toBeNull());
      // Recently closed now holds that group; the ☰ (back on the strip) reopens it.
      await settle();
      fireEvent.click(menus()[0]!);
      expect((await menuEntries())[RECENTLY_CLOSED]).toBe(false);
    }
  );

  it('Reset layout from the ☰ lays the tiles out as equal columns', async () => {
    await openAt(4);
    fireEvent.click(menus()[0]!);
    fireEvent.click(await screen.findByRole('menuitem', { name: RESET_LAYOUT }));
    await waitFor(() => {
      const now = layout();
      expect(now && 'split' in now ? now.split : null).toBe('row');
      expect(now && 'items' in now ? now.items.every((i) => 'tile' in i) : false).toBe(true);
    });
  });
});

describe('tile bars and screen headers', () => {
  it.each([false, true])('a lone tile has no bar (host-embedded: %s)', async (hosted) => {
    if (hosted) hostEmbed();
    renderAt(`/embed/${KNOB}`);
    await screen.findByTestId('screen-probe');
    await waitFor(() => expect(probe.api).not.toBeNull());
    await settle();
    expect(bars()).toEqual([]);
    // Standalone the header sits in the row above the content; the host carries it.
    await waitFor(() => expect(headers()).toBe(hosted ? 0 : 1));
    // The strip tab × is the one close.
    expect(screen.getByRole('button', { name: /^Close / })).toBeTruthy();
  });

  it.each([
    ['row', false],
    ['column', false],
    ['row', true],
    ['column', true],
  ] as const)(
    'two tiles in a %s carry bars, and they go at one again (host-embedded: %s)',
    async (split, hosted) => {
      if (hosted) hostEmbed();
      storeTabs([KNOB, MAGNET], KNOB);
      storeDock({ split, items: [tile('a', KNOB), tile('b', MAGNET)] });
      renderAt('/embed/');
      await screen.findAllByTestId('screen-probe');
      await waitFor(() => expect([...bars()].sort()).toEqual([KNOB, MAGNET]));
      await waitFor(() => expect(headers()).toBe(2));
      expect(stripRow()).toBeNull();

      const close = document.querySelector<HTMLElement>(
        '[data-testid="tile-bar"] [data-tab-key="common/magnet"] .canopy-tile-bar__close'
      );
      expect(close).not.toBeNull();
      fireEvent.click(close!);
      await waitFor(() => expect(tileCount()).toBe(1));
      await waitFor(() => expect(bars()).toEqual([]));
      expect(stripRow()).not.toBeNull();
      expect(menus()).toHaveLength(1);
      expect(menus()[0]!.closest('.workspace__strip')).not.toBeNull();
    }
  );
});

describe('one tile: the header row', () => {
  it('standalone: the strip row stays with its ☰; the header sits above the content', async () => {
    renderAt(`/embed/${KNOB}`);
    await screen.findByTestId('screen-probe');
    await waitFor(() => expect(headers()).toBe(1));
    const header = document.querySelector('[data-testid="screen-header-title"]')!;
    expect(header.closest('.workspace__strip')).toBeNull();
    expect(header.closest('.workspace__main')).not.toBeNull();
    expect(strip().lastElementChild?.getAttribute('aria-label')).toBe(WINDOW_MENU);
  });

  it('host-embedded: a lone tile has no header row and no badge', async () => {
    hostEmbed();
    renderAt(`/embed/${KNOB}`);
    await screen.findByTestId('screen-probe');
    await settle();
    expect(headers()).toBe(0);
    expect(strip().querySelector('.target-badge')).toBeNull();
    expect(strip().querySelector('.tab-strip__reset')).toBeNull();
  });
});
