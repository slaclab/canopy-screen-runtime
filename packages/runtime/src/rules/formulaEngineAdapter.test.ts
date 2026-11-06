// Wiring test: the SDK's real Formula Engine service satisfies
// FormulaEngineServiceLike (compile-time pin), and the adapter's behavior is
// exercised against a scripted fake of the same shape.

import { describe, expect, it, vi } from 'vitest';
import { FormulaEngineService } from '@slaclab/canopy-client';
import type { FormulaSpec } from '../formula.js';
import type { FormulaEngineServiceLike } from './formulaEngineAdapter.js';
import { FormulaError } from '../formula.js';
import { createFormulaEngineSubscriber } from './formulaEngineAdapter.js';

const SPEC: FormulaSpec = {
  kind: 'scalar',
  expression: 'True if ({0} > 1) else (False)',
  bindings: { '0': 'DEV:SEVR' },
};

describe('createFormulaEngineSubscriber', () => {
  it('accepts the real SDK Formula Engine service (compile-time wiring)', () => {
    const service: FormulaEngineServiceLike = new FormulaEngineService({
      baseUrl: 'https://canopy.example.org',
      // No WebSocket in jsdom — inject a factory but never connect.
      webSocketFactory: () => {
        throw new Error('not connected in this test');
      },
    });
    const subscriber = createFormulaEngineSubscriber(service);
    expect(typeof subscriber.subscribe).toBe('function');
  });

  it('delivers scalar values, ignores non-scalar frames, maps errors', () => {
    let captured: {
      onResult: (data: {
        kind: string;
        scalar: { value: number | string | boolean; severity?: string; tsNs?: number } | null;
      }) => void;
      onError?: (error: { code: string; message: string }) => void;
      intervalMs?: number;
    } | null = null;
    const unsubscribe = vi.fn();
    const fake: FormulaEngineServiceLike = {
      subscribe: (spec, options) => {
        expect(spec).toEqual(SPEC);
        captured = options;
        return unsubscribe;
      },
    };

    const onResult = vi.fn();
    const onError = vi.fn();
    const stop = createFormulaEngineSubscriber(fake).subscribe(SPEC, {
      intervalMs: 500,
      onResult,
      onError,
    });

    expect(captured).not.toBeNull();
    const options = captured!;
    expect(options.intervalMs).toBe(500);

    options.onResult({ kind: 'scalar', scalar: { value: true } });
    expect(onResult).toHaveBeenLastCalledWith(true, {});

    options.onResult({ kind: 'waveform', scalar: null });
    expect(onResult).toHaveBeenCalledTimes(1);

    options.onError?.({ code: 'FORMULA_INVALID', message: 'bad spec' });
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]![0] as Error).message).toBe('FORMULA_INVALID: bad spec');

    stop();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('forwards result severity and timestamp as metadata', () => {
    let deliver: ((data: { kind: string; scalar: unknown }) => void) | null = null;
    const fake: FormulaEngineServiceLike = {
      subscribe: (_spec, options) => {
        deliver = options.onResult as (data: { kind: string; scalar: unknown }) => void;
        return () => {};
      },
    };
    const onResult = vi.fn();
    createFormulaEngineSubscriber(fake).subscribe(SPEC, { onResult });

    deliver!({
      kind: 'scalar',
      scalar: { value: -1.5, severity: 'MINOR', tsNs: 1_700_000_000_123_456_000, inputsUsed: {} },
    });
    expect(onResult).toHaveBeenLastCalledWith(-1.5, {
      severity: 'MINOR',
      timestampMs: 1_700_000_000_123,
    });

    // A severity this client does not know reads as INVALID (HarePVService parity).
    deliver!({ kind: 'scalar', scalar: { value: 2, severity: 'WEIRD', tsNs: 0, inputsUsed: {} } });
    expect(onResult).toHaveBeenLastCalledWith(2, { severity: 'INVALID' });
  });

  it("keeps the sdk's retryable flag on a typed error (code, retryable)", () => {
    let onErrorFrame:
      | ((error: { code: string; message: string; retryable?: boolean }) => void)
      | undefined;
    const fake: FormulaEngineServiceLike = {
      subscribe: (_spec, options) => {
        onErrorFrame = options.onError;
        return () => {};
      },
    };
    const onError = vi.fn();
    createFormulaEngineSubscriber(fake).subscribe(SPEC, { onResult: () => {}, onError });

    onErrorFrame?.({
      code: 'FORMULA_INPUT_OUTAGE',
      message: 'DEV:SEVR disconnected',
      retryable: true,
    });
    onErrorFrame?.({ code: 'FORMULA_INVALID', message: 'bad spec', retryable: false });
    // A frame without the flag (an older server) reads as not retryable.
    onErrorFrame?.({ code: 'FORMULA_INVALID', message: 'no flag' });

    expect(onError).toHaveBeenCalledTimes(3);
    const [outage, invalid, noFlag] = onError.mock.calls.map((call) => call[0] as FormulaError);
    expect(outage).toBeInstanceOf(FormulaError);
    expect(outage).toBeInstanceOf(Error);
    expect(outage!.code).toBe('FORMULA_INPUT_OUTAGE');
    expect(outage!.retryable).toBe(true);
    expect(outage!.message).toBe('FORMULA_INPUT_OUTAGE: DEV:SEVR disconnected');
    expect(invalid!.code).toBe('FORMULA_INVALID');
    expect(invalid!.retryable).toBe(false);
    expect(noFlag!.retryable).toBe(false);
  });
});
