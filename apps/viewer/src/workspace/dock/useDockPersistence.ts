// The dock's persistence wiring: which layout a
// page load starts from, and when the holder's layout is written back.
// Storage itself (key, validation, unchanged-value skip) is storage.ts.
//
// The stored value is the holder's own `{version: 1, layout, panels}`: the
// layout tree (tiles, tabs, showing tab, sizes) and, per panel, what a new
// session needs to reopen it. Nothing is read from or written through
// dockview: the holder is the dock, and the dock's apply follows from the
// holder like every other change.
//
// Load is decided once, in the WorkspacePage `useState` initializer, through
// `planDockLoad`, which hands the stored layout to the holder's `loadTabs`
// (the same prune rule as the holder's `restore`, no undo entry). A reload
// prunes the stored layout to the session's open tabs and reopens nothing; a
// new session (no stored tabs) reopens the stored panels with their tool
// state. No usable value (none stored, another version, invalid) opens the
// default layout silently: no warning, no removal, no migration.
//
// Writing is armed, not guarded: nothing is written until the first trusted
// pointer or key event inside the workspace after mount (or a `schedule(true)`
// from an operator's own action), so mount and load never write.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, type RefObject } from 'react';
import { loadTabs, type ReopenPanel, type TabsState } from '../tabs.js';
import { isToolKey } from '../tools.js';
import { keysOf } from '@slaclab/canopy-dock-engine';
import {
  DOCK_VERSION,
  readDock,
  writeDock,
  type StoredDock,
  type StoredDockPanel,
} from './storage.js';

/** Debounce of every write: a burst of changes is stored once. */
export const PERSIST_DELAY_MS = 150;

export interface DockLoadInput {
  /** False under `_canopyChrome=0`: storage is neither read nor written. */
  chrome: boolean;
  /** The router basename the key is scoped by. */
  basename: string;
  /** The session's stored tabs (`readTabs()`), EMPTY_TABS without chrome. */
  stored: TabsState;
  urlKey: string | null;
  tools: readonly string[];
  /** True when this session stored no tabs yet: the new-session path. */
  newSession: boolean;
  /**
   * True when the URL carried a deep link (`_canopyOpen`) the collections hook
   * runs after the mount: the first-visit default (the data browser on a bare
   * first visit) is suppressed so the link's members are not joined by it.
   */
  suppressFirstVisit?: boolean;
  /**
   * The home screen replaces the data browser as the first-visit default
   * (HostCapabilities.homeOnFirstOpen): a base path with no usable dock value
   * and no session tabs on a bare first visit opens nothing and reports
   * `pendingHome`, so the workspace opens the home screen once the manifest
   * arrives; a stored workspace restores as it is, without the `@trace`
   * default.
   */
  homeOnFirstOpen?: boolean;
  /** One-tile (chrome-off) mode, passed through to `loadTabs`. */
  oneTile?: boolean;
}

export interface DockLoad {
  /** The holder's initial state; its layout is what the mount applies. */
  state: TabsState;
  warnings: string[];
  /** Present (true) when the workspace opens its first-open target later. */
  pendingHome?: true;
}

/**
 * The load decision: reads the stored value once and feeds `loadTabs`
 * the reload `layout` or the new-session `reopen` option.
 */
export function planDockLoad(input: DockLoadInput): DockLoad {
  const { chrome, basename, stored, urlKey, tools, newSession } = input;
  const homeOnFirstOpen = input.homeOnFirstOpen === true;
  const firstVisit = chrome && newSession && input.suppressFirstVisit !== true;
  // With a home screen, only a base path without a stored dock gets a first-open default.
  const fresh = firstVisit && !homeOnFirstOpen;
  const base = { tools, homeOnFirstOpen, ...(input.oneTile === true ? { oneTile: true } : {}) };
  const done = (loaded: ReturnType<typeof loadTabs>): DockLoad => {
    const load: DockLoad = { state: loaded.state, warnings: loaded.warnings };
    if (loaded.pendingHome) load.pendingHome = true;
    return load;
  };

  const value = chrome ? readDock(basename) : null;
  if (value === null) {
    return done(
      loadTabs(stored, urlKey, { ...base, fresh: fresh || (homeOnFirstOpen && firstVisit) })
    );
  }
  if (!newSession) {
    // Reload: nothing is reopened; a closed key is pruned silently.
    return done(loadTabs(stored, urlKey, { ...base, fresh, layout: { layout: value.layout } }));
  }
  // New session: the stored panels reopen in the layout's strip order.
  const panels = keysOf(value.layout).map((key) => reopenPanel(key, value.panels[key]));
  return done(
    loadTabs(stored, urlKey, { ...base, fresh, reopen: { panels, layout: value.layout } })
  );
}

