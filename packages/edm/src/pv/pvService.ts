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
  };
}
