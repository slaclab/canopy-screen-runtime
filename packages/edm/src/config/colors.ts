// Site colour palette from colors.list (EDM format 4: edmlib/color_pkg.cc
// colorInfoClass::ver4InitFromFile), and EDM colour specs from .edl files.
//
//   static N "name" { r g b [r2 g2 b2] }   16-bit components; a second
//                                         triplet makes it blink
//   rule N name { <cond> : "colour" … }    value-driven colour (evalRule)
//   alias name "colour"
//   alarm { disconnected : "…" invalid : "…" minor : "…" major : "…" noalarm : * }
//   blinkms=750  max=0x10000
//
// Colours become CSS #rrggbb with the X server's 16→8-bit mapping (the high
// byte; checked against EDM screenshots).

import { AlarmSeverity } from '@slaclab/canopy-client';

export interface EdmStaticColor {
  readonly index: number;
  readonly name: string;
  /** CSS colour of the first (or only) RGB triplet. */
  readonly css: string;
  /** CSS colour of the blink phase, when the static blinks. */
  readonly blinkCss?: string;
}

type Cmp = (v: number, arg: number) => boolean;

interface RuleCondition {
  readonly test: (v: number) => boolean;
  /** How this condition's result joins the next one (`&&`/`||` after the colour). */
  readonly join?: '&&' | '||';
  readonly result: string;
}

export interface EdmColorRule {
  readonly index: number;
  readonly name: string;
  readonly conditions: readonly RuleCondition[];
}

/** An .edl colour property: `index N` or `rgb r g b` (16-bit). */
export type EdmColorSpec =
  | { readonly kind: 'index'; readonly index: number }
  | { readonly kind: 'rgb'; readonly css: string };

/** colors.list `alarm { … }`: severity → CSS colour; null = keep the widget's own. */
export type EdmAlarmColors = Readonly<Record<AlarmSeverity, string | null>>;

const CMP: Record<string, Cmp> = {
  '=': (v, a) => v === a,
  '!=': (v, a) => v !== a,
  '>': (v, a) => v > a,
  '>=': (v, a) => v >= a,
  '<': (v, a) => v < a,
  '<=': (v, a) => v <= a,
};

const TOKEN = /"(?:[^"\\]|\\.)*"|>=|<=|!=|&&|\|\||[=<>:{}*]|[^\s"=<>:{}!&|*]+/g;

export class EdmPalette {
  readonly statics = new Map<number, EdmStaticColor>();
  readonly rules = new Map<number, EdmColorRule>();
  readonly byName = new Map<string, number>();
  readonly aliases = new Map<string, string>();
  alarm: EdmAlarmColors = {
    [AlarmSeverity.NO_ALARM]: null,
    [AlarmSeverity.MINOR]: '#ffff00',
    [AlarmSeverity.MAJOR]: '#ff0000',
    [AlarmSeverity.INVALID]: '#ffffff',
    [AlarmSeverity.DISCONNECTED]: '#ffffff',
  };
  blinkMs = 0;
  /** The static named "invisible": objects whose colour evaluates to it are not drawn. */
  invisibleIndex = -1;
  /** Largest defined index + 1; EDM paints anything beyond as the invalid colour. */
  maxIndex = 0;
  readonly issues: string[] = [];

  /** Colour of a static or rule by index; a rule without a value shows its first result. */
  css(index: number, value?: number): string {
    const rule = this.rules.get(index);
    if (rule) return this.cssByName(evalRule(rule, value ?? 0)) ?? this.invalid();
    return this.statics.get(index)?.css ?? this.invalid();
  }

  /** CSS of an .edl colour spec (value selects a rule colour). */
  spec(spec: EdmColorSpec | undefined, value?: number): string | undefined {
    if (!spec) return undefined;
    return spec.kind === 'rgb' ? spec.css : this.css(spec.index, value);
  }

  /**
   * The colour index a spec shows (a rule evaluated at `value`); undefined
   * for rgb specs and unknown names.
   */
  indexFor(spec: EdmColorSpec | undefined, value?: number): number | undefined {
    if (spec?.kind !== 'index') return undefined;
    const rule = this.rules.get(spec.index);
    if (!rule) return spec.index;
    const name = evalRule(rule, value ?? 0);
    return this.byName.get(this.aliases.get(name) ?? name);
  }

