// A tool URL with a query (/embed/@<tool>?<query>), by host message and at first
// load: it takes open_tool's path (a new query opens a tab, the same query
// focuses it), a refused query and the instance cap open nothing and show the
// notice, and the URL written back never reopens a tab on reload.

import { createElement, useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import type { Manifest } from '../api.js';
import type { ViewerConfig } from '../config.js';
import { EmbedThemeContext } from '../pages/EmbedPage.js';
import { ZoomProvider } from '../ZoomContext.js';
import { NAVIGATE_MESSAGE } from './host/useHostNavigation.js';
import { tabsStorageKey } from './tabs.js';
import { WorkspacePage } from './WorkspacePage.js';
import { toolUrlOf } from './workspaceUrl.js';

// Node 26's global localStorage is unusable without --localstorage-file and
// shadows jsdom's; an in-memory Storage stands in (as in WorkspacePage.test).
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

vi.mock('../pages/ScreenPage.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../pages/ScreenPage.js')>();
  function ScreenProbe(props: { id?: string; onTitle?: (title: string) => void }) {
    const { onTitle } = props;
    useEffect(() => {
      onTitle?.(`Rendered ${props.id ?? ''}`);
    }, [onTitle, props.id]);
    return createElement('div', { 'data-testid': 'screen-probe', 'data-id': props.id });
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
  ],
};
const BASE = 'https://host/screens';
const TRACE = { path: '/trace/', query: 'pv=DEFAULT' };
const CONFIG = { trace: TRACE } as Partial<ViewerConfig> as ViewerConfig;
const QUERY_A = 'pv=SR:A&range=-1h';
const QUERY_B = 'pv=SR:B&range=-1h';

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify(MANIFEST), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
    )
  );
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const frame = document.createElement('iframe');
  document.body.appendChild(frame);
  const host = frame.contentWindow!;
  host.postMessage = vi.fn() as unknown as Window['postMessage'];
  vi.spyOn(window, 'parent', 'get').mockReturnValue(host as Window & typeof globalThis);
});

afterEach(() => {
  cleanup();
  document.querySelectorAll('body > iframe').forEach((frame) => frame.remove());
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

function LocationProbe() {
  const location = useLocation();
  return createElement(
    'output',
    { 'data-testid': 'location' },
    location.pathname + location.search
  );
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ZoomProvider>
        <EmbedThemeContext.Provider
          value={{ mode: 'dark', id: 'dark', anchorRef: { current: null } }}
        >
          <WorkspacePage screensBaseUrl={BASE} config={CONFIG} />
          <LocationProbe />
        </EmbedThemeContext.Provider>
      </ZoomProvider>
    </MemoryRouter>
  );
}

function here(): string {
  return screen.getByTestId('location').textContent ?? '';
}

interface Stored {
  keys: string[];
  active: string | null;
  instances: Record<string, { query?: string | null }>;
}

function stored(): Stored {
  const raw = sessionStorage.getItem(tabsStorageKey('/'));
  return raw === null ? { keys: [], active: null, instances: {} } : (JSON.parse(raw) as Stored);
}

function send(url: string) {
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: NAVIGATE_MESSAGE, url },
        source: window.parent,
        origin: window.location.origin,
      })
    );
  });
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

function notice(): string | null {
  return document.querySelector('.workspace__notice span')?.textContent ?? null;
}

const pvs = (count: number) =>
  Array.from({ length: count }, (_, i) => `pv=SR:PV${i}`).join('&') + '&range=-1h';

describe('toolUrlOf', () => {
  it('reads the tool and the query as written', () => {
    expect(toolUrlOf(`/embed/@trace?${QUERY_A}`)).toEqual({ tool: 'trace', query: QUERY_A });
    expect(toolUrlOf('/embed/@trace/?pv=A#x')).toEqual({ tool: 'trace', query: 'pv=A' });
  });

  it("leaves the viewer's own parameters out of the query", () => {
    expect(
      toolUrlOf('/embed/@trace?embedded=true&pv=A&theme=dark&_canopyZoom=fit&mode=light&range=-1h')
    ).toEqual({ tool: 'trace', query: 'pv=A&range=-1h' });
    expect(toolUrlOf('/embed/@trace?embedded=true&theme=dark')).toBeNull();
  });

  it('is null for a plain tool URL, a numbered instance, a screen and a bad key', () => {
    expect(toolUrlOf('/embed/@trace')).toBeNull();
    expect(toolUrlOf('/embed/@trace?')).toBeNull();
    expect(toolUrlOf('/embed/@trace/2?pv=A')).toBeNull();
    expect(toolUrlOf('/embed/bts/knob?pv=A')).toBeNull();
    expect(toolUrlOf('/embed/@BAD?pv=A')).toBeNull();
    expect(toolUrlOf('/embed/@%E0%A4%A?pv=A')).toBeNull();
  });
});

