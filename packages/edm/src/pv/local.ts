// EDM local PVs (LOC\ plugin): in-browser variables shared by name within one
// screen. Behaviour matches EDM's locPv plugin (locPv/loc_pv_factory.cc);
// written from that behaviour, no EDM code copied.
//
//   LOC\name               a reference; invalid (disconnected) until some
//                          reference initialises the name
//   LOC\name=t:value       t = d (double), i (integer), s (text),
//                          e (enum: `e:index,label0,label1,…`)
//
// The initialiser is positional, as in EDM: its first character is the type,
// the second is skipped whatever it is, the rest is the initial text. So
// `=i:0` and `=i,0` are integer 0, while `=0` or `=1` are *text* PVs with an
// empty value (numerically 0) — a quirk screens rely on. The first
// initialiser of a name wins. The value is one text buffer (63 chars) read as
// a number by its numeric prefix. Precision 4, limits -100..100.
//
// EDM keeps LOC PVs in one process-wide pool and screens make names private
// with the $(!W) macro; here the pool is one screen (browser window).

import { AlarmSeverity } from '@slaclab/canopy-client';
import { cFormat } from '../format.js';
import type { EdmPvConnection, EdmPvData, EdmPvListener, EdmPvType } from './types.js';

interface Entry {
  data: EdmPvData;
  valid: boolean;
  readonly listeners: Set<EdmPvListener>;
}

const INVALID: EdmPvData = {
  connected: false,
  type: 'string',
  num: 0,
  text: '',
  severity: AlarmSeverity.DISCONNECTED,
  units: '',
  precision: 4,
  enumChoices: [],
  lowerLimit: -100,
  upperLimit: 100,
  writable: true,
};

const numericPrefix = (s: string) => {
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
};

function withBuffer(d: EdmPvData, buffer: string): EdmPvData {
  const num = numericPrefix(buffer);
  if (d.type === 'enum') {
    const i = Math.trunc(num);
    return { ...d, num: i, text: d.enumChoices[i] ?? '' };
  }
  return { ...d, num: d.type === 'integer' ? Math.trunc(num) : num, text: buffer };
}

/** The PV an initialiser (the text after `=`) declares. */
export function parseLocDeclaration(attr: string): EdmPvData {
  const letter = attr[0] ?? '';
  const rest = attr.slice(2, 65);
  const base: EdmPvData = { ...INVALID, connected: true, severity: AlarmSeverity.NO_ALARM };
  const type: EdmPvType =
    letter === 'd' ? 'double' : letter === 'i' ? 'integer' : letter === 'e' ? 'enum' : 'string';
  if (type !== 'enum') return withBuffer({ ...base, type }, rest);
  const pieces = rest.split(/[,;]/).filter((s) => s !== '');
  if (pieces.length === 0) return withBuffer({ ...base, type, enumChoices: ['0', '1'] }, '0');
  return withBuffer({ ...base, type, enumChoices: pieces.slice(1, 17) }, pieces[0]);
}

export interface LocalConnection extends EdmPvConnection {
  clear(): void;
}

export function localConnection(): LocalConnection {
  const pvs = new Map<string, Entry>();
  const entry = (name: string): Entry => {
    let e = pvs.get(name);
    if (!e) {
      e = { data: INVALID, valid: false, listeners: new Set() };
      pvs.set(name, e);
    }
    return e;
  };
  // name = text before the first `=` or `~`; consecutive separators collapse.
  const split = (s: string): [string, string | undefined] => {
    const m = /[=~]+/.exec(s);
    return m ? [s.slice(0, m.index), s.slice(m.index + m[0].length)] : [s, undefined];
  };
  const emit = (e: Entry) => e.listeners.forEach((l) => l(e.data));
  return {
    subscribe(spec, listener) {
      const [name, attr] = split(spec);
      const e = entry(name);
      if (attr !== undefined && !e.valid) {
        e.valid = true;
        e.data = parseLocDeclaration(attr);
        emit(e);
      }
      e.listeners.add(listener);
      listener(e.data);
      return () => e.listeners.delete(listener);
    },
    put(spec, value) {
      const [name] = split(spec);
      const e = entry(name);
      // A put does not make an uninitialised PV valid, but its buffer changes.
      const buffer =
        typeof value === 'number'
          ? Number.isInteger(value)
            ? String(value)
            : cFormat('%.15g', value)
          : value.slice(0, 63);
      e.data = withBuffer(e.data, buffer);
      emit(e);
    },
    clear() {
      pvs.clear();
    },
  };
}
