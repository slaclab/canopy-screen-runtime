// The mount set: which screen tabs stay mounted, and what each showing screen
// reports.
//
// Every showing screen (its tile's showing tab) is mounted, plus up to
// KEEP_MOUNTED of the screens focused most recently that are hidden (least
// recently focused evicted first); a hidden one keeps its layout (visibility,
// not display) and is inert. Switching back to a kept tab is instant: its
// document, embeds and PV subscriptions are already there. Two flags reach a
// screen: `showing` drives hidden/aria-hidden/inert and the title/zoom/screen
// report (one entry per tab key, so every tile bar shows its own screen's
// title and scale; the entry goes when the screen unmounts), `focused` (the
// focused tile's showing tab) drives print fit, and its
// report is the document title and the header's. A screen with a live write
// toast also stays mounted, beyond KEEP_MOUNTED, until its toasts are gone
// (writeGate/toastHost pinLiveToasts): its gate holds them.

import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { ActionHostContext } from '@slaclab/canopy-screen-runtime';
import type { ActionHost } from '@slaclab/canopy-screen-runtime';
import { ScreenPage } from '../pages/ScreenPage.js';
import type { ScreenTarget } from '../screenActions/types.js';
import { KeyedZoomProvider } from '../ZoomContext.js';
import type { ZoomStore } from '../ZoomContext.js';
import { WriteToastHostContext } from '../writeGate/toastHost.js';
import type { WriteToastHost } from '../writeGate/toastHost.js';
import { isTile } from '@slaclab/canopy-dock-engine';
import type { Layout, Tile } from '@slaclab/canopy-dock-engine';
import { parseTabKey } from './tabs.js';
import type { ScreenReadiness } from './workspaceApply.js';

/** Hidden screen tabs kept mounted besides the showing ones. */
export const KEEP_MOUNTED = 3;

/**
 * The screen tabs to keep mounted: every showing screen (the showing tab of
 * some tile), plus the most recently focused of `recent` that are hidden, at
 * most `limit` of those, in strip order so a switch never moves a mounted
 * screen in the DOM. Only open keys `isScreen` accepts count (a screen the
 * manifest lacks is not).
 */
export function mountedScreens(
  keys: readonly string[],
  showing: readonly string[],
  recent: readonly string[],
  isScreen: (key: string) => boolean,
  limit: number = KEEP_MOUNTED
): string[] {
  const keep = new Set(showing.filter((key) => keys.includes(key) && isScreen(key)));
  let hidden = 0;
  for (const key of recent) {
    if (hidden >= limit) break;
    if (showing.includes(key) || keep.has(key) || !keys.includes(key) || !isScreen(key)) continue;
    keep.add(key);
    hidden += 1;
  }
  return keys.filter((key) => keep.has(key));
}

/** The tiles of `layout`, in layout order (none for an empty dock). */
export function tilesOf(layout: Layout | null): Tile[] {
  if (layout === null) return [];
  if (isTile(layout)) return [layout];
  return layout.items.flatMap((item) => tilesOf(item));
}

/** The keys some tile shows, in strip order. */
export function showingKeys(keys: readonly string[], layout: Layout | null): string[] {
  const showing = new Set(tilesOf(layout).map((tile) => tile.showing));
  return keys.filter((key) => showing.has(key));
}

/** What a showing screen reported: its title, zoom scale and open screen. */
export interface Report {
  title?: string;
  scale?: number;
  screen?: ScreenTarget | null;
}

/** The reports of the mounted screens, by tab key. */
export type Reports = Readonly<Record<string, Report>>;

const NO_REPORTS: Reports = {};

/**
 * `prev` with `patch` from tab `key`. An unchanged report keeps `prev`'s
 * identity (so nothing re-renders), and a null screen for a key with no entry
 * (a screen's unmount cleanup after its entry was dropped) adds none.
 */
function withReport(prev: Reports, key: string, patch: Report): Reports {
  const old = prev[key];
  if (old === undefined && patch.screen === null) return prev;
  const next = { ...old, ...patch };
  if (
    old !== undefined &&
    next.title === old.title &&
    next.scale === old.scale &&
    next.screen === old.screen
  ) {
    return prev;
  }
  return { ...prev, [key]: next };
}

/** `prev` without tab `key`'s report (`prev` itself when it has none). */
function withoutReport(prev: Reports, key: string): Reports {
  if (!(key in prev)) return prev;
  const next = { ...prev };
  delete next[key];
  return next;
}

/** The reports of the mounted screens and the callbacks that write them. */
export function useScreenReports(): {
  reported: Reports;
  onTitle: (key: string, title: string) => void;
  onZoom: (key: string, scale: number) => void;
  onScreen: (key: string, screen: ScreenTarget | null) => void;
  onDrop: (key: string) => void;
} {
  const [reported, setReported] = useState<Reports>(NO_REPORTS);
  const onTitle = useCallback(
    (key: string, title: string) => setReported((prev) => withReport(prev, key, { title })),
    []
  );
  const onZoom = useCallback(
    (key: string, scale: number) => setReported((prev) => withReport(prev, key, { scale })),
    []
  );
  const onScreen = useCallback(
    (key: string, screen: ScreenTarget | null) =>
      setReported((prev) => withReport(prev, key, { screen })),
    []
  );
  const onDrop = useCallback((key: string) => setReported((prev) => withoutReport(prev, key)), []);
  return { reported, onTitle, onZoom, onScreen, onDrop };
}

