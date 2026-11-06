// Color-role resolution: turns every ColorRole in a widget's props into a CSS
// color string before the props reach rules and widgets.
//
// A role the active scheme defines becomes `var(--cr-<i>, <fallback>)`, where
// `i` is the role's index in the flat scheme; the stylesheet that defines the
// `--cr-<i>` custom properties is installed separately. A role the scheme does
// not define becomes `light-dark(<fallback>, <fallbackDark ?? fallback>)`.
//
// The walk is pure and structurally shared: a subtree with no role is returned
// by reference, and the input is never mutated (IR documents may be frozen,
// and one embedded document can back many instances).

import { isColorRole } from '@slaclab/canopy-screen-ir';
import type { ColorRole, FlatScheme, PropertyValue } from '@slaclab/canopy-screen-ir';

type PropsBag = Readonly<Record<string, PropertyValue>>;

const roleIndexes = new WeakMap<FlatScheme, ReadonlyMap<string, number>>();

function indexOf(flat: FlatScheme): ReadonlyMap<string, number> {
  let map = roleIndexes.get(flat);
  if (!map) {
    const built = new Map<string, number>();
    flat.roles.forEach((role, i) => {
      if (!built.has(role)) built.set(role, i);
    });
    map = built;
    roleIndexes.set(flat, map);
  }
  return map;
}

/** The CSS color string a single role resolves to under `flat`. */
export function resolveRole(role: ColorRole, flat: FlatScheme): string {
  const i = indexOf(flat).get(role.$role);
  if (i !== undefined) return `var(--cr-${i}, ${role.fallback})`;
  return `light-dark(${role.fallback}, ${role.fallbackDark ?? role.fallback})`;
}

function resolveValue(value: PropertyValue, flat: FlatScheme): PropertyValue {
  if (value === null || typeof value !== 'object') return value;
  if (isColorRole(value)) return resolveRole(value, flat);
  if (Array.isArray(value)) {
    const items = value as readonly PropertyValue[];
    let out: PropertyValue[] | undefined;
    for (let i = 0; i < items.length; i++) {
      const next = resolveValue(items[i]!, flat);
      if (next !== items[i] && !out) out = items.slice(0, i);
      if (out) out.push(next);
    }
    return out ?? value;
  }
  return resolveObject(value as PropsBag, flat);
}

function resolveObject<T extends PropsBag>(obj: T, flat: FlatScheme): T {
  let out: Record<string, PropertyValue> | undefined;
  for (const key of Object.keys(obj)) {
    const before = obj[key]!;
    const after = resolveValue(before, flat);
    if (after !== before) {
      out ??= { ...obj };
      out[key] = after;
    }
  }
  return (out as T | undefined) ?? obj;
}

const resultCache = new WeakMap<FlatScheme, WeakMap<object, unknown>>();

/**
 * Resolve every ColorRole anywhere in `props` (nested arrays and objects
 * included, e.g. `curves[].color`) against `flat`. Returns `props` itself when
 * it holds no role; otherwise a copy that shares every role-free subtree.
 * The same `props` reference under the same scheme yields the same result.
 */
export function resolveRoles<T extends PropsBag>(props: T, flat: FlatScheme): T {
  let perScheme = resultCache.get(flat);
  if (!perScheme) {
    perScheme = new WeakMap();
    resultCache.set(flat, perScheme);
  }
  const hit = perScheme.get(props);
  if (hit !== undefined) return hit as T;
  const out = resolveObject(props, flat);
  perScheme.set(props, out);
  return out;
}
