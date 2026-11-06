// FormulaSubscriber composition: formulas whose bindings are ALL client-side
// locals (loc://) evaluate in the page against the local PV service; anything
// else goes to the wrapped (Formula Engine) subscriber. A mixed spec — locals
// and CA channels in one expression — has no evaluation venue today (the
// Formula Engine cannot see page locals) and is surfaced as a subscription
// error.

import { isLocalChannel } from '../channels.js';
import type { FormulaSpec, FormulaSubscriber } from '../formula.js';
import { FormulaError } from '../formula.js';
import { evaluatePyExpr, PyExprError, type PyValue } from './pyExpr.js';

/** Structural slice of PVService — what local evaluation needs. */
export interface LocalPVLike {
  subscribe(
    pvName: string,
    listener: (data: { value: unknown; connected: boolean }) => void
  ): () => void;
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
      const localCount = addresses.filter(isLocalChannel).length;

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
      // Set by every reported error: the next result is delivered even when
      // it equals `last`, so a consumer's stale/error state clears.
      let deliverNext = false;

      const fail = (error: Error) => {
        deliverNext = true;
        options.onError?.(error);
      };

      const evaluate = () => {
        if ([...connected.values()].some((ok) => !ok)) return;
        try {
          const result = evaluatePyExpr(spec.expression, values);
          // null (Python None) has no FormulaScalarValue representation —
          // treat it as "no output". (Rule ladders never produce it: they
          // evaluate to an arm index, -1 for the default.)
          if (result !== null && (result !== last || deliverNext)) {
            last = result;
            deliverNext = false;
            options.onResult(result);
          }
        } catch (err) {
          if (err instanceof PyExprError) {
            fail(err);
          } else {
            throw err;
          }
        }
      };

      const unsubscribes = Object.entries(spec.bindings).map(([token, address]) =>
        local.subscribe(address, (data) => {
          // Only a connected → disconnected transition is an error: an input
          // that has never connected is still in its initial deliveries and
          // stays silent, and a repeated disconnected snapshot is one drop.
          const wasConnected = connected.get(token) === true;
          values.set(token, scalar(data.value));
          connected.set(token, data.connected);
          if (!data.connected && wasConnected) {
            fail(
              new FormulaError('input_disconnected', `local input '${address}' disconnected`, true)
            );
            return;
          }
          evaluate();
        })
      );
      return () => {
        for (const unsubscribe of unsubscribes) unsubscribe();
      };
    },
  };
}
