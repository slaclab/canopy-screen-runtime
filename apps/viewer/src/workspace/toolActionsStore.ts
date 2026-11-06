// What each tool frame last reported about its own actions
// (`canopy:tool-actions`), keyed by the tab key of the TraceTab that hosts it,
// plus the way back to that frame (`canopy:tool-invoke`).
//
//   report     parseToolActions() turns a raw tool-actions message into a frozen
//              ToolActionsReport, or null when it is not one: wrong type or
//              version, `actions` not an array. Malformed entries are dropped
//              one by one; `links` keep only http(s) URLs (they are opened in a
//              new tab); unknown fields are not carried.
//   store      set() replaces a tab's report whole; clear() drops it (the
//              frame unloaded or the tab closed). Snapshots are frozen records
//              replaced only on a change, so useSyncExternalStore can compare
//              them by identity.
//   frames     TraceTab registers its iframe per tab key; invokeToolAction()
//              posts `{type: 'canopy:tool-invoke', id}` to that frame at
//              location.origin and returns whether a frame was there to post
//              to. Whether the id is runnable is the tool's decision.
//
// Before a tab's first report the viewer shows no tool entries for it, so an
// older tool that never reports keeps its own action bar.

import { useSyncExternalStore } from 'react';

export const TOOL_ACTIONS = 'canopy:tool-actions';
export const TOOL_INVOKE = 'canopy:tool-invoke';
export const SAVE_VIEW = 'canopy:save-view';
export const TOOL_ACTIONS_VERSION = 1;

const MAX_STRING = 120;

export interface ToolActionEntry {
  readonly id: string;
  readonly label: string;
  readonly kind: 'button' | 'toggle';
  readonly pressed?: boolean;
  /** false, or the reason the action cannot run now. */
  readonly disabled?: false | string;
  /** react-trace's own shortcut string (`primary+O`); formatted by the viewer. */
  readonly shortcut?: string;
}

export interface ToolActionsLinks {
  readonly docs?: string;
  readonly bug?: string;
}

export interface ToolActionsReport {
  readonly version: 1;
  /** The tool's subtitle fragment (`2 curves · live`). */
  readonly state?: string;
  readonly actions: readonly ToolActionEntry[];
  readonly links: ToolActionsLinks;
}

export type ToolActionsSnapshot = Readonly<Record<string, ToolActionsReport>>;

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value.slice(0, MAX_STRING) : undefined;
}

function httpUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value, document.baseURI);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function parseEntry(raw: unknown): ToolActionEntry | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id);
  const label = str(r.label);
  if (!id || label === undefined) return null;
  if (r.kind !== 'button' && r.kind !== 'toggle') return null;
  const entry: {
    id: string;
    label: string;
    kind: 'button' | 'toggle';
    pressed?: boolean;
    disabled?: false | string;
    shortcut?: string;
  } = { id, label, kind: r.kind };
  if (typeof r.pressed === 'boolean') entry.pressed = r.pressed;
  if (r.disabled === false) entry.disabled = false;
  else if (typeof r.disabled === 'string') entry.disabled = str(r.disabled);
  const shortcut = str(r.shortcut);
  if (shortcut !== undefined) entry.shortcut = shortcut;
  return Object.freeze(entry);
}

/** A raw message as a tool-actions report, or null when it is not one. */
export function parseToolActions(data: unknown): ToolActionsReport | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  if (d.type !== TOOL_ACTIONS || d.version !== TOOL_ACTIONS_VERSION) return null;
  if (!Array.isArray(d.actions)) return null;
  const seen = new Set<string>();
  const actions: ToolActionEntry[] = [];
  for (const raw of d.actions) {
    const entry = parseEntry(raw);
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    actions.push(entry);
  }
  const rawLinks =
    typeof d.links === 'object' && d.links !== null ? (d.links as Record<string, unknown>) : {};
  const links: { docs?: string; bug?: string } = {};
  const docs = httpUrl(rawLinks.docs);
  const bug = httpUrl(rawLinks.bug);
  if (docs) links.docs = docs;
  if (bug) links.bug = bug;
  const report: {
    version: 1;
    state?: string;
    actions: readonly ToolActionEntry[];
    links: ToolActionsLinks;
  } = {
    version: 1,
    actions: Object.freeze(actions),
    links: Object.freeze(links),
  };
  const state = str(d.state);
  if (state !== undefined) report.state = state;
  return Object.freeze(report);
}

export interface ToolActionsStore {
  getSnapshot(): ToolActionsSnapshot;
  /** Calls `listener` after every change; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void;
  get(tabId: string): ToolActionsReport | null;
  /** Replace the tab's report whole. */
  set(tabId: string, report: ToolActionsReport): void;
  /** Drop the tab's report (no-op when it has none). */
  clear(tabId: string): void;
  /** Register the iframe hosting the tab's tool; returns the unregister function. */
  registerFrame(tabId: string, frame: HTMLIFrameElement): () => void;
  /** Post canopy:tool-invoke to the tab's frame; false when the tab has no frame. */
  invoke(tabId: string, id: string): boolean;
}

export function createToolActionsStore(): ToolActionsStore {
  let snapshot: ToolActionsSnapshot = Object.freeze({});
  const listeners = new Set<() => void>();
  const frames = new Map<string, HTMLIFrameElement>();

  const replace = (next: Record<string, ToolActionsReport>) => {
    snapshot = Object.freeze(next);
    for (const listener of [...listeners]) listener();
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    get: (tabId) => (Object.hasOwn(snapshot, tabId) ? snapshot[tabId]! : null),
    set(tabId, report) {
      if (snapshot[tabId] === report) return;
      replace({ ...snapshot, [tabId]: report });
    },
    clear(tabId) {
      if (!Object.hasOwn(snapshot, tabId)) return;
      const next = { ...snapshot };
      delete next[tabId];
      replace(next);
    },
    registerFrame(tabId, frame) {
      frames.set(tabId, frame);
      return () => {
        if (frames.get(tabId) === frame) frames.delete(tabId);
      };
    },
    invoke(tabId, id) {
      const target = frames.get(tabId)?.contentWindow;
      if (!target) return false;
      target.postMessage({ type: TOOL_INVOKE, id }, window.location.origin);
      return true;
    },
  };
}

/** The page's store: TraceTab writes it, the host header reads it. */
export const toolActionsStore: ToolActionsStore = createToolActionsStore();

/** Post `{type: 'canopy:tool-invoke', id}` to the tool frame of tab `tabId`. */
export function invokeToolAction(tabId: string, id: string): boolean {
  return toolActionsStore.invoke(tabId, id);
}

/** The tab's latest report, re-rendering on change; null before the first. */
export function useToolActions(
  tabId: string | null | undefined,
  store: ToolActionsStore = toolActionsStore
): ToolActionsReport | null {
  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return tabId && Object.hasOwn(snap, tabId) ? snap[tabId]! : null;
}
