// ScreenPage validates every document it loads against the full Screen IR
// contract. A document that fails it still renders, beneath a notice that
// names the document and the first problem; a document that passes shows no
// notice.

import '../test/memoryStorage.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LocalPVService, MockPVService } from '@slaclab/canopy-client';
import { registerBuiltinWidgets } from '@slaclab/canopy-screen-widgets';
import { ScreenPage } from './ScreenPage.js';
import { ServicesContext } from '../services.js';
import type { ViewerServices } from '../services.js';

const PATH = 'screens/examples/checked.screen.json';

const MANIFEST = {
  screens: [
    {
      id: 'checked',
      kind: 'ir',
      title: 'Checked',
      category: 'examples',
      path: PATH,
      macros: [],
      tags: [],
      schemaVersion: '1.1',
    },
  ],
};

/** A valid 1.1 screen: one text label; `props` and the root are spread over by each case. */
function doc(props: Record<string, unknown> = {}, root: Record<string, unknown> = {}) {
  return {
    schemaVersion: '1.1',
    kind: 'screen',
    id: 'checked',
    metadata: {
      title: 'Checked',
      source: { type: 'hand-authored' },
      size: { width: 200, height: 50 },
    },
    macros: [],
    root: {
      id: 'root',
      type: 'text-label',
      props: { text: 'the label', ...props },
      geometry: { x: 0, y: 0, width: 200, height: 20 },
    },
    ...root,
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
          id="checked"
        />
      </MemoryRouter>
    </ServicesContext.Provider>
  );
}

const notice = () => screen.queryByTestId('canopy-invalid-screen');

describe('ScreenPage validates the document it loads', () => {
  it('shows a valid document without a notice', async () => {
    stubFetch(doc());
    open();
    expect(await screen.findByText('the label')).toBeTruthy();
    expect(notice()).toBeNull();
  });

  it('renders an invalid document beneath a notice naming the document and the first problem', async () => {
    stubFetch(doc({}, { notes: 'kept by hand' }));
    open();
    expect(await screen.findByText('the label')).toBeTruthy();
    const shown = notice();
    expect(shown).not.toBeNull();
    expect(shown!.textContent).toContain(PATH);
    expect(shown!.textContent).toContain('(root) must NOT have additional properties');
  });

  it('names a malformed colour role in a colour property', async () => {
    stubFetch(doc({ foregroundColor: { $role: 'Text', fallback: 'black' } }));
    open();
    expect(await screen.findByText('the label')).toBeTruthy();
    expect(notice()?.textContent).toContain('/root/props/foregroundColor/fallback');
  });

  it('counts the problems past the first', async () => {
    stubFetch(doc({}, { notes: 'kept by hand', author: 'someone' }));
    open();
    expect(await screen.findByText('the label')).toBeTruthy();
    expect(notice()?.textContent).toMatch(/and \d+ more/);
  });
});
