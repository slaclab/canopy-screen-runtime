// EmbedPage is a mode-store writer: it seeds the runtime's mode store before
// the first workspace screen mounts, and a host's theme message flips
// the store (and so every screen root) without re-rendering any widget.
// Rendered through the real App route table and WorkspacePage, so the
// runtime's widget render probe sees every WidgetNodeView.

import { useLayoutEffect } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { LocalPVService, MockPVService } from '@slaclab/canopy-client';
import { getMode, setMode } from '@slaclab/canopy-screen-runtime';
import { __setWidgetRenderProbe } from '@slaclab/canopy-screen-runtime/testing';
import { registerBuiltinWidgets } from '@slaclab/canopy-screen-widgets';
import { App } from '../App.js';
import { EmbedPage } from './EmbedPage.js';
import { ServicesContext } from '../services.js';
import type { ViewerServices } from '../services.js';
import { THEME_MESSAGE } from '../useThemeInput.js';

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

const MANIFEST = {
  screens: [
    {
      id: 'alpha',
      kind: 'ir',
      title: 'Screen alpha',
      category: 'examples',
      path: 'screens/examples/alpha.screen.json',
      macros: [],
      tags: [],
      schemaVersion: '1.1',
    },
  ],
};

const DOC = {
  schemaVersion: '1.1',
  kind: 'screen',
  id: 'alpha',
  metadata: {
    title: 'Screen alpha',
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
        id: 'alpha-label',
        type: 'text-label',
        props: { text: 'label alpha' },
        geometry: { x: 0, y: 0, width: 200, height: 20 },
      },
    ],
  },
};

function stubFetch() {
  const routes: Record<string, unknown> = {
    '/manifest.json': MANIFEST,
    '/screens/examples/alpha.screen.json': DOC,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input).split('?')[0]!;
      for (const [suffix, data] of Object.entries(routes)) {
        if (url.endsWith(suffix)) return new Response(JSON.stringify(data), { status: 200 });
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

function renderEmbed(path: string) {
  return render(
    <ServicesContext.Provider value={services}>
      <MemoryRouter initialEntries={[path]}>
        <App screensBaseUrl={window.location.origin} themes={{ 'host-night': 'dark' }} />
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

describe('EmbedPage mode-store writer', () => {
  it('seeds the store before the first screen mounts', async () => {
    setMode('light');
    renderEmbed('/embed/examples/alpha');
    // The embed default is dark; the root's first layout effect already saw it.
    expect(getMode()).toBe('dark');
    const root = await screen.findByTestId('screen-root');
    expect(root.dataset.theme).toBe('dark');
  });

  it("the store is set before a child's first layout effect, as a screen root reads it", () => {
    setMode('dark');
    const seen: string[] = [];
    function Child() {
      useLayoutEffect(() => {
        seen.push(getMode());
      }, []);
      return null;
    }
    render(
      <MemoryRouter initialEntries={['/embed/x?theme=light']}>
        <Routes>
          <Route path="/embed" element={<EmbedPage themes={{}} />}>
            <Route path="*" element={<Child />} />
          </Route>
        </Routes>
      </MemoryRouter>
    );
    expect(seen).toEqual(['light']);
  });

  it('seeds ?theme=light', async () => {
    setMode('dark');
    renderEmbed('/embed/examples/alpha?theme=light');
    expect(getMode()).toBe('light');
    expect((await screen.findByTestId('screen-root')).dataset.theme).toBe('light');
  });

  it('a theme message flips every screen root and renders no widget', async () => {
    let renders = 0;
    __setWidgetRenderProbe(() => {
      renders += 1;
    });
    renderEmbed('/embed/examples/alpha?theme=light');
    const root = await screen.findByTestId('screen-root');
    await waitFor(() => expect(screen.getByText('label alpha')).toBeTruthy());
    // Positive control: the probe sees widgets render on mount.
    expect(renders).toBeGreaterThanOrEqual(1);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    renders = 0;
    hostTheme('host-night');
    expect(getMode()).toBe('dark');
    expect(root.dataset.theme).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    hostTheme('light');
    expect(getMode()).toBe('light');
    expect(root.dataset.theme).toBe('light');

    expect(renders).toBe(0);
  });

  it('a flip to another theme of the same mode renames the anchor and renders no widget', async () => {
    let renders = 0;
    __setWidgetRenderProbe(() => {
      renders += 1;
    });
    const { container } = renderEmbed('/embed/examples/alpha?theme=desy-dark');
    const root = await screen.findByTestId('screen-root');
    await waitFor(() => expect(screen.getByText('label alpha')).toBeTruthy());
    expect(renders).toBeGreaterThanOrEqual(1);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    const anchor = container.querySelector<HTMLElement>('.viewer-embed')!;
    expect(anchor.getAttribute('data-theme')).toBe('desy-dark');
    expect(anchor.hasAttribute('data-canopy-host-root')).toBe(true);
    expect(anchor.hasAttribute('data-floating-menu-container')).toBe(true);

    renders = 0;
    hostTheme('retro-dark');
    // The same element, renamed: the anchor is not remounted by a flip.
    expect(container.querySelector('.viewer-embed')).toBe(anchor);
    expect(anchor.getAttribute('data-theme')).toBe('retro-dark');
    expect(anchor.hasAttribute('data-canopy-host-root')).toBe(true);
    expect(anchor.classList.contains('cds--g100')).toBe(true);
    // The document and the screen roots keep the mode, never the id.
    expect(getMode()).toBe('dark');
    expect(root.dataset.theme).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');

    expect(renders).toBe(0);
  });

  it('a flip across modes renames the anchor too', async () => {
    const { container } = renderEmbed('/embed/examples/alpha?theme=retro-dark');
    await screen.findByTestId('screen-root');
    const anchor = container.querySelector<HTMLElement>('.viewer-embed')!;
    hostTheme('desy-light');
    expect(anchor.getAttribute('data-theme')).toBe('desy-light');
    expect(anchor.classList.contains('cds--white')).toBe(true);
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('an ill-formed theme id never reaches the anchor: it carries the mode', async () => {
    const { container } = renderEmbed('/embed/examples/alpha?theme=Desy%20Dark');
    await screen.findByTestId('screen-root');
    const anchor = container.querySelector<HTMLElement>('.viewer-embed')!;
    expect(anchor.getAttribute('data-theme')).toBe('dark');
    hostTheme('"><x');
    expect(anchor.getAttribute('data-theme')).toBe('dark');
  });
});
