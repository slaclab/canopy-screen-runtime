// The dock's persisted value and its key: one value per router basename and,
// when the page is scoped, per user. Storage only: no debounce, arming or load
// policy; the persistence wiring decides what to do with what is read. A value
// is either a valid version 1 dock or nothing: any other version, non-JSON, or
// an invalid value reads as `null`, silently and without migration, and the
// default layout opens.
import { validateLayout, type Layout } from '@slaclab/canopy-dock-engine';
import { storageKey } from '../../storageScope.js';

/**
 * What reopening one panel in a new session needs: its kind and, for a tool,
 * its live query (absent: the config default, '' blank), its saved view, the
 * collection member it was opened from (`from`, a member key) and that
 * member's name (`title`). The strip order is the layout's (keysOf).
 */
export interface StoredDockPanel {
  kind: 'screen' | 'tool';
  query?: string;
  view?: string;
  from?: string;
  title?: string;
}

/** The stored value: the holder's layout (null = an empty dock) and its panels by tab key. */
export interface StoredDock {
  version: 1;
  layout: Layout | null;
  panels: Record<string, StoredDockPanel>;
}

/** The one version this build reads and writes. */
export const DOCK_VERSION = 1;

const STORAGE_NAME = 'canopy-workspace-dock';
const VALUE_FIELDS: ReadonlySet<string> = new Set(['version', 'layout', 'panels']);
const PANEL_FIELDS: ReadonlySet<string> = new Set(['kind', 'query', 'view', 'from', 'title']);
const PANEL_STRINGS = ['query', 'view', 'from', 'title'] as const;

/** Serialized form of the last value read or written, per key. */
const lastSeen = new Map<string, string>();

/**
 * The storage key for a router basename (`/`, `/x/y`, `/x/y/`): storageKey's
 * mount and host scope. A scoped page never falls back to the unscoped key.
 */
export function dockStorageKey(basename: string): string {
  return storageKey(STORAGE_NAME, basename);
}

// localStorage can be missing (Node >= 25 without --localstorage-file) or
// throw (blocked site data, sandboxed frames), as in usePaneSplitter.ts.
function localStore(): Storage | undefined {
  try {
    const value = (globalThis as { localStorage?: Storage }).localStorage;
    return typeof value?.getItem === 'function' ? value : undefined;
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPanel(value: unknown): value is StoredDockPanel {
  if (!isObject(value)) return false;
  if (value.kind !== 'screen' && value.kind !== 'tool') return false;
  if (Object.keys(value).some((field) => !PANEL_FIELDS.has(field))) return false;
  return PANEL_STRINGS.every(
    (field) => value[field] === undefined || typeof value[field] === 'string'
  );
}

/**
 * True for a valid version 1 value: exactly `{version, layout, panels}`, a
 * dock-form layout tree (or null) and a well-formed record per panel.
 */
export function isStoredDock(value: unknown): value is StoredDock {
  if (!isObject(value) || value.version !== DOCK_VERSION) return false;
  if (Object.keys(value).some((field) => !VALUE_FIELDS.has(field))) return false;
  if (!Object.hasOwn(value, 'layout')) return false;
  if (value.layout !== null && !validateLayout(value.layout, { form: 'dock' }).valid) return false;
  if (!isObject(value.panels)) return false;
  return Object.values(value.panels).every(isPanel);
}

/**
 * The stored value, or `null` when nothing usable is stored: no value,
 * unusable storage, non-JSON, another version, or an invalid value.
 */
export function readDock(basename: string): StoredDock | null {
  const key = dockStorageKey(basename);
  let raw: string | null;
  try {
    raw = localStore()?.getItem(key) ?? null;
  } catch {
    return null;
  }
  let parsed: unknown = null;
  if (raw !== null) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
  }
  if (!isStoredDock(parsed)) {
    // A later write of any value goes through, replacing what is there.
    lastSeen.delete(key);
    return null;
  }
  lastSeen.set(key, raw!);
  return parsed;
}

/** Remove the stored value; a later write of any value goes through. */
export function removeDock(basename: string): void {
  const key = dockStorageKey(basename);
  lastSeen.delete(key);
  try {
    localStore()?.removeItem(key);
  } catch {
    // Not removed; the next read reports what is there.
  }
}

/** Store the value, skipping a write equal to the last value read or written. */
export function writeDock(basename: string, value: StoredDock): void {
  const key = dockStorageKey(basename);
  const serialized = JSON.stringify(value);
  if (lastSeen.get(key) === serialized) return;
  const store = localStore();
  if (!store) return;
  try {
    store.setItem(key, serialized);
    lastSeen.set(key, serialized);
  } catch {
    // Not remembered; the layout still holds for this page view.
  }
}
