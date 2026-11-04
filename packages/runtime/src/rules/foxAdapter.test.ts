// Wiring test: the SDK's real FoxFormulaService satisfies FoxServiceLike
// (compile-time pin), and the adapter's behavior is exercised against a
// scripted fake of the same shape.

import { describe, expect, it, vi } from 'vitest';
import { FoxFormulaService } from '@slaclab/canopy-client';
import type { FormulaSpec } from '../formula.js';
import type { FoxServiceLike } from './foxAdapter.js';
import { createFoxFormulaSubscriber } from './foxAdapter.js';

const SPEC: FormulaSpec = {
  kind: 'scalar',
  expression: 'True if ({0} > 1) else (False)',
  bindings: { '0': 'DEV:SEVR' },
};

describe('createFoxFormulaSubscriber', () => {
  it('accepts the real SDK FoxFormulaService (compile-time wiring)', () => {
    const service: FoxServiceLike = new FoxFormulaService({
      baseUrl: 'https://canopy.example.org',
      // No WebSocket in jsdom — inject a factory but never connect.
      webSocketFactory: () => {
        throw new Error('not connected in this test');
      },
    });
    const subscriber = createFoxFormulaSubscriber(service);
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
    const fake: FoxServiceLike = {
      subscribe: (spec, options) => {
        expect(spec).toEqual(SPEC);
        captured = options;
        return unsubscribe;
      },
    };

    const onResult = vi.fn();
    const onError = vi.fn();
    const stop = createFoxFormulaSubscriber(fake).subscribe(SPEC, {
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
    const fake: FoxServiceLike = {
      subscribe: (_spec, options) => {
        deliver = options.onResult as (data: { kind: string; scalar: unknown }) => void;
        return () => {};
      },
    };
    const onResult = vi.fn();
    createFoxFormulaSubscriber(fake).subscribe(SPEC, { onResult });

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
});
