// Which manifest entries the screen list shows by default. Sub-screens are
// the pieces other screens embed (an `embedded/` directory, or a basename
// starting with `_`): not meant to be opened on their own, so the list hides
// them until the operator asks, and remembers that choice in browser storage
// (storageScope.ts), per mount and per host scope, so one user's choice never
// seeds another's.

import { useSyncExternalStore } from 'react';
import { storageKey } from './storageScope.js';

const SHOW_SUB_SCREENS_NAME = 'canopy-viewer:show-sub-screens';

/** A sub-screen id: an `embedded` path segment, or a basename starting with `_`. */
export function isSubScreen(id: string): boolean {
  const segments = id.split('/');
  const basename = segments[segments.length - 1] ?? '';
  return segments.includes('embedded') || basename.startsWith('_');
}

// localStorage can be missing (Node >= 25 without --localstorage-file), or
// throw (blocked site data, sandboxed frames); either way the list falls back
// to hiding sub-screens and the checkbox still works for this page view.
export function browserStorage(): Storage | undefined {
  try {
    const value = (globalThis as { localStorage?: Storage }).localStorage;
    return typeof value?.getItem === 'function' ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The key the show-sub-screens choice is stored under on this page. */
export function showSubScreensKey(basename?: string): string {
  return storageKey(SHOW_SUB_SCREENS_NAME, basename);
}

export function readShowSubScreens(basename?: string): boolean {
  try {
    return browserStorage()?.getItem(showSubScreensKey(basename)) === '1';
  } catch {
    return false;
  }
}

export function writeShowSubScreens(show: boolean, basename?: string): void {
  try {
    const store = browserStorage();
    if (!store) return;
    const key = showSubScreensKey(basename);
    if (show) store.setItem(key, '1');
    else store.removeItem(key);
  } catch {
    // Not remembered; the current page still shows the choice.
  }
}

// --- the show-sub-screens store ----------------------------------------------
//
// One subscribable choice over the key above, read by the tree, both ⋯ menus
// and the host header composer, so a toggle in any of them re-renders the rest.
// The stored key stays the truth; a write the storage refuses is held in
// memory for this page view, never persisted.

const showSubScreensListeners = new Set<() => void>();
/** Per key: the choice a refused write could not store. */
const unstored = new Map<string, boolean>();

/** The current show-sub-screens choice on this page (stored, or held after a refused write). */
export function getShowSubScreens(basename?: string): boolean {
  const held = unstored.get(showSubScreensKey(basename));
  return held ?? readShowSubScreens(basename);
}

/** Stores the choice and notifies every subscriber. */
export function setShowSubScreens(show: boolean, basename?: string): void {
  writeShowSubScreens(show, basename);
  const key = showSubScreensKey(basename);
  if (readShowSubScreens(basename) === show) unstored.delete(key);
  else unstored.set(key, show);
  for (const listener of [...showSubScreensListeners]) listener();
}

/** Calls `listener` after every setShowSubScreens(); returns the unsubscribe. */
export function subscribeShowSubScreens(listener: () => void): () => void {
  showSubScreensListeners.add(listener);
  return () => {
    showSubScreensListeners.delete(listener);
  };
}

/** The show-sub-screens choice, re-rendering on every change. */
export function useShowSubScreens(basename?: string): boolean {
  return useSyncExternalStore(
    subscribeShowSubScreens,
    () => getShowSubScreens(basename),
    () => false
  );
}

/** Test hook: forget every choice held after a refused write. */
export function resetShowSubScreensStore(): void {
  unstored.clear();
}
