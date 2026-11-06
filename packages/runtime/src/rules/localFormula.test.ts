// Local (loc://) formula evaluation: the WS2 tab-selector chain — rules whose
// inputs are page locals must evaluate without the Formula Engine.
import { describe, expect, it, vi } from 'vitest';
import type { Rule } from '@slaclab/canopy-screen-ir';
import { compileRule } from './compileRule.js';
import { FormulaError } from '../formula.js';
import { createLocalAwareFormulaSubscriber } from './localFormula.js';
import { evaluatePyExpr, PyExprError } from './pyExpr.js';
import type { FormulaSpec, FormulaSubscriber } from '../formula.js';

// ── pyExpr: the compileRule output grammar ──────────────────────────────────

function ev(expression: string, bindings: Record<string, number | string | boolean> = {}) {
  return evaluatePyExpr(expression, new Map(Object.entries(bindings)));
}

describe('evaluatePyExpr', () => {
  it('evaluates the arm-index ladder compileRule emits', () => {
    const ladder = '0 if (({0} >= 1.0) and ({0} < 2.0)) else (-1)';
    expect(ev(ladder, { '0': 1 })).toBe(0);
    expect(ev(ladder, { '0': 2 })).toBe(-1);
  });

  it('evaluates nested conditionals right-associatively', () => {
    const expr = '2 if ({A} == 1) else (4 if ({A} == 2) else (0))';
    expect(ev(expr, { A: 1 })).toBe(2);
    expect(ev(expr, { A: 2 })).toBe(4);
    expect(ev(expr, { A: 7 })).toBe(0);
  });

  it('handles inlined formula sums over namespaced tokens', () => {
    // What compileRule produces when a rule pv references formula://sum (A+B).
    const expr = 'True if (({sum.A} + {sum.B}) != 0) else (False)';
    expect(ev(expr, { 'sum.A': 0, 'sum.B': 0 })).toBe(false);
    expect(ev(expr, { 'sum.A': 1, 'sum.B': 0 })).toBe(true);
  });

  it('supports the math function namespace', () => {
    expect(ev('max({A}, {B})', { A: 3, B: 9 })).toBe(9);
    expect(ev('floor(2.9) + abs(-1)')).toBe(3);
    expect(ev('sqrt(16) ** 2')).toBe(16);
  });

  it('supports arithmetic precedence, %, //, comparisons, strings', () => {
    expect(ev('1 + 2 * 3')).toBe(7);
    expect(ev('7 // 2')).toBe(3);
    expect(ev('7 % 2')).toBe(1);
    expect(ev('"on" if ({A} > 0.5) else "off"', { A: 1 })).toBe('on');
    expect(ev("'a' + 'b'")).toBe('ab');
  });

  it('rejects out-of-subset input', () => {
    expect(() => ev('__import__("os")')).toThrow(PyExprError);
    expect(() => ev('{missing}')).toThrow(PyExprError);
    expect(() => ev('lambda: 1')).toThrow(PyExprError);
  });
});

// ── local-aware subscriber routing ──────────────────────────────────────────

class FakeLocalPV {
  private listeners = new Map<string, Set<(d: { value: unknown; connected: boolean }) => void>>();
  private values = new Map<string, number | string>();
  private links = new Map<string, boolean>();

  subscribe(name: string, listener: (d: { value: unknown; connected: boolean }) => void) {
    const key = name.split('?')[0]!;
    if (!this.listeners.has(key)) this.listeners.set(key, new Set());
    this.listeners.get(key)!.add(listener);
    listener({ value: this.values.get(key) ?? 0, connected: this.links.get(key) ?? true });
    return () => this.listeners.get(key)!.delete(listener);
  }

  put(name: string, value: number | string) {
    const key = name.split('?')[0]!;
    this.values.set(key, value);
    this.emit(key);
  }

  /** Set the link state; delivers a snapshot to current listeners. */
  link(name: string, connected: boolean) {
    const key = name.split('?')[0]!;
    this.links.set(key, connected);
    this.emit(key);
  }

  private emit(key: string) {
    for (const listener of this.listeners.get(key) ?? []) {
      listener({ value: this.values.get(key) ?? 0, connected: this.links.get(key) ?? true });
    }
  }
}

const spec = (expression: string, bindings: Record<string, string>): FormulaSpec => ({
  kind: 'scalar',
  expression,
  bindings,
});

