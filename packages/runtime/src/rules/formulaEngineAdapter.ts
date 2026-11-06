// Adapter: the SDK's Formula Engine service → the runtime's FormulaSubscriber.
//
// Structurally typed on purpose: the runtime does not depend on
// @slaclab/canopy-client — the composition root (viewer app) constructs the
// concrete Formula Engine service and passes it here. `FormulaEngineServiceLike`
// is the minimal shape of its `subscribe`; the SDK class satisfies it (pinned
// by the wiring test, which uses the real class as a dev dependency).

import { FormulaError } from '../formula.js';
import type {
  FormulaResultMeta,
  FormulaScalarValue,
  FormulaSeverity,
  FormulaSpec,
  FormulaSubscriber,
} from '../formula.js';

interface FormulaEngineScalarLike {
  value: FormulaScalarValue;
  /** Wire severity (`NO_ALARM` | `MINOR` | `MAJOR` | `INVALID`). */
  severity?: string;
  /** Result timestamp, epoch ns. */
  tsNs?: number;
}

const KNOWN_SEVERITIES: ReadonlySet<string> = new Set<FormulaSeverity>([
  'NO_ALARM',
  'MINOR',
  'MAJOR',
  'INVALID',
]);

function resultMeta(scalar: FormulaEngineScalarLike): FormulaResultMeta {
  const meta: { severity?: FormulaSeverity; timestampMs?: number } = {};
  if (scalar.severity !== undefined) {
    // Like HarePVService: a severity the server grew later reads as INVALID.
    meta.severity = KNOWN_SEVERITIES.has(scalar.severity)
      ? (scalar.severity as FormulaSeverity)
      : 'INVALID';
  }
  if (typeof scalar.tsNs === 'number' && scalar.tsNs > 0) {
    meta.timestampMs = Math.floor(scalar.tsNs / 1e6);
  }
  return meta;
}

interface FormulaEngineResultLike {
  kind: string;
  scalar: FormulaEngineScalarLike | null;
}

interface FormulaEngineErrorLike {
  code: string;
  message: string;
  /** The sdk's flag: true while the subscription stays live (a transient condition). */
  retryable?: boolean;
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
 * `onResult` with the bare value plus its severity/timestamp metadata;
 * non-scalar results are ignored (rules and widget channels are scalar);
 * error frames map onto FormulaErrors that keep the frame's `code` and
 * `retryable` (a frame without the flag reads as not retryable).
 */
export function createFormulaEngineSubscriber(
  service: FormulaEngineServiceLike
): FormulaSubscriber {
  return {
    subscribe(spec: FormulaSpec, { intervalMs, onResult, onError }) {
      return service.subscribe(spec, {
        ...(intervalMs !== undefined ? { intervalMs } : {}),
        onResult: (data) => {
          if (data.kind === 'scalar' && data.scalar) {
            onResult(data.scalar.value, resultMeta(data.scalar));
          }
        },
        onError: onError
          ? (error) =>
              onError(new FormulaError(error.code, error.message, error.retryable === true))
          : undefined,
      });
    },
  };
}
