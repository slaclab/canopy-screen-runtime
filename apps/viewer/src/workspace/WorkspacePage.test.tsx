// WorkspacePage composes the tree, tab strip, dock with its tile bars and the
// active tab.
// ScreenPage is replaced by a probe that shows the props it got and fires
// actions through the ActionHost the workspace provides, so these tests cover
// the shell (tab state, URL and storage mirroring, the manifest refresh,
// chrome off, the action mapping) without rendering screens. The manifest is
// a fetch stub; the router is a MemoryRouter whose location a probe exposes.

import { createElement, useContext, useEffect } from 'react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useNavigationType,
} from 'react-router-dom';
import { ActionHostContext } from '@slaclab/canopy-screen-runtime';
import type { Manifest } from '../api.js';
import type { TraceConfig } from '../config.js';
import { EmbedPage, EmbedThemeContext } from '../pages/EmbedPage.js';
import { ZOOM_BY_SCREEN_NAME, ZOOM_STORAGE_NAME, ZoomProvider } from '../ZoomContext.js';
import { createBackendBadgeStore } from '../backendBadge.js';
import type { BackendBadgeStore } from '../backendBadge.js';
import { ServicesContext } from '../services.js';
import type { ViewerServices } from '../services.js';
import { dockStorageKey } from './dock/storage.js';
import { tabsStorageKey } from './tabs.js';
import { KEEP_MOUNTED, mountedScreens } from './mountSet.js';
import { TILE_BAR_ROW_HEIGHT } from './tileHeaders.js';
import { WorkspacePage } from './WorkspacePage.js';
import { keyForUrl, urlForKey } from './workspaceUrl.js';

// Node 26 defines a global `localStorage` that is undefined without
// --localstorage-file and shadows jsdom's; canopy-shell's theme store reads
// it at import. Hoisted above the imports, this puts an in-memory Storage
// in its place when the global one is unusable.
vi.hoisted(() => {
  const g = globalThis as { localStorage?: Storage };
  if (typeof g.localStorage?.getItem === 'function') return;
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
});

// A pass-through wrapper: a count of mounted shortcut bindings (each one is
// a window keydown listener).
const dockProbe = vi.hoisted(() => ({ shortcutMounts: 0 }));

vi.mock('../screenActions/shortcuts.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../screenActions/shortcuts.js')>();
  return {
    ...actual,
    useShortcuts: (...args: Parameters<typeof actual.useShortcuts>) => {
      useEffect(() => {
        dockProbe.shortcutMounts += 1;
        return () => {
          dockProbe.shortcutMounts -= 1;
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
    macros?: Record<string, string>;
    onTitle?: (title: string) => void;
    onScreen?: (screen: unknown) => void;
  }) {
    const host = useContext(ActionHostContext);
    const { onTitle, onScreen } = props;
    useEffect(() => {
      onTitle?.(`Rendered ${props.id ?? ''}`);
    }, [onTitle, props.id]);
    // The open screen, for the header's actions: two groups of PVs.
    useEffect(() => {
      onScreen?.({
        category: props.category ?? '',
        id: props.id ?? '',
        title: `Rendered ${props.id ?? ''}`,
        macros: {},
        element: null,
        documentUrl: '',
        collectPVs: async () => [
          {
            key: '',
            title: `Rendered ${props.id ?? ''}`,
            detail: '',
            depth: 0,
            pvs: [
              { name: 'TOP:I', role: 'readback' },
              { name: 'TOP:SET', role: 'control' },
            ],
          },
          {
            key: '/0:e1',
            title: 'BPM',
            detail: 'BPM=1',
            depth: 1,
            pvs: [{ name: 'BPM1:X', role: 'readback' }],
          },
        ],
      });
    }, [onScreen, props.category, props.id]);
    return createElement(
      'div',
      {
        'data-testid': 'screen-probe',
        'data-category': props.category,
        'data-id': props.id,
        'data-macros': JSON.stringify(props.macros ?? {}),
      },
      createElement(
        'button',
        { type: 'button', onClick: () => host.navigate('/embed/common/magnet?X=1') },
        'action-navigate'
      ),
      createElement(
        'button',
        { type: 'button', onClick: () => host.navigate('/embed/@correlation/2') },
        'action-navigate-tool'
      ),
      createElement(
        'button',
        {
          type: 'button',
          onClick: async () => {
            const url = await host.resolveManifest('../common/magnet.screen.json');
            if (url) host.openWindow(`${url}?Y=2`);
          },
        },
        'action-open-tab'
      ),
      createElement(
        'button',
        { type: 'button', onClick: () => host.openWindow('https://example.org/') },
        'action-open-web'
      ),
      createElement('button', { type: 'button', onClick: () => host.close() }, 'action-close'),
      createElement(
        'button',
        { type: 'button', onClick: () => host.showError('No screen for x.screen.json') },
        'action-fail'
      )
    );
  }
  return { ...actual, ScreenPage: ScreenProbe };
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
      id: 'CBXFEL/Landing',
      kind: 'ir',
      title: 'Landing',
      category: 'cbx fel',
      path: 'screens/cbxfel/CBXFEL/Landing.screen.json',
    },
  ],
};

const TRACE: TraceConfig = { path: 'trace/', query: 'pv=A&range=-1h' };
const BASE = 'https://host/screens';

let manifest: Manifest;
let fetchMock: ReturnType<typeof vi.fn>;
let warn: ReturnType<typeof vi.spyOn>;
let visibility: DocumentVisibilityState;

