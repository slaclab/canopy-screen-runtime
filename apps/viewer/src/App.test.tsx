// Viewer acceptance: the route table (/ and /embed/<category> redirect to the
// workspace, @trace needs config.trace, every workspace URL write replaces),
// deep-link rendering of the real vacuum-system screen with mock PV data and
// query macros, the explicit schemaVersion error page, and the workspace on
// the embed route (screen tree, tabs, the focused screen's tile bar, widget
// actions under a router basename).

import { createElement, useEffect } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate, useNavigationType } from 'react-router-dom';
import { LocalPVService, MockPVService } from '@slaclab/canopy-client';
import { getMode, setMode, subscribe } from '@slaclab/canopy-screen-runtime';
import { __setWidgetRenderProbe } from '@slaclab/canopy-screen-runtime/testing';
import { registerBuiltinWidgets } from '@slaclab/canopy-screen-widgets';
import { App } from './App.js';
import { WorkspacePage } from './workspace/WorkspacePage.js';
import { ZoomProvider } from './ZoomContext.js';
import { ServicesContext } from './services.js';
import type { ViewerServices } from './services.js';

import vacuumScreen from './test/vacuum-system.screen.json' with { type: 'json' };

// Node >= 25 ships an experimental global `localStorage` that is undefined
// unless --localstorage-file is given, and it shadows jsdom's. canopy-shell's
// themeStore reads localStorage at import time, so install an in-memory one
// before the imports above are evaluated (vi.hoisted runs first).
vi.hoisted(() => {
  let usable = false;
  try {
    usable = typeof globalThis.localStorage?.getItem === 'function';
  } catch {
    // Reading the Node global can throw; treat that as unusable.
  }
  if (usable) return;
  const store = new Map<string, string>();
  const memory = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, String(value)),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  };
  for (const target of [globalThis, globalThis.window]) {
    if (target)
      Object.defineProperty(target, 'localStorage', { configurable: true, value: memory });
  }
});

const MANIFEST = {
  screens: [
    {
      id: 'vacuum-system',
      kind: 'ir',
      title: 'Vacuum System',
      category: 'examples',
      path: 'screens/examples/vacuum-system.screen.json',
      macros: [
        { name: 'PREFIX', default: 'DEMO:VAC1' },
        { name: 'DEVICE', default: 'Q1' },
      ],
      tags: [],
      schemaVersion: '1.0',
    },
    {
      id: 'pump-panel',
      kind: 'wrapper',
      title: 'Pump Panel (code)',
      category: 'cryo',
      path: 'screens/cryo/pump-panel',
    },
    {
      // A nested id (slash) — must be reachable under the /s/:category/* splat.
      id: 'CBXFEL/Landing',
      kind: 'ir',
      title: 'CBXFEL Landing',
      category: 'examples',
      path: 'screens/examples/CBXFEL/Landing.screen.json',
      macros: [],
      tags: [],
      schemaVersion: '1.0',
    },
  ],
};

const MOTOR_SCREEN = {
  schemaVersion: '1.0',
  kind: 'template',
  id: 'motor-control',
  metadata: {
    title: 'Motor',
    source: { type: 'hand-authored' },
    size: { width: 400, height: 200 },
  },
  macros: [{ name: 'MOTOR' }],
  root: {
    id: 'm-root',
    type: 'text-label',
    props: { text: 'Motor ${MOTOR}' },
    geometry: { x: 0, y: 0, width: 200, height: 20 },
  },
};

/** URL-suffix-matched fetch stub. */
function stubFetch(routes: Record<string, unknown>) {
  const impl = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    for (const [suffix, data] of Object.entries(routes)) {
      if (url.endsWith(suffix)) return new Response(JSON.stringify(data), { status: 200 });
    }
    return new Response('{}', { status: 404, statusText: 'Not Found' });
  });
  vi.stubGlobal('fetch', impl);
  return impl;
}

let services: ViewerServices;

beforeAll(() => {
  registerBuiltinWidgets();
});

beforeEach(() => {
  const pv = new MockPVService();
  pv.connect();
  const locals = new LocalPVService();
  locals.connect();
  // One shared scope: these tests open one screen at a time.
  services = { pv, formulas: null, locals, screenScope: () => ({ pv, formulas: null, locals }) };
});

afterEach(() => {
  cleanup();
  services.pv.disconnect();
  vi.unstubAllGlobals();
  // Zoom state and the sub-screen choice persist by design; not across tests.
  for (const store of [globalThis.sessionStorage, globalThis.localStorage]) {
    try {
      store?.clear();
    } catch {
      // Unusable storage: nothing persisted.
    }
  }
});

function renderAt(path: string) {
  return render(
    <ServicesContext.Provider value={services}>
      <MemoryRouter initialEntries={[path]}>
        <App screensBaseUrl={window.location.origin} />
      </MemoryRouter>
    </ServicesContext.Provider>
  );
}

/** The router's navigate, for a test to change the URL after mount. */
let navigateTo: ((to: string) => void) | null = null;

/** Shows the router location and the last navigation's type (POP/PUSH/REPLACE). */
function LocationProbe() {
  const location = useLocation();
  const type = useNavigationType();
  const navigate = useNavigate();
  useEffect(() => {
    navigateTo = (to: string) => void navigate(to);
  }, [navigate]);
  return createElement(
    'output',
    { 'data-testid': 'location', 'data-type': type },
    location.pathname + location.search
  );
}

const here = () => screen.getByTestId('location').textContent;
const navType = () => screen.getByTestId('location').dataset.type;

/** App plus a LocationProbe, optionally with a viewer config. */
type ToolEntryConfig = { path: string; query: string };

function renderWithLocation(
  path: string,
  config?: { trace?: ToolEntryConfig; correlation?: ToolEntryConfig }
) {
  return render(
    <ServicesContext.Provider value={services}>
      <MemoryRouter initialEntries={[path]}>
        <App screensBaseUrl={window.location.origin} config={config} />
        <LocationProbe />
      </MemoryRouter>
    </ServicesContext.Provider>
  );
}

/**
 * The page's alerts outside the dock: dockview keeps an always-present
 * assertive live region (role alert) inside the dock root.
 */
const pageAlerts = () =>
  screen.queryAllByRole('alert').filter((el) => !el.closest('[data-testid="workspace-dock"]'));

