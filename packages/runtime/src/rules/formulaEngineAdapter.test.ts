// Wiring test: the SDK's real Formula Engine service satisfies
// FormulaEngineServiceLike (compile-time pin), and the adapter's behavior is
// exercised against a scripted fake of the same shape.

import { describe, expect, it, vi } from 'vitest';
import { FormulaEngineService } from '@slaclab/canopy-client';
import type { FormulaSpec } from '../formula.js';
import type { FormulaEngineServiceLike } from './formulaEngineAdapter.js';
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
        scalar: { value: number | string | boolean } | null;
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
    expect(onResult).toHaveBeenCalledWith(true);

    options.onResult({ kind: 'waveform', scalar: null });
    expect(onResult).toHaveBeenCalledTimes(1);

    options.onError?.({ code: 'FORMULA_INVALID', message: 'bad spec' });
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]![0] as Error).message).toBe('FORMULA_INVALID: bad spec');

    stop();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
