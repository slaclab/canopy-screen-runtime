// /s/:category/* — render one IR screen with ?MACRO=value query macros. The
// screen id is the splat, so nested ids ("CBXFEL/Landing") match.
//
// The workspace renders it with chrome={false} (no page header), explicit
// `category`/`id`/`macros` (its tab, not the route) and `zoomable` (fit-to-view
// by default, see zoom.ts / ZoomContext.tsx), and takes the title and the
// zoom scale back through `onTitle`/`onZoom` for its tile bar, and the open
// screen (document URL, displayed element, reload) through `onScreen` for
// that bar's actions. The callbacks are the report flag: a docked screen gets
// them, so every tile reports, and new ones make it report again at once; a
// hidden one gets none. `active` is separate: only the focused screen fits
// the print. With the chrome, the page renders its header (ScreenHeader)
// itself and fits every print to the open screen.
//
// `onReady` is the screen-ready signal: called once per loaded document (and
// once for a load error) after it has rendered and every embed its renderer
// asked for has resolved or failed, with EMBED_QUIET_MS of quiet so the
// embeds an embed brings are waited for too.
//
// With the chrome the page is a page of its own: it shows the target badge
// in its header and mounts the page's one Notices column (writeGate/
// toastHost.tsx) with its MachineToasts; its write gate's toasts go into
// that column too, so the two never stack in the same corner. Without the
// chrome (a workspace tab) it mounts neither and puts its write gate in the
// page's MachineGatesContext.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useHref, useLocation, useParams, useSearchParams } from 'react-router-dom';
import { PVServiceProvider } from '@slaclab/canopy-react';
import {
  isSupportedSchemaVersion,
  SUPPORTED_SCHEMA_VERSIONS,
  validate,
} from '@slaclab/canopy-screen-ir';
import type { ScreenJSON } from '@slaclab/canopy-screen-ir';
import {
  FormulaSubscriberContext,
  ScreenRenderer,
  collectScreenPVs,
  parseRenderMode,
} from '@slaclab/canopy-screen-runtime';
import type { ManifestScreen } from '../api.js';
import {
  fetchManifest,
  fetchScreenDocument,
  makeResolveAsset,
  makeResolveScreen,
  screenDocumentUrl,
} from '../api.js';
import { useColorScheme } from '../colorSchemeContext.js';
import type { ViewerConfig } from '../config.js';
import { ErrorPanel, ScreenErrorBoundary } from '../ErrorPanel.js';
import { InvalidScreenNotice } from '../InvalidScreenNotice.js';
import { macrosFromSearch, RENDER_QUERY_PARAM } from '../macros.js';
import { ScreenHeader } from '../ScreenHeader.js';
import { usePrintFit } from '../screenActions/print.js';
import type { ScreenActionContext, ScreenTarget } from '../screenActions/types.js';
import { useServices } from '../services.js';
import { useManifestPoll } from '../useManifestPoll.js';
import { useScreenWriteGate, ScreenWriteGateProvider } from '../writeGate/WriteGateView.js';
import { createGateRegistry } from '../writeGate/machineToasts.js';
import {
  MachineToasts,
  WriteToastColumn,
  WriteToastHostContext,
  useMachineGates,
} from '../writeGate/toastHost.js';
import type { WriteToastHost } from '../writeGate/toastHost.js';
import { TargetBadge } from '../workspace/TargetBadge.js';
import { useZoom } from '../ZoomContext.js';
import { fitScale } from '../zoom.js';

/** .viewer-canvas padding (index.css, 1rem) — the fit area excludes it on each side. */
const CANVAS_PADDING = 16;

/** Reserved query parameter (`_canopy*`, never a macro): `fit` or a percentage. */
export const ZOOM_PARAM = '_canopyZoom';

/** A `?_canopyZoom` value: 'fit', a scale (percent / 100), or null when unusable. */
export function zoomFromParam(value: string | null): 'fit' | number | null {
  if (value === 'fit') return 'fit';
  if (value !== null && /^\d+(\.\d+)?$/.test(value)) return Number(value) / 100;
  return null;
}