/** Waits for exactly one alert outside the dock. */
const findPageAlert = () =>
  waitFor(() => {
    const alerts = pageAlerts();
    expect(alerts).toHaveLength(1);
    return alerts[0]!;
  });

/** The open tabs' titles, in strip order. */
const tabTitles = () =>
  screen.queryAllByRole('tab').map((tab) => tab.querySelector('.tab-strip__title')!.textContent);

describe('workspace routes', () => {
  it('redirects / to /embed/, keeping the query, with REPLACE', async () => {
    stubFetch({ '/manifest.json': MANIFEST });
    renderWithLocation('/?theme=light');
    expect(await screen.findByTestId('workspace')).toBeTruthy();
    // The redirect carried ?theme=light into the embed layout, which latches
    // it at mount; the workspace then rewrites its own URL (no tab: /embed/)
    // without the reserved parameters, also with REPLACE.
    expect(document.documentElement.dataset.theme).toBe('light');
    await waitFor(() => expect(here()).toBe('/embed/'));
    expect(navType()).toBe('REPLACE');
    expect(await screen.findByText('Vacuum System')).toBeTruthy();
    expect(screen.queryByText('Page not found')).toBeNull();
  });

  it('keeps the whole query on the / redirect (chrome off writes no URL)', async () => {
    stubFetch({ '/manifest.json': MANIFEST });
    renderWithLocation('/?_canopyChrome=0&theme=light&X=1');
    expect(await screen.findByTestId('workspace')).toBeTruthy();
    expect(here()).toBe('/embed/?_canopyChrome=0&theme=light&X=1');
    expect(navType()).toBe('REPLACE');
  });

  it('redirects /embed/<category> alone to /embed/, every category expanded', async () => {
    stubFetch({ '/manifest.json': MANIFEST });
    renderWithLocation('/embed/cryo');
    await waitFor(() => expect(here()).toBe('/embed/'));
    expect(navType()).toBe('REPLACE');
    // The named category and the others are all listed in the tree.
    expect(await screen.findByText('Pump Panel (code)')).toBeTruthy();
    expect(screen.getByText('Vacuum System')).toBeTruthy();
    expect(screen.getByTestId('workspace-empty')).toBeTruthy();
    expect(screen.queryByText('Page not found')).toBeNull();
  });

  it('drops /embed/@trace when the config has no trace', async () => {
    stubFetch({ '/manifest.json': MANIFEST });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    renderWithLocation('/embed/@trace');
    await screen.findByText('Vacuum System');
    await waitFor(() => expect(here()).toBe('/embed/'));
    expect(navType()).toBe('REPLACE');
    expect(tabTitles()).toEqual([]);
    expect(screen.getByTestId('workspace-empty')).toBeTruthy();
    // No data browser entry in the tree and no Trace iframe.
    expect(document.querySelector('[data-screen-key="@trace"]')).toBeNull();
    expect(screen.queryByText('Tools')).toBeNull();
    expect(document.querySelector('iframe')).toBeNull();
    warn.mockRestore();
  });

  it('opens /embed/@trace as the data browser tab when the config has a trace', async () => {
    stubFetch({ '/manifest.json': MANIFEST });
    renderWithLocation('/embed/@trace', { trace: { path: 'trace/', query: 'pv=A&range=-1h' } });
    await screen.findByText('Vacuum System');
    expect(here()).toBe('/embed/@trace');
    expect(tabTitles()).toEqual(['Data Browser']);
  });

  it('opens /embed/@correlation as correlation instance 1 when the config has one', async () => {
    stubFetch({ '/manifest.json': MANIFEST });
    renderWithLocation('/embed/@correlation', {
      correlation: { path: 'trace/correlation.html', query: 'n=500' },
    });
    await screen.findByText('Vacuum System');
    expect(here()).toBe('/embed/@correlation');
    expect(tabTitles()).toEqual(['Correlation']);
    const frame = document.querySelector<HTMLIFrameElement>('iframe[data-tab-key="@correlation"]')!;
    expect(frame.src).toContain('trace/correlation.html?n=500&');
    expect(frame.classList.contains('workspace-trace')).toBe(false);
  });

  it('warns once and restores the URL for /embed/@correlation without correlation', async () => {
    stubFetch({ '/manifest.json': MANIFEST });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    renderWithLocation('/embed/@correlation', { trace: { path: 'trace/', query: '' } });
    await screen.findByText('Vacuum System');
    // A first visit opens the data browser; the URL names it, not the refused tool.
    await waitFor(() => expect(here()).toBe('/embed/@trace'));
    expect(warn.mock.calls.filter(([m]) => String(m).includes('Correlation'))).toHaveLength(1);
    expect(tabTitles()).toEqual(['Data Browser']);

    // After mount: open a screen, then the unconfigured tool's URL.
    act(() => navigateTo!('/embed/examples/vacuum-system'));
    await waitFor(() => expect(tabTitles()).toEqual(['Data Browser', 'Vacuum System']));
    act(() => navigateTo!('/embed/@correlation'));
    await waitFor(() => expect(here()).toBe('/embed/examples/vacuum-system'));
    expect(warn.mock.calls.filter(([m]) => String(m).includes('Correlation'))).toHaveLength(2);
    expect(tabTitles()).toEqual(['Data Browser', 'Vacuum System']);
    warn.mockRestore();
  });

  it('redirects /embed/<category> after mount too, also with no tab open', async () => {
    stubFetch({ '/manifest.json': MANIFEST });
    renderWithLocation('/embed/');
    await screen.findByText('Vacuum System');
    await waitFor(() => expect(here()).toBe('/embed/'));
    act(() => navigateTo!('/embed/SR'));
    await waitFor(() => expect(here()).toBe('/embed/'));
    act(() => navigateTo!('/embed/examples/vacuum-system'));
    await waitFor(() => expect(tabTitles()).toEqual(['Vacuum System']));
    act(() => navigateTo!('/embed/cryo'));
    await waitFor(() => expect(here()).toBe('/embed/examples/vacuum-system'));
    expect(navType()).toBe('REPLACE');
  });

  it('shows the workspace, never a blank page, when the manifest cannot load', async () => {
    stubFetch({});
    renderAt('/');
    expect(await screen.findByText('No screens to show.')).toBeTruthy();
    expect(screen.getByTestId('workspace-empty')).toBeTruthy();
    expect(screen.queryByText('Page not found')).toBeNull();
  });

  it('every workspace navigation is a REPLACE', async () => {
    stubFetch({
      '/manifest.json': MANIFEST,
      '/screens/examples/vacuum-system.screen.json': vacuumScreen,
      '/screens/examples/motor-control.screen.json': MOTOR_SCREEN,
      '/screens/examples/CBXFEL/Landing.screen.json': {
        ...MOTOR_SCREEN,
        kind: 'screen',
        id: 'CBXFEL/Landing',
        metadata: { ...MOTOR_SCREEN.metadata, title: 'CBXFEL Landing' },
      },
    });
    vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {});
    renderWithLocation('/embed/');
    await waitFor(() => expect(here()).toBe('/embed/'));
    const seen: string[] = [];
    const expectReplace = async (url: string) => {
      await waitFor(() => expect(here()).toBe(url));
      seen.push(`${navType()} ${url}`);
    };

    // Left-click opens in the active tab.
    fireEvent.click(await screen.findByText('Vacuum System'));
    await expectReplace('/embed/examples/vacuum-system');

    // Right-click -> Open in new tab appends and focuses.
    fireEvent.contextMenu(screen.getAllByText('CBXFEL Landing')[0]!);
    fireEvent.click(screen.getByText('Open in new tab'));
    await expectReplace('/embed/examples/CBXFEL/Landing');
    expect(tabTitles()).toEqual(['Vacuum System', 'CBXFEL Landing']);

    // Focusing a tab.
    fireEvent.click(screen.getAllByRole('tab')[0]!);
    await expectReplace('/embed/examples/vacuum-system');

    // Closing the active tab focuses the remaining one.
    fireEvent.click(screen.getByRole('button', { name: 'Close Vacuum System' }));
    await expectReplace('/embed/examples/CBXFEL/Landing');

    // Closing the last tab returns to the root.
    fireEvent.click(screen.getByRole('button', { name: 'Close CBXFEL Landing' }));
    await expectReplace('/embed/');

    expect(seen).toEqual([
      'REPLACE /embed/examples/vacuum-system',
      'REPLACE /embed/examples/CBXFEL/Landing',
      'REPLACE /embed/examples/vacuum-system',
      'REPLACE /embed/examples/CBXFEL/Landing',
      'REPLACE /embed/',
    ]);
    vi.restoreAllMocks();
  });
});

