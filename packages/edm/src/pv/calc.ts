// EDM CALC\ pseudo-PVs. Behaviour matches EDM's calcPv plugin
// (calcPv/calc_pv_factory.cc); written from that behaviour, no EDM code copied.
//
//   CALC\{expression}(arg1, arg2, …)   inline expression
//   CALC\name(arg1, …)                 expression from calc.list
//
// Arguments are numeric literals or PV names of any kind (EPICS, LOC\, nested
// CALC\), bound to A..L in order; unbound letters read 0. The result is a
// double with precision 4 that is recomputed on every argument update. It is
// connected when the expression name resolved and every PV argument is
// connected; its severity is the highest among the arguments, and at INVALID
// the expression is not evaluated (the previous value stays). An expression
// that does not compile leaves the value at 0. Writes are ignored.

import { AlarmSeverity } from '@slaclab/canopy-client';
import { CALC_NARGS, compileCalc, performCalc } from './calcExpr.js';
import type { CalcProgram } from './calcExpr.js';
import type { EdmPvLayer } from './layer.js';
import type { EdmPvConnection, EdmPvData } from './types.js';

/**
 * calc.list: a `CALC1` header, then name / expression line pairs; blank and
 * `#` lines are skipped anywhere, `@…` rewrite lines between a name and its
 * expression are ignored, and the first definition of a name wins.
 */
export function parseCalcList(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = text.split('\n').map((l) => l.trim());
  if (!lines[0]?.startsWith('CALC1')) return out;
  let name: string | null = null;
  for (const line of lines.slice(1)) {
    if (!line || line.startsWith('#')) continue;
    const opt = line.split(/[\s=]+/)[0].toLowerCase();
    if (name === null && (opt === 'processinvalid' || opt === 'invalidresult')) continue;
    if (name === null) name = line;
    else if (line.startsWith('@')) continue;
    else {
      if (!out.has(name)) out.set(name, line);
      name = null;
    }
  }
  return out;
}

export interface CalcRef {
  /** `{expr}` for inline expressions, else the calc.list name. */
  readonly head: string;
  readonly args: readonly string[];
}

/** Split the text after `CALC\` into its head and argument strings. */
export function parseCalcName(name: string): CalcRef | null {
  const s = name.replace(/^\s+/, '');
  if (!s || s.startsWith('(')) return null;
  let i = 0;
  let inBrace = false;
  while (i < s.length && (inBrace || s[i] !== '(')) {
    if (s[i] === '{') inBrace = true;
    else if (s[i] === '}') inBrace = false;
    i++;
  }
  let head = s.slice(0, i);
  if (head.startsWith('{')) {
    const close = head.indexOf('}');
    if (close < 2) return null; // `{}` or unterminated
    head = head.slice(0, close + 1);
  }
  const args: string[] = [];
  let rest = s.slice(i);
  if (rest.startsWith('(')) {
    rest = rest.slice(1);
    let k = 0;
    while (k < rest.length) {
      while (k < rest.length && ', \t)'.includes(rest[k])) k++;
      if (k >= rest.length) break;
      const start = k;
      let depth = 0;
      while (k < rest.length) {
        const c = rest[k];
        if (c === '(') depth++;
        else if (c === ')') {
          if (depth === 0) break;
          depth--;
        } else if (c === ',' && depth === 0) break;
        k++;
      }
      args.push(rest.slice(start, k).replace(/\s+$/, ''));
    }
  }
  return { head, args: args.slice(0, CALC_NARGS) };
}

/** EDM's numeric-literal argument: sign, digits, point, exponent; or any prefix of that. */
const NUMERIC_ARG = /^[+-]?(\d*\.?\d*)([eE][+-]?\d*)?$/;

const BASE: EdmPvData = {
  connected: false,
  type: 'double',
  num: 0,
  text: '',
  severity: AlarmSeverity.DISCONNECTED,
  units: '',
  precision: 4,
  enumChoices: [],
  lowerLimit: 0,
  upperLimit: 10,
  writable: true,
};

export function calcConnection(
  layer: EdmPvLayer,
  calcs: ReadonlyMap<string, string>
): EdmPvConnection {
  const compiled = new Map<string, CalcProgram | null>();
  const program = (head: string): CalcProgram | null | undefined => {
    const expr = head.startsWith('{') ? head.slice(1, -1) : calcs.get(head);
    if (expr === undefined) return undefined; // unknown name: the PV never becomes valid
    if (!compiled.has(head)) {
      try {
        compiled.set(head, compileCalc(expr));
      } catch {
        compiled.set(head, null); // compile error: valid with its arguments, value stays 0
      }
    }
    return compiled.get(head);
  };

  return {
    subscribe(name, listener, scope = '') {
      const ref = parseCalcName(name);
      const prog = ref ? program(ref.head) : undefined;
      if (!ref || prog === undefined) {
        listener(BASE);
        return () => {};
      }
      const n = ref.args.length;
      const values: number[] = new Array<number>(CALC_NARGS).fill(0);
      const state: (EdmPvData | undefined | null)[] = new Array(n).fill(undefined);
      let value = 0;
      const recompute = () => {
        if (state.some((d) => d === undefined || (d !== null && !d.connected))) {
          listener({ ...BASE, num: value });
          return;
        }
        let severity: AlarmSeverity = AlarmSeverity.NO_ALARM;
        for (const d of state) if (d && d.severity > severity) severity = d.severity;
        if (severity < AlarmSeverity.INVALID && prog) {
          const r = performCalc(prog, [...values]);
          if (r !== null) value = r;
        }
        listener({ ...BASE, connected: true, num: value, severity });
      };
      const unsubs: (() => void)[] = [];
      ref.args.forEach((arg, i) => {
        if (NUMERIC_ARG.test(arg)) {
          values[i] = parseFloat(arg) || 0;
          state[i] = null; // a constant
          return;
        }
        unsubs.push(
          layer.subscribe(
            arg,
            arg,
            'CALC.arg',
            (d) => {
              state[i] = d;
              values[i] = d.num;
              recompute();
            },
            scope
          )
        );
      });
      // No PV arguments (or all already delivered): the value is computed at once.
      if (state.every((d) => d !== undefined)) recompute();
      else if (state.some((d) => d === undefined)) listener({ ...BASE, num: value });
      return () => unsubs.forEach((u) => u());
    },
  };
}
