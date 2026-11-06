// Content access: relative refs resolve against the TOP screen document's
// directory under an absolute screens base (no page-origin fallback);
// absolute/root-relative asset refs pass through. Plus the bootstrap URL
// helpers (router basename, absolute screens base).

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchManifest,
  fetchScreenDocument,
  makeResolveAsset,
  makeResolveScreen,
  pollManifest,
  routerBasename,
  screensBaseUrl,
} from './api.js';

const SCREEN_PATH = 'screens/examples/vacuum-system.screen.json';

describe('makeResolveAsset', () => {
  it('resolves a relative filename against the screen directory under baseUrl', () => {
    const resolve = makeResolveAsset('https://host/canopy-screens', SCREEN_PATH);
    expect(resolve('beamline.png')).toBe(
      'https://host/canopy-screens/screens/examples/beamline.png'
    );
    expect(resolve('images/beamline.png')).toBe(
      'https://host/canopy-screens/screens/examples/images/beamline.png'
    );
  });

  it('resolves ../ segments within the base', () => {
    const resolve = makeResolveAsset('https://host/canopy-screens', SCREEN_PATH);
    expect(resolve('../shared/logo.png')).toBe(
      'https://host/canopy-screens/screens/shared/logo.png'
    );
  });

  it('keeps the mount prefix of an absolute base with a trailing slash', () => {
    const resolve = makeResolveAsset('http://h/u/x/panel/canopy/', SCREEN_PATH);
    expect(resolve('beamline.png')).toBe('http://h/u/x/panel/canopy/screens/examples/beamline.png');
  });

  it('has no page-origin fallback: an empty base is rejected', () => {
    expect(() => makeResolveAsset('', SCREEN_PATH)('beamline.png')).toThrow();
  });

  it('handles a screen document at the manifest root (no directory)', () => {
    const resolve = makeResolveAsset('https://host/base', 'top.screen.json');
    expect(resolve('beamline.png')).toBe('https://host/base/beamline.png');
  });

  it('passes absolute URLs and root-relative paths through untouched', () => {
    const resolve = makeResolveAsset('https://host/base', SCREEN_PATH);
    expect(resolve('https://elsewhere/img.png')).toBe('https://elsewhere/img.png');
    expect(resolve('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
    expect(resolve('blob:https://host/1234')).toBe('blob:https://host/1234');
    expect(resolve('/static/img.png')).toBe('/static/img.png');
  });
});

function stubJsonFetch(body: unknown) {
  const impl = vi.fn<(input: RequestInfo | URL) => Promise<Response>>(
    async () => ({ ok: true, status: 200, statusText: 'OK', json: async () => body }) as Response
  );
  vi.stubGlobal('fetch', impl);
  return impl;
}

describe('makeResolveScreen', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('resolves embeds against the TOP document directory under an absolute base', async () => {
    const fetchImpl = stubJsonFetch({ ok: 1 });
    const resolve = makeResolveScreen('http://h/u/x/panel/canopy', SCREEN_PATH);
    await resolve('motor-control.screen.json');
    await resolve('nested/deeper.screen.json');
    expect(fetchImpl.mock.calls.map((c) => String(c[0]))).toEqual([
      'http://h/u/x/panel/canopy/screens/examples/motor-control.screen.json',
      'http://h/u/x/panel/canopy/screens/examples/nested/deeper.screen.json',
    ]);
  });

  it('has no page-origin fallback: an empty base is rejected', async () => {
    stubJsonFetch({});
    await expect(makeResolveScreen('', SCREEN_PATH)('x.screen.json')).rejects.toThrow();
  });

  it('shares one request per URL among concurrent and later embeds', async () => {
    const fetchImpl = stubJsonFetch({ ok: 1 });
    const resolve = makeResolveScreen('http://h/base', SCREEN_PATH);
    const all = await Promise.all([
      resolve('faceplate.screen.json'),
      resolve('faceplate.screen.json'),
      resolve('./faceplate.screen.json'),
      resolve('other.screen.json'),
    ]);
    await resolve('faceplate.screen.json');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(all[0]).toBe(all[1]);
    expect(all[0]).toBe(all[2]);
  });

  it('drops a failed fetch so the next embed retries it', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503, statusText: 'Busy', json: async () => ({}) })
      .mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ ok: 2 }),
      });
    vi.stubGlobal('fetch', fetchImpl);
    const resolve = makeResolveScreen('http://h/base', SCREEN_PATH);
    await expect(resolve('x.screen.json')).rejects.toThrow('503');
    await expect(resolve('x.screen.json')).resolves.toEqual({ ok: 2 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not share between resolvers (a reload builds a new one)', async () => {
    const fetchImpl = stubJsonFetch({ ok: 1 });
    await makeResolveScreen('http://h/base', SCREEN_PATH)('x.screen.json');
    await makeResolveScreen('http://h/base', SCREEN_PATH)('x.screen.json');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('fetchManifest / fetchScreenDocument', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('join onto the base with exactly one slash, with or without a trailing slash', async () => {
    const fetchImpl = stubJsonFetch({ screens: [] });
    await fetchManifest('http://h/u/x/panel/canopy');
    await fetchManifest('http://h/u/x/panel/canopy/');
    await fetchScreenDocument('http://h/u/x/panel/canopy/', SCREEN_PATH);
    expect(fetchImpl.mock.calls.map((c) => String(c[0]))).toEqual([
      'http://h/u/x/panel/canopy/manifest.json',
      'http://h/u/x/panel/canopy/manifest.json',
      `http://h/u/x/panel/canopy/${SCREEN_PATH}`,
    ]);
  });
});

describe('pollManifest', () => {
  afterEach(() => vi.unstubAllGlobals());

  const manifest = { screens: [] };

  it('fetches unconditionally without a validator and returns the ETag it was given', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify(manifest), { status: 200, headers: { ETag: '"m1"' } })
    );
    vi.stubGlobal('fetch', fetchImpl);
    await expect(pollManifest('http://h/base', null)).resolves.toEqual({
      changed: true,
      manifest,
      etag: '"m1"',
    });
    expect(fetchImpl).toHaveBeenCalledWith('http://h/base/manifest.json', { cache: 'no-cache' });
  });

  it('sends If-None-Match past the cache with a validator, and reads a 304 as unchanged', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 304 }));
    vi.stubGlobal('fetch', fetchImpl);
    await expect(pollManifest('http://h/base/', '"m1"')).resolves.toEqual({ changed: false });
    expect(fetchImpl).toHaveBeenCalledWith('http://h/base/manifest.json', {
      cache: 'no-store',
      headers: { 'If-None-Match': '"m1"' },
    });
  });

  it('returns a null etag from a server that sends none', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(manifest), { status: 200 }));
    await expect(pollManifest('http://h/base', null)).resolves.toEqual({
      changed: true,
      manifest,
      etag: null,
    });
  });

  it('throws on a failed status and on a manifest without screens[]', async () => {
    vi.stubGlobal(
      'fetch',
      async () => new Response('nope', { status: 404, statusText: 'Not Found' })
    );
    await expect(pollManifest('http://h/base', null)).rejects.toThrow('404 Not Found');
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 200 }));
    await expect(pollManifest('http://h/base', null)).rejects.toThrow('no screens[] array');
  });
});

describe('routerBasename', () => {
  it('is the base path without its trailing slash', () => {
    expect(routerBasename('http://h/u/x/panel/canopy/')).toBe('/u/x/panel/canopy');
    expect(routerBasename('https://host/canopy/viewer/')).toBe('/canopy/viewer');
  });

  it("is '/' at the origin root", () => {
    expect(routerBasename('http://h/')).toBe('/');
  });
});

describe('screensBaseUrl', () => {
  it('resolves screensPath against the base URI as an absolute URL', () => {
    expect(screensBaseUrl('.', 'http://h/u/x/panel/canopy/')).toBe('http://h/u/x/panel/canopy');
    expect(screensBaseUrl('content/', 'http://h/u/x/panel/canopy/')).toBe(
      'http://h/u/x/panel/canopy/content'
    );
    expect(screensBaseUrl('/screens', 'http://h/u/x/panel/canopy/')).toBe('http://h/screens');
    expect(screensBaseUrl('https://cdn/s/', 'http://h/')).toBe('https://cdn/s');
  });
});