describe('createLocalAwareFormulaSubscriber', () => {
  it('evaluates loc-only specs locally and re-emits on local writes', () => {
    const local = new FakeLocalPV();
    const subscriber = createLocalAwareFormulaSubscriber(local, null);
    const results: unknown[] = [];
    subscriber.subscribe(
      spec('True if (({0} + {1}) != 0) else (False)', {
        '0': 'loc://${!W}posVis?type=int&init=0',
        '1': 'loc://${!W}ctlVis?type=int&init=0',
      }),
      { onResult: (v) => results.push(v) }
    );
    expect(results).toEqual([false]);
    local.put('loc://${!W}posVis', 1);
    expect(results).toEqual([false, true]);
  });

  it('evaluates a compiled loc:// rule ladder to its arm index (never the arm)', () => {
    const local = new FakeLocalPV();
    const subscriber = createLocalAwareFormulaSubscriber(local, null);
    const compiled = compileRule(
      {
        id: 'r-tab',
        name: 'tab color',
        targetProperty: 'backgroundColor',
        default: { $role: 'Display_Background', fallback: '#202020' },
        pvs: [{ name: 'loc://${!W}tab?type=int&init=0', trigger: true }],
        conditions: [
          { expression: '{0} == 1', value: { $role: 'OK', fallback: '#00ff00' } },
          { expression: '{0} == 2', value: '#ffff00' },
        ],
      } as Rule,
      [],
      {}
    );
    if (compiled.kind !== 'ladder') throw new Error('expected a ladder');
    const results: unknown[] = [];
    subscriber.subscribe(compiled.spec, { onResult: (v) => results.push(v) });
    expect(results).toEqual([-1]);
    local.put('loc://${!W}tab', 1);
    local.put('loc://${!W}tab', 2);
    local.put('loc://${!W}tab', 9);
    expect(results).toEqual([-1, 0, 1, -1]);
  });

  it('delegates non-local specs to the wrapped subscriber', () => {
    const local = new FakeLocalPV();
    const formulaEngine: FormulaSubscriber = { subscribe: vi.fn(() => () => {}) };
    const subscriber = createLocalAwareFormulaSubscriber(local, formulaEngine);
    subscriber.subscribe(spec('{0} + 1', { '0': 'DEV:X' }), { onResult: () => {} });
    expect(formulaEngine.subscribe).toHaveBeenCalledTimes(1);
  });

  it('reports mixed local/gateway specs as errors', () => {
    const local = new FakeLocalPV();
    const formulaEngine: FormulaSubscriber = { subscribe: vi.fn(() => () => {}) };
    const subscriber = createLocalAwareFormulaSubscriber(local, formulaEngine);
    const onError = vi.fn();
    subscriber.subscribe(spec('{0} + {1}', { '0': 'loc://a', '1': 'DEV:X' }), {
      onResult: () => {},
      onError,
    });
    expect(onError).toHaveBeenCalled();
    expect(formulaEngine.subscribe).not.toHaveBeenCalled();
  });
});

describe('local formula: a dropped input is a retryable error', () => {
  const SUM = spec('{0} + {1}', { '0': 'loc://a', '1': 'loc://b' });

  it('reports nothing for inputs that start disconnected (initial deliveries at mount)', () => {
    const local = new FakeLocalPV();
    local.link('loc://a', false);
    const subscriber = createLocalAwareFormulaSubscriber(local, null);
    const onResult = vi.fn();
    const onError = vi.fn();
    subscriber.subscribe(SUM, { onResult, onError });
    expect(onError).not.toHaveBeenCalled();
    expect(onResult).not.toHaveBeenCalled();
    // A repeated disconnected snapshot before any connection is still initial.
    local.link('loc://a', false);
    expect(onError).not.toHaveBeenCalled();
    // First connection: the first result, no error.
    local.put('loc://a', 2);
    local.link('loc://a', true);
    expect(onResult).toHaveBeenCalledWith(2);
    expect(onError).not.toHaveBeenCalled();
  });

  it('reports a retryable input_disconnected once when a connected input drops', () => {
    const local = new FakeLocalPV();
    const subscriber = createLocalAwareFormulaSubscriber(local, null);
    const onResult = vi.fn();
    const onError = vi.fn();
    subscriber.subscribe(SUM, { onResult, onError });
    expect(onResult).toHaveBeenCalledTimes(1);

    local.link('loc://b', false);
    expect(onError).toHaveBeenCalledTimes(1);
    const error = onError.mock.calls[0]![0] as FormulaError;
    expect(error).toBeInstanceOf(FormulaError);
    expect(error.code).toBe('input_disconnected');
    expect(error.retryable).toBe(true);
    expect(error.message).toContain('loc://b');

    // Further disconnected snapshots of the same drop do not repeat it.
    local.link('loc://b', false);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledTimes(1);
  });

  it('delivers the first result after an error even when equal to the last, then dedupes again', () => {
    const local = new FakeLocalPV();
    const subscriber = createLocalAwareFormulaSubscriber(local, null);
    const results: unknown[] = [];
    const onError = vi.fn();
    subscriber.subscribe(SUM, { onResult: (v) => results.push(v), onError });
    expect(results).toEqual([0]);

    local.link('loc://a', false);
    local.link('loc://a', true);
    // Same value as before the drop: delivered once so stale clears.
    expect(results).toEqual([0, 0]);
    // Back to the normal dedupe.
    local.put('loc://a', 0);
    expect(results).toEqual([0, 0]);
    local.put('loc://a', 5);
    expect(results).toEqual([0, 0, 5]);

    // A second drop and reconnect behaves the same.
    local.link('loc://b', false);
    expect(onError).toHaveBeenCalledTimes(2);
    local.link('loc://b', true);
    expect(results).toEqual([0, 0, 5, 5]);
  });

  it('bypasses the dedupe after an evaluation error too', () => {
    const local = new FakeLocalPV();
    const subscriber = createLocalAwareFormulaSubscriber(local, null);
    const results: unknown[] = [];
    const onError = vi.fn();
    // A string input makes number + string raise in the evaluator.
    subscriber.subscribe(spec('{0} + 1', { '0': 'loc://a' }), {
      onResult: (v) => results.push(v),
      onError,
    });
    expect(results).toEqual([1]);
    local.put('loc://a', 'x');
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]![0] as { retryable?: boolean }).retryable).not.toBe(true);
    local.put('loc://a', 0);
    // Equal to the last result (1), delivered because an error came between.
    expect(results).toEqual([1, 1]);
    local.put('loc://a', 0);
    expect(results).toEqual([1, 1]);
  });
});
