// Fixture PV service: serves a recorded snapshot for deterministic renders.
//
// The snapshot holds every PV once in the Formula Engine's binding form — enum and bi PVs as
// their numeric index, `<pv>.SEVR` as a number — plus each PV's connection
// state. Values are static: a subscriber gets the recorded value at once and
// nothing after it, so a render never depends on timing.
//
// Serving rules:
//   - `value` is the stored value; `displayValue` is that value as-is (an
//     enum renders its index, since the snapshot carries no enum strings).
//   - a base PV's severity comes from its `<pv>.SEVR` entry (0-3); without
//     one, or with an out-of-range one, it is NO_ALARM.
//   - a PV recorded as disconnected, or absent from the snapshot, renders as
//     disconnected (severity 4), exactly as a dead gateway PV does.
//   - `ca://` and `pva://` names resolve against the bare PV name.

import { AlarmSeverity, DISCONNECTED_PV } from '@slaclab/canopy-screen-widgets';
import type { PVData, PVListener, PVService } from '@slaclab/canopy-screen-widgets';

/** A recorded value in Formula Engine binding form. */
export type FixtureValue = number | string | boolean;

/** One recorded PV: the value plus its connection state (default connected). */
export interface FixtureEntry {
  value: FixtureValue;
  connected?: boolean;
}

/**
 * The fixture snapshot document (`__fixture/<key>.json`). An entry is either
 * a `FixtureEntry` or a bare value, shorthand for a connected entry.
 * `timestamp` (epoch seconds) stamps every value; it defaults to 0.
 */
export interface FixtureSnapshot {
  pvs: Record<string, FixtureEntry | FixtureValue>;
  timestamp?: number;
}

const SEVR_SUFFIX = '.SEVR';
const SCHEME_RE = /^(ca|pva):\/\//;

function isFixtureValue(value: unknown): value is FixtureValue {
  return (
    (typeof value === 'number' && Number.isFinite(value)) ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  );
}

function invalid(message: string): never {
  throw new Error(`invalid fixture snapshot: ${message}`);
}

/** Validate a parsed `__fixture/<key>.json`; throws on any malformed entry. */
export function parseFixtureSnapshot(raw: unknown): FixtureSnapshot {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    invalid('expected an object');
  }
  const doc = raw as { pvs?: unknown; timestamp?: unknown };
  if (typeof doc.pvs !== 'object' || doc.pvs === null || Array.isArray(doc.pvs)) {
    invalid("expected a 'pvs' object");
  }
  if (doc.timestamp !== undefined && typeof doc.timestamp !== 'number') {
    invalid("'timestamp' must be a number");
  }
  const pvs: Record<string, FixtureEntry> = {};
  for (const [name, entry] of Object.entries(doc.pvs as Record<string, unknown>)) {
    if (isFixtureValue(entry)) {
      pvs[name] = { value: entry };
      continue;
    }
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      invalid(`${name}: expected a value or { value, connected }`);
    }
    const { value, connected } = entry as { value?: unknown; connected?: unknown };
    if (!isFixtureValue(value)) invalid(`${name}: 'value' must be a number, string or boolean`);
    if (connected !== undefined && typeof connected !== 'boolean') {
      invalid(`${name}: 'connected' must be a boolean`);
    }
    pvs[name] = connected === undefined ? { value } : { value, connected };
  }
  return doc.timestamp === undefined ? { pvs } : { pvs, timestamp: doc.timestamp };
}

export class FixturePVService implements PVService {
  private readonly entries: ReadonlyMap<string, FixtureEntry>;
  private readonly timestamp: number;
  private connectedFlag = false;

  constructor(snapshot: FixtureSnapshot) {
    const entries = new Map<string, FixtureEntry>();
    for (const [name, entry] of Object.entries(snapshot.pvs)) {
      entries.set(name, isFixtureValue(entry) ? { value: entry } : entry);
    }
    this.entries = entries;
    this.timestamp = snapshot.timestamp ?? 0;
  }

  get isConnected(): boolean {
    return this.connectedFlag;
  }

  subscribe(pvName: string, listener: PVListener): () => void {
    listener(this.data(pvName));
    // Static data: there is never a later update to stop.
    return () => {};
  }

  getSnapshot(pvName: string): PVData | undefined {
    return this.data(pvName);
  }

  put(pvName: string, value: number | string | boolean): void {
    console.warn(
      `FixturePVService: ${pvName} is served from a read-only fixture; put(${String(value)}) ignored`
    );
  }

  connect(): void {
    this.connectedFlag = true;
  }

  disconnect(): void {
    this.connectedFlag = false;
  }

  private lookup(pvName: string): FixtureEntry | undefined {
    return this.entries.get(pvName) ?? this.entries.get(pvName.replace(SCHEME_RE, ''));
  }

  private severity(pvName: string): PVData['severity'] {
    if (pvName.endsWith(SEVR_SUFFIX)) return AlarmSeverity.NO_ALARM;
    const sevr = this.lookup(pvName + SEVR_SUFFIX);
    if (!sevr || sevr.connected === false) return AlarmSeverity.NO_ALARM;
    const n = sevr.value;
    if (typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 3) {
      return n as PVData['severity'];
    }
    return AlarmSeverity.NO_ALARM;
  }

  private data(pvName: string): PVData {
    const entry = this.lookup(pvName);
    if (!entry || entry.connected === false) return DISCONNECTED_PV;
    return {
      value: entry.value,
      displayValue: String(entry.value),
      severity: this.severity(pvName),
      connected: true,
      timestamp: this.timestamp,
      units: '',
      precision: 0,
      lowerLimit: 0,
      upperLimit: 0,
    };
  }
}
