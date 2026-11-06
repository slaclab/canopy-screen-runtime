// Viewer zoom state: fit-to-view (the default) or a manual scale. Storage
// failures (blocked, sandboxed, missing) are ignored: the state then lasts for
// the page's lifetime only. Two shapes:
//
//   ZoomProvider       one value for the whole app, mirrored to sessionStorage
//                      under storageKey('canopy-viewer:zoom') (mount plus
//                      host scope, storageScope.ts), above the routes: used by the
//                      workspace with chrome off (`?_canopyChrome=0`); /s/ is
//                      never zoomed. It reads the router basename, so it
//                      needs a router above it.
//   ZoomStore          the docked workspace's per-tile zoom, remembered per
//                      screen per user: ONE localStorage record under
//                      storageKey('canopy-viewer:zoom-by-screen') (mount plus
//                      host scope; per browser profile, like a
//                      browser's per-site zoom), a JSON map keyed
//                      `category/id`, so every tab of a screen (any macros)
//                      shares it and it outlives the session. Only a manual
//                      zoom is stored: Fit removes the screen's entry, so an
//                      unknown screen opens at Fit. A tool key (`@…`) has no
//                      zoom. Another browser tab's write arrives through the
//                      `storage` event. `latch` holds the ?_canopyZoom value
//                      for the URL's tab key in memory only (this page view),
//                      ahead of the remembered entry, until a zoom is picked
//                      on that tile. Owned by WorkspacePage, which passes it
//                      the basename. A KeyedZoomProvider around each screen
//                      and that screen's tile bar (useKeyedZoom; a bar lives
//                      in dockview's tab element, a sibling subtree of the
//                      screen) read and write the same entry.
//
// ScreenPage reads either through useZoom(); the innermost provider wins.

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import type { ReactNode } from 'react';
import { useHref } from 'react-router-dom';
import { browserStorage } from './screenList.js';
import { storageKey } from './storageScope.js';
import { isValidScale } from './zoom.js';

export type ZoomMode = 'fit' | 'manual';

export interface ZoomState {
  mode: ZoomMode;
  /** The manual scale; ignored while mode is 'fit'. */
  scale: number;
}

export interface ZoomControl extends ZoomState {
  setFit(): void;
  setManual(scale: number): void;
}

/** The name of the app-level zoom record (a storageKey name). */
export const ZOOM_STORAGE_NAME = 'canopy-viewer:zoom';
/** The name of the per-screen zoom record (a storageKey name). */
export const ZOOM_BY_SCREEN_NAME = 'canopy-viewer:zoom-by-screen';
const DEFAULT_ZOOM: ZoomState = Object.freeze({ mode: 'fit', scale: 1 }) as ZoomState;

function sessionStore(): Storage | undefined {
  try {
    const value = (globalThis as { sessionStorage?: Storage }).sessionStorage;
    return typeof value?.getItem === 'function' ? value : undefined;
  } catch {
    return undefined;
  }
}

/** A valid state, else the default fit. */
function normalise(state: Partial<ZoomState> | null | undefined): ZoomState {
  if (state?.mode === 'manual' && isValidScale(state.scale)) {
    return { mode: 'manual', scale: state.scale };
  }
  return DEFAULT_ZOOM;
}

function readZoom(key: string): ZoomState {
  try {
    const raw = sessionStore()?.getItem(key);
    if (!raw) return DEFAULT_ZOOM;
    return normalise(JSON.parse(raw) as Partial<ZoomState>);
  } catch {
    return DEFAULT_ZOOM;
  }
}

function writeZoom(key: string, state: ZoomState): void {
  try {
    sessionStore()?.setItem(key, JSON.stringify(state));
  } catch {
    // Not persisted; the in-memory state still applies.
  }
}

function sameZoom(a: ZoomState, b: ZoomState): boolean {
  return a.mode === b.mode && (a.mode === 'fit' || a.scale === b.scale);
}

/** The record key of a tab key: `category/id` (macros dropped); null for a tool. */
function screenOf(key: string): string | null {
  if (key.startsWith('@')) return null;
  const q = key.indexOf('?');
  const path = q < 0 ? key : key.slice(0, q);
  return path.indexOf('/') > 0 ? path : null;
}

/** The stored record's valid manual entries; anything else reads as absent. */
function readRecord(key: string): Map<string, ZoomState> {
  const out = new Map<string, ZoomState>();
  try {
    const raw = browserStorage()?.getItem(key);
    if (!raw) return out;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out;
    for (const [screen, entry] of Object.entries(parsed as Record<string, unknown>)) {
      const state = normalise(entry as Partial<ZoomState> | null);
      if (state.mode === 'manual') out.set(screen, state);
    }
  } catch {
    // Unreadable: nothing remembered.
  }
  return out;
}

/**
 * Zoom per screen, from one localStorage record read on first use, written
 * back on every change and re-read on the `storage` event. Snapshots keep
 * their identity until their value changes, as useSyncExternalStore requires.
 */
export class ZoomStore {
  /** The remembered manual zooms by `category/id`; null until first read. */
  private record: Map<string, ZoomState> | null = null;
  /** Latched zooms by exact tab key: this page view only. */
  private readonly latched = new Map<string, ZoomState>();
  private readonly listeners = new Set<() => void>();
  private readonly storageKey: string;
  private detach: (() => void) | null = null;

