// The workspace (/embed/*): a screen tree on the left, a tab strip and the
// dock on the right. tabs.ts's reducer is the single source of truth (the
// layout holder): the open keys, the dock's layout (tiles, their tabs and
// showing tab, sizes) and the focused tile, whose showing tab is `active`.
// Every change to the layout goes through it: a drop, every close, a reopen
// (Recently closed, Undo), a restore, Reset. dockview draws what the holder
// says and nothing else; the URL and storage only mirror it.
//
// This page wires the parts together; each part's rules live with it:
//
//   dock         dock/: the content box holds the dock root (createDock) and
//                the overlay layer (DockOverlay) where the viewer renders every
//                panel itself, once, in strip order; useDockBridge is the one
//                decider between the holder and dockview, useDockPersistence
//                stores the layout. A layout change only rewrites an item's
//                geometry, so a screen never remounts because the layout
//                changed.
//   mount set    mountSet.tsx: which screens stay mounted, and what each
//                showing screen reports (title, zoom, open screen).
//   tool URL     workspaceUrl.ts: only the host's navigate message and its
//                same-origin framed first load carry a query on /embed/@<tool>.
//   tools        tools.ts, TraceTab.tsx: every open tool instance stays
//                mounted while it is open, keyed `<key>:<epoch>:<binding
//                generation>` inside its stable item, and is never moved (a
//                moved iframe reloads). The binding generation steps when the
//                data connection's last non-null binding moves to another
//                one, so every tool frame reloads against the new target.
//   headers      tileHeaders.tsx: the strip with one tile, a bar per tile from
//                two tiles on, the single-tile header row, and the shortcut
//                relays; dock/WindowMenu.tsx: the one ☰ (⌥M), at the right end
//                of the top-right tile's bar or of the strip row.
//   zoom         per screen, remembered per user: a ZoomStore owned here
//                (ZoomContext.tsx) keyed category/id, read by each screen and
//                its tile's bar. A screen opens at its remembered zoom, else
//                Fit; the latched ?_canopyZoom applies to the URL-named key
//                only, for this page view, and is never stored. Chrome off
//                keeps the app-level zoom.
//   manifest     useWorkspaceManifest.ts: one conditional poll for the page;
//                every mounted screen reads it through SharedManifestContext.
//   URL          workspaceUrl.ts: the active tab, written with `replace`
//                only. A URL naming a tool instance that cannot open warns
//                once and is replaced by the active tab's URL; so is any
//                single-segment /embed/<seg> that is not a configured tool.
//   actions      one action host per mounted screen, bound to its tab key:
//                open_display replaces that screen in its own tile, focused or
//                not (tab/window targets append), and refuses tool URLs;
//                close_display closes that tab. A workspace-wide host acts on
//                the active tab. All their errors show in the banner.
//   collections  useCollections.ts owns every collection behaviour; the page
//                places its UI (popover, Quick open, the tree's branches, the
//                ☰ entry, the save dialog outside the dock).
//   views, plot  savedViews.ts, SaveView.tsx, PlotPVsDialog.tsx: their
//                dialogs render here, outside the dock.
//   agent        useWorkspaceSync.ts and workspaceApply.ts: the agent's
//                claim, state report and batches, through one ApplyPort.
//   host         host/: what an embedding host shell takes over
//                (hostCapabilities.ts), its header (useHostHeader.ts), its
//                navigation (useHostNavigation.ts) and the focus exit
//                (FocusSentinels.tsx); docs/host-embedding.md.
//   toasts       write toasts of every screen share one viewport-level column
//                (writeGate/toastHost), outside the dock, beside this page's
//                notification toasts (useToasts.tsx).
//   chrome off   `?_canopyChrome=0` (latched at first render, like
//                `?_canopyZoom`): one tile and no dock; only the showing tab's
//                content, no tree, strip, bars, and no URL or tabs writes.
//   test hook    the dock root carries data-showing (the showing keys, JSON,
//                in strip order), data-layout (the holder's layout, JSON) and
//                canopyDockLayout() (the live api.toJSON()), read-only, for the
//                end-to-end tests; nothing else is exposed.
//
// Workspace chrome uses no <main>: ScreenPage's <main> (the zoom scroller)
// stays the page's only one.

import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { useHref, useLocation, useNavigate } from 'react-router-dom';
import type { DockviewApi } from 'dockview-core';
import { ActionHostContext } from '@slaclab/canopy-screen-runtime';
import type { Manifest, ManifestScreen } from '../api.js';
import { useViewerActionHost } from '../actionHost.js';
import type { WorkspaceTabs } from '../actionHost.js';
import type { ViewerConfig } from '../config.js';
import { ErrorPanel } from '../ErrorPanel.js';
import { EmbedThemeContext } from '../pages/EmbedPage.js';
import { ZOOM_PARAM, zoomFromParam } from '../pages/ScreenPage.js';
import type { ScreenHistory } from '../ScreenHeader.js';
import { SCREEN_ACTIONS, availableActions } from '../screenActions/actions.js';
import { isMac, shortcutBindings, useShortcuts } from '../screenActions/shortcuts.js';
import type { ScreenAction, ScreenActionContext, ScreenTarget } from '../screenActions/types.js';
import { ScreenVerbRegistry, useScreenVerbs } from '../screenActions/useScreenActions.js';
import { getShowSubScreens, setShowSubScreens, useShowSubScreens } from '../screenList.js';
import { useBackendBadge } from '../services.js';
import { SharedManifestContext } from '../useManifestPoll.js';
import type { SharedManifest } from '../useManifestPoll.js';
import { ZoomStore, useKeyedZoom, useZoom } from '../ZoomContext.js';
import type { ZoomState } from '../ZoomContext.js';
import { stepZoom } from '../zoom.js';
import { armAgentGuard, isOperatorBusy, onBusyChange } from '../writeGate/guard.js';
import { createGateRegistry } from '../writeGate/machineToasts.js';
import {
  MachineGatesContext,
  MachineToasts,
  WriteToastColumn,
  pinLiveToasts,
} from '../writeGate/toastHost.js';
import { resolveViewDrop } from './browserDrop.js';
import { memberKey, resolveMember } from './collections.js';
import type { Member, MemberKey } from './collections.js';
import { CollectionsPopover, openCollections } from './CollectionsPopover.js';
import { deriveConnectionHealth } from './connectionHealth.js';
import { PlotPVsDialog } from './PlotPVsDialog.js';
import { QuickOpen, openQuickOpen } from './QuickOpen.js';
import {
  SaveCollectionDialog,
  finishSave,
  focusCollectionsTrigger,
  stripMembers,
} from './SaveCollection.js';
import { SaveViewButton, SaveViewDialog } from './SaveView.js';
import { useSavedViews } from './savedViews.js';
import type { SavedView } from './savedViews.js';
import { ScreenTree } from './ScreenTree.js';
import type { ToolEntry } from './ScreenTree.js';
import { TabStrip, isReopenClosedShortcut } from './TabStrip.js';
import type { StripRects, TabStripTab } from './TabStrip.js';
import { TargetBadge } from './TargetBadge.js';
import { toolActionsStore, useToolActions } from './toolActionsStore.js';
import { TraceTab } from './TraceTab.js';
import { OPEN_PARAM, screenMemberOfKey, useCollections } from './useCollections.js';
import type { Collection } from './useCollections.js';
import { LAYOUT_RESET, ToastContext, ToastRegion, useOfferUndo, useToasts } from './useToasts.js';
import type { OfferUndo } from './useToasts.js';
import { useWorkspaceSync } from './useWorkspaceSync.js';
import { ScreenReadiness, createBatchApplier, highlightTouched } from './workspaceApply.js';
import type { ApplyPort } from './workspaceApply.js';
import { buildState } from './workspaceState.js';
import type { BatchEvent } from './workspaceSync.js';
import { WorkspaceSidebar } from './WorkspaceSidebar.js';
import {
  KEEP_MOUNTED,
  MountedScreen,
  mountedScreens,
  showingKeys,
  tilesOf,
  useScreenReports,
} from './mountSet.js';
import {
  SINGLE_TILE_TOOL_ROW,
  ScreenTileHeader,
  ScreenTileRunner,
  TileRunners,
  barPlacement,
} from './tileHeaders.js';
import { useWorkspaceManifest } from './useWorkspaceManifest.js';
import {
  framedBySameOrigin,
  keyForUrl,
  toolUrlOf,
  toolUrlOutcome,
  urlForKey,
} from './workspaceUrl.js';
import { createDock } from './dock/createDock.js';
import { DockOverlay, DockOverlayItem } from './dock/DockOverlay.js';
import { DropPreview } from './dock/DropPreview.js';
import { tileIdsOf, tileOf } from '@slaclab/canopy-dock-engine';
import type { Layout } from '@slaclab/canopy-dock-engine';
import {
  TileBarPortals,
  createTileHeaderActions,
  createTileHeaderRegistry,
  dockDragStart,
} from './dock/tabAdapter.js';
import type { TileHeaderEntry } from './dock/tabAdapter.js';
import { TileActions, TileBar } from './dock/TileBar.js';
import { isViewDrag, useDockBridge } from './dock/useDockBridge.js';
import type { BrowserDrag } from './dock/useDockBridge.js';
import { planDockLoad, useDockPersistence } from './dock/useDockPersistence.js';
import { tabPlacement } from './dock/useTileFocus.js';
import {
  WindowMenu,
  closedTitles,
  isWindowMenuShortcut,
  topRightTile,
  windowMenuShortcutLabel,
} from './dock/WindowMenu.js';
import type { ClosedGroupItem } from './dock/WindowMenu.js';
import { FocusSentinels } from './host/FocusSentinels.js';
import type { HeaderActionContext } from './host/headerActions.js';
import type { HeaderInput, HeaderTab } from './host/headerComposer.js';
import { HostCapabilitiesContext, useHostCapabilities } from './host/hostCapabilities.js';
import { useHostHeader } from './host/useHostHeader.js';
import { useHostNavigation } from './host/useHostNavigation.js';
import {
  EMPTY_TABS,
  TRACE_KEY,
  canOpen,
  firstOpenKey,
  hasStoredTabs,
  instancesOf,
  mintClosedId,
  mruInstance,
  parseTabKey,
  readTabs,
  recordKeys,
  reopenClosed,
  tabsReducer,
  toolProblem,
  viewInstance,
  writeTabs,
} from './tabs.js';
import type {
  ClosedAction,
  ClosedBy,
  CloseInfo,
  OpenMode,
  SavedTab,
  TabsAction,
  TabsState,
} from './tabs.js';
import {
  DEFAULT_TOOL,
  MAX_TOOL_INSTANCES,
  TOOLS,
  configuredTools,
  instanceLabel,
  isToolKey,
  toolConfig,
  toolLabel,
  toolOf,
  toolSpec,
} from './tools.js';
import './workspace.css';
import './dock/dock-theme.css';

