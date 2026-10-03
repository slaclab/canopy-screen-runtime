// /s/<category>/<id> with several variants: the site policy, the link, the
// user's own choice, the header switcher, and the edm variant drawn from the
// static EDM display tree.

import { useEffect } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { LocalPVService, MockPVService } from '@slaclab/canopy-client';
import { registerBuiltinWidgets } from '@slaclab/canopy-screen-widgets';
import { registerEdmBuiltins } from '@slaclab/canopy-edm';
import { App } from '../App.js';
import { memoryPreferences } from '../preferences.js';
import type { VariantPreferences } from '../preferences.js';
import { ServicesContext } from '../services.js';
import type { ViewerServices } from '../services.js';
import { parsePolicy } from '../variants.js';

const MANIFEST = {
  screens: [
    // The shape canopy-screens' build-manifest writes: impl and look on every entry.
    {
      id: 'vacuum-system',
      kind: 'ir',
      impl: 'react',
      look: null,
      title: 'Vacuum System',
      category: 'examples',
      path: 'screens/examples/vacuum-system.screen.json',
      macros: [],
      tags: [],
      schemaVersion: '1.0',
    },
    {
      id: 'vacuum-system',
      kind: 'edl',
      impl: 'edm',
      look: 'faithful',
      title: 'Vacuum System',
      category: 'examples',
      path: 'vac/vacuum.edl',
      macros: [],
      tags: [],
      schemaVersion: null,
    },
  ],
};

const IR_SCREEN = {
  schemaVersion: '1.0',
  kind: 'screen',
  id: 'vacuum-system',
  metadata: {
    title: 'Vacuum System',
    source: { type: 'hand-authored' },
    size: { width: 400, height: 200 },
  },
  macros: [],
  root: {
    id: 'root',
    type: 'text-label',
    props: { text: 'IR P=${P} impl=${impl}' },
    geometry: { x: 0, y: 0, width: 300, height: 20 },
  },
};

const COLORS = `4 0 0
static 4 "grey-4" { 48059 48059 48059 }
static 14 "black-14" { 0 0 0 }
`;

const EDL = `4 0 1
beginScreenProperties
w 320
h 120
bgColor index 4
endScreenProperties
object activeXTextClass
beginObjectProperties
x 10
y 10
w 200
h 20
fgColor index 14
useDisplayBg
value {
  "EDM P=$(P) impl=$(impl)"
}
endObjectProperties
`;

const ROUTES: Record<string, () => Response> = {
  '/manifest.json': () => Response.json(MANIFEST),
  '/screens/examples/vacuum-system.screen.json': () => Response.json(IR_SCREEN),
  '/displays/edm/index.json': () => Response.json({ files: ['vac/vacuum.edl'] }),
  '/displays/edm/vac/vacuum.edl': () => new Response(EDL),
  '/displays/edm/config/colors.list': () => new Response(COLORS),
};

let fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>;
let services: ViewerServices;
let prefs: VariantPreferences;

beforeAll(() => {
  registerBuiltinWidgets();
  registerEdmBuiltins();
});