function reopenPanel(key: string, panel: StoredDockPanel | undefined): ReopenPanel {
  const reopen: ReopenPanel = { key };
  if (panel === undefined || panel.kind !== 'tool') return reopen;
  if (panel.query !== undefined) reopen.query = panel.query;
  if (panel.view !== undefined) reopen.view = panel.view;
  if (panel.from !== undefined) reopen.from = panel.from;
  if (panel.title !== undefined) reopen.title = panel.title;
  return reopen;
}

/** The value written for the holder: its layout and every open panel. */
export function dockValue(state: Pick<TabsState, 'layout' | 'instances'>): StoredDock {
  const panels: Record<string, StoredDockPanel> = {};
  for (const key of keysOf(state.layout)) {
    if (!isToolKey(key)) {
      panels[key] = { kind: 'screen' };
      continue;
    }
    const instance = state.instances[key];
    const view = instance?.view;
    const from = instance?.from;
    if ((typeof view === 'string' && view !== '') || from) {
      // A saved view or a member instance reopens with its live query.
      const record: StoredDockPanel = { kind: 'tool' };
      if (instance!.query !== null) record.query = instance!.query;
      if (typeof view === 'string' && view !== '') record.view = view;
      if (from) {
        record.from = from;
        if (typeof instance!.title === 'string' && instance!.title !== '') {
          record.title = instance!.title;
        }
      }
      panels[key] = record;
    } else {
      panels[key] = { kind: 'tool', query: '' };
    }
  }
  return { version: DOCK_VERSION, layout: state.layout, panels };
}

export interface DockPersistenceOptions {
  /** The holder's state; its persisted part is the write trigger. */
  state: TabsState;
  basename: string;
  /** False under `_canopyChrome=0`: nothing is ever written. */
  enabled: boolean;
  /** The workspace element whose trusted pointer and key events arm writing. */
  root: RefObject<HTMLElement | null>;
  /** Event trust test; `event.isTrusted` unless a test substitutes one. */
  isTrusted?: (event: Event) => boolean;
}

export interface DockPersistence {
  /**
   * Schedules a debounced write when armed. `arm` (Reset, an operator's own
   * action) arms writing first.
   */
  schedule(arm?: boolean): void;
}

const ARMING_EVENTS = ['pointerdown', 'keydown'] as const;

export function useDockPersistence(options: DockPersistenceOptions): DockPersistence {
  const { state, basename, enabled, root } = options;
  const armed = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef({ state, basename, enabled });
  const trusted = useRef(options.isTrusted ?? ((event: Event) => event.isTrusted));
  useLayoutEffect(() => {
    latest.current = { state, basename, enabled };
    trusted.current = options.isTrusted ?? ((event: Event) => event.isTrusted);
  });

  const flush = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const { state: now, basename: base, enabled: on } = latest.current;
    if (!on || !armed.current) return;
    writeDock(base, dockValue(now));
  }, []);

  const schedule = useCallback(
    (arm = false) => {
      if (!latest.current.enabled) return;
      if (arm) armed.current = true;
      if (!armed.current) return;
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(flush, PERSIST_DELAY_MS);
    },
    [flush]
  );

  // Arming: the first trusted pointer or key event inside the workspace.
  useEffect(() => {
    const element = root.current;
    if (!enabled || !element) return;
    const onEvent = (event: Event) => {
      if (trusted.current(event)) armed.current = true;
    };
    for (const type of ARMING_EVENTS) element.addEventListener(type, onEvent, true);
    return () => {
      for (const type of ARMING_EVENTS) element.removeEventListener(type, onEvent, true);
    };
  }, [enabled, root]);

  // Trigger: any change of what is stored (tiles, tabs, showing, sizes, a
  // panel's tool state). Focus alone is not stored and is no trigger.
  const { layout, instances } = state;
  const signature = useMemo(
    () => JSON.stringify(dockValue({ layout, instances })),
    [layout, instances]
  );
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    schedule();
  }, [signature, schedule]);

  // A pending write is not lost to a reload or a closed tab; nothing else is
  // written on the way out.
  useEffect(() => {
    const onHide = () => {
      if (timer.current !== null) flush();
    };
    window.addEventListener('pagehide', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    };
  }, [flush]);

  return useMemo(() => ({ schedule }), [schedule]);
}