/** `length` x `scale` in px, rounded to 1/100 px (400 x 1.1 is 440, not 440.00000000000006). */
function scaledPx(length: number, scale: number): number {
  return Math.round(length * scale * 100) / 100;
}

/**
 * The client (inner, scrollbar-excluded) size of `element`, kept current by a
 * ResizeObserver. Measured in a layout effect so the first fitted scale is in
 * place before the screen paints. 0 x 0 when unmeasurable (jsdom).
 */
function useClientSize(element: HTMLElement | null): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    if (element === null) return;
    const measure = () => {
      const width = element.clientWidth;
      const height = element.clientHeight;
      setSize((prev) =>
        prev.width === width && prev.height === height ? prev : { width, height }
      );
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(element);
    return () => ro.disconnect();
  }, [element]);
  return size;
}

/** Header detail: `category/id`, plus `?MACRO=value` when macros are set. */
function screenDetail({ category, id, macros }: ScreenTarget): string {
  const query = new URLSearchParams(macros as Record<string, string>).toString();
  return query ? `${category}/${id}?${query}` : `${category}/${id}`;
}

/** How long no embed may be in flight before a ready screen counts as settled. */
export const EMBED_QUIET_MS = 50;

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; title: string; detail?: string }
  // `problems`: validate()'s messages for the loaded document; empty when it
  // meets the contract. A document with problems still renders, under a notice.
  | { status: 'ready'; entry: ManifestScreen; screen: ScreenJSON; problems: readonly string[] };

function useScreenDocument(
  screensBaseUrl: string,
  category: string | undefined,
  id: string | undefined,
  reloads: number
): { state: LoadState; generation: number } {
  // The result is tagged with the request it answered; a route change makes
  // it stale, so "loading" is derived instead of reset inside the effect.
  const key = `${screensBaseUrl}|${category}|${id}`;
  const [loaded, setLoaded] = useState<{ key: string; state: LoadState } | null>(null);
  const current: LoadState = loaded && loaded.key === key ? loaded.state : { status: 'loading' };

  // Drafts only (a static site's entries carry no rev and are never polled):
  // a rev change of the open document or of an entry beside it bumps the
  // generation, which refetches under the same route key — the last render
  // stays up until the new one lands.
  const openEntry = current.status === 'ready' ? current.entry : undefined;
  const generation = useManifestPoll(screensBaseUrl, openEntry?.path, openEntry?.rev);

  useEffect(() => {
    let cancelled = false;

    (async (): Promise<LoadState> => {
      // An operator's reload goes past the HTTP cache.
      const fresh = reloads > 0;
      const manifest = await fetchManifest(screensBaseUrl, { fresh });
      const entry = manifest.screens.find((s) => s.category === category && s.id === id);
      if (!entry) {
        return {
          status: 'error',
          title: `No screen '${category}/${id}' in the manifest`,
        };
      }
      if (entry.kind !== 'ir') {
        return {
          status: 'error',
          title: `Screen '${entry.title}' is a ${entry.kind} screen`,
          detail: 'Only IR screens (.screen.json) are viewable in this version.',
        };
      }
      const screen = await fetchScreenDocument(screensBaseUrl, entry.path, { fresh });
      if (!isSupportedSchemaVersion(screen.schemaVersion)) {
        return {
          status: 'error',
          title: 'Schema version mismatch',
          detail:
            `'${entry.path}' declares schemaVersion ${String(screen.schemaVersion)}, ` +
            `but this viewer speaks ${SUPPORTED_SCHEMA_VERSIONS.join(', ')}. Re-save the screen with a matching ` +
            `canopy-screen-builder, or update the viewer.`,
        };
      }
      return { status: 'ready', entry, screen, problems: validate(screen) };
    })().then(
      (next) => {
        if (!cancelled) setLoaded({ key, state: next });
      },
      (err: unknown) => {
        if (!cancelled)
          setLoaded({
            key,
            state: {
              status: 'error',
              title: 'Could not load the screen',
              detail: err instanceof Error ? err.message : String(err),
            },
          });
      }
    );

    return () => {
      cancelled = true;
    };
  }, [screensBaseUrl, category, id, key, generation, reloads]);

  return { state: current, generation };
}

