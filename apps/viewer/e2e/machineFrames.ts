// Machine-statement heartbeat frames for the mocked PV socket (installHareMock
// in hostFixture.ts): builders for the `reachable` and `writes` claims and a
// heartbeat around them, plus the recorded frames of the shared heartbeat
// contract (fixtures/contracts/heartbeat_vectors.json, a byte copy of
// canopy's contract file), so a spec drives the viewer with the same frames
// the server and the SDK are checked against.
//
// A frame without `reachable` and `writes` keys is a legacy frame: the server
// makes no claim and the client reads both as null.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type {
  HareHeartbeatFrame,
  HareReachable,
  HareReachableState,
  HareWrites,
  HareWritesState,
} from '@slaclab/canopy-client';

/** A `writes` claim; reason and cause default to null. */
export function writes(
  state: HareWritesState | (string & {}),
  reason: string | null = null,
  cause: string | null = null
): HareWrites {
  return { state, reason, cause };
}

/** A `reachable` claim; since (epoch seconds) and reason default to null. */
export function reachable(
  state: HareReachableState | (string & {}),
  since: number | null = null,
  reason: string | null = null
): HareReachable {
  return { state, since, reason };
}

/** The identity and claims a heartbeat built by `heartbeat` carries. */
export interface HeartbeatFields {
  timestamp?: number;
  backend?: string | null;
  label?: string | null;
  notice?: HareHeartbeatFrame['notice'];
  binding?: string | null;
  /** Omitted: no `reachable` key (legacy). null: an explicit no-claim. */
  reachable?: HareReachable | null;
  /** Omitted: no `writes` key (legacy). null: an explicit no-claim. */
  writes?: HareWrites | null;
}

/**
 * A heartbeat frame. Identity defaults to the probe target installHareMock
 * announces on open (backend 'probe', label 'Probe', binding 'probe@1') and the
 * timestamp to now; `reachable` and `writes` appear only when given.
 */
export function heartbeat(fields: HeartbeatFields = {}): HareHeartbeatFrame {
  const frame: HareHeartbeatFrame = {
    type: 'heartbeat',
    timestamp: fields.timestamp ?? Date.now() / 1000,
    backend: fields.backend === undefined ? 'probe' : fields.backend,
    label: fields.label === undefined ? 'Probe' : fields.label,
    notice: fields.notice ?? null,
    binding: fields.binding === undefined ? 'probe@1' : fields.binding,
  };
  if (fields.reachable !== undefined) frame.reachable = fields.reachable;
  if (fields.writes !== undefined) frame.writes = fields.writes;
  return frame;
}

/** One recorded frame of the contract and what a reader derives from it. */
export interface RecordedFrame {
  case: string;
  frame: HareHeartbeatFrame;
  expected: Record<string, unknown>;
}

/** One step of a recorded sequence: a frame arrives, or the socket closes. */
export type RecordedStep =
  | { event: 'frame'; frame: HareHeartbeatFrame; expected: Record<string, unknown> }
  | { event: 'close'; expected: Record<string, unknown> };

export interface RecordedSequence {
  id: string;
  description: string;
  steps: RecordedStep[];
}

interface HeartbeatVectors {
  legacy_frame: RecordedFrame;
  reachable_frames: RecordedFrame[];
  writes_frames: RecordedFrame[];
  sequences: RecordedSequence[];
}

const VECTORS_PATH = fileURLToPath(
  new URL('./fixtures/contracts/heartbeat_vectors.json', import.meta.url)
);

let vectors: HeartbeatVectors | undefined;
function loadVectors(): HeartbeatVectors {
  vectors ??= JSON.parse(readFileSync(VECTORS_PATH, 'utf8')) as HeartbeatVectors;
  return vectors;
}

function byCase(list: RecordedFrame[], kind: string, name: string): RecordedFrame {
  const found = list.find((entry) => entry.case === name);
  if (!found) {
    const known = list.map((entry) => entry.case).join(', ');
    throw new Error(`machineFrames: no recorded ${kind} frame '${name}' (known: ${known})`);
  }
  return structuredClone(found);
}

/** The recorded legacy frame: identity only, no `reachable` or `writes` key. */
export function recordedLegacyFrame(): RecordedFrame {
  return structuredClone(loadVectors().legacy_frame);
}

/** A recorded `writes` frame by case, e.g. 'locked-with-reason'. */
export function recordedWritesFrame(name: string): RecordedFrame {
  return byCase(loadVectors().writes_frames, 'writes', name);
}

/** A recorded `reachable` frame by case, e.g. 'no-with-reason'. */
export function recordedReachableFrame(name: string): RecordedFrame {
  return byCase(loadVectors().reachable_frames, 'reachable', name);
}

/** A recorded frame/close sequence by id. */
export function recordedSequence(id: string): RecordedSequence {
  const found = loadVectors().sequences.find((sequence) => sequence.id === id);
  if (!found) {
    const known = loadVectors()
      .sequences.map((sequence) => sequence.id)
      .join(', ');
    throw new Error(`machineFrames: no recorded sequence '${id}' (known: ${known})`);
  }
  return structuredClone(found);
}
