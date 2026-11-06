// Is this viewer a tile of a host shell (docs/host-embedding.md)?
//
// The host shell loads the viewer in an iframe with `?embedded=true`. Both
// halves count: the flag alone (a standalone tab someone opened with the
// shell's URL) is not host-embedded, and neither is a frame without the flag
// (any other page framing the viewer).
//
// The answer is computed once, at the first call, and latched for the page's
// life the way the `?_canopyChrome` flag is: `embedded` is a reserved
// parameter, so the viewer's own URL writer drops it on the first navigation.
// A `replace` navigation or a reload inside the frame starts a fresh page
// without the flag, so a positive answer is also kept in sessionStorage
// (storageScope.ts: per mount and host scope) and a framed page without the flag
// reads it back. sessionStorage belongs to the frame's browsing context, so a
// standalone tab never sees what a host frame stored. The capabilities this
// implies are hostCapabilities.ts's.

import { routerBasename } from '../../api.js';
import { storageKey } from '../../storageScope.js';

const STORAGE_NAME = 'canopy-viewer:host-embedded';

/** The class main.tsx puts on <body> when the viewer is host-embedded (read by host stylesheets). */
export const HOST_EMBEDDED_CLASS = 'embedded';

let latched: boolean | null = null;

function framed(): boolean {
  try {
    return window.parent !== window;
  } catch {
    // A parent we may not even compare against is still a parent.
    return true;
  }
}

function embeddedKey(): string {
  return storageKey(STORAGE_NAME, routerBasename(document.baseURI));
}

function compute(): boolean {
  if (typeof window === 'undefined' || !framed()) return false;
  const flagged = new URLSearchParams(window.location.search).get('embedded') === 'true';
  try {
    if (flagged) {
      window.sessionStorage.setItem(embeddedKey(), '1');
      return true;
    }
    return window.sessionStorage.getItem(embeddedKey()) === '1';
  } catch {
    // Storage unavailable (privacy mode, sandboxed frame): the flag decides.
    return flagged;
  }
}

/** True when the viewer runs inside a host shell's frame; latched at first call. */
export function isHostEmbedded(): boolean {
  if (latched === null) latched = compute();
  return latched;
}

/** Put the host-embedded class on `body` when host-embedded. Called once at startup. */
export function applyHostEmbeddedClass(body: HTMLElement = document.body): void {
  if (isHostEmbedded()) body.classList.add(HOST_EMBEDDED_CLASS);
}

/** Test-only: forget the latched answer so the next call computes it again. */
export function resetHostEmbeddedForTests(): void {
  latched = null;
}