describe('screen page (deep link)', () => {
  it('renders the vacuum screen with mock data, query macros, and embedded display', async () => {
    stubFetch({
      '/manifest.json': MANIFEST,
      '/screens/examples/vacuum-system.screen.json': vacuumScreen,
      '/screens/examples/motor-control.screen.json': MOTOR_SCREEN,
    });

    renderAt('/s/examples/vacuum-system?PREFIX=XX00:9');

    // AppHeader title comes from the screen metadata.
    expect(await screen.findByText('Vacuum System')).toBeTruthy();
    // The screen canvas rendered.
    const root = await screen.findByTestId('screen-root');
    expect(root.dataset.screenId).toBe('vacuum-system');
    // The embedded display resolved relative to the screen document and its
    // node macros were substituted with the ?PREFIX= query macro.
    expect(await screen.findByText('Motor XX00:9:M1')).toBeTruthy();
    // No widget crashed.
    expect(root.querySelectorAll('[data-testid="widget-error"]')).toHaveLength(0);
  });

  it('shows the explicit schema-mismatch error page (never blank)', async () => {
    stubFetch({
      '/manifest.json': MANIFEST,
      '/screens/examples/vacuum-system.screen.json': { ...vacuumScreen, schemaVersion: '9.9' },
    });

    renderAt('/s/examples/vacuum-system');

    expect(await screen.findByText('Schema version mismatch')).toBeTruthy();
    expect(screen.getByText(/declares schemaVersion 9\.9/)).toBeTruthy();
  });

  it('shows an explicit error for unknown screens', async () => {
    stubFetch({ '/manifest.json': MANIFEST });
    renderAt('/s/examples/nope');
    expect(await screen.findByText("No screen 'examples/nope' in the manifest")).toBeTruthy();
  });

  it('opens a nested screen id (slash) via the splat route', async () => {
    const NESTED = {
      ...MOTOR_SCREEN,
      kind: 'screen',
      id: 'CBXFEL/Landing',
      metadata: { ...MOTOR_SCREEN.metadata, title: 'CBXFEL Landing' },
    };
    stubFetch({
      '/manifest.json': MANIFEST,
      '/screens/examples/CBXFEL/Landing.screen.json': NESTED,
    });
    renderAt('/s/examples/CBXFEL/Landing');
    // Resolves (not the "Page not found" splat-miss) — header shows the title.
    expect(await screen.findByText('CBXFEL Landing')).toBeTruthy();
    expect(screen.queryByText('Page not found')).toBeNull();
  });

  it('explains code screens instead of rendering blank', async () => {
    stubFetch({ '/manifest.json': MANIFEST });
    renderAt('/s/cryo/pump-panel');
    expect(await screen.findByText(/is a wrapper screen/)).toBeTruthy();
  });
});