/** How long a bar says "Saved …" after a save. */
const SAVED_STATUS_MS = 2500;

/** Reserved query parameter: `0` renders the active tab without chrome. */
export const CHROME_PARAM = '_canopyChrome';

/** An agent command has committed once the page has rendered nothing for this long ... */
const SETTLE_QUIET_MS = 16;
/** ... or after this many such waits. */
const SETTLE_ROUNDS = 10;

/**
 * Reset layout: every tile of `layout`, tabs and showing tab
 * kept, as an equal column of one row; null when there is nothing to lay out.
 */
export function resetTiles(layout: Layout | null): Layout | null {
  const tiles = tilesOf(layout).map(({ tile, tabs, showing }) => ({ tile, tabs, showing }));
  if (tiles.length < 2) return null;
  return { split: 'row', items: tiles.map((t) => ({ ...t, size: 1 / tiles.length })) };
}

/** An agent's open_set members as the unlisted collection Open all opens. */
function agentSet(members: readonly Member[]): Collection {
  return {
    source: 'personal',
    ref: 'agent:open_set',
    id: 'open_set',
    name: 'The agent’s set',
    members: [...members],
    layout: null,
    default: false,
  };
}

/**
 * The dock's live-region text for a panel event. dockview narrates every
 * panel add and remove; the open path re-places panels that stay open, which
 * left "<open tab> closed" in the status region. A close of a tab that is still
 * open says nothing, and open/close name the tab by its title, not its raw key
 * (`@trace`). Other events keep dockview's default (undefined).
 */
export function dockAnnouncement(
  event: { kind: string; panel: { id: string } },
  openKeys: readonly string[],
  titleOf: (key: string) => string
): string | null | undefined {
  const key = event.panel.id;
  if (event.kind === 'open') return `${titleOf(key)} opened`;
  if (event.kind === 'close') return openKeys.includes(key) ? null : `${titleOf(key)} closed`;
  return undefined;
}

function findEntry(manifest: Manifest | null, key: string): ManifestScreen | undefined {
  const parsed = parseTabKey(key);
  if (!manifest || !parsed || parsed.kind !== 'screen') return undefined;
  return manifest.screens.find((s) => s.category === parsed.category && s.id === parsed.id);
}

/**
 * A tool instance's title: its loaded view's name, else the name of the
 * member it was opened from or saved as, else its label (+ " <n>").
 */
function toolTitle(state: TabsState, views: readonly SavedView[], key: string): string {
  const instance = state.instances[key];
  const view = instance?.view;
  const name = view ? views.find((v) => v.id === view)?.name : undefined;
  return name ?? (instance?.title || instanceLabel(key));
}

function tabTitle(
  manifest: Manifest | null,
  key: string,
  state: TabsState,
  views: readonly SavedView[]
): string {
  if (isToolKey(key)) return toolTitle(state, views, key);
  const entry = findEntry(manifest, key);
  if (entry) return entry.title;
  const parsed = parseTabKey(key);
  return parsed && parsed.kind === 'screen' ? parsed.id : key;
}

export interface WorkspacePageProps {
  /** Absolute screens base URL (manifest.json and screens/**). */
  screensBaseUrl: string;
  /** The viewer config; each tool's entry (`trace`, `correlation`) enables its tabs. */
  config?: Readonly<Partial<ViewerConfig>>;
}

/**
 * The generation of the data connection's binding: 0 at first, stepped each
 * time the last non-null binding (config.json, then heartbeats) changes from
 * one non-null value to another. Null to a first binding does not step it: a
 * page whose config.json served no binding had no target for its tool frames
 * to leave. Always 0 without a badge store (mock, fixture, no provider).
 */
function useBindingGeneration(): number {
  const binding = useBackendBadge()?.lastBinding ?? null;
  const [seen, setSeen] = useState({ binding, generation: 0 });
  if (binding === seen.binding) return seen.generation;
  // State from the previous render (React's derived-state pattern).
  const next = {
    binding,
    generation: seen.binding === null ? seen.generation : seen.generation + 1,
  };
  setSeen(next);
  return next.generation;
}

const NO_VIEWS: readonly SavedView[] = [];

/** The zoom state a latched ?_canopyZoom value stands for. */
function latchedZoom(value: 'fit' | number): ZoomState {
  return value === 'fit' ? { mode: 'fit', scale: 1 } : { mode: 'manual', scale: value };
}

const NO_BINDINGS: ReadonlyMap<string, ScreenAction> = new Map();

