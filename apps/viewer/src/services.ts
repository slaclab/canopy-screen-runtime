// Composition root — the ONLY place concrete PV / formula services appear.
// Everything below App consumes them through context.

import { createContext, useContext, useSyncExternalStore } from 'react';
import type { HareConnectionStatus, HareHeartbeatState, PVService } from '@slaclab/canopy-client';
import {
  FormulaEngineService,
  HarePVService,
  LocalPVService,
  MockPVService,
  RoutedPVService,
} from '@slaclab/canopy-client';
import type { FixtureSnapshot, FormulaSubscriber } from '@slaclab/canopy-screen-runtime';
import {
  createFixtureFormulaSubscriber,
  createFormulaEngineSubscriber,
  createLocalAwareFormulaSubscriber,
  FixturePVService,
  parseFixtureSnapshot,
} from '@slaclab/canopy-screen-runtime';
import type { ViewerConfig } from './config.js';
import { createConfirmWritesSource, readConfirmWrites } from './config.js';
import type { WriteBackend } from './writeGate/gate.js';
import { badgeIdentity, createBackendBadgeStore } from './backendBadge.js';
import type { BackendBadgeIdentity, BackendBadgeState, BackendBadgeStore } from './backendBadge.js';

export interface ViewerServices {
  pv: PVService;
  /** null in mock mode: rules stay inert (base props render unchanged). */
  formulas: FormulaSubscriber | null;
  /** loc:// locals (EDM LOC parity) of `pv`; a screen uses its own scope. */
  locals: LocalPVService;
  /**
   * A fresh loc:// scope for one open screen: its own locals, routed in front
   * of the shared Hare (mock, or fixture) service and the Formula Engine (or local evaluation). The workspace keeps several
   * screens mounted at once, and EDM locals are window-local, so each screen
   * gets one; closing a screen clears its scope and no other.
   */
  screenScope(): ScreenScope;
  /**
   * The backend badge store, in hare mode only. Unset in mock and fixture
   * mode, so useBackendBadge() returns null there and no badge is drawn.
   */
  backend?: BackendBadgeStore;
  /**
   * Machine writes, in hare mode only: what each screen's write gate submits
   * through (the Hare service itself, never the loc:// router). Unset in mock
   * and fixture mode, so no gate is provided and widgets write straight through.
   */
  writes?: WriteBackend;
}

/** One screen's PV and formula services, sharing the page's connections. */
export interface ScreenScope {
  pv: PVService;
  formulas: FormulaSubscriber | null;
  locals: LocalPVService;
}

function scopeOver(
  base: PVService,
  formulasFor: (locals: LocalPVService) => FormulaSubscriber
): () => ScreenScope {
  return () => {
    const locals = new LocalPVService();
    locals.connect();
    return {
      pv: new RoutedPVService({ 'loc://': locals }, base),
      formulas: formulasFor(locals),
      locals,
    };
  };
}

// ── Fixture mode (deterministic renders) ─────────────────────────────────────
// `?_canopyPv=fixture&_canopyFixture=<key>` serves every channel from the
// snapshot at `<base>/__fixture/<key>.json`: plain PVs from a FixturePVService,
// every formula evaluated in the page. Hare and the Formula Engine are never constructed. The
// parameters are reserved (`_canopy*`, dropped from macros and tab queries),
// so they are latched once, at startup, from the page's first URL.

const FIXTURE_PV_PARAM = '_canopyPv';
const FIXTURE_KEY_PARAM = '_canopyFixture';

/**
 * The fixture key selected by `search`, or null when the page is not in
 * fixture mode. Throws when fixture mode is selected without a key.
 */
export function fixtureKeyFromSearch(search: string | URLSearchParams): string | null {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search;
  if (params.get(FIXTURE_PV_PARAM) !== 'fixture') return null;
  const key = params.get(FIXTURE_KEY_PARAM);
  if (!key) throw new Error(`${FIXTURE_PV_PARAM}=fixture needs ${FIXTURE_KEY_PARAM}=<key>`);
  return key;
}

/** URL of the snapshot for `key`: `<base>/__fixture/<key>.json`, the key opaque. */
export function fixtureUrl(key: string, base: URL): URL {
  return new URL(`__fixture/${encodeURIComponent(key)}.json`, base);
}

/** Fetch and validate the snapshot for `key`; throws when it is missing or malformed. */
export async function loadFixture(
  key: string,
  base: URL,
  fetchImpl: typeof fetch = fetch
): Promise<FixtureSnapshot> {
  const url = fixtureUrl(key, base);
  const response = await fetchImpl(url.href, { cache: 'no-store' });
  if (!response.ok) throw new Error(`fixture ${url.href}: HTTP ${response.status}`);
  return parseFixtureSnapshot(await response.json());
}

/** Page-level PV status: the Hare connection status, or 'mock' in mock mode. */
export type CanopyPVStatus = HareConnectionStatus | 'mock';

declare global {
  interface Window {
    /**
     * Read by headless consumers: `pvStatus` (e.g. screenshotting waits for PV
     * data) and, in hare mode, `backend` (the badge's identity and link).
     * Each writer merge-assigns its own key.
     */
    __canopy?: { pvStatus?: CanopyPVStatus; backend?: BackendBadgeIdentity };
  }
}

function publishPVStatus(pvStatus: CanopyPVStatus): void {
  window.__canopy = { ...window.__canopy, pvStatus };
}

function publishBackend(state: BackendBadgeState): void {
  window.__canopy = { ...window.__canopy, backend: badgeIdentity(state) };
}

