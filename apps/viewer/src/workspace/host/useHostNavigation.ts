// In-place navigation from the host (docs/host-embedding.md). Once its
// message handler is installed the page posts {type: 'canopy-host-navigate-ready'}
// to window.parent (location.origin), and again in reply to every
// {type: 'canopy-host-navigate-probe'}. {type: 'canopy-host-navigate', url} is taken
// only from window.parent with origin location.origin; the router basename is
// stripped from its same-origin url, then ?_canopyOpen=<ref> runs the
// collections deep link and any other path is a replace navigation, which the
// workspace's outside-URL effect opens (append; focus when already open).
// Standalone (no parent window) nothing is posted.

import { useEffect, useRef } from 'react';
import { OPEN_PARAM } from '../useCollections.js';

/** The navigation messages of the host contract (docs/host-embedding.md). */
export const NAVIGATE_MESSAGE = 'canopy-host-navigate';
export const NAVIGATE_PROBE = 'canopy-host-navigate-probe';
export const NAVIGATE_READY = 'canopy-host-navigate-ready';

/**
 * A same-origin `url` as a router-relative pathname and search, the router
 * `basename` (useHref('/')) stripped; null for another origin or a path
 * outside the basename.
 */
export function routerPath(
  url: string,
  basename: string
): { pathname: string; search: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url, window.location.href);
  } catch {
    return null;
  }
  if (parsed.origin !== window.location.origin) return null;
  const prefix = basename.replace(/\/+$/, '');
  const { pathname, search } = parsed;
  if (prefix === '') return { pathname, search };
  if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) return null;
  return { pathname: pathname.slice(prefix.length) || '/', search };
}

export interface HostNavigationOptions {
  /** The router basename (useHref('/')). */
  basename: string;
  /** Runs the collections deep link for a `?_canopyOpen=<ref>` target. */
  runDeepLink: (ref: string) => void;
  /** A replace navigation to a router-relative path and search. */
  navigate: (to: string) => void;
}

/** Answers the host's navigation messages while the page is framed. */
export function useHostNavigation({
  basename,
  runDeepLink,
  navigate,
}: HostNavigationOptions): void {
  // Read when a message lands, so a new callback never re-posts ready.
  const navigateRef = useRef(navigate);
  useEffect(() => {
    navigateRef.current = navigate;
  });
  useEffect(() => {
    if (window.parent === window) return;
    const ready = () => window.parent.postMessage({ type: NAVIGATE_READY }, window.location.origin);
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window.parent || event.origin !== window.location.origin) return;
      const data: unknown = event.data;
      if (typeof data !== 'object' || data === null) return;
      const { type, url } = data as { type?: unknown; url?: unknown };
      if (type === NAVIGATE_PROBE) {
        ready();
        return;
      }
      if (type !== NAVIGATE_MESSAGE || typeof url !== 'string') return;
      const target = routerPath(url, basename);
      if (target === null) {
        console.warn(`Workspace: ignoring ${NAVIGATE_MESSAGE} to ${url}.`);
        return;
      }
      const ref = new URLSearchParams(target.search).get(OPEN_PARAM);
      if (ref !== null) runDeepLink(ref);
      else navigateRef.current(target.pathname + target.search);
    };
    window.addEventListener('message', onMessage);
    ready();
    return () => window.removeEventListener('message', onMessage);
  }, [basename, runDeepLink]);
}
