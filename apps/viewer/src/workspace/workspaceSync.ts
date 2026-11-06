// The window's side of canopy_mcp's workspace hub: who this window is, when it
// claims the active slot, when it reports its state, and how it keeps its
// event stream. Framework-free: every browser dependency (fetch, the event
// stream, the window and its document, the config re-read) is injected, so a
// test drives it against the stub hub with a fake clock.
//
// Identity. `windowId` is minted once per page load and lives only in memory:
// a reload or a duplicated tab is a new window.
//
// Claim. A window starts inactive. It becomes active on a claim's 200 or on a
// `hello` naming it, and inactive on `event: inactive` or a report's 409
// not_active. It claims only while it believes it is inactive: on start when
// the top-level browsing context has focus, and on the operator's focus
// gestures (its own focus, pointerdown and keydown, becoming visible while
// focused, and the top window's focus where that window is reachable). After
// its stream fails, a window that held the slot and never got `inactive`
// re-claims with ?if_vacant=1, which succeeds only when no connected window
// holds the slot: a canopy_mcp restart is recovered without a gesture, and a window
// that lost the slot never takes it back from a live one.
//
// Stream. Open while active, one per window. Every stream error closes it; the
// recovery above decides what comes next, so the browser's own reconnect never
// runs behind the hub's back.
//
// Report. Only the active window reports. Changes are throttled (trailing
// edge, 100 ms quiet, flushed within 250 ms of the first change); a `shown`
// flip and the end of a batch report at once. Every claim, report and result
// carries the next value of one per-window monotonic `seq`; the body passes
// through reduceOversize so it never exceeds the hub's cap.
//
// shown = the document is visible and the window has a non-zero size (a hidden
// host tile keeps the frame loaded with display:none, which reads as 0 x 0).
//
// Failures. A network failure or a 5xx starts a capped backoff: retries at
// 2, 4, 8, 16 s and then every 30 s, so a window with canopy_mcp down makes at most
// six workspace requests in any 60 s, and re-reads config.json at most once per
// 60 s. A re-read that finds no advertisement, or a protocol major this viewer
// does not know, stops the window for good: no further workspace request.
// Other 4xx answers are final for the request that got them.

import { readWorkspaceAdvertisement } from '../config.js';
import type { WorkspaceAdvertisement, WorkspaceConfig } from '../config.js';
import { reduceOversize, type WorkspaceState } from './workspaceState.js';

/** Throttle: report after this much quiet ... */
export const REPORT_QUIET_MS = 100;
/** ... and never later than this after the first unreported change. */
export const REPORT_MAX_WAIT_MS = 250;
/** Backoff delays after consecutive failures; the last one repeats. */
export const BACKOFF_MS = [2_000, 4_000, 8_000, 16_000, 30_000] as const;
/** At most one config.json re-read per this window. */
export const CONFIG_REREAD_MS = 60_000;

/** The subset of EventSource the sync uses. */
export interface EventStream {
  addEventListener(type: string, listener: (event: MessageEvent) => void): void;
  onerror: ((event: Event) => void) | null;
  close(): void;
}

/** The subset of a window the sync reads and listens to. */
export interface SyncWindow {
  readonly innerWidth: number;
  readonly innerHeight: number;
  readonly top: unknown;
  addEventListener(type: string, listener: EventListener, options?: AddEventListenerOptions): void;
  removeEventListener(type: string, listener: EventListener, options?: EventListenerOptions): void;
}

/** The subset of a document the sync reads and listens to. */
export interface SyncDocument {
  readonly visibilityState: DocumentVisibilityState;
  readonly defaultView: unknown;
  hasFocus(): boolean;
  addEventListener(type: string, listener: EventListener, options?: AddEventListenerOptions): void;
  removeEventListener(type: string, listener: EventListener, options?: EventListenerOptions): void;
}

/** A batch event's data, as the hub sends it. */
export interface BatchEvent {
  batch: string;
  window: string;
  base?: unknown;
  deadline?: string;
  commands: { id: string; cmd: string; args: Record<string, unknown> }[];
}