describe('a tool URL by host message', () => {
  it('a new query opens a tab and the URL becomes that tab', async () => {
    renderAt('/embed/bts/knob');
    await screen.findByTestId('screen-probe');
    send(`/embed/@trace?${QUERY_A}`);
    await waitFor(() => expect(stored().keys).toEqual(['bts/knob', '@trace']));
    expect(stored().active).toBe('@trace');
    expect(stored().instances['@trace']?.query).toBe(QUERY_A);
    await waitFor(() => expect(here()).toBe('/embed/@trace'));
    send(`/embed/@trace?${QUERY_B}`);
    await waitFor(() => expect(stored().keys).toEqual(['bts/knob', '@trace', '@trace/2']));
    expect(stored().instances['@trace/2']?.query).toBe(QUERY_B);
    await waitFor(() => expect(here()).toBe('/embed/@trace/2'));
  });

  it('the same query focuses the tab showing it', async () => {
    renderAt('/embed/bts/knob');
    await screen.findByTestId('screen-probe');
    send(`/embed/@trace?${QUERY_A}`);
    await waitFor(() => expect(here()).toBe('/embed/@trace'));
    send(`/embed/@trace?${QUERY_B}`);
    await waitFor(() => expect(here()).toBe('/embed/@trace/2'));
    send(`/embed/@trace?${QUERY_A}`);
    await waitFor(() => expect(stored().active).toBe('@trace'));
    expect(stored().keys).toEqual(['bts/knob', '@trace', '@trace/2']);
    await waitFor(() => expect(here()).toBe('/embed/@trace'));
  });

  it('the query of the tab already active keeps it and restores its URL', async () => {
    renderAt('/embed/bts/knob');
    await screen.findByTestId('screen-probe');
    send(`/embed/@trace?${QUERY_A}`);
    await waitFor(() => expect(here()).toBe('/embed/@trace'));
    send(`/embed/@trace?${QUERY_A}`);
    await waitFor(() => expect(here()).toBe('/embed/@trace'));
    await settle();
    expect(here()).toBe('/embed/@trace');
    expect(stored().keys).toEqual(['bts/knob', '@trace']);
    // The write was seen as the workspace's own: an outside link to it still works.
    send('/embed/bts/knob');
    await waitFor(() => expect(stored().active).toBe('bts/knob'));
    send('/embed/@trace');
    await waitFor(() => expect(stored().active).toBe('@trace'));
  });

  it('a default-query instance is the tab showing the default query', async () => {
    renderAt('/embed/@trace');
    await waitFor(() => expect(stored().keys).toEqual(['@trace']));
    send(`/embed/@trace?${TRACE.query}`);
    await waitFor(() => expect(here()).toBe('/embed/@trace'));
    await settle();
    expect(stored().keys).toEqual(['@trace']);
  });

  it('a plain tool URL still opens the first instance', async () => {
    renderAt('/embed/bts/knob');
    await screen.findByTestId('screen-probe');
    send('/embed/@trace');
    await waitFor(() => expect(stored().active).toBe('@trace'));
    expect(stored().instances['@trace']?.query ?? null).toBeNull();
  });

  it.each([
    ['more than 12 PVs', pvs(13)],
    ['an unreadable range', 'pv=SR:A&range=soon'],
  ])('%s opens nothing, restores the URL and shows the notice', async (_label, query) => {
    renderAt('/embed/bts/knob');
    await screen.findByTestId('screen-probe');
    send(`/embed/@trace?${query}`);
    await waitFor(() => expect(notice()).toContain('Data Browser'));
    await waitFor(() => expect(here()).toBe('/embed/bts/knob'));
    expect(stored().keys).toEqual(['bts/knob']);
    expect(stored().active).toBe('bts/knob');
  });

  it('12 PVs are not refused', async () => {
    renderAt('/embed/bts/knob');
    await screen.findByTestId('screen-probe');
    send(`/embed/@trace?${pvs(12)}`);
    await waitFor(() => expect(stored().keys).toEqual(['bts/knob', '@trace']));
    expect(notice()).toBeNull();
  });

  it('a tool this viewer has not configured opens nothing and shows the notice', async () => {
    renderAt('/embed/bts/knob');
    await screen.findByTestId('screen-probe');
    send('/embed/@correlation?y=SR:A');
    await waitFor(() => expect(notice()).toContain('Correlation'));
    await waitFor(() => expect(here()).toBe('/embed/bts/knob'));
    expect(stored().keys).toEqual(['bts/knob']);
  });

  it('at the instance cap a new query opens nothing; a query already showing still focuses', async () => {
    renderAt('/embed/bts/knob');
    await screen.findByTestId('screen-probe');
    for (let i = 1; i <= 10; i += 1) {
      send(`/embed/@trace?pv=SR:${i}`);
      await waitFor(() => expect(stored().keys).toHaveLength(i + 1));
      await waitFor(() => expect(here()).not.toContain('?'));
    }
    const full = stored().keys;
    const active = stored().active;
    send('/embed/@trace?pv=SR:11');
    await waitFor(() => expect(notice()).toContain('At most 10 Data Browser tabs'));
    await waitFor(() => expect(here()).toBe(`/embed/${active}`));
    expect(stored().keys).toEqual(full);
    expect(stored().active).toBe(active);
    send('/embed/@trace?pv=SR:1');
    await waitFor(() => expect(stored().active).toBe('@trace'));
    expect(stored().keys).toEqual(full);
    await waitFor(() => expect(here()).toBe('/embed/@trace'));
  });
});

