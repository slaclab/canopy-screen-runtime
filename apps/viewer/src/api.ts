// canopy-screens content access: manifest + screen documents.

import type { ScreenJSON } from '@slaclab/canopy-screen-ir';
import type { ResolveAsset, ResolveScreen } from '@slaclab/canopy-screen-runtime';

/** One entry of the content repo's generated manifest.json. */
export interface ManifestScreen {
  id: string;
  /** 'ir' renders here; 'wrapper'/'code' screens are code-based (not yet viewable). */
  kind: string;
  title: string;
  category: string;
  /** Repo-relative path of the document, e.g. screens/examples/x.screen.json */
  path: string;
  macros?: { name: string; default?: string; description?: string }[];
  tags?: string[];
  schemaVersion?: string;
  /** Content revision (served by canopy_mcp for drafts); changes when the document does. */
  rev?: string;
}

export interface Manifest {
  screens: ManifestScreen[];
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const response = await (init ? fetch(url, init) : fetch(url));
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} fetching ${url}`);
  }
  return response.json();
}

// Every baseUrl below is an ABSOLUTE screens base URL (see screensBaseUrl);
// a trailing slash is tolerated.
function withSlash(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/`;
}

/** `fresh` fetches past the HTTP cache (`cache: 'no-cache'`). */
export async function fetchManifest(
  baseUrl: string,
  options?: { fresh?: boolean }
): Promise<Manifest> {
  const url = `${withSlash(baseUrl)}manifest.json`;
  const data = (await fetchJson(
    url,
    options?.fresh ? { cache: 'no-cache' } : undefined
  )) as Manifest;
  if (!Array.isArray(data.screens)) {
    throw new Error('manifest.json has no screens[] array');
  }
  return data;
}

/** One manifest poll: the manifest with its validator, or unchanged (a 304). */
export type ManifestPoll =
  | { changed: true; manifest: Manifest; etag: string | null }
  | { changed: false };

/**
 * Fetch `manifest.json` past the HTTP cache — conditionally once `etag` is
 * the validator of the manifest last seen: the request then carries
 * `If-None-Match` and a 304 answers `{ changed: false }` with nothing parsed.
 * The conditional request is `no-store` so the 304 is the response this
 * code sees, not one the browser's cache turns back into the cached 200. A
 * server that sends no ETag answers 200 every time, exactly as before.
 */
export async function pollManifest(baseUrl: string, etag: string | null): Promise<ManifestPoll> {
  const url = `${withSlash(baseUrl)}manifest.json`;
  const init: RequestInit =
    etag === null
      ? { cache: 'no-cache' }
      : { cache: 'no-store', headers: { 'If-None-Match': etag } };
  const response = await fetch(url, init);
  if (response.status === 304) return { changed: false };
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} fetching ${url}`);
  }
  const data = (await response.json()) as Manifest;
  if (!Array.isArray(data.screens)) {
    throw new Error('manifest.json has no screens[] array');
  }
  return { changed: true, manifest: data, etag: response.headers.get('ETag') };
}

/** The absolute URL of the screen document at `path` (a manifest entry's path). */
export function screenDocumentUrl(baseUrl: string, path: string): string {
  return `${withSlash(baseUrl)}${path}`;
}

/** `fresh` fetches past the HTTP cache (`cache: 'no-cache'`). */
export async function fetchScreenDocument(
  baseUrl: string,
  path: string,
  options?: { fresh?: boolean }
): Promise<ScreenJSON> {
  const url = screenDocumentUrl(baseUrl, path);
  return (await fetchJson(url, options?.fresh ? { cache: 'no-cache' } : undefined)) as ScreenJSON;
}

/**
 * Build the runtime's resolveScreen for a screen document: embedded refs
 * resolve relative to the TOP screen document's directory (nested chains
 * resolve against the same base — a documented v0.1 simplification).
 *
 * One resolver shares its fetches by URL: every embed of the same file (a
 * panel repeating one device faceplate thirty times) awaits one request and
 * gets the same parsed document, which the runtime never mutates. A failed
 * fetch is dropped from the cache, so a later embed retries it. The cache
 * lives as long as the resolver: ScreenPage builds a new one on every reload
 * and every draft revision, which is what invalidates it.
 */
export function makeResolveScreen(baseUrl: string, screenPath: string): ResolveScreen {
  const directory = directoryOf(screenPath);
  const inFlight = new Map<string, Promise<ScreenJSON>>();
  return (ref: string) => {
    let target: string;
    try {
      target = new URL(`${directory}${ref}`, withSlash(baseUrl)).toString();
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
    const cached = inFlight.get(target);
    if (cached) return cached;
    const pending = fetchJson(target).then((doc) => doc as ScreenJSON);
    inFlight.set(target, pending);
    pending.catch(() => {
      if (inFlight.get(target) === pending) inFlight.delete(target);
    });
    return pending;
  };
}

/**
 * Build the runtime's resolveAsset for a screen document: relative image
 * filenames resolve relative to the TOP screen document's directory (the same
 * v0.1 simplification as makeResolveScreen), so an image committed next to
 * the .screen.json just works. Absolute URLs (http:, https:, data:, blob:)
 * and root-relative paths pass through untouched.
 */
export function makeResolveAsset(baseUrl: string, screenPath: string): ResolveAsset {
  const directory = directoryOf(screenPath);
  return (ref: string) => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith('/')) return ref;
    return new URL(`${directory}${ref}`, withSlash(baseUrl)).toString();
  };
}

/** The directory part of a screen path, with its trailing slash ('' at the top level). */
export function directoryOf(screenPath: string): string {
  return screenPath.includes('/') ? screenPath.slice(0, screenPath.lastIndexOf('/') + 1) : '';
}

/**
 * The react-router basename for a document base URI: its path without the
 * trailing slash ('/' at the origin root), so routes work under any mount
 * prefix, e.g. http://h/u/x/panel/canopy/ -> /u/x/panel/canopy.
 */
export function routerBasename(baseURI: string): string {
  return new URL(baseURI).pathname.replace(/\/+$/, '') || '/';
}

/**
 * The absolute screens base URL: config.screensPath resolved against the
 * document base URI, trailing slash stripped.
 */
export function screensBaseUrl(screensPath: string, baseURI: string): string {
  return new URL(screensPath, baseURI).href.replace(/\/+$/, '');
}
