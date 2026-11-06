// Channel-name classes the runtime branches on.
//
// Prefixes match case-sensitively, the same rule the PV router
// (`RoutedPVService`) and `isFormulaRef` route by: a name the router would send to
// the gateway is never treated as local here.

import { FORMULA_PREFIX } from './formulaRef.js';

/** Prefix of a page-side local channel. */
export const LOC_PREFIX = 'loc://';

/** Whether `name` is a `loc://` local: page-side state that never reaches a machine. */
export function isLocalChannel(name: string): boolean {
  return name.startsWith(LOC_PREFIX);
}

/**
 * Whether a write to `name` bypasses the write gate: a `loc://` local or a
 * `formula://` formula channel, both served by the screen instance's router.
 */
export function isGateBypass(name: string): boolean {
  return isLocalChannel(name) || name.startsWith(FORMULA_PREFIX);
}
