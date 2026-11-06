// A theme flip must not re-render any widget of the screens the workspace
// keeps mounted. The flip arrives two ways: the EmbedThemeContext value the
// embed page provides (which WorkspacePage reads for the Trace tab) and the
// runtime's mode store. Neither may cascade into WidgetNodeView: the screen
// root applies the mode imperatively. Rendered with the real ScreenPage (no
// probe) so the runtime's widget render probe sees every WidgetNodeView.
//
// A flip between two host themes of one mode (desy-dark -> retro-dark) never
// touches the mode store: it changes only the theme id on the root element
// and in the context. It is driven through the real route table, on /embed
// and on /s/, and must render no widget either.

import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LocalPVService, MockPVService } from '@slaclab/canopy-client';
import { getMode, setMode } from '@slaclab/canopy-screen-runtime';
import { __setWidgetRenderProbe } from '@slaclab/canopy-screen-runtime/testing';
import { registerBuiltinWidgets } from '@slaclab/canopy-screen-widgets';
import { App } from '../App.js';
import type { ViewerConfig } from '../config.js';
import { EmbedThemeContext } from '../pages/EmbedPage.js';
import { ServicesContext } from '../services.js';
import type { ViewerServices } from '../services.js';
import { THEME_MESSAGE } from '../useThemeInput.js';
import { ZoomProvider } from '../ZoomContext.js';
import { dockStorageKey } from './dock/storage.js';
import { tabsStorageKey } from './tabs.js';
import { KEEP_MOUNTED } from './mountSet.js';
import { WorkspacePage } from './WorkspacePage.js';

// Node >= 25 ships a global `localStorage` that is undefined without
// --localstorage-file and shadows jsdom's; install an in-memory one before
// canopy-shell reads it at import time.
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

const IDS = ['alpha', 'beta', 'gamma'] as const;
const KEYS = IDS.map((id) => `examples/${id}`);

const MANIFEST = {
  screens: IDS.map((id) => ({
    id,
    kind: 'ir',
    title: `Screen ${id}`,
    category: 'examples',
    path: `screens/examples/${id}.screen.json`,
    macros: [],
    tags: [],
    schemaVersion: '1.1',
  })),
};

function doc(id: string) {
  return {
    schemaVersion: '1.1',
    kind: 'screen',
    id,
    metadata: {
      title: `Screen ${id}`,
      source: { type: 'hand-authored' },
      size: { width: 200, height: 60 },
    },
    macros: [],
    root: {
      id: 'root',
      type: 'group',
      props: {},
      geometry: { x: 0, y: 0, width: 200, height: 60 },
      children: [
        {
          id: `${id}-label`,
          type: 'text-label',
          props: { text: `label ${id}` },
          geometry: { x: 0, y: 0, width: 200, height: 20 },
        },
      ],
    },
  };
}

function stubFetch() {
  const routes: Record<string, unknown> = { '/manifest.json': MANIFEST };
  for (const id of IDS) routes[`/screens/examples/${id}.screen.json`] = doc(id);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input).split('?')[0]!;
      for (const [suffix, data] of Object.entries(routes)) {
        if (url.endsWith(suffix)) {
          return new Response(JSON.stringify(data), { status: 200 });
        }
      }
      return new Response('{}', { status: 404, statusText: 'Not Found' });
    })
  );
}

let services: ViewerServices;

beforeAll(() => {
  registerBuiltinWidgets();
});

beforeEach(() => {
  stubFetch();
  const pv = new MockPVService();
  pv.connect();
  const locals = new LocalPVService();
  locals.connect();
  services = { pv, formulas: null, locals, screenScope: () => ({ pv, formulas: null, locals }) };
  sessionStorage.setItem(tabsStorageKey('/'), JSON.stringify({ keys: KEYS, active: KEYS[0] }));
});

afterEach(() => {
  cleanup();
  __setWidgetRenderProbe(null);
  setMode('light');
  services.pv.disconnect();
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.theme;
  for (const store of [globalThis.sessionStorage, globalThis.localStorage]) {
    try {
      store?.clear();
    } catch {
      // Storage unavailable: nothing to clear.
    }
  }
});

