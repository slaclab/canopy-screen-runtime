// The backend badge store: what the page knows about the data connection's
// control target. One store per hare-mode page (services.ts creates it; mock
// and fixture pages have none, so they show no badge). It is seeded from
// config.json's `backend` / `binding` block and fed by the Hare connection
// status and the heartbeat identity (HarePVService's onBackendChange).
//
//   label, notice, binding  the last identity seen (config first, then each
//                           heartbeat that changes it).
//   link                    'boot' until the first connected or disconnected
//                           status, then 'up' / 'down'; 'connecting' and
//                           'idle' never change it.
//   labelSeen               a non-null label was seen at least once (a label
//                           from config.json counts).
//   configBackendNull       config.json served `backend: null` (DATA did not
//                           answer); false when the key is absent.
//   heartbeat               at least one heartbeat identity has arrived.
//   lastBinding             the last non-null binding (config or heartbeat).
//   reachable, writes       the live socket's statement from its last
//                           heartbeat; null when the frame made no claim, and
//                           cleared to null when the socket closes.
//   timestamp               that heartbeat's server `timestamp` (epoch
//                           seconds), the clock a `since` duration is read
//                           against; cleared with the statement.
//
// Snapshots are frozen and replaced only on a change, so useSyncExternalStore
// can compare them by identity.

import type {
  HareBackend,
  HareBackendNotice,
  HareConnectionStatus,
  HareReachable,
  HareWrites,
} from '@slaclab/canopy-client';
import type { ConfigBackend } from './config.js';

export type BackendLink = 'boot' | 'up' | 'down';

export interface BackendBadgeState {
  readonly label: string | null;
  readonly notice: HareBackendNotice;
  readonly binding: string | null;
  readonly link: BackendLink;
  readonly labelSeen: boolean;
  readonly configBackendNull: boolean;
  readonly heartbeat: boolean;
  readonly lastBinding: string | null;
  readonly reachable: HareReachable | null;
  readonly writes: HareWrites | null;
  readonly timestamp: number | null;
}

/** The public part of the badge, mirrored on `window.__canopy.backend`. */
export interface BackendBadgeIdentity {
  label: string | null;
  notice: HareBackendNotice;
  binding: string | null;
  link: BackendLink;
}

/** config.json's block; an absent key (`undefined`) means the server sent none. */
export interface BackendBadgeSeed {
  backend?: ConfigBackend | null;
  binding?: string | null;
}

export interface BackendBadgeStore {
  getSnapshot(): BackendBadgeState;
  /** Calls `listener` after every change; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /** Feeds a Hare connection status. */
  setStatus(status: HareConnectionStatus): void;
  /**
   * Feeds a heartbeat identity and statement. `timestamp` is the frame's
   * server time; omitted, the last one is kept.
   */
  setBackend(backend: HareBackend, timestamp?: number | null): void;
}

const KEYS = [
  'label',
  'notice',
  'binding',
  'link',
  'labelSeen',
  'configBackendNull',
  'heartbeat',
  'lastBinding',
  'reachable',
  'writes',
  'timestamp',
] as const satisfies readonly (keyof BackendBadgeState)[];

/** The four identity fields of a snapshot, as a plain object. */
export function badgeIdentity(state: BackendBadgeState): BackendBadgeIdentity {
  return { label: state.label, notice: state.notice, binding: state.binding, link: state.link };
}

function sameReachable(a: HareReachable | null, b: HareReachable | null): boolean {
  if (a === null || b === null) return a === b;
  return a.state === b.state && a.since === b.since && a.reason === b.reason;
}

function sameWrites(a: HareWrites | null, b: HareWrites | null): boolean {
  if (a === null || b === null) return a === b;
  return a.state === b.state && a.reason === b.reason && a.cause === b.cause;
}

function copyReachable(r: HareReachable | null | undefined): HareReachable | null {
  if (r == null) return null;
  return Object.freeze({ state: r.state, since: r.since ?? null, reason: r.reason ?? null });
}

function copyWrites(w: HareWrites | null | undefined): HareWrites | null {
  if (w == null) return null;
  return Object.freeze({ state: w.state, reason: w.reason ?? null, cause: w.cause ?? null });
}

export function createBackendBadgeStore(seed: BackendBadgeSeed = {}): BackendBadgeStore {
  const label = seed.backend?.label ?? null;
  const binding = seed.binding ?? null;
  let state: BackendBadgeState = Object.freeze({
    label,
    notice: seed.backend?.notice ?? null,
    binding,
    link: 'boot',
    labelSeen: label !== null,
    configBackendNull: seed.backend === null,
    heartbeat: false,
    lastBinding: binding,
    reachable: null,
    writes: null,
    timestamp: null,
  });
  const listeners = new Set<() => void>();

  function update(patch: Partial<BackendBadgeState>): void {
    const next = { ...state, ...patch };
    if (KEYS.every((key) => next[key] === state[key])) return;
    state = Object.freeze(next);
    for (const listener of [...listeners]) listener();
  }

  return {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setStatus(status) {
      if (status === 'connected') update({ link: 'up' });
      else if (status === 'disconnected') {
        update({ link: 'down', reachable: null, writes: null, timestamp: null });
      }
    },
    setBackend(backend, timestamp) {
      // Equal statements keep the held object, so the snapshot only moves on
      // a real change.
      const reachable = copyReachable(backend.reachable);
      const writes = copyWrites(backend.writes);
      update({
        label: backend.label,
        notice: backend.notice,
        binding: backend.binding,
        labelSeen: state.labelSeen || backend.label !== null,
        heartbeat: true,
        lastBinding: backend.binding ?? state.lastBinding,
        reachable: sameReachable(state.reachable, reachable) ? state.reachable : reachable,
        writes: sameWrites(state.writes, writes) ? state.writes : writes,
        timestamp: timestamp === undefined ? state.timestamp : timestamp,
      });
    },
  };
}
