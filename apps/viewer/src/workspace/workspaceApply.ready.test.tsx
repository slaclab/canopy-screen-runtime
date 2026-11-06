// The screen page's screen-ready signal (ScreenPage onReady), which the
// workspace apply loop's input guard waits for after it mounted a screen: once
// per loaded document, after its ready render with every embed it asked for
// resolved or failed; once for a load error.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LocalPVService, MockPVService } from '@slaclab/canopy-client';
import { registerBuiltinWidgets } from '@slaclab/canopy-screen-widgets';
import { EMBED_QUIET_MS, ScreenPage } from '../pages/ScreenPage.js';
import { ServicesContext } from '../services.js';
import type { ViewerServices } from '../services.js';

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

const PATH = 'screens/examples/parent.screen.json';
const MANIFEST = {
  screens: [
    {
      id: 'parent',
      kind: 'ir',
      title: 'Parent',
      category: 'examples',
      path: PATH,
      macros: [],
      tags: [],
    },
  ],
};

function screenDoc(id: string, root: Record<string, unknown>) {
  return {
    schemaVersion: '1.1',
    kind: 'screen',
    id,
    metadata: { title: id, source: { type: 'hand-authored' }, size: { width: 200, height: 50 } },
    macros: [],
    root,
  };
}

const LABEL = {
  id: 'label',
  type: 'text-label',
  props: { text: 'child' },
  geometry: { x: 0, y: 0, width: 200, height: 20 },
};
const EMBED = {
  id: 'embed',
  type: 'embedded-display',
  props: { file: 'child.screen.json' },
  geometry: { x: 0, y: 0, width: 200, height: 50 },
};

let child: { resolve: (ok: boolean) => void } | null = null;
let childRequests = 0;

function stubFetch(parent: unknown | null) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input).split('?')[0]!;
      if (url.endsWith('/manifest.json')) return new Response(JSON.stringify(MANIFEST));
      if (url.endsWith(`/${PATH}`) && parent !== null) return new Response(JSON.stringify(parent));
      if (url.endsWith('/child.screen.json')) {
        childRequests += 1;
        return new Promise<Response>((resolve) => {
          child = {
            resolve: (ok) =>
              resolve(
                ok
                  ? new Response(JSON.stringify(screenDoc('child', LABEL)))
                  : new Response('{}', { status: 404, statusText: 'Not Found' })
              ),
          };
        });
      }
      return new Response('{}', { status: 404, statusText: 'Not Found' });
    })
  );
}

let services: ViewerServices;
beforeAll(() => registerBuiltinWidgets());
beforeEach(() => {
  child = null;
  childRequests = 0;
  const pv = new MockPVService();
  pv.connect();
  const locals = new LocalPVService();
  locals.connect();
  services = { pv, formulas: null, locals, screenScope: () => ({ pv, formulas: null, locals }) };
});
afterEach(() => {
  cleanup();
  services.pv.disconnect();
  vi.unstubAllGlobals();
});

function open(onReady: () => void) {
  return render(
    <ServicesContext.Provider value={services}>
      <MemoryRouter>
        <ScreenPage
          screensBaseUrl={window.location.origin}
          chrome={false}
          category="examples"
          id="parent"
          onReady={onReady}
        />
      </MemoryRouter>
    </ServicesContext.Provider>
  );
}

const wait = (ms: number) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));

describe('workspaceApply screen-ready signal', () => {
  it('waits for the embeds, then signals once', async () => {
    stubFetch(screenDoc('parent', EMBED));
    const onReady = vi.fn();
    open(onReady);
    await vi.waitFor(() => expect(childRequests).toBe(1));
    await wait(EMBED_QUIET_MS * 4);
    expect(onReady).not.toHaveBeenCalled();
    await act(async () => child!.resolve(true));
    await vi.waitFor(() => expect(onReady).toHaveBeenCalledTimes(1));
    await wait(EMBED_QUIET_MS * 4);
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it('a failed embed settles too', async () => {
    stubFetch(screenDoc('parent', EMBED));
    const onReady = vi.fn();
    open(onReady);
    await vi.waitFor(() => expect(childRequests).toBe(1));
    await act(async () => child!.resolve(false));
    await vi.waitFor(() => expect(onReady).toHaveBeenCalledTimes(1));
  });

  it('a screen without embeds signals after its ready render', async () => {
    stubFetch(screenDoc('parent', LABEL));
    const onReady = vi.fn();
    open(onReady);
    await vi.waitFor(() => expect(onReady).toHaveBeenCalledTimes(1));
  });

  it('a load error signals', async () => {
    stubFetch(null);
    const onReady = vi.fn();
    open(onReady);
    await vi.waitFor(() => expect(onReady).toHaveBeenCalledTimes(1));
  });
});
