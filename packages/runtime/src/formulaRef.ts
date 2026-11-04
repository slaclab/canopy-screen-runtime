// `formula://` reference helpers.
//
// These mirror the (unexported) helpers in @slaclab/canopy-screen-ir's
// formula.ts — the IR package's public surface is frozen, so the runtime
// carries its own copies of these three-liners rather than altering it.

/** Prefix marking a value as a formula reference (`formula://<name>`) rather than a PV. */
export const FORMULA_PREFIX = 'formula://';

/** Whether `value` is a `formula://` formula reference. */
export function isFormulaRef(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(FORMULA_PREFIX);
}

/** The bare formula name behind a reference, with the `formula://` prefix stripped if present. */
export function formulaName(ref: string): string {
  return ref.startsWith(FORMULA_PREFIX) ? ref.slice(FORMULA_PREFIX.length) : ref;
}