function tree(mode: 'light' | 'dark', config?: Readonly<Partial<ViewerConfig>>): ReactNode {
  return (
    <ServicesContext.Provider value={services}>
      <MemoryRouter initialEntries={['/embed/']}>
        <ZoomProvider>
          <EmbedThemeContext.Provider value={{ mode, id: mode, anchorRef: { current: null } }}>
            <WorkspacePage screensBaseUrl={window.location.origin} config={config} />
          </EmbedThemeContext.Provider>
        </ZoomProvider>
      </MemoryRouter>
    </ServicesContext.Provider>
  );
}

/** The workspace strip's tabs (dockview's tile tabs sit in the dock beside it). */
function stripTabs(): HTMLElement[] {
  return within(screen.getByRole('tablist', { name: 'Open tabs' })).getAllByRole('tab');
}

/** The labels each mounted screen rendered, in strip order. */
function mountedLabels(): string[] {
  return [...document.querySelectorAll<HTMLElement>('.workspace__screen')].map((el) =>
    el.textContent?.includes('label ') ? (el.dataset.tabKey ?? '') : ''
  );
}

/** Shows every tab once so KEEP_MOUNTED screens are mounted, each rendered. */
async function mountAll() {
  const view = render(tree('dark'));
  await waitFor(() => expect(stripTabs()).toHaveLength(KEYS.length));
  for (let i = KEYS.length - 1; i >= 0; i -= 1) {
    fireEvent.click(stripTabs()[i]!);
    await waitFor(() => expect(screen.getByText(`label ${IDS[i]}`)).toBeTruthy());
  }
  await waitFor(() => expect(mountedLabels()).toEqual(KEYS));
  return view;
}

describe('theme flip render count', () => {
  it(`renders no widget of the ${KEEP_MOUNTED} kept-mounted tabs across a flip`, async () => {
    expect(KEYS).toHaveLength(KEEP_MOUNTED);
    let renders = 0;
    __setWidgetRenderProbe(() => {
      renders += 1;
    });
    const view = await mountAll();
    // Positive control: the probe sees widgets render on mount.
    expect(renders).toBeGreaterThanOrEqual(1);
    // Let any trailing mount work (manifest settle, reports) finish first.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    renders = 0;
    act(() => {
      view.rerender(tree('light'));
      setMode('dark');
    });
    act(() => {
      view.rerender(tree('dark'));
      setMode('light');
    });

    expect(renders).toBe(0);
    // The flip kept every screen mounted and the active one unchanged.
    expect(mountedLabels()).toEqual(KEYS);
    expect(
      document.querySelector<HTMLElement>('.workspace__screen[data-active="true"]')?.dataset.tabKey
    ).toBe(KEYS[0]);
  });

  it('renders no widget of a screen docked beside the data browser, and leaves the dock alone', async () => {
    const SCREEN = KEYS[0]!;
    const TRACE = '@trace';
    const docked = [SCREEN, TRACE];
    const config = { trace: { path: 'trace/', query: 'pv=A&range=-1h' } };
    sessionStorage.setItem(tabsStorageKey('/'), JSON.stringify({ keys: docked, active: SCREEN }));
    // The stored layout (storage.ts StoredDock v1): two equal columns, one tab each.
    localStorage.setItem(
      dockStorageKey('/'),
      JSON.stringify({
        version: 1,
        layout: {
          split: 'row',
          items: docked.map((key, i) => ({
            tile: `t${i + 1}`,
            tabs: [key],
            showing: key,
            size: 0.5,
          })),
        },
        panels: { [SCREEN]: { kind: 'screen' }, [TRACE]: { kind: 'tool' } },
      })
    );
    // Each tile's showing tab, in strip order (the dock root's data-showing).
    const dockedNow = () =>
      JSON.parse(screen.getByTestId('workspace-dock').dataset.showing ?? 'null') as string[];
    const layoutNow = () =>
      JSON.stringify(
        (
          screen.getByTestId('workspace-dock') as HTMLElement & { canopyDockLayout: () => unknown }
        ).canopyDockLayout()
      );

    let renders = 0;
    __setWidgetRenderProbe(() => {
      renders += 1;
    });
    const view = render(tree('dark', config));
    await waitFor(() => expect(dockedNow()).toEqual(docked));
    await waitFor(() => expect(screen.getByText(`label ${IDS[0]}`)).toBeTruthy());
    // Positive control: the probe sees widgets render on mount.
    expect(renders).toBeGreaterThanOrEqual(1);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    const frame = document.querySelector<HTMLIFrameElement>('iframe.workspace-trace');
    expect(frame).not.toBeNull();
    const themed = document.querySelectorAll('.canopy-dock');
    expect(themed).toHaveLength(1);
    const classes = themed[0]!.className;
    const layout = layoutNow();
    expect(document.querySelectorAll('[data-testid="tile-bar"]')).toHaveLength(2);

    renders = 0;
    act(() => {
      view.rerender(tree('light', config));
      setMode('dark');
    });
    act(() => {
      view.rerender(tree('dark', config));
      setMode('light');
    });

    expect(renders).toBe(0);
    // The dock's one theme was not swapped, and neither tile moved or remounted.
    expect(document.querySelectorAll('.canopy-dock')).toHaveLength(1);
    expect(document.querySelector('.canopy-dock')).toBe(themed[0]);
    expect(themed[0]!.className).toBe(classes);
    expect(document.querySelectorAll('[class*="dockview-theme-"]')).toHaveLength(0);
    expect(layoutNow()).toBe(layout);
    expect(dockedNow()).toEqual(docked);
    expect(document.querySelector('iframe.workspace-trace')).toBe(frame);
    expect(mountedLabels()).toEqual([SCREEN]);
  });
});

