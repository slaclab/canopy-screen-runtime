// A tool URL with a query (/embed/@<tool>?<query>) is the host's hand-off: its
// navigate message or a same-origin framed first load takes open_tool's path (a
// new query opens a tab, the same query focuses it, no stored query changes), a
// refused query and the instance cap open nothing and show the notice, and a
// reload never reopens a tab. A top-level load ignores the query, as does any
// other URL. A query never overrides the viewer's own parameters in a tool frame.

import { createElement, useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import type { Manifest } from '../api.js';
import type { ViewerConfig } from '../config.js';
import { EmbedThemeContext } from '../pages/EmbedPage.js';
import { ZoomProvider } from '../ZoomContext.js';
import { NAVIGATE_MESSAGE } from './host/useHostNavigation.js';
import { tabsStorageKey } from './tabs.js';
import { traceSrc } from './TraceTab.js';
import { WorkspacePage } from './WorkspacePage.js';
import { framedBySameOrigin, toolUrlOf } from './workspaceUrl.js';

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
const CONFIG = {
  trace: TRACE,
  correlation: { path: '/correlation/', query: '' },
} as Partial<ViewerConfig> as ViewerConfig;
// The queries in the one encoding the viewer keeps.
const QUERY_A = 'pv=SR%3AA&range=-1h';
const QUERY_B = 'pv=SR%3AB&range=-1h';

let host: Window;

/** window.parent is `value`: a host frame, a stand-in, or window itself (top level). */
function setParent(value: unknown) {
  vi.spyOn(window, 'parent', 'get').mockReturnValue(value as Window & typeof globalThis);
}

/** A same-origin parent for a first load; messages then come from the real `host` frame. */
function sameOriginParent() {
  setParent({ location: { origin: window.location.origin }, postMessage: vi.fn() });
}

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
  host = frame.contentWindow!;
  host.postMessage = vi.fn() as unknown as Window['postMessage'];
  setParent(host);
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
  const navigate = useNavigate();
  return (
    <>
      <output data-testid="location">{location.pathname + location.search}</output>
      <button
        data-testid="router-link"
        onClick={() => void navigate('/embed/@trace?pv=EVIL:PV', { replace: true })}
      />
    </>
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

function frameUrl(): URL {
  const frame = document.querySelector('iframe.workspace-trace');
  return new URL((frame as HTMLIFrameElement).src);
}

const pvs = (count: number) =>
  Array.from({ length: count }, (_, i) => `pv=SR:PV${i}`).join('&') + '&range=-1h';

describe('toolUrlOf', () => {
  it('reads the tool and the query, in one encoding', () => {
    expect(toolUrlOf('/embed/@trace?pv=SR:A&range=-1h')).toEqual({ tool: 'trace', query: QUERY_A });
    expect(toolUrlOf(`/embed/@trace?${QUERY_A}`)).toEqual({ tool: 'trace', query: QUERY_A });
    expect(toolUrlOf('/embed/@trace/?pv=A#x')).toEqual({ tool: 'trace', query: 'pv=A' });
  });

  it("leaves the viewer's own parameters out of the query", () => {
    expect(
      toolUrlOf(
        '/embed/@trace?embedded=true&pv=A&theme=dark&_canopyZoom=fit&mode=light&hostbar=1&range=-1h'
      )
    ).toEqual({ tool: 'trace', query: 'pv=A&range=-1h' });
    expect(toolUrlOf('/embed/@trace?embedded=true&theme=dark')).toBeNull();
  });

  it.each(['%74heme=evil', 'embe%64ded=false', 'hostb%61r=0', 'mod%65=x', '%5FcanopyZoom=9'])(
    'leaves the encoded name %s out too',
    (pair) => {
      expect(toolUrlOf(`/embed/@trace?pv=A&${pair}`)).toEqual({ tool: 'trace', query: 'pv=A' });
    }
  );

  it('is null for a plain tool URL, a numbered instance, a screen and a bad key', () => {
    expect(toolUrlOf('/embed/@trace')).toBeNull();
    expect(toolUrlOf('/embed/@trace?')).toBeNull();
    expect(toolUrlOf('/embed/@trace/2?pv=A')).toBeNull();
    expect(toolUrlOf('/embed/bts/knob?pv=A')).toBeNull();
    expect(toolUrlOf('/embed/@BAD?pv=A')).toBeNull();
    expect(toolUrlOf('/embed/@%E0%A4%A?pv=A')).toBeNull();
  });
});

describe('framedBySameOrigin', () => {
  it('is true only for a same-origin parent', () => {
    sameOriginParent();
    expect(framedBySameOrigin()).toBe(true);
    setParent(window);
    expect(framedBySameOrigin()).toBe(false);
    setParent({ location: { origin: 'https://evil.example' } });
    expect(framedBySameOrigin()).toBe(false);
    setParent({
      get location() {
        throw new DOMException('Blocked a frame', 'SecurityError');
      },
    });
    expect(framedBySameOrigin()).toBe(false);
  });
});

describe('traceSrc', () => {
  it.each([
    'theme=evil',
    '%74heme=evil',
    'embedded=false',
    'embe%64ded=false',
    'hostbar=1',
    'hostb%61r=1',
  ])('a stored query with %s cannot override the viewer', (pair) => {
    const src = new URL(traceSrc('trace/', `pv=A&${pair}`, 'dark'));
    expect(src.searchParams.getAll('theme')).toEqual(['dark']);
    expect(src.searchParams.getAll('embedded')).toEqual(['true']);
    expect(src.searchParams.has('hostbar')).toBe(false);
    expect(src.searchParams.getAll('pv')).toEqual(['A']);
  });

  it("keeps the rest of the query's bytes", () => {
    expect(traceSrc('trace/', 'pv=SR:A&range=-1h', 'dark')).toContain(
      '?pv=SR:A&range=-1h&theme=dark&embedded=true'
    );
  });

  it('a hostile stored instance reaches its frame without the override', async () => {
    sessionStorage.setItem(
      tabsStorageKey('/'),
      JSON.stringify({
        keys: ['@trace'],
        active: '@trace',
        instances: { '@trace': { query: 'pv=A&%74heme=evil&embe%64ded=false' } },
        toolMru: ['@trace'],
      })
    );
    renderAt('/embed/@trace');
    await settle();
    expect(frameUrl().searchParams.getAll('theme')).toEqual(['dark']);
    expect(frameUrl().searchParams.getAll('embedded')).toEqual(['true']);
  });
});

describe('a tool URL by host message', () => {
  it('a new query opens a tab and the URL becomes that tab', async () => {
    renderAt('/embed/bts/knob');
    await screen.findByTestId('screen-probe');
    send('/embed/@trace?pv=SR:A&range=-1h');
    await waitFor(() => expect(stored().keys).toEqual(['bts/knob', '@trace']));
    expect(stored().active).toBe('@trace');
    expect(stored().instances['@trace']?.query).toBe(QUERY_A);
    await waitFor(() => expect(here()).toBe('/embed/@trace'));
    send(`/embed/@trace?${QUERY_B}`);
    await waitFor(() => expect(stored().keys).toEqual(['bts/knob', '@trace', '@trace/2']));
    expect(stored().instances['@trace/2']?.query).toBe(QUERY_B);
    // The first tab keeps its query.
    expect(stored().instances['@trace']?.query).toBe(QUERY_A);
    await waitFor(() => expect(here()).toBe('/embed/@trace/2'));
  });

  it('the same query focuses the tab showing it, however it is spelled', async () => {
    renderAt('/embed/bts/knob');
    await screen.findByTestId('screen-probe');
    send(`/embed/@trace?${QUERY_A}`);
    await waitFor(() => expect(here()).toBe('/embed/@trace'));
    send(`/embed/@trace?${QUERY_B}`);
    await waitFor(() => expect(here()).toBe('/embed/@trace/2'));
    send('/embed/@trace?pv=SR:A&range=-1h');
    await waitFor(() => expect(stored().active).toBe('@trace'));
    expect(stored().keys).toEqual(['bts/knob', '@trace', '@trace/2']);
    await waitFor(() => expect(here()).toBe('/embed/@trace'));
  });

  it('the query of the tab already active changes nothing', async () => {
    renderAt('/embed/bts/knob');
    await screen.findByTestId('screen-probe');
    send(`/embed/@trace?${QUERY_A}`);
    await waitFor(() => expect(here()).toBe('/embed/@trace'));
    send(`/embed/@trace?${QUERY_A}`);
    await settle();
    expect(here()).toBe('/embed/@trace');
    expect(stored().keys).toEqual(['bts/knob', '@trace']);
  });

  it('a default-query instance is the tab showing the default query', async () => {
    renderAt('/embed/@trace');
    await waitFor(() => expect(stored().keys).toEqual(['@trace']));
    send(`/embed/@trace?${TRACE.query}`);
    await settle();
    expect(stored().keys).toEqual(['@trace']);
    expect(here()).toBe('/embed/@trace');
  });

  it('a stored instance on another query is left as it is', async () => {
    sessionStorage.setItem(
      tabsStorageKey('/'),
      JSON.stringify({
        keys: ['@trace'],
        active: '@trace',
        instances: { '@trace': { query: 'pv=KEEP' } },
        toolMru: ['@trace'],
      })
    );
    renderAt('/embed/@trace');
    await settle();
    send(`/embed/@trace?${QUERY_A}`);
    await waitFor(() => expect(stored().keys).toEqual(['@trace', '@trace/2']));
    expect(stored().instances['@trace']?.query).toBe('pv=KEEP');
    expect(stored().instances['@trace/2']?.query).toBe(QUERY_A);
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
    ['an unknown parameter', 'pv=SR:A&evil=1'],
    ['a parameter Trace reads but a host may not name', 'pv=SR:A&plot=%7B%7D'],
  ])('%s opens nothing, keeps the URL and shows the notice', async (_label, query) => {
    renderAt('/embed/bts/knob');
    await screen.findByTestId('screen-probe');
    send(`/embed/@trace?${query}`);
    await waitFor(() => expect(notice()).toContain('Data Browser'));
    expect(here()).toBe('/embed/bts/knob');
    expect(stored().keys).toEqual(['bts/knob']);
    expect(stored().active).toBe('bts/knob');
  });

  it('12 PVs and a custom range are not refused', async () => {
    renderAt('/embed/bts/knob');
    await screen.findByTestId('screen-probe');
    send(`/embed/@trace?${pvs(12)}`);
    await waitFor(() => expect(stored().keys).toEqual(['bts/knob', '@trace']));
    send('/embed/@trace?pv=SR:A&range=custom&from=2026-01-01T00:00&to=2026-01-02T00:00');
    await waitFor(() => expect(stored().keys).toHaveLength(3));
    expect(notice()).toBeNull();
  });

  it('a tool that takes no host query opens nothing and shows the notice', async () => {
    renderAt('/embed/bts/knob');
    await screen.findByTestId('screen-probe');
    send('/embed/@correlation?y=SR:A');
    await waitFor(() => expect(notice()).toContain('Correlation'));
    expect(stored().keys).toEqual(['bts/knob']);
  });

  it('a tool this viewer has not configured opens nothing and shows the notice', async () => {
    renderAt('/embed/bts/knob');
    await screen.findByTestId('screen-probe');
    send('/embed/@waveform?pv=SR:A');
    await waitFor(() => expect(notice()).toContain('Waveform'));
    expect(here()).toBe('/embed/bts/knob');
    expect(stored().keys).toEqual(['bts/knob']);
  });

  it('at the instance cap a new query opens nothing; a query already showing still focuses', async () => {
    renderAt('/embed/bts/knob');
    await screen.findByTestId('screen-probe');
    for (let i = 1; i <= 10; i += 1) {
      send(`/embed/@trace?pv=SR${i}`);
      await waitFor(() => expect(stored().keys).toHaveLength(i + 1));
    }
    const full = stored().keys;
    const active = stored().active;
    await waitFor(() => expect(here()).toBe(`/embed/${active}`));
    send('/embed/@trace?pv=SR11');
    await waitFor(() => expect(notice()).toContain('At most 10 Data Browser tabs'));
    expect(here()).toBe(`/embed/${active}`);
    expect(stored().keys).toEqual(full);
    send('/embed/@trace?pv=SR1');
    await waitFor(() => expect(stored().active).toBe('@trace'));
    expect(stored().keys).toEqual(full);
    await waitFor(() => expect(here()).toBe('/embed/@trace'));
  });
});

describe('a tool URL at first load, framed by a same-origin host', () => {
  beforeEach(sameOriginParent);

  it('opens one tab with the query, no first-visit data browser beside it', async () => {
    renderAt(`/embed/@trace?${QUERY_A}&embedded=true`);
    await waitFor(() => expect(here()).toBe('/embed/@trace'));
    expect(stored().keys).toEqual(['@trace']);
    expect(stored().instances['@trace']?.query).toBe(QUERY_A);
    expect(notice()).toBeNull();
    expect(frameUrl().searchParams.getAll('pv')).toEqual(['SR:A']);
  });

  it('joins the tabs the session restores, and focuses one showing the query', async () => {
    const first = renderAt('/embed/bts/knob');
    await screen.findByTestId('screen-probe');
    await waitFor(() => expect(stored().keys).toEqual(['bts/knob']));
    first.unmount();

    const second = renderAt(`/embed/@trace?${QUERY_A}`);
    await waitFor(() => expect(here()).toBe('/embed/@trace'));
    expect(stored().keys).toEqual(['bts/knob', '@trace']);
    second.unmount();

    const third = renderAt(`/embed/@trace?${QUERY_B}`);
    await waitFor(() => expect(here()).toBe('/embed/@trace/2'));
    expect(stored().keys).toEqual(['bts/knob', '@trace', '@trace/2']);
    expect(stored().instances['@trace']?.query).toBe(QUERY_A);
    third.unmount();

    renderAt(`/embed/@trace?${QUERY_A}`);
    await waitFor(() => expect(here()).toBe('/embed/@trace'));
    expect(stored().keys).toEqual(['bts/knob', '@trace', '@trace/2']);
    expect(stored().active).toBe('@trace');
  });

  it('a refused query opens nothing of its own, restores the URL and shows the notice', async () => {
    renderAt(`/embed/@trace?${pvs(13)}`);
    await waitFor(() => expect(notice()).toContain('Data Browser'));
    // A first visit opens what a bare /embed/ opens: the data browser on its default.
    await waitFor(() => expect(here()).toBe('/embed/@trace'));
    expect(stored().keys).toEqual(['@trace']);
    expect(frameUrl().searchParams.getAll('pv')).toEqual(['DEFAULT']);
  });

  it('a refused query keeps the session as it was', async () => {
    const first = renderAt('/embed/bts/knob');
    await screen.findByTestId('screen-probe');
    await waitFor(() => expect(stored().keys).toEqual(['bts/knob']));
    first.unmount();
    renderAt('/embed/@trace?pv=SR:A&evil=1');
    await waitFor(() => expect(notice()).toContain('Data Browser'));
    await waitFor(() => expect(here()).toBe('/embed/bts/knob'));
    expect(stored().keys).toEqual(['bts/knob']);
  });

  it("a later plain host link to that URL still navigates: the write is seen as the workspace's own", async () => {
    renderAt(`/embed/@trace?${QUERY_A}`);
    await waitFor(() => expect(here()).toBe('/embed/@trace'));
    setParent(host);
    send('/embed/bts/knob');
    await waitFor(() => expect(stored().active).toBe('bts/knob'));
    send('/embed/@trace');
    await waitFor(() => expect(stored().active).toBe('@trace'));
    await settle();
    expect(here()).toBe('/embed/@trace');
  });
});

describe('a query the host did not hand over', () => {
  it.each([
    ['a top-level load', () => setParent(window)],
    [
      'a cross-origin frame',
      () => setParent({ location: { origin: 'https://evil.example' }, postMessage: vi.fn() }),
    ],
    [
      'a frame whose parent cannot be read',
      () =>
        setParent({
          get location() {
            throw new DOMException('Blocked a frame', 'SecurityError');
          },
          postMessage: vi.fn(),
        }),
    ],
  ])('%s ignores it and opens the tool on its own query', async (_label, arrange) => {
    arrange();
    renderAt('/embed/@trace?pv=EVIL:PV&range=-9d');
    await waitFor(() => expect(here()).toBe('/embed/@trace'));
    expect(frameUrl().searchParams.getAll('pv')).toEqual(['DEFAULT']);
    expect(stored().keys).toEqual(['@trace']);
    expect(stored().instances['@trace']?.query ?? null).toBeNull();
    expect(notice()).toBeNull();
  });

  it('a top-level load leaves a stored instance unchanged', async () => {
    setParent(window);
    sessionStorage.setItem(
      tabsStorageKey('/'),
      JSON.stringify({
        keys: ['@trace'],
        active: '@trace',
        instances: { '@trace': { query: 'pv=KEEP' } },
        toolMru: ['@trace'],
      })
    );
    renderAt('/embed/@trace?pv=EVIL:PV');
    await waitFor(() => expect(here()).toBe('/embed/@trace'));
    expect(stored().keys).toEqual(['@trace']);
    expect(stored().instances['@trace']?.query).toBe('pv=KEEP');
    expect(frameUrl().searchParams.getAll('pv')).toEqual(['KEEP']);
  });

  it('a router navigation inside a framed viewer ignores it', async () => {
    renderAt('/embed/bts/knob');
    await screen.findByTestId('screen-probe');
    fireEvent.click(screen.getByTestId('router-link'));
    await waitFor(() => expect(stored().active).toBe('@trace'));
    expect(stored().instances['@trace']?.query ?? null).toBeNull();
    expect(frameUrl().searchParams.getAll('pv')).toEqual(['DEFAULT']);
  });

  it('a navigate message from another window opens nothing', async () => {
    renderAt('/embed/bts/knob');
    await screen.findByTestId('screen-probe');
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: NAVIGATE_MESSAGE, url: `/embed/@trace?${QUERY_A}` },
          source: window,
          origin: window.location.origin,
        })
      );
    });
    await settle();
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

  it('a framed first-load URL reloaded opens no second tab', async () => {
    sameOriginParent();
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
