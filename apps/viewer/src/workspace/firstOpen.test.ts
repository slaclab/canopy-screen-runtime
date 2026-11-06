// The first open with homeOnFirstOpen (the host-embedded default).
//
// Pinned here: (a) a never-stored base path opened bare inside the host opens
// the configured home library screen, else the first viewable non-sub-screen
// leaf of the screens tree in its render order, else nothing; it waits for the
// manifest when that arrives after the mount, and Recent records nothing;
// (b) a stored workspace restores and gets no home; (c) a session whose tabs
// were all closed stays empty, and closing the home tab never re-adds it;
// (d) a URL-named tab or a deep link opens only what it names. Standalone
// keeps the per-session `@trace` first visit.
//
// Host-embedded is the real isHostEmbedded(): `?embedded=true` on the page URL
// and a parent window, stubbed through window.parent's getter.

import { createElement, useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { Manifest, ManifestScreen } from '../api.js';
import { createBackendBadgeStore } from '../backendBadge.js';
import type { ViewerConfig } from '../config.js';
import { EmbedThemeContext } from '../pages/EmbedPage.js';
import { ServicesContext } from '../services.js';
import type { ViewerServices } from '../services.js';
import { ZoomProvider } from '../ZoomContext.js';
import { planDockLoad } from './dock/useDockPersistence.js';
import { dockStorageKey } from './dock/storage.js';
import { resetHostEmbeddedForTests } from './host/hostEmbed.js';
import { EMPTY_TABS, tabsStorageKey, TRACE_KEY, firstOpenKey } from './tabs.js';
import { WorkspacePage } from './WorkspacePage.js';

vi.hoisted(() => {
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
});

vi.mock('../pages/ScreenPage.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../pages/ScreenPage.js')>();
  function ScreenProbe(props: {
    category?: string;
    id?: string;
    onTitle?: (title: string) => void;
  }) {
    const { onTitle } = props;
    useEffect(() => {
      onTitle?.(`Rendered ${props.id ?? ''}`);
    }, [onTitle, props.id]);
    return createElement('div', {
      'data-testid': 'screen-probe',
      'data-screen': `${props.category ?? ''}/${props.id ?? ''}`,
    });
  }
  return { ...actual, ScreenPage: ScreenProbe };
});

function entry(category: string, id: string, title: string, kind = 'ir'): ManifestScreen {
  return { id, kind, title, category, path: `screens/${category}/${id}.screen.json` };
}

const HOME = 'sr/overview';
const MANIFEST: Manifest = {
  screens: [
    entry('library', 'sr/overview', 'Storage ring overview'),
    entry('library', 'bts/knob', 'Knob device'),
    entry('common', 'magnet', 'Magnet'),
  ],
};
const BASE = 'https://host/screens';

// --- pure: what the first open resolves to ---

