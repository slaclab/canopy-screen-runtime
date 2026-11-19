// Adapter: the SDK's Formula Engine service → the runtime's FormulaSubscriber.
//
// Structurally typed on purpose: the runtime does not depend on
// @slaclab/canopy-client — the composition root (viewer app) constructs the
// concrete Formula Engine service and passes it here. `FormulaEngineServiceLike`
// is the minimal shape of its `subscribe`; the SDK class satisfies it (pinned
// by the wiring test, which uses the real class as a dev dependency).

import type { FormulaScalarValue, FormulaSpec, FormulaSubscriber } from '../formula.js';

interface FormulaEngineScalarLike {
  value: FormulaScalarValue;
}

interface FormulaEngineResultLike {
  kind: string;
  scalar: FormulaEngineScalarLike | null;
}

interface FormulaEngineErrorLike {
  code: string;
  message: string;
}

export interface FormulaEngineServiceLike {
  subscribe(
    spec: FormulaSpec,
    options: {
      intervalMs?: number;
      onResult: (data: FormulaEngineResultLike) => void;
      onError?: (error: FormulaEngineErrorLike) => void;
    }
  ): () => void;
}

/**
 * Wrap the SDK's Formula Engine service (or anything of its shape) as the
 * FormulaSubscriber the rule engine consumes. Scalar results feed
 * `onResult` with the bare value; non-scalar results are ignored (rules
 * target scalar widget properties); error frames map onto plain Errors.
 */
export function createFormulaEngineSubscriber(
  service: FormulaEngineServiceLike
): FormulaSubscriber {
  return {
    subscribe(spec: FormulaSpec, { intervalMs, onResult, onError }) {
      return service.subscribe(spec, {
        ...(intervalMs !== undefined ? { intervalMs } : {}),
        onResult: (data) => {
          if (data.kind === 'scalar' && data.scalar) onResult(data.scalar.value);
        },
        onError: onError
          ? (error) => onError(new Error(`${error.code}: ${error.message}`))
          : undefined,
      });
    },
  };
}
