// A workspace tab under /embed renders with the configured color scheme. The
// only ScreenRenderer is ScreenPage's, and the workspace's memoised
// MountedScreen passes its tabs no config, so main.tsx provides the scheme
// through ColorSchemeContext and ScreenPage reads it. These tests render the
// real App route table at /embed/<category>/<id> and check that a role-bearing
// widget resolves against the config scheme (its index, its stylesheet, its
// value) rather than the bundled canopy-default, and that re-rendering with the
// same provider value re-renders no widget (the value is one stable object).

import type { ReactNode } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LocalPVService, MockPVService } from '@slaclab/canopy-client';
import { canopyDefaultFlat } from '@slaclab/canopy-screen-ir';
import type { FlatScheme } from '@slaclab/canopy-screen-ir';
import { setMode } from '@slaclab/canopy-screen-runtime';
import { __setWidgetRenderProbe } from '@slaclab/canopy-screen-runtime/testing';
import { registerBuiltinWidgets } from '@slaclab/canopy-screen-widgets';
import { App } from '../App.js';
import { ColorSchemeContext, useColorScheme } from '../colorSchemeContext.js';
import { parseColorScheme } from '../config.js';
import { ServicesContext } from '../services.js';
import type { ViewerServices } from '../services.js';

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

const FALLBACK = '#010203';
const SITE_TEXT_LIGHT = '#123456';

// The config scheme as config.json serves it, parsed the way main.tsx does.
// `Text` sits at index 1, so its custom property differs from canopy-default's.
const SITE_SCHEME: FlatScheme = parseColorScheme({
  roles: ['Site_Pad', 'Text'],
  light: ['#fefefe', SITE_TEXT_LIGHT],
  dark: ['#0e0e0e', '#abcdef'],
  meta: {
    id: 'site-scheme',
    sha256: 'b'.repeat(64),
    flatHash: 'site-hash',
    served: 'site-scheme',
    errors: [],
  },
});

const MANIFEST = {
  screens: [
    {
      id: 'role-screen',
      kind: 'ir',
      title: 'Role screen',
      category: 'examples',
      path: 'screens/examples/role-screen.screen.json',
      macros: [],
      tags: [],
      schemaVersion: '1.1',
    },
  ],
};

const DOC = {
  schemaVersion: '1.1',
  kind: 'screen',
  id: 'role-screen',
  metadata: {
    title: 'Role screen',
    source: { type: 'hand-authored' },
    size: { width: 200, height: 40 },
  },
  macros: [],
  root: {
    id: 'root',
    type: 'group',
    props: {},
    geometry: { x: 0, y: 0, width: 200, height: 40 },
    children: [
      {
        id: 'role-label',
        type: 'text-label',
        props: { text: 'role text', foregroundColor: { $role: 'Text', fallback: FALLBACK } },
        geometry: { x: 0, y: 0, width: 200, height: 20 },
      },
    ],
  },
};

let services: ViewerServices;

beforeAll(() => {
  registerBuiltinWidgets();
});

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input).split('?')[0]!;
      if (url.endsWith('/manifest.json')) return new Response(JSON.stringify(MANIFEST));
      if (url.endsWith('/screens/examples/role-screen.screen.json'))
        return new Response(JSON.stringify(DOC));
      return new Response('{}', { status: 404, statusText: 'Not Found' });
    })
  );
  vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {});
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
  vi.restoreAllMocks();
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

function tree(scheme: FlatScheme | undefined, children?: ReactNode): ReactNode {
  const app = (
    <ServicesContext.Provider value={services}>
      <MemoryRouter initialEntries={['/embed/examples/role-screen?theme=light']}>
        <App screensBaseUrl={window.location.origin} />
        {children}
      </MemoryRouter>
    </ServicesContext.Provider>
  );
  return scheme ? (
    <ColorSchemeContext.Provider value={scheme}>{app}</ColorSchemeContext.Provider>
  ) : (
    app
  );
}

/** The element carrying the label's resolved foreground colour. */
async function labelColor(): Promise<string> {
  const text = await screen.findByText('role text');
  for (let el: HTMLElement | null = text; el; el = el.parentElement) {
    if (el.style.color) return el.style.color;
  }
  throw new Error('no element with an inline color');
}

describe('workspace tab colour scheme under /embed', () => {
  it('resolves a role against the config scheme, not canopy-default', async () => {
    expect(canopyDefaultFlat.roles.indexOf('Text')).not.toBe(1);
    render(tree(SITE_SCHEME));

    const root = await screen.findByTestId('screen-root');
    expect(root.dataset.scheme).toBe('site-hash');
    expect(root.dataset.scheme).not.toBe(canopyDefaultFlat.meta.flatHash);
    expect(await labelColor()).toBe(`var(--cr-1, ${FALLBACK})`);

    const sheet = document.querySelector('style[data-canopy-scheme="site-hash"]');
    expect(sheet?.textContent).toContain(`--cr-1:${SITE_TEXT_LIGHT}`);
    const defaultText = canopyDefaultFlat.light[canopyDefaultFlat.roles.indexOf('Text')];
    expect(defaultText).not.toBe(SITE_TEXT_LIGHT);
  });

  it('falls back to canopy-default without a provider', async () => {
    render(tree(undefined));
    const root = await screen.findByTestId('screen-root');
    expect(root.dataset.scheme).toBe(canopyDefaultFlat.meta.flatHash);
    const i = canopyDefaultFlat.roles.indexOf('Text');
    expect(await labelColor()).toBe(`var(--cr-${i}, ${FALLBACK})`);
  });

  it('keeps one stable context value and re-renders no widget across renders', async () => {
    const seen: FlatScheme[] = [];
    function Probe() {
      seen.push(useColorScheme());
      return null;
    }
    // One app element, as main.tsx renders it once: only the provider re-renders.
    const app = tree(undefined, <Probe />);
    const provide = (scheme: FlatScheme) => (
      <ColorSchemeContext.Provider value={scheme}>{app}</ColorSchemeContext.Provider>
    );
    const view = render(provide(SITE_SCHEME));
    await screen.findByText('role text');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    let renders = 0;
    __setWidgetRenderProbe(() => {
      renders += 1;
    });
    view.rerender(provide(SITE_SCHEME));
    view.rerender(provide(SITE_SCHEME));
    expect(renders).toBe(0);
    expect(seen.length).toBeGreaterThanOrEqual(1);
    for (const value of seen) expect(value).toBe(SITE_SCHEME);

    // Positive control: an equal but new scheme object does reach the widgets,
    // so the zero above is the stable reference at work, not a blind probe.
    view.rerender(provide({ ...SITE_SCHEME }));
    expect(renders).toBeGreaterThanOrEqual(1);
    expect((await screen.findByTestId('screen-root')).dataset.scheme).toBe('site-hash');
  });
});