describe('firstOpenKey', () => {
  it('opens the configured home when the manifest lists it in the library', () => {
    expect(firstOpenKey(MANIFEST.screens, HOME)).toBe('library/sr/overview');
  });

  it('falls back when the home is unknown, outside the library or not viewable', () => {
    const screens = [
      entry('common', 'sr/overview', 'Elsewhere'),
      entry('library', 'code/thing', 'Code screen', 'code'),
      entry('library', 'b', 'Beta'),
    ];
    // 'common' sorts before 'library'.
    expect(firstOpenKey(screens, 'nope')).toBe('common/sr/overview');
    expect(firstOpenKey(screens, 'sr/overview')).toBe('common/sr/overview');
    expect(firstOpenKey(screens, 'code/thing')).toBe('common/sr/overview');
  });

  it('falls back to the first leaf in render order: folders by name before leaves by title', () => {
    const screens = [
      entry('drafts', 'aaa', 'AAA draft'), // flattened into the root: after every folder
      entry('zeta', 'top', 'Top'),
      entry('alpha', 'zz', 'Zulu'),
      entry('alpha', 'aa', 'Yankee'),
      entry('alpha', 'sub/deep', 'Deep'), // folder 'sub' comes before alpha's leaves
    ];
    expect(firstOpenKey(screens)).toBe('alpha/sub/deep');
    expect(firstOpenKey(screens.filter((s) => s.id !== 'sub/deep'))).toBe('alpha/aa');
    expect(firstOpenKey([entry('drafts', 'aaa', 'AAA draft'), entry('zeta', 'top', 'Top')])).toBe(
      'zeta/top'
    );
    expect(firstOpenKey([entry('drafts', 'aaa', 'AAA draft')])).toBe('drafts/aaa');
  });

  it('skips sub-screens, internal categories and screens it cannot render', () => {
    const screens = [
      entry('alpha', 'embedded/panel', 'A panel'),
      entry('alpha', '_hidden', 'Aaa hidden'),
      entry('@trace', 'x', 'Internal'),
      entry('alpha', 'wrapped', 'Aardvark', 'wrapper'),
      entry('beta', 'real', 'Real'),
    ];
    expect(firstOpenKey(screens)).toBe('beta/real');
  });

  it('opens nothing without a viewable screen', () => {
    expect(firstOpenKey([])).toBeNull();
    expect(firstOpenKey([], HOME)).toBeNull();
    expect(firstOpenKey([entry('alpha', '_only', 'Only sub')])).toBeNull();
  });
});

// --- pure: the mount-time load decision ---

describe('planDockLoad first visit', () => {
  const tools = ['trace'];
  const input = {
    chrome: true,
    basename: '/',
    stored: EMPTY_TABS,
    urlKey: null,
    tools,
    newSession: true,
  };

  beforeEach(() => clearStorage());
  afterEach(() => clearStorage());

  it('host-embedded, never stored: opens nothing and marks the home pending', () => {
    const load = planDockLoad({ ...input, homeOnFirstOpen: true });
    expect(load.state.keys).toEqual([]);
    expect(load.pendingHome).toBe(true);
  });

  it('standalone, never stored: the data browser opens, nothing pending', () => {
    const load = planDockLoad(input);
    expect(load.state.keys).toEqual([TRACE_KEY]);
    expect(load.pendingHome).toBeUndefined();
  });

  it('host-embedded with a URL-named tab: only that tab, nothing pending', () => {
    const load = planDockLoad({ ...input, homeOnFirstOpen: true, urlKey: 'common/magnet' });
    expect(load.state.keys).toEqual(['common/magnet']);
    expect(load.pendingHome).toBeUndefined();
  });

  it('host-embedded with a deep link: nothing opens here and nothing is pending', () => {
    const load = planDockLoad({ ...input, homeOnFirstOpen: true, suppressFirstVisit: true });
    expect(load.state.keys).toEqual([]);
    expect(load.pendingHome).toBeUndefined();
  });

  it('host-embedded, stored session tabs: they restore, nothing pending', () => {
    const stored = { ...EMPTY_TABS, keys: ['common/magnet'], active: 'common/magnet' };
    const load = planDockLoad({ ...input, homeOnFirstOpen: true, stored, newSession: false });
    expect(load.state.keys).toEqual(['common/magnet']);
    expect(load.pendingHome).toBeUndefined();
  });

  it('host-embedded, a session whose tabs were all closed stays empty', () => {
    const load = planDockLoad({ ...input, homeOnFirstOpen: true, newSession: false });
    expect(load.state.keys).toEqual([]);
    expect(load.pendingHome).toBeUndefined();
  });

  it('host-embedded, a stored empty dock layout: no home and no data browser', () => {
    // A v2 dock (storage.ts StoredDock) whose layout is an empty dock.
    localStorage.setItem(
      dockStorageKey('/'),
      JSON.stringify({ version: 1, layout: null, panels: {} })
    );
    const load = planDockLoad({ ...input, homeOnFirstOpen: true });
    expect(load.warnings).toEqual([]);
    expect(load.state.keys).toEqual([]);
    expect(load.pendingHome).toBeUndefined();
  });

  it('without chrome nothing is stored and nothing is pending', () => {
    const load = planDockLoad({ ...input, chrome: false, newSession: true, homeOnFirstOpen: true });
    expect(load.state.keys).toEqual([]);
    expect(load.pendingHome).toBeUndefined();
  });
});