beforeEach(() => {
  manifest = MANIFEST;
  fetchMock = vi.fn(async () => new Response(JSON.stringify(manifest), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  // Drop the instance override; the prototype getter applies again.
  delete (document as { visibilityState?: unknown }).visibilityState;
  for (const store of [globalThis.sessionStorage, globalThis.localStorage]) {
    try {
      store?.clear();
    } catch {
      // Storage unavailable: nothing to clear.
    }
  }
});

let navigateTo: (url: string) => void = () => {};

function LocationProbe() {
  const location = useLocation();
  const type = useNavigationType();
  const navigate = useNavigate();
  useEffect(() => {
    navigateTo = (url) => void navigate(url);
  }, [navigate]);
  return createElement(
    'output',
    { 'data-testid': 'location', 'data-type': type },
    location.pathname + location.search
  );
}

function renderAt(
  path: string,
  options: {
    trace?: TraceConfig;
    correlation?: TraceConfig;
    views?: boolean;
    /** Serve config.collections at `collections` (the fetch stub routes it). */
    collections?: boolean;
    mode?: 'light' | 'dark';
    wrap?: (n: ReactNode) => ReactNode;
  } = {}
) {
  const config =
    options.trace || options.correlation || options.collections
      ? {
          ...(options.trace ? { trace: options.trace } : {}),
          ...(options.correlation ? { correlation: options.correlation } : {}),
          ...(options.views ? { views: { path: 'views' } } : {}),
          ...(options.collections ? { collections: { path: 'collections' } } : {}),
        }
      : undefined;
  const page = <WorkspacePage screensBaseUrl={BASE} config={config} />;
  const mode = options.mode ?? 'dark';
  const tree = (
    <MemoryRouter initialEntries={[path]}>
      <ZoomProvider>
        <EmbedThemeContext.Provider value={{ mode, id: mode, anchorRef: { current: null } }}>
          {page}
          <LocationProbe />
        </EmbedThemeContext.Provider>
      </ZoomProvider>
    </MemoryRouter>
  );
  return render(options.wrap ? options.wrap(tree) : tree);
}

/** A hare-mode page's services: only the backend badge store is read here. */
function withBackend(store: BackendBadgeStore) {
  const services = { backend: store } as unknown as ViewerServices;
  return (n: ReactNode) => (
    <ServicesContext.Provider value={services}>{n}</ServicesContext.Provider>
  );
}

const SIM_SEED = {
  backend: { name: 'example', label: 'Simulator', notice: null },
  binding: 'sim@3',
} as const;

/** One live heartbeat of the simulator saying `reachable`. */
function simFrame(store: BackendBadgeStore, reachable: 'yes' | 'no') {
  act(() => {
    store.setStatus('connected');
    store.setBackend(
      {
        name: 'example',
        label: 'Simulator',
        notice: null,
        binding: 'sim@3',
        reachable: {
          state: reachable,
          since: reachable === 'no' ? 1760700060 : null,
          reason: null,
        },
        writes: { state: 'on', reason: null, cause: null },
      },
      1760700120
    );
  });
}

/** The screen probe of the active (shown) screen tab. */
function activeProbe(): HTMLElement {
  const probe = document.querySelector<HTMLElement>(
    '.workspace__screen[data-active="true"] [data-testid="screen-probe"]'
  );
  if (!probe) throw new Error('no active screen');
  return probe;
}

function here(): string {
  return screen.getByTestId('location').textContent ?? '';
}

interface Stored {
  keys: string[];
  active: string | null;
  instances: Record<string, { query: string | null; view?: string }>;
  toolMru: string[];
}

function stored(): Stored | null {
  const raw = sessionStorage.getItem(tabsStorageKey('/'));
  return raw === null ? null : JSON.parse(raw);
}

function tree(): HTMLElement {
  return screen.getByRole('navigation', { name: 'Screens' });
}

async function treeLoaded() {
  await waitFor(() => expect(within(tree()).getByText('Knob device')).toBeTruthy());
}

/**
 * The workspace tab strip. Scoped because dockview's own tile tabs and its
 * live regions (role tab, alert) sit in the dock beside it.
 */
function strip(): HTMLElement {
  return screen.getByRole('tablist', { name: 'Open tabs' });
}

function stripTabs(): HTMLElement[] {
  return within(strip()).getAllByRole('tab');
}

function tabTitles(): string[] {
  return stripTabs().map((t) => t.getAttribute('title') ?? '');
}

/** The bar of the tile showing `key`. */
function tileBar(key: string): HTMLElement {
  const bar = tileBars().find((b) => b.dataset.panelKey === key);
  if (!bar) throw new Error(`no tile bar for ${key}`);
  return bar;
}

function tileBars(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-testid="tile-bar"]'));
}

/** The actions slot (header, Save view, ☰) of the tile showing `key`, beside its bar. */
function tileActions(key: string): HTMLElement {
  const tile = tileBar(key).dataset.tile;
  const slot = document.querySelector<HTMLElement>(
    `[data-testid="tile-actions"][data-tile="${tile}"]`
  );
  if (!slot) throw new Error(`no tile actions for ${key}`);
  return slot;
}

/** With one tile there is no bar: the one screen header, in the row above the dock. */
function oneTileHeader(): HTMLElement {
  expect(tileBars()).toHaveLength(0);
  const header = screen.getByTestId('screen-header');
  expect(header.closest('[data-testid="workspace-dock"]')).toBeNull();
  return header;
}

/** A stored v2 dock (storage.ts StoredDock): one tile per key, in a row. */
function storeRow(keys: readonly string[]): void {
  localStorage.setItem(
    dockStorageKey('/'),
    JSON.stringify({
      version: 1,
      layout: {
        split: 'row',
        items: keys.map((key, i) => ({
          tile: `t${i + 1}`,
          tabs: [key],
          showing: key,
          size: 1 / keys.length,
        })),
      },
      panels: Object.fromEntries(keys.map((key) => [key, { kind: 'screen' }])),
    })
  );
}

/** The per-screen zoom record at the origin root. */
const ZOOM_RECORD = `${ZOOM_BY_SCREEN_NAME}:/`;

function zoomRecord(key = ZOOM_RECORD): Record<string, unknown> | null {
  const raw = localStorage.getItem(key);
  return raw === null ? null : (JSON.parse(raw) as Record<string, unknown>);
}

/** Seeds the remembered zooms (a previous session's). */
function remember(entries: Record<string, { mode: 'manual'; scale: number }>) {
  localStorage.setItem(ZOOM_RECORD, JSON.stringify(entries));
}

/** The only screen header's Fit button. */
function fitButton(): HTMLElement {
  return screen.getByRole('button', { name: 'Fit' });
}

/** Lets the tab adapter's portals settle (it re-applies on a microtask). */
async function settle() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** The alerts outside the dock (the workspace banner's). */
function bannerAlerts(): HTMLElement[] {
  return screen
    .queryAllByRole('alert')
    .filter((el) => !el.closest('[data-testid="workspace-dock"]'));
}

describe('keyForUrl / urlForKey', () => {
  it('maps screen URLs (encoded, slashed, with macros) to canonical keys', () => {
    expect(keyForUrl('/embed/bts/knob')).toBe('bts/knob');
    expect(keyForUrl('/embed/cbx%20fel/CBXFEL/Landing?B=2&A=1&theme=dark')).toBe(
      'cbx fel/CBXFEL/Landing?A=1&B=2'
    );
    expect(keyForUrl('/s/bts/knob?P=1')).toBe('bts/knob?P=1');
    expect(keyForUrl('/embed/@trace?pv=X')).toBe('@trace');
  });

  it('names no tab for /embed/, a bare category or an internal category', () => {
    expect(keyForUrl('/embed/')).toBeNull();
    expect(keyForUrl('/embed')).toBeNull();
    expect(keyForUrl('/embed/bts')).toBeNull();
    expect(keyForUrl('/embed/@drafts/a')).toBeNull();
    expect(keyForUrl('/embed/%E0%A4%A/x')).toBeNull();
  });

  it('round-trips through urlForKey', () => {
    for (const key of ['bts/knob', 'cbx fel/CBXFEL/Landing?A=1&B=2', '@trace']) {
      expect(keyForUrl(urlForKey(key))).toBe(key);
    }
    expect(urlForKey(null)).toBe('/embed/');
    expect(urlForKey('cbx fel/CBXFEL/Landing')).toBe('/embed/cbx%20fel/CBXFEL/Landing');
  });
});

describe('WorkspacePage tabs', () => {
  it('starts empty, lists the manifest in the tree and has no <main> of its own', async () => {
    const { container } = renderAt('/embed/');
    expect(screen.getByTestId('workspace-empty')).toBeTruthy();
    await treeLoaded();
    expect(container.querySelector('main')).toBeNull();
    expect(screen.queryByRole('tab')).toBeNull();
  });

  it('puts the screen browser splitter between the tree and the content', async () => {
    renderAt('/embed/');
    await treeLoaded();
    const splitter = screen.getByRole('separator', { name: 'Resize screen browser' });
    expect(splitter.previousElementSibling?.classList.contains('workspace__sidebar')).toBe(true);
    expect(splitter.nextElementSibling?.classList.contains('workspace__main')).toBe(true);
  });

  it('opens a tree screen in the active tab and mirrors it to the URL with replace', async () => {
    renderAt('/embed/');
    await treeLoaded();
    fireEvent.click(within(tree()).getByText('Knob device'));
    const probe = await screen.findByTestId('screen-probe');
    expect(probe.dataset.category).toBe('bts');
    expect(probe.dataset.id).toBe('knob');
    await waitFor(() => expect(here()).toBe('/embed/bts/knob'));
    expect(screen.getByTestId('location').dataset.type).toBe('REPLACE');
    expect(stored()).toEqual({
      keys: ['bts/knob'],
      active: 'bts/knob',
      instances: {},
      toolMru: [],
    });

    // A second left-click replaces the active tab.
    fireEvent.click(within(tree()).getByText('Magnet'));
    await waitFor(() => expect(here()).toBe('/embed/common/magnet'));
    expect(tabTitles()).toEqual(['Magnet']);
  });

  it('appends a deep link to the stored tabs and passes its macros', async () => {
    sessionStorage.setItem(
      tabsStorageKey('/'),
      JSON.stringify({ keys: ['common/magnet'], active: 'common/magnet' })
    );
    renderAt('/embed/bts/knob?P=1&theme=light');
    const probe = await screen.findByTestId('screen-probe');
    expect(probe.dataset.id).toBe('knob');
    expect(JSON.parse(probe.dataset.macros!)).toEqual({ P: '1' });
    await waitFor(() => expect(tabTitles()).toEqual(['Magnet', 'Knob device']));
    expect(stored()?.keys).toEqual(['common/magnet', 'bts/knob?P=1']);
    expect(here()).toBe('/embed/bts/knob?P=1');
  });

  it('focuses the stored active tab on a bare /embed/ and mounts only that screen', async () => {
    sessionStorage.setItem(
      tabsStorageKey('/'),
      JSON.stringify({ keys: ['bts/knob', 'common/magnet'], active: 'common/magnet' })
    );
    renderAt('/embed/');
    await waitFor(() => expect(here()).toBe('/embed/common/magnet'));
    // A restored tab that was never shown is not mounted.
    expect(screen.getAllByTestId('screen-probe')).toHaveLength(1);
    expect(activeProbe().dataset.id).toBe('magnet');
  });

  it('keeps a screen it showed mounted but hidden, and switches back without a remount', async () => {
    sessionStorage.setItem(
      tabsStorageKey('/'),
      JSON.stringify({ keys: ['bts/knob', 'common/magnet'], active: 'common/magnet' })
    );
    renderAt('/embed/');
    await waitFor(() => expect(here()).toBe('/embed/common/magnet'));
    const magnet = activeProbe();

    fireEvent.click(stripTabs()[0]!);
    await waitFor(() => expect(here()).toBe('/embed/bts/knob'));
    expect(screen.getAllByTestId('screen-probe')).toHaveLength(2);
    expect(activeProbe().dataset.id).toBe('knob');
    const hidden = magnet.closest<HTMLElement>('.workspace__screen')!;
    expect(hidden.dataset.active).toBe('false');
    expect(hidden.classList.contains('workspace__screen--hidden')).toBe(true);
    expect(hidden.getAttribute('aria-hidden')).toBe('true');
    expect(hidden.hasAttribute('inert')).toBe(true);
    // Only the active screen reports: with one tile (no bar) the
    // header row above the dock names the knob.
    await waitFor(() =>
      expect(
        oneTileHeader().querySelector('[data-testid="screen-header-title"]')?.textContent
      ).toContain('Rendered knob')
    );

    fireEvent.click(stripTabs()[1]!);
    await waitFor(() => expect(here()).toBe('/embed/common/magnet'));
    expect(activeProbe()).toBe(magnet);
    await waitFor(() =>
      expect(
        oneTileHeader().querySelector('[data-testid="screen-header-title"]')?.textContent
      ).toContain('Rendered magnet')
    );
  });

  it(`keeps the docked screen and at most ${KEEP_MOUNTED} undocked ones, evicting the least recently shown`, async () => {
    const keys = ['bts/knob?P=1', 'bts/knob?P=2', 'bts/knob?P=3', 'bts/knob?P=4', 'bts/knob?P=5'];
    sessionStorage.setItem(tabsStorageKey('/'), JSON.stringify({ keys, active: keys[0] }));
    renderAt('/embed/');
    for (let i = 1; i < keys.length; i += 1) {
      fireEvent.click(stripTabs()[i]!);
      await waitFor(() => expect(here()).toBe(`/embed/bts/knob?P=${i + 1}`));
    }
    const macros = () =>
      screen.getAllByTestId('screen-probe').map((p) => JSON.parse(p.dataset.macros!).P);
    // P=5 docked, P=4..2 the undocked ones kept; P=1 evicted.
    expect(macros()).toEqual(['2', '3', '4', '5']);
    // Showing P=2 again keeps it; closing a hidden tab (P=3) unmounts it and
    // never brings the evicted P=1 back.
    fireEvent.click(stripTabs()[1]!);
    await waitFor(() => expect(here()).toBe('/embed/bts/knob?P=2'));
    fireEvent.click(screen.getAllByRole('button', { name: 'Close Knob device' })[2]!);
    expect(macros()).toEqual(['2', '4', '5']);
    expect(activeProbe().dataset.macros).toBe(JSON.stringify({ P: '2' }));
  });

  it('shows the empty state after the last tab closes', async () => {
    renderAt('/embed/bts/knob');
    await screen.findByTestId('screen-probe');
    fireEvent.click(screen.getByRole('button', { name: /^Close / }));
    expect(screen.getByTestId('workspace-empty')).toBeTruthy();
    expect(screen.queryByTestId('screen-probe')).toBeNull();
    // No tab, no header: the empty-state text replaces it.
    await settle();
    expect(screen.queryByTestId('screen-header')).toBeNull();
    expect(tileBars()).toHaveLength(0);
    await waitFor(() => expect(here()).toBe('/embed/'));
    expect(stored()?.keys).toEqual([]);
  });

  it('shows tab-missing for a key the fresh manifest lacks, with Close tab', async () => {
    renderAt('/embed/bts/gone');
    await screen.findByTestId('tab-missing');
    expect(screen.queryByTestId('screen-probe')).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(`${BASE}/manifest.json`, { cache: 'no-cache' });
    fireEvent.click(screen.getByRole('button', { name: 'Close tab' }));
    expect(screen.getByTestId('workspace-empty')).toBeTruthy();
  });

  it("shows the screen title the page reports in the one tile's header row", async () => {
    renderAt('/embed/bts/knob');
    await screen.findByTestId('screen-probe');
    await settle();
    const toolbar = oneTileHeader();
    await waitFor(() => expect(toolbar.textContent).toContain('Rendered knob'));
    expect(toolbar.textContent).toContain('bts/knob');
  });

  it('opens a tab for a URL it did not write', async () => {
    renderAt('/embed/bts/knob');
    await screen.findByTestId('screen-probe');
    act(() => navigateTo('/embed/common/magnet'));
    await waitFor(() => expect(activeProbe().dataset.id).toBe('magnet'));
    expect(stored()?.keys).toEqual(['bts/knob', 'common/magnet']);
  });
});

describe('WorkspacePage manifest refresh', () => {
  it('refetches fresh on window focus', async () => {
    renderAt('/embed/');
    await treeLoaded();
    const before = fetchMock.mock.calls.length;
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(fetchMock.mock.calls.length).toBe(before + 1));
    for (const call of fetchMock.mock.calls) {
      expect(call).toEqual([`${BASE}/manifest.json`, { cache: 'no-cache' }]);
    }
  });

  it('polls every three seconds while visible, not while hidden, and picks up new screens', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    renderAt('/embed/');
    await treeLoaded();
    const start = fetchMock.mock.calls.length;

    manifest = {
      screens: [
        ...MANIFEST.screens,
        {
          id: 'new',
          kind: 'ir',
          title: 'Brand new',
          category: 'bts',
          path: 'screens/bts/new.json',
        },
      ],
    };
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    await waitFor(() => expect(within(tree()).getByText('Brand new')).toBeTruthy());
    expect(fetchMock.mock.calls.length).toBe(start + 1);

    visibility = 'hidden';
    await act(async () => {
      vi.advanceTimersByTime(9000);
    });
    expect(fetchMock.mock.calls.length).toBe(start + 1);
  });

  it('turns tab-missing into the screen once a refresh lists it', async () => {
    manifest = { screens: [] };
    renderAt('/embed/bts/knob');
    await screen.findByTestId('tab-missing');
    manifest = MANIFEST;
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await screen.findByTestId('screen-probe');
    expect(screen.queryByTestId('tab-missing')).toBeNull();
  });

  it('sends the last ETag and keeps the tree on a 304', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (new Headers(init?.headers).get('If-None-Match') === '"m1"') {
        return new Response(null, { status: 304, headers: { ETag: '"m1"' } });
      }
      return new Response(JSON.stringify(manifest), { status: 200, headers: { ETag: '"m1"' } });
    });
    renderAt('/embed/');
    await treeLoaded();
    const start = fetchMock.mock.calls.length;
    expect(fetchMock.mock.calls[0]![1]).toEqual({ cache: 'no-cache' });

    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    await waitFor(() => expect(fetchMock.mock.calls.length).toBe(start + 1));
    expect(fetchMock.mock.calls[start]![1]).toEqual({
      cache: 'no-store',
      headers: { 'If-None-Match': '"m1"' },
    });
    expect(within(tree()).getByText('Knob device')).toBeTruthy();
  });

  it('refetches when the document becomes visible', async () => {
    renderAt('/embed/');
    await treeLoaded();
    const before = fetchMock.mock.calls.length;
    visibility = 'hidden';
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(fetchMock.mock.calls.length).toBe(before);
    visibility = 'visible';
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(fetchMock.mock.calls.length).toBe(before + 1));
  });
});

