// The site's variant policy (variants.ts), kept in Canopy's magpie app-config
// store: the config named `screen-variants` of app `canopy-viewer`. Magpie
// gives configs server-made slugs, so the viewer finds it by name (the newest
// one wins) unless a slug is configured (VITE_SCREEN_POLICY_SLUG).
//
//   GET {canopy}/magpie/v1/configs/canopy-viewer?search=screen-variants
//   GET {canopy}/magpie/v1/configs/canopy-viewer/{slug}
//
// A policy that can't be read (Canopy down, no config, no database) means no
// policy: screens open on their first viewable variant, never on an error.

import type { ScreenPolicy } from './variants.js';
import { EMPTY_POLICY, parsePolicy } from './variants.js';

export const POLICY_APP = 'canopy-viewer';
export const POLICY_NAME = 'screen-variants';

export interface PolicyOptions {
  readonly canopyBaseUrl: string;
  readonly apiKey?: string;
  readonly slug?: string;
  readonly fetch?: typeof fetch;
  /** Give up after this long (default 5000 ms). */
  readonly timeoutMs?: number;
}

interface MagpieConfig {
  name?: string | null;
  data?: unknown;
  lastModifiedDate?: string;
}

/** Read the policy; rejects when it can't be read. */
export async function fetchScreenPolicy(opts: PolicyOptions): Promise<ScreenPolicy> {
  const fetchFn =
    opts.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const base = `${opts.canopyBaseUrl.replace(/\/+$/, '')}/magpie/v1/configs/${POLICY_APP}`;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), opts.timeoutMs ?? 5000);
  const get = async (url: string) => {
    const res = await fetchFn(url, {
      headers: opts.apiKey ? { 'X-API-Key': opts.apiKey } : {},
      signal: abort.signal,
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} fetching ${url}`);
    return (await res.json()) as unknown;
  };
  try {
    if (opts.slug) {
      const config = (await get(`${base}/${encodeURIComponent(opts.slug)}`)) as MagpieConfig;
      return parsePolicy(config.data);
    }
    const page = (await get(`${base}?search=${POLICY_NAME}&pageSize=100`)) as {
      results?: MagpieConfig[];
    };
    const named = (page.results ?? [])
      .filter((c) => c.name === POLICY_NAME)
      .sort((a, b) => (b.lastModifiedDate ?? '').localeCompare(a.lastModifiedDate ?? ''));
    return named.length ? parsePolicy(named[0].data) : EMPTY_POLICY;
  } finally {
    clearTimeout(timer);
  }
}

/** Read the policy once; any failure is logged and reads as no policy. */
export function screenPolicyLoader(opts: PolicyOptions): () => Promise<ScreenPolicy> {
  let loaded: Promise<ScreenPolicy> | null = null;
  return () => {
    loaded ??= fetchScreenPolicy(opts).catch((err: unknown) => {
      console.warn('screen variant policy unavailable:', err);
      return EMPTY_POLICY;
    });
    return loaded;
  };
}
