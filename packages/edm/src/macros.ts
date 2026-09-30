// EDM macro substitution: `$(NAME)` (and `${NAME}`) replaced by value; an
// unresolved macro stays literal, as in EDM. `$(!W)` is unique per window and
// `$(!A)` per application; both are supplied by the screen as ordinary macros.

export type EdmMacros = Readonly<Record<string, string>>;

const MACRO = /\$\(([^()]+)\)|\$\{([^{}]+)\}/g;

export function expandMacros(s: string, macros: EdmMacros): string {
  if (!s.includes('$')) return s;
  return s.replace(MACRO, (whole, a: string | undefined, b: string | undefined) => {
    const v = macros[(a ?? b) as string];
    return v === undefined ? whole : v;
  });
}

/** "P=FOO,R=BAR" (EDM -m / related-display symbols) → { P: 'FOO', R: 'BAR' }. */
export function parseMacroString(s: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!s) return out;
  for (const part of splitTopLevel(s)) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

/** Split on commas that are not inside $( … ) / quotes. */
function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let q = false;
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') q = !q;
    else if (!q && c === '(') depth++;
    else if (!q && c === ')') depth = Math.max(0, depth - 1);
    if (c === ',' && depth === 0 && !q) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}