  /** `basename` is the router basename the record is scoped by. */
  constructor(basename = '/') {
    this.storageKey = storageKey(ZOOM_BY_SCREEN_NAME, basename);
  }

  private remembered(): Map<string, ZoomState> {
    this.record ??= readRecord(this.storageKey);
    return this.record;
  }

  /** The key's zoom: its latch, else its screen's remembered zoom, else fit. */
  get(key: string): ZoomState {
    const latched = this.latched.get(key);
    if (latched !== undefined) return latched;
    const screen = screenOf(key);
    if (screen === null) return DEFAULT_ZOOM;
    return this.remembered().get(screen) ?? DEFAULT_ZOOM;
  }

  /**
   * Latches `key` (the URL's tab key) at `state` for this page view, ahead of
   * the remembered zoom; nothing is stored. A later `set` on it drops it.
   */
  latch(key: string, state: ZoomState): void {
    if (screenOf(key) === null) return;
    this.latched.set(key, normalise(state));
    this.notify();
  }

  /**
   * Sets the key's screen zoom (an invalid manual scale reads as fit): a
   * manual one is remembered, fit removes the entry. Drops the key's latch.
   */
  set(key: string, state: ZoomState): void {
    const screen = screenOf(key);
    if (screen === null) return;
    const next = normalise(state);
    const hadLatch = this.latched.delete(key);
    // Merge into what is stored now: another tab may have written meanwhile.
    const record = readRecord(this.storageKey);
    if (next.mode === 'manual') record.set(screen, next);
    else record.delete(screen);
    const changed = this.adopt(record);
    try {
      const storage = browserStorage();
      if (record.size === 0) storage?.removeItem(this.storageKey);
      else storage?.setItem(this.storageKey, JSON.stringify(Object.fromEntries(record)));
    } catch {
      // Not persisted; the in-memory state still applies.
    }
    if (hadLatch || changed) this.notify();
  }

  /** Takes `next` as the record, keeping the identity of unchanged entries. */
  private adopt(next: Map<string, ZoomState>): boolean {
    const old = this.remembered();
    let changed = old.size !== next.size;
    for (const [screen, state] of next) {
      const before = old.get(screen);
      if (before !== undefined && sameZoom(before, state)) next.set(screen, before);
      else changed = true;
    }
    this.record = next;
    return changed;
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }

  private onStorage = (event: StorageEvent): void => {
    // A null key is a clear() of the whole storage area.
    if (event.key !== null && event.key !== this.storageKey) return;
    if (this.adopt(readRecord(this.storageKey))) this.notify();
  };

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (this.detach === null && typeof window !== 'undefined') {
      window.addEventListener('storage', this.onStorage);
      this.detach = () => window.removeEventListener('storage', this.onStorage);
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0 && this.detach !== null) {
        this.detach();
        this.detach = null;
      }
    };
  };
}

const ZoomContext = createContext<ZoomControl | null>(null);

/** The app-level zoom: one value for every screen below it. */
export function ZoomProvider({ children }: { children: ReactNode }) {
  // useHref('/') is the router basename (`/` when there is none).
  const basename = useHref('/');
  const key = storageKey(ZOOM_STORAGE_NAME, basename);
  const [state, setState] = useState<ZoomState>(() => readZoom(key));

  const update = useCallback(
    (next: ZoomState) => {
      setState(next);
      writeZoom(key, next);
    },
    [key]
  );
  const setFit = useCallback(() => update({ mode: 'fit', scale: 1 }), [update]);
  const setManual = useCallback(
    (scale: number) => {
      if (isValidScale(scale)) update({ mode: 'manual', scale });
    },
    [update]
  );

  const value = useMemo(
    () => ({ mode: state.mode, scale: state.scale, setFit, setManual }),
    [state, setFit, setManual]
  );
  return <ZoomContext.Provider value={value}>{children}</ZoomContext.Provider>;
}

/** The zoom of `key` in `store`, live, with setters that write that key. */
export function useKeyedZoom(store: ZoomStore, key: string): ZoomControl {
  const getSnapshot = useCallback(() => store.get(key), [store, key]);
  const state = useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
  const setFit = useCallback(() => store.set(key, { mode: 'fit', scale: 1 }), [store, key]);
  const setManual = useCallback(
    (scale: number) => {
      if (isValidScale(scale)) store.set(key, { mode: 'manual', scale });
    },
    [store, key]
  );
  return useMemo(
    () => ({ mode: state.mode, scale: state.scale, setFit, setManual }),
    [state, setFit, setManual]
  );
}

/** One screen's zoom: the `zoomKey` entry of `store`, for every useZoom() below. */
export function KeyedZoomProvider({
  store,
  zoomKey,
  children,
}: {
  store: ZoomStore;
  zoomKey: string;
  children: ReactNode;
}) {
  const value = useKeyedZoom(store, zoomKey);
  return <ZoomContext.Provider value={value}>{children}</ZoomContext.Provider>;
}

/** The viewer's zoom state; outside a ZoomProvider it is a fixed fit mode. */
export function useZoom(): ZoomControl {
  return useContext(ZoomContext) ?? FIXED_FIT;
}

const FIXED_FIT: ZoomControl = { ...DEFAULT_ZOOM, setFit: () => {}, setManual: () => {} };
