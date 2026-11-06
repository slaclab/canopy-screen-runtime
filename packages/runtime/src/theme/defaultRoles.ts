// Default colour roles: the role a colour prop takes when the document leaves
// it unset, filled in before role resolution so the default follows the
// active scheme and mode exactly as an authored role does. The fallbacks are
// canopy-default's own values for the role, so a scheme that does not define
// it still gets a readable light and dark colour.

import { canopyDefaultFlat } from '@slaclab/canopy-screen-ir';
import type { ColorRole, PropertyValue } from '@slaclab/canopy-screen-ir';

type PropsBag = Readonly<Record<string, PropertyValue>>;

function defaultRole(name: string): ColorRole {
  const i = canopyDefaultFlat.roles.indexOf(name);
  if (i < 0) throw new Error(`canopy-default defines no '${name}' role`);
  return {
    $role: name,
    fallback: canopyDefaultFlat.light[i],
    fallbackDark: canopyDefaultFlat.dark[i],
  };
}

/** The `Text` role, with canopy-default's light and dark values as its fallbacks. */
export const TEXT_ROLE: ColorRole = defaultRole('Text');

/** Per IR type, the role each colour prop takes when absent. */
const DEFAULT_ROLES: Readonly<Record<string, Readonly<Record<string, ColorRole>>>> = {
  'text-label': { foregroundColor: TEXT_ROLE },
};

/**
 * `props` with every default role of `type` filled in where the prop is
 * absent (`undefined`); `props` itself, by identity, when nothing is missing
 * or the type has no defaults.
 */
export function withDefaultRoles<T extends PropsBag>(type: string, props: T): T {
  const defaults = DEFAULT_ROLES[type];
  if (!defaults) return props;
  let out: Record<string, PropertyValue> | undefined;
  for (const [key, role] of Object.entries(defaults)) {
    if (props[key] !== undefined) continue;
    out ??= { ...props };
    out[key] = role;
  }
  return (out as T | undefined) ?? props;
}