  /** color_pkg.cc isInvisible: the evaluated colour is the "invisible" static. */
  isInvisible(spec: EdmColorSpec | undefined, value?: number): boolean {
    return this.invisibleIndex >= 0 && this.indexFor(spec, value) === this.invisibleIndex;
  }

  isRule(spec: EdmColorSpec | undefined): boolean {
    return spec?.kind === 'index' && this.rules.has(spec.index);
  }

  cssByName(name: string): string | undefined {
    const target = this.aliases.get(name) ?? name;
    const idx = this.byName.get(target);
    return idx === undefined ? undefined : this.statics.get(idx)?.css;
  }

  /** EDM's special "disconnected" colour (colors.list `alarm { disconnected }`). */
  disconnected(): string {
    return this.alarm[AlarmSeverity.DISCONNECTED] ?? '#ffffff';
  }

  /** EDM's special INVALID colour (colors.list `alarm { invalid }`), for undefined indices. */
  invalid(): string {
    return this.alarm[AlarmSeverity.INVALID] ?? '#ffffff';
  }

  static parse(text: string): EdmPalette {
    const p = new EdmPalette();
    // Strip comments outside quotes, then tokenise the whole file.
    const src = text
      .split('\n')
      .map((l) => stripComment(l))
      .join('\n');
    let maxComponent = 0x10000;
    for (const m of src.matchAll(/^\s*(blinkms|max)\s*=\s*(\S+)/gm)) {
      const n = Number(m[2]);
      if (!Number.isFinite(n)) continue;
      if (m[1] === 'blinkms') p.blinkMs = n;
      else maxComponent = n;
    }
    const toks = src.replace(/^\s*\w+\s*=.*$/gm, '').match(TOKEN) ?? [];
    let i = 0;
    const next = () => toks[i++];
    const peek = () => toks[i];
    const unq = (s: string | undefined) => (s && s.startsWith('"') ? s.slice(1, -1) : (s ?? ''));
    const toCss = (c: number[]) =>
      '#' +
      c
        .map((v) => {
          const c16 = Math.min(0xffff, Math.max(0, Math.round((v * 0x10000) / maxComponent)));
          return (c16 >> 8).toString(16).padStart(2, '0');
        })
        .join('');
    const pendingAlarm: Partial<Record<AlarmSeverity, string | null>> = {};

    while (i < toks.length) {
      const t = next();
      if (t === 'static') {
        const index = Number(next());
        const name = unq(next());
        if (next() !== '{') {
          p.issues.push(`static ${index}: expected {`);
          continue;
        }
        const nums: number[] = [];
        while (i < toks.length && peek() !== '}') nums.push(Number(next()));
        next();
        if (!Number.isInteger(index) || nums.length < 3 || nums.some((n) => !Number.isFinite(n))) {
          p.issues.push(`static ${index} "${name}": bad components`);
          continue;
        }
        p.statics.set(index, {
          index,
          name,
          css: toCss(nums.slice(0, 3)),
          ...(nums.length >= 6 ? { blinkCss: toCss(nums.slice(3, 6)) } : {}),
        });
        if (!p.byName.has(name)) p.byName.set(name, index);
        if (name === 'invisible') p.invisibleIndex = index;
        p.maxIndex = Math.max(p.maxIndex, index + 1);
      } else if (t === 'rule') {
        const index = Number(next());
        const name = unq(next());
        if (next() !== '{') {
          p.issues.push(`rule ${index}: expected {`);
          continue;
        }
        const body: string[] = [];
        while (i < toks.length && peek() !== '}') body.push(next());
        next();
        const conditions = parseRuleBody(body, (msg) =>
          p.issues.push(`rule ${index} ${name}: ${msg}`)
        );
        p.rules.set(index, { index, name, conditions });
        if (!p.byName.has(name)) p.byName.set(name, index);
        p.maxIndex = Math.max(p.maxIndex, index + 1);
      } else if (t === 'alias') {
        const name = unq(next());
        p.aliases.set(name, unq(next()));
      } else if (t === 'alarm') {
        if (next() !== '{') continue;
        while (i < toks.length && peek() !== '}') {
          const key = next();
          if (next() !== ':') continue;
          const v = next();
          const sev = ALARM_KEYS[key];
          if (sev !== undefined) pendingAlarm[sev] = v === '*' ? null : unq(v);
        }
        next();
      } else if (t === 'menumap') {
        if (next() !== '{') continue;
        while (i < toks.length && peek() !== '}') next();
        next();
      }
    }
    // Resolve alarm colour names once every static is known.
    const alarm = { ...p.alarm } as Record<AlarmSeverity, string | null>;
    for (const [k, name] of Object.entries(pendingAlarm)) {
      const sev = Number(k) as AlarmSeverity;
      alarm[sev] = name === null ? null : (p.cssByName(name) ?? alarm[sev]);
    }
    p.alarm = alarm;
    return p;
  }
}

