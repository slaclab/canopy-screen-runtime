// Client-side Formula Engine formula contracts.
//
// `FormulaSpec` mirrors the wire shape of Canopy's `canopy.contracts.formula.
// FormulaSpec` (camelCase on the wire): `kind`, `expression`, `bindings`.
// The expression grammar is the Formula Engine's sandboxed Python-expression
// subset (Canopy src/canopy/formula_engine/language/grammar.py): arithmetic,
// comparisons, boolean ops, `a if cond else b` conditionals, and the
// SAFE_FUNCS call whitelist. PV inputs appear as `{token}` placeholders whose
// token text maps 1:1 onto `bindings` keys; the Formula Engine rejects specs
// whose bindings are unused or whose tokens are unbound, and rejects
// `formula:`-prefixed binding values (no formula-of-formula), which is why
// the rule compiler inlines screen formulas instead of referencing them.

import { createContext, useContext } from 'react';

export type FormulaKind = 'scalar' | 'timeseries' | 'waveform';

/** A complete formula request, ready to subscribe against the Formula Engine. */
export interface FormulaSpec {
  readonly kind: FormulaKind;
  readonly expression: string;
  readonly bindings: Readonly<Record<string, string>>;
}

/** Scalar result value delivered to rule subscribers. */
export type FormulaScalarValue = number | string | boolean;

/** Alarm severity of a formula result as the Formula Engine reports it (worst input severity). */
export type FormulaSeverity = 'NO_ALARM' | 'MINOR' | 'MAJOR' | 'INVALID';

/**
 * Optional per-result metadata. Rules ignore it; formula-backed widget
 * channels (see ScreenPVService) surface it as the channel's alarm state.
 */
export interface FormulaResultMeta {
  /** Worst severity across the formula's inputs; absent = not reported. */
  readonly severity?: FormulaSeverity;
  /** Result timestamp, epoch ms (Formula Engine: the newest input sample used). */
  readonly timestampMs?: number;
}

/**
 * A formula subscription error that keeps its origin's `code` and whether it
 * is `retryable` (the subscription stays live and a later result supersedes
 * it). Raised by the Formula Engine adapter for every error frame and by local formula
 * evaluation for a dropped input; rule consumers read `retryable` to mark a
 * widget stale instead of failed.
 */
export class FormulaError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable: boolean) {
    super(`${code}: ${message}`);
    this.name = 'FormulaError';
    this.code = code;
    this.retryable = retryable;
  }
}

export interface FormulaSubscribeOptions {
  /** Re-evaluation poll interval; omitted/0 = event-driven (on PV change). */
  intervalMs?: number;
  onResult: (value: FormulaScalarValue, meta?: FormulaResultMeta) => void;
  onError?: (error: Error) => void;
}

/**
 * The runtime's only view of a live formula service. The SDK's Formula Engine
 * service satisfies this shape; tests use scripted stubs. The returned
 * function unsubscribes.
 */
export interface FormulaSubscriber {
  subscribe(spec: FormulaSpec, options: FormulaSubscribeOptions): () => void;
}

/**
 * Context carrying the app's FormulaSubscriber. When absent, widget rules are
 * inert: base props render unchanged (there is nothing to evaluate against).
 */
export const FormulaSubscriberContext = createContext<FormulaSubscriber | null>(null);

/** The ambient FormulaSubscriber, or null when the app runs without the Formula Engine. */
export function useFormulaSubscriber(): FormulaSubscriber | null {
  return useContext(FormulaSubscriberContext);
}
