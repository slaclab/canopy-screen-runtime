// ScreenPVService: `fox://` widget channels resolve against the screen's
// formulas (macro-substituted), share one upstream subscription, surface
// value/severity/connected as PVData, reject writes, and degrade to
// disconnected + a warning on anything unresolvable. Other addresses go to
// the parent service untouched.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { AlarmSeverity, DISCONNECTED_PV, MockPVService } from '@slaclab/canopy-client';
import type { PVData } from '@slaclab/canopy-client';
import type { FormulaDeclaration } from '@slaclab/canopy-screen-ir';
import type { FormulaSpec, FormulaSubscribeOptions } from './formula.js';
import { formatFormulaValue, ScreenPVService } from './screenPV.js';

class StubSubscriber {
  readonly subscriptions: { spec: FormulaSpec; options: FormulaSubscribeOptions }[] = [];
  released = 0;

  subscribe(spec: FormulaSpec, options: FormulaSubscribeOptions): () => void {
    this.subscriptions.push({ spec, options });
    return () => {
      this.released += 1;
    };
  }

  get last(): FormulaSubscribeOptions {
    const sub = this.subscriptions.at(-1);
    if (!sub) throw new Error('no formula subscription');
    return sub.options;
  }
}

const FORMULAS: FormulaDeclaration[] = [
  {
    name: 'f-001',
    kind: 'scalar',
    expression: '100*(A-B)/A',
    bindings: { A: '${DEV}:GetActualValueRaw', B: '${DEV}:GetPressSetpointRaw' },
  },
  { name: 'wave', kind: 'waveform', expression: 'A * 2', bindings: { A: 'X:WF' } },
  { name: 'const', expression: '3.14', bindings: {} },
  { name: 'nested', expression: 'A + 1', bindings: { A: 'fox://f-001' } },
];

const MACROS = { DEV: 'DEMO:VAC:GAUGE1' };

let parent: MockPVService;
let stub: StubSubscriber;
let service: ScreenPVService;
let warn: MockInstance<(...args: unknown[]) => void>;

function lastData(listener: ReturnType<typeof vi.fn>): PVData {
  return listener.mock.lastCall![0] as PVData;
}

beforeEach(() => {
  parent = new MockPVService();
  parent.connect();
  stub = new StubSubscriber();
  service = new ScreenPVService(parent, FORMULAS, MACROS, stub);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  parent.disconnect();
  warn.mockRestore();
});