export interface WorkspaceSyncOptions {
  /** The parsed advertisement (config.workspace). */
  workspace: WorkspaceConfig;
  /** The window's current state (buildState over the live inputs). */
  getState: () => WorkspaceState;
  /** Every URL resolves against it. Default document.baseURI. */
  baseURI?: string;
  fetch?: typeof fetch;
  /** Opens the event stream. Default `new EventSource(url)`. */
  openStream?: (url: string) => EventStream;
  win?: SyncWindow;
  doc?: SyncDocument;
  /** Re-reads config.json. Default readWorkspaceAdvertisement(baseURI). */
  reread?: () => Promise<WorkspaceAdvertisement>;
  /** Mints the windowId. Default crypto.randomUUID. */
  randomId?: () => string;
  /** Called with each batch delivered to this window. */
  onBatch?: (batch: BatchEvent) => void;
  /** Called whenever the window's belief about holding the slot changes. */
  onActiveChange?: (active: boolean) => void;
}

/** What a result POST carries beside the state. */
export interface BatchResult {
  batch: string;
  results: Record<string, unknown>[];
}

export interface WorkspaceSync {
  readonly windowId: string;
  /** Whether the window believes it holds the slot. */
  isActive(): boolean;
  /** Whether the sync has stopped for good (stop(), or the advertisement went away). */
  isStopped(): boolean;
  /** The last seq sent. */
  seq(): number;
  /** Begin: listen for gestures, and claim when the top-level context has focus. */
  start(): void;
  /** End: drop every listener, timer and stream; say goodbye when active. */
  stop(): void;
  /** The state changed: a throttled report (active only). */
  changed(): void;
  /** Report at once (active only), e.g. after a batch. */
  reportNow(): Promise<void>;
  /** POST the batch's result with the current state; resolves to the HTTP status (0 on failure). */
  postResult(result: BatchResult): Promise<number>;
}

export type Pending = 'claim' | 'reclaim' | 'report';

const PENDING_RANK: Record<Pending, number> = { report: 0, reclaim: 1, claim: 2 };

/**
 * What the backoff retries once `what` also needs retrying: claim > reclaim >
 * report. A pending report is upgraded to a reclaim or a claim, a reclaim to a
 * claim, and nothing is ever downgraded, so a window that lost its stream while
 * a report was backing off still re-claims its slot.
 */
export function mergePending(pending: Pending | null, what: Pending): Pending {
  if (pending === null) return what;
  return PENDING_RANK[what] > PENDING_RANK[pending] ? what : pending;
}

function defaultOpenStream(url: string): EventStream {
  return new EventSource(url);
}

/** shown: visible and non-zero size. */
export function isShown(win: SyncWindow, doc: SyncDocument): boolean {
  return doc.visibilityState === 'visible' && win.innerWidth > 0 && win.innerHeight > 0;
}

/** Whether the top-level browsing context has focus (this document's own focus when unreachable). */
export function topHasFocus(win: SyncWindow, doc: SyncDocument): boolean {
  try {
    const top = win.top as { document: { hasFocus(): boolean } } | null;
    if (top) return top.document.hasFocus();
  } catch {
    // Cross-origin top: fall through to this document.
  }
  return doc.hasFocus();
}