/**
 * One mounted screen tab: ScreenPage for its tab key. `showing` (its tile's
 * showing tab) shows it (a hidden one stays rendered but invisible and inert)
 * and makes it report (title, zoom, open screen), with fresh callbacks when it
 * shows so a tab shown again re-reports at once; `onDrop` takes its report
 * back when it unmounts.
 * Only the `focused` one has print fit. A Print clicked
 * in another tile's bar still prints that tile: the press focuses it
 * first, and the action marks its own overlay item [data-printing], which the
 * print rule prefers over the focused one.
 *
 * Memoised: its props are the tab key, the two flags and stable callbacks,
 * so a WorkspacePage re-render that changes none of them (an EmbedThemeContext
 * flip, a manifest refresh) does not re-render the screen's widgets. Zoom and
 * services reach ScreenPage through context, which memo does not block.
 *
 * With `zoomStore` (the workspace's chrome mode) its zoom is its own key's
 * entry there; without it, the app-level zoom above the workspace.
 *
 * With `onToastsLive` (the workspace's chrome mode) its write gate gets a
 * WriteToastHost: toasts go into `toastColumn`, headed by `toastTitle`, and
 * the screen reports whether it has one. Without it, toasts stay inline.
 *
 * Its widgets act through `hostFor(tab)`, made once per mounted key, so an
 * action runs on this tab whether or not its tile is the focused one.
 */
export const MountedScreen = memo(function MountedScreen({
  screensBaseUrl,
  tab,
  showing,
  focused,
  onTitle,
  onZoom,
  onScreen,
  onDrop,
  toastColumn = null,
  toastTitle = '',
  onToastsLive,
  zoomStore,
  hostFor,
  readiness,
}: {
  screensBaseUrl: string;
  tab: string;
  showing: boolean;
  focused: boolean;
  onTitle: (key: string, title: string) => void;
  onZoom: (key: string, scale: number) => void;
  onScreen: (key: string, screen: ScreenTarget | null) => void;
  onDrop: (key: string) => void;
  toastColumn?: HTMLElement | null;
  toastTitle?: string;
  onToastsLive?: (key: string, live: boolean) => void;
  zoomStore?: ZoomStore;
  hostFor: (key: string) => ActionHost;
  /** Takes the screen-ready signal (the apply loop's guard waits on it). */
  readiness?: ScreenReadiness;
}) {
  const parsed = useMemo(() => parseTabKey(tab), [tab]);
  const onReady = useMemo(
    () => (readiness ? () => readiness.ready(tab) : undefined),
    [readiness, tab]
  );
  useEffect(() => () => readiness?.forget(tab), [readiness, tab]);
  // Its own action host, one per mounted key.
  const host = useMemo(() => hostFor(tab), [hostFor, tab]);
  const onLive = useMemo(
    () => (onToastsLive ? (live: boolean) => onToastsLive(tab, live) : undefined),
    [onToastsLive, tab]
  );
  const toastHost = useMemo<WriteToastHost | null>(
    () => (onLive ? { element: toastColumn, title: toastTitle, onLive } : null),
    [onLive, toastColumn, toastTitle]
  );
  // The focused screen is always a showing one.
  const reporting = showing || focused;
  const reports = useMemo(
    () =>
      reporting
        ? {
            onTitle: (title: string) => onTitle(tab, title),
            onZoom: (scale: number) => onZoom(tab, scale),
            onScreen: (screen: ScreenTarget | null) => onScreen(tab, screen),
          }
        : {},
    [reporting, tab, onTitle, onZoom, onScreen]
  );
  useEffect(() => () => onDrop(tab), [onDrop, tab]);
  if (!parsed || parsed.kind !== 'screen') return null;
  const page = (
    <ScreenPage
      screensBaseUrl={screensBaseUrl}
      chrome={false}
      zoomable
      active={focused}
      category={parsed.category}
      id={parsed.id}
      macros={parsed.macros}
      onReady={onReady}
      {...reports}
    />
  );
  return (
    <div
      className={showing ? 'workspace__screen' : 'workspace__screen workspace__screen--hidden'}
      data-tab-key={tab}
      data-active={focused ? 'true' : 'false'}
      aria-hidden={showing ? undefined : true}
      inert={!showing}
    >
      <ActionHostContext.Provider value={host}>
        <WriteToastHostContext.Provider value={toastHost}>
          {zoomStore ? (
            <KeyedZoomProvider store={zoomStore} zoomKey={tab}>
              {page}
            </KeyedZoomProvider>
          ) : (
            page
          )}
        </WriteToastHostContext.Provider>
      </ActionHostContext.Provider>
    </div>
  );
});
