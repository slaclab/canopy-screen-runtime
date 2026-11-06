// Macro resolution for the Canopy screen runtime.
//
// The IR stores macro *templates* (`${NAME}`); the runtime resolves them to
// values at render/subscribe time (see @slaclab/canopy-screen-ir macros.ts:
// "NEVER stored in the IR — the IR holds templates, runtime resolves to
// values"). The canonical spelling in IR documents is `${NAME}`; the legacy
// EPICS/EDM spelling `$(NAME)` is accepted too so converter output and
// hand-authored screens agree.

import type { MacroValues, ScreenJSON } from '@slaclab/canopy-screen-ir';
import type { PropertyValue, Props } from '@slaclab/canopy-screen-ir';

// `${NAME}` (canonical) or `$(NAME)` (legacy). Macro names are
// MACRO_NAME_PATTERN (^[A-Z][A-Z0-9_]*$); the match is deliberately broader
// (\w+) so near-miss names still round-trip visibly instead of vanishing.
const MACRO_RE = /\$\{(\w+)\}|\$\((\w+)\)/g;

/**
 * Substitute `${NAME}` / `$(NAME)` occurrences in `template` using `macros`.
 * Unresolved macros are left verbatim so a missing value is visible on the
 * screen (and in PV names) rather than silently collapsing to ''.
 * Substitution is a single pass — macro *values* are not re-scanned, so a
 * value containing `${X}` cannot recurse.
 */
export function substituteMacros(template: string, macros: MacroValues): string {
  return template.replace(
    MACRO_RE,
    (whole, curly: string | undefined, paren: string | undefined) => {
      const name = curly ?? paren ?? '';
      return macros[name] ?? whole;
    }
  );
}

/** Whether `template` still contains an unresolved macro reference. */
export function hasMacro(template: string): boolean {
  MACRO_RE.lastIndex = 0;
  return MACRO_RE.test(template);
}

/**
 * Deep macro substitution across a JSON prop value: every string anywhere in
 * the structure (including array elements and nested object values) is
 * substituted. Non-strings pass through untouched.
 */
export function substituteDeep(value: PropertyValue, macros: MacroValues): PropertyValue {
  if (typeof value === 'string') return substituteMacros(value, macros);
  if (Array.isArray(value)) {
    return value.map((v) => substituteDeep(v as PropertyValue, macros));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, PropertyValue> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = substituteDeep(v as PropertyValue, macros);
    }
    return out;
  }
  return value;
}

/** Substitute macros in every string prop of a widget props bag. */
export function substituteProps(props: Props, macros: MacroValues): Record<string, PropertyValue> {
  const out: Record<string, PropertyValue> = {};
  for (const [k, v] of Object.entries(props)) {
    out[k] = substituteDeep(v, macros);
  }
  return out;
}

/** Upper bound on default-substitution passes in `resolveScreenMacros`. */
const MAX_DEFAULT_PASSES = 5;

/**
 * The effective macro set for a screen: the screen's declared defaults,
 * overridden by caller-provided values (viewer query params, an embedding
 * parent, tests). Callers may also pass macros the screen never declared —
 * they flow through so deep embedding chains work like EPICS macro passing.
 * Declared defaults may reference other macros and are resolved to a fixpoint.
 */
export function resolveScreenMacros(screen: ScreenJSON, provided: MacroValues = {}): MacroValues {
  const merged: Record<string, string> = {};
  // Defaults that the caller did not override; only these are substituted —
  // caller-provided values are taken verbatim.
  const defaulted: string[] = [];
  for (const decl of screen.macros) {
    if (decl.default === undefined) continue;
    merged[decl.name] = decl.default;
    if (!Object.hasOwn(provided, decl.name)) defaulted.push(decl.name);
  }
  Object.assign(merged, provided);
  // A default may reference a provided macro (`P=${HOST}`) or another default
  // declared in any order (`A=${B}`, `B=1`). Substitute repeatedly against the
  // whole effective set until nothing changes, capped at MAX_DEFAULT_PASSES.
  // Unresolved references stay verbatim, so cycles (`A=${A}`) terminate.
  for (let pass = 0; pass < MAX_DEFAULT_PASSES; pass++) {
    let changed = false;
    for (const name of defaulted) {
      const current = merged[name] ?? '';
      const next = substituteMacros(current, merged);
      if (next !== current) {
        merged[name] = next;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return merged;
}

/**
 * Macros handed to an embedded screen: the parent's effective macros, plus
 * the embedding node's `macros` prop (whose *values* are themselves resolved
 * against the parent macros first — `{ MOTOR: "${PREFIX}:M1" }`). The child
 * screen's own declared defaults then fill anything still missing via
 * `resolveScreenMacros(child, thisResult)`.
 */
export function childMacros(
  parentMacros: MacroValues,
  nodeMacros: Readonly<Record<string, string>> | undefined
): MacroValues {
  const resolved: Record<string, string> = { ...parentMacros };
  for (const [name, value] of Object.entries(nodeMacros ?? {})) {
    resolved[name] = substituteMacros(value, parentMacros);
  }
  return resolved;
}
