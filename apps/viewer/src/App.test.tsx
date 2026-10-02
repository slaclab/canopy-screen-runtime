// Viewer acceptance: browse/search over the manifest, deep-link rendering of
// the real vacuum-system screen with mock PV data and query macros, and the
// explicit schemaVersion error page.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LocalPVService, MockPVService } from '@slaclab/canopy-client';
import { registerBuiltinWidgets } from '@slaclab/canopy-screen-widgets';
import type { RenderMode } from '@slaclab/canopy-screen-runtime';
import { App } from './App.js';
import { ServicesContext } from './services.js';
import type { ViewerServices } from './services.js';

import vacuumScreen from './test/vacuum-system.screen.json' with { type: 'json' };

const MANIFEST = {
  screens: [
    {
      id: 'vacuum-system',
      kind: 'ir',
      title: 'Vacuum System',
      category: 'examples',
      path: 'screens/examples/vacuum-system.screen.json',
      macros: [
        { name: 'PREFIX', default: 'DEMO:VAC1' },
        { name: 'DEVICE', default: 'Q1' },
      ],
      tags: [],
      schemaVersion: '1.0',
    },
    {
      id: 'pump-panel',
      kind: 'wrapper',
      title: 'Pump Panel (code)',
      category: 'cryo',
      path: 'screens/cryo/pump-panel',
    },
    {
      // A nested id (slash) — must be reachable under the /s/:category/* splat.
      id: 'CBXFEL/Landing',
      kind: 'ir',
      title: 'CBXFEL Landing',
      category: 'examples',
      path: 'screens/examples/CBXFEL/Landing.screen.json',
      macros: [],
      tags: [],
      schemaVersion: '1.0',
    },
  ],
};

const MOTOR_SCREEN = {
  schemaVersion: '1.0',
  kind: 'template',
  id: 'motor-control',
  metadata: {
    title: 'Motor',
    source: { type: 'hand-authored' },
    size: { width: 400, height: 200 },
  },
  macros: [{ name: 'MOTOR' }],
  root: {
    id: 'm-root',
    type: 'text-label',
    props: { text: 'Motor ${MOTOR}' },
    geometry: { x: 0, y: 0, width: 200, height: 20 },
  },
};

/** URL-suffix-matched fetch stub. */
function stubFetch(routes: Record<string, unknown>) {
  const impl = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    for (const [suffix, data] of Object.entries(routes)) {
      if (url.endsWith(suffix)) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => structuredClone(data),
        } as Response;
      }
    }
    return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) } as Response;
  });
  vi.stubGlobal('fetch', impl);
  return impl;
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
  services = { pv, formulas: null, locals, hare: null, createHare: null };
});

afterEach(() => {
  cleanup();
  services.pv.disconnect();
  vi.unstubAllGlobals();
});

function renderAt(path: string, defaultRenderMode?: RenderMode) {
  return render(
    <ServicesContext.Provider value={services}>
      <MemoryRouter initialEntries={[path]}>
        <App screensBaseUrl="" defaultRenderMode={defaultRenderMode} />
      </MemoryRouter>
    </ServicesContext.Provider>
  );
}

describe('browse page', () => {
  it('lists manifest screens as cards, links ir screens, disables code screens', async () => {
    stubFetch({ '/manifest.json': MANIFEST });
    renderAt('/');

    const irCard = (await screen.findByText('Vacuum System')).closest('a');
    expect(irCard).not.toBeNull();
    expect(irCard!.getAttribute('href')).toBe('/s/examples/vacuum-system');

    const codeCard = screen.getByText('Pump Panel (code)').closest('div');
    expect(codeCard!.className).toContain('screen-card--disabled');
    expect(screen.getByText('code screen — not yet viewable')).toBeTruthy();
  });

  it('filters cards by title, category, and id', async () => {
    stubFetch({ '/manifest.json': MANIFEST });
    renderAt('/');
    await screen.findByText('Vacuum System');

    const input = screen.getByPlaceholderText<HTMLInputElement>('Filter by title, category, or id');

    // Category filter hides the non-matching card.
    fireEvent.change(input, { target: { value: 'cryo' } });
    expect(screen.queryByText('Vacuum System')).toBeNull();
    expect(screen.getByText('Pump Panel (code)')).toBeTruthy();

    // Id filter.
    fireEvent.change(input, { target: { value: 'vacuum-sys' } });
    expect(screen.getByText('Vacuum System')).toBeTruthy();
    expect(screen.queryByText('Pump Panel (code)')).toBeNull();

    // No match message.
    fireEvent.change(input, { target: { value: 'zzz' } });
    expect(screen.getByText(/No screens match/)).toBeTruthy();
  });

  it('shows an explicit error when the manifest cannot load', async () => {
    stubFetch({});
    renderAt('/');
    expect(await screen.findByText('Could not load the screen manifest')).toBeTruthy();
  });
});

