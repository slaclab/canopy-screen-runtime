// The Trace and correlation iframes (TraceTab) key on the backend's last
// non-null binding as well as on their instance epoch: a heartbeat that moves
// the data connection to another binding remounts (reloads) both, so their
// archive queries go to the new target. A first heartbeat after config.json
// served a null binding is not a move (the page never had a target to leave)
// and remounts nothing; nor does a status change, a repeated binding or a
// heartbeat that clears the binding.
//
// Renders the real WorkspacePage inside a ServicesContext that carries a real
// badge store; a frame is "remounted" when its DOM node is a different one.

import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { createBackendBadgeStore } from '../backendBadge.js';
import type { BackendBadgeSeed, BackendBadgeStore } from '../backendBadge.js';
import type { Manifest } from '../api.js';
import type { TraceConfig } from '../config.js';
import { EmbedThemeContext } from '../pages/EmbedPage.js';
import { ServicesContext } from '../services.js';
import type { ViewerServices } from '../services.js';
import { ZoomProvider } from '../ZoomContext.js';
import { tabsStorageKey } from './tabs.js';
import { WorkspacePage } from './WorkspacePage.js';

// Node 26's global `localStorage` is undefined without --localstorage-file and
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

// Only tool tabs are open; no screen renders.
vi.mock('../pages/ScreenPage.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../pages/ScreenPage.js')>();
  return { ...actual, ScreenPage: () => createElement('div', { 'data-testid': 'screen-probe' }) };
});

type Heartbeat = Parameters<BackendBadgeStore['setBackend']>[0];

const MANIFEST: Manifest = { screens: [] };
const TRACE: TraceConfig = { path: 'trace/', query: 'pv=A&range=-1h' };
const CORR: TraceConfig = { path: 'trace/correlation.html', query: 'n=500' };
const KEYS = ['@trace', '@correlation'] as const;

const SIM: BackendBadgeSeed = {
  backend: { name: 'example', label: 'Simulator', notice: null },
  binding: 'va@3',
};
const NO_DATA: BackendBadgeSeed = { backend: null, binding: null };

function beat(binding: string | null, label: string | null = 'Simulator'): Heartbeat {
  return { name: 'example', label, notice: null, binding, reachable: null, writes: null };
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(MANIFEST), { status: 200 }))
  );
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  sessionStorage.setItem(
    tabsStorageKey('/'),
    JSON.stringify({ keys: [...KEYS], active: '@trace', instances: {}, toolMru: ['@trace'] })
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

const DARK = { mode: 'dark', id: 'dark', anchorRef: { current: null } } as const;

/** Render the workspace with both tools open over `store` (none: no provider). */
function renderPage(store: BackendBadgeStore | null) {
  const page = (
    <WorkspacePage
      screensBaseUrl="https://host/screens"
      config={{ trace: TRACE, correlation: CORR }}
    />
  );
  const services = store ? ({ backend: store } as unknown as ViewerServices) : null;
  return render(
    <MemoryRouter initialEntries={['/embed/@trace']}>
      <ZoomProvider>
        <EmbedThemeContext.Provider value={DARK}>
          {services ? (
            <ServicesContext.Provider value={services}>{page}</ServicesContext.Provider>
          ) : (
            page
          )}
        </EmbedThemeContext.Provider>
      </ZoomProvider>
    </MemoryRouter>
  );
}

function frame(key: string): HTMLIFrameElement {
  const el = document.querySelector(`iframe[data-tab-key="${key}"]`);
  if (!(el instanceof HTMLIFrameElement)) throw new Error(`no iframe for ${key}`);
  return el;
}

/** The current frame of each open tool, by key. */
function frames(): Record<string, HTMLIFrameElement> {
  return Object.fromEntries(KEYS.map((key) => [key, frame(key)]));
}

/** True when every tool's frame is still the node in `before`. */
function sameFrames(before: Record<string, HTMLIFrameElement>): boolean {
  return KEYS.every((key) => frame(key) === before[key] && before[key]!.isConnected);
}

/** True when every tool's frame is a new node and the old one is gone. */
function remounted(before: Record<string, HTMLIFrameElement>): boolean {
  return KEYS.every((key) => frame(key) !== before[key] && !before[key]!.isConnected);
}

function feed(store: BackendBadgeStore, ...steps: (Heartbeat | 'connected' | 'disconnected')[]) {
  act(() => {
    for (const step of steps) {
      if (typeof step === 'string') store.setStatus(step);
      else store.setBackend(step);
    }
  });
}

describe('Trace and correlation iframes key on the last non-null binding', () => {
  it('keep their frames on heartbeats repeating the config binding and on status changes', () => {
    const store = createBackendBadgeStore(SIM);
    renderPage(store);
    const before = frames();
    feed(store, 'connected', beat('va@3'));
    expect(sameFrames(before)).toBe(true);
    feed(store, 'disconnected', 'connected', beat('va@3'));
    expect(sameFrames(before)).toBe(true);
  });

  it('remount both frames when a heartbeat moves the binding', () => {
    const store = createBackendBadgeStore(SIM);
    renderPage(store);
    const before = frames();
    feed(store, 'connected', beat('va@4'));
    expect(remounted(before)).toBe(true);
    // The new frames keep their tool's src (path and query).
    expect(new URL(frame('@trace').src).pathname.endsWith('/trace/')).toBe(true);
    expect(new URL(frame('@correlation').src).pathname.endsWith('/trace/correlation.html')).toBe(
      true
    );
  });

  it('do not remount on the first heartbeat after a null config binding', () => {
    const store = createBackendBadgeStore(NO_DATA);
    renderPage(store);
    const before = frames();
    feed(store, 'connected', beat('va@3'));
    expect(sameFrames(before)).toBe(true);
    // A later move is a real one.
    feed(store, beat('va@4'));
    expect(remounted(before)).toBe(true);
  });

  it('do not remount on the first heartbeat when config.json sent no binding block', () => {
    const store = createBackendBadgeStore({});
    renderPage(store);
    const before = frames();
    feed(store, 'connected', beat('va@3'));
    expect(sameFrames(before)).toBe(true);
  });

  it('do not remount when a heartbeat clears the binding, nor when the same one returns', () => {
    const store = createBackendBadgeStore(SIM);
    renderPage(store);
    const before = frames();
    feed(store, 'connected', beat(null, null));
    expect(sameFrames(before)).toBe(true);
    feed(store, beat('va@3'));
    expect(sameFrames(before)).toBe(true);
  });

  it('remount on every move, back to an earlier binding included', () => {
    const store = createBackendBadgeStore(SIM);
    renderPage(store);
    const first = frames();
    feed(store, beat('va@4'));
    expect(remounted(first)).toBe(true);
    const second = frames();
    feed(store, beat('va@3'));
    expect(remounted(second)).toBe(true);
  });

  it('a move made while a binding was cleared still remounts', () => {
    const store = createBackendBadgeStore(SIM);
    renderPage(store);
    const before = frames();
    feed(store, beat(null, null));
    expect(sameFrames(before)).toBe(true);
    feed(store, beat('va@4'));
    expect(remounted(before)).toBe(true);
  });

  it('render the frames without a ServicesContext (mock, fixture and component tests)', () => {
    renderPage(null);
    expect(frame('@trace')).toBeTruthy();
    expect(frame('@correlation')).toBeTruthy();
  });
});
