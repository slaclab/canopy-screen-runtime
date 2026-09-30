// /edl/<path>: legacy EDM screens rendered directly from the .edl served by
// the display-file endpoint, with query macros.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LocalPVService, MockPVService } from '@slaclab/canopy-client';
import { registerEdmBuiltins } from '@slaclab/canopy-edm';
import { App } from '../App.js';
import { ServicesContext } from '../services.js';
import type { ViewerServices } from '../services.js';

const COLORS = `4 0 0
static 4 "grey-4" { 48059 48059 48059 }
static 14 "black-14" { 0 0 0 }
`;

const EDL = `4 0 1
beginScreenProperties
w 320
h 120
bgColor index 4
title "Test $(P)"
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
  "Device $(P) $(render)"
}
endObjectProperties
object someFutureClass
beginObjectProperties
x 10
y 40
w 50
h 20
endObjectProperties
`;

function stubDisplays(files: Record<string, string>) {
  const impl = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    for (const [suffix, text] of Object.entries(files)) {
      if (url.split('?')[0].endsWith(suffix)) {
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'X-Display-Path': suffix.replace(/^.*\/files\//, '') }),
          text: async () => text,
        } as Response;
      }
    }
    return { ok: false, status: 404, headers: new Headers(), text: async () => '' } as Response;
  });
  vi.stubGlobal('fetch', impl);
  return impl;
}

let services: ViewerServices;

beforeAll(() => registerEdmBuiltins());

beforeEach(() => {
  const pv = new MockPVService();
  pv.connect();
  const locals = new LocalPVService();
  locals.connect();
  services = { pv, formulas: null, locals, hare: null };
});

afterEach(() => {
  cleanup();
  services.pv.disconnect();
  vi.unstubAllGlobals();
});

function renderAt(path: string) {
  return render(
    <ServicesContext.Provider value={services}>
      <MemoryRouter initialEntries={[path]}>
        <App screensBaseUrl="" edmBaseUrl="/displays/v1" />
      </MemoryRouter>
    </ServicesContext.Provider>
  );
}

describe('/edl/<path>', () => {
  it('renders the .edl at its EDM size with query macros; render= is not a macro', async () => {
    const fetchImpl = stubDisplays({
      '/displays/v1/files/misc/test.edl': EDL,
      '/displays/v1/config/colors.list': COLORS,
    });
    renderAt('/edl/misc/test.edl?P=DEV1&render=carbon');
    const root = await screen.findByTestId('screen-root');
    expect(root.style.width).toBe('320px');
    expect(root.style.height).toBe('120px');
    expect(root.dataset.edmPath).toBe('misc/test.edl');
    expect(screen.getByText('Device DEV1 $(render)')).toBeTruthy();
    expect(screen.getByTestId('widget-placeholder').textContent).toBe('someFutureClass');
    expect(fetchImpl.mock.calls.map(([u]) => String(u))).toContain(
      '/displays/v1/files/misc/test.edl'
    );
  });

  it('shows an explicit error when the display cannot be found', async () => {
    stubDisplays({ '/displays/v1/config/colors.list': COLORS });
    renderAt('/edl/misc/missing.edl');
    expect((await screen.findByRole('alert')).textContent).toMatch(/misc\/missing\.edl/);
  });
});
