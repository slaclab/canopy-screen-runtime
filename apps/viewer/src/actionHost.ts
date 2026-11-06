// The viewer's ActionHost: what widget actions (open_display, close_display,
// open_webpage) do in this app. `createActionHost` is a pure factory over
// injected callbacks so it is testable without React; `useViewerActionHost`
// binds it to the router, `window` and an error state App renders.
//
// URLs the host hands the router are router-relative (`/s/...`, `/embed/...`)
// and keep the route prefix of the screen the action ran on, so an embedded
// screen stays embedded. Only a viewer screen opened in a new tab/window needs
// the router basename, since window.open resolves against the origin.
//
// Channels are not the host's concern: in the viewer's mock PV mode, a
// gateway-bound `formula://` channel on a navigated-to screen renders disconnected
// by design (phase-1 behaviour); only `hare` mode connects them.

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useHref, useLocation, useNavigate } from 'react-router-dom';
import type { Location, NavigateFunction } from 'react-router-dom';
import type { ActionHost } from '@slaclab/canopy-screen-runtime';
import type { Manifest, ManifestScreen } from './api.js';
import { directoryOf, fetchManifest } from './api.js';

export interface ActionHostDeps {
  /** `fresh` bypasses the HTTP cache (a lookup missed a stale manifest). */
  loadManifest(options?: { fresh?: boolean }): Promise<Manifest>;
  /** Router pathname of the screen currently shown (e.g. `/s/bts/knob-device`). */
  currentPathname(): string;
  navigate(url: string): void;
  openWindow(url: string): void;
  close(): void;
  showError(message: string): void;
  /** Router basename (`/x/y`, or `''`/`'/'` at the root); prefixes opened screens. */
  basename?: string;
  /**
   * Open a resolved viewer screen in a new workspace tab instead of a
   * window. Returns false when there is no workspace to take it, and the
   * screen then opens in a window as before.
   */
  openTab?(url: string): boolean;
}

/** The two routes a screen renders under. */
export type ScreenRoute = 's' | 'embed';

/** The screen route a router pathname is on; `s` off the screen routes. */
export function routeOf(pathname: string): ScreenRoute {
  return /^\/embed(\/|$)/.test(pathname) ? 'embed' : 's';
}

/** Normalise a manifest-root path: no leading `/`, `.` dropped, `..` folded. */
export function normalizePath(path: string): string {
  const out: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..' && out.length > 0 && out[out.length - 1] !== '..') out.pop();
    else out.push(segment);
  }
  return out.join('/');
}

/** The router-relative URL of a screen. */
export function screenUrl(entry: ManifestScreen, route: ScreenRoute = 's'): string {
  const id = entry.id.split('/').map(encodeURIComponent).join('/');
  return `/${route}/${encodeURIComponent(entry.category)}/${id}`;
}

/** The manifest path of the screen a `/s/` or `/embed/<category>/<id>` pathname shows. */
export function screenPathForLocation(manifest: Manifest, pathname: string): string | undefined {
  const match = /^\/(?:s|embed)\/([^/]+)\/(.+)$/.exec(pathname);
  if (!match) return undefined;
  let category: string;
  let id: string;
  try {
    category = decodeURIComponent(match[1]!);
    id = match[2]!.split('/').map(decodeURIComponent).join('/');
  } catch {
    return undefined;
  }
  return manifest.screens.find((s) => s.category === category && s.id === id)?.path;
}

/**
 * Whether `openWindow` may open `url`: http(s) or a root-relative path.
 * Everything else (javascript:, data:, protocol-relative `//host`, `/\host`,
 * document-relative paths) is refused.
 */
export function isOpenableUrl(url: string): boolean {
  if (url.startsWith('/')) return !url.startsWith('//') && !url.startsWith('/\\');
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:';
}

/** `''` for the root basename, else the basename without a trailing slash. */
function basenamePrefix(basename: string | undefined): string {
  return (basename ?? '').replace(/\/+$/, '');
}

function pathOf(url: string): string {
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
}