describe('a tool URL at first load', () => {
  it('opens one tab with the query, no first-visit data browser beside it', async () => {
    renderAt(`/embed/@trace?${QUERY_A}&embedded=true`);
    await waitFor(() => expect(here()).toBe('/embed/@trace'));
    expect(stored().keys).toEqual(['@trace']);
    expect(stored().instances['@trace']?.query).toBe(QUERY_A);
    expect(notice()).toBeNull();
    const frame = document.querySelector('iframe.workspace-trace');
    expect(new URL((frame as HTMLIFrameElement).src).searchParams.getAll('pv')).toEqual(['SR:A']);
  });

  it('joins the tabs the session restores, and focuses one showing the query', async () => {
    const first = renderAt('/embed/bts/knob');
    await screen.findByTestId('screen-probe');
    send(`/embed/@trace?${QUERY_A}`);
    await waitFor(() => expect(here()).toBe('/embed/@trace'));
    send('/embed/bts/knob');
    await waitFor(() => expect(stored().active).toBe('bts/knob'));
    first.unmount();

    const second = renderAt(`/embed/@trace?${QUERY_A}`);
    await waitFor(() => expect(here()).toBe('/embed/@trace'));
    expect(stored().keys).toEqual(['bts/knob', '@trace']);
    expect(stored().active).toBe('@trace');
    second.unmount();

    renderAt(`/embed/@trace?${QUERY_B}`);
    await waitFor(() => expect(here()).toBe('/embed/@trace/2'));
    expect(stored().keys).toEqual(['bts/knob', '@trace', '@trace/2']);
    expect(stored().instances['@trace/2']?.query).toBe(QUERY_B);
  });

  it('a refused query opens nothing of its own, restores the URL and shows the notice', async () => {
    renderAt(`/embed/@trace?${pvs(13)}`);
    await waitFor(() => expect(notice()).toContain('Data Browser'));
    // A first visit opens what a bare /embed/ opens: the data browser on its default.
    await waitFor(() => expect(here()).toBe('/embed/@trace'));
    expect(stored().keys).toEqual(['@trace']);
    expect(stored().instances['@trace']?.query).not.toBe(pvs(13));
  });

  it('a refused query keeps the session as it was', async () => {
    const first = renderAt('/embed/bts/knob');
    await screen.findByTestId('screen-probe');
    await waitFor(() => expect(stored().keys).toEqual(['bts/knob']));
    first.unmount();
    renderAt('/embed/@trace?pv=SR:A&range=soon');
    await waitFor(() => expect(notice()).toContain('Data Browser'));
    await waitFor(() => expect(here()).toBe('/embed/bts/knob'));
    expect(stored().keys).toEqual(['bts/knob']);
  });
});

describe('reload', () => {
  it('the URL written back opens no second tab', async () => {
    const first = renderAt('/embed/bts/knob');
    await screen.findByTestId('screen-probe');
    send(`/embed/@trace?${QUERY_A}`);
    await waitFor(() => expect(here()).toBe('/embed/@trace'));
    send(`/embed/@trace?${QUERY_B}`);
    await waitFor(() => expect(here()).toBe('/embed/@trace/2'));
    const written = here();
    const keys = stored().keys;
    first.unmount();

    renderAt(written);
    await settle();
    expect(here()).toBe(written);
    expect(stored().keys).toEqual(keys);
    expect(stored().active).toBe('@trace/2');
    expect(stored().instances['@trace/2']?.query).toBe(QUERY_B);
  });

  it('a first-load URL reloaded opens no second tab', async () => {
    const first = renderAt(`/embed/@trace?${QUERY_A}`);
    await waitFor(() => expect(here()).toBe('/embed/@trace'));
    const written = here();
    first.unmount();
    renderAt(written);
    await settle();
    expect(here()).toBe('/embed/@trace');
    expect(stored().keys).toEqual(['@trace']);
  });
});
