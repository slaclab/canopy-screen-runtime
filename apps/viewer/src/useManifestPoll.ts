// Live reload for drafts: while a document whose manifest entry carries a
// `rev` is open (canopy_mcp serves one per draft), watch the manifest and the
// revs of the open document and of every entry in its directory (the screens
// it can embed). A change bumps a generation counter that ScreenPage folds
// into its document key and resolver memos, so the top document is refetched
// and embeds remount. A static canopy-screens site has no revs and is never
// watched; a failed poll keeps the last generation and tries again.
//
// One poll per page: inside the workspace, which already polls the manifest
// for its tree, every open screen reads that manifest through
// SharedManifestContext instead of fetching its own. Only a page without the
// context (the /s/ deep link) polls for itself: every MANIFEST_POLL_MS while
// the document is visible and at once when it becomes visible, conditionally
// on the manifest's ETag, so an unchanged manifest costs a bodiless 304.

import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Manifest, ManifestScreen } from './api.js';
import { directoryOf, pollManifest } from './api.js';

/** Manifest refresh period, for this hook and the workspace's poll, while the document is visible. */
export const MANIFEST_POLL_MS = 3000;

/** A manifest someone else keeps fresh, for the screens base it came from. */
export interface SharedManifest {
  /** The absolute screens base URL the manifest was fetched from. */
  base: string;
  /** The latest manifest, or null before the first successful fetch. */
  manifest: Manifest | null;
}

/** Provided by the workspace, whose own poll feeds every open screen. */
export const SharedManifestContext = createContext<SharedManifest | null>(null);

/** The revs the open document depends on, as one comparable string. */
function revTuple(screens: ManifestScreen[], openPath: string): string {
  const directory = directoryOf(openPath);
  return screens
    .filter((s) => s.path === openPath || s.path.startsWith(directory))
    .map((s) => `${s.path}@${s.rev ?? ''}`)
    .sort()
    .join('\n');
}

/**
 * Watch the manifest while `openPath` is open with a known `openRev`; returns
 * a generation number that changes only when the open document's rev, or the
 * rev of an entry in its directory, changes.
 */
export function useManifestPoll(
  screensBaseUrl: string,
  openPath: string | undefined,
  openRev: string | undefined
): number {
  const [generation, setGeneration] = useState(0);
  // Read at observe time so a reload that feeds the new rev back in does not
  // restart the watch.
  const openRevRef = useRef(openRev);
  useEffect(() => {
    openRevRef.current = openRev;
  }, [openRev]);
  const enabled = openPath !== undefined && openRev !== undefined;

  const shared = useContext(SharedManifestContext);
  const useShared = shared !== null && shared.base === screensBaseUrl;
  const sharedManifest = useShared ? shared.manifest : null;

  // The rev tuple last observed for the open document; none until the first
  // observation, which only bumps if the document changed since it loaded.
  const last = useRef<{ path: string; tuple: string } | null>(null);
  const observe = useRef<(manifest: Manifest) => void>(() => {});
  useEffect(() => {
    observe.current = (manifest: Manifest) => {
      if (openPath === undefined) return;
      const open = manifest.screens.find((s) => s.path === openPath);
      if (!open) return; // Keep the last render until the entry reappears.
      const tuple = revTuple(manifest.screens, openPath);
      const prev = last.current?.path === openPath ? last.current.tuple : null;
      const changed = prev === null ? open.rev !== openRevRef.current : tuple !== prev;
      last.current = { path: openPath, tuple };
      if (changed) setGeneration((g) => g + 1);
    };
  });

  // Shared: observe every manifest the workspace's poll delivers.
  useEffect(() => {
    if (!enabled || sharedManifest === null) return;
    observe.current(sharedManifest);
  }, [enabled, sharedManifest]);

  // Standalone: poll for ourselves, every MANIFEST_POLL_MS while the document
  // is visible and at once when it becomes visible again. A new document
  // restarts the loop, whose first fetch is then unconditional, so the
  // first-observation rule above sees a full manifest.
  useConditionalManifestPoll(screensBaseUrl, (manifest) => observe.current(manifest), {
    enabled: enabled && !useShared,
    scope: openPath,
  });

  return generation;
}

export interface ConditionalManifestPollOptions {
  /** False stops the loop (default true). */
  enabled?: boolean;
  /** Also fetch at once and whenever the window gains focus (default false). */
  eager?: boolean;
  /** A change restarts the loop, forgetting the validator (default: none). */
  scope?: unknown;
}

/**
 * The one manifest poll loop: `pollManifest` every MANIFEST_POLL_MS while the
 * document is visible and at once when it becomes visible, conditionally on
 * the ETag it last saw, so an unchanged manifest is a bodiless 304 and
 * `onManifest` runs only for a changed one. A failed poll keeps the last
 * manifest and tries again on the next tick; one poll runs at a time. The
 * validator lives in the loop: a new base, `scope` or `enabled` starts over
 * with an unconditional fetch. `onManifest` is read when a poll lands, so a
 * new callback never restarts the loop.
 */
export function useConditionalManifestPoll(
  screensBaseUrl: string,
  onManifest: (manifest: Manifest) => void,
  { enabled = true, eager = false, scope }: ConditionalManifestPollOptions = {}
): void {
  const deliver = useRef(onManifest);
  useLayoutEffect(() => {
    deliver.current = onManifest;
  });
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let inFlight = false;
    let etag: string | null = null;
    const poll = async (): Promise<void> => {
      if (inFlight) return;
      inFlight = true;
      try {
        const result = await pollManifest(screensBaseUrl, etag);
        if (cancelled || !result.changed) return;
        etag = result.etag;
        deliver.current(result.manifest);
      } catch {
        // Missing manifest or network error: keep the last one, retry later.
      } finally {
        inFlight = false;
      }
    };
    const onFocus = () => void poll();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void poll();
    };
    if (eager) {
      void poll();
      window.addEventListener('focus', onFocus);
    }
    document.addEventListener('visibilitychange', onVisible);
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void poll();
    }, MANIFEST_POLL_MS);
    return () => {
      cancelled = true;
      if (eager) window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
      clearInterval(timer);
    };
  }, [screensBaseUrl, enabled, eager, scope]);
}