// --- the page ---

const FAKE_PARENT = { postMessage: () => {} } as unknown as Window;

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

interface Server {
  /** The bodies of every non-GET request. */
  writes: string[];
  /** Resolves the held manifest response (when `hold` was set). */
  release: () => void;
}

function serve(manifest: Manifest, hold = false): Server {
  const server: Server = { writes: [], release: () => {} };
  const held = hold
    ? new Promise<void>((resolve) => {
        server.release = resolve;
      })
    : Promise.resolve();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const method = init?.method ?? 'GET';
      if (method !== 'GET') server.writes.push(String(init?.body ?? ''));
      if (url.includes('manifest.json')) {
        await held;
        return new Response(JSON.stringify(manifest), { status: 200 });
      }
      if (url.includes('collections-state')) {
        return new Response(JSON.stringify({ ticked: [], unticked: [], pinned: [], recent: [] }), {
          status: 200,
        });
      }
      if (url.includes('collections')) return new Response('[]', { status: 200 });
      return new Response('', { status: 404 });
    })
  );
  return server;
}

const CONFIG: ViewerConfig = {
  pvMode: 'mock',
  renderMode: 'edm',
  screensPath: '.',
  themes: {},
  confirmWrites: false,
  collections: { path: 'collections' },
};

function renderAt(path: string, config: ViewerConfig = CONFIG) {
  const backend = createBackendBadgeStore({
    backend: { name: 'example', label: 'Simulator', notice: null },
    binding: 'va@3',
  });
  const services = { backend } as unknown as ViewerServices;
  return render(
    createElement(
      ServicesContext.Provider,
      { value: services },
      createElement(
        MemoryRouter,
        { initialEntries: [path] },
        createElement(
          ZoomProvider,
          null,
          createElement(
            EmbedThemeContext.Provider,
            { value: { mode: 'dark', id: 'dark', anchorRef: { current: null } } },
            createElement(WorkspacePage, { screensBaseUrl: BASE, config })
          )
        )
      )
    )
  );
}

function openKeys(): string[] {
  const raw = sessionStorage.getItem(tabsStorageKey('/'));
  return raw === null ? [] : ((JSON.parse(raw) as { keys: string[] }).keys ?? []);
}

const recentWrites = (server: Server) => server.writes.filter((body) => body.includes('recent'));

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
}