beforeEach(() => {
  fetchImpl = vi.fn<typeof fetch>(async (input) => {
    const route = ROUTES[String(input).split('?')[0]];
    return route ? route() : new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchImpl);
  const pv = new MockPVService();
  pv.connect();
  const locals = new LocalPVService();
  locals.connect();
  prefs = memoryPreferences();
  services = {
    pv,
    formulas: null,
    locals,
    hare: null,
    createHare: null,
    preferences: prefs,
    screenPolicy: async () =>
      parsePolicy({ screens: { 'examples/vacuum-system': { impl: 'edm', look: 'faithful' } } }),
  };
});

afterEach(() => {
  cleanup();
  services.pv.disconnect();
  vi.unstubAllGlobals();
});

/** The router's current location, for assertions. */
const where = { url: '' };
function Where() {
  const l = useLocation();
  useEffect(() => {
    where.url = `${l.pathname}${l.search}`;
  }, [l]);
  return null;
}

function renderAt(path: string) {
  return render(
    <ServicesContext.Provider value={services}>
      <MemoryRouter initialEntries={[path]}>
        <App screensBaseUrl="" edmBaseUrl="/displays/edm" />
        <Where />
      </MemoryRouter>
    </ServicesContext.Provider>
  );
}

const switcher = () => screen.getByLabelText<HTMLSelectElement>('Screen variant');

describe('screen variants', () => {
  it('opens the variant the site policy names, drawn from the .edl', async () => {
    renderAt('/s/examples/vacuum-system?P=DEV1');
    const root = await screen.findByTestId('screen-root');
    expect(root.dataset.edmPath).toBe('vac/vacuum.edl');
    expect(await screen.findByText('EDM P=DEV1 impl=$(impl)')).toBeTruthy();
    expect(switcher().selectedOptions[0].textContent).toBe('EDM · faithful');
    expect(screen.getByText('site default')).toBeTruthy();
  });

  it('a link chooses the variant; impl and look are not macros', async () => {
    renderAt('/s/examples/vacuum-system?P=DEV1&impl=react');
    expect(await screen.findByText('IR P=DEV1 impl=${impl}')).toBeTruthy();
    expect((await screen.findByTestId('screen-root')).dataset.screenId).toBe('vacuum-system');
    expect(screen.getByText('from the link')).toBeTruthy();
  });

  it('the switcher links to another variant, keeping the macros', async () => {
    renderAt('/s/examples/vacuum-system?P=DEV1&impl=react');
    await screen.findByText('IR P=DEV1 impl=${impl}');
    fireEvent.change(switcher(), { target: { value: '1' } });
    expect(await screen.findByText('EDM P=DEV1 impl=$(impl)')).toBeTruthy();
    expect(where.url).toBe('/s/examples/vacuum-system?P=DEV1&impl=edm&look=faithful');
  });

  it("keeps the user's choice over the site's, until they forget it", async () => {
    renderAt('/s/examples/vacuum-system?P=DEV1&impl=react');
    await screen.findByText('IR P=DEV1 impl=${impl}');
    fireEvent.click(screen.getByText('Always open this'));
    expect(prefs.get('examples/vacuum-system')).toEqual({ impl: 'react' });
    expect(where.url).toBe('/s/examples/vacuum-system?P=DEV1');
    expect(await screen.findByText('your choice')).toBeTruthy();
    expect(screen.getByText('IR P=DEV1 impl=${impl}')).toBeTruthy();

    fireEvent.click(screen.getByText('Use site default'));
    expect(prefs.get('examples/vacuum-system')).toBeNull();
    expect(await screen.findByText('EDM P=DEV1 impl=$(impl)')).toBeTruthy();
    expect(screen.getByText('site default')).toBeTruthy();
  });

  it('explains a link to a variant the screen does not have', async () => {
    renderAt('/s/examples/vacuum-system?impl=pydm');
    expect(await screen.findByText("No 'pydm' variant of 'examples/vacuum-system'")).toBeTruthy();
    expect(screen.getByText('This screen has: Screen IR, EDM · faithful.')).toBeTruthy();
  });

  it('opens the first listed variant when there is no policy', async () => {
    services.screenPolicy = undefined;
    renderAt('/s/examples/vacuum-system?P=DEV1');
    expect(await screen.findByText('IR P=DEV1 impl=${impl}')).toBeTruthy();
    expect(screen.getByText('first listed')).toBeTruthy();
  });

  it('reads the static display tree with no credentials', async () => {
    renderAt('/s/examples/vacuum-system?P=DEV1');
    await screen.findByText('EDM P=DEV1 impl=$(impl)');
    const edm = fetchImpl.mock.calls.filter(([u]) => String(u).startsWith('/displays/edm/'));
    expect(edm.map(([u]) => String(u))).toContain('/displays/edm/vac/vacuum.edl');
    for (const [, init] of fetchImpl.mock.calls) {
      expect(new Headers(init?.headers).get('X-API-Key')).toBeNull();
    }
  });

  it('browses one card per screen, listing its variants', async () => {
    renderAt('/');
    const card = (await screen.findByText('Vacuum System')).closest('a');
    expect(card?.getAttribute('href')).toBe('/s/examples/vacuum-system');
    expect(screen.getByText('Screen IR / EDM · faithful')).toBeTruthy();
    expect(screen.getAllByText('Vacuum System')).toHaveLength(1);
  });
});