export function WorkspacePage({ screensBaseUrl, config }: WorkspacePageProps) {
  const location = useLocation();
  const navigate = useNavigate();
  // useHref('/') is the router basename (`/` when there is none).
  const basename = useHref('/');
  const trace = config?.trace;
  const tools = useMemo(() => configuredTools(config), [config]);
  const urlKey = keyForUrl(location.pathname + location.search);

  // Latched at first render: later URL writes drop the reserved parameters.
  const [latched] = useState(() => {
    const params = new URLSearchParams(location.search);
    return {
      chrome: params.get(CHROME_PARAM) !== '0',
      zoom: zoomFromParam(params.get(ZOOM_PARAM)),
      // The deep link the collections hook runs once the dock is laid out.
      open: params.get(OPEN_PARAM),
    };
  });
  const chrome = latched.chrome;
  // What the host takes over (hostCapabilities.ts); everything below reads it.
  const capabilities = useHostCapabilities();
  const { headerOwnedByHost, compactSidebar, homeOnFirstOpen } = capabilities;
  const bindingGeneration = useBindingGeneration();

  // A first visit (nothing stored this session) on a bare /embed/ opens the
  // data browser (with homeOnFirstOpen, the home screen once the manifest is
  // in); a session whose tabs were all closed stays empty. The stored dock
  // layout is read here, once: a reload reconciles it
  // against the session's tabs, a new session reopens its stored panels.
  // The restored keys (the stored tabs) and the URL's key are latched too:
  // Recent records the URL's screen at mount only when restore did not bring
  // it back (a fresh `src` navigation, not a reload).
  // The host's first load of a tool URL with a query brings its own tab, so no
  // data browser joins it unless it is refused. On any other load the query is
  // ignored (toolUrlOf says why).
  const [{ initial, restoredKeys, mountUrlKey, mountNotice }] = useState(() => {
    const stored = chrome ? readTabs(basename) : EMPTY_TABS;
    const toolUrl = framedBySameOrigin() ? toolUrlOf(location.pathname + location.search) : null;
    const plan = (key: string | null, suppressFirstVisit: boolean) =>
      planDockLoad({
        chrome,
        basename,
        stored,
        urlKey: key,
        tools,
        newSession: !hasStoredTabs(basename),
        suppressFirstVisit,
        homeOnFirstOpen,
        // Chrome off: one tile, no dock; the reducer refuses drops and arrangements.
        ...(chrome ? {} : { oneTile: true }),
      });
    // A deep link brings its own members: no data browser joins them.
    const deepLink = latched.open !== null;
    let loaded = plan(toolUrl === null ? urlKey : null, deepLink || toolUrl !== null);
    let toolNotice: string | null = null;
    if (toolUrl !== null) {
      const outcome = toolUrlOutcome(
        loaded.state,
        toolUrl,
        tools,
        toolConfig(config, toolUrl.tool)?.query,
        Date.now()
      );
      if ('notice' in outcome) {
        toolNotice = outcome.notice;
        loaded = plan(null, deepLink);
      } else {
        loaded = { ...loaded, state: tabsReducer(loaded.state, outcome.action) };
      }
    }
    return {
      initial: loaded,
      restoredKeys: stored.keys,
      // Without chrome nothing is stored, so a reload cannot be told apart: no record.
      mountUrlKey: chrome ? urlKey : null,
      mountNotice: toolNotice,
    };
  });
  const [state, dispatch] = useReducer(tabsReducer, initial.state);

  const warned = useRef(false);
  useEffect(() => {
    if (warned.current) return;
    warned.current = true;
    for (const warning of initial.warnings) console.warn(`Workspace: ${warning}`);
  }, [initial]);

  // Zoom (chrome): per screen. The latched ?_canopyZoom is latched (in
  // memory, never stored) on the URL-named key before the first render reads
  // it, ahead of that screen's remembered zoom; other keys read theirs or Fit.
  const [zoomStore] = useState(() => {
    const store = new ZoomStore(basename);
    if (chrome && latched.zoom !== null && urlKey !== null) {
      store.latch(urlKey, latchedZoom(latched.zoom));
    }
    return store;
  });
  // Without chrome: the app-level zoom, latched once before the first paint.
  const appZoom = useZoom();
  const { setFit: appFit, setManual: appManual } = appZoom;
  useLayoutEffect(() => {
    if (chrome) return;
    if (latched.zoom === 'fit') appFit();
    else if (latched.zoom !== null) appManual(latched.zoom);
  }, [chrome, latched, appFit, appManual]);

  // Mirror the tabs into sessionStorage (keyed by the mount) and the active
  // tab into the URL.
  const here = location.pathname + location.search;
  useEffect(() => {
    if (!chrome) return;
    writeTabs(state, basename);
  }, [basename, chrome, state]);
  // useNavigate's identity follows the location, so it is read through a ref:
  // only a tab change writes the URL (else a URL the workspace did not write
  // would be overwritten before its tab opens, and the two would ping-pong).
  const navigateRef = useRef(navigate);
  useLayoutEffect(() => {
    navigateRef.current = navigate;
  }, [navigate]);
  // The router's location reaches a render only after a write lands, so two
  // focus changes in quick succession (a press that focuses a tile, then its
  // × that closes it) would compare the second target against a stale
  // `here` and skip the write, and the late echo of the first write would
  // then read as a navigation to a tab the workspace has just left. The URL
  // last written or seen is kept here, and every write is queued until the
  // router reports it back, so an echo of the workspace's own write is never
  // taken for an outside navigation.
  const knownUrl = useRef(here);
  const ownWrites = useRef<string[]>([]);
  useLayoutEffect(() => {
    knownUrl.current = here;
  }, [here]);
  const writeUrl = useCallback((target: string) => {
    knownUrl.current = target;
    ownWrites.current.push(target);
    void navigateRef.current(target, { replace: true });
  }, []);
  useEffect(() => {
    if (!chrome) return;
    const target = urlForKey(state.active);
    if (target !== knownUrl.current) writeUrl(target);
  }, [chrome, state.active, writeUrl]);

  // The latest state, for effects and callbacks that must not re-run on it.
  const stateRef = useRef(state);
  useLayoutEffect(() => {
    stateRef.current = state;
  }, [state]);

  // Back to the active tab's URL (the URL is otherwise written only when the
  // active tab changes). Without chrome the workspace writes no tab URL: a
  // refused URL falls back to /embed/ with its query.
  const restoreUrl = useCallback(() => {
    if (chrome) {
      writeUrl(urlForKey(stateRef.current.active));
    } else {
      void navigateRef.current(
        { pathname: '/embed/', search: window.location.search },
        {
          replace: true,
        }
      );
    }
  }, [chrome, writeUrl]);

  // A URL the workspace did not write (a link, a host navigation) opens its
  // tab; a tool instance that cannot open warns and restores the URL.
  const lastUrlKey = useRef(urlKey);
  // Recent's choke point, set once the collections hook exists (below).
  const recordUrlOpen = useRef<(key: string) => void>(() => {});
  useEffect(() => {
    if (urlKey === lastUrlKey.current) {
      // A write that only dropped a tool URL's query still comes back as our own.
      const same = ownWrites.current.indexOf(here);
      if (same >= 0) ownWrites.current.splice(0, same + 1);
      return;
    }
    lastUrlKey.current = urlKey;
    const echo = ownWrites.current.indexOf(here);
    if (echo >= 0) {
      // The workspace's own write coming back (earlier unseen ones are dropped
      // with it). A stale one, with no later write still in flight, is put right.
      ownWrites.current.splice(0, echo + 1);
      if (urlKey !== state.active && ownWrites.current.length === 0) restoreUrl();
      return;
    }
    if (urlKey === null) return;
    // An outside navigation (a link, a host or agent open) is history (Recent).
    recordUrlOpen.current(urlKey);
    if (urlKey === state.active) return;
    if (urlKey.startsWith('@')) {
      const problem =
        toolProblem(urlKey, tools) ??
        (canOpen(state, urlKey)
          ? null
          : `At most ${MAX_TOOL_INSTANCES} ${toolLabel(toolOf(urlKey)!)} tabs`);
      if (problem !== null) {
        console.warn(`Workspace: ${problem}; ignoring /embed/${urlKey}.`);
        restoreUrl();
        return;
      }
    }
    dispatch({ type: 'open', key: urlKey, mode: 'append' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlKey, here]);

  // Refused at mount: with chrome the active tab's URL is written anyway.
  useEffect(() => {
    if (!chrome && mountNotice !== null) restoreUrl();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A single-segment /embed/<seg> that is not a configured tool names no tab
  // (a category alone, a tool not served here): back to the active tab's URL,
  // on mount and whenever the URL changes to one — keyForUrl is null for
  // both /embed/ and /embed/SR, so the urlKey effect never sees that change.
  const pathname = location.pathname;
  useEffect(() => {
    const single = /^\/embed\/([^/]+)\/?$/.exec(pathname);
    if (!single) return;
    const key = keyForUrl(pathname);
    if (key !== null && toolProblem(key, tools) === null) return;
    restoreUrl();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  const { manifest, refetch: refetchManifest } = useWorkspaceManifest(screensBaseUrl);
  const sharedManifest = useMemo<SharedManifest>(
    () => ({ base: screensBaseUrl, manifest }),
    [screensBaseUrl, manifest]
  );

  // The home screen on a first open (homeOnFirstOpen): a never-stored base
  // path opened nothing at mount. When the first manifest arrives and nothing is open yet, open the
  // configured home, else the first screen of the tree, else nothing —
  // through the reducer, so Recent records nothing. One shot.
  const pendingHome = useRef(initial.pendingHome === true);
  const homeScreen = config?.home?.screen;
  useEffect(() => {
    if (!pendingHome.current || manifest === null) return;
    pendingHome.current = false;
    if (state.keys.length > 0) return;
    const key = firstOpenKey(manifest.screens, homeScreen);
    if (key !== null) dispatch({ type: 'open', key, mode: 'append' });
  }, [manifest, homeScreen, state.keys.length]);

  // The action host drives the reducer; it reads these through a ref.
  const activeRef = useRef(state.active);
  useLayoutEffect(() => {
    activeRef.current = state.active;
  }, [state.active]);
  // The tabs an action host drives: bound to tab `tile` (a screen's own
  // host), or with null to whichever tab is active (the workspace-wide one).

  // The one close path: every close, from the strip, a tile bar, a
  // screen's own close action or a workspace command, goes through the
  // reducer, which records its group with an id and its closer, and offers it
  // for Undo as the one toast. offerUndo is created further down; it is read
  // through a ref here.
  const offerUndoRef = useRef<OfferUndo>(() => {});
  const closeTabs = useCallback(
    (
      keys: readonly string[],
      make: (closed: CloseInfo) => TabsAction,
      closedBy: ClosedBy = 'you'
    ): string | null => {
      const now = stateRef.current;
      const closing = now.keys.filter((k) => keys.includes(k));
      if (closing.length === 0) return null;
      const id = mintClosedId(now.closedStack);
      dispatch(make({ id, closedBy }));
      offerUndoRef.current(id, closing.length);
      return id;
    },
    []
  );
  const tabsFor = useCallback(
    (tile: string | null): WorkspaceTabs => ({
      open: (url: string, mode: OpenMode) => {
        const key = keyForUrl(url);
        // A screen action never opens a tool: that would bypass the opening
        // rules and the instance cap.
        if (key === null || key.startsWith('@')) {
          console.warn(`Workspace: no tab for ${url}`);
          return;
        }
        // A replace targets the action host's own tab when it is open, else
        // the focused tile; never another open screen.
        const target = mode === 'replace' && tile !== null ? tile : undefined;
        dispatch(
          target === undefined ? { type: 'open', key, mode } : { type: 'open', key, mode, target }
        );
      },
      close: () => {
        if (tile === null) {
          const focused = stateRef.current.active;
          if (focused !== null) closeTabs([focused], (closed) => ({ type: 'closeActive', closed }));
        } else {
          closeTabs([tile], (closed) => ({ type: 'close', key: tile, closed }));
        }
      },
      currentPathname: () => {
        const key = tile ?? activeRef.current;
        if (key === null || isToolKey(key)) return undefined;
        const url = urlForKey(key);
        const cut = url.indexOf('?');
        return cut === -1 ? url : url.slice(0, cut);
      },
    }),
    [closeTabs]
  );
  const tabs = useMemo(() => tabsFor(null), [tabsFor]);
  const { host, error, clearError, hostFor } = useViewerActionHost(screensBaseUrl, tabs);
  const hostForTab = useCallback((key: string) => hostFor(tabsFor(key)), [hostFor, tabsFor]);

  const onOpen = useCallback((key: string, mode: OpenMode) => {
    dispatch({ type: 'open', key, mode });
  }, []);
  const onFocus = useCallback((key: string) => dispatch({ type: 'focus', key }), []);
  const onClose = useCallback(
    (key: string) => void closeTabs([key], (closed) => ({ type: 'close', key, closed })),
    [closeTabs]
  );
  // Close others / close to the right act within the tab's tile (one group).
  const onCloseOthers = useCallback(
    (key: string) => {
      const tile = tileOf(stateRef.current.layout, key);
      if (tile === null) return;
      closeTabs(
        tile.tabs.filter((k) => k !== key),
        (closed) => ({ type: 'closeOthers', key, closed })
      );
    },
    [closeTabs]
  );
  const onCloseToRight = useCallback(
    (key: string) => {
      const tile = tileOf(stateRef.current.layout, key);
      if (tile === null) return;
      closeTabs(tile.tabs.slice(tile.tabs.indexOf(key) + 1), (closed) => ({
        type: 'closeToRight',
        key,
        closed,
      }));
    },
    [closeTabs]
  );
  const onCloseAll = useCallback(
    () => void closeTabs(stateRef.current.keys, (closed) => ({ type: 'closeAll', closed })),
    [closeTabs]
  );
  const onOpenTool = useCallback((tool: string) => dispatch({ type: 'openTool', tool }), []);
  const onNewTool = useCallback((tool: string) => dispatch({ type: 'newInstance', tool }), []);
  const onToolQuery = useCallback(
    (key: string, query: string) => dispatch({ type: 'setQuery', key, query }),
    []
  );

  // What every showing ScreenPage reported (title, scale, open screen), by tab
  // key; a screen's entry goes when it unmounts.
  const { reported, onTitle, onZoom, onScreen, onDrop } = useScreenReports();
  const active = state.active;

  const { mode, id } = useContext(EmbedThemeContext);
  const activeParsed = active === null ? null : parseTabKey(active);
  const activeIsScreen = activeParsed?.kind === 'screen';
  const missing =
    activeIsScreen && manifest !== null && active !== null && !findEntry(manifest, active);
  const activeTool = toolOf(active);

  // The keys some tile shows, in strip order: shown, reporting and mounted.
  const showing = useMemo(() => showingKeys(state.keys, state.layout), [state.keys, state.layout]);
  // The screen tabs focused most recently, newest first; with the showing ones
  // they are the screens kept mounted. Long enough to hold KEEP_MOUNTED
  // hidden ones besides the showing; a tab that falls off is forgotten, so a
  // later close never brings an evicted screen back.
  // Updated during render (React's "adjust state on a prop change"), so the
  // switch that changes the active tab already mounts the right screens.
  const [recent, setRecent] = useState<string[]>([]);
  if (active !== null && activeIsScreen && recent[0] !== active) {
    setRecent(
      [active, ...recent.filter((k) => k !== active)].slice(0, KEEP_MOUNTED + showing.length)
    );
  }
  // A screen key the (fresh) manifest lacks: shown as tab-missing, never mounted.
  const isMissing = useCallback(
    (key: string) =>
      manifest !== null && parseTabKey(key)?.kind === 'screen' && !findEntry(manifest, key),
    [manifest]
  );
  // The shared write-toast column (chrome mode) and the screens with a live
  // toast in it: those stay mounted past KEEP_MOUNTED until it is gone.
  const [toastColumn, setToastColumn] = useState<HTMLDivElement | null>(null);
  // The page's write gates, watched by its machine toasts.
  const machineGates = useMemo(() => createGateRegistry(), []);
  // The notification toasts: one store, shown beside the write column.
  const toasts = useToasts();
  const [toastLive, setToastLive] = useState<readonly string[]>([]);
  const onToastsLive = useCallback(
    (key: string, live: boolean) =>
      setToastLive((prev) =>
        live
          ? prev.includes(key)
            ? prev
            : [...prev, key]
          : prev.includes(key)
            ? prev.filter((k) => k !== key)
            : prev
      ),
    []
  );
  const mounted = useMemo(() => {
    const isScreen = (key: string) => parseTabKey(key)?.kind === 'screen' && !isMissing(key);
    return pinLiveToasts(
      mountedScreens(state.keys, showing, recent, isScreen),
      state.keys,
      toastLive,
      isScreen
    );
  }, [state.keys, showing, recent, isMissing, toastLive]);

  // Saved views of every kind (config.views), shared through the server.
  const saved = useSavedViews(config?.views?.path, document.baseURI);
  const views = config?.views === undefined ? NO_VIEWS : saved.views;

  const stripTabs: TabStripTab[] = useMemo(
    () => state.keys.map((key) => ({ key, title: tabTitle(manifest, key, state, views) })),
    [state, manifest, views]
  );

  // The focused tile's zoom (chrome), else the app-level one.
  const focusedZoom = useKeyedZoom(zoomStore, active ?? '');
  const zoom = chrome ? focusedZoom : appZoom;

  const own = active === null ? undefined : reported[active];
  // The focused tab's title: what its screen reported, else the strip's.
  const title = active === null ? '' : (own?.title ?? tabTitle(manifest, active, state, views));
  const scale = own?.scale ?? (zoom.mode === 'manual' ? zoom.scale : 1);

  // The URL that reopens the active tab: the workspace URL naming it.
  const activeHref = useHref(urlForKey(active));
  const fit = zoom.mode === 'fit';
  const ownScreen = activeIsScreen && !missing ? (own?.screen ?? null) : null;

  // The document's title (which a shell framing the page shows) follows the
  // focused tile's; the page's own comes back when the workspace goes.
  useEffect(() => {
    if (title === '') return;
    const previous = document.title;
    document.title = title;
    return () => {
      document.title = previous;
    };
  }, [title]);
  // The screen whose PVs the "Plot in Data Browser" chooser offers, while open.
  const [plotTarget, setPlotTarget] = useState<ScreenTarget | null>(null);
  const plotInDataBrowser = trace === undefined ? undefined : setPlotTarget;
  const actions = useMemo<ScreenActionContext | undefined>(
    () =>
      ownScreen
        ? {
            screen: ownScreen,
            zoom: { scale, fit },
            config,
            link: new URL(activeHref, window.location.href).href,
            plotInDataBrowser,
          }
        : undefined,
    [ownScreen, scale, fit, config, activeHref, plotInDataBrowser]
  );

  // The one shortcut listener: bound to the focused screen's available
  // actions, which it runs through that tile's bar (its relay's runner), so
  // the outcome shows in that bar as a click's would. The bars bind none.
  const [runners] = useState(() => new TileRunners());
  // While the host owns the header, every mounted screen also has a headless
  // runner; its verbs are published here for the host header and its
  // outcomes are toasts.
  const [screenVerbs] = useState(() => new ScreenVerbRegistry());
  const toastVerbOutcome = useCallback(
    (text: string) => {
      toasts.show({ message: text });
    },
    [toasts]
  );
  const shortcutKeys = useMemo(
    () =>
      chrome && actions ? shortcutBindings(availableActions(actions, SCREEN_ACTIONS)) : NO_BINDINGS,
    [chrome, actions]
  );
  const onShortcut = useCallback(
    (action: ScreenAction) => {
      if (active !== null) runners.run(active, action);
    },
    [runners, active]
  );
  useShortcuts(shortcutKeys, onShortcut);

  const [viewError, setViewError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(mountNotice);

  // The query an instance shows: its own, else its tool's config default.
  const instanceQuery = (key: string): string =>
    state.instances[key]?.query ?? toolConfig(config, toolOf(key) ?? '')?.query ?? '';

  // At a tool's instance cap a view loads into the most recently used
  // instance (as the reducer does); the notice names it.
  const capTarget = useCallback(
    (now: TabsState, kind: string): string => {
      const target = mruInstance(now, kind)!;
      setNotice(
        `At most ${MAX_TOOL_INSTANCES} ${toolLabel(kind)} tabs; loaded into ${toolTitle(
          now,
          saved.views,
          target
        )}`
      );
      return target;
    },
    [saved.views]
  );
  const onOpenView = useCallback(
    (view: SavedView, newTab: boolean) => {
      if (!tools.includes(view.kind)) return;
      const now = stateRef.current;
      const showing = newTab ? null : viewInstance(now, view.kind, view.id);
      if (showing === null && instancesOf(now, view.kind).length >= MAX_TOOL_INSTANCES) {
        capTarget(now, view.kind);
      }
      dispatch({ type: 'openView', tool: view.kind, query: view.query, view: view.id, newTab });
    },
    [tools, capTarget]
  );
  // canopy:trace-open from any tool frame: a registered tool and a
  // query valid for it, else ignored; an unconfigured tool gets a notice. It
  // opens a new instance, or at the cap loads into the most recently used.
  const onTraceOpen = useCallback(
    (tool: string, query: string) => {
      const spec = toolSpec(tool);
      if (spec === undefined || !spec.isValidQuery(query)) return;
      if (!tools.includes(tool)) {
        setNotice(`${toolLabel(tool)} is not available here`);
        return;
      }
      const now = stateRef.current;
      if (instancesOf(now, tool).length >= MAX_TOOL_INSTANCES) {
        dispatch({ type: 'load', key: capTarget(now, tool), query, view: null });
      } else {
        dispatch({ type: 'newInstance', tool, query });
      }
    },
    [tools, capTarget]
  );
  // The member keys the Browse tree renders, which alone a drop is trusted
  // for: the set the tree reports (onRenderedKeys), read through a ref so the
  // bridge's options do not churn with it. Empty until the tree reports.
  const renderedKeys = useRef<ReadonlySet<MemberKey>>(new Set());
  const onRenderedKeys = useCallback((keys: ReadonlySet<MemberKey>) => {
    renderedKeys.current = keys;
  }, []);
  // A screen-browser row dragged into the dock: the key its click would reach
  // (resolveMember for a member, which also refuses what the tree does not
  // render, since the payload is the DataTransfer's; resolveViewDrop for a
  // saved view) is resolved at the drag's start and recorded as the dock's
  // `{new: key}` source, so the bridge decides the drop and the reducer
  // places it. A query (a view, a tool member) loads once that drop has
  // changed the layout, so the load finds its instance open where it was
  // dropped instead of opening it into the focused tile; the drag's end
  // forgets a load no drop took.
  const pendingLoad = useRef<{
    key: string;
    load: { query: string; view: string | null };
    atCap?: string;
    layout: Layout | null;
  } | null>(null);
  const onBrowserDragStart = useCallback(
    (drag: BrowserDrag, dataTransfer: DataTransfer | null) => {
      const now = stateRef.current;
      let target: { key: string; load?: { query: string; view: string | null }; atCap?: string };
      if (isViewDrag(drag)) {
        const view = resolveViewDrop(drag.id, { state: now, tools, views: saved.views });
        if (view === null) return;
        target = view;
      } else {
        const resolved = resolveMember(
          drag,
          {
            state: now,
            screens: manifest?.screens ?? null,
            tools,
            renderedKeys: renderedKeys.current,
          },
          { source: 'drop', atCap: 'mru' }
        );
        if (resolved.status !== 'resolved') return;
        target = resolved;
      }
      pendingLoad.current = target.load
        ? {
            key: target.key,
            load: target.load,
            ...(target.atCap !== undefined ? { atCap: target.atCap } : {}),
            layout: now.layout,
          }
        : null;
      dockDragStart({ new: target.key }, dataTransfer);
      const forget = () => {
        document.removeEventListener('dragend', forget, true);
        // A turn later: the drop's own render has run its load by then.
        setTimeout(() => {
          pendingLoad.current = null;
        }, 0);
      };
      document.addEventListener('dragend', forget, true);
    },
    [manifest, tools, saved.views]
  );
  useLayoutEffect(() => {
    const pending = pendingLoad.current;
    if (pending === null || state.layout === pending.layout) return;
    if (!state.keys.includes(pending.key)) return;
    pendingLoad.current = null;
    if (pending.atCap !== undefined) capTarget(state, pending.atCap);
    dispatch({ type: 'load', key: pending.key, ...pending.load });
  }, [state, capTarget]);
  const onRevertView = useCallback((view: SavedView) => {
    const key = viewInstance(stateRef.current, view.kind, view.id);
    if (key !== null) dispatch({ type: 'load', key, query: view.query, view: view.id });
  }, []);
  const { remove: removeView, save: saveView } = saved;
  const onDeleteView = useCallback(
    (view: SavedView) => {
      removeView(view.id).catch((err: unknown) =>
        setViewError(err instanceof Error ? err.message : String(err))
      );
    },
    [removeView]
  );
  const activeView = activeTool === undefined ? null : (state.instances[active!]?.view ?? null);
  const viewsEnabled = config?.views !== undefined;

  // Views whose instance has drifted from them: "Revert to saved".
  const revertable = useMemo(() => {
    const ids = new Set<string>();
    for (const view of views) {
      if (!tools.includes(view.kind)) continue;
      const key = viewInstance(state, view.kind, view.id);
      const cfg = toolConfig(config, view.kind);
      if (key !== null && (state.instances[key]?.query ?? cfg?.query ?? '') !== view.query) {
        ids.add(view.id);
      }
    }
    return ids;
  }, [views, tools, state, config]);

  // "Plot in Data Browser" targets the most recently used data browser
  // instance (instance 1 when none is open), and keeps that one's time range.
  const plotKey = mruInstance(state, DEFAULT_TOOL) ?? TRACE_KEY;
  const onPlot = useCallback(
    (query: string) => {
      setPlotTarget(null);
      dispatch({ type: 'load', key: plotKey, query, view: null });
    },
    [plotKey]
  );
  const plotDialog = plotTarget ? (
    <PlotPVsDialog
      screen={plotTarget}
      currentQuery={trace ? instanceQuery(plotKey) : ''}
      onPlot={onPlot}
      onClose={() => setPlotTarget(null)}
    />
  ) : null;

  const toolEntries = useMemo<ToolEntry[]>(
    () =>
      TOOLS.filter((tool) => tools.includes(tool.id)).map((tool) => ({
        id: tool.id,
        label: tool.label,
        treeLabel: tool.treeLabel,
        full: instancesOf(state, tool.id).length >= MAX_TOOL_INSTANCES,
      })),
    [tools, state]
  );

  // The dock (chrome only): created once its root is in the DOM, disposed
  // with it. Without chrome there is no dock and the bridge gets no api.
  // Every tile gets one bar (its tabs) and one actions slot (the showing
  // tab's header): the group header actions are set on the api before the
  // first layout, so the first tile already has them.
  const dockRoot = useRef<HTMLDivElement>(null);
  // The dock root as state: the bridge attaches its drop and resize listeners to it.
  const [dockRootEl, setDockRootEl] = useState<HTMLDivElement | null>(null);
  const [dockApi, setDockApi] = useState<DockviewApi | null>(null);
  const [tileHeaders] = useState(() => createTileHeaderRegistry());
  useLayoutEffect(() => {
    const root = dockRoot.current;
    if (!chrome || !root) return;
    const api = createDock(root);
    api.updateOptions(createTileHeaderActions(tileHeaders));
    setDockApi(api);
    setDockRootEl(root);
    return () => {
      setDockApi(null);
      setDockRootEl(null);
      api.dispose();
    };
  }, [chrome, tileHeaders]);
  // A new panel's title, read through a ref so the bridge's options never churn.
  const titleSource = useRef((key: string) => key);
  useLayoutEffect(() => {
    titleSource.current = (key: string) => tabTitle(manifest, key, state, views);
  });
  const titleOf = useCallback((key: string) => titleSource.current(key), []);
  // The dock's live region never says "<open tab> closed".
  useLayoutEffect(() => {
    dockApi?.updateOptions({
      getAnnouncement: (event) => dockAnnouncement(event, stateRef.current.keys, titleOf),
    });
  }, [dockApi, titleOf]);
  // The one decider: it applies the holder's layout to the dock (the mount's
  // too, once the api exists; never while a drag is live), turns drops into
  // `drop` and sash moves and dock size changes into `resized`.
  const bridge = useDockBridge(dockApi, state, dispatch, { root: dockRootEl, titleOf });
  // The window's side of canopy_mcp's workspace hub (chrome only, and only
  // when config.json advertises it): claim, stream, and the throttled state report.
  // The state is built at send time from the latest values.
  const syncState = useRef(() =>
    buildState({ tabs: stateRef.current, zoomOf: (key) => zoomStore.get(key) })
  );
  useLayoutEffect(() => {
    syncState.current = () =>
      buildState({
        tabs: stateRef.current,
        zoomOf: (key) => zoomStore.get(key),
        labelOf: (key) => titleSource.current(key),
        defaultQueryOf: (tool) => toolConfig(config, tool)?.query,
      });
  });
  // The apply loop for the agent's batches (workspaceApply.ts): it reads the
  // window through `applyPort`, whose methods read the latest values below.
  const applyPort = useRef<ApplyPort | null>(null);
  const applier = useRef<((batch: BatchEvent) => Promise<void>) | null>(null);
  const onBatch = useCallback((batch: BatchEvent) => {
    applier.current ??= createBatchApplier(() => applyPort.current!);
    void applier.current(batch);
  }, []);
  const workspaceSync = useWorkspaceSync({
    enabled: chrome,
    workspace: config?.workspace,
    getState: () => syncState.current(),
    onBatch,
  });
  // Every layout change (sizes included) is a holder change.
  useEffect(() => {
    workspaceSync.current?.changed();
  }, [workspaceSync, state, manifest, views]);
  useEffect(
    () => zoomStore.subscribe(() => workspaceSync.current?.changed()),
    [workspaceSync, zoomStore]
  );
  // Writes the holder's layout back, armed by the first trusted event
  // inside the workspace; never without chrome.
  const workspaceRef = useRef<HTMLDivElement>(null);
  const persistence = useDockPersistence({
    state,
    basename,
    enabled: chrome,
    root: workspaceRef,
  });
  // Reopen a closed group: `id`, else the newest (⌘⇧T, "Reopen closed
  // tab"); the toast's Undo, "Recently closed" and the agent's `reopen` call
  // it too. The reducer brings the record back where it was (a layout group
  // replaces the dock with the one it recorded, against the tabs open now).
  // Tool tabs refused at their instance cap get one notice. Returns the
  // group, or null when there is none.
  const reopenGroup = useCallback((id?: string): ClosedAction | null => {
    const { entry, skipped } = reopenClosed(stateRef.current, id);
    if (entry === undefined) return null;
    dispatch({ type: 'reopenClosed', id: entry.id });
    if (skipped.length > 0) {
      const labels = [...new Set(skipped.map((key) => toolLabel(toolOf(key) ?? key)))];
      setNotice(`At most ${MAX_TOOL_INSTANCES} tabs per tool; not reopened: ${labels.join(', ')}`);
    }
    return entry;
  }, []);
  const offerUndo = useOfferUndo(toasts, reopenGroup);
  useLayoutEffect(() => {
    offerUndoRef.current = offerUndo;
  }, [offerUndo]);
  // ⌘⇧T (Ctrl+Shift+T elsewhere), where the browser lets the page have it.
  useEffect(() => {
    if (!chrome) return undefined;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !isReopenClosedShortcut(e, isMac)) return;
      e.preventDefault();
      reopenGroup();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [chrome, reopenGroup]);
  // "Reset layout": every tile as an equal column, tabs kept, through the
  // reducer as one layout group offered for Undo; persisted as the
  // operator's act. Null below two tiles (nothing done).
  const resetLayoutBy = useCallback(
    (closedBy: ClosedBy): string | null => {
      const now = stateRef.current;
      const layout = resetTiles(now.layout);
      if (layout === null) return null;
      const id = mintClosedId(now.closedStack);
      dispatch({ type: 'replaceLayout', layout, closed: { id, closedBy } });
      persistence.schedule(true);
      offerUndo(id, 0, 'layout');
      return id;
    },
    [persistence, offerUndo]
  );
  const onResetLayout = useCallback(() => void resetLayoutBy('you'), [resetLayoutBy]);
  const tileCount = tileIdsOf(state.layout).length;
  const resetDisabled = tileCount < 2;
  // "Recently closed": the closed groups newest first, each with its closer.
  // A layout group (Reset, an arrangement, Close all) brings back the whole
  // dock it recorded: it is a layout reset while some of its tabs are open,
  // and names its tabs when none is (a closed dock).
  const closedGroups = useMemo((): ClosedGroupItem[] => {
    const titleOfKey = (key: string) => tabTitle(manifest, key, state, views);
    return [...(state.closedStack ?? [])].reverse().map((entry) => {
      const keys = recordKeys(entry);
      const reset = entry.kind === 'layout' && keys.some((key) => state.keys.includes(key));
      return {
        id: entry.id,
        closedBy: entry.closedBy,
        label: reset ? LAYOUT_RESET : closedTitles(keys.map(titleOfKey)),
      };
    });
  }, [state, manifest, views]);
  const onReopenGroup = useCallback((id: string) => void reopenGroup(id), [reopenGroup]);

  // Collections (config.collections): the hook owns every orchestration
  // (Open all, a layout's apply, the _canopyOpen deep link and its URL
  // removal, Recent); the page passes it what it reads and places its UI.
  // The page's own writeUrl is passed so the deep link's removal is known as
  // the workspace's own write, not an outside navigation.
  // A member open matches an instance on its tool's config default against
  // the member a save stores for it: the reducer is config-free, so the
  // default rides on the action.
  const collectionsDispatch = useCallback(
    (action: TabsAction) => {
      if (action.type === 'openMember' && 'tool' in action.member) {
        const defaultQuery = toolConfig(config, action.member.tool)?.query;
        if (defaultQuery !== undefined && action.defaultQuery === undefined) {
          dispatch({ ...action, defaultQuery });
          return;
        }
      }
      dispatch(action);
    },
    [config]
  );
  const collections = useCollections({
    path: config?.collections?.path,
    base: document.baseURI,
    state,
    stateRef,
    dispatch: collectionsDispatch,
    screens: manifest?.screens ?? null,
    tools,
    chrome,
    persistence,
    notify: setNotice,
    openRef: latched.open,
    here,
    writeUrl,
    root: workspaceRef,
    urlKey: mountUrlKey,
    restoredKeys,
  });
  const { recordOpen } = collections;
  useLayoutEffect(() => {
    recordUrlOpen.current = (key) => {
      const member = screenMemberOfKey(key);
      if (member !== null) void recordOpen(member);
    };
  }, [recordOpen]);
  // The agent's batches (see workspaceApply.ts). The loop holds one port for
  // the page's life; every method reads the latest render's values (`live`),
  // since a batch outlives the render it started in.
  const [readiness] = useState(() => new ScreenReadiness());
  // The window's changes made while no agent command is in flight are the
  // operator's: one between two commands fails the next stale_state.
  const applying = useRef(false);
  const operatorChanges = useRef(0);
  useLayoutEffect(() => {
    if (!applying.current) operatorChanges.current += 1;
  }, [state]);
  useEffect(
    () =>
      zoomStore.subscribe(() => {
        if (!applying.current) operatorChanges.current += 1;
      }),
    [zoomStore]
  );
  // Commits, counted so a command waits until the page has gone quiet.
  const commits = useRef(0);
  useLayoutEffect(() => {
    commits.current += 1;
  });
  const settled = useCallback(async (): Promise<void> => {
    for (let round = 0; round < SETTLE_ROUNDS; round += 1) {
      const before = commits.current;
      await new Promise((resolve) => setTimeout(resolve, SETTLE_QUIET_MS));
      if (commits.current === before) return;
    }
  }, []);
  const live = useRef({ manifest, mounted, reported, collections });
  useLayoutEffect(() => {
    live.current = { manifest, mounted, reported, collections };
  });
  useLayoutEffect(() => {
    applyPort.current = {
      tabs: () => stateRef.current,
      dispatch,
      closeTabs,
      reopenGroup,
      resetLayout: (closedBy) => resetLayoutBy(closedBy),
      zoomOf: (key) => zoomStore.get(key),
      setZoom: (key, zoomState) => zoomStore.set(key, zoomState),
      reportedScale: (key) => live.current.reported[key]?.scale,
      // open_collection names a listed collection; open_set's members open
      // as an unlisted one, through the same Open all (caller agent).
      openAll: async (source, { as, layout, closedBy }) => {
        const collection =
          typeof source === 'string'
            ? live.current.collections.collections.find((c) => c.ref === source)
            : agentSet(source);
        if (collection === undefined) return null;
        const opened = await live.current.collections.openAll(collection, {
          caller: 'agent',
          closedBy,
          ...(as !== undefined ? { as } : {}),
          ...(layout !== undefined ? { layout } : {}),
        });
        if (opened.group !== null) offerUndoRef.current(opened.group, 0, 'layout');
        return opened;
      },
      toolQuery: (tool) => toolConfig(config, tool)?.query,
      settled,
      precheckInputs: () => ({
        screens: live.current.manifest?.screens ?? [],
        tools,
        collections: live.current.collections.collections.map(({ ref, members }) => ({
          ref,
          members,
        })),
        toolQuery: (tool) => toolConfig(config, tool)?.query,
      }),
      refetch: async () => {
        live.current.collections.refresh();
        const fresh = await refetchManifest();
        if (fresh !== null) live.current = { ...live.current, manifest: fresh };
        await settled();
      },
      seq: () => workspaceSync.current?.seq() ?? 0,
      operatorChanges: () => operatorChanges.current,
      setApplying: (on) => {
        applying.current = on;
      },
      mounted: () => live.current.mounted,
      screenReady: (key) => readiness.whenReady(key),
      isBusy: isOperatorBusy,
      onBusyChange,
      arm: armAgentGuard,
      highlight: (touched) => {
        highlightTouched(workspaceRef.current ?? document, touched);
      },
      post: (result) => workspaceSync.current?.postResult(result) ?? Promise.resolve(0),
    };
  });

  // The host's in-place navigation (host/useHostNavigation.ts).
  const { runDeepLink } = collections;
  // A tool URL with a query is the host handing over a tab: it goes straight to
  // the holder, so its query never sits in the router's location.
  const navigateReplace = useCallback(
    (to: string) => {
      const toolUrl = toolUrlOf(to);
      if (toolUrl === null) {
        void navigateRef.current(to, { replace: true });
        return;
      }
      const outcome = toolUrlOutcome(
        stateRef.current,
        toolUrl,
        tools,
        toolConfig(config, toolUrl.tool)?.query,
        Date.now()
      );
      if ('notice' in outcome) {
        console.warn(`Workspace: ${outcome.notice}.`);
        setNotice(outcome.notice);
      } else {
        // The next message may arrive before this one commits.
        stateRef.current = tabsReducer(stateRef.current, outcome.action);
        dispatch(outcome.action);
      }
    },
    [tools, config]
  );
  useHostNavigation({ basename, runDeepLink, navigate: navigateReplace });
  // Save open tabs as collection: opened from the strip's menu and the
  // popover footer, rendered outside the dock like the Save view dialog.
  const [savingCollection, setSavingCollection] = useState(false);
  const onSaveCollection = useCallback(() => setSavingCollection(true), []);
  const { save: saveCollection, tick: tickCollection } = collections;
  // After a save, focus goes to the Collections trigger once the dialog is gone.
  const [savedCollection, setSavedCollection] = useState(0);
  useEffect(() => {
    if (savedCollection > 0 && !savingCollection) focusCollectionsTrigger();
  }, [savedCollection, savingCollection]);
  const collectionToolQuery = useCallback(
    (tool: string) => toolConfig(config, tool)?.query,
    [config]
  );
  const collectionTitleOf = useCallback(
    (key: string) => tabTitle(manifest, key, state, views),
    [manifest, state, views]
  );
  const { collections: collectionList } = collections;
  const onSaveCollectionDraft = useCallback(
    async (...args: Parameters<typeof saveCollection>) => {
      const [draft] = args;
      // The tool tabs the draft holds, paired with their tab keys as the
      // dialog built them: once saved, each records its member and name, so
      // its title is the saved name and Open all focuses it.
      const strip = stripMembers(stateRef.current, collectionList, views, {
        toolQuery: collectionToolQuery,
        titleOf: collectionTitleOf,
      });
      const saved = new Map(draft.members.map((m) => [memberKey(m), m]));
      const entries: SavedTab[] = [];
      strip.members.forEach((m, i) => {
        if (!('tool' in m)) return;
        const from = memberKey(m);
        const member = saved.get(from);
        if (member === undefined) return;
        const entry: SavedTab = { key: strip.tabKeys[i]!, from };
        if (member.name !== undefined) entry.title = member.name;
        entries.push(entry);
      });
      const result = finishSave(await saveCollection(...args), draft.name, {
        show: (spec) => toasts.show(spec),
        tick: tickCollection,
        close: () => {
          setSavingCollection(false);
          setSavedCollection((n) => n + 1);
        },
      });
      if (result.ok && entries.length > 0) dispatch({ type: 'membersSaved', entries });
      return result;
    },
    [
      saveCollection,
      tickCollection,
      toasts,
      collectionList,
      views,
      collectionToolQuery,
      collectionTitleOf,
    ]
  );
  const collectionDialog =
    savingCollection && collections.enabled ? (
      <SaveCollectionDialog
        state={state}
        collections={collections.collections}
        views={views}
        toolQuery={collectionToolQuery}
        titleOf={collectionTitleOf}
        onCancel={() => setSavingCollection(false)}
        onSave={onSaveCollectionDraft}
      />
    ) : null;
  // canopy:quick-open from a tool frame: the palette opens with the frame as
  // its opener (Esc then returns focus to the tree search).
  const onQuickOpen = useCallback((frame: HTMLIFrameElement) => {
    openQuickOpen(frame);
  }, []);

  // Save view. A tool's tile bar holds only the button, which names
  // its own instance; the dialog's open state lives here and the dialog
  // renders outside the dock, beside the plot dialog, because nothing a bar
  // opens may render inside dockview's tab element. The view is saved for the
  // instance whose bar asked, focused or not.
  const [saveTarget, setSaveTarget] = useState<string | null>(null);
  const [savedStatus, setSavedStatus] = useState<{ key: string; text: string } | null>(null);
  const onSaveView = useCallback(
    async (key: string, name: string, query: string) => {
      const kind = toolOf(key);
      if (kind === undefined) throw new Error('Not a tool tab');
      const view = await saveView(name, query, kind);
      // The instance now shows this view; its stored panel names it, so the
      // layout is written again (the save is the operator's act).
      dispatch({ type: 'setView', key, view: view.id });
      if (stateRef.current.keys.includes(key)) persistence.schedule(true);
      setSaveTarget(null);
      const status = { key, text: `Saved “${view.name}”` };
      setSavedStatus(status);
      setTimeout(() => setSavedStatus((prev) => (prev === status ? null : prev)), SAVED_STATUS_MS);
    },
    [saveView, persistence]
  );
  // Opens Save view for the tool instance `key`, as its bar's button does;
  // nothing for a screen, and without saved views. The tool frame's
  // canopy:save-view (its ⌘S while the host owns the header) lands here too.
  const openSaveViewFor = (key: string) => {
    if (!viewsEnabled || toolSpec(toolOf(key) ?? '') === undefined) return;
    setSavedStatus((prev) => (prev?.key === key ? null : prev));
    setSaveTarget(key);
  };
  // The Save view button of the tool instance `key`; null for a screen, and
  // without saved views.
  const saveButtonFor = (key: string): ReactNode => {
    const tool = toolSpec(toolOf(key) ?? '');
    if (!viewsEnabled || tool === undefined) return null;
    return (
      <SaveViewButton
        tool={tool}
        query={instanceQuery(key)}
        status={savedStatus?.key === key ? savedStatus.text : null}
        onOpen={() => openSaveViewFor(key)}
      />
    );
  };
  // Open only while its instance is: closing the tab closes the dialog.
  const saveTool =
    saveTarget !== null && viewsEnabled && state.keys.includes(saveTarget)
      ? toolSpec(toolOf(saveTarget) ?? '')
      : undefined;
  const saveDialog =
    saveTarget !== null && saveTool !== undefined ? (
      <SaveViewDialog
        key={saveTarget}
        tool={saveTool}
        query={instanceQuery(saveTarget)}
        views={views}
        initialName={views.find((v) => v.id === state.instances[saveTarget]?.view)?.name ?? ''}
        onCancel={() => setSaveTarget(null)}
        onSave={(name) => onSaveView(saveTarget, name, instanceQuery(saveTarget))}
      />
    ) : null;
  // The read-only test surface: the live layout on the dock root.
  useLayoutEffect(() => {
    const root = dockRoot.current;
    if (!root || !dockApi) return;
    Object.defineProperty(root, 'canopyDockLayout', {
      configurable: true,
      enumerable: false,
      value: () => dockApi.toJSON(),
    });
    return () => {
      delete (root as { canopyDockLayout?: unknown }).canopyDockLayout;
    };
  }, [dockApi]);

  // Whether the document (the CANOPY frame) has focus: with more than one tile
  // in the dock, the focused tile's bar shows its hairline only then.
  const [documentFocused, setDocumentFocused] = useState(() => document.hasFocus());
  useEffect(() => {
    const update = () => setDocumentFocused(document.hasFocus());
    window.addEventListener('focus', update);
    window.addEventListener('blur', update);
    return () => {
      window.removeEventListener('focus', update);
      window.removeEventListener('blur', update);
    };
  }, []);

  // A screen tab's ◀ ▶: each enabled when its stack has an entry, titled
  // "Switch to <title>" when that entry is open in another tab (the click
  // focuses it there). No keyboard binding.
  const historyFor = (key: string): ScreenHistory => {
    const entry = state.history?.[key];
    const step = (stack: readonly string[] | undefined, type: 'historyBack' | 'historyForward') => {
      const target = stack?.[stack.length - 1];
      return {
        enabled: target !== undefined,
        switchTo:
          target !== undefined && state.keys.includes(target)
            ? tabTitle(manifest, target, state, views)
            : undefined,
        onClick: () => dispatch({ type, key }),
      };
    };
    return {
      back: step(entry?.back, 'historyBack'),
      forward: step(entry?.forward, 'historyForward'),
    };
  };

  // A screen tab's header (its zoom, ◀ ▶ and actions), or null for a tool or a
  // screen the manifest lacks. Its action bar binds no shortcut listener.
  const headerFor = (key: string, keyTitle: string): ReactNode =>
    parseTabKey(key)?.kind === 'screen' && !isMissing(key) ? (
      <ScreenTileHeader
        tileKey={key}
        title={keyTitle}
        report={reported[key]}
        zoomStore={zoomStore}
        config={config}
        plotInDataBrowser={plotInDataBrowser}
        relay={runners.relayFor(key)}
        history={historyFor(key)}
      />
    ) : null;
  // One tile shows its tabs in the strip row and has no bar; two or more
  // tiles each have a bar (tileHeaders.ts). With one tile and a header the
  // viewer draws itself, the focused tab's header sits in a row above the
  // content: a screen's ScreenHeader, or a tool's Save view.
  const bars = barPlacement(tileCount, { chrome, headerOwnedByHost });
  const tileChrome = bars.tileBars;
  const singleTileHeader = active !== null ? headerFor(active, title) : null;
  const singleTileSave = active !== null ? saveButtonFor(active) : null;
  const singleTileToolRow =
    singleTileSave !== null ? <div style={SINGLE_TILE_TOOL_ROW}>{singleTileSave}</div> : null;

  // The host header (host/useHostHeader.ts), armed while the host owns the
  // header: the focused tab's inputs, and the actions its clicks run against
  // the focused tile.
  const badge = useBackendBadge();
  const health = deriveConnectionHealth(badge);
  const showSubScreens = useShowSubScreens();
  const focusedVerbs = useScreenVerbs(screenVerbs, activeIsScreen && !missing ? active : null);
  const focusedToolKey = activeTool !== undefined ? active : null;
  const focusedToolReport = useToolActions(focusedToolKey);
  const activeKind = activeParsed?.kind ?? null;
  const headerTab = useMemo((): HeaderTab | null => {
    if (active === null || activeKind === null) return null;
    if (activeKind !== 'screen') return { kind: 'tool', title };
    const macros = own?.screen?.macros;
    return macros && Object.keys(macros).length > 0
      ? { kind: 'screen', title, id: active, macros }
      : { kind: 'screen', title, id: active };
  }, [active, activeKind, title, own?.screen?.macros]);
  const headerInput = useMemo(
    (): HeaderInput => ({
      activeTab: headerTab,
      screenView: focusedVerbs?.view ?? null,
      toolActions: focusedToolReport,
      savedViewsEnabled: viewsEnabled,
      collectionsEnabled: collections.enabled,
      dockAvailable: dockApi !== null,
      resetDisabled,
      multiTile: tileCount >= 2,
      health,
      showSubScreens,
    }),
    [
      headerTab,
      focusedVerbs,
      focusedToolReport,
      viewsEnabled,
      collections.enabled,
      dockApi,
      resetDisabled,
      tileCount,
      health,
      showSubScreens,
    ]
  );
  // Bound to the focused tile on every render.
  const headerContext: HeaderActionContext = {
    toast: (message) => toasts.show({ message }),
    focusViewer: () => window.focus(),
    openQuickOpen: () => openQuickOpen(),
    saveView:
      focusedToolKey !== null && viewsEnabled ? () => setSaveTarget(focusedToolKey) : undefined,
    openSaveCollection: collections.enabled ? onSaveCollection : undefined,
    resetLayout: dockApi !== null && !resetDisabled ? onResetLayout : undefined,
    getShowSubScreens: () => getShowSubScreens(),
    setShowSubScreens: (show) => setShowSubScreens(show),
    openCollections,
    history: active !== null && activeIsScreen && !missing ? historyFor(active) : null,
    screenVerbs: focusedVerbs ?? null,
    zoom:
      active !== null && activeIsScreen && !missing
        ? {
            zoomIn: () => focusedZoom.setManual(stepZoom(scale, 1)),
            zoomOut: () => focusedZoom.setManual(stepZoom(scale, -1)),
            fit: () => focusedZoom.setFit(),
            actual: () => focusedZoom.setManual(1),
          }
        : null,
    tool:
      focusedToolKey !== null
        ? {
            report: focusedToolReport,
            invoke: (toolAction) => toolActionsStore.invoke(focusedToolKey, toolAction),
          }
        : null,
  };
  useHostHeader({
    enabled: headerOwnedByHost,
    input: headerInput,
    context: headerContext,
    // ⌘S on a tool tab opens Save view with saved views and does nothing
    // without; a screen tab keeps Download through the shortcut listener.
    onSaveKey: () => {
      const key = stateRef.current.active;
      if (toolOf(key) === undefined) return false;
      if (viewsEnabled && key !== null) setSaveTarget(key);
      return true;
    },
  });

  // One bar and one actions slot per tile (only with two or more tiles). The bar lists the tile's tabs, marks the showing one and is the
  // drag handle (tabs and grip); a tab click shows it and focuses its tile,
  // a tab's × closes it through the one close path. The actions slot holds
  // the showing tab's header: a screen's own ScreenHeader (its title, zoom,
  // ◀ ▶ and actions, which act on that tile whether or not it has focus),
  // or a tool's Save view. Every tile holds one header at most, so one
  // runner per relay.
  const renderTileHeader = (entry: TileHeaderEntry) => {
    if (!tileChrome) return null;
    const key = entry.showing;
    if (key === null) return null;
    const keyTitle = (k: string) => reported[k]?.title ?? tabTitle(manifest, k, state, views);
    if (entry.slot === 'actions') {
      const header = headerFor(key, keyTitle(key)) ?? saveButtonFor(key);
      return (
        <TileActions
          tile={entry.tile}
          header={header ?? undefined}
          menu={entry.tile === menuTile ? windowEnd : undefined}
        />
      );
    }
    return (
      <TileBar
        tile={entry.tile}
        tabs={entry.tabs.map((tab) => ({ key: tab.key, title: keyTitle(tab.key) }))}
        panelKey={key}
        title={keyTitle(key)}
        focused={entry.tile === state.focusedTile}
        multiTile={tileChrome}
        documentFocused={documentFocused}
        onFocus={onFocus}
        onShow={(shown) => {
          entry.activate(shown);
          onFocus(shown);
        }}
        onCloseTab={onClose}
      />
    );
  };

  // A strip tab drags as the dock's `{tab: key}` source.
  const onStripDragStart = useCallback(
    (key: string, dataTransfer: DataTransfer | null) => dockDragStart({ tab: key }, dataTransfer),
    []
  );
  // The strip shows only with one tile and is then that tile's bar: a drag
  // over it or a drop on it goes to the bridge with the strip's rects keyed to
  // the one tile.
  const stripShown = bars.strip;
  const [windowMenuOpen, setWindowMenuOpen] = useState(false);
  const stripTile = (rects: StripRects) => {
    const id = tileIdsOf(stateRef.current.layout)[0];
    return id === undefined ? undefined : { [id]: rects };
  };
  const onStripDragOver = (event: Parameters<typeof bridge.stripDragOver>[0], rects: StripRects) =>
    bridge.stripDragOver(event, stripTile(rects));
  const onStripDrop = (event: Parameters<typeof bridge.stripDrop>[0], rects: StripRects) =>
    bridge.stripDrop(event, stripTile(rects));

  // The ☰ window menu and, unless the host owns the header, the target badge
  // left of it:
  // the strip row's right end with one tile, else the right end of the
  // top-right tile's bar. Exactly one is mounted.
  const windowEnd = (
    <>
      {!headerOwnedByHost && <TargetBadge chrome={chrome} />}
      <WindowMenu
        open={windowMenuOpen}
        onOpenChange={setWindowMenuOpen}
        tabCount={state.keys.length}
        onReset={dockApi ? onResetLayout : undefined}
        resetDisabled={resetDisabled}
        onSaveAsCollection={collections.enabled ? onSaveCollection : undefined}
        closedGroups={closedGroups}
        onReopenGroup={onReopenGroup}
        onCloseAll={onCloseAll}
        toolLinks={focusedToolReport?.links}
        shortcutLabel={windowMenuShortcutLabel(isMac)}
      />
    </>
  );
  const menuTile = stripShown ? null : topRightTile(state.layout);
  // ⌥M (Alt+M elsewhere) opens the ☰ wherever it sits; the open state lives
  // here so the one listener reaches whichever ☰ is mounted.
  useEffect(() => {
    if (!chrome) return undefined;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !isWindowMenuShortcut(e)) return;
      e.preventDefault();
      setWindowMenuOpen(true);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [chrome]);

  const noticeBar =
    notice !== null ? (
      <div className="viewer-action-error workspace__notice" role="status">
        <span>{notice}</span>
        <button type="button" onClick={() => setNotice(null)}>
          Dismiss
        </button>
      </div>
    ) : null;

  const banner =
    error !== null || viewError !== null ? (
      <div className="viewer-action-error">
        <ErrorPanel title="Action failed" detail={error ?? viewError ?? ''} />
        <button
          type="button"
          onClick={() => {
            if (error !== null) clearError();
            else setViewError(null);
          }}
        >
          Dismiss
        </button>
      </div>
    ) : null;

  const missingPanel = (key: string) => {
    const parsed = parseTabKey(key);
    const name = parsed?.kind === 'screen' ? `${parsed.category}/${parsed.id}` : key;
    return (
      <div className="workspace__missing" data-testid="tab-missing">
        <ErrorPanel
          title={`Screen '${name}' is not in the manifest`}
          detail="It may have been removed or renamed."
        />
        <button type="button" onClick={() => onClose(key)}>
          Close tab
        </button>
      </div>
    );
  };

  const toolFrame = (key: string, shown: boolean) => {
    const tool = toolOf(key)!;
    const cfg = toolConfig(config, tool);
    if (!cfg) return null;
    const instance = state.instances[key];
    return (
      <TraceTab
        key={`${key}:${instance?.epoch ?? 0}:${bindingGeneration}`}
        tool={toolSpec(tool)}
        tabKey={key}
        title={toolTitle(state, views, key)}
        mode={mode}
        theme={id}
        showing={shown}
        path={cfg.path}
        query={instance?.query ?? cfg.query}
        onQuery={(query) => onToolQuery(key, query)}
        onOpen={onTraceOpen}
        onQuickOpen={onQuickOpen}
        onSaveView={() => openSaveViewFor(key)}
      />
    );
  };

  // Every panel, once, in strip order, each in its own overlay item: mounted
  // screens, showing screens the manifest lacks (their tab-missing in their
  // tile) and every configured tool instance.
  // While the host owns the header, every mounted screen's headless runner: with one tile
  // there is no bar, so it holds the key's relay and the shortcuts reach it;
  // with bars it leaves the relay to the bar and only publishes its verbs.
  const tileRunners = headerOwnedByHost
    ? mounted
        .filter((key) => !isMissing(key))
        .map((key) => (
          <ScreenTileRunner
            key={key}
            tileKey={key}
            report={reported[key]}
            zoomStore={zoomStore}
            config={config}
            plotInDataBrowser={plotInDataBrowser}
            history={historyFor(key)}
            relay={tileChrome ? null : runners.relayFor(key)}
            notify={toastVerbOutcome}
            verbs={screenVerbs}
          />
        ))
    : null;

  const dockContent = (
    <div className="workspace__content">
      <div
        ref={dockRoot}
        className="workspace__dock"
        data-testid="workspace-dock"
        data-showing={JSON.stringify(showing)}
        data-layout={JSON.stringify(state.layout)}
        data-dragging={bridge.dragging ? 'true' : undefined}
      />
      <DockOverlay dragging={bridge.dragging} onFocus={onFocus}>
        {state.keys.map((key) => {
          const placement = tabPlacement(state.layout, state.focusedTile, key);
          let child: ReactNode;
          if (isToolKey(key)) {
            if (!toolConfig(config, toolOf(key)!)) return null;
            child = toolFrame(key, placement.showing);
          } else if (mounted.includes(key)) {
            child = (
              <MountedScreen
                screensBaseUrl={screensBaseUrl}
                tab={key}
                showing={placement.showing}
                focused={placement.focused}
                onTitle={onTitle}
                onZoom={onZoom}
                onScreen={onScreen}
                onDrop={onDrop}
                toastColumn={toastColumn}
                toastTitle={tabTitle(manifest, key, state, views)}
                onToastsLive={onToastsLive}
                zoomStore={zoomStore}
                hostFor={hostForTab}
                readiness={readiness}
              />
            );
          } else if (placement.showing && isMissing(key)) {
            child = missingPanel(key);
          } else {
            return null;
          }
          return (
            <DockOverlayItem key={key} api={dockApi} tileKey={key} focused={placement.focused}>
              {child}
            </DockOverlayItem>
          );
        })}
      </DockOverlay>
      <DropPreview
        target={bridge.preview.target}
        result={bridge.preview.result}
        dockRoot={dockRootEl}
        onClear={bridge.clearPreview}
      />
      <TileBarPortals registry={tileHeaders} renderBar={renderTileHeader} />
      {tileRunners}
      {state.keys.length === 0 && (
        <div className="workspace__empty workspace__dock-notice" data-testid="workspace-empty">
          <p>No tab open.</p>
          <p>Pick a screen from the tree on the left.</p>
        </div>
      )}
    </div>
  );

  // Without chrome: one tile and no dock; only the tile's showing tab shows.
  const bareContent = (
    <div className="workspace__content">
      {active === null && (
        <div className="workspace__empty" data-testid="workspace-empty">
          <p>No tab open.</p>
        </div>
      )}
      {missing && (
        <div className="workspace__missing" data-testid="tab-missing">
          <ErrorPanel
            title={`Screen '${activeParsed.category}/${activeParsed.id}' is not in the manifest`}
            detail="It may have been removed or renamed."
          />
          <button type="button" onClick={() => onClose(active)}>
            Close tab
          </button>
        </div>
      )}
      {mounted.map((key) => (
        <MountedScreen
          key={key}
          screensBaseUrl={screensBaseUrl}
          tab={key}
          showing={showing.includes(key)}
          focused={key === active}
          onTitle={onTitle}
          onZoom={onZoom}
          onScreen={onScreen}
          onDrop={onDrop}
          hostFor={hostForTab}
          readiness={readiness}
        />
      ))}
      {state.keys.filter(isToolKey).map((key) => toolFrame(key, showing.includes(key)))}
      {tileRunners}
    </div>
  );

  return (
    <HostCapabilitiesContext.Provider value={capabilities}>
      <SharedManifestContext.Provider value={sharedManifest}>
        <MachineGatesContext.Provider value={machineGates}>
          <ToastContext.Provider value={toasts}>
            <ActionHostContext.Provider value={host}>
              <FocusSentinels>
                {chrome ? (
                  <div className="workspace" data-testid="workspace" ref={workspaceRef}>
                    <WorkspaceSidebar
                      basename={basename}
                      collections={collections.enabled}
                      header={
                        <>
                          <CollectionsPopover
                            api={collections}
                            onSave={onSaveCollection}
                            trigger={!compactSidebar}
                          />
                          <QuickOpen
                            screens={manifest?.screens ?? null}
                            tools={tools}
                            views={views}
                            collections={collections}
                            onOpen={onOpen}
                            onOpenTool={onOpenTool}
                            onNewTool={onNewTool}
                            onOpenView={viewsEnabled ? onOpenView : undefined}
                            tabs={stripTabs}
                            activeKey={active}
                            onFocusTab={onFocus}
                            trigger={!compactSidebar}
                          />
                        </>
                      }
                    >
                      <ScreenTree
                        screens={manifest?.screens ?? []}
                        tools={toolEntries}
                        onOpen={onOpen}
                        onOpenTool={onOpenTool}
                        onNewTool={onNewTool}
                        activeKey={active}
                        views={views}
                        activeViewId={activeView}
                        onOpenView={viewsEnabled ? onOpenView : undefined}
                        revertable={revertable}
                        onRevertView={viewsEnabled ? onRevertView : undefined}
                        onDeleteView={viewsEnabled ? onDeleteView : undefined}
                        onDragStart={dockApi ? onBrowserDragStart : undefined}
                        tabs={state}
                        collections={collections}
                        onRenderedKeys={onRenderedKeys}
                        onNotice={setNotice}
                      />
                    </WorkspaceSidebar>
                    <section className="workspace__main" aria-label="Workspace">
                      {stripShown && (
                        <div className="workspace__strip">
                          <TabStrip
                            tabs={stripTabs}
                            activeKey={active}
                            onFocus={onFocus}
                            onClose={onClose}
                            onDragStart={dockApi ? onStripDragStart : undefined}
                            onDragOver={dockApi ? onStripDragOver : undefined}
                            onDrop={dockApi ? onStripDrop : undefined}
                            onCloseOthers={onCloseOthers}
                            onCloseToRight={onCloseToRight}
                          />
                          {windowEnd}
                        </div>
                      )}
                      {bars.headerRow && (singleTileHeader ?? singleTileToolRow)}
                      {banner}
                      {noticeBar}
                      {dockContent}
                    </section>
                    {plotDialog}
                    {saveDialog}
                    {collectionDialog}
                    <WriteToastColumn onElement={setToastColumn} />
                    <MachineToasts column={toastColumn} gates={machineGates} />
                    <ToastRegion store={toasts} />
                  </div>
                ) : (
                  <div className="workspace workspace--bare" data-testid="workspace">
                    {banner}
                    {noticeBar}
                    {bareContent}
                  </div>
                )}
              </FocusSentinels>
            </ActionHostContext.Provider>
          </ToastContext.Provider>
        </MachineGatesContext.Provider>
      </SharedManifestContext.Provider>
    </HostCapabilitiesContext.Provider>
  );
}