/** One reconnect schedule (ms) for Hare and the Formula Engine. */
const RECONNECT_DELAYS_MS = [250, 500, 1000, 2000];

// Close codes: the client SDK's default applies. Canopy closes a socket with
// 1008 (policy violation) only when it refuses the connection (no or wrong
// credential, no read access, off-origin), so a 1008 close is terminal: the
// service reports `disconnected` (the badge reads it as down) and stops
// retrying; reloading the page connects again. Every other close reconnects
// on RECONNECT_DELAYS_MS.

/** ws:/wss: URL of the Hare live-PV endpoint under the Canopy base URL. */
function hareWebSocketUrl(base: URL): string {
  const url = new URL('hare/v1/ws/pvs', base);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.href;
}

/**
 * `base` is the Canopy base URL — the document base URI, since Canopy is the
 * origin (and mount prefix) serving the viewer. A `fixture` snapshot selects
 * fixture mode, which overrides `config.pvMode` for this page only.
 */
export function createServices(
  config: ViewerConfig,
  base: URL = new URL(document.baseURI),
  fixture?: FixtureSnapshot
): ViewerServices {
  // loc:// locals are page-side state (EDM LOC semantics): widgets write and
  // rules read them without a gateway, in every pv mode.
  const locals = new LocalPVService();
  locals.connect();

  if (fixture) {
    // Fixed status: the snapshot is all there is, and it is all present.
    publishPVStatus('connected');
    const recorded = new FixturePVService(fixture);
    const pv = new RoutedPVService({ 'loc://': locals }, recorded);
    pv.connect();
    return {
      pv,
      formulas: createFixtureFormulaSubscriber(locals, recorded),
      locals,
      screenScope: scopeOver(recorded, (l) => createFixtureFormulaSubscriber(l, recorded)),
    };
  }

  if (config.pvMode === 'hare') {
    const backend = createBackendBadgeStore({ backend: config.backend, binding: config.binding });
    publishBackend(backend.getSnapshot());
    backend.subscribe(() => publishBackend(backend.getSnapshot()));
    // confirmWrites is re-read on every reconnect after the first connect
    // (the page's config was read just before it); pending or failed reads ask.
    const confirm = createConfirmWritesSource(config.confirmWrites, () =>
      readConfirmWrites(base.href)
    );
    let connectedOnce = false;
    // Whether this page has seen a write statement on any socket: after one,
    // a closed socket reads "Reconnecting" instead of live.
    let writesSeen = false;
    const heartbeatListeners = new Set<(state: HareHeartbeatState) => void>();
    // No key is sent from the page.
    const hare = new HarePVService({
      url: hareWebSocketUrl(base),
      reconnectDelaysMs: [...RECONNECT_DELAYS_MS],
      onStatusChange: (status) => {
        publishPVStatus(status);
        backend.setStatus(status);
        if (status === 'connected') {
          if (connectedOnce) void confirm.reread();
          connectedOnce = true;
        }
      },
      onBackendChange: (identity) => {
        if (identity.writes != null) writesSeen = true;
        backend.setBackend(identity);
      },
      onHeartbeat: (state) => {
        for (const listener of [...heartbeatListeners]) listener(state);
      },
    });
    const writes: WriteBackend = {
      heartbeat: () => hare.heartbeat(),
      linkUp: () => hare.status === 'connected',
      submit: (pv, value, options) => hare.submit(pv, value, options),
      onHeartbeat(listener) {
        heartbeatListeners.add(listener);
        return () => heartbeatListeners.delete(listener);
      },
      confirmWrites: () => confirm.current(),
      machineLabel: () => backend.getSnapshot().label,
      writes: () => ({ writes: backend.getSnapshot().writes, seen: writesSeen }),
      onWrites: (listener) => backend.subscribe(listener),
    };
    publishPVStatus(hare.status);
    backend.setStatus(hare.status);
    const pv = new RoutedPVService({ 'loc://': locals }, hare);
    pv.connect();
    const formulaEngine = new FormulaEngineService({
      baseUrl: base.href,
      reconnectDelaysMs: [...RECONNECT_DELAYS_MS],
    });
    formulaEngine.connect();
    const live = createFormulaEngineSubscriber(formulaEngine);
    return {
      pv,
      formulas: createLocalAwareFormulaSubscriber(locals, live),
      locals,
      screenScope: scopeOver(hare, (l) => createLocalAwareFormulaSubscriber(l, live)),
      backend,
      writes,
    };
  }

  publishPVStatus('mock');
  const mock = new MockPVService();
  const pv = new RoutedPVService({ 'loc://': locals }, mock);
  pv.connect();
  return {
    pv,
    formulas: createLocalAwareFormulaSubscriber(locals, null),
    locals,
    screenScope: scopeOver(mock, (l) => createLocalAwareFormulaSubscriber(l, null)),
  };
}

export const ServicesContext = createContext<ViewerServices | null>(null);

export function useServices(): ViewerServices {
  const services = useContext(ServicesContext);
  if (!services) throw new Error('useServices must be used inside <ServicesContext.Provider>');
  return services;
}

const NO_BACKEND = {
  subscribe: () => () => {},
  getSnapshot: () => null,
};

/**
 * The backend badge's live state, or null when there is no badge: no
 * ServicesContext provider (component tests), or mock / fixture mode.
 */
export function useBackendBadge(): BackendBadgeState | null {
  const source: {
    subscribe(listener: () => void): () => void;
    getSnapshot(): BackendBadgeState | null;
  } = useContext(ServicesContext)?.backend ?? NO_BACKEND;
  return useSyncExternalStore(source.subscribe, source.getSnapshot);
}