describe('screen page (deep link)', () => {
  it('renders the vacuum screen with mock data, query macros, and embedded display', async () => {
    stubFetch({
      '/manifest.json': MANIFEST,
      '/screens/examples/vacuum-system.screen.json': vacuumScreen,
      '/screens/examples/motor-control.screen.json': MOTOR_SCREEN,
    });

    renderAt('/s/examples/vacuum-system?PREFIX=XX00:9');

    // AppHeader title comes from the screen metadata.
    expect(await screen.findByText('Vacuum System')).toBeTruthy();
    // The screen canvas rendered.
    const root = await screen.findByTestId('screen-root');
    expect(root.dataset.screenId).toBe('vacuum-system');
    // The embedded display resolved relative to the screen document and its
    // node macros were substituted with the ?PREFIX= query macro.
    expect(await screen.findByText('Motor XX00:9:M1')).toBeTruthy();
    // No widget crashed.
    expect(root.querySelectorAll('[data-testid="widget-error"]')).toHaveLength(0);
  });

  it('shows the explicit schema-mismatch error page (never blank)', async () => {
    stubFetch({
      '/manifest.json': MANIFEST,
      '/screens/examples/vacuum-system.screen.json': { ...vacuumScreen, schemaVersion: '9.9' },
    });

    renderAt('/s/examples/vacuum-system');

    expect(await screen.findByText('Schema version mismatch')).toBeTruthy();
    expect(screen.getByText(/declares schemaVersion 9\.9/)).toBeTruthy();
  });

  it('shows an explicit error for unknown screens', async () => {
    stubFetch({ '/manifest.json': MANIFEST });
    renderAt('/s/examples/nope');
    expect(await screen.findByText("No screen 'examples/nope' in the manifest")).toBeTruthy();
  });

  it('opens a nested screen id (slash) via the splat route', async () => {
    const NESTED = {
      ...MOTOR_SCREEN,
      kind: 'screen',
      id: 'CBXFEL/Landing',
      metadata: { ...MOTOR_SCREEN.metadata, title: 'CBXFEL Landing' },
    };
    stubFetch({
      '/manifest.json': MANIFEST,
      '/screens/examples/CBXFEL/Landing.screen.json': NESTED,
    });
    renderAt('/s/examples/CBXFEL/Landing');
    // Resolves (not the "Page not found" splat-miss) — header shows the title.
    expect(await screen.findByText('CBXFEL Landing')).toBeTruthy();
    expect(screen.queryByText('Page not found')).toBeNull();
  });

  it('explains code screens instead of rendering blank', async () => {
    stubFetch({ '/manifest.json': MANIFEST });
    renderAt('/s/cryo/pump-panel');
    expect(await screen.findByText(/is a wrapper screen/)).toBeTruthy();
  });
});

describe('screen page render mode', () => {
  // A screen whose label shows the value of a `render` macro, if any.
  const MODE_SCREEN = {
    ...MOTOR_SCREEN,
    kind: 'screen',
    id: 'CBXFEL/Landing',
    metadata: { ...MOTOR_SCREEN.metadata, title: 'CBXFEL Landing' },
    macros: [],
    root: { ...MOTOR_SCREEN.root, props: { text: 'render=${render}' } },
  };

  function stubModeScreen() {
    stubFetch({
      '/manifest.json': MANIFEST,
      '/screens/examples/CBXFEL/Landing.screen.json': MODE_SCREEN,
    });
  }

  it("renders in 'edm' mode by default", async () => {
    stubModeScreen();
    renderAt('/s/examples/CBXFEL/Landing');
    expect((await screen.findByTestId('screen-root')).dataset.renderMode).toBe('edm');
  });

  it('uses the configured default (VITE_RENDER_MODE)', async () => {
    stubModeScreen();
    renderAt('/s/examples/CBXFEL/Landing', 'carbon');
    expect((await screen.findByTestId('screen-root')).dataset.renderMode).toBe('carbon');
  });

  it('?render= overrides the default and is not passed on as a macro', async () => {
    stubModeScreen();
    renderAt('/s/examples/CBXFEL/Landing?render=carbon');
    expect((await screen.findByTestId('screen-root')).dataset.renderMode).toBe('carbon');
    // Unresolved macros stay verbatim: `render` never reached the screen.
    expect(screen.getByText('render=${render}')).toBeTruthy();
  });

  it('ignores an unknown ?render= value', async () => {
    stubModeScreen();
    renderAt('/s/examples/CBXFEL/Landing?render=bogus', 'carbon');
    expect((await screen.findByTestId('screen-root')).dataset.renderMode).toBe('carbon');
  });
});
