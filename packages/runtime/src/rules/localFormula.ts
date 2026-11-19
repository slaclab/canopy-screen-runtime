// FormulaSubscriber composition: formulas whose bindings are ALL client-side
// locals (loc://) evaluate in the page against the local PV service; anything
// else goes to the wrapped (Formula Engine) subscriber. A mixed spec — locals
// and CA channels in one expression — has no evaluation venue today (the
// Formula Engine cannot see page locals) and is surfaced as a subscription
// error.

import type { FormulaSpec, FormulaSubscriber } from '../formula.js';
import { evaluatePyExpr, PyExprError, type PyValue } from './pyExpr.js';

/** Structural slice of PVService — what local evaluation needs. */
export interface LocalPVLike {
  subscribe(
    pvName: string,
    listener: (data: { value: unknown; connected: boolean }) => void
  ): () => void;
}

function isLocal(address: string): boolean {
  return address.startsWith('loc://');
}

function scalar(value: unknown): PyValue {
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  return null;
}

/**
 * Wrap `formulaEngine` so loc-only formulas evaluate locally. `formulaEngine`
 * may be null (mock mode): loc-only formulas still work there — they need no
 * backend at all.
 */
export function createLocalAwareFormulaSubscriber(
  local: LocalPVLike,
  formulaEngine: FormulaSubscriber | null
): FormulaSubscriber {
  return {
    subscribe(spec: FormulaSpec, options) {
      const addresses = Object.values(spec.bindings);
      const localCount = addresses.filter(isLocal).length;

      if (localCount === 0) {
        if (formulaEngine) return formulaEngine.subscribe(spec, options);
        return () => {};
      }
      if (localCount !== addresses.length) {
        options.onError?.(
          new Error(
            'formula mixes loc:// locals with gateway channels; no evaluation venue supports both'
          )
        );
        return () => {};
      }

      const values = new Map<string, PyValue>();
      const connected = new Map<string, boolean>();
      // Pre-seed every token: subscriptions deliver synchronously one by one,
      // and evaluating before the last token reports would hit "unbound
      // token" errors mid-loop.
      for (const token of Object.keys(spec.bindings)) connected.set(token, false);
      let last: PyValue | undefined;

      const evaluate = () => {
        if ([...connected.values()].some((ok) => !ok)) return;
        try {
          const result = evaluatePyExpr(spec.expression, values);
          // null (Python None) has no FormulaScalarValue representation —
          // treat it as "no output", matching an unmatched rule ladder.
          if (result !== null && result !== last) {
            last = result;
            options.onResult(result);
          }
        } catch (err) {
          if (err instanceof PyExprError) {
            options.onError?.(err);
          } else {
            throw err;
          }
        }
      };

      const unsubscribes = Object.entries(spec.bindings).map(([token, address]) =>
        local.subscribe(address, (data) => {
          values.set(token, scalar(data.value));
          connected.set(token, data.connected);
          evaluate();
        })
      );
      return () => {
        for (const unsubscribe of unsubscribes) unsubscribe();
      };
    },
  };
}
