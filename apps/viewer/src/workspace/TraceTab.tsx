// One tool instance's iframe (the data browser hosting react-trace, the
// correlation plot, any tools.ts entry). Presentational — the tool, the
// page path, the initial query, the theme and whether the instance is the showing
// tab of its tile come in as props; a query the page reports back, checked by the tool's own
// isValidQuery, goes out through onQuery; a request to open another tool
// (canopy:trace-open) goes out through onOpen unjudged. The iframe carries the instance's
// tab key as data-tab-key and the tool's frameClass (`workspace-trace` for
// the data browser).
//
//   src         frozen at first mount: `<path>?<query>&theme=<id>&embedded=true`
//               resolved against document.baseURI, plus `&hostbar=1` when the
//               host owns the header (HostCapabilities.headerOwnedByHost, so
//               the tool reports its actions instead of drawing them); <id>
//               is the host theme id when it is well-formed, else the mode.
//               Theme changes and stored queries never touch it, so Trace is
//               never reloaded.
//   showing     the instance is the showing tab of its tile: a frame shows
//               in its tile whether or not that tile is the focused one. A
//               hidden tab, or an instance with no tile, is not showing.
//   hidden      when not showing the iframe stays mounted, hidden with
//               visibility:hidden + absolute positioning (never display:none).
//               Never an inline pointer-events value: dockview snapshots each
//               frame's inline pointer-events when a drag or sash press starts and
//               writes the snapshot back on release, so a frame that was hidden
//               then and shown since would come back with no input. Hidden frames
//               take no hits through visibility:hidden and their unplaced overlay
//               item (dock.css).
//   visible     showing AND the iframe intersects the viewport AND the
//               viewport has a non-zero size AND the document is visible.
//               (IntersectionObserver ignores CSS visibility, so the showing
//               flag is what keeps a hidden frame from counting as seen.)
//   protocol    parent -> Trace: canopy:trace-visibility {visible} and
//               canopy:trace-theme {mode, theme}, sent on canopy:trace-ready and on
//               every change. Trace -> parent: canopy:trace-ready and
//               canopy:trace-query {query} and canopy:trace-open {tool, query}
//               (both strings, else dropped) and canopy:quick-open (no payload;
//               asks the page to open the quick-open palette). Messages are accepted only from the
//               iframe's contentWindow with origin === location.origin.
//   actions     Trace -> parent: canopy:tool-actions is parsed and stored
//               whole per tab key in toolActionsStore, and dropped when the
//               frame's document unloads (pagehide) or the tab unmounts;
//               canopy:save-view (no payload) calls onSaveView. Parent ->
//               Trace: invokeToolAction(tabKey, id) posts canopy:tool-invoke
//               to this tab's frame. Same source and origin checks.

import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { HOST_THEME_ID } from '@slaclab/canopy-shell';
import type { ThemeName } from '../config.js';
import { useHostCapabilities } from './host/hostCapabilities.js';
import { DEFAULT_TOOL, toolSpec } from './tools.js';
import { SAVE_VIEW, TOOL_ACTIONS, parseToolActions, toolActionsStore } from './toolActionsStore.js';
import type { ToolActionsStore } from './toolActionsStore.js';
import type { ToolSpec } from './tools.js';

const TRACE_TOOL: ToolSpec = toolSpec(DEFAULT_TOOL)!;

export const TRACE_READY = 'canopy:trace-ready';
export const TRACE_QUERY = 'canopy:trace-query';
export const TRACE_VISIBILITY = 'canopy:trace-visibility';
export const TRACE_THEME = 'canopy:trace-theme';
export const TRACE_OPEN = 'canopy:trace-open';
export const QUICK_OPEN = 'canopy:quick-open';
export { SAVE_VIEW, TOOL_ACTIONS, TOOL_INVOKE, invokeToolAction } from './toolActionsStore.js';

