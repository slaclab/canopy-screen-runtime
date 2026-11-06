// The apply loop wired into the workspace page: a batch the stub hub
// (e2e/workspaceHub.mjs) delivers over the window's event stream is applied
// through the page's own handlers (reducer, dock bridge, zoom store), the
// touched tab, tile bar and zoom control carry data-agent-touched for 1.5 s,
// and one result goes back with the post-apply state. ScreenPage is a probe
// that gives the screen-ready signal on mount; the real dock runs in jsdom.

import { createElement, useEffect } from 'react';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { Manifest } from '../api.js';
import { EmbedThemeContext } from '../pages/EmbedPage.js';
import { ZoomProvider } from '../ZoomContext.js';
import { TOUCHED_ATTR } from './workspaceApply.js';
import { WorkspacePage } from './WorkspacePage.js';

const probe = vi.hoisted(() => {
  // Node 26's unusable global localStorage shadows jsdom's (see WorkspacePage.test.tsx).
  const g = globalThis as { localStorage?: Storage };
  if (typeof g.localStorage?.getItem !== 'function') {
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
  }
  return { ready: [] as string[] };
});

vi.mock('../pages/ScreenPage.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../pages/ScreenPage.js')>();
  function ScreenProbe(props: {
    category?: string;
    id?: string;
    onTitle?: (title: string) => void;
    onReady?: () => void;
  }) {
    const name = `${props.category ?? ''}/${props.id ?? ''}`;
    const { onTitle, onReady } = props;
    useEffect(() => {
      onTitle?.(`Rendered ${props.id ?? ''}`);
    }, [onTitle, props.id]);
    useEffect(() => {
      probe.ready.push(name);
      onReady?.();
    }, [onReady, name]);
    return createElement('div', { 'data-testid': 'screen-probe', 'data-id': props.id });
  }
  return { ...actual, ScreenPage: ScreenProbe };
});

const require = createRequire(import.meta.url);
const STUB_HUB = pathToFileURL(require.resolve('../../e2e/workspaceHub.mjs')).href;

type Sink = { send(event: { event: string; data?: unknown }): void; end(): void };
/** The hub's workspace document, as far as these tests read it. */
interface Doc {
  activeWindow: string | null;
  seq: number;
  results: Record<string, unknown>[];
  state: { tabs: { key: string }[]; zoom: Record<string, unknown> };
}
interface Hub {
  getWorkspace(): Doc;
  setWorkspace(args: { commands: unknown[] }): { batch: { id: string | null; status: string } };
  disconnect(stream: unknown): void;
  close(): void;
}
interface StubModule {
  WorkspaceHub: new (options: { epoch?: string; now?: () => number }) => Hub;
  routeWorkspace(
    hub: Hub,
    request: {
      method: string;
      path: string;
      headers: Record<string, string>;
      body?: string;
      sink?: Sink;
    }
  ): { status: number; body?: unknown; stream?: unknown };
  ADVERTISEMENT: { path: string; protocol: 1 };
}

let stub: StubModule;
beforeAll(async () => {
  stub = (await import(/* @vite-ignore */ STUB_HUB)) as StubModule;
});

const MANIFEST: Manifest = {
  screens: [
    {
      id: 'knob',
      kind: 'ir',
      title: 'Knob',
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
const BASE = 'https://host/screens';

let hub: Hub;

/** The workspace route path of a URL under the advertised prefix, else null. */
function workspacePath(url: string): string | null {
  const u = new URL(url, document.baseURI);
  const prefix = new URL(`${stub.ADVERTISEMENT.path}/`, document.baseURI).pathname;
  return u.pathname.startsWith(prefix) ? u.pathname.slice(prefix.length) + u.search : null;
}

function answer(status: number, body?: unknown): Response {
  const text = body === undefined ? '' : JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => JSON.parse(text),
    text: async () => text,
  } as unknown as Response;
}

class HubStream {
  onerror: ((event: Event) => void) | null = null;
  private closed = false;
  private stream: unknown = null;
  private listeners = new Map<string, ((event: MessageEvent) => void)[]>();
  readonly url: string;
  constructor(url: string) {
    this.url = url;
    queueMicrotask(() => {
      if (this.closed) return;
      const result = stub.routeWorkspace(hub, {
        method: 'GET',
        path: workspacePath(url)!,
        headers: { 'sec-fetch-site': 'same-origin' },
        sink: {
          send: (event) => {
            if (this.closed) return;
            const data = { data: JSON.stringify(event.data ?? {}) } as MessageEvent;
            for (const listener of this.listeners.get(event.event) ?? []) listener(data);
          },
          end: () => this.onerror?.(new Event('error')),
        },
      });
      if (result.status !== 200) this.onerror?.(new Event('error'));
      this.stream = result.stream;
    });
  }
  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close(): void {
    this.closed = true;
    if (this.stream) hub.disconnect(this.stream);
  }
}

beforeEach(() => {
  probe.ready = [];
  hub = new stub.WorkspaceHub({ epoch: 'e1', now: () => Date.now() });
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  vi.stubGlobal('EventSource', HubStream);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const path = workspacePath(url);
      if (path === null) return new Response(JSON.stringify(MANIFEST), { status: 200 });
      const body = typeof init?.body === 'string' ? init.body : undefined;
      const result = stub.routeWorkspace(hub, {
        method: init?.method ?? 'GET',
        path,
        headers: { 'sec-fetch-site': 'same-origin' },
        body,
      });
      return answer(result.status, result.body);
    })
  );
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  hub.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const store of [globalThis.sessionStorage, globalThis.localStorage]) {
    try {
      store?.clear();
    } catch {
      // Storage unavailable.
    }
  }
});