describe('embed page (/embed/:category/*)', () => {
  type Message = { type: string; width?: number; height?: number };

  /** Records every message the embed posts to window.parent. */
  function spyParent() {
    const posted: Message[] = [];
    vi.spyOn(window.parent, 'postMessage').mockImplementation((msg: unknown) => {
      posted.push(msg as Message);
    });
    return posted;
  }

  /** A ResizeObserver stand-in whose callback the test fires by hand. */
  function stubResizeObserver() {
    const observers: { callback: ResizeObserverCallback; targets: Element[] }[] = [];
    class FakeResizeObserver {
      private readonly entry: { callback: ResizeObserverCallback; targets: Element[] };
      constructor(callback: ResizeObserverCallback) {
        this.entry = { callback, targets: [] };
        observers.push(this.entry);
      }
      observe(target: Element) {
        this.entry.targets.push(target);
      }
      unobserve() {}
      disconnect() {
        this.entry.targets = [];
      }
    }
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    return observers;
  }

  function stubVacuum() {
    stubFetch({
      '/manifest.json': MANIFEST,
      '/screens/examples/vacuum-system.screen.json': vacuumScreen,
      '/screens/examples/motor-control.screen.json': MOTOR_SCREEN,
    });
  }

  function renderEmbed(path: string, themes: Record<string, 'light' | 'dark'> = {}) {
    return render(
      <ServicesContext.Provider value={services}>
        <MemoryRouter initialEntries={[path]}>
          <App screensBaseUrl={window.location.origin} themes={themes} />
        </MemoryRouter>
      </ServicesContext.Provider>
    );
  }

  afterEach(() => {
    vi.restoreAllMocks();
    delete document.documentElement.dataset.theme;
  });

  it('renders the screen under the screen header, without the /s/ back link', async () => {
    stubResizeObserver();
    spyParent();
    stubVacuum();
    const { container } = renderEmbed('/embed/examples/vacuum-system?PREFIX=XX00:9');

    const root = await screen.findByTestId('screen-root');
    expect(root.dataset.screenId).toBe('vacuum-system');
    expect(await screen.findByText('Motor XX00:9:M1')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'All screens' })).toBeNull();
    expect(container.querySelectorAll('header')).toHaveLength(1);
    expect(screen.getByTestId('screen-header').textContent).toContain('SCREEN');
    expect(screen.queryByText('Page not found')).toBeNull();
  });

  it('keeps the chrome on /s/:category/*', async () => {
    stubVacuum();
    const { container } = renderAt('/s/examples/vacuum-system');
    await screen.findByTestId('screen-root');
    expect(screen.getByText('All screens')).toBeTruthy();
    expect(container.querySelector('header')).not.toBeNull();
  });

  it('defaults to dark: Carbon g100 and html[data-theme=dark]', async () => {
    stubResizeObserver();
    spyParent();
    stubVacuum();
    const { container } = renderEmbed('/embed/examples/vacuum-system');
    await screen.findByTestId('screen-root');
    expect(container.querySelector('.cds--g100')).not.toBeNull();
    expect(container.querySelector('.cds--white')).toBeNull();
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('?theme=light selects Carbon white and html[data-theme=light]', async () => {
    stubResizeObserver();
    spyParent();
    stubVacuum();
    const { container } = renderEmbed('/embed/examples/vacuum-system?theme=light');
    await screen.findByTestId('screen-root');
    expect(container.querySelector('.cds--white')).not.toBeNull();
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('resolves a host theme id through config.themes', async () => {
    stubResizeObserver();
    spyParent();
    stubVacuum();
    const { container } = renderEmbed('/embed/examples/vacuum-system?theme=host-paper', {
      'host-paper': 'light',
    });
    await screen.findByTestId('screen-root');
    expect(container.querySelector('.cds--white')).not.toBeNull();
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('follows canopy:theme messages from the parent', async () => {
    stubResizeObserver();
    spyParent();
    stubVacuum();
    const { container } = renderEmbed('/embed/examples/vacuum-system?theme=light', {
      'host-night': 'dark',
    });
    await screen.findByTestId('screen-root');
    expect(document.documentElement.dataset.theme).toBe('light');

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'canopy:theme', theme: 'host-night' },
          source: window.parent,
          origin: window.location.origin,
        })
      );
    });
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(container.querySelector('.cds--g100')).not.toBeNull();

    // Unrelated messages are ignored.
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', { data: { type: 'something-else', theme: 'light' } })
      );
    });
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('never persists the embed theme to localStorage', async () => {
    stubResizeObserver();
    spyParent();
    stubVacuum();
    window.localStorage.removeItem('canopy.theme');
    renderEmbed('/embed/examples/vacuum-system?theme=light');
    await screen.findByTestId('screen-root');
    // canopy-shell's setColorMode would have written its storage key.
    expect(window.localStorage.getItem('canopy.theme')).toBeNull();
    expect(window.localStorage.length).toBe(0);
  });

  describe('open_display from an embedded screen under a basename', () => {
    const entry = (id: string) => ({
      id,
      kind: 'ir',
      title: `Draft ${id}`,
      category: 'drafts',
      path: `screens/drafts/${id}.screen.json`,
      macros: [],
      tags: [],
      schemaVersion: '1.0',
    });

    function draft(id: string, actions: unknown[]) {
      return {
        schemaVersion: '1.0',
        kind: 'screen',
        id,
        metadata: {
          title: `Draft ${id}`,
          source: { type: 'hand-authored' },
          size: { width: 400, height: 200 },
        },
        macros: [],
        root: {
          id: `${id}-root`,
          type: 'absolute-canvas',
          props: {},
          geometry: { x: 0, y: 0, width: 400, height: 200 },
          children: [
            {
              id: `${id}-label`,
              type: 'text-label',
              props: { text: `Screen ${id}` },
              geometry: { x: 0, y: 0, width: 100, height: 20 },
            },
            {
              id: `${id}-go`,
              type: 'regular-button',
              props: { label: 'Go', actions },
              geometry: { x: 0, y: 40, width: 100, height: 30 },
            },
          ],
        },
      };
    }

    function stubDrafts(actions: unknown[], ids = ['a', 'b']) {
      const routes: Record<string, unknown> = {
        '/manifest.json': { screens: ids.map(entry) },
        '/screens/drafts/a.screen.json': draft('a', actions),
        '/screens/drafts/b.screen.json': draft('b', []),
      };
      stubFetch(routes);
      return routes;
    }

    function renderUnderBasename(path: string) {
      return render(
        <ServicesContext.Provider value={services}>
          <MemoryRouter basename="/x/y" initialEntries={[`/x/y${path}`]}>
            <App screensBaseUrl={`${window.location.origin}/x/y`} />
          </MemoryRouter>
        </ServicesContext.Provider>
      );
    }

    beforeEach(() => {
      stubResizeObserver();
      spyParent();
    });

    it('same-tab lands on /embed/drafts/b with no double prefix', async () => {
      stubDrafts([{ type: 'open_display', file: 'b.screen.json', target: 'replace' }]);
      renderUnderBasename('/embed/drafts/a');
      await screen.findByText('Screen a');
      fireEvent.click(screen.getByRole('button', { name: 'Go' }));
      // Screen b renders on the embed route: no AppHeader, no 404 from a
      // doubled /x/y/x/y prefix.
      expect(await screen.findByText('Screen b')).toBeTruthy();
      expect(screen.queryByText('Page not found')).toBeNull();
      expect(screen.queryByRole('link', { name: 'All screens' })).toBeNull();
    });

    it('target tab appends a workspace tab for drafts/b, opening no window', async () => {
      const open = vi.fn(() => null);
      vi.stubGlobal('open', open);
      stubDrafts([
        { type: 'open_display', file: 'b.screen.json', target: 'tab', macros: { M: '1' } },
      ]);
      render(
        <ServicesContext.Provider value={services}>
          <MemoryRouter basename="/x/y" initialEntries={['/x/y/embed/drafts/a']}>
            <App screensBaseUrl={`${window.location.origin}/x/y`} />
            <LocationProbe />
          </MemoryRouter>
        </ServicesContext.Provider>
      );
      await screen.findByText('Screen a');
      fireEvent.click(screen.getByRole('button', { name: 'Go' }));
      expect(await screen.findByText('Screen b')).toBeTruthy();
      // Router-relative under the basename: no doubled /x/y prefix.
      await waitFor(() => expect(here()).toBe('/embed/drafts/b?M=1'));
      expect(navType()).toBe('REPLACE');
      expect(tabTitles()).toEqual(['Draft a', 'Draft b']);
      expect(screen.getAllByRole('tab')[1]!.getAttribute('aria-selected')).toBe('true');
      expect(open).not.toHaveBeenCalled();
    });

    it('a miss refetches the manifest, so a screen published since then opens', async () => {
      const routes = stubDrafts(
        [{ type: 'open_display', file: 'b.screen.json', target: 'replace' }],
        ['a']
      );
      renderUnderBasename('/embed/drafts/a');
      await screen.findByText('Screen a');

      fireEvent.click(screen.getByRole('button', { name: 'Go' }));
      expect((await findPageAlert()).textContent).toContain('No screen for b.screen.json');
      const fetch = vi.mocked(globalThis.fetch);
      expect(
        fetch.mock.calls.some(
          ([url, init]) =>
            String(url).endsWith('/manifest.json') &&
            (init as RequestInit | undefined)?.cache === 'no-cache'
        )
      ).toBe(true);

      routes['/manifest.json'] = { screens: ['a', 'b'].map(entry) };
      fireEvent.click(screen.getByRole('button', { name: 'Go' }));
      // The workspace learns of b on its own 3 s manifest poll before it
      // loads the screen, so this can take longer than findBy's 1 s default.
      expect(await screen.findByText('Screen b', undefined, { timeout: 8000 })).toBeTruthy();
      expect(pageAlerts()).toHaveLength(0);
    });

    it('open_webpage with a javascript: URL shows an error and opens nothing', async () => {
      const open = vi.fn(() => null);
      vi.stubGlobal('open', open);
      stubDrafts([{ type: 'open_webpage', url: 'javascript:alert(1)' }]);
      renderUnderBasename('/embed/drafts/a');
      await screen.findByText('Screen a');
      fireEvent.click(screen.getByRole('button', { name: 'Go' }));
      expect((await findPageAlert()).textContent).toContain('javascript:alert(1)');
      expect(open).not.toHaveBeenCalled();
    });

    it('renders the error surfaces inside the resolved Carbon zone', async () => {
      // Neither surface sits inside a page's own <Theme>, and the contract
      // variables .viewer-error reads exist only inside a Carbon zone.
      try {
        act(() => setMode('light'));
        const notFound = renderAt('/nope');
        const panel = await screen.findByRole('alert');
        expect(panel.textContent).toContain('Page not found');
        expect(panel.closest('.cds--white')).not.toBeNull();
        expect(panel.closest('.cds--g100')).toBeNull();
        act(() => setMode('dark'));
        expect(screen.getByRole('alert').closest('.cds--g100')).not.toBeNull();
        expect(screen.getByRole('alert').closest('.cds--white')).toBeNull();
        // The zone reads the store and never writes it.
        expect(getMode()).toBe('dark');
        notFound.unmount();

        // The embed page resolves dark here and writes it to the store.
        stubDrafts([{ type: 'open_webpage', url: 'javascript:alert(1)' }]);
        const dark = renderUnderBasename('/embed/drafts/a');
        await screen.findByText('Screen a');
        fireEvent.click(screen.getByRole('button', { name: 'Go' }));
        const overlay = (await findPageAlert()).closest('.viewer-action-error');
        expect(overlay).not.toBeNull();
        expect(getMode()).toBe('dark');
        expect(overlay!.closest('.cds--g100')).not.toBeNull();
        expect(overlay!.closest('.cds--white')).toBeNull();
        dark.unmount();

        // A light embed: the overlay follows it, and the embed stays light.
        renderUnderBasename('/embed/drafts/a?theme=light');
        await screen.findByText('Screen a');
        fireEvent.click(screen.getByRole('button', { name: 'Go' }));
        const light = (await findPageAlert()).closest('.viewer-action-error');
        expect(light).not.toBeNull();
        expect(getMode()).toBe('light');
        expect(light!.closest('.cds--white')).not.toBeNull();
        expect(light!.closest('.cds--g100')).toBeNull();
      } finally {
        setMode('light');
      }
    });
  });

  it('restores html[data-theme] when the embed unmounts', async () => {
    stubResizeObserver();
    spyParent();
    stubVacuum();
    document.documentElement.dataset.theme = 'previous';
    const { unmount } = renderEmbed('/embed/examples/vacuum-system?theme=light');
    await screen.findByTestId('screen-root');
    expect(document.documentElement.dataset.theme).toBe('light');
    unmount();
    expect(document.documentElement.dataset.theme).toBe('previous');
  });
});