export interface TraceTabProps {
  /** The tool this instance runs (default: the data browser). */
  tool?: ToolSpec;
  /** The iframe's accessible title (default: the tool's label). */
  title?: string;
  /** The instance's tab key, as data-tab-key. */
  tabKey?: string;
  /** Resolved theme; sent to Trace on change, baked into src only at mount. */
  mode: ThemeName;
  /** The host's theme id (default: the mode); sent and baked in like the mode. */
  theme?: string;
  /** True while the instance is the showing tab of its tile (focused or not). */
  showing?: boolean;
  /** Where Trace is served, relative to the viewer (config.trace.path). */
  path: string;
  /** Initial query (the instance's stored query, else the config default); read once. */
  query: string;
  /** Called with a query the page reported via canopy:trace-query, once the tool accepts it. */
  onQuery: (query: string) => void;
  /**
   * Called with the tool id and query of a well-formed canopy:trace-open from
   * the frame. Forwarded as is: whether the tool exists, is configured, or
   * accepts the query is the owner's decision.
   */
  onOpen?: (tool: string, query: string) => void;
  /**
   * Called with this instance's iframe when its frame posts canopy:quick-open
   * (the frame's own primary+K). The page opens the quick-open palette; the
   * frame is the opener focus returns toward when the palette closes.
   */
  onQuickOpen?: (frame: HTMLIFrameElement) => void;
  /** Called when the frame posts canopy:save-view (its ⌘S while the host owns the header). */
  onSaveView?: () => void;
  /** Where tool-actions reports go and tool-invoke finds this frame (default: the page's store). */
  actionsStore?: ToolActionsStore;
}

/**
 * Build the frozen iframe src. Exported for tests.
 *
 * `theme` reaches the URL only when it is a well-formed host theme id; any
 * other value could carry its own `&key=value` pairs into the frame's query
 * (the viewer URL it comes from is not trusted), so the mode stands in.
 * `hostBar` (the host owns the header) appends `hostbar=1`.
 */
export function traceSrc(
  path: string,
  query: string,
  theme: string | null | undefined,
  mode: ThemeName = 'dark',
  hostBar = false
): string {
  const prefix = query ? `${query}&` : '';
  const t = typeof theme === 'string' && HOST_THEME_ID.test(theme) ? theme : mode;
  const suffix = hostBar ? '&hostbar=1' : '';
  return new URL(`${path}?${prefix}theme=${t}&embedded=true${suffix}`, document.baseURI).href;
}

function viewportOk(): boolean {
  return window.innerWidth > 0 && window.innerHeight > 0;
}

function documentVisible(): boolean {
  return document.visibilityState === 'visible';
}

function postTo(iframe: HTMLIFrameElement | null, message: Record<string, unknown>): void {
  iframe?.contentWindow?.postMessage(message, window.location.origin);
}

const BASE_STYLE: CSSProperties = { border: 0, width: '100%', height: '100%', display: 'block' };
const HIDDEN_STYLE: CSSProperties = {
  ...BASE_STYLE,
  visibility: 'hidden',
  position: 'absolute',
  top: 0,
  left: 0,
};