describe('ScreenPVService', () => {
  it('delegates non-formula addresses to the parent service', () => {
    const listener = vi.fn();
    service.subscribe('DEV:PRESSURE', listener);
    expect(listener).toHaveBeenCalled();
    expect(lastData(listener).connected).toBe(true);
    expect(service.getSnapshot('DEV:PRESSURE')).toBe(parent.getSnapshot('DEV:PRESSURE'));
    expect(stub.subscriptions).toHaveLength(0);

    const put = vi.spyOn(parent, 'put');
    service.put('DEV:PRESSURE', 5);
    expect(put).toHaveBeenCalledWith('DEV:PRESSURE', 5);
  });

  it('compiles the named formula with the screen macros and subscribes once', () => {
    const a = vi.fn();
    const b = vi.fn();
    service.subscribe('fox://f-001', a);
    service.subscribe('fox://f-001', b);

    expect(stub.subscriptions).toHaveLength(1);
    expect(stub.subscriptions[0]!.spec).toEqual({
      kind: 'scalar',
      expression: '100*({A}-{B})/{A}',
      bindings: {
        A: 'DEMO:VAC:GAUGE1:GetActualValueRaw',
        B: 'DEMO:VAC:GAUGE1:GetPressSetpointRaw',
      },
    });
    // Delivered synchronously as disconnected until the first result.
    expect(lastData(a)).toEqual(DISCONNECTED_PV);
    expect(lastData(b)).toEqual(DISCONNECTED_PV);
  });

  it('maps results onto PVData: value, display text, severity, connected, timestamp', () => {
    const listener = vi.fn();
    service.subscribe('fox://f-001', listener);

    stub.last.onResult(-1.6175621028307337, { severity: 'MINOR', timestampMs: 1234 });
    expect(lastData(listener)).toMatchObject({
      value: -1.6175621028307337,
      displayValue: '-1.61756',
      severity: AlarmSeverity.MINOR,
      connected: true,
      timestamp: 1234,
    });
    expect(service.getSnapshot('fox://f-001')).toBe(lastData(listener));

    // No metadata (e.g. page-local evaluation): NO_ALARM.
    stub.last.onResult(7);
    expect(lastData(listener)).toMatchObject({
      value: 7,
      displayValue: '7',
      severity: AlarmSeverity.NO_ALARM,
    });
  });

  it('a late subscriber starts from the shared snapshot', () => {
    service.subscribe('fox://f-001', vi.fn());
    stub.last.onResult(42);
    const late = vi.fn();
    service.subscribe('fox://f-001', late);
    expect(late).toHaveBeenCalledTimes(1);
    expect(lastData(late)).toMatchObject({ value: 42, connected: true });
  });

  it('releases the upstream subscription with the last listener', () => {
    const stopA = service.subscribe('fox://f-001', vi.fn());
    const stopB = service.subscribe('fox://f-001', vi.fn());
    stopA();
    expect(stub.released).toBe(0);
    stopB();
    stopB(); // idempotent
    expect(stub.released).toBe(1);
    expect(service.getSnapshot('fox://f-001')).toBeUndefined();

    // Re-subscribing opens a fresh upstream subscription.
    service.subscribe('fox://f-001', vi.fn());
    expect(stub.subscriptions).toHaveLength(2);
  });

  it('ignores results that race the release', () => {
    const listener = vi.fn();
    const stop = service.subscribe('fox://f-001', listener);
    const { onResult } = stub.last;
    stop();
    listener.mockClear();
    onResult(1);
    expect(listener).not.toHaveBeenCalled();
  });

  it('an evaluation error disconnects; a later result reconnects', () => {
    const listener = vi.fn();
    service.subscribe('fox://f-001', listener);
    stub.last.onResult(1.5);

    stub.last.onError?.(new Error('FORMULA_INPUT_MISSING: PVs not available'));
    expect(lastData(listener)).toMatchObject({
      connected: false,
      severity: AlarmSeverity.DISCONNECTED,
    });
    // Recurring identical errors warn once.
    stub.last.onError?.(new Error('FORMULA_INPUT_MISSING: PVs not available'));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("'fox://f-001'");

    stub.last.onResult(2.5);
    expect(lastData(listener)).toMatchObject({ value: 2.5, connected: true });
  });

  it('rejects writes to formula channels', () => {
    const put = vi.spyOn(parent, 'put');
    service.subscribe('fox://f-001', vi.fn());
    service.put('fox://f-001', 3);
    expect(put).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('read-only formula channel'));
  });

  it('unknown formula name: disconnected + warning, no subscription, no throw', () => {
    const listener = vi.fn();
    expect(() => service.subscribe('fox://nope', listener)).not.toThrow();
    expect(lastData(listener)).toEqual(DISCONNECTED_PV);
    expect(stub.subscriptions).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("'nope'"));
  });

  it.each([
    ['fox://wave', 'scalar only'],
    ['fox://const', 'no {token} inputs'],
    ['fox://nested', 'formula-of-formula'],
  ])('%s cannot evaluate: disconnected + warning', (address, reason) => {
    const listener = vi.fn();
    service.subscribe(address, listener);
    expect(lastData(listener)).toEqual(DISCONNECTED_PV);
    expect(stub.subscriptions).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(reason));
  });

  it('without a formula subscriber, formula channels stay disconnected', () => {
    const bare = new ScreenPVService(parent, FORMULAS, MACROS, null);
    const listener = vi.fn();
    bare.subscribe('fox://f-001', listener);
    expect(lastData(listener)).toEqual(DISCONNECTED_PV);
    expect(warn).not.toHaveBeenCalled();
  });

  it('connect/disconnect leave the parent lifecycle alone', () => {
    const disconnect = vi.spyOn(parent, 'disconnect');
    service.disconnect();
    service.connect();
    expect(disconnect).not.toHaveBeenCalled();
    expect(service.isConnected).toBe(true);
  });
});

describe('formatFormulaValue', () => {
  it.each([
    [-1.6175621028307337, '-1.61756'],
    [0.1 + 0.2, '0.3'],
    [42, '42'],
    [1.5e-9, '1.5e-9'],
    [Number.NaN, 'NaN'],
    [true, 'true'],
    ['ON', 'ON'],
  ])('%s -> %s', (value, text) => {
    expect(formatFormulaValue(value)).toBe(text);
  });
});