describe('WorkspacePage chrome and zoom', () => {
  it('two open tabs and a `reachable: no` frame: one badge and one machine toast', async () => {
    sessionStorage.setItem(
      tabsStorageKey('/'),
      JSON.stringify({ keys: ['bts/knob', 'common/magnet'], active: 'bts/knob' })
    );
    const store = createBackendBadgeStore(SIM_SEED);
    renderAt('/embed/bts/knob', { wrap: withBackend(store) });
    await treeLoaded();
    expect(screen.getAllByRole('tab')).toHaveLength(2);
    simFrame(store, 'yes');
    expect(screen.queryAllByTestId('canopy-machine-toast')).toHaveLength(0);
    simFrame(store, 'no');
    expect(document.querySelectorAll('.target-badge')).toHaveLength(1);
    const toasts = screen.getAllByTestId('canopy-machine-toast');
    expect(toasts.map((t) => t.textContent)).toEqual(['Simulator stopped answering']);
    // In the Notices column, titled by the machine, and not a live region.
    const column = screen.getByRole('region', { name: 'Notices' });
    expect(column.contains(toasts[0])).toBe(true);
    expect(within(column).getByTestId('canopy-machine-toast-title').textContent).toBe('Simulator');
    expect(toasts[0].closest('[role="status"], [aria-live]')).toBeNull();
  });

  it('_canopyChrome=0 mounts no badge and no machine toasts', async () => {
    const store = createBackendBadgeStore(SIM_SEED);
    renderAt('/embed/bts/knob?_canopyChrome=0', { wrap: withBackend(store) });
    await screen.findByTestId('screen-probe');
    simFrame(store, 'yes');
    simFrame(store, 'no');
    expect(document.querySelectorAll('.target-badge')).toHaveLength(0);
    expect(screen.queryAllByTestId('canopy-machine-toast')).toHaveLength(0);
    expect(screen.queryByRole('region', { name: 'Notices' })).toBeNull();
  });

  it('_canopyChrome=0 renders only the active screen and writes no URL or tabs', async () => {
    renderAt('/embed/bts/knob?_canopyChrome=0&_canopyZoom=100');
    await screen.findByTestId('screen-probe');
    expect(screen.queryByRole('navigation', { name: 'Screens' })).toBeNull();
    expect(screen.queryByRole('separator')).toBeNull();
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByTestId('screen-header')).toBeNull();

    // An action still switches the shown screen, but nothing is mirrored.
    fireEvent.click(screen.getByRole('button', { name: 'action-navigate' }));
    await waitFor(() => expect(screen.getByTestId('screen-probe').dataset.id).toBe('magnet'));
    expect(here()).toBe('/embed/bts/knob?_canopyChrome=0&_canopyZoom=100');
    expect(sessionStorage.getItem(tabsStorageKey('/'))).toBeNull();
  });

  it('ignores stored tabs when chrome is off', async () => {
    sessionStorage.setItem(
      tabsStorageKey('/'),
      JSON.stringify({ keys: ['common/magnet'], active: 'common/magnet' })
    );
    renderAt('/embed/bts/knob?_canopyChrome=0');
    const probe = await screen.findByTestId('screen-probe');
    expect(probe.dataset.id).toBe('knob');
    fireEvent.click(screen.getByRole('button', { name: 'action-close' }));
    expect(screen.getByTestId('workspace-empty')).toBeTruthy();
  });

  it('places Quick open above the tree; no Collections without config.collections', async () => {
    renderAt('/embed/bts/knob');
    await treeLoaded();
    const header = screen.getByTestId('workspace-sidebar-header');
    expect(within(header).getByRole('button', { name: /^Quick open/ })).toBeTruthy();
    expect(within(header).queryByRole('button', { name: /collections/i })).toBeNull();
  });

  it('_canopyChrome=0 renders no Quick open', async () => {
    renderAt('/embed/bts/knob?_canopyChrome=0&_canopyOpen=c-ops');
    await screen.findByTestId('screen-probe');
    expect(screen.queryByRole('button', { name: /^Quick open/ })).toBeNull();
    expect(screen.getByTestId('screen-probe').dataset.id).toBe('knob');
  });

  it('latches ?_canopyZoom once, drops it from the URL and stores nothing', async () => {
    renderAt('/embed/bts/knob?_canopyZoom=100');
    await screen.findByTestId('screen-probe');
    await waitFor(() => expect(here()).toBe('/embed/bts/knob'));
    expect(screen.getByTestId('zoom-percent').textContent).toBe('100%');
    expect(fitButton().getAttribute('aria-pressed')).toBe('false');
    // The latch is for this page view only: no per-tab-key session entry and
    // nothing remembered for the screen.
    expect(sessionStorage.getItem('canopy-viewer:zoom:bts/knob')).toBeNull();
    expect(localStorage.getItem(ZOOM_RECORD)).toBeNull();
  });

  it('a latched ?_canopyZoom beats the remembered zoom', async () => {
    remember({ 'bts/knob': { mode: 'manual', scale: 2 } });
    renderAt('/embed/bts/knob?_canopyZoom=fit');
    await screen.findByTestId('screen-probe');
    await waitFor(() => expect(here()).toBe('/embed/bts/knob'));
    expect(fitButton().getAttribute('aria-pressed')).toBe('true');
    expect(zoomRecord()).toEqual({ 'bts/knob': { mode: 'manual', scale: 2 } });
  });

  it('opens a screen at its remembered zoom, else Fit', async () => {
    remember({ 'bts/knob': { mode: 'manual', scale: 2 } });
    renderAt('/embed/bts/knob');
    await screen.findByTestId('screen-probe');
    expect(screen.getByTestId('zoom-percent').textContent).toBe('200%');
    expect(fitButton().getAttribute('aria-pressed')).toBe('false');
    cleanup();
    renderAt('/embed/common/magnet');
    await screen.findByTestId('screen-probe');
    expect(fitButton().getAttribute('aria-pressed')).toBe('true');
  });

  it('a zoom button remembers the screen; Fit forgets it', async () => {
    renderAt('/embed/bts/knob?X=1');
    await screen.findByTestId('screen-probe');
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    const zoomed = screen.getByTestId('zoom-percent').textContent;
    expect(zoomed).not.toBe('100%');
    expect(Object.keys(zoomRecord()!)).toEqual(['bts/knob']);
    fireEvent.click(fitButton());
    expect(fitButton().getAttribute('aria-pressed')).toBe('true');
    expect(localStorage.getItem(ZOOM_RECORD)).toBeNull();
  });

  it('the remembered zoom survives a new session', async () => {
    renderAt('/embed/bts/knob');
    await screen.findByTestId('screen-probe');
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    const zoomed = screen.getByTestId('zoom-percent').textContent;
    expect(zoomed).not.toBe('100%');
    cleanup();
    // A new session: the tabs and every session entry are gone.
    sessionStorage.clear();
    renderAt('/embed/bts/knob');
    await screen.findByTestId('screen-probe');
    expect(screen.getByTestId('zoom-percent').textContent).toBe(zoomed);
    expect(fitButton().getAttribute('aria-pressed')).toBe('false');
  });

  it('replace from a zoomed tile opens the new screen at Fit when it has no zoom', async () => {
    renderAt('/embed/bts/knob');
    await screen.findByTestId('screen-probe');
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(fitButton().getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'action-navigate' }));
    await waitFor(() => expect(here()).toBe('/embed/common/magnet?X=1'));
    await waitFor(() => expect(fitButton().getAttribute('aria-pressed')).toBe('true'));
    expect(screen.getByTestId('zoom-percent').textContent).toBe('100%');
    // Nothing was inherited: only the zoomed screen is remembered.
    expect(Object.keys(zoomRecord()!)).toEqual(['bts/knob']);
  });

  it('replace from a zoomed tile opens the new screen at its remembered zoom', async () => {
    remember({ 'common/magnet': { mode: 'manual', scale: 0.5 } });
    renderAt('/embed/bts/knob');
    await screen.findByTestId('screen-probe');
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    fireEvent.click(screen.getByRole('button', { name: 'action-navigate' }));
    await waitFor(() => expect(here()).toBe('/embed/common/magnet?X=1'));
    await waitFor(() => expect(screen.getByTestId('zoom-percent').textContent).toBe('50%'));
    expect(zoomRecord()!['common/magnet']).toEqual({ mode: 'manual', scale: 0.5 });
  });
});