export function createWorkspaceSync(options: WorkspaceSyncOptions): WorkspaceSync {
  const baseURI = options.baseURI ?? document.baseURI;
  const doFetch =
    options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const openStream = options.openStream ?? defaultOpenStream;
  const win = options.win ?? (window as unknown as SyncWindow);
  const doc = options.doc ?? (document as unknown as SyncDocument);
  const reread = options.reread ?? (() => readWorkspaceAdvertisement(baseURI));
  const windowId = (options.randomId ?? (() => crypto.randomUUID()))();
  let path = options.workspace.path.replace(/\/+$/, '');

  let started = false;
  let stopped = false;
  let active = false;
  /** Held the slot and never got `inactive`: the stream-error recovery re-claims. */
  let held = false;
  let claiming = false;
  /** A change arrived while a claim was in flight: report once it lands. */
  let dirty = false;
  let seq = 0;
  let shown = false;
  let stream: EventStream | null = null;

  let quietTimer: ReturnType<typeof setTimeout> | null = null;
  let maxTimer: ReturnType<typeof setTimeout> | null = null;

  let failures = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let pending: Pending | null = null;
  let lastReread = -Infinity;
  let rereading = false;

  const listeners = new AbortController();
  let topListener: AbortController | null = null;

  const url = (rel: string) => new URL(`${path}/${rel}`, baseURI).toString();

  function setActive(next: boolean): void {
    if (active === next) return;
    active = next;
    options.onActiveChange?.(next);
  }

  function body(): Record<string, unknown> {
    seq += 1;
    return reduceOversize({ windowId, seq, shown, state: options.getState() });
  }

  async function send(method: string, rel: string, payload?: unknown, keepalive = false) {
    const init: RequestInit = { method, credentials: 'same-origin' };
    if (payload !== undefined) {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(payload);
    }
    if (keepalive) init.keepalive = true;
    return doFetch(url(rel), init);
  }

  // --- failures ----------------------------------------------------------------

  function clearRetry(): void {
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
  }

  function succeeded(): void {
    failures = 0;
  }

  /** A network failure or 5xx: retry `what` after the backoff (a claim outranks a report). */
  function failed(what: Pending): void {
    if (stopped) return;
    pending = mergePending(pending, what);
    failures += 1;
    maybeReread();
    if (retryTimer !== null) return;
    const delay = BACKOFF_MS[Math.min(failures, BACKOFF_MS.length) - 1];
    retryTimer = setTimeout(retry, delay);
  }

  function retry(): void {
    retryTimer = null;
    if (stopped) return;
    const what = pending;
    pending = null;
    if (what === 'claim') void claim(false);
    else if (what === 'reclaim') void claim(true);
    else if (what === 'report') void report();
  }

  function backingOff(): boolean {
    return retryTimer !== null;
  }

  function maybeReread(): void {
    if (rereading) return;
    const now = Date.now();
    if (now - lastReread <= CONFIG_REREAD_MS) return;
    lastReread = now;
    rereading = true;
    void reread()
      .then((ad) => {
        if (ad.status === 'absent') halt();
        else if (ad.status === 'advertised') path = ad.workspace.path.replace(/\/+$/, '');
      })
      .catch(() => undefined)
      .finally(() => {
        rereading = false;
      });
  }

  /** No advertisement any more: never send another workspace request. */
  function halt(): void {
    stopped = true;
    teardown();
    held = false;
    setActive(false);
  }

  // --- claim and stream ------------------------------------------------------------

  async function claim(ifVacant: boolean): Promise<void> {
    if (stopped || active || claiming) return;
    if (backingOff()) {
      // A gesture or a stream error while canopy_mcp is failing: the scheduled retry
      // claims (or re-claims), even when what was backing off was a report.
      pending = mergePending(pending, ifVacant ? 'reclaim' : 'claim');
      return;
    }
    claiming = true;
    dirty = false;
    let status: number;
    try {
      const response = await send('POST', ifVacant ? 'claim?if_vacant=1' : 'claim', body());
      status = response.status;
    } catch {
      status = 0;
    } finally {
      claiming = false;
    }
    if (stopped) return;
    if (status === 200) {
      succeeded();
      held = true;
      setActive(true);
      connect();
      if (dirty) scheduleFlush();
      dirty = false;
      return;
    }
    if (status === 0 || status >= 500) {
      failed(ifVacant ? 'reclaim' : 'claim');
      return;
    }
    if (status === 404) {
      // The hub is gone (opt-in off); the re-read decides whether it comes back.
      failed(ifVacant ? 'reclaim' : 'claim');
      return;
    }
    // 409 not_vacant: a live window holds the slot; this one waits for a gesture.
    succeeded();
    held = false;
  }

  function closeStream(): void {
    const current = stream;
    stream = null;
    current?.close();
  }

  function connect(): void {
    closeStream();
    const es = openStream(url(`events?window=${encodeURIComponent(windowId)}`));
    stream = es;
    const data = (event: MessageEvent): unknown => {
      try {
        return JSON.parse(String(event.data));
      } catch {
        return null;
      }
    };
    es.addEventListener('hello', (event) => {
      if (stream !== es) return;
      const hello = data(event) as { activeWindow?: unknown } | null;
      if (hello?.activeWindow === windowId) {
        held = true;
        setActive(true);
      }
    });
    es.addEventListener('batch', (event) => {
      if (stream !== es || !active) return;
      const batch = data(event) as BatchEvent | null;
      if (batch && batch.window === windowId) options.onBatch?.(batch);
    });
    es.addEventListener('inactive', () => {
      if (stream !== es) return;
      held = false;
      setActive(false);
      closeStream();
    });
    es.onerror = () => {
      if (stream !== es) return;
      // The hub ended the stream, refused it (204), or the connection dropped.
      closeStream();
      setActive(false);
      if (held) void claim(true);
    };
  }

  // --- report ---------------------------------------------------------------------

  function clearThrottle(): void {
    if (quietTimer !== null) clearTimeout(quietTimer);
    if (maxTimer !== null) clearTimeout(maxTimer);
    quietTimer = null;
    maxTimer = null;
  }

  function scheduleFlush(): void {
    if (quietTimer !== null) clearTimeout(quietTimer);
    quietTimer = setTimeout(flush, REPORT_QUIET_MS);
    if (maxTimer === null) maxTimer = setTimeout(flush, REPORT_MAX_WAIT_MS);
  }

  function flush(): void {
    clearThrottle();
    void report();
  }

  async function report(): Promise<void> {
    if (stopped || !active) return;
    if (backingOff()) {
      pending = mergePending(pending, 'report');
      return;
    }
    let status: number;
    try {
      status = (await send('PUT', 'active', body())).status;
    } catch {
      status = 0;
    }
    if (stopped) return;
    if (status === 0 || status >= 500 || status === 404) {
      failed('report');
      return;
    }
    succeeded();
    if (status === 409) {
      // not_active: another window holds the slot.
      held = false;
      setActive(false);
      closeStream();
    }
  }

  function changed(): void {
    if (claiming) dirty = true;
    if (stopped || !active) return;
    scheduleFlush();
  }

  async function reportNow(): Promise<void> {
    clearThrottle();
    await report();
  }

  async function postResult(result: BatchResult): Promise<number> {
    if (stopped) return 0;
    // The result route takes exactly {batch, seq, state, results}.
    const { seq: sent, state } = body();
    const payload = { batch: result.batch, seq: sent, state, results: result.results };
    try {
      const response = await send('POST', `active/${encodeURIComponent(windowId)}/result`, payload);
      if (response.status >= 500) failed('report');
      return response.status;
    } catch {
      failed('report');
      return 0;
    }
  }

  // --- gestures and visibility ----------------------------------------------------

  function gesture(): void {
    void claim(false);
  }

  function reshow(): void {
    const next = isShown(win, doc);
    if (next === shown) return;
    shown = next;
    if (active) void reportNow();
  }

  function onVisibility(): void {
    reshow();
    if (doc.visibilityState === 'visible' && doc.hasFocus()) gesture();
  }

  function onPagehide(): void {
    topListener?.abort();
    topListener = null;
    if (active && !stopped) {
      void send('DELETE', `active?window=${encodeURIComponent(windowId)}`, undefined, true).catch(
        () => undefined
      );
    }
  }

  function listenTop(): void {
    let top: SyncWindow | null;
    try {
      top = win.top as SyncWindow | null;
      if (!top || top === win) return;
      topListener = new AbortController();
      top.addEventListener(
        'focus',
        () => {
          if (doc.defaultView === win) gesture();
        },
        { signal: topListener.signal }
      );
    } catch {
      // Cross-origin top: its focus is not this window's to see.
      topListener = null;
    }
  }

  function teardown(): void {
    listeners.abort();
    topListener?.abort();
    topListener = null;
    clearThrottle();
    clearRetry();
    pending = null;
    closeStream();
  }

  function start(): void {
    if (started || stopped) return;
    started = true;
    shown = isShown(win, doc);
    const signal = listeners.signal;
    win.addEventListener('focus', gesture, { signal });
    win.addEventListener('resize', reshow, { signal });
    win.addEventListener('pagehide', onPagehide, { signal });
    doc.addEventListener('pointerdown', gesture, { capture: true, signal });
    doc.addEventListener('keydown', gesture, { capture: true, signal });
    doc.addEventListener('visibilitychange', onVisibility, { signal });
    listenTop();
    if (topHasFocus(win, doc)) gesture();
  }

  function stop(): void {
    if (stopped) return;
    const wasActive = active;
    stopped = true;
    teardown();
    if (wasActive) {
      void send('DELETE', `active?window=${encodeURIComponent(windowId)}`, undefined, true).catch(
        () => undefined
      );
    }
    held = false;
    setActive(false);
  }

  return {
    windowId,
    isActive: () => active,
    isStopped: () => stopped,
    seq: () => seq,
    start,
    stop,
    changed,
    reportNow,
    postResult,
  };
}