function renderApp(path: string) {
  return render(
    <ServicesContext.Provider value={services}>
      <MemoryRouter initialEntries={[path]}>
        <App screensBaseUrl={window.location.origin} />
      </MemoryRouter>
    </ServicesContext.Provider>
  );
}

function hostTheme(theme: string) {
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: THEME_MESSAGE, theme },
        source: window.parent,
        origin: window.location.origin,
      })
    );
  });
}

const anchorTheme = () => document.querySelector<HTMLElement>('.viewer-embed')?.dataset.theme;

describe('same-mode theme flip render count', () => {
  it(`/embed renders no widget of the ${KEEP_MOUNTED} kept-mounted tabs`, async () => {
    let renders = 0;
    __setWidgetRenderProbe(() => {
      renders += 1;
    });
    renderApp('/embed/?theme=desy-dark');
    await waitFor(() => expect(stripTabs()).toHaveLength(KEYS.length));
    for (let i = KEYS.length - 1; i >= 0; i -= 1) {
      fireEvent.click(stripTabs()[i]!);
      await waitFor(() => expect(screen.getByText(`label ${IDS[i]}`)).toBeTruthy());
    }
    await waitFor(() => expect(mountedLabels()).toEqual(KEYS));
    // Positive control: the probe sees widgets render on mount.
    expect(renders).toBeGreaterThanOrEqual(1);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(anchorTheme()).toBe('desy-dark');

    renders = 0;
    hostTheme('retro-dark');
    // The flip arrived: the root names the new theme, the mode is unchanged.
    expect(anchorTheme()).toBe('retro-dark');
    expect(getMode()).toBe('dark');
    hostTheme('desy-dark');
    expect(anchorTheme()).toBe('desy-dark');

    expect(renders).toBe(0);
    expect(mountedLabels()).toEqual(KEYS);
  });

  it('/s/ renders no widget of the screen', async () => {
    let renders = 0;
    __setWidgetRenderProbe(() => {
      renders += 1;
    });
    renderApp('/s/examples/alpha?theme=desy-dark');
    await waitFor(() => expect(screen.getByText('label alpha')).toBeTruthy());
    expect(renders).toBeGreaterThanOrEqual(1);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(anchorTheme()).toBe('desy-dark');

    renders = 0;
    hostTheme('retro-dark');
    expect(anchorTheme()).toBe('retro-dark');
    expect(getMode()).toBe('dark');
    hostTheme('desy-dark');
    expect(anchorTheme()).toBe('desy-dark');

    expect(renders).toBe(0);
  });
});
