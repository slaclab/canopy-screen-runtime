// EDL (EDM display list, format 4.0.x) → EdmDocument.
//
// Value rules are EDM's own (edmlib/tag_pkg.cc tagClass::getValue and
// getCompoundValue):
//   - `name` alone is a flag;
//   - `name value` keeps the rest of the line, minus one leading and one
//     trailing double quote, with `\x` → `x` (so `\\ \" \{ \}` unescape);
//   - `name {` starts a compound value that runs to the first unescaped `}`;
//     each line drops its first unescaped `"` and a trailing `"`, and `\x` → `x`.
// Groups (activeGroupClass) hold `beginGroup … endGroup` between their own
// tags; the group's remaining tags (visPv, …) follow `endGroup`.
//
// The parser never throws: malformed input (merge-conflict markers, a class
// EDM cannot load, a truncated file) becomes an issue and parsing resumes at
// the next recognisable line.

import type { EdmBlock, EdmDocument, EdmObject, EdmParseIssue, EdmPropValue } from '../model.js';

interface Cursor {
  readonly lines: readonly string[];
  i: number;
  readonly issues: EdmParseIssue[];
}

const isSkippable = (s: string) => /^\s*(#|$)/.test(s);

const STRUCTURE = new Set([
  'object',
  'endGroup',
  'endObjectProperties',
  'endScreenProperties',
  'beginObjectProperties',
  'beginScreenProperties',
]);

export function parseEdl(text: string): EdmDocument {
  const lines = text.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  const cur: Cursor = { lines, i: 0, issues: [] };

  let version: [number, number, number] | null = null;
  while (cur.i < lines.length && isSkippable(lines[cur.i])) cur.i++;
  const vm = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(lines[cur.i] ?? '');
  if (vm) {
    version = [Number(vm[1]), Number(vm[2]), Number(vm[3])];
    cur.i++;
  }

  let screen: Record<string, EdmPropValue> = {};
  const objects: EdmObject[] = [];
  while (cur.i < lines.length) {
    const line = lines[cur.i];
    const t = line.trim();
    if (isSkippable(line)) {
      cur.i++;
    } else if (t === 'beginScreenProperties') {
      cur.i++;
      screen = readTags(cur, 'endScreenProperties', null);
    } else if (t.startsWith('object ') || t === 'object') {
      const obj = readObject(cur);
      if (obj) objects.push(obj);
    } else {
      cur.issues.push({ line: cur.i + 1, message: `unexpected line: ${clip(t)}` });
      cur.i++;
    }
  }
  return { version, screen, objects, issues: cur.issues };
}

/** At an `object <class>` line: the object and (for groups) its members. */
function readObject(cur: Cursor): EdmObject | null {
  const startLine = cur.i + 1;
  const className = cur.lines[cur.i].trim().slice('object'.length).trim();
  cur.i++;
  while (cur.i < cur.lines.length && isSkippable(cur.lines[cur.i])) cur.i++;
  if (cur.lines[cur.i]?.trim() !== 'beginObjectProperties') {
    cur.issues.push({ line: startLine, message: `object ${className}: no beginObjectProperties` });
    return null;
  }
  cur.i++;
  const children: EdmObject[] = [];
  const props = readTags(cur, 'endObjectProperties', children);
  if (!className) {
    cur.issues.push({ line: startLine, message: 'object without a class name' });
    return null;
  }
  return children.length || className === 'activeGroupClass'
    ? { className, props, children, line: startLine }
    : { className, props, line: startLine };
}

/**
 * Tag lines up to `end` (consumed). `children` collects `beginGroup … endGroup`
 * members when non-null.
 */
function readTags(
  cur: Cursor,
  end: string,
  children: EdmObject[] | null
): Record<string, EdmPropValue> {
  const props: Record<string, EdmPropValue> = {};
  while (cur.i < cur.lines.length) {
    const line = cur.lines[cur.i];
    if (isSkippable(line)) {
      cur.i++;
      continue;
    }
    const m = /^\s*(\S+)(?:[ \t]+(.*))?$/.exec(line);
    const name = m?.[1] ?? '';
    if (name === end) {
      cur.i++;
      return props;
    }
    if (name === 'beginGroup' && children) {
      cur.i++;
      readGroupMembers(cur, children);
      continue;
    }
    if (STRUCTURE.has(name)) {
      // A missing end tag: let the caller see this line.
      cur.issues.push({ line: cur.i + 1, message: `missing ${end} before ${clip(line.trim())}` });
      return props;
    }
    cur.i++;
    const rest = (m?.[2] ?? '').replace(/\s+$/, '');
    if (rest === '') {
      props[name] = true;
    } else if (rest.startsWith('{')) {
      props[name] = readCompound(cur, rest.slice(1));
    } else {
      props[name] = simpleValue(rest);
    }
  }
  cur.issues.push({ line: cur.lines.length, message: `end of file before ${end}` });
  return props;
}

function readGroupMembers(cur: Cursor, children: EdmObject[]) {
  while (cur.i < cur.lines.length) {
    const line = cur.lines[cur.i];
    const t = line.trim();
    if (isSkippable(line)) {
      cur.i++;
    } else if (t === 'endGroup') {
      cur.i++;
      return;
    } else if (t.startsWith('object ')) {
      const obj = readObject(cur);
      if (obj) children.push(obj);
    } else {
      cur.issues.push({ line: cur.i + 1, message: `unexpected line in group: ${clip(t)}` });
      cur.i++;
    }
  }
  cur.issues.push({ line: cur.lines.length, message: 'end of file before endGroup' });
}

/** tag_pkg.cc getValue, simple entry. */
function simpleValue(s: string): string {
  let a = 0;
  let b = s.length;
  if (s[0] === '"') a = 1;
  if (b - 1 > 0 && s[b - 1] === '"') b -= 1;
  return unescape(s.slice(a, Math.max(a, b)), false).text;
}

/** tag_pkg.cc getCompoundValue: lines up to the first unescaped `}`. */
function readCompound(cur: Cursor, sameLine: string): EdmBlock {
  const out: string[] = [];
  const take = (raw: string): boolean => {
    const s = raw.trim();
    if (!s) return true; // EDM rejects blank lines inside a block; tolerate them
    const body = s.length > 1 && s.endsWith('"') ? s.slice(0, -1) : s;
    const r = unescape(body, true);
    if (r.text || !r.closed) out.push(r.text);
    return !r.closed;
  };
  if (sameLine.trim() && !take(sameLine)) return { lines: out };
  while (cur.i < cur.lines.length) {
    const more = take(cur.lines[cur.i]);
    cur.i++;
    if (!more) return { lines: out };
  }
  cur.issues.push({ line: cur.lines.length, message: 'end of file inside a { … } value' });
  return { lines: out };
}

/**
 * `\x` → `x`; in compound mode also drop the first unescaped `"` and stop at
 * an unescaped `}` (closed = true).
 */
function unescape(s: string, compound: boolean): { text: string; closed: boolean } {
  let text = '';
  let escape = false;
  let foundQuote = false;
  for (const ch of s) {
    if (escape) {
      escape = false;
      text += ch;
    } else if (ch === '\\') {
      escape = true;
    } else if (compound && ch === '}') {
      return { text, closed: true };
    } else if (compound && ch === '"' && !foundQuote) {
      foundQuote = true;
    } else {
      text += ch;
    }
  }
  return { text, closed: false };
}

const clip = (s: string) => (s.length > 60 ? `${s.slice(0, 57)}...` : s);