export function createActionHost(deps: ActionHostDeps): ActionHost {
  let manifest: Promise<Manifest> | null = null;
  const loadManifest = (fresh = false): Promise<Manifest> => {
    if (!manifest || fresh) {
      const loading = deps.loadManifest(fresh ? { fresh: true } : undefined);
      const memo = loading.catch((error: unknown) => {
        if (manifest === memo) manifest = null; // a failed fetch is retried on the next action
        throw error;
      });
      manifest = memo;
    }
    return manifest;
  };
  // Router-relative screen URLs resolveManifest produced: openWindow gives
  // these (and only these) the basename, so an open_webpage URL that happens
  // to be root-relative is opened exactly as written.
  const screenUrls = new Set<string>();
  const prefix = basenamePrefix(deps.basename);

  const lookup = (loaded: Manifest, file: string): string | null => {
    // The runtime hands a manifest-root path when the screen was rendered
    // with `screenPath`; otherwise the path is relative to the top screen's
    // directory, so also try it against the screen currently shown.
    const pathname = deps.currentPathname();
    const candidates = [normalizePath(file)];
    const current = screenPathForLocation(loaded, pathname);
    if (current !== undefined) candidates.push(normalizePath(directoryOf(current) + file));
    for (const candidate of candidates) {
      const entry = loaded.screens.find((s) => s.kind === 'ir' && s.path === candidate);
      if (entry) return screenUrl(entry, routeOf(pathname));
    }
    return null;
  };

  return {
    async resolveManifest(file) {
      // A miss may be a screen added since the manifest was cached: refetch
      // it once past the HTTP cache and look again before giving up.
      const url = lookup(await loadManifest(), file) ?? lookup(await loadManifest(true), file);
      if (url !== null) screenUrls.add(url);
      return url;
    },
    navigate: (url) => deps.navigate(url),
    openWindow: (url) => {
      if (!isOpenableUrl(url)) {
        deps.showError(`Refusing to open ${url}: only http, https and viewer paths are allowed`);
        return;
      }
      const isScreen = screenUrls.has(pathOf(url));
      if (isScreen && deps.openTab?.(url)) return;
      deps.openWindow(isScreen ? `${prefix}${url}` : url);
    },
    close: () => deps.close(),
    showError: (message) => deps.showError(message),
  };
}

function openWindow(url: string): void {
  // Viewer screens open with an opener so their close_display can close them;
  // external pages get none, so they cannot script the viewer tab.
  if (url.startsWith('/') && !url.startsWith('//')) window.open(url, '_blank');
  else window.open(url, '_blank', 'noopener');
}

/** Router state the host reads when an action runs, never during render. */
interface RouterSnapshot {
  navigate: NavigateFunction;
  location: Location;
}

interface RaisedError {
  message: string;
  /** `location.key` of the screen the error was raised on. */
  key: string;
}

/**
 * The workspace's tabs, as the action host drives them. With these, a screen
 * an action navigates to replaces the tab the host belongs to, a screen
 * opened in a tab/window target appends a tab, and close_display closes that
 * tab (never navigates back). Only non-screen URLs still use window.open.
 * The workspace hands each screen tab its own, bound to its
 * tab key, so an action acts on the tab it ran in whether or not that tab's
 * tile is focused: a navigate replaces that tab in its own tile, a close
 * closes that tab. The workspace-wide one acts on the active tab (the
 * focused tile's showing tab); an append opens as a tab of the focused
 * tile.
 */
export interface WorkspaceTabs {
  /** Open the router-relative screen URL (`/embed/<category>/<id>?macros`). */
  open(url: string, mode: 'replace' | 'append'): void;
  /** Close the tab this host belongs to. */
  close(): void;
  /**
   * Router pathname of the host's screen tab, for resolving relative
   * screen files; omitted or undefined falls back to the router location.
   */
  currentPathname?(): string | undefined;
}

/**
 * One manifest fetch shared by every host of a page: a failed fetch is
 * dropped, so the next action retries, and `fresh` replaces it for all.
 */
function sharedManifestLoader(screensBaseUrl: string): ActionHostDeps['loadManifest'] {
  let cached: Promise<Manifest> | null = null;
  return (options) => {
    if (!cached || options?.fresh) {
      const memo: Promise<Manifest> = fetchManifest(screensBaseUrl, options).catch(
        (error: unknown) => {
          if (cached === memo) cached = null;
          throw error;
        }
      );
      cached = memo;
    }
    return cached;
  };
}

