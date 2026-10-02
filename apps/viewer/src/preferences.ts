// A user's own variant choice per screen (variants.ts step 2). Canopy keys
// identify a client, not a person, so the choice lives in this browser's
// localStorage; storage that is blocked or full just means no choice.

import type { VariantPick } from './variants.js';

export interface VariantPreferences {
  get(screenKey: string): VariantPick | null;
  /** null forgets the choice. */
  set(screenKey: string, pick: VariantPick | null): void;
}

const PREFIX = 'canopy-viewer:variant:';

export function storagePreferences(storage: () => Storage | undefined): VariantPreferences {
  return {
    get(screenKey) {
      try {
        const raw = storage()?.getItem(PREFIX + screenKey);
        const v = raw ? (JSON.parse(raw) as Partial<VariantPick>) : null;
        if (!v || typeof v.impl !== 'string' || !v.impl) return null;
        return typeof v.look === 'string' && v.look
          ? { impl: v.impl, look: v.look }
          : { impl: v.impl };
      } catch {
        return null;
      }
    },
    set(screenKey, pick) {
      try {
        if (pick) storage()?.setItem(PREFIX + screenKey, JSON.stringify(pick));
        else storage()?.removeItem(PREFIX + screenKey);
      } catch {
        // Not remembered; the choice still applies to this page.
      }
    },
  };
}

export const browserPreferences = storagePreferences(() =>
  typeof window === 'undefined' ? undefined : window.localStorage
);

/** In-memory preferences (tests, or a page that must not persist). */
export function memoryPreferences(): VariantPreferences {
  const map = new Map<string, VariantPick>();
  return {
    get: (k) => map.get(k) ?? null,
    set: (k, p) => (p ? map.set(k, p) : map.delete(k)),
  };
}