describe('WorkspacePage actions', () => {
  it('open_display replace swaps the active tab', async () => {
    renderAt('/embed/bts/knob');
    await screen.findByTestId('screen-probe');
    fireEvent.click(screen.getByRole('button', { name: 'action-navigate' }));
    await waitFor(() => expect(here()).toBe('/embed/common/magnet?X=1'));
    expect(stored()?.keys).toEqual(['common/magnet?X=1']);
    expect(screen.getByTestId('location').dataset.type).toBe('REPLACE');
  });

  it('a tab/window target on a screen appends a tab instead of window.open', async () => {
    const open = vi.fn(() => null);
    vi.stubGlobal('open', open);
    renderAt('/embed/bts/knob');
    await screen.findByTestId('screen-probe');
    fireEvent.click(screen.getByRole('button', { name: 'action-open-tab' }));
    await waitFor(() => expect(here()).toBe('/embed/common/magnet?Y=2'));
    expect(stored()?.keys).toEqual(['bts/knob', 'common/magnet?Y=2']);
    expect(open).not.toHaveBeenCalled();
  });

  it('a non-screen URL still opens a window', async () => {
    const open = vi.fn(() => null);
    vi.stubGlobal('open', open);
    renderAt('/embed/bts/knob');
    await screen.findByTestId('screen-probe');
    fireEvent.click(screen.getByRole('button', { name: 'action-open-web' }));
    expect(open).toHaveBeenCalledWith('https://example.org/', '_blank', 'noopener');
  });

  it('close_display closes the active tab and never navigates back', async () => {
    const close = vi.spyOn(window, 'close').mockImplementation(() => {});
    sessionStorage.setItem(
      tabsStorageKey('/'),
      JSON.stringify({ keys: ['bts/knob', 'common/magnet'], active: 'bts/knob' })
    );
    renderAt('/embed/');
    await screen.findByTestId('screen-probe');
    fireEvent.click(screen.getByRole('button', { name: 'action-close' }));
    await waitFor(() => expect(here()).toBe('/embed/common/magnet'));
    expect(stored()?.keys).toEqual(['common/magnet']);
    expect(close).not.toHaveBeenCalled();
  });

  it('shows action errors in its own banner until dismissed', async () => {
    renderAt('/embed/bts/knob');
    await screen.findByTestId('screen-probe');
    fireEvent.click(screen.getByRole('button', { name: 'action-fail' }));
    expect(bannerAlerts()).toHaveLength(1);
    expect(bannerAlerts()[0]!.textContent).toContain('No screen for x.screen.json');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(bannerAlerts()).toEqual([]);
  });
});

describe('WorkspacePage Trace tab', () => {
  function iframe(): HTMLIFrameElement {
    const frame = document.querySelector('iframe.workspace-trace');
    if (!(frame instanceof HTMLIFrameElement)) throw new Error('no Trace iframe');
    return frame;
  }

  it('mounts Trace at /embed/@trace with the config query and the embed theme', async () => {
    renderAt('/embed/@trace?pv=EVIL', { trace: TRACE, mode: 'light' });
    const src = new URL(iframe().src);
    expect(src.pathname.endsWith('/trace/')).toBe(true);
    expect(src.searchParams.getAll('pv')).toEqual(['A']);
    expect(src.searchParams.get('theme')).toBe('light');
    expect(src.searchParams.get('embedded')).toBe('true');
    await waitFor(() => expect(here()).toBe('/embed/@trace'));
    expect(tabTitles()).toEqual(['Data Browser']);
    // The data browser brings its own header (Trace's); no screen header.
    // One tile has no bar: its strip tab carries the title and the ×.
    expect(screen.queryByTestId('screen-header')).toBeNull();
    await settle();
    expect(tileBars()).toHaveLength(0);
    const tab = stripTabs()[0]!;
    expect(tab.textContent).toContain('Data Browser');
    expect(within(strip()).getByRole('button', { name: 'Close Data Browser' })).toBeTruthy();
  });

  // The whole path from the frame's own URL: EmbedPage reads ?theme=, the
  // workspace passes the id on, TraceTab builds the iframe src.
  function renderUnderEmbedPage(path: string) {
    const page = <WorkspacePage screensBaseUrl={BASE} config={{ trace: TRACE }} />;
    return render(
      <MemoryRouter initialEntries={[path]}>
        <ZoomProvider>
          <Routes>
            <Route path="/embed" element={<EmbedPage themes={{ 'retro-dark': 'dark' }} />}>
              <Route index element={page} />
              <Route path="*" element={page} />
            </Route>
          </Routes>
        </ZoomProvider>
      </MemoryRouter>
    );
  }

  it('keeps a crafted ?theme= on the embed URL out of the Trace iframe query', () => {
    renderUnderEmbedPage('/embed/@trace?theme=dark%26embedded%3Dfalse%26pv%3DX');
    const src = new URL(iframe().src);
    expect(src.searchParams.getAll('theme')).toEqual(['dark']);
    expect(src.searchParams.getAll('embedded')).toEqual(['true']);
    expect(src.searchParams.getAll('pv')).toEqual(['A']);
    expect(iframe().src.match(/embedded=/g)).toHaveLength(1);
  });

  it('passes a well-formed host theme id from the embed URL to the Trace iframe', () => {
    renderUnderEmbedPage('/embed/@trace?theme=retro-dark');
    const src = new URL(iframe().src);
    expect(src.searchParams.get('theme')).toBe('retro-dark');
    expect(src.searchParams.get('embedded')).toBe('true');
  });

  it('prefers the stored instance query and keeps the iframe mounted behind a screen tab', async () => {
    sessionStorage.setItem(
      tabsStorageKey('/'),
      JSON.stringify({
        keys: ['@trace'],
        active: '@trace',
        instances: { '@trace': { query: 'pv=STORED' } },
      })
    );
    renderAt('/embed/', { trace: TRACE });
    const frame = iframe();
    expect(new URL(frame.src).searchParams.get('pv')).toBe('STORED');

    // Left-click while Trace is active appends instead of replacing it.
    await treeLoaded();
    fireEvent.click(within(tree()).getByText('Knob device'));
    await screen.findByTestId('screen-probe');
    expect(tabTitles()).toEqual(['Data Browser', 'Knob device']);
    expect(iframe()).toBe(frame);
    expect(frame.style.visibility).toBe('hidden');

    fireEvent.click(stripTabs()[0]!);
    expect(iframe()).toBe(frame);
    expect(frame.style.visibility).toBe('');
    // The screen stays mounted behind the data browser, hidden.
    expect(
      screen.getByTestId('screen-probe').closest<HTMLElement>('.workspace__screen')!.dataset.active
    ).toBe('false');
  });

  it('a first visit to a bare /embed/ opens the data browser as the active tab', async () => {
    renderAt('/embed/', { trace: TRACE });
    expect(iframe().style.visibility).toBe('');
    expect(screen.queryByTestId('workspace-empty')).toBeNull();
    expect(tabTitles()).toEqual(['Data Browser']);
    await waitFor(() => expect(here()).toBe('/embed/@trace'));
    expect(stored()).toEqual({
      keys: ['@trace'],
      active: '@trace',
      instances: {},
      toolMru: ['@trace'],
    });
  });

  it('a first visit with ?_canopyOpen opens no data browser and drops the parameter', async () => {
    renderAt('/embed/?_canopyOpen=c-ops', { trace: TRACE });
    expect(screen.getByTestId('workspace-empty')).toBeTruthy();
    expect(document.querySelector('iframe.workspace-trace')).toBeNull();
    await treeLoaded();
    await waitFor(() => expect(here()).toBe('/embed/'));
    expect(stored()?.keys).toEqual([]);
  });

  it("a frame's canopy:quick-open opens the quick-open palette", async () => {
    renderAt('/embed/@trace', { trace: TRACE });
    await treeLoaded();
    expect(screen.queryByRole('dialog', { name: 'Quick open' })).toBeNull();
    const frame = iframe();
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'canopy:quick-open' },
          source: frame.contentWindow,
          origin: window.location.origin,
        })
      );
    });
    expect(await screen.findByRole('dialog', { name: 'Quick open' })).toBeTruthy();
  });

  it('ignores canopy:quick-open from another window', async () => {
    renderAt('/embed/@trace', { trace: TRACE });
    await treeLoaded();
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'canopy:quick-open' },
          source: window,
          origin: window.location.origin,
        })
      );
    });
    expect(screen.queryByRole('dialog', { name: 'Quick open' })).toBeNull();
  });

  it('a first visit to a screen URL opens only that screen', async () => {
    renderAt('/embed/bts/knob', { trace: TRACE });
    await screen.findByTestId('screen-probe');
    expect(document.querySelector('iframe.workspace-trace')).toBeNull();
    expect(stored()?.keys).toEqual(['bts/knob']);
  });

  it('stored tabs win over the default, even when the stored set is empty', async () => {
    sessionStorage.setItem(tabsStorageKey('/'), JSON.stringify({ keys: [], active: null }));
    renderAt('/embed/', { trace: TRACE });
    expect(screen.getByTestId('workspace-empty')).toBeTruthy();
    expect(document.querySelector('iframe.workspace-trace')).toBeNull();
    await treeLoaded();
    expect(here()).toBe('/embed/');
  });

  it('closing the default data browser leaves the empty state', async () => {
    renderAt('/embed/', { trace: TRACE });
    await waitFor(() => expect(here()).toBe('/embed/@trace'));
    fireEvent.click(screen.getByRole('button', { name: 'Close Data Browser' }));
    expect(screen.getByTestId('workspace-empty')).toBeTruthy();
    expect(document.querySelector('iframe.workspace-trace')).toBeNull();
    await waitFor(() => expect(here()).toBe('/embed/'));
    expect(stored()?.keys).toEqual([]);
  });

  it('opens no default tab with chrome off', async () => {
    renderAt('/embed/?_canopyChrome=0', { trace: TRACE });
    expect(screen.getByTestId('workspace-empty')).toBeTruthy();
    expect(document.querySelector('iframe.workspace-trace')).toBeNull();
  });

  it('drops @trace with a warning when Trace is not configured', async () => {
    renderAt('/embed/@trace');
    expect(document.querySelector('iframe.workspace-trace')).toBeNull();
    expect(screen.getByTestId('workspace-empty')).toBeTruthy();
    await waitFor(() => expect(here()).toBe('/embed/'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Data Browser is not configured'));
  });
});