beforeEach(() => {
  resetHostEmbeddedForTests();
  clearStorage();
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

describe('host-embedded first open (a)', () => {
  it('opens the configured home without recording Recent', async () => {
    hostEmbed();
    const server = serve(MANIFEST);
    renderAt('/embed/', { ...CONFIG, home: { screen: HOME } });
    const probe = await screen.findByTestId('screen-probe');
    expect(probe.dataset.screen).toBe('library/sr/overview');
    await settle();
    expect(openKeys()).toEqual(['library/sr/overview']);
    expect(recentWrites(server)).toEqual([]);
  });

  it('without a resolvable home opens the first screen of the tree', async () => {
    hostEmbed();
    const server = serve(MANIFEST);
    renderAt('/embed/', { ...CONFIG, home: { screen: 'gone/away' } });
    const probe = await screen.findByTestId('screen-probe');
    // 'common' sorts before 'library'.
    expect(probe.dataset.screen).toBe('common/magnet');
    await settle();
    expect(openKeys()).toEqual(['common/magnet']);
    expect(recentWrites(server)).toEqual([]);
  });

  it('with no screens opens nothing, not even the data browser', async () => {
    hostEmbed();
    serve({ screens: [] });
    renderAt('/embed/', {
      ...CONFIG,
      home: { screen: HOME },
      trace: { path: 'trace/', query: '' },
    });
    await settle();
    expect(screen.queryByTestId('screen-probe')).toBeNull();
    expect(openKeys()).toEqual([]);
  });

  it('waits for a manifest that arrives after the mount, then opens the home once', async () => {
    hostEmbed();
    const server = serve(MANIFEST, true);
    renderAt('/embed/', { ...CONFIG, home: { screen: HOME } });
    await settle();
    expect(screen.queryByTestId('screen-probe')).toBeNull();
    expect(openKeys()).toEqual([]);
    await act(async () => server.release());
    const probe = await screen.findByTestId('screen-probe');
    expect(probe.dataset.screen).toBe('library/sr/overview');
    await settle();
    expect(openKeys()).toEqual(['library/sr/overview']);
    expect(recentWrites(server)).toEqual([]);
  });
});

describe('host-embedded, everything else unchanged', () => {
  it('(b) a stored workspace restores and gets no home', async () => {
    hostEmbed();
    serve(MANIFEST);
    sessionStorage.setItem(
      tabsStorageKey('/'),
      JSON.stringify({ keys: ['library/bts/knob'], active: 'library/bts/knob' })
    );
    renderAt('/embed/', { ...CONFIG, home: { screen: HOME } });
    const probe = await screen.findByTestId('screen-probe');
    expect(probe.dataset.screen).toBe('library/bts/knob');
    await settle();
    expect(openKeys()).toEqual(['library/bts/knob']);
  });

  it('(c) a session whose tabs were all closed stays empty', async () => {
    hostEmbed();
    serve(MANIFEST);
    sessionStorage.setItem(tabsStorageKey('/'), JSON.stringify({ keys: [], active: null }));
    renderAt('/embed/', { ...CONFIG, home: { screen: HOME } });
    await settle();
    expect(screen.queryByTestId('screen-probe')).toBeNull();
    expect(openKeys()).toEqual([]);
  });

  it('(c) closing the home tab leaves an empty strip; a later manifest does not re-add it', async () => {
    hostEmbed();
    serve(MANIFEST);
    renderAt('/embed/', { ...CONFIG, home: { screen: HOME } });
    await screen.findByTestId('screen-probe');
    await settle();
    fireEvent.click(await screen.findByRole('button', { name: /^Close / }));
    await waitFor(() => expect(openKeys()).toEqual([]));
    // A manifest re-fetch (window focus) must not run the first open again.
    serve({ screens: [...MANIFEST.screens, entry('aaa', 'new', 'New')] });
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await settle();
    expect(openKeys()).toEqual([]);
    expect(screen.queryByTestId('screen-probe')).toBeNull();
  });

  it('(d) a URL-named tab opens only what it names', async () => {
    hostEmbed();
    serve(MANIFEST);
    renderAt('/embed/common/magnet', { ...CONFIG, home: { screen: HOME } });
    const probe = await screen.findByTestId('screen-probe');
    expect(probe.dataset.screen).toBe('common/magnet');
    await settle();
    expect(openKeys()).toEqual(['common/magnet']);
  });
});

describe('standalone first visit', () => {
  it('keeps the per-session data browser and never opens the home', async () => {
    serve(MANIFEST);
    renderAt('/embed/', {
      ...CONFIG,
      home: { screen: HOME },
      trace: { path: 'trace/', query: '' },
    });
    await settle();
    expect(openKeys()).toEqual([TRACE_KEY]);
    expect(screen.queryByTestId('screen-probe')).toBeNull();
  });

  it('without the data browser configured opens nothing', async () => {
    serve(MANIFEST);
    renderAt('/embed/', { ...CONFIG, home: { screen: HOME } });
    await settle();
    expect(openKeys()).toEqual([]);
  });
});
