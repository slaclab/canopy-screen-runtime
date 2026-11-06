// ScreenPage opens any Screen IR version this viewer supports (1.0 and 1.1)
// and shows the explicit error panel, naming the supported set, for others.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LocalPVService, MockPVService } from '@slaclab/canopy-client';
import { registerBuiltinWidgets } from '@slaclab/canopy-screen-widgets';
import { ScreenPage } from './ScreenPage.js';
import { ServicesContext } from '../services.js';
import type { ViewerServices } from '../services.js';

// Node >= 25 ships an experimental global `localStorage` that is undefined
// unless --localstorage-file is given, and it shadows jsdom's; install an
// in-memory one before canopy-shell reads it at import time.
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

const PATH = 'screens/examples/themed.screen.json';

const MANIFEST = {
  screens: [
    {
      id: 'themed',
      kind: 'ir',
      title: 'Themed',
      category: 'examples',
      path: PATH,
      macros: [],
      tags: [],
      schemaVersion: '1.1',
    },
  ],
};

function doc(schemaVersion: string) {
  return {
    schemaVersion,
    kind: 'screen',
    id: 'themed',
    metadata: {
      title: 'Themed',
      source: { type: 'hand-authored' },
      size: { width: 200, height: 50 },
    },
    macros: [],
    root: {
      id: 'root',
      type: 'text-label',
      props: { text: `version ${schemaVersion}` },
      geometry: { x: 0, y: 0, width: 200, height: 20 },
    },
  };
}

function stubFetch(screenDoc: unknown) {
  const routes: Record<string, unknown> = { '/manifest.json': MANIFEST, [`/${PATH}`]: screenDoc };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      for (const [suffix, data] of Object.entries(routes)) {
        if (url.split('?')[0].endsWith(suffix))
          return new Response(JSON.stringify(data), { status: 200 });
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

function open() {
  return render(
    <ServicesContext.Provider value={services}>
      <MemoryRouter>
        <ScreenPage
          screensBaseUrl={window.location.origin}
          chrome={false}
          category="examples"
          id="themed"
        />
      </MemoryRouter>
    </ServicesContext.Provider>
  );
}

describe('ScreenPage schema versions', () => {
  it.each(['1.0', '1.1'])('opens a top-level %s screen', async (version) => {
    stubFetch(doc(version));
    open();
    expect(await screen.findByText(`version ${version}`)).toBeTruthy();
    expect(screen.queryByText('Schema version mismatch')).toBeNull();
  });

  it('shows the error panel naming the supported set for 1.2', async () => {
    stubFetch(doc('1.2'));
    open();
    expect(await screen.findByText('Schema version mismatch')).toBeTruthy();
    const detail = screen.getByText(/declares schemaVersion 1\.2/);
    expect(detail.textContent).toContain('1.0, 1.1');
  });
});