export function ScreenPage({
  screensBaseUrl,
  chrome,
  category: categoryProp,
  id: idProp,
  macros: macrosProp,
  zoomable = false,
  onTitle,
  onZoom,
  onScreen,
  config,
  active = true,
  onReady,
}: {
  screensBaseUrl: string;
  /** Render the page header (ScreenHeader) and the target badge. */
  chrome: boolean;
  /** The screen's category; defaults to the route's `:category`. */
  category?: string;
  /** The screen id; defaults to the route's splat. */
  id?: string;
  /** Macro values; default from the URL query (see macros.ts). */
  macros?: Record<string, string>;
  /**
   * With chrome={false}: zoom the screen (the host renders the controls from
   * onZoom and the ZoomContext, and owns `?_canopyZoom`).
   */
  zoomable?: boolean;
  /** Called with the screen's title once loaded and on every change. */
  onTitle?: (title: string) => void;
  /** Called with the scale in effect whenever it changes (zoomed pages only). */
  onZoom?: (scale: number) => void;
  /** Called with the open screen whenever it changes, and null while there is none. */
  onScreen?: (screen: ScreenTarget | null) => void;
  /** The viewer config, passed on to the header's actions (chrome only). */
  config?: Readonly<Partial<ViewerConfig>>;
  /**
   * False while a workspace keeps this screen mounted but hidden, or shows it
   * in a tile without focus: only an active screen fits the print.
   */
  active?: boolean;
  /** The screen-ready signal: rendered, with every embed resolved or failed (see the header). */
  onReady?: () => void;
}) {
  const params = useParams();
  const category = categoryProp ?? params.category;
  const id = idProp ?? params['*']; // splat holds the (possibly slashed) screen id
  const [searchParams] = useSearchParams();
  const services = useServices();
  const colorScheme = useColorScheme();
  // Each reload re-fetches the document and remounts the renderer (keyed by
  // the count), so every widget resubscribes its PVs.
  const [reloads, setReloads] = useState(0);
  const reload = useCallback(() => setReloads((n) => n + 1), []);
  const { state, generation } = useScreenDocument(screensBaseUrl, category, id, reloads);

  // loc:// locals are screen-scoped (EDM window-local lifetime): every screen
  // gets its own scope, cleared when the rendered screen changes or the page
  // unmounts, so one screen's tab state can't leak into the next, nor into a
  // workspace tab kept mounted beside it.
  const scope = useMemo(
    () => services.screenScope(),
    // category/id: a new screen in the same page gets a fresh scope.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [services, category, id]
  );
  useEffect(() => {
    return () => scope.locals.clear();
  }, [scope]);

  // Machine writes go through this screen's write gate (hare mode only; none
  // in mock or fixture mode). Like the scope, a new screen gets a new gate,
  // and the old one's queued runs are dropped. The origin is the manifest
  // screen and its revision (drafts only).
  const entry = state.status === 'ready' ? state.entry : undefined;
  const writeOrigin = useMemo(
    () => ({ screen: entry?.id ?? id ?? '', rev: entry?.rev ?? null }),
    [entry, id]
  );
  const writeGate = useScreenWriteGate(services.writes, writeOrigin, `${category}/${id}`);
  // The page's write gates: its own with the chrome, else the workspace's.
  const ownGates = useMemo(() => (chrome ? createGateRegistry() : null), [chrome]);
  const pageGates = useMachineGates();
  const gates = ownGates ?? pageGates;
  useEffect(() => {
    if (!gates || !writeGate) return;
    return gates.add(writeGate);
  }, [gates, writeGate]);
  const [noticeColumn, setNoticeColumn] = useState<HTMLDivElement | null>(null);

  // Every ?NAME=value query parameter is a macro value, except the viewer's
  // reserved parameters (see macros.ts).
  const macros = useMemo(
    () => macrosProp ?? macrosFromSearch(searchParams),
    [macrosProp, searchParams]
  );
  // ?render=edm|carbon overrides the configured render mode (main.tsx's
  // RenderModeContext) for this page; an unknown value is ignored.
  const renderMode = parseRenderMode(searchParams.get(RENDER_QUERY_PARAM)) ?? undefined;

  const resolveScreen = useMemo(
    () =>
      state.status === 'ready' ? makeResolveScreen(screensBaseUrl, state.entry.path) : undefined,
    // generation: a new identity makes ScreenRenderer refetch its embeds.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [screensBaseUrl, state, generation]
  );
  // The embeds in flight, counted through the resolver the renderer gets.
  const embeds = useRef({ pending: 0, onSettle: null as (() => void) | null });
  const trackedResolve = useMemo(() => {
    if (resolveScreen === undefined) return undefined;
    const tracked: typeof resolveScreen = (ref) => {
      embeds.current.pending += 1;
      const pending = resolveScreen(ref);
      const done = () => {
        embeds.current.pending -= 1;
        embeds.current.onSettle?.();
      };
      pending.then(done, done);
      return pending;
    };
    return tracked;
  }, [resolveScreen]);
  const onReadyRef = useRef(onReady);
  useLayoutEffect(() => {
    onReadyRef.current = onReady;
  });
  const settledFor = useRef<LoadState | null>(null);
  useEffect(() => {
    if (state.status === 'loading' || settledFor.current === state) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (embeds.current.pending > 0 || settledFor.current === state) return;
        settledFor.current = state;
        onReadyRef.current?.();
      }, EMBED_QUIET_MS);
    };
    const counter = embeds.current;
    counter.onSettle = check;
    check();
    return () => {
      clearTimeout(timer);
      if (counter.onSettle === check) counter.onSettle = null;
    };
  }, [state]);
  const resolveAsset = useMemo(
    () =>
      state.status === 'ready' ? makeResolveAsset(screensBaseUrl, state.entry.path) : undefined,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [screensBaseUrl, state, generation]
  );

  const title = state.status === 'ready' ? state.screen.metadata.title : 'Canopy Screens';
  const noticeHost = useMemo<WriteToastHost | null>(
    () => (chrome ? { element: noticeColumn, title } : null),
    [chrome, noticeColumn, title]
  );

  // Zoom (zoomable pages only). The fit area is the scroll container's client
  // box less the canvas padding; it depends only on the page layout, never on
  // the scaled screen, and in fit mode the container does not scroll (so no
  // scrollbar can appear, shrink the area, and re-trigger a fit).
  const zoom = useZoom();
  const zoomed = !chrome && zoomable;
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  const area = useClientSize(zoomed ? scroller : null);
  const screenSize = state.status === 'ready' ? state.screen.metadata.size : undefined;
  const fitting = zoom.mode === 'fit';
  const scale = !zoomed
    ? 1
    : fitting
      ? fitScale(
          area.width - 2 * CANVAS_PADDING,
          area.height - 2 * CANVAS_PADDING,
          screenSize?.width ?? 0,
          screenSize?.height ?? 0
        )
      : zoom.scale;

  const readyTitle = state.status === 'ready' ? title : undefined;
  useEffect(() => {
    if (readyTitle !== undefined) onTitle?.(readyTitle);
  }, [readyTitle, onTitle]);
  // A layout effect, so the host's title bar shows the new scale in the same
  // frame as the canvas (a passive effect leaves it one render behind).
  useLayoutEffect(() => {
    if (zoomed) onZoom?.(scale);
  }, [zoomed, scale, onZoom]);

  // The element that shows the screen as displayed: the zoom box, which has
  // the scaled size, or unzoomed the box that shrink-wraps the screen root.
  const [zoomBox, setZoomBox] = useState<HTMLDivElement | null>(null);
  const [screenBox, setScreenBox] = useState<HTMLDivElement | null>(null);
  const element = zoomed ? zoomBox : screenBox;

  const ready = state.status === 'ready' ? state : undefined;
  // The PVs as rendered: same document, macros and embed resolver (whose
  // fetches the renderer already made, so collecting costs no requests).
  const collectPVs = useMemo(
    () => (ready ? () => collectScreenPVs(ready.screen, { macros, resolveScreen }) : undefined),
    [ready, macros, resolveScreen]
  );
  const target = useMemo<ScreenTarget | null>(
    () =>
      ready && category !== undefined && id !== undefined
        ? {
            category,
            id,
            title: ready.screen.metadata.title,
            macros,
            element,
            documentUrl: screenDocumentUrl(screensBaseUrl, ready.entry.path),
            size: ready.screen.metadata.size,
            reload,
            collectPVs,
          }
        : null,
    [ready, category, id, macros, element, screensBaseUrl, reload, collectPVs]
  );
  useEffect(() => {
    onScreen?.(target);
  }, [onScreen, target]);
  useEffect(() => () => onScreen?.(null), [onScreen]);

  // Only the shown screen fits the print (hidden workspace tabs stay mounted).
  usePrintFit(active ? ready?.screen.metadata.size : undefined);

  // The /s/ page's own header actions; its URL is the link that reopens it.
  const location = useLocation();
  const href = useHref(location.pathname + location.search);
  const headerActions = useMemo<ScreenActionContext | undefined>(
    () =>
      chrome && target
        ? {
            screen: target,
            // The page with the chrome is never zoomed (`zoomed` is false).
            zoom: { scale: 1, fit: false },
            config,
            link: new URL(href, window.location.href).href,
          }
        : undefined,
    [chrome, target, config, href]
  );

  const renderer =
    state.status === 'ready' ? (
      <ScreenRenderer
        key={reloads}
        screen={state.screen}
        macros={macros}
        resolveScreen={trackedResolve}
        resolveAsset={resolveAsset}
        colorScheme={colorScheme}
        renderMode={renderMode}
      />
    ) : null;

  const page = (
    <div className="viewer-page">
      {chrome && (
        <ScreenHeader
          title={title}
          detail={target ? screenDetail(target) : undefined}
          actions={headerActions}
        >
          <Link className="viewer-back" to="/">
            All screens
          </Link>
          <TargetBadge />
        </ScreenHeader>
      )}
      {state.status === 'ready' && state.problems.length > 0 && (
        // Above <main>, not inside it: the zoom fit measures <main>'s client
        // box, so the notice takes its height from the column, not the fit.
        <InvalidScreenNotice path={state.entry.path} problems={state.problems} />
      )}
      <main
        ref={zoomed ? setScroller : undefined}
        className={
          'viewer-content viewer-content--screen' +
          (zoomed && fitting ? ' viewer-content--fit' : '')
        }
      >
        {state.status === 'loading' && <p className="viewer-loading">Loading screen…</p>}
        {state.status === 'error' && <ErrorPanel title={state.title} detail={state.detail} />}
        {state.status === 'ready' && (
          <ScreenErrorBoundary screenId={state.screen.id}>
            <PVServiceProvider service={scope.pv}>
              <ScreenWriteGateProvider gate={writeGate}>
                <FormulaSubscriberContext.Provider value={scope.formulas}>
                  <div className="viewer-canvas">
                    {zoomed && screenSize ? (
                      // The outer box takes the scaled size, so layout and
                      // scrollbars see the zoomed extent; the inner box keeps
                      // the authored size and scales from its top-left corner.
                      // Hit-testing follows the transform, so widgets stay
                      // clickable at any zoom.
                      <div
                        ref={setZoomBox}
                        className="viewer-zoom"
                        style={{
                          width: scaledPx(screenSize.width, scale),
                          height: scaledPx(screenSize.height, scale),
                        }}
                      >
                        <div
                          className="viewer-zoom__scaled"
                          style={{
                            width: screenSize.width,
                            height: screenSize.height,
                            transform: `scale(${scale})`,
                          }}
                        >
                          {renderer}
                        </div>
                      </div>
                    ) : (
                      <div ref={setScreenBox} className="viewer-screen">
                        {renderer}
                      </div>
                    )}
                  </div>
                </FormulaSubscriberContext.Provider>
              </ScreenWriteGateProvider>
            </PVServiceProvider>
          </ScreenErrorBoundary>
        )}
      </main>
    </div>
  );
  if (!chrome) return page;
  return (
    <WriteToastHostContext.Provider value={noticeHost}>
      {page}
      <WriteToastColumn onElement={setNoticeColumn} />
      <MachineToasts column={noticeColumn} gates={gates} />
    </WriteToastHostContext.Provider>
  );
}