describe('embed toolbar and zoom', () => {
  const WIDE = {
    schemaVersion: '1.0',
    kind: 'screen',
    id: 'wide',
    metadata: {
      title: 'Wide Panel',
      source: { type: 'hand-authored' },
      size: { width: 400, height: 200 },
    },
    macros: [],
    root: {
      id: 'wide-root',
      type: 'absolute-canvas',
      props: {},
      geometry: { x: 0, y: 0, width: 400, height: 200 },
      children: [
        {
          id: 'wide-label',
          type: 'text-label',
          props: { text: 'Wide body' },
          geometry: { x: 0, y: 0, width: 100, height: 20 },
        },
      ],
    },
  };

  const entry = (id: string, title = id) => ({
    id,
    kind: 'ir',
    title,
    category: 'drafts',
    path: `screens/drafts/${id}.screen.json`,
  });

  function stubWide() {
    stubFetch({
      '/manifest.json': { screens: [entry('wide', 'Wide Panel'), entry('other', 'Other Panel')] },
      '/screens/drafts/wide.screen.json': WIDE,
      '/screens/drafts/other.screen.json': { ...WIDE, id: 'other' },
    });
  }

  /** Every element reports this client box (the scroll container is what is read). */
  function clientBox(width: number, height: number) {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(width);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(height);
  }

  function renderEmbedAt(path: string) {
    vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {});
    return render(
      <ServicesContext.Provider value={services}>
        <MemoryRouter initialEntries={[path]}>
          <App screensBaseUrl={window.location.origin} />
        </MemoryRouter>
      </ServicesContext.Provider>
    );
  }

  const percent = () => screen.getByTestId('zoom-percent').textContent;
  const scaled = (container: HTMLElement) =>
    container.querySelector<HTMLElement>('.viewer-zoom__scaled')!;
  const zoomBox = (container: HTMLElement) => container.querySelector<HTMLElement>('.viewer-zoom')!;

  afterEach(() => {
    vi.restoreAllMocks();
    delete document.documentElement.dataset.theme;
  });

  it('shows the screen header: label, screen title and id, zoom controls, actions', async () => {
    stubWide();
    const { container } = renderEmbedAt('/embed/drafts/wide');
    await screen.findByTestId('screen-root');

    // One tile has no bar; its tabs sit in the strip row and the
    // header in the row below it, above the dock.
    const header = await screen.findByTestId('screen-header');
    expect(header.closest('[data-testid="tile-bar"]')).toBeNull();
    expect(screen.queryAllByTestId('tile-bar')).toHaveLength(0);
    expect(header.closest('[data-testid="workspace-dock"]')).toBeNull();
    expect(header.closest('.workspace__main')).not.toBeNull();
    expect(screen.getByRole('tablist', { name: 'Open tabs' })).toBeTruthy();
    // The tree replaces the old list, so there is no back link.
    expect(screen.queryByRole('link', { name: 'All screens' })).toBeNull();
    expect(header.textContent).toContain('SCREEN');
    expect(header.textContent).toContain('Wide Panel');
    expect(header.textContent).toContain('drafts/wide');
    for (const name of ['Zoom out', 'Zoom in', 'Fit', 'Actual size']) {
      expect(screen.getByRole('button', { name })).toBeTruthy();
    }
    await waitFor(() =>
      expect(
        Array.from(header.querySelectorAll('[data-screen-action]')).map(
          (b) => (b as HTMLElement).dataset.screenAction
        )
      ).toEqual(['reload', 'download', 'export-png', 'print', 'copy-link'])
    );
    // One Carbon header row: the screen header itself.
    expect(container.querySelectorAll('header')).toHaveLength(1);
  });

  it('copy link copies the workspace URL that reopens the screen with its macros', async () => {
    stubWide();
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    renderEmbedAt('/embed/drafts/wide?SECTOR=3');
    await screen.findByTestId('screen-root');
    const button = await screen.findByRole('button', { name: 'Copy link' });
    await act(async () => {
      fireEvent.click(button);
    });
    expect(writeText).toHaveBeenCalledWith(
      new URL('/embed/drafts/wide?SECTOR=3', window.location.href).href
    );
    expect(screen.getByTestId('screen-action-status').textContent).toBe('Copied');
  });

  it('reload re-fetches the document past the HTTP cache and remounts the screen', async () => {
    stubWide();
    renderEmbedAt('/embed/drafts/wide');
    const first = await screen.findByTestId('screen-root');
    const fetchMock = vi.mocked(fetch);
    const fresh = () =>
      fetchMock.mock.calls.filter(
        ([url, init]) =>
          String(url).endsWith('/screens/drafts/wide.screen.json') &&
          (init as RequestInit | undefined)?.cache === 'no-cache'
      ).length;
    expect(fresh()).toBe(0);
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Reload screen' }));
    });
    await waitFor(() => expect(fresh()).toBe(1));
    // A new screen root: the renderer was remounted, its widgets resubscribed.
    await waitFor(() => expect(screen.getByTestId('screen-root')).not.toBe(first));
  });

  it('opens in fit mode: the whole panel scaled into the area', async () => {
    // 432 x 1032 client box - 2 x 16 px canvas padding = 400 x 1000 area.
    clientBox(232, 1032);
    stubWide();
    const { container } = renderEmbedAt('/embed/drafts/wide');
    await screen.findByTestId('screen-root');

    expect(percent()).toBe('50%');
    expect(screen.getByRole('button', { name: 'Fit' }).getAttribute('aria-pressed')).toBe('true');
    expect(scaled(container).style.transform).toBe('scale(0.5)');
    expect(scaled(container).style.width).toBe('400px');
    expect(zoomBox(container).style.width).toBe('200px');
    expect(zoomBox(container).style.height).toBe('100px');
    expect(container.querySelector('main')!.className).toContain('viewer-content--fit');
  });

  it('fit magnifies a panel smaller than the area to fill it; 1:1 stays authored size', async () => {
    // 1232 x 1032 client box - 2 x 16 px padding = 1200 x 1000 area; the
    // 400 x 200 panel may grow 3x in width and 5x in height: the width wins.
    clientBox(1232, 1032);
    stubWide();
    const { container } = renderEmbedAt('/embed/drafts/wide');
    await screen.findByTestId('screen-root');
    expect(percent()).toBe('300%');
    expect(scaled(container).style.transform).toBe('scale(3)');
    expect(zoomBox(container).style.width).toBe('1200px');
    expect(zoomBox(container).style.height).toBe('600px');

    fireEvent.click(screen.getByRole('button', { name: 'Actual size' }));
    expect(percent()).toBe('100%');
    expect(scaled(container).style.transform).toBe('scale(1)');
  });

  it('− / + step the ladder, 1:1 is 100%, Fit re-enters fit mode', async () => {
    clientBox(232, 1032); // fit = 50%
    stubWide();
    const { container } = renderEmbedAt('/embed/drafts/wide');
    await screen.findByTestId('screen-root');
    const fitButton = screen.getByRole('button', { name: 'Fit' });

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(percent()).toBe('67%');
    expect(fitButton.getAttribute('aria-pressed')).toBe('false');
    expect(container.querySelector('main')!.className).not.toContain('viewer-content--fit');

    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    expect(percent()).toBe('33%');

    fireEvent.click(screen.getByRole('button', { name: 'Actual size' }));
    expect(percent()).toBe('100%');
    expect(scaled(container).style.transform).toBe('scale(1)');
    expect(zoomBox(container).style.width).toBe('400px');

    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(percent()).toBe('110%');
    expect(zoomBox(container).style.width).toBe('440px');

    fireEvent.click(fitButton);
    expect(percent()).toBe('50%');
    expect(fitButton.getAttribute('aria-pressed')).toBe('true');
  });

  it('widgets stay clickable under a zoom transform', async () => {
    stubFetch({
      '/manifest.json': { screens: [entry('wide', 'Wide Panel'), entry('other', 'Other Panel')] },
      '/screens/drafts/wide.screen.json': {
        ...WIDE,
        root: {
          ...WIDE.root,
          children: [
            {
              id: 'go',
              type: 'regular-button',
              props: {
                label: 'Go',
                actions: [{ type: 'open_display', file: 'other.screen.json', target: 'replace' }],
              },
              geometry: { x: 0, y: 40, width: 100, height: 30 },
            },
          ],
        },
      },
      '/screens/drafts/other.screen.json': {
        ...WIDE,
        id: 'other',
        metadata: { ...WIDE.metadata, title: 'Other Panel' },
      },
    });
    clientBox(232, 1032);
    renderEmbedAt('/embed/drafts/wide');
    await screen.findByTestId('screen-root');
    expect(percent()).toBe('50%');
    fireEvent.click(screen.getByRole('button', { name: 'Go' }));
    expect(await screen.findByText('drafts/other')).toBeTruthy();
  });

  it('opens another screen at Fit, not at the zoom of the screen it replaces', async () => {
    stubWide();
    renderEmbedAt('/embed/drafts/wide');
    await screen.findByTestId('screen-root');
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(percent()).toBe('110%');

    // Open the other screen from the tree (it replaces the active tab).
    fireEvent.click(await screen.findByText('Other Panel'));
    expect(await screen.findByText('drafts/other')).toBeTruthy();
    await screen.findByTestId('screen-root');
    expect(screen.getByRole('button', { name: 'Fit' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('?_canopyZoom=100 opens at actual size, and is not a macro', async () => {
    clientBox(232, 1032); // fit would be 50%
    stubWide();
    renderEmbedAt('/embed/drafts/wide?_canopyZoom=100');
    await screen.findByTestId('screen-root');
    expect(percent()).toBe('100%');
  });

  it('/s/ has the screen header with the actions but no zoom controls', async () => {
    stubWide();
    const { container } = renderAt('/s/drafts/wide');
    await screen.findByTestId('screen-root');
    expect(container.querySelector('header')).not.toBeNull();
    expect(screen.getByText('All screens')).toBeTruthy();
    expect(screen.queryByTestId('zoom-percent')).toBeNull();
    expect(container.querySelector('.viewer-zoom')).toBeNull();
    await waitFor(() => expect(container.querySelectorAll('[data-screen-action]').length).toBe(5));
  });
});

describe('screen list: embed mode and sub-screens', () => {
  const entry = (id: string, category = 'drafts') => ({
    id,
    kind: 'ir',
    title: `Title ${id}`,
    category,
    path: `screens/${category}/${id}.screen.json`,
  });

  const LIST = {
    screens: [
      entry('bts/BTSView'),
      entry('bts/embedded/_tv'),
      entry('_sub'),
      entry('common/KnobPanel'),
      entry('vacuum', 'examples'),
    ],
  };

  function renderList(path: string) {
    stubFetch({ '/manifest.json': LIST });
    return render(
      <ServicesContext.Provider value={services}>
        <MemoryRouter initialEntries={[path]}>
          <App screensBaseUrl={window.location.origin} />
        </MemoryRouter>
      </ServicesContext.Provider>
    );
  }

  afterEach(() => {
    delete document.documentElement.dataset.theme;
  });

  it('/embed lists screens in the tree beside the dock; a leaf opens /embed/...', async () => {
    const { container } = renderList('/embed');
    expect(await screen.findByText('Title bts/BTSView')).toBeTruthy();
    expect(screen.getByText('Title vacuum')).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Screens' })).toBeTruthy();
    // With no tab open there is no header, no tile bar and no action: the
    // empty-state text stands in their place.
    expect(screen.getByTestId('workspace-empty').textContent).toContain('No tab open.');
    expect(screen.queryByTestId('screen-header')).toBeNull();
    expect(container.querySelectorAll('[data-testid="tile-bar"]')).toHaveLength(0);
    expect(container.querySelectorAll('[data-screen-action]')).toHaveLength(0);
    // No back link anywhere: the tree is always there.
    expect(screen.queryByText('← All screens')).toBeNull();
    expect(container.querySelector('.viewer-embed')).not.toBeNull();
  });

  it('/embed/:category redirects to the root, listing every category', async () => {
    renderList('/embed/examples');
    expect(await screen.findByText('Title vacuum')).toBeTruthy();
    expect(screen.getByText('Title bts/BTSView')).toBeTruthy();
    expect(screen.queryByText('← All screens')).toBeNull();
    expect(screen.getByTestId('workspace-empty')).toBeTruthy();
  });

  it('hides sub-screens until "Show sub-screens" is ticked (/embed)', async () => {
    renderList('/embed');
    await screen.findByText('Title bts/BTSView');
    expect(screen.queryByText('Title bts/embedded/_tv')).toBeNull();
    expect(screen.queryByText('Title _sub')).toBeNull();

    const box = screen.getByLabelText('Show sub-screens (2)') as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    expect(box.checked).toBe(true);
    expect(screen.getByText('Title bts/embedded/_tv')).toBeTruthy();
    expect(screen.getByText('Title _sub')).toBeTruthy();

    fireEvent.click(box);
    expect(screen.queryByText('Title _sub')).toBeNull();
  });

  it('search filters only the visible set', async () => {
    renderList('/embed/');
    await screen.findByText('Title bts/BTSView');
    const input = screen.getByPlaceholderText('Filter by title or id');
    fireEvent.change(input, { target: { value: 'bts' } });
    expect(screen.getByText('Title bts/BTSView')).toBeTruthy();
    expect(screen.queryByText('Title bts/embedded/_tv')).toBeNull();

    fireEvent.click(screen.getByLabelText('Show sub-screens (2)'));
    expect(screen.getByText('Title bts/embedded/_tv')).toBeTruthy();
    expect(screen.queryByText('Title _sub')).toBeNull();
  });

  it('remembers the choice across page loads', async () => {
    const first = renderList('/embed/');
    await screen.findByText('Title bts/BTSView');
    fireEvent.click(screen.getByLabelText('Show sub-screens (2)'));
    first.unmount();

    renderList('/embed/');
    expect(await screen.findByText('Title _sub')).toBeTruthy();
    expect((screen.getByLabelText('Show sub-screens (2)') as HTMLInputElement).checked).toBe(true);
  });
});

describe('/s/ theme (the second mode-store writer)', () => {
  function stubVacuum() {
    stubFetch({
      '/manifest.json': MANIFEST,
      '/screens/examples/vacuum-system.screen.json': vacuumScreen,
      '/screens/examples/motor-control.screen.json': MOTOR_SCREEN,
    });
  }

  function renderS(path: string, themes: Record<string, 'light' | 'dark'> = {}) {
    return render(
      <ServicesContext.Provider value={services}>
        <MemoryRouter initialEntries={[path]}>
          <App screensBaseUrl={window.location.origin} themes={themes} />
        </MemoryRouter>
      </ServicesContext.Provider>
    );
  }

  function hostTheme(theme: string) {
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'canopy:theme', theme },
          source: window.parent,
          origin: window.location.origin,
        })
      );
    });
  }

  afterEach(() => {
    __setWidgetRenderProbe(null);
    setMode('light');
    delete document.documentElement.dataset.theme;
  });

  it("a bare /s/ URL renders light (today's look), whatever the store held", async () => {
    stubVacuum();
    setMode('dark');
    const { container } = renderS('/s/examples/vacuum-system');
    expect(getMode()).toBe('light');
    const root = await screen.findByTestId('screen-root');
    expect(root.dataset.theme).toBe('light');
    // The /s/ wrapper (the shell header may carry its own Carbon theme).
    const wrapper = container.querySelector<HTMLElement>('.viewer-embed');
    expect(wrapper?.classList.contains('cds--white')).toBe(true);
    expect(wrapper?.classList.contains('cds--g100')).toBe(false);
  });

  it('wraps the page in a full-height Carbon <Theme>', async () => {
    stubVacuum();
    const { container } = renderS('/s/examples/vacuum-system');
    await screen.findByTestId('screen-root');
    const wrapper = container.querySelector<HTMLElement>('.cds--white');
    expect(wrapper).not.toBeNull();
    expect(wrapper!.classList.contains('viewer-embed')).toBe(true);
    expect(wrapper!.querySelector('[data-testid="screen-root"]')).not.toBeNull();
  });

  it('?theme= resolves through config.themes and sets html[data-theme] to the mode', async () => {
    stubVacuum();
    document.documentElement.dataset.theme = 'light';
    const { container } = renderS('/s/examples/vacuum-system?theme=host-night', {
      'host-night': 'dark',
    });
    const root = await screen.findByTestId('screen-root');
    expect(root.dataset.theme).toBe('dark');
    expect(container.querySelector('.cds--g100.viewer-embed')).not.toBeNull();
    // The document carries the mode, never the theme id.
    expect(document.documentElement.dataset.theme).toBe('dark');
    // It persists nothing (canopy-shell's setColorMode would).
    expect(window.localStorage.getItem('canopy.theme')).toBeNull();
  });

  it('the /s/ wrapper is the host anchor and carries the theme id', async () => {
    stubVacuum();
    const { container } = renderS('/s/examples/vacuum-system?theme=desy-dark');
    await screen.findByTestId('screen-root');
    const anchor = container.querySelector<HTMLElement>('.viewer-embed')!;
    expect(anchor.hasAttribute('data-canopy-host-root')).toBe(true);
    expect(anchor.hasAttribute('data-floating-menu-container')).toBe(true);
    expect(anchor.getAttribute('data-theme')).toBe('desy-dark');
    expect(anchor.classList.contains('cds--g100')).toBe(true);

    // A host message renames the same element; the mode is unchanged.
    hostTheme('retro-dark');
    expect(container.querySelector('.viewer-embed')).toBe(anchor);
    expect(anchor.getAttribute('data-theme')).toBe('retro-dark');
    expect(getMode()).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('the /s/ anchor carries the mode without a well-formed theme id', async () => {
    stubVacuum();
    const { container } = renderS('/s/examples/vacuum-system');
    await screen.findByTestId('screen-root');
    const anchor = container.querySelector<HTMLElement>('.viewer-embed')!;
    expect(anchor.hasAttribute('data-canopy-host-root')).toBe(true);
    expect(anchor.getAttribute('data-theme')).toBe('light');
    hostTheme('Not A Theme');
    // Ill-formed: resolved as dark by its name, never written to the DOM.
    expect(anchor.getAttribute('data-theme')).toBe('dark');
  });

  it('a /s/ flip renders no widget, and Carbon follows it', async () => {
    stubVacuum();
    let renders = 0;
    __setWidgetRenderProbe(() => {
      renders += 1;
    });
    const { container } = renderS('/s/examples/vacuum-system', { 'host-night': 'dark' });
    const root = await screen.findByTestId('screen-root');
    expect(await screen.findByText('Motor DEMO:VAC1:M1')).toBeTruthy();
    // Positive control: the probe sees widgets render on mount.
    expect(renders).toBeGreaterThanOrEqual(1);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    renders = 0;
    hostTheme('host-night');
    expect(root.dataset.theme).toBe('dark');
    expect(container.querySelector('.cds--g100.viewer-embed')).not.toBeNull();
    hostTheme('light');
    expect(root.dataset.theme).toBe('light');
    expect(container.querySelector('.cds--white.viewer-embed')).not.toBeNull();

    expect(renders).toBe(0);
  });

  it('a workspace tab never writes the store, even with ?theme= in the URL', async () => {
    stubVacuum();
    setMode('dark');
    let writes = 0;
    const unsubscribe = subscribe(() => {
      writes += 1;
    });
    // WorkspacePage (and the ScreenPage of each tab) outside any writer.
    render(
      <ServicesContext.Provider value={services}>
        <MemoryRouter initialEntries={['/embed/examples/vacuum-system?theme=light']}>
          <ZoomProvider>
            <WorkspacePage screensBaseUrl={window.location.origin} />
          </ZoomProvider>
        </MemoryRouter>
      </ServicesContext.Provider>
    );
    const root = await screen.findByTestId('screen-root');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    unsubscribe();
    expect(writes).toBe(0);
    expect(getMode()).toBe('dark');
    expect(root.dataset.theme).toBe('dark');
  });
});