function renderWorkspace(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ZoomProvider>
        <EmbedThemeContext.Provider
          value={{ mode: 'dark', id: 'dark', anchorRef: { current: null } }}
        >
          <WorkspacePage screensBaseUrl={BASE} config={{ workspace: stub.ADVERTISEMENT }} />
        </EmbedThemeContext.Provider>
      </ZoomProvider>
    </MemoryRouter>
  );
}

/** The tab of `key` in its tile's bar (two or more tiles: each tile has a bar). */
function barTab(key: string): HTMLElement {
  return document.querySelector<HTMLElement>(`.canopy-tile-bar__tab[data-tab-key="${key}"]`)!;
}

describe('workspaceApply in the page', () => {
  it('applies a delivered drop + zoom with highlights, and posts one result', async () => {
    renderWorkspace('/embed/bts/knob');
    await waitFor(() => expect(hub.getWorkspace().activeWindow).not.toBeNull());
    await waitFor(() => expect(hub.getWorkspace().seq).toBeGreaterThan(0));

    const enqueued = hub.setWorkspace({
      commands: [
        // A new screen dropped on the dock's outer bottom edge, a tile of its own.
        {
          cmd: 'drop',
          args: { source: { new: { ref: 'common/magnet' } }, target: { outer: 'bottom' } },
        },
        { cmd: 'zoom', args: { key: 'bts/knob', percent: 150 } },
      ],
    });
    expect(enqueued.batch.status).toBe('pending');

    await waitFor(
      () => expect(hub.getWorkspace().results.map((r) => r.status)).toEqual(['applied', 'applied']),
      { timeout: 5_000 }
    );
    const results = hub.getWorkspace().results;
    // drop's one extra is the new item's key (commands/drop.json); it carries no mode.
    expect(results[0]).toMatchObject({ changed: true, key: 'common/magnet' });
    expect(results[0]).not.toHaveProperty('mode');
    expect(results[1]).toMatchObject({ changed: true, percent: 150 });
    // The posted state is the post-apply state.
    const state = hub.getWorkspace().state;
    expect(state.tabs.map((t) => t.key)).toEqual(['bts/knob', 'common/magnet']);
    expect(state.zoom['bts/knob']).toEqual({ mode: 'manual', percent: 150 });

    // Two tiles now: each has its bar, and no strip row is left.
    expect(screen.queryByRole('tablist', { name: 'Open tabs' })).toBeNull();
    expect(barTab('common/magnet').hasAttribute(TOUCHED_ATTR)).toBe(true);
    const zoomControls = document.querySelectorAll(`.screen-header__zoom[${TOUCHED_ATTR}]`);
    expect(zoomControls.length).toBe(1);
    // The new screen gave its ready signal.
    expect(probe.ready).toContain('common/magnet');
    // Highlights end after 1.5 s.
    await waitFor(() => expect(barTab('common/magnet').hasAttribute(TOUCHED_ATTR)).toBe(false), {
      timeout: 3_000,
    });
  });

  it('a destructive close goes through the close path: the agent group and the Undo toast', async () => {
    renderWorkspace('/embed/bts/knob');
    await waitFor(() => expect(hub.getWorkspace().seq).toBeGreaterThan(0));
    hub.setWorkspace({ commands: [{ cmd: 'close_tab', args: { key: 'bts/knob' } }] });
    await waitFor(() => expect(hub.getWorkspace().results).toHaveLength(1), { timeout: 5_000 });
    const [result] = hub.getWorkspace().results;
    expect(result).toMatchObject({ status: 'applied', changed: true });
    expect(typeof result.group).toBe('string');
    await waitFor(() => expect(screen.getByRole('button', { name: /undo/i })).toBeTruthy());
  });
});