describe('mountedScreens', () => {
  const screens = (key: string) => key !== '@trace';
  const keys = ['a/1', '@trace', 'a/2', 'a/3', 'a/4'];

  it('keeps every docked screen and the most recent undocked ones, in strip order', () => {
    expect(mountedScreens(keys, ['a/2'], ['a/4', 'a/1', 'a/3'], screens, 2)).toEqual([
      'a/1',
      'a/2',
      'a/4',
    ]);
  });

  it('counts the limit over undocked screens only (docked ones are always kept)', () => {
    // a/2 and a/3 are docked; the limit of 1 still admits one undocked screen.
    expect(mountedScreens(keys, ['a/2', 'a/3'], ['a/3', 'a/2', 'a/4', 'a/1'], screens, 1)).toEqual([
      'a/2',
      'a/3',
      'a/4',
    ]);
    // More docked screens than the limit: all of them stay mounted.
    expect(mountedScreens(keys, ['a/1', 'a/2', 'a/3', 'a/4'], [], screens, 1)).toEqual([
      'a/1',
      'a/2',
      'a/3',
      'a/4',
    ]);
  });

  it('keeps the recent screens when nothing is docked', () => {
    expect(mountedScreens(keys, [], ['a/3', 'a/1'], screens)).toEqual(['a/1', 'a/3']);
  });

  it('drops closed and non-screen keys, and honours the limit', () => {
    expect(mountedScreens(['a/1', 'a/2'], ['a/1'], ['gone/x', 'a/2'], screens, 0)).toEqual(['a/1']);
    expect(mountedScreens(keys, ['@trace'], ['@trace'], screens)).toEqual([]);
    // A docked key the predicate refuses (a screen the manifest lacks) is not mounted.
    expect(mountedScreens(['a/1', 'a/2'], ['a/1'], [], (k) => k !== 'a/1')).toEqual([]);
  });
});

describe('WorkspacePage plot in data browser', () => {
  beforeEach(() => {
    // Carbon's Modal observes its body; jsdom has no ResizeObserver.
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
  });

  const plotButton = () => screen.findByRole('button', { name: 'Plot in Data Browser' });

  it("opens the data browser with the picked PVs over the data browser's range", async () => {
    sessionStorage.setItem(
      tabsStorageKey('/'),
      JSON.stringify({
        keys: ['bts/knob', '@trace'],
        active: 'bts/knob',
        instances: { '@trace': { query: 'pv=OLD&range=-6h' } },
      })
    );
    renderAt('/embed/bts/knob', { trace: TRACE });
    fireEvent.click(await plotButton());
    const dialog = await screen.findByRole('dialog');
    // Grouped per screen instance; the readbacks are preselected.
    expect(within(dialog).getByText('BPM')).toBeTruthy();
    const box = (name: string) => within(dialog).getByLabelText(name) as HTMLInputElement;
    await waitFor(() => expect(box('TOP:I').checked).toBe(true));
    expect(box('BPM1:X').checked).toBe(true);
    expect(box('TOP:SET').checked).toBe(false);
    fireEvent.click(box('TOP:SET'));
    fireEvent.click(box('BPM1:X'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Plot 2 PVs' }));

    await waitFor(() => expect(here()).toBe('/embed/@trace'));
    const frame = document.querySelector('iframe.workspace-trace') as HTMLIFrameElement;
    const src = new URL(frame.src);
    expect(src.searchParams.getAll('pv')).toEqual(['TOP:I', 'TOP:SET']);
    expect(src.searchParams.get('range')).toBe('-6h');
    expect(stored()?.instances['@trace']?.query).toBe('pv=TOP:I&pv=TOP:SET&range=-6h');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('filters the list and leaves everything as it was on cancel', async () => {
    renderAt('/embed/bts/knob', { trace: TRACE });
    fireEvent.click(await plotButton());
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByLabelText('TOP:I');
    fireEvent.change(within(dialog).getByRole('searchbox'), { target: { value: 'bpm' } });
    expect(within(dialog).queryByLabelText('TOP:I')).toBeNull();
    expect(within(dialog).getByLabelText('BPM1:X')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(here()).toBe('/embed/bts/knob');
  });

  it('is not offered without a data browser', async () => {
    renderAt('/embed/bts/knob');
    await screen.findByRole('button', { name: 'Copy link' });
    expect(screen.queryByRole('button', { name: 'Plot in Data Browser' })).toBeNull();
  });
});

describe('WorkspacePage saved views', () => {
  let views: { id: string; name: string; query: string }[];
  let writes: { method: string; url: string; body?: unknown }[];

  beforeEach(() => {
    views = [{ id: 'gun-vacuum', name: 'Gun vacuum', query: 'pv=GUN:VAC&range=-12h' }];
    writes = [];
    // Carbon's Modal observes its body; jsdom has no ResizeObserver.
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (!url.includes('/views')) return new Response(JSON.stringify(manifest), { status: 200 });
      if (method === 'GET') return new Response(JSON.stringify({ views }), { status: 200 });
      const id = decodeURIComponent(url.slice(url.lastIndexOf('/') + 1));
      if (method === 'PUT') {
        const body = JSON.parse(String(init?.body)) as { name: string; query: string };
        writes.push({ method, url, body });
        const view = { id, ...body };
        views = [...views.filter((v) => v.id !== id), view];
        return new Response(JSON.stringify(view), { status: 201 });
      }
      writes.push({ method, url });
      views = views.filter((v) => v.id !== id);
      return new Response(null, { status: 204 });
    });
  });

  function iframe(): HTMLIFrameElement {
    const frame = document.querySelector('iframe.workspace-trace');
    if (!(frame instanceof HTMLIFrameElement)) throw new Error('no Trace iframe');
    return frame;
  }

  it('lists the views under the data browser; opening one reloads Trace with its query', async () => {
    renderAt('/embed/bts/knob', { trace: TRACE, views: true });
    const item = await within(tree()).findByText('Gun vacuum');
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith('/views'))).toBe(true);
    fireEvent.click(item);
    await waitFor(() => expect(here()).toBe('/embed/@trace'));
    const first = iframe();
    expect(new URL(first.src).searchParams.getAll('pv')).toEqual(['GUN:VAC']);
    expect(new URL(first.src).searchParams.get('range')).toBe('-12h');
    expect(stored()?.instances['@trace']).toEqual({
      query: 'pv=GUN:VAC&range=-12h',
      view: 'gun-vacuum',
    });
    expect(
      within(tree()).getByRole('treeitem', { name: 'Gun vacuum' }).getAttribute('aria-selected')
    ).toBe('true');
    // The tab is titled by the view.
    expect(tabTitles()).toEqual(['Knob device', 'Gun vacuum']);

    // Opening it again focuses the instance showing it, without a reload;
    // "Revert to saved" is what reloads it.
    fireEvent.click(within(strip()).getByRole('tab', { name: /Knob device/ }));
    fireEvent.click(within(tree()).getByText('Gun vacuum'));
    await waitFor(() => expect(here()).toBe('/embed/@trace'));
    expect(iframe()).toBe(first);
  });

  it('saves the current data browser view under a name, from the tab strip', async () => {
    sessionStorage.setItem(
      tabsStorageKey('/'),
      JSON.stringify({
        keys: ['@trace'],
        active: '@trace',
        instances: { '@trace': { query: 'pv=RF:FWD&range=-1h' } },
      })
    );
    renderAt('/embed/', { trace: TRACE, views: true });
    await within(tree()).findByText('Gun vacuum');
    fireEvent.click(screen.getByRole('button', { name: 'Save view' }));
    const name = await screen.findByLabelText('Name');
    fireEvent.change(name, { target: { value: 'RF forward' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toEqual({
      method: 'PUT',
      url: 'http://localhost:3000/views/rf-forward',
      body: { name: 'RF forward', query: 'pv=RF:FWD&range=-1h' },
    });
    await within(tree()).findByText('RF forward');
    expect(screen.getByTestId('save-view-status').textContent).toContain('RF forward');
    // The data browser now shows the saved view.
    await waitFor(() =>
      expect(
        within(tree()).getByRole('treeitem', { name: 'RF forward' }).getAttribute('aria-selected')
      ).toBe('true')
    );
  });

  it('keeps the axis settings Trace reported through a save and a reopen', async () => {
    const plot = '{"v":1,"axes":[{},{"name":"I","logScale":true}],"traces":[{},{"axis":1}]}';
    const query = `pv=GTL:BPM1:X&pv=GTL:QF1:I&range=-6h&plot=${encodeURIComponent(plot)}`;
    sessionStorage.setItem(
      tabsStorageKey('/'),
      JSON.stringify({
        keys: ['@trace'],
        active: '@trace',
        instances: { '@trace': { query: query } },
      })
    );
    renderAt('/embed/', { trace: TRACE, views: true });
    await within(tree()).findByText('Gun vacuum');
    fireEvent.click(screen.getByRole('button', { name: 'Save view' }));
    expect(await screen.findByText(/2 PVs, the time range and the axis settings/)).toBeTruthy();
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'GTL axes' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]?.body).toEqual({ name: 'GTL axes', query });

    // Reopened from the tree, Trace's frame gets the settings back.
    fireEvent.click(await within(tree()).findByText('GTL axes'));
    await waitFor(() => expect(new URL(iframe().src).searchParams.get('plot')).toBe(plot));
    expect(new URL(iframe().src).searchParams.getAll('pv')).toEqual(['GTL:BPM1:X', 'GTL:QF1:I']);
    expect(stored()?.instances['@trace']?.query).toBe(query);
  });

  it('warns before replacing a view of the same name', async () => {
    sessionStorage.setItem(
      tabsStorageKey('/'),
      JSON.stringify({
        keys: ['@trace'],
        active: '@trace',
        instances: { '@trace': { query: 'pv=X' } },
      })
    );
    renderAt('/embed/', { trace: TRACE, views: true });
    await within(tree()).findByText('Gun vacuum');
    fireEvent.click(screen.getByRole('button', { name: 'Save view' }));
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'gun VACUUM' } });
    expect(screen.getByText('Replaces the saved view “Gun vacuum”.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Replace' })).toBeTruthy();
  });

  it('shows Save view only on the data browser tab', async () => {
    renderAt('/embed/bts/knob', { trace: TRACE, views: true });
    await within(tree()).findByText('Gun vacuum');
    expect(screen.queryByRole('button', { name: 'Save view' })).toBeNull();
  });

  it('has no saved views without config.views', async () => {
    renderAt('/embed/@trace', { trace: TRACE });
    await treeLoaded();
    expect(screen.queryByRole('button', { name: 'Save view' })).toBeNull();
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/views'))).toBe(false);
  });
});

