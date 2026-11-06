// WorkspacePage's half of in-place navigation from the host: the page
// posts canopy-host-navigate-ready to window.parent once its handler is installed
// and in reply to every probe from that parent; canopy-host-navigate is taken only
// from window.parent with the page's origin, the router basename is stripped,
// ?_canopyOpen=<ref> runs the collections deep link, and any other path opens
// through the outside-URL effect (append; focus when already open).
// window.parent is a real same-origin frame window (an iframe's
// contentWindow), so MessageEvent accepts it as a source; ScreenPage is a
// probe and fetch serves the manifest and the collections store.

import { createElement, useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import type { Manifest } from '../api.js';
import { EmbedThemeContext } from '../pages/EmbedPage.js';
import { ZoomProvider } from '../ZoomContext.js';
import { tabsStorageKey } from './tabs.js';
import {
  NAVIGATE_MESSAGE,
  NAVIGATE_PROBE,
  NAVIGATE_READY,
  routerPath,
} from './host/useHostNavigation.js';
import { WorkspacePage } from './WorkspacePage.js';

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
    {
      id: 'magnet',
      kind: 'ir',
      title: 'Magnet',
      category: 'common',
      path: 'screens/common/magnet.screen.json',
    },
  ],
};

const LIST = {
  collections: [
    {
      source: 'facility',
      ref: 'facility:ops',
      id: 'ops',
      name: 'Ops',
      members: [{ screen: 'bts/knob' }, { screen: 'common/magnet' }],
    },
  ],
};

const STATE = { ticked: [], unticked: [], pinned: [], recent: [] };
const BASE = 'https://host/screens';
const ALICE = '/u/alice/panel/canopy';

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

let fetchMock: ReturnType<typeof vi.fn<(input: unknown, init?: RequestInit) => Promise<Response>>>;
let host: Window;
let frame: HTMLIFrameElement;
let posted: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/collections-state')) return json(STATE);
    if (url.endsWith('/collections') && (init?.method ?? 'GET') === 'GET') return json(LIST);
    return json(MANIFEST);
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  frame = document.createElement('iframe');
  document.body.appendChild(frame);
  host = frame.contentWindow!;
  posted = vi.fn();
  host.postMessage = posted as unknown as Window['postMessage'];
  vi.spyOn(window, 'parent', 'get').mockReturnValue(host as Window & typeof globalThis);
});

afterEach(() => {
  cleanup();
  frame.remove();
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

function renderAt(path: string, options: { mount?: string; collections?: boolean } = {}) {
  const mount = options.mount;
  const config = options.collections ? { collections: { path: 'collections' } } : undefined;
  return render(
    <MemoryRouter basename={mount} initialEntries={[`${mount ?? ''}${path}`]}>
      <ZoomProvider>
        <EmbedThemeContext.Provider
          value={{ mode: 'dark', id: 'dark', anchorRef: { current: null } }}
        >
          <WorkspacePage screensBaseUrl={BASE} config={config} />
          <LocationProbe />
        </EmbedThemeContext.Provider>
      </ZoomProvider>
    </MemoryRouter>
  );
}

function here(): string {
  return screen.getByTestId('location').textContent ?? '';
}

function storedKeys(mount?: string): string[] | undefined {
  const raw = sessionStorage.getItem(tabsStorageKey(mount ?? '/'));
  return raw === null ? undefined : (JSON.parse(raw) as { keys: string[] }).keys;
}

function storedActive(mount?: string): string | null | undefined {
  const raw = sessionStorage.getItem(tabsStorageKey(mount ?? '/'));
  return raw === null ? undefined : (JSON.parse(raw) as { active: string | null }).active;
}

function send(data: unknown, source: Window = host, origin = window.location.origin) {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data, source, origin }));
  });
}

function readyPosts(): number {
  return posted.mock.calls.filter(
    ([msg, origin]) =>
      (msg as { type?: string }).type === NAVIGATE_READY && origin === window.location.origin
  ).length;
}

function listGets(): number {
  return fetchMock.mock.calls.filter(
    ([u, init]) => String(u).endsWith('/collections') && (init?.method ?? 'GET') === 'GET'
  ).length;
}