export function TraceTab({
  tool = TRACE_TOOL,
  title,
  tabKey,
  mode,
  theme,
  showing = false,
  path,
  query,
  onQuery,
  onOpen,
  onQuickOpen,
  onSaveView,
  actionsStore = toolActionsStore,
}: TraceTabProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  // Frozen at first mount: later props never reload the frame.
  const { headerOwnedByHost } = useHostCapabilities();
  const [src] = useState(() => traceSrc(path, query, theme, mode, headerOwnedByHost));
  // What Trace is told: the id traceSrc would bake in.
  const id = typeof theme === 'string' && HOST_THEME_ID.test(theme) ? theme : mode;
  // Without IntersectionObserver (old browsers, tests) assume on screen.
  const [intersecting, setIntersecting] = useState(
    () => typeof IntersectionObserver === 'undefined'
  );
  const [pageOk, setPageOk] = useState(() => viewportOk() && documentVisible());

  const visible = showing && intersecting && pageOk;

  // Latest values for the ready handler, which is registered once.
  const latest = useRef({
    visible,
    mode,
    id,
    onQuery,
    onOpen,
    onQuickOpen,
    onSaveView,
    tabKey,
    actionsStore,
    isValidQuery: tool.isValidQuery,
  });
  useEffect(() => {
    latest.current = {
      visible,
      mode,
      id,
      onQuery,
      onOpen,
      onQuickOpen,
      onSaveView,
      tabKey,
      actionsStore,
      isValidQuery: tool.isValidQuery,
    };
  });

  // canopy:tool-invoke reaches this frame by tab key; its tool-actions report
  // lives as long as the frame's current document, and at most as long as
  // this tab.
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe || !tabKey) return;
    const unregister = actionsStore.registerFrame(tabKey, iframe);
    let watched: Window | null = null;
    const onPageHide = () => actionsStore.clear(tabKey);
    const watch = () => {
      watched?.removeEventListener('pagehide', onPageHide);
      watched = iframe.contentWindow;
      try {
        watched?.addEventListener('pagehide', onPageHide);
      } catch {
        watched = null;
      }
    };
    watch();
    iframe.addEventListener('load', watch);
    return () => {
      iframe.removeEventListener('load', watch);
      watched?.removeEventListener('pagehide', onPageHide);
      unregister();
      actionsStore.clear(tabKey);
    };
  }, [tabKey, actionsStore]);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry) setIntersecting(entry.isIntersecting);
    });
    observer.observe(iframe);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const update = () => setPageOk(viewportOk() && documentVisible());
    window.addEventListener('resize', update);
    document.addEventListener('visibilitychange', update);
    return () => {
      window.removeEventListener('resize', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, []);

  // Post on every change (and once at mount).
  useEffect(() => {
    postTo(iframeRef.current, { type: TRACE_VISIBILITY, visible });
  }, [visible]);

  useEffect(() => {
    postTo(iframeRef.current, { type: TRACE_THEME, mode, theme: id });
  }, [mode, id]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const frame = iframeRef.current?.contentWindow;
      if (!frame || event.source !== frame) return;
      if (event.origin !== window.location.origin) return;
      const data: unknown = event.data;
      if (typeof data !== 'object' || data === null) return;
      const {
        type,
        query: reported,
        tool: target,
      } = data as { type?: unknown; query?: unknown; tool?: unknown };
      if (type === TRACE_READY) {
        const { visible: v, mode: m, id: t } = latest.current;
        postTo(iframeRef.current, { type: TRACE_VISIBILITY, visible: v });
        postTo(iframeRef.current, { type: TRACE_THEME, mode: m, theme: t });
      } else if (type === TRACE_QUERY && latest.current.isValidQuery(reported)) {
        latest.current.onQuery(reported);
      } else if (
        type === TRACE_OPEN &&
        typeof target === 'string' &&
        typeof reported === 'string'
      ) {
        latest.current.onOpen?.(target, reported);
      } else if (type === QUICK_OPEN && iframeRef.current) {
        latest.current.onQuickOpen?.(iframeRef.current);
      } else if (type === TOOL_ACTIONS) {
        const { tabKey: key, actionsStore: store } = latest.current;
        const report = parseToolActions(data);
        if (key && report) store.set(key, report);
      } else if (type === SAVE_VIEW) {
        latest.current.onSaveView?.();
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  return (
    <iframe
      ref={iframeRef}
      className={tool.frameClass}
      title={title ?? tool.label}
      data-tab-key={tabKey}
      src={src}
      style={showing ? BASE_STYLE : HIDDEN_STYLE}
      aria-hidden={showing ? undefined : true}
      tabIndex={showing ? undefined : -1}
      data-visible={visible ? 'true' : 'false'}
    />
  );
}
