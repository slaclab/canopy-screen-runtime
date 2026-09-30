// The EDM object description: what the parser produces and every widget reads.
//
// It stays close to EDM's own model (edmlib/tag_pkg.cc): each object is its
// class name plus the tag/value pairs of its `beginObjectProperties` block,
// kept verbatim. Widgets interpret the values the way EDM's createFromFile
// does, through the typed accessors below, so the description never loses
// information a later widget might need.

/** A compound `name { … }` value: EDM's per-line processed text (tag_pkg.cc getCompoundValue). */
export interface EdmBlock {
  readonly lines: readonly string[];
}

/** `true` = a bare flag tag (`fill`), string = a one-line value, block = `name { … }`. */
export type EdmPropValue = string | true | EdmBlock;

export type EdmProps = Readonly<Record<string, EdmPropValue>>;

export interface EdmObject {
  /** As written after `object`, including suffixes such as `activeXTextDspClass:noedit`. */
  readonly className: string;
  readonly props: EdmProps;
  /** Members of an activeGroupClass (`beginGroup … endGroup`), in file order. */
  readonly children?: readonly EdmObject[];
  /** 1-based line of the `object` keyword (diagnostics). */
  readonly line: number;
}

export interface EdmParseIssue {
  readonly line: number;
  readonly message: string;
}

export interface EdmDocument {
  /** `[major, minor, release]` of the format line, e.g. [4, 0, 1]. */
  readonly version: readonly [number, number, number] | null;
  /** `beginScreenProperties … endScreenProperties` (empty for template fragments). */
  readonly screen: EdmProps;
  readonly objects: readonly EdmObject[];
  readonly issues: readonly EdmParseIssue[];
}

export function isBlock(v: EdmPropValue | undefined): v is EdmBlock {
  return typeof v === 'object' && v !== null;
}

/** One-line value as a string ('' for a flag or block; undefined when absent). */
export function propStr(props: EdmProps, name: string): string | undefined {
  const v = props[name];
  if (v === undefined) return undefined;
  return typeof v === 'string' ? v : '';
}

/** C `strtol(s, 0, 0)`-style integer (leading number, hex with 0x), else `def`; 1 for a bare tag. */
export function propInt(props: EdmProps, name: string, def: number): number {
  const v = props[name];
  // A tag present without a value reads as 1 (EDM's tag reader), e.g. a flag.
  if (v === true) return 1;
  if (typeof v !== 'string') return def;
  return parseCInt(v) ?? def;
}

export function propNum(props: EdmProps, name: string, def: number): number {
  const v = props[name];
  if (typeof v !== 'string') return def;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : def;
}

/**
 * A boolean tag: EDM writes it as a bare flag when true (tag.loadBoolW) and
 * old files may write `name 1`.
 */
export function propBool(props: EdmProps, name: string): boolean {
  const v = props[name];
  if (v === true) return true;
  if (typeof v === 'string') return (parseCInt(v) ?? 0) !== 0;
  return false;
}

/** A multi-line string value (`value { "a" "b" }` → "a\nb"; a one-line value as is). */
export function propText(props: EdmProps, name: string): string | undefined {
  const v = props[name];
  if (v === undefined) return undefined;
  if (v === true) return '';
  if (typeof v === 'string') return v;
  return v.lines.join('\n');
}

/**
 * A sparse indexed string array (`symbols { 0 "P=…" \n 2 "…" }`): index → the
 * rest of the line, `''` meaning empty (tag_pkg.cc STRING_ARRAY /
 * EXP_STRING_ARRAY). Holes are undefined.
 */
export function propIndexedStrings(props: EdmProps, name: string): (string | undefined)[] {
  const v = props[name];
  const out: (string | undefined)[] = [];
  if (!isBlock(v)) return out;
  for (const raw of v.lines) {
    const m = /^\s*(\S+)(?:[ \t]+(.*))?$/.exec(raw);
    if (!m) continue;
    const idx = parseCInt(m[1]);
    if (idx === undefined || idx < 0 || idx > 10000) continue;
    const val = m[2] ?? '';
    out[idx] = val === "''" ? '' : val;
  }
  return out;
}

/** A sparse indexed integer array (`closeAction { 0 1 }`); holes undefined. */
export function propIndexedInts(props: EdmProps, name: string): (number | undefined)[] {
  const out: (number | undefined)[] = [];
  const toks = blockTokens(props, name);
  for (let i = 0; i + 1 < toks.length; i += 2) {
    const idx = parseCInt(toks[i]);
    const val = parseCInt(toks[i + 1]);
    if (idx === undefined || idx < 0 || idx > 10000 || val === undefined) continue;
    out[idx] = val;
  }
  return out;
}

/**
 * A dynamic integer array (`xPoints { 0 257 \n 1 258 }`): the values of the
 * index/value pairs in file order, indices ignored (tag_pkg.cc
 * DYNAMIC_INTEGER_ARRAY).
 */
export function propIntList(props: EdmProps, name: string): number[] {
  const toks = blockTokens(props, name);
  const out: number[] = [];
  for (let i = 1; i < toks.length; i += 2) out.push(parseCInt(toks[i]) ?? 0);
  return out;
}

function blockTokens(props: EdmProps, name: string): string[] {
  const v = props[name];
  if (!isBlock(v)) return [];
  return v.lines
    .join('\n')
    .split(/[ \t\n]+/)
    .filter(Boolean);
}

/** strtol(s, NULL, 0): optional sign, 0x hex, leading digits; undefined when none. */
export function parseCInt(s: string): number | undefined {
  const m = /^\s*([+-]?)(0x[0-9a-f]+|\d+)/i.exec(s);
  if (!m) return undefined;
  const n = m[2].toLowerCase().startsWith('0x') ? parseInt(m[2], 16) : parseInt(m[2], 10);
  return m[1] === '-' ? -n : n;
}
