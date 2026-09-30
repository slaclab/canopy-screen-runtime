// Where display files and site config come from. The HTTP source speaks the
// planned Canopy endpoint shape:
//
//   GET {base}/files/{path}?relativeTo={dir}   an .edl (or image), searched
//        like EDMDATAFILES: relativeTo's directory, its ancestors, then the
//        site search path; X-Display-Path names the file that was found
//   GET {base}/config/{colors|fonts|calc}.list
//
// (canopy-fidelity/tools/edm_direct_serve.mjs serves it for M0.)

import { parseEdl } from '../parser/edl.js';
import { getFileParser } from '../parser/registry.js';
import type { EdmDocument } from '../model.js';

export interface EdmDisplaySource {
  /** Fetch a display file; `relativeTo` is the path of the referring screen. */
  load(path: string, relativeTo?: string): Promise<{ path: string; text: string }>;
  config(name: 'colors.list' | 'fonts.list' | 'calc.list'): Promise<string>;
}

export class EdmHttpError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export function httpDisplaySource(base: string, fetchFn: typeof fetch = fetch): EdmDisplaySource {
  const root = base.replace(/\/+$/, '');
  const enc = (p: string) => p.split('/').map(encodeURIComponent).join('/');
  return {
    async load(path, relativeTo) {
      const q = relativeTo ? `?relativeTo=${encodeURIComponent(relativeTo)}` : '';
      const res = await fetchFn(`${root}/files/${enc(path.replace(/^\/+/, ''))}${q}`);
      if (!res.ok) throw new EdmHttpError(`${path}: HTTP ${res.status}`, res.status);
      return { path: res.headers.get('X-Display-Path') ?? path, text: await res.text() };
    },
    async config(name) {
      const res = await fetchFn(`${root}/config/${name}`);
      if (!res.ok) throw new EdmHttpError(`${name}: HTTP ${res.status}`, res.status);
      return res.text();
    },
  };
}

/** Parse a display file with the parser registered for its extension (.edl by default). */
export function parseDisplay(path: string, text: string): EdmDocument {
  const parser = getFileParser(path) ?? parseEdl;
  return parser(text, path);
}
