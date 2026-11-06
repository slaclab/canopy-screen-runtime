// The workspace's manifest: fetched past the HTTP cache on mount, on window
// focus, when the document becomes visible and every MANIFEST_POLL_MS while it
// is visible, conditionally on the last ETag (useConditionalManifestPoll), so
// an unchanged manifest is a bodiless 304 that touches nothing. The tree, tab
// titles and tab-missing derive from it, and every mounted screen's draft live
// reload reads it through SharedManifestContext, so the page runs one poll,
// not one per screen.

import { useCallback, useState } from 'react';
import type { Manifest } from '../api.js';
import { fetchManifest } from '../api.js';
import { useConditionalManifestPoll } from '../useManifestPoll.js';

/**
 * The latest manifest for `screensBaseUrl` (null before the first one) and a
 * one-shot `refetch` past the HTTP cache (null when it fails). A failed fetch
 * keeps the last manifest; an unchanged one keeps its identity, so nothing
 * re-renders.
 */
export function useWorkspaceManifest(screensBaseUrl: string): {
  manifest: Manifest | null;
  refetch: () => Promise<Manifest | null>;
} {
  const [manifest, setManifest] = useState<{ base: string; json: string; value: Manifest } | null>(
    null
  );
  const adopt = useCallback(
    (value: Manifest) => {
      const json = JSON.stringify(value);
      setManifest((prev) =>
        prev && prev.base === screensBaseUrl && prev.json === json
          ? prev
          : { base: screensBaseUrl, json, value }
      );
    },
    [screensBaseUrl]
  );
  // One fetch past the HTTP cache, now (the apply loop's refetch before an
  // unknown target stands); null when it fails.
  const refetch = useCallback(async (): Promise<Manifest | null> => {
    try {
      const value = await fetchManifest(screensBaseUrl, { fresh: true });
      adopt(value);
      return value;
    } catch {
      return null;
    }
  }, [screensBaseUrl, adopt]);

  useConditionalManifestPoll(screensBaseUrl, adopt, { eager: true });

  return {
    manifest: manifest && manifest.base === screensBaseUrl ? manifest.value : null,
    refetch,
  };
}
