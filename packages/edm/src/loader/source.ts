// Where display files and site config come from. The HTTP source speaks
// Canopy's display-file endpoint, whose base names a display tree
// ({canopy}/displays/v1/edm for EDM):
//
//   GET {base}/files/{path}?relativeTo={dir}   an .edl (or image), searched
//        like EDMDATAFILES: relativeTo's directory, its ancestors, then the
//        site search path; X-Display-Path names the file that was found
//   GET {base}/config/{colors|fonts|calc}.list
//
// With an API key every request carries X-API-Key (never the query string),
// so images are fetched too rather than handed to <img src>. Caching is the
// browser's: the endpoint sends ETags and asks for revalidation.
//
// (canopy-fidelity/tools/edm_direct_serve.mjs serves it for the harness.)

import { parseEdl } from '../parser/edl.js';
import { getFileParser } from '../parser/registry.js';
import type { EdmDocument } from '../model.js';

export interface EdmDisplaySource {
  /** Fetch a display file; `relativeTo` is the path of the referring screen. */
  load(path: string, relativeTo?: string): Promise<{ path: string; text: string }>;
  /** An image (or any other served file) found the same way, as bytes. */
  image(path: string, relativeTo?: string): Promise<Blob>;
  /** URL of a file found the same way (no credentials attached). */
  url(path: string, relativeTo?: string): string;
  config(name: 'colors.list' | 'fonts.list' | 'calc.list'): Promise<string>;
}

export class EdmHttpError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export interface HttpDisplaySourceOptions {
  /** Sent as X-API-Key on every request. */
  readonly apiKey?: string;
  readonly fetch?: typeof fetch;
}

/**
 * A display name as it goes in the files/ URL. The endpoint resolves the name itself, so it
 * must arrive as written. The URL parser would fold "." and ".." segments ("../pps/x.edl",
 * relative to the referring display) into the route, and a leading "/" (a production path
 * the endpoint maps onto its root) would read as an empty segment. Such a name travels as one
 * segment, slashes encoded; any other name is encoded segment by segment and stays readable.
 */
export function displayNameInUrl(name: string): string {
  const segments = name.split('/');
  if (name.startsWith('/') || segments.some((s) => s === '.' || s === '..')) {
    return encodeURIComponent(name);
  }
  return segments.map(encodeURIComponent).join('/');
}

export function httpDisplaySource(
  base: string,
  options: HttpDisplaySourceOptions | typeof fetch = {}
): EdmDisplaySource {
  const opts = typeof options === 'function' ? { fetch: options } : options;
  const fetchFn =
    opts.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const init: RequestInit | undefined = opts.apiKey
    ? { headers: { 'X-API-Key': opts.apiKey } }
    : undefined;
  const root = base.replace(/\/+$/, '');
  const url = (path: string, relativeTo?: string) => {
    const q = relativeTo ? `?relativeTo=${encodeURIComponent(relativeTo)}` : '';
    return `${root}/files/${displayNameInUrl(path)}${q}`;
  };
  const get = async (target: string, what: string) => {
    const res = await (init ? fetchFn(target, init) : fetchFn(target));
    if (!res.ok) throw new EdmHttpError(`${what}: HTTP ${res.status}`, res.status);
    return res;
  };
  return {
    url,
    async load(path, relativeTo) {
      const res = await get(url(path, relativeTo), path);
      return { path: res.headers.get('X-Display-Path') ?? path, text: await res.text() };
    },
    async image(path, relativeTo) {
      return (await get(url(path, relativeTo), path)).blob();
    },
    async config(name) {
      return (await get(`${root}/config/${name}`, name)).text();
    },
  };
}

/** Parse a display file with the parser registered for its extension (.edl by default). */
export function parseDisplay(path: string, text: string): EdmDocument {
  const parser = getFileParser(path) ?? parseEdl;
  return parser(text, path);
}