describe('navigation readiness', () => {
  it('posts canopy-host-navigate-ready to the parent on mount, with the page origin', async () => {
    renderAt('/embed/bts/knob');
    await screen.findByTestId('screen-probe');
    expect(readyPosts()).toBe(1);
    expect(posted).toHaveBeenCalledWith({ type: NAVIGATE_READY }, window.location.origin);
  });

  it('answers every probe from the parent with ready', async () => {
    renderAt('/embed/bts/knob');
    await screen.findByTestId('screen-probe');
    send({ type: NAVIGATE_PROBE });
    send({ type: NAVIGATE_PROBE });
    expect(readyPosts()).toBe(3);
  });

  it('ignores a probe from another window or origin', async () => {
    renderAt('/embed/bts/knob');
    await screen.findByTestId('screen-probe');
    send({ type: NAVIGATE_PROBE }, window);
    send({ type: NAVIGATE_PROBE }, host, 'https://evil.example');
    expect(readyPosts()).toBe(1);
  });

  it('posts nothing standalone (window.parent === window)', async () => {
    vi.spyOn(window, 'parent', 'get').mockReturnValue(window as Window & typeof globalThis);
    const self = vi.spyOn(window, 'postMessage');
    renderAt('/embed/bts/knob');
    await screen.findByTestId('screen-probe');
    expect(self).not.toHaveBeenCalled();
    expect(posted).not.toHaveBeenCalled();
  });
});

describe('canopy-host-navigate', () => {
  it('a path URL appends its tab, and focuses one already open', async () => {
    renderAt('/embed/bts/knob');
    await screen.findByTestId('screen-probe');
    send({ type: NAVIGATE_MESSAGE, url: '/embed/common/magnet' });
    await waitFor(() => expect(storedKeys()).toEqual(['bts/knob', 'common/magnet']));
    expect(storedActive()).toBe('common/magnet');
    expect(here()).toBe('/embed/common/magnet');
    send({ type: NAVIGATE_MESSAGE, url: '/embed/bts/knob' });
    await waitFor(() => expect(storedActive()).toBe('bts/knob'));
    expect(storedKeys()).toEqual(['bts/knob', 'common/magnet']);
  });

  it('strips the router basename from the URL', async () => {
    renderAt('/embed/bts/knob', { mount: ALICE });
    await screen.findByTestId('screen-probe');
    send({ type: NAVIGATE_MESSAGE, url: `${ALICE}/embed/common/magnet` });
    await waitFor(() => expect(storedKeys(ALICE)).toEqual(['bts/knob', 'common/magnet']));
    expect(here()).toBe('/embed/common/magnet');
  });

  it('rejects a navigate from another window or origin', async () => {
    renderAt('/embed/bts/knob');
    await screen.findByTestId('screen-probe');
    send({ type: NAVIGATE_MESSAGE, url: '/embed/common/magnet' }, window);
    send({ type: NAVIGATE_MESSAGE, url: '/embed/common/magnet' }, host, 'https://evil.example');
    send({ type: NAVIGATE_MESSAGE, url: 'https://evil.example/embed/common/magnet' });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(here()).toBe('/embed/bts/knob');
    expect(storedKeys()).toEqual(['bts/knob']);
  });

  it('?_canopyOpen=<ref> runs Open all of that collection once', async () => {
    renderAt('/embed/', { collections: true });
    await waitFor(() => expect(listGets()).toBeGreaterThan(0));
    await waitFor(() => expect(screen.getByTestId('workspace-empty')).toBeTruthy());
    send({ type: NAVIGATE_MESSAGE, url: '/embed/?_canopyOpen=facility%3Aops' });
    await waitFor(() => expect(storedKeys()).toEqual(['bts/knob', 'common/magnet']));
    // The deep link is not a URL navigation: nothing is written for it.
    expect(here()).not.toContain('_canopyOpen');
    // A later list refresh or re-render does not run it again.
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(storedKeys()).toEqual(['bts/knob', 'common/magnet']);
  });

  it('a deep link that arrives before the first list settles is held, then runs', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
      if (String(input).endsWith('/collections')) await gate;
      return base(input, init);
    });
    renderAt('/embed/', { collections: true });
    send({ type: NAVIGATE_MESSAGE, url: '/embed/?_canopyOpen=facility%3Aops' });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(storedKeys() ?? []).toEqual([]);
    await act(async () => {
      release();
      await gate;
    });
    await waitFor(() => expect(storedKeys()).toEqual(['bts/knob', 'common/magnet']));
  });
});

describe('routerPath', () => {
  it('strips the basename and keeps the search', () => {
    expect(routerPath(`${ALICE}/embed/a/b?X=1`, ALICE)).toEqual({
      pathname: '/embed/a/b',
      search: '?X=1',
    });
    expect(routerPath(`${ALICE}/embed/a/b`, `${ALICE}/`)).toEqual({
      pathname: '/embed/a/b',
      search: '',
    });
    expect(routerPath('/embed/a/b', '/')).toEqual({ pathname: '/embed/a/b', search: '' });
  });

  it('refuses another origin and a path outside the basename', () => {
    expect(routerPath('https://evil.example/embed/a/b', '/')).toBeNull();
    expect(routerPath('/u/bob/panel/canopy/embed/a/b', ALICE)).toBeNull();
    expect(routerPath(`${ALICE}x/embed/a/b`, ALICE)).toBeNull();
  });
});
