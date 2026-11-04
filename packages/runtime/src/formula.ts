// Client-side Fox formula contracts.
//
// `FormulaSpec` mirrors the wire shape of Canopy's `canopy.contracts.formula.
// FormulaSpec` (camelCase on the wire): `kind`, `expression`, `bindings`.
// The expression grammar is Fox's sandboxed Python-expression subset
// (Canopy src/canopy/fox/language/grammar.py): arithmetic, comparisons,
// boolean ops, `a if cond else b` conditionals, and the SAFE_FUNCS call
// whitelist. PV inputs appear as `{token}` placeholders whose token text maps
// 1:1 onto `bindings` keys; Fox rejects specs whose bindings are unused or
// whose tokens are unbound, and rejects `fox:`-prefixed binding values
// (no formula-of-formula), which is why the rule compiler inlines screen
// formulas instead of referencing them.

import { createContext, useContext } from 'react';

export type FormulaKind = 'scalar' | 'timeseries' | 'waveform';

/** A complete formula request, ready to subscribe against Fox. */
export interface FormulaSpec {
  readonly kind: FormulaKind;
  readonly expression: string;
  readonly bindings: Readonly<Record<string, string>>;
}

/** Scalar result value delivered to rule subscribers. */
export type FormulaScalarValue = number | string | boolean;

/** Alarm severity of a formula result as Fox reports it (worst input severity). */
export type FormulaSeverity = 'NO_ALARM' | 'MINOR' | 'MAJOR' | 'INVALID';

/**
 * Optional per-result metadata. Rules ignore it; formula-backed widget
 * channels (see ScreenPVService) surface it as the channel's alarm state.
 */
export interface FormulaResultMeta {
  /** Worst severity across the formula's inputs; absent = not reported. */
  readonly severity?: FormulaSeverity;
  /** Result timestamp, epoch ms (Fox: the newest input sample used). */
  readonly timestampMs?: number;
}

export interface FormulaSubscribeOptions {
  /** Re-evaluation poll interval; omitted/0 = event-driven (on PV change). */
  intervalMs?: number;
  onResult: (value: FormulaScalarValue, meta?: FormulaResultMeta) => void;
  onError?: (error: Error) => void;
}

/**
 * The runtime's only view of a live formula service. The SDK's
 * FoxFormulaService satisfies this shape; tests use scripted stubs. The
 * returned function unsubscribes.
 */
export interface FormulaSubscriber {
  subscribe(spec: FormulaSpec, options: FormulaSubscribeOptions): () => void;
}

/**
 * Context carrying the app's FormulaSubscriber. When absent, widget rules are
 * inert: base props render unchanged (there is nothing to evaluate against).
 */
export const FormulaSubscriberContext = createContext<FormulaSubscriber | null>(null);

/** The ambient FormulaSubscriber, or null when the app runs without Fox. */
export function useFormulaSubscriber(): FormulaSubscriber | null {
  return useContext(FormulaSubscriberContext);
}