const ALARM_KEYS: Record<string, AlarmSeverity> = {
  disconnected: AlarmSeverity.DISCONNECTED,
  invalid: AlarmSeverity.INVALID,
  minor: AlarmSeverity.MINOR,
  major: AlarmSeverity.MAJOR,
  noalarm: AlarmSeverity.NO_ALARM,
};

/**
 * `<cond> : "colour"` entries; cond = `default` | number (implied =) |
 * op number [(&&|\|\|) op number]; an `&&`/`||` after the colour joins the
 * entry with the next (color_pkg.cc ver4InitFromFile states).
 */
function parseRuleBody(toks: string[], issue: (m: string) => void): RuleCondition[] {
  const out: RuleCondition[] = [];
  let i = 0;
  const cmp = (): ((v: number) => boolean) | null => {
    const t = toks[i++];
    if (t === undefined) return null;
    if (t === 'default') return () => true;
    let op = '=';
    let arg = t;
    if (CMP[t]) {
      op = t;
      arg = toks[i++];
    }
    const a = Number(arg);
    if (!Number.isFinite(a)) {
      issue(`bad number ${arg}`);
      return null;
    }
    const f = CMP[op];
    return (v) => f(v, a);
  };
  while (i < toks.length) {
    const c1 = cmp();
    if (!c1) break;
    let test = c1;
    if (toks[i] === '&&' || toks[i] === '||') {
      const conn = toks[i++];
      const c2 = cmp();
      if (!c2) break;
      test = conn === '&&' ? (v) => c1(v) && c2(v) : (v) => c1(v) || c2(v);
    }
    if (toks[i] !== ':') {
      issue(`expected : at ${toks[i]}`);
      break;
    }
    i++;
    const r = toks[i++] ?? '';
    const result = r.startsWith('"') ? r.slice(1, -1) : r;
    let join: '&&' | '||' | undefined;
    if (toks[i] === '&&' || toks[i] === '||') join = toks[i++] as '&&' | '||';
    out.push(join ? { test, join, result } : { test, result });
  }
  return out;
}

/** color_pkg.cc evalRule: first condition that holds wins; else the first result. */
export function evalRule(rule: EdmColorRule, value: number): string {
  let pending: { op: '&&' | '||'; acc: boolean } | null = null;
  for (const c of rule.conditions) {
    let r = c.test(value);
    if (pending) r = pending.op === '&&' ? r && pending.acc : r || pending.acc;
    if (c.join) {
      pending = { op: c.join, acc: r };
      continue;
    }
    pending = null;
    if (r) return c.result;
  }
  // No match: EDM keeps the rule index, whose pixel is the first result colour.
  return rule.conditions[0]?.result ?? '';
}

/** `index 14` / `rgb 65535 0 0` → spec; undefined for anything else. */
export function parseColorSpec(raw: string | undefined): EdmColorSpec | undefined {
  if (!raw) return undefined;
  let m = /^\s*index\s+(-?\d+)/.exec(raw);
  if (m) return { kind: 'index', index: Number(m[1]) };
  m = /^\s*rgb\s+(\d+)\s+(\d+)\s+(\d+)/.exec(raw);
  if (m) {
    const css =
      '#' +
      [m[1], m[2], m[3]]
        .map((v) => (Math.min(0xffff, Number(v)) >> 8).toString(16).padStart(2, '0'))
        .join('');
    return { kind: 'rgb', css };
  }
  return undefined;
}

function stripComment(line: string): string {
  let q = false;
  for (let k = 0; k < line.length; k++) {
    const c = line[k];
    if (c === '\\') k++;
    else if (c === '"') q = !q;
    else if (c === '#' && !q) return line.slice(0, k);
  }
  return line;
}
