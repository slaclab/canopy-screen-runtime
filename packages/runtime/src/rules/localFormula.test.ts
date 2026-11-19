// Local (loc://) formula evaluation: the WS2 tab-selector chain — rules whose
// inputs are page locals must evaluate without the Formula Engine.
import { describe, expect, it, vi } from 'vitest';
import { createLocalAwareFormulaSubscriber } from './localFormula.js';
import { evaluatePyExpr, PyExprError } from './pyExpr.js';
import type { FormulaSpec, FormulaSubscriber } from '../formula.js';

// ── pyExpr: the compileRule output grammar ──────────────────────────────────

function ev(expression: string, bindings: Record<string, number | string | boolean> = {}) {
  return evaluatePyExpr(expression, new Map(Object.entries(bindings)));
}

describe('evaluatePyExpr', () => {
  it('evaluates the visibility ladder compileRule emits', () => {
    const ladder = 'True if (({0} >= 1.0) and ({0} < 2.0)) else (False)';
    expect(ev(ladder, { '0': 1 })).toBe(true);
    expect(ev(ladder, { '0': 2 })).toBe(false);
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
  private values = new Map<string, number>();

  subscribe(name: string, listener: (d: { value: unknown; connected: boolean }) => void) {
    const key = name.split('?')[0]!;
    if (!this.listeners.has(key)) this.listeners.set(key, new Set());
    this.listeners.get(key)!.add(listener);
    listener({ value: this.values.get(key) ?? 0, connected: true });
    return () => this.listeners.get(key)!.delete(listener);
  }

  put(name: string, value: number) {
    const key = name.split('?')[0]!;
    this.values.set(key, value);
    for (const listener of this.listeners.get(key) ?? []) {
      listener({ value, connected: true });
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