/** The host over the latest router snapshot, read only inside its callbacks. */
function routerActionHost(
  loadManifest: ActionHostDeps['loadManifest'],
  basename: string,
  router: () => RouterSnapshot,
  raise: (error: RaisedError) => void,
  tabs: () => WorkspaceTabs | undefined
): ActionHost {
  return createActionHost({
    basename,
    loadManifest,
    currentPathname: () => tabs()?.currentPathname?.() ?? router().location.pathname,
    navigate: (url) => {
      const workspace = tabs();
      if (workspace) workspace.open(url, 'replace');
      else void router().navigate(url);
    },
    openWindow,
    openTab: (url) => {
      const workspace = tabs();
      if (!workspace) return false;
      workspace.open(url, 'append');
      return true;
    },
    close: () => {
      const workspace = tabs();
      if (workspace) {
        workspace.close();
        return;
      }
      // BrowserRouter records its history index in history.state; with an
      // entry behind us go back, otherwise this is a window an action opened
      // (or a router that keeps no index, e.g. MemoryRouter): close it.
      const state: unknown = window.history.state;
      const idx =
        typeof state === 'object' && state !== null && 'idx' in state ? state.idx : undefined;
      if (typeof idx === 'number' && idx > 0) void router().navigate(-1);
      else window.close();
    },
    showError: (message) => raise({ message, key: router().location.key }),
  });
}

export interface ViewerActionHost {
  host: ActionHost;
  /** Message from the last `showError` of any host here, or null; cleared on navigation. */
  error: string | null;
  clearError(): void;
  /**
   * A host bound to `tabs` instead of the workspace-wide ones: one per
   * workspace tile. It shares this hook's router, manifest fetch and error,
   * so its errors show where `error` is rendered. Stable per router basename
   * and screens base URL; each call makes a new host, so memoise per tile.
   */
  hostFor(tabs: WorkspaceTabs): ActionHost;
}

/**
 * The ActionHost bound to the router and `window`; call inside a Router.
 * `tabs` (the workspace) redirects screen navigation, screen tab/window
 * opens and close into the workspace's tabs; it is read through a ref, so a
 * new object each render keeps the host's identity.
 */
export function useViewerActionHost(
  screensBaseUrl: string,
  tabs?: WorkspaceTabs
): ViewerActionHost {
  const navigate = useNavigate();
  const location = useLocation();
  // useHref('/') is the router basename (`/` when there is none).
  const basename = useHref('/');
  // The error is tagged with the location it was raised on, so navigating
  // away hides it without a state update in an effect.
  const [raised, setRaised] = useState<RaisedError | null>(null);

  // The host reads the router through a ref refreshed after every commit, so
  // its identity (and its manifest memo) survives navigation: context
  // consumers do not re-render on every route change. Actions run from event
  // handlers, i.e. after the commit that updated the ref.
  const router = useRef<RouterSnapshot>({ navigate, location });
  useLayoutEffect(() => {
    router.current = { navigate, location };
  }, [navigate, location]);
  const tabsRef = useRef<WorkspaceTabs | undefined>(tabs);
  useLayoutEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  const loadManifest = useMemo(() => sharedManifestLoader(screensBaseUrl), [screensBaseUrl]);
  const host = useMemo(
    () =>
      routerActionHost(
        loadManifest,
        basename,
        // eslint-disable-next-line react-hooks/refs -- the getters run only inside action callbacks, never during render
        () => router.current,
        setRaised,
        // eslint-disable-next-line react-hooks/refs -- as above
        () => tabsRef.current
      ),
    [loadManifest, basename]
  );
  const hostFor = useCallback(
    (tabs: WorkspaceTabs) =>
      routerActionHost(
        loadManifest,
        basename,
        () => router.current,
        setRaised,
        () => tabs
      ),
    [loadManifest, basename]
  );

  const clearError = useCallback(() => setRaised(null), []);
  const error = raised !== null && raised.key === location.key ? raised.message : null;
  return { host, error, clearError, hostFor };
}
