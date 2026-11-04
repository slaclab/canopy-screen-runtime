// Adapter: the SDK's FoxFormulaService → the runtime's FormulaSubscriber.
//
// Structurally typed on purpose: the runtime does not depend on
// @slaclab/canopy-client — the composition root (viewer app) constructs the
// concrete FoxFormulaService and passes it here. `FoxServiceLike` is the
// minimal shape of FoxFormulaService.subscribe; the SDK class satisfies it
// (pinned by the wiring test, which uses the real class as a dev dependency).

import type {
  FormulaResultMeta,
  FormulaScalarValue,
  FormulaSeverity,
  FormulaSpec,
  FormulaSubscriber,
} from '../formula.js';

interface FoxScalarLike {
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

function resultMeta(scalar: FoxScalarLike): FormulaResultMeta {
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

interface FoxResultLike {
  kind: string;
  scalar: FoxScalarLike | null;
}

interface FoxErrorLike {
  code: string;
  message: string;
}

export interface FoxServiceLike {
  subscribe(
    spec: FormulaSpec,
    options: {
      intervalMs?: number;
      onResult: (data: FoxResultLike) => void;
      onError?: (error: FoxErrorLike) => void;
    }
  ): () => void;
}

/**
 * Wrap a FoxFormulaService (or anything of its shape) as the
 * FormulaSubscriber the rule engine consumes. Scalar results feed
 * `onResult` with the bare value plus its severity/timestamp metadata;
 * non-scalar results are ignored (rules and widget channels are scalar);
 * error frames map onto plain Errors.
 */
export function createFoxFormulaSubscriber(service: FoxServiceLike): FormulaSubscriber {
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
          ? (error) => onError(new Error(`${error.code}: ${error.message}`))
          : undefined,
      });
    },
  };
}
