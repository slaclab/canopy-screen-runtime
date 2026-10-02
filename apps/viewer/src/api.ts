// canopy-screens content access: manifest + screen documents.

import type { ScreenJSON } from '@slaclab/canopy-screen-ir';
import type { ResolveAsset, ResolveScreen } from '@slaclab/canopy-screen-runtime';

/**
 * One entry of the content repo's generated manifest.json: one implementation
 * of a screen. Entries sharing category and id are variants of one screen
 * (variants.ts).
 */
export interface ManifestScreen {
  id: string;
  /**
   * 'ir' renders here; 'wrapper'/'code' screens are code-based (not yet
   * viewable); 'edl' is an EDM display drawn by @slaclab/canopy-edm.
   */
  kind: string;
  /** 'edm' | 'pydm' | 'react'; absent: implied by kind (edl → edm, ui → pydm, else react). */
  impl?: string;
  /** e.g. 'faithful' for an .edl drawn as EDM draws it; canopy-screens writes null for none. */
  look?: string | null;
  title: string;
  category: string;
  /**
   * Repo-relative path of the document, e.g. screens/examples/x.screen.json;
   * for an edm variant, the display's path under the display-file endpoint
   * (the /edl/<path> path).
   */
  path: string;
  macros?: { name: string; default?: string; description?: string }[];
  tags?: string[];
  schemaVersion?: string;
}

export interface Manifest {
  screens: ManifestScreen[];
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} fetching ${url}`);
  }
  return response.json();
}

export async function fetchManifest(baseUrl: string): Promise<Manifest> {
  const data = (await fetchJson(`${baseUrl}/manifest.json`)) as Manifest;
  if (!Array.isArray(data.screens)) {
    throw new Error('manifest.json has no screens[] array');
  }
  return data;
}

export async function fetchScreenDocument(baseUrl: string, path: string): Promise<ScreenJSON> {
  return (await fetchJson(`${baseUrl}/${path}`)) as ScreenJSON;
}

/**
 * Build the runtime's resolveScreen for a screen document: embedded refs
 * resolve relative to the TOP screen document's directory (nested chains
 * resolve against the same base — a documented v0.1 simplification).
 */
export function makeResolveScreen(baseUrl: string, screenPath: string): ResolveScreen {
  const directory = directoryOf(screenPath);
  return async (ref: string) => {
    const target = new URL(`${directory}${ref}`, `${resolveDocumentOrigin(baseUrl)}/`).toString();
    return (await fetchJson(target)) as ScreenJSON;
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
    return new URL(`${directory}${ref}`, `${resolveDocumentOrigin(baseUrl)}/`).toString();
  };
}

function directoryOf(screenPath: string): string {
  return screenPath.includes('/') ? screenPath.slice(0, screenPath.lastIndexOf('/') + 1) : '';
}

// new URL() needs an absolute base; same-origin '' resolves against the page.
function resolveDocumentOrigin(baseUrl: string): string {
  if (baseUrl) return baseUrl;
  return window.location.origin;
}
