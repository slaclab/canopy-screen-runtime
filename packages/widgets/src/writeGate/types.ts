// Write-gate types: what a widget hands the gate and what the gate returns.
//
// One write's outcome is the SDK client's `WriteOutcome`, the value its
// `HarePVService.submit()` resolves to. The composition root (the viewer)
// adapts `submit()` to `WriteGateService`; nothing in this package calls it.

import type { WriteOutcome } from '@slaclab/canopy-client';

export type { WriteOutcome, WriteOutcomeKind } from '@slaclab/canopy-client';

/** A value a widget writes to a PV. */
export type WriteValue = number | string | boolean;

/** One write of a run. */
export interface WriteRequest {
  pv: string;
  value: WriteValue;
  /**
   * The text the operator typed when `value` was parsed from it (a text
   * entry's draft), for the confirmation dialog to show beside the value. It
   * is never sent: the write is `value`.
   */
  entered?: string;
  /**
   * A momentary button's release. It is sent iff the write before it resolved
   * `confirmed`, `mismatch`, `unconfirmed` or `unknown` — unlike every other
   * write, an `unknown` press does not stop it, so a held output is not left
   * pressed when the press's fate is unknown.
   */
  release?: boolean;
}

export interface WriteRunOptions {
  /**
   * Writes known only after the run has started: a momentary button's release
   * with confirmation off, appended when the pointer comes up. The gate sends
   * them after every listed write has resolved, under the same rules; the
   * promise never rejects and may resolve to an empty list.
   */
  tail?: Promise<readonly WriteRequest[]>;
}

/** `'declined'`, or the outcome of each write that was sent, in order. */
export type WriteRunResult = 'declined' | readonly WriteOutcome[];

/**
 * The gate a composition root provides for machine writes.
 *
 * `run()` takes one click's writes: at most one confirmation dialog, then the
 * writes in order, continuing only after `confirmed`, `mismatch` or
 * `unconfirmed` (a `release` write: see `WriteRequest.release`). It never
 * rejects.
 */
export interface WriteGateService {
  /** Whether a run opens a confirmation dialog first (read at each run). */
  confirmWrites(): boolean;
  run(writes: readonly WriteRequest[], options?: WriteRunOptions): Promise<WriteRunResult>;
  /**
   * Whether machine writes are accepted now. The same object is returned
   * while nothing changed. A gate without it makes no statement and is never
   * inert.
   */
  writes?(): WritesState;
  /** Calls `listener` when `writes()` may have changed. Returns an unsubscribe. */
  subscribeWrites?(listener: () => void): () => void;
}

/**
 * Whether the machine accepts writes. `disabled` widgets render inert, with
 * `reason` (never null while disabled) as their description and hover.
 */
export interface WritesState {
  readonly disabled: boolean;
  readonly reason: string | null;
}

/** The state of a gate that makes no statement, and of every local channel. */
export const WRITES_LIVE: WritesState = Object.freeze({ disabled: false, reason: null });

/** True when a run sent at least one write and every sent write was confirmed. */
export function allConfirmed(result: WriteRunResult): boolean {
  return (
    result !== 'declined' && result.length > 0 && result.every((o) => o.outcome === 'confirmed')
  );
}
