// EDM local PVs (`LOC\name=type:init`, locPv plugin): in-browser variables
// scoped to one screen (window). Types: d(ouble), i(nteger), s(tring),
// e(num: `e:<index>,<choice0>,<choice1>,…`). The first declaration wins; a
// bare reference (`LOC\name`) before any declaration reads as a double 0.

import { AlarmSeverity } from '@slaclab/canopy-client';
import type { EdmPvConnection, EdmPvData, EdmPvListener } from './types.js';

interface Entry {
  data: EdmPvData;
  declared: boolean;
  readonly listeners: Set<EdmPvListener>;
}

const BASE: EdmPvData = {
  connected: true,
  type: 'double',
  num: 0,
  text: '',
  severity: AlarmSeverity.NO_ALARM,
  units: '',
  precision: null,
  enumChoices: [],
  lowerLimit: 0,
  upperLimit: 0,
};

export function parseLocDeclaration(decl: string): EdmPvData {
  const m = /^\s*([dise])\s*:(.*)$/is.exec(decl);
  if (!m) {
    const n = Number(decl);
    return Number.isFinite(n) && decl.trim() !== ''
      ? { ...BASE, num: n, text: decl.trim() }
      : { ...BASE, type: 'string', text: decl };
  }
  const t = m[1].toLowerCase();
  const rest = m[2];
  if (t === 's') return { ...BASE, type: 'string', text: rest };
  if (t === 'e') {
    const [idx, ...choices] = rest.split(',');
    const num = Number(idx) || 0;
    return { ...BASE, type: 'enum', num, text: choices[num] ?? '', enumChoices: choices };
  }
  const num = Number(rest) || 0;
  return { ...BASE, type: t === 'i' ? 'integer' : 'double', num, text: String(num) };
}

export interface LocalConnection extends EdmPvConnection {
  clear(): void;
}

export function localConnection(): LocalConnection {
  const pvs = new Map<string, Entry>();
  const entry = (name: string): Entry => {
    let e = pvs.get(name);
    if (!e) {
      e = { data: BASE, declared: false, listeners: new Set() };
      pvs.set(name, e);
    }
    return e;
  };
  const split = (s: string): [string, string | undefined] => {
    const eq = s.indexOf('=');
    return eq < 0 ? [s.trim(), undefined] : [s.slice(0, eq).trim(), s.slice(eq + 1)];
  };
  const emit = (e: Entry) => e.listeners.forEach((l) => l(e.data));
  return {
    subscribe(spec, listener) {
      const [name, decl] = split(spec);
      const e = entry(name);
      if (decl !== undefined && !e.declared) {
        e.declared = true;
        e.data = parseLocDeclaration(decl);
        emit(e);
      }
      e.listeners.add(listener);
      listener(e.data);
      return () => e.listeners.delete(listener);
    },
    put(spec, value) {
      const [name] = split(spec);
      const e = entry(name);
      const d = e.data;
      if (d.type === 'string') e.data = { ...d, text: String(value) };
      else {
        const num = typeof value === 'number' ? value : Number(value) || 0;
        e.data = {
          ...d,
          num: d.type === 'integer' || d.type === 'enum' ? Math.trunc(num) : num,
          text: d.type === 'enum' ? (d.enumChoices[Math.trunc(num)] ?? '') : String(num),
        };
      }
      emit(e);
    },
    clear() {
      pvs.clear();
    },
  };
}
