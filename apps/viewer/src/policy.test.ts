import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchScreenPolicy, screenPolicyLoader } from './policy.js';

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function stub(routes: Record<string, unknown>, status = 200) {
  return vi.fn<FetchFn>(async (input) => {
    const body = routes[String(input)];
    if (body === undefined || status !== 200)
      return new Response('{}', { status: status === 200 ? 404 : status });
    return new Response(JSON.stringify(body), { status: 200 });
  });
}

const config = (name: string, data: unknown, lastModifiedDate: string) => ({
  slug: 'x',
  app: 'canopy-viewer',
  name,
  data,
  lastModifiedDate,
});

afterEach(() => vi.restoreAllMocks());

describe('screen variant policy (magpie)', () => {
  it('finds the newest config named screen-variants, sending the API key', async () => {
    const fetchFn = stub({
      'https://canopy/magpie/v1/configs/canopy-viewer?search=screen-variants&pageSize=100': {
        results: [
          config('screen-variants', { default: { impl: 'react' } }, '2026-09-01T00:00:00Z'),
          config('screen-variants-old', { default: { impl: 'pydm' } }, '2026-10-01T00:00:00Z'),
          config('screen-variants', { default: { impl: 'edm' } }, '2026-09-30T00:00:00Z'),
        ],
      },
    });
    const policy = await fetchScreenPolicy({
      canopyBaseUrl: 'https://canopy/',
      apiKey: 'k1',
      fetch: fetchFn,
    });
    expect(policy).toEqual({ default: { impl: 'edm' }, screens: {} });
    expect(new Headers(fetchFn.mock.calls[0][1]?.headers).get('X-API-Key')).toBe('k1');
  });

  it('reads a configured slug directly; no config is no policy', async () => {
    const fetchFn = stub({
      '/magpie/v1/configs/canopy-viewer/Ab12': config(
        'anything',
        { screens: { 'ex/vac': { impl: 'edm', look: 'faithful' } } },
        ''
      ),
      '/magpie/v1/configs/canopy-viewer?search=screen-variants&pageSize=100': { results: [] },
    });
    expect(await fetchScreenPolicy({ canopyBaseUrl: '', slug: 'Ab12', fetch: fetchFn })).toEqual({
      screens: { 'ex/vac': { impl: 'edm', look: 'faithful' } },
    });
    expect(await fetchScreenPolicy({ canopyBaseUrl: '', fetch: fetchFn })).toEqual({ screens: {} });
  });

  it('reads as no policy when magpie fails, once per session', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchFn = stub({}, 500);
    const load = screenPolicyLoader({ canopyBaseUrl: 'https://canopy', fetch: fetchFn });
    expect(await load()).toEqual({ screens: {} });
    expect(await load()).toEqual({ screens: {} });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
