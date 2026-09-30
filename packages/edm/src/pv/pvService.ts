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
  let type: EdmPvType;
  const kind = meta?.valueKind;
  if (kind === 'enum' || (kind === undefined && choices.length)) type = 'enum';
  else if (kind === 'string' || typeof d.value === 'string') type = 'string';
  else if (kind === 'waveform' || Array.isArray(d.value)) type = 'array';
  else if (typeof d.value === 'number' || typeof d.value === 'boolean')
    type = meta ? (meta.precision == null ? 'integer' : 'double') : 'double';
  else type = 'unknown';

  const num =
    typeof d.value === 'number'
      ? d.value
      : typeof d.value === 'boolean'
        ? Number(d.value)
        : typeof d.value === 'string'
          ? Number(d.value) || 0
          : 0;
  let text = '';
  if (type === 'enum') text = choices[num] ?? '';
  else if (typeof d.value === 'string') text = d.value;
  else if (Array.isArray(d.value)) text = d.displayValue ?? '';
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
