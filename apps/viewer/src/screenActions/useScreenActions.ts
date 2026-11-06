// The screen action runner, headless. One tile's actions: the hook builds the
// tile's ScreenActionContext, runs an action with a per-action dedupe, hands
// that runner to the tile's ShortcutRelay whether or not a bar is mounted, and
// reports each outcome ("Copied", or "<label> failed: <reason>") either as its
// own status text (a bar shows it) or through `notify` (a tile with no bar,
// inside an embedding host: the toast column).
//
// ScreenActionBar calls this hook, so the standalone bar and the workspace
// tile bars share it. The workspace also calls it per screen tile when it is
// embedded in a host page, where a tile can have no bar: then ⌘S, ⌘I and ⌘P
// still reach the tile through its relay, and the host header reads the
// tile's verbs (ScreenVerbView) and runs them through `invoke`.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ViewerConfig } from '../config.js';
import type { ScreenHistory } from '../ScreenHeader.js';
import { SCREEN_ACTIONS, availableActions } from './actions.js';
import type { ShortcutRelay } from './ScreenActionBar.js';
import type { ScreenAction, ScreenActionContext, ScreenTarget } from './types.js';

/** How long a status message stays up. */
export const STATUS_MS = 2000;

/** The action id of Download screen (⌘S), reported apart in the verb view. */
export const DOWNLOAD_ACTION_ID = 'download';

/**
 * What the host header knows of a screen tile. `verbs` lists every action
 * of the tile's list, in order, with whether it is available now (Plot in
 * Data Browser only when the data browser is configured and the screen can
 * list its PVs).
 */
export interface ScreenVerbView {
  canGoBack: boolean;
  canGoForward: boolean;
  verbs: readonly { id: string; available: boolean }[];
  zoom: { scale: number; fit: boolean };
  download: { available: boolean };
}

/** One tile, as the hook needs it. */
export interface ScreenActionTile {
  /** The open screen, or null before it reports (no verb is available). */
  screen: ScreenTarget | null;
  /** The scale in effect and whether it is the fit-to-view scale. */
  zoom: { scale: number; fit: boolean };
  config?: Readonly<Partial<ViewerConfig>>;
  /** Absolute URL that reopens exactly this screen. */
  link?: string;
  /** The data browser's PV chooser, when the host has one. */
  plotInDataBrowser?: (screen: ScreenTarget) => void;
  /** The tile's ◀ ▶, for the view's nav flags. */
  history?: ScreenHistory;
  /** The action list; SCREEN_ACTIONS by default. */
  actions?: readonly ScreenAction[];
  /** Where to hand over the runner; none, nothing is attached. */
  relay?: ShortcutRelay | null;
  /**
   * Where outcomes go instead of the status text (the toast column). Read
   * at the time an action finishes.
   */
  notify?: (text: string, error: boolean) => void;
}

export interface ScreenActions {
  /** The context the actions run with, or undefined without a screen. */
  ctx: ScreenActionContext | undefined;
  /** The available actions, in list order. */
  available: readonly ScreenAction[];
  view: ScreenVerbView;
  /** Run the action with this id if it is available; false otherwise. */
  invoke(id: string): boolean;
  /** Run an action (dedupe: a second run while one is pending is dropped). */
  run(action: ScreenAction): void;
  /** The current status text, when no `notify` takes it. */
  status: { text: string; error: boolean } | null;
}

/** One tile's runner, verb view and status (see the module comment). */
export function useScreenActions(tile: ScreenActionTile): ScreenActions {
  const {
    screen,
    zoom: { scale, fit },
    config,
    link,
    plotInDataBrowser,
    history,
    actions = SCREEN_ACTIONS,
    relay,
    notify,
  } = tile;
  const ctx = useMemo<ScreenActionContext | undefined>(
    () => (screen ? { screen, zoom: { scale, fit }, config, link, plotInDataBrowser } : undefined),
    [screen, scale, fit, config, link, plotInDataBrowser]
  );
  const available = useMemo(() => (ctx ? availableActions(ctx, actions) : []), [ctx, actions]);

  const ctxRef = useRef(ctx);
  const notifyRef = useRef(notify);
  const availableRef = useRef(available);
  useEffect(() => {
    ctxRef.current = ctx;
    notifyRef.current = notify;
    availableRef.current = available;
  });

  const [status, setStatus] = useState<{ text: string; error: boolean } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const show = useCallback((text: string, error: boolean) => {
    const sink = notifyRef.current;
    if (sink) {
      sink(text, error);
      return;
    }
    clearTimeout(timer.current);
    setStatus({ text, error });
    timer.current = setTimeout(() => setStatus(null), STATUS_MS);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);

  const running = useRef(new Set<string>());
  const run = useCallback(
    (action: ScreenAction) => {
      const current = ctxRef.current;
      if (current === undefined) return;
      if (running.current.has(action.id)) return;
      running.current.add(action.id);
      // A rejection and a synchronous throw both end up in the status text.
      void Promise.resolve()
        .then(() => action.run(current))
        .then(
          (result) => {
            if (result && result.message) show(result.message, false);
          },
          (err: unknown) => {
            const reason = err instanceof Error ? err.message : String(err);
            show(`${action.label} failed: ${reason}`, true);
          }
        )
        .finally(() => running.current.delete(action.id));
    },
    [show]
  );

  // The shortcut owner runs this tile's actions through this runner.
  useEffect(() => relay?.attach(run), [relay, run]);

  const invoke = useCallback(
    (id: string) => {
      const action = availableRef.current.find((a) => a.id === id);
      if (action === undefined) return false;
      run(action);
      return true;
    },
    [run]
  );

  const canGoBack = history?.back.enabled ?? false;
  const canGoForward = history?.forward.enabled ?? false;
  const view = useMemo<ScreenVerbView>(() => {
    const ids = new Set(available.map((a) => a.id));
    return {
      canGoBack,
      canGoForward,
      verbs: actions.map((a) => ({ id: a.id, available: ids.has(a.id) })),
      zoom: { scale, fit },
      download: { available: ids.has(DOWNLOAD_ACTION_ID) },
    };
  }, [available, actions, canGoBack, canGoForward, scale, fit]);

  return { ctx, available, view, invoke, run, status };
}

/** A tile's published verbs: its view and its `invoke`. */
export interface ScreenVerbs {
  view: ScreenVerbView;
  invoke(id: string): boolean;
}

/**
 * The screen tiles' verbs by tab key, for a reader that is not the tile (the
 * host header): a small external store with stable snapshots per key.
 */
export class ScreenVerbRegistry {
  private readonly entries = new Map<string, ScreenVerbs>();
  private readonly listeners = new Set<() => void>();

  /** Publish (or with undefined, withdraw) `key`'s verbs. */
  set(key: string, verbs: ScreenVerbs | undefined): void {
    if (verbs === undefined) {
      if (!this.entries.delete(key)) return;
    } else {
      if (this.entries.get(key) === verbs) return;
      this.entries.set(key, verbs);
    }
    for (const listener of [...this.listeners]) listener();
  }

  get(key: string): ScreenVerbs | undefined {
    return this.entries.get(key);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
}

/** `key`'s published verbs (re-rendering when they change), or undefined. */
export function useScreenVerbs(
  registry: ScreenVerbRegistry,
  key: string | null
): ScreenVerbs | undefined {
  return useSyncExternalStore(registry.subscribe, () =>
    key === null ? undefined : registry.get(key)
  );
}
