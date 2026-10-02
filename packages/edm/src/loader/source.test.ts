import { describe, expect, it, vi } from 'vitest';
import { EdmHttpError, httpDisplaySource } from './source.js';

function stub(status = 200, headers: Record<string, string> = {}) {
  return vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
    async () => new Response(status === 200 ? 'body' : null, { status, headers })
  );
}

describe('httpDisplaySource', () => {
  it('finds files relative to the referring screen and reports the path served', async () => {
    const fetchFn = stub(200, { 'X-Display-Path': 'misc/a b.edl' });
    const source = httpDisplaySource('/displays/v1/', fetchFn);
    expect(await source.load('a b.edl', 'misc/top.edl')).toEqual({
      path: 'misc/a b.edl',
      text: 'body',
    });
    expect(String(fetchFn.mock.calls[0][0])).toBe(
      '/displays/v1/files/a%20b.edl?relativeTo=misc%2Ftop.edl'
    );
    expect(fetchFn.mock.calls[0][1]).toBeUndefined();
  });

  it('sends the API key as a header on files, images and config, never in the URL', async () => {
    const fetchFn = stub();
    const source = httpDisplaySource('https://canopy/displays/v1', {
      apiKey: 'k1',
      fetch: fetchFn,
    });
    await source.load('x.edl');
    expect((await source.image('pics/y.png', 'x.edl')).size).toBe(4);
    await source.config('colors.list');
    expect(fetchFn.mock.calls.map(([u]) => String(u))).toEqual([
      'https://canopy/displays/v1/files/x.edl',
      'https://canopy/displays/v1/files/pics/y.png?relativeTo=x.edl',
      'https://canopy/displays/v1/config/colors.list',
    ]);
    for (const [u, init] of fetchFn.mock.calls) {
      expect(new Headers(init?.headers).get('X-API-Key')).toBe('k1');
      expect(String(u)).not.toContain('k1');
    }
  });

  it('sends relative and production names intact; the URL parser does not fold them', () => {
    const source = httpDisplaySource('https://canopy/displays/v1/edm');
    const sent = (name: string, from?: string) => new URL(source.url(name, from)).pathname;
    // EDM resolves "../pps/x.edl" from the referring display; per-segment encoding would let
    // the URL parser turn files/../pps/x.edl into /displays/v1/edm/pps/x.edl.
    expect(sent('../pps/pps_doorsymbol.edl', 'pps/pps_xrt_feh.edl')).toBe(
      '/displays/v1/edm/files/..%2Fpps%2Fpps_doorsymbol.edl'
    );
    expect(sent('./a.edl')).toBe('/displays/v1/edm/files/.%2Fa.edl');
    expect(sent('/path/to/edm/displays/misc/x.edl')).toBe(
      '/displays/v1/edm/files/%2Fpath%2Fto%2Fedm%2Fdisplays%2Fmisc%2Fx.edl'
    );
    expect(sent('misc/a b.edl')).toBe('/displays/v1/edm/files/misc/a%20b.edl');
    expect(decodeURIComponent(sent('../pps/x.edl').split('/files/')[1])).toBe('../pps/x.edl');
  });

  it('rejects with the HTTP status', async () => {
    const source = httpDisplaySource('/d', stub(403));
    await expect(source.load('x.edl')).rejects.toBeInstanceOf(EdmHttpError);
    await expect(source.image('x.png')).rejects.toMatchObject({ status: 403 });
  });
});