describe('WorkspacePage tool instances', () => {
  const CORR: TraceConfig = { path: 'trace/correlation.html', query: 'n=500' };
  let views: { id: string; name: string; kind?: string; query: string }[];
  let writes: { url: string; body: unknown }[];
  let putStatus: number;

  beforeEach(() => {
    views = [];
    writes = [];
    putStatus = 201;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (!url.includes('/views')) return new Response(JSON.stringify(manifest), { status: 200 });
      if (method === 'GET') return new Response(JSON.stringify({ views }), { status: 200 });
      const id = decodeURIComponent(url.slice(url.lastIndexOf('/') + 1));
      const body = JSON.parse(String(init?.body)) as { name: string; query: string; kind?: string };
      writes.push({ url, body });
      if (putStatus === 409) {
        return new Response(
          JSON.stringify({ code: 'kind_conflict', detail: `view '${id}' is of another kind` }),
          {
            status: 409,
          }
        );
      }
      const view = { id, ...body };
      views = [...views.filter((v) => v.id !== id), view];
      return new Response(JSON.stringify(view), { status: 201 });
    });
  });

  function frame(key: string): HTMLIFrameElement {
    const el = document.querySelector(`iframe[data-tab-key="${key}"]`);
    if (!(el instanceof HTMLIFrameElement)) throw new Error(`no iframe for ${key}`);
    return el;
  }

  function report(key: string, query: string) {
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'canopy:trace-query', query },
          origin: window.location.origin,
          source: frame(key).contentWindow,
        })
      );
    });
  }

  /** A tool frame asking the workspace to open `tool` with `query`. */
  function openFrom(key: string, tool: string, query: string) {
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'canopy:trace-open', tool, query },
          origin: window.location.origin,
          source: frame(key).contentWindow,
        })
      );
    });
  }

  function seed(state: Partial<Stored>) {
    sessionStorage.setItem(
      tabsStorageKey('/'),
      JSON.stringify({ keys: [], active: null, instances: {}, toolMru: [], ...state })
    );
  }

  function plus(label: string) {
    fireEvent.click(within(tree()).getByRole('button', { name: `New ${label} tab` }));
  }

  it("'+' opens blank instances side by side; each frame carries its key", async () => {
    renderAt('/embed/bts/knob', { trace: TRACE, correlation: CORR });
    await treeLoaded();
    plus('Correlation');
    plus('Correlation');
    await waitFor(() => expect(here()).toBe('/embed/@correlation/2'));
    expect(tabTitles()).toEqual(['Knob device', 'Correlation', 'Correlation 2']);
    // Blank: '' (not the config default) and never the Trace class.
    expect(new URL(frame('@correlation').src).searchParams.get('n')).toBeNull();
    expect(frame('@correlation').classList.contains('workspace-trace')).toBe(false);
    expect(frame('@correlation/2').getAttribute('aria-hidden')).toBeNull();
    expect(frame('@correlation').getAttribute('aria-hidden')).toBe('true');
    // Each instance reports its own query.
    report('@correlation', 'x=A&y=B');
    report('@correlation/2', 'x=C&y=D&y=E');
    expect(stored()?.instances).toEqual({
      '@correlation': { query: 'x=A&y=B' },
      '@correlation/2': { query: 'x=C&y=D&y=E' },
    });
    // A replace-open of a screen while @correlation/2 is active appends.
    fireEvent.click(within(tree()).getByText('Magnet'));
    await waitFor(() => expect(tabTitles()).toHaveLength(4));
    expect(stored()?.keys).toEqual(['bts/knob', '@correlation', '@correlation/2', 'common/magnet']);
  });

  it('a Tools-entry click focuses the most recently used instance', async () => {
    seed({
      keys: ['bts/knob', '@trace', '@trace/2'],
      active: 'bts/knob',
      toolMru: ['@trace/2', '@trace'],
    });
    renderAt('/embed/', { trace: TRACE });
    await treeLoaded();
    fireEvent.click(within(tree()).getByText('Data Browser (Trace)'));
    await waitFor(() => expect(here()).toBe('/embed/@trace/2'));
    expect(stored()?.keys).toHaveLength(3);
  });

  it('loading a view into one instance remounts only that one; Revert reloads only its instance', async () => {
    views = [{ id: 'gun', name: 'Gun', query: 'pv=GUN&range=-1h' }];
    seed({
      keys: ['@trace', '@trace/2'],
      active: '@trace/2',
      instances: { '@trace': { query: 'pv=ONE' }, '@trace/2': { query: 'pv=TWO' } },
      toolMru: ['@trace/2'],
    });
    renderAt('/embed/', { trace: TRACE, views: true });
    await within(tree()).findByText('Gun');
    const one = frame('@trace');
    fireEvent.click(within(tree()).getByText('Gun'));
    await waitFor(() => expect(here()).toBe('/embed/@trace/3'));
    expect(frame('@trace')).toBe(one);
    const three = frame('@trace/3');
    expect(new URL(three.src).searchParams.getAll('pv')).toEqual(['GUN']);

    // Edited in its page: Revert is offered and reloads instance 3 only.
    report('@trace/3', 'pv=GUN&pv=MORE&range=-1h');
    fireEvent.contextMenu(within(tree()).getByText('Gun'));
    fireEvent.click(screen.getByText('Revert to saved'));
    await waitFor(() => expect(frame('@trace/3')).not.toBe(three));
    expect(new URL(frame('@trace/3').src).searchParams.getAll('pv')).toEqual(['GUN']);
    expect(frame('@trace')).toBe(one);
    expect(stored()?.instances['@trace/3']).toEqual({ query: 'pv=GUN&range=-1h', view: 'gun' });
  });

  it('at the cap a saved view loads into the most recently used instance, with a notice', async () => {
    views = [{ id: 'correlation_orm', name: 'ORM', kind: 'correlation', query: 'x=H&y=B1' }];
    const keys = ['@correlation', ...Array.from({ length: 9 }, (_, i) => `@correlation/${i + 2}`)];
    seed({ keys: ['bts/knob', ...keys], active: 'bts/knob', toolMru: ['@correlation/4'] });
    renderAt('/embed/', { correlation: CORR, views: true });
    await within(tree()).findByText('ORM');
    const plusButton = within(tree()).getByRole('button', { name: 'New Correlation tab' });
    expect(plusButton.getAttribute('aria-disabled')).toBe('true');
    const four = frame('@correlation/4');
    fireEvent.click(within(tree()).getByText('ORM'));
    await waitFor(() => expect(here()).toBe('/embed/@correlation/4'));
    expect(frame('@correlation/4')).not.toBe(four);
    expect(new URL(frame('@correlation/4').src).searchParams.get('x')).toBe('H');
    expect(document.querySelector('.workspace__notice')?.textContent).toContain(
      'At most 10 Correlation tabs; loaded into Correlation 4'
    );
    expect(stored()?.keys).toHaveLength(11);
  });

  it('trace-open under the cap opens a new instance carrying the query', async () => {
    seed({ keys: ['bts/knob', '@trace', '@correlation'], active: '@trace' });
    renderAt('/embed/@trace', { trace: TRACE, correlation: CORR });
    await waitFor(() => expect(frame('@trace')).toBeTruthy());
    openFrom('@trace', 'correlation', 'x=H&y=B1');
    await waitFor(() => expect(here()).toBe('/embed/@correlation/2'));
    expect(new URL(frame('@correlation/2').src).searchParams.get('x')).toBe('H');
    expect(stored()?.instances['@correlation/2']).toEqual({ query: 'x=H&y=B1' });
    expect(stored()?.keys).toEqual(['bts/knob', '@trace', '@correlation', '@correlation/2']);
    expect(document.querySelector('.workspace__notice')).toBeNull();
  });

  it('trace-open at the cap loads into the most recently used instance, with a notice', async () => {
    const keys = ['@correlation', ...Array.from({ length: 9 }, (_, i) => `@correlation/${i + 2}`)];
    seed({ keys: ['@trace', ...keys], active: '@trace', toolMru: ['@correlation/4'] });
    renderAt('/embed/@trace', { trace: TRACE, correlation: CORR });
    await waitFor(() => expect(frame('@correlation/4')).toBeTruthy());
    const four = frame('@correlation/4');
    openFrom('@trace', 'correlation', 'x=H&y=B1');
    await waitFor(() => expect(here()).toBe('/embed/@correlation/4'));
    expect(frame('@correlation/4')).not.toBe(four);
    expect(new URL(frame('@correlation/4').src).searchParams.get('x')).toBe('H');
    expect(document.querySelector('.workspace__notice')?.textContent).toContain(
      'At most 10 Correlation tabs; loaded into Correlation 4'
    );
    expect(stored()?.keys).toHaveLength(11);
  });

  it('trace-open of a registered but unconfigured tool shows a notice and opens nothing', async () => {
    renderAt('/embed/@trace', { trace: TRACE });
    await waitFor(() => expect(frame('@trace')).toBeTruthy());
    openFrom('@trace', 'correlation', 'x=H&y=B1');
    await waitFor(() =>
      expect(document.querySelector('.workspace__notice')?.textContent).toContain(
        'Correlation is not available here'
      )
    );
    expect(here()).toBe('/embed/@trace');
    expect(stored()?.keys ?? []).not.toContain('@correlation');
  });

  it('trace-open with an invalid query or an unregistered tool is ignored', async () => {
    seed({ keys: ['@trace', '@correlation'], active: '@trace' });
    renderAt('/embed/@trace', { trace: TRACE, correlation: CORR });
    await waitFor(() => expect(frame('@trace')).toBeTruthy());
    const before = stored();
    // Not decodable: fails Correlation's isValidQuery.
    openFrom('@trace', 'correlation', 'x=%E0%A4%A');
    // Over the size limit.
    openFrom('@trace', 'correlation', `x=${'A'.repeat(20000)}`);
    // Trace requires a pv or range key.
    openFrom('@correlation', 'trace', 'n=5');
    // Not a registered tool.
    openFrom('@trace', 'nosuch', 'x=H');
    await act(async () => {});
    expect(here()).toBe('/embed/@trace');
    expect(stored()?.keys).toEqual(before?.keys);
    expect(stored()?.instances).toEqual(before?.instances);
    expect(document.querySelector('.workspace__notice')).toBeNull();
  });

  it('a URL naming an 11th instance warns and restores the active URL', async () => {
    const keys = ['@correlation', ...Array.from({ length: 9 }, (_, i) => `@correlation/${i + 2}`)];
    seed({ keys: ['bts/knob', ...keys], active: 'bts/knob' });
    renderAt('/embed/bts/knob', { correlation: CORR });
    await screen.findByTestId('screen-probe');
    act(() => navigateTo('/embed/@correlation/11'));
    await waitFor(() => expect(here()).toBe('/embed/bts/knob'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('At most 10 Correlation tabs'));
    expect(stored()?.keys).toHaveLength(11);
    // An instance under the cap opens (with the tool default).
    act(() => navigateTo('/embed/@correlation/5'));
    await waitFor(() => expect(here()).toBe('/embed/@correlation/5'));
  });

  it('open_display to a tool URL warns and changes no state', async () => {
    renderAt('/embed/bts/knob', { correlation: CORR });
    await screen.findByTestId('screen-probe');
    const before = sessionStorage.getItem(tabsStorageKey('/'));
    fireEvent.click(screen.getByRole('button', { name: 'action-navigate-tool' }));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('/embed/@correlation/2'));
    expect(sessionStorage.getItem(tabsStorageKey('/'))).toBe(before);
    expect(here()).toBe('/embed/bts/knob');
  });

  it('saves a correlation view under correlation_<slug> with its kind, beside a Trace view of the same name', async () => {
    views = [{ id: 'orm', name: 'ORM', query: 'pv=A&range=-1h' }];
    seed({
      keys: ['@correlation'],
      active: '@correlation',
      instances: { '@correlation': { query: 'x=HCM01&y=BPM1&y=BPM2' } },
    });
    renderAt('/embed/', { trace: TRACE, correlation: CORR, views: true });
    await within(tree()).findByText('ORM');
    fireEvent.click(screen.getByRole('button', { name: 'Save view' }));
    expect(await screen.findByText('Save Correlation view')).toBeTruthy();
    expect(
      screen.getByText('2 Y PVs, listed for everyone under Tools → Correlation.')
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'ORM' } });
    // Not the Trace view's id: a plain Save, no Replace.
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toEqual({
      url: 'http://localhost:3000/views/correlation_orm',
      body: { name: 'ORM', query: 'x=HCM01&y=BPM1&y=BPM2', kind: 'correlation' },
    });
    await waitFor(() =>
      expect(
        document.querySelector('[data-screen-key="@correlation"] [data-view-id="correlation_orm"]')
      ).not.toBeNull()
    );
    expect(
      document.querySelector('[data-screen-key="@trace"] [data-view-id="orm"]')
    ).not.toBeNull();
    expect(tabTitles()).toEqual(['ORM']);
  });

  it('shows a 409 from the server in the save dialog', async () => {
    putStatus = 409;
    seed({ keys: ['@trace'], active: '@trace', instances: { '@trace': { query: 'pv=X' } } });
    renderAt('/embed/', { trace: TRACE, views: true });
    await treeLoaded();
    fireEvent.click(screen.getByRole('button', { name: 'Save view' }));
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Taken' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByText("Could not save the view: view 'taken' is of another kind")
    ).toBeTruthy();
    expect(writes[0]?.body).toEqual({ name: 'Taken', query: 'pv=X' });
  });

  it('a view of a tool not served here is listed disabled', async () => {
    views = [{ id: 'correlation_x', name: 'Corr X', kind: 'correlation', query: 'x=A' }];
    renderAt('/embed/', { trace: TRACE, views: true });
    const item = await within(tree()).findByRole('treeitem', { name: 'Corr X' });
    expect(item.getAttribute('aria-disabled')).toBe('true');
    expect(item.getAttribute('title')).toBe('Correlation is not available here');
  });

  it('"Plot in Data Browser" keeps the MRU instance’s range and remounts only it', async () => {
    seed({
      keys: ['bts/knob', '@trace', '@trace/2'],
      active: 'bts/knob',
      instances: {
        '@trace': { query: 'pv=ONE&range=-6h' },
        '@trace/2': { query: 'pv=TWO&range=-2h' },
      },
      toolMru: ['@trace/2', '@trace'],
    });
    renderAt('/embed/bts/knob', { trace: TRACE });
    const one = frame('@trace');
    const two = frame('@trace/2');
    fireEvent.click(await screen.findByRole('button', { name: 'Plot in Data Browser' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByLabelText('TOP:I');
    fireEvent.click(within(dialog).getByRole('button', { name: /^Plot/ }));
    await waitFor(() => expect(here()).toBe('/embed/@trace/2'));
    expect(frame('@trace')).toBe(one);
    expect(frame('@trace/2')).not.toBe(two);
    expect(new URL(frame('@trace/2').src).searchParams.get('range')).toBe('-2h');
    expect(stored()?.instances['@trace']?.query).toBe('pv=ONE&range=-6h');
  });
});

describe('storage keyed by the mount', () => {
  const ALICE = '/u/alice/panel/canopy';
  const BOB = '/u/bob/panel/canopy';

  function renderMounted(mount: string, path: string) {
    return render(
      <MemoryRouter basename={mount} initialEntries={[`${mount}${path}`]}>
        <ZoomProvider>
          <EmbedThemeContext.Provider
            value={{ mode: 'dark', id: 'dark', anchorRef: { current: null } }}
          >
            <WorkspacePage screensBaseUrl={BASE} />
            <LocationProbe />
          </EmbedThemeContext.Provider>
        </ZoomProvider>
      </MemoryRouter>
    );
  }

  it("mirrors the tabs under the mount's key, never the root's", async () => {
    renderMounted(ALICE, '/embed/bts/knob');
    await screen.findByTestId('screen-probe');
    await waitFor(() => expect(here()).toBe('/embed/bts/knob'));
    expect(sessionStorage.getItem(tabsStorageKey('/'))).toBeNull();
    expect(JSON.parse(sessionStorage.getItem(tabsStorageKey(ALICE))!).keys).toEqual(['bts/knob']);
  });

  it('one mount never restores the tabs another mount or the root stored', async () => {
    sessionStorage.setItem(
      tabsStorageKey(ALICE),
      JSON.stringify({ keys: ['common/magnet'], active: 'common/magnet' })
    );
    sessionStorage.setItem(
      tabsStorageKey('/'),
      JSON.stringify({ keys: ['bts/knob'], active: 'bts/knob' })
    );
    renderMounted(BOB, '/embed/');
    expect(await screen.findByTestId('workspace-empty')).toBeTruthy();
    expect(JSON.parse(sessionStorage.getItem(tabsStorageKey(BOB))!).keys).toEqual([]);
    expect(JSON.parse(sessionStorage.getItem(tabsStorageKey(ALICE))!).keys).toEqual([
      'common/magnet',
    ]);
    expect(JSON.parse(sessionStorage.getItem(tabsStorageKey('/'))!).keys).toEqual(['bts/knob']);
  });

  it("remembers a tile's zoom under the mount's record, never the root's", async () => {
    renderMounted(ALICE, '/embed/bts/knob');
    await screen.findByTestId('screen-probe');
    fireEvent.click(screen.getByRole('button', { name: 'Actual size' }));
    expect(screen.getByTestId('zoom-percent').textContent).toBe('100%');
    expect(localStorage.getItem(ZOOM_RECORD)).toBeNull();
    expect(sessionStorage.getItem(`${ZOOM_STORAGE_NAME}:${ALICE}:bts/knob`)).toBeNull();
    expect(zoomRecord(`${ZOOM_BY_SCREEN_NAME}:${ALICE}`)).toEqual({
      'bts/knob': { mode: 'manual', scale: 1 },
    });
  });

  it("mirrors the chrome-off zoom under the mount's key, never the root's", async () => {
    renderMounted(ALICE, '/embed/bts/knob?_canopyChrome=0&_canopyZoom=100');
    await screen.findByTestId('screen-probe');
    await waitFor(() =>
      expect(JSON.parse(sessionStorage.getItem(`${ZOOM_STORAGE_NAME}:${ALICE}`)!)).toEqual({
        mode: 'manual',
        scale: 1,
      })
    );
    expect(sessionStorage.getItem(`${ZOOM_STORAGE_NAME}:/`)).toBeNull();
  });
});

describe('WorkspacePage tile bars (phase 1)', () => {
  /** Two tiles from a stored dock: knob (left) and magnet (right, focused). */
  async function twoTiles() {
    sessionStorage.setItem(
      tabsStorageKey('/'),
      JSON.stringify({ keys: ['bts/knob', 'common/magnet'], active: 'common/magnet' })
    );
    storeRow(['bts/knob', 'common/magnet']);
    renderAt('/embed/common/magnet');
    await waitFor(() => expect(here()).toBe('/embed/common/magnet'));
    await settle();
    await waitFor(() => expect(tileBars()).toHaveLength(2));
    await waitFor(() =>
      expect(within(tileActions('common/magnet')).getAllByRole('button').length).toBeGreaterThan(5)
    );
  }

  /** Focus the tile showing `key` by a click on its tab in that tile's bar. */
  function focusTile(key: string) {
    const tab = tileBar(key).querySelector<HTMLElement>(`[role="tab"][data-tab-key="${key}"]`)!;
    fireEvent.pointerDown(tab);
    fireEvent.mouseDown(tab);
    fireEvent.click(tab);
  }

  it('gives every tile one bar in the dock, and no strip above it', async () => {
    await twoTiles();
    expect(
      tileBars()
        .map((b) => b.dataset.panelKey)
        .sort()
    ).toEqual(['bts/knob', 'common/magnet']);
    const dock = screen.getByTestId('workspace-dock');
    for (const bar of tileBars()) expect(dock.contains(bar)).toBe(true);
    // Two or more tiles: each has its bar, and the strip row is gone.
    expect(screen.queryByRole('tablist', { name: 'Open tabs' })).toBeNull();
    // One header per screen tile, each in its own tile's actions slot; none anywhere else.
    const headers = screen.getAllByTestId('screen-header');
    expect(headers).toHaveLength(2);
    for (const key of ['bts/knob', 'common/magnet']) {
      expect(within(tileActions(key)).getAllByTestId('screen-header')).toHaveLength(1);
    }
    expect(screen.getByTestId('workspace').querySelectorAll('header')).toHaveLength(2);
  });

  it('gives an unfocused screen tile its own title, zoom and actions besides its ×', async () => {
    await twoTiles();
    const knob = tileBar('bts/knob');
    // Its screen reports while showing, so its tile shows the screen's title.
    await waitFor(() => expect(tileActions('bts/knob').textContent).toContain('Rendered knob'));
    expect(within(tileActions('bts/knob')).getByTestId('screen-header')).toBeTruthy();
    expect(within(tileActions('bts/knob')).getByTestId('zoom-percent')).toBeTruthy();
    // Its tab's × closes the tab (there is no "remove from layout" any more).
    expect(within(knob).getByRole('button', { name: /^Close tab: / })).toBeTruthy();
    expect(within(knob).queryByRole('button', { name: /Remove from layout/ })).toBeNull();
    // Both tiles hold a zoom group and the actions (the probe screen has no
    // document or element, so copy-link is the one that applies).
    for (const key of ['bts/knob', 'common/magnet']) {
      const slot = tileActions(key);
      expect(within(slot).getByTestId('zoom-percent')).toBeTruthy();
      expect(
        Array.from(slot.querySelectorAll<HTMLElement>('[data-screen-action]')).map(
          (b) => b.dataset.screenAction
        )
      ).toEqual(['copy-link']);
    }
  });

  it('binds exactly one shortcut listener with two screen tiles, following focus', async () => {
    await twoTiles();
    expect(dockProbe.shortcutMounts).toBe(1);
    // Focus moves to the knob's tile: every tile keeps its actions, and the
    // one listener stays one.
    focusTile('bts/knob');
    await waitFor(() => expect(here()).toBe('/embed/bts/knob'));
    await settle();
    expect(tileActions('bts/knob').querySelectorAll('[data-screen-action]')).toHaveLength(1);
    expect(within(tileActions('bts/knob')).getByTestId('zoom-percent')).toBeTruthy();
    expect(tileActions('common/magnet').querySelectorAll('[data-screen-action]')).toHaveLength(1);
    expect(dockProbe.shortcutMounts).toBe(1);
  });

  it('renders no tooltip in a tile: actions are labelled by their native title', async () => {
    await twoTiles();
    const magnet = tileActions('common/magnet');
    const actions = Array.from(magnet.querySelectorAll<HTMLElement>('[data-screen-action]'));
    expect(actions.length).toBeGreaterThan(0);
    for (const action of actions) {
      expect(action.tagName).toBe('BUTTON');
      expect(action.getAttribute('title')).toBeTruthy();
      expect(action.getAttribute('aria-label')).toBe(action.getAttribute('title'));
      fireEvent.mouseOver(action);
      fireEvent.focus(action);
    }
    // The zoom group's buttons are labelled the same way.
    for (const name of ['Zoom out', 'Zoom in', 'Actual size']) {
      expect(within(magnet).getByRole('button', { name }).getAttribute('title')).toBeTruthy();
    }
    for (const key of ['bts/knob', 'common/magnet']) {
      expect(tileBar(key).querySelector('[role="tooltip"]')).toBeNull();
      expect(tileActions(key).querySelector('[role="tooltip"]')).toBeNull();
    }
  });

  // A tile whose chrome grew when it gained focus would move its content
  // under the pointer. jsdom lays nothing out, so this pins the rule the
  // browser spec measures: the header sits in the tile's actions slot, never
  // in its bar, whichever tile has focus.
  it('keeps every screen header in its tile across a focus change', async () => {
    await twoTiles();
    const rows = () =>
      ['bts/knob', 'common/magnet'].map((key) => [
        within(tileActions(key)).queryAllByTestId('screen-header').length,
        within(tileBar(key)).queryAllByTestId('screen-header').length,
      ]);
    expect(rows()).toEqual([
      [1, 0],
      [1, 0],
    ]);
    // Focus moves: nothing in either tile changes rows.
    focusTile('bts/knob');
    await waitFor(() => expect(here()).toBe('/embed/bts/knob'));
    await settle();
    expect(rows()).toEqual([
      [1, 0],
      [1, 0],
    ]);
  });

  it('gives a tile without the header its tab title and no header', async () => {
    // A screen the manifest lacks has no header: its tile shows only its tab.
    sessionStorage.setItem(
      tabsStorageKey('/'),
      JSON.stringify({ keys: ['bts/knob', 'bts/gone'], active: 'bts/knob' })
    );
    storeRow(['bts/knob', 'bts/gone']);
    renderAt('/embed/');
    await screen.findByTestId('screen-probe');
    await settle();
    await waitFor(() => expect(tileBars()).toHaveLength(2));
    await settle();
    expect(
      tileBar('bts/gone').querySelector('[role="tab"][data-tab-key="bts/gone"]')
    ).not.toBeNull();
    expect(within(tileActions('bts/gone')).queryByTestId('screen-header')).toBeNull();
    expect(within(tileActions('bts/knob')).getByTestId('screen-header')).toBeTruthy();
  });

  it('shows the header above the content with one tile', async () => {
    renderAt('/embed/bts/knob');
    await screen.findByTestId('screen-probe');
    await settle();
    expect(tileBars()).toHaveLength(0);
    const headers = screen.getAllByTestId('screen-header');
    expect(headers).toHaveLength(1);
    const header = headers[0]!;
    expect(header.closest('[data-testid="workspace-dock"]')).toBeNull();
    expect(header.closest('.workspace__content')).toBeNull();
    expect(header.parentElement!.classList).toContain('workspace__main');
    expect(within(header).getByTestId('screen-header-title').textContent).toContain(
      'Rendered knob'
    );
    expect(within(header).getByTestId('zoom-percent')).toBeTruthy();
    expect(header.querySelectorAll('[data-screen-action]').length).toBeGreaterThan(0);
    expect(dockProbe.shortcutMounts).toBe(1);
    // A single-tile tool row is the header row's height (Carbon's 3rem header).
    expect(TILE_BAR_ROW_HEIGHT).toBe('3rem');
  });

  it('closes a tab with its tile bar ×, and its tile goes with it', async () => {
    await twoTiles();
    fireEvent.click(within(tileBar('bts/knob')).getByRole('button', { name: /^Close tab: / }));
    await settle();
    // One tile is left: no bar, its tabs back in the strip.
    await waitFor(() => expect(tileBars()).toHaveLength(0));
    expect(tabTitles()).toHaveLength(1);
  });
});

describe('WorkspacePage member titles (rt-tool-title)', () => {
  const GUN = 'Gun high voltage and heater';
  const INJECTOR = {
    source: 'facility',
    ref: 'facility:injector',
    rev: 'r1',
    id: 'injector',
    name: 'Injector',
    members: [
      { screen: 'bts/knob' },
      {
        tool: 'trace',
        name: GUN,
        query: 'pv=EG______HV_____AM00&pv=EG______HTR____AM00&range=-1h',
      },
    ],
    default: true,
  };
  const reply = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  beforeEach(() => {
    fetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/collections-state')) {
        return reply({ ticked: [], unticked: [], pinned: [], recent: [] });
      }
      if (url.endsWith('/collections') && (init?.method ?? 'GET') === 'GET') {
        return reply({ collections: [INJECTOR] });
      }
      return reply(manifest);
    });
  });

  it('a member opened from Injector is titled by its name', async () => {
    renderAt('/', { trace: TRACE, collections: true });
    await waitFor(() => expect(within(tree()).getByText(GUN)).toBeTruthy());
    fireEvent.click(within(tree()).getByText(GUN));
    await waitFor(() => expect(tabTitles()).toContain(GUN));
    expect(document.title).toContain(GUN);
    // The name survives a reload of the tabs record.
    const instances = stored()!.instances as Record<string, { title?: string }>;
    expect(Object.values(instances).map((i) => i.title)).toContain(GUN);
  });
});
