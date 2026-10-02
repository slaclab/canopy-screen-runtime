// EPICS channels through any canopy-client PVService (HarePVService in the
// viewer, MockPVService in tests). Hare's per-channel metadata, when the
// service exposes it, tells integer records (no PREC) from doubles and enums
// from numbers, which EDM's formatting depends on.

import type { PVData, PVMetaDTO, PVService } from '@slaclab/canopy-client';
import type { EdmPvConnection, EdmPvData, EdmPvType } from './types.js';

type WithMeta = PVService & { getMeta?(pv: string): PVMetaDTO | undefined };

export function pvServiceConnection(service: PVService): EdmPvConnection {
  const svc = service as WithMeta;
  return {
    subscribe(name, listener) {
      return svc.subscribe(name, (d) => listener(toEdm(d, svc.getMeta?.(name))));
    },
    put(name, value) {
      svc.put(name, value);
    },
  };
}

/** A Hare-like service: its own socket, connected on demand, with channel metadata. */
export type EdmHareLike = WithMeta & { connect(): void; disconnect(): void };

interface Wave {
  readonly svc: EdmHareLike;
  refs: number;
  started: boolean;
}

/**
 * EPICS channels through Hare, one socket per wave of subscriptions.
 *
 * Hare reads a socket's subscribe messages one at a time and answers each
 * (with the channel metadata that tells integers from doubles) only when
 * every channel in it has been seeded; a dead CA channel costs two timeouts
 * (value, then describe: about 10 s with the default 5 s), and live channels
 * in the meantime get values without metadata (slaclab/canopy#129). One
 * message per channel would queue every channel behind each dead one. So the
 * channels a render asks for share one socket and one message, and channels
 * that report a value there before their metadata (live ones held back by a
 * dead neighbour) are asked for again on a fresh socket, which answers at
 * once. Values without metadata are never shown: EDM's formatting needs it.
 * Once Hare answers subscribes concurrently, plain pvServiceConnection will do.
 */
export function batchedPvServiceConnection(
  create: () => EdmHareLike,
  windowMs = 0
): EdmPvConnection {
  let collecting: Wave | null = null;
  let rescuing: Wave | null = null;
  let writer: EdmHareLike | null = null;

  const wave = (rescue: boolean): Wave => {
    const open = rescue ? rescuing : collecting;
    if (open) return open;
    const w: Wave = { svc: create(), refs: 0, started: false };
    if (rescue) rescuing = w;
    else collecting = w;
    setTimeout(() => {
      if (rescue ? rescuing === w : collecting === w) {
        if (rescue) rescuing = null;
        else collecting = null;
      }
      w.started = true;
      if (w.refs > 0) w.svc.connect();
    }, windowMs);
    return w;
  };
  const release = (w: Wave) => {
    w.refs--;
    if (w.refs === 0 && w.started) w.svc.disconnect();
  };

  return {
    subscribe(name, listener) {
      let closed = false;
      let rescue: { w: Wave; unsub: () => void } | null = null;
      const first = wave(false);
      first.refs++;
      let unsubFirst: (() => void) | null = null;
      const dropFirst = () => {
        if (!unsubFirst) return;
        unsubFirst();
        unsubFirst = null;
        release(first);
      };
      unsubFirst = first.svc.subscribe(name, (d) => {
        if (closed || rescue) return;
        const meta = first.svc.getMeta?.(name);
        if (meta || !d.connected) {
          listener(toEdm(d, meta));
          return;
        }
        // A value without metadata: ask again on a fresh socket.
        const w = wave(true);
        w.refs++;
        const unsub = w.svc.subscribe(name, (r) => {
          if (!closed) listener(toEdm(r, w.svc.getMeta?.(name)));
        });
        rescue = { w, unsub };
        dropFirst();
      });
      // (A service that answers synchronously may already have rescued it.)
      if (rescue) dropFirst();
      return () => {
        closed = true;
        dropFirst();
        if (rescue) {
          rescue.unsub();
          release(rescue.w);
          rescue = null;
        }
      };
    },
    put(name, value) {
      writer ??= create();
      writer.put(name, value);
    },
  };
}

function toEdm(d: PVData, meta: PVMetaDTO | undefined): EdmPvData {
  const choices = d.enumChoices ?? meta?.enumChoices ?? [];
  const numeric = (): EdmPvType =>
    meta ? (meta.precision == null ? 'integer' : 'double') : 'double';
  // A numeric waveform reads as its first element: EDM's text widgets call
  // get_double()/get_string() on the channel whatever its element count.
  const v = Array.isArray(d.value) && typeof d.value[0] !== 'string' ? (d.value[0] ?? 0) : d.value;
  let type: EdmPvType;
  const kind = meta?.valueKind;
  if (kind === 'enum' || (kind === undefined && choices.length)) type = 'enum';
  else if (kind === 'string' || typeof v === 'string') type = 'string';
  else if (typeof v === 'number' || typeof v === 'boolean') type = numeric();
  else if (Array.isArray(v)) type = 'array';
  else type = 'unknown';

  const num =
    typeof v === 'number'
      ? v
      : typeof v === 'boolean'
        ? Number(v)
        : typeof v === 'string'
          ? Number(v) || 0
          : 0;
  let text = '';
  if (type === 'enum') text = choices[num] ?? '';
  else if (typeof v === 'string') text = v;
  else if (Array.isArray(v)) text = v.join('');
  return {
    connected: d.connected,
    type,
    num,
    text,
    severity: d.severity,
    units: meta?.units ?? d.units ?? '',
    precision: meta ? (meta.precision ?? null) : d.precision,
    enumChoices: choices,
    lowerLimit: d.lowerLimit,
    upperLimit: d.upperLimit,
    writable: meta?.writable ?? true,
    ...(Array.isArray(d.value) && typeof d.value[0] !== 'string'
      ? { values: (d.value as readonly unknown[]).map((e) => Number(e)) }
      : {}),
    // Hare turns a char waveform into text; its record still has display limits
    // (numeric), a DBR_STRING channel has none.
    ...(type === 'string' && meta?.displayLow != null ? { charArray: true } : {}),
  };
}
