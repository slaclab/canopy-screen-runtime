// Fixture-mode formula evaluation: every FormulaSpec (rule ladders,
// formula-arm rules, formula:// widget channels) evaluates in the page over the
// fixture snapshot, keeping the loc:// routing and the mixed-spec error.
// Rule ladders yield ARM INDEXES (-1 = default); the raw arms stay on the
// compiled rule and are mapped back by useWidgetRules, not here.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalPVService } from '@slaclab/canopy-client';
import type { FormulaDeclaration, Rule } from '@slaclab/canopy-screen-ir';
import type { FormulaScalarValue, FormulaSpec } from '../formula.js';
import { FixturePVService } from '../pv/FixturePVService.js';
import { ScreenPVService } from '../screenPV.js';
import { compileRule } from './compileRule.js';
import { createFixtureFormulaSubscriber } from './fixtureFormulas.js';

const FIXTURE = new FixturePVService({
  pvs: {
    'SYN:P1:SEVR_IN': 2,
    'SYN:P1:MODE': 1,
    'SYN:P1:W1': 3,
    'SYN:P1:W2': 4,
    'SYN:P1:MEM_MAX': 8,
    'SYN:P1:MEM_FREE': 2,
    'SYN:P1:DOWN': { value: 1, connected: false },
  },
});
FIXTURE.connect();

const FORMULAS: readonly FormulaDeclaration[] = [
  { name: 'wsum', kind: 'scalar', expression: 'A + B', bindings: { A: '${P}:W1', B: '${P}:W2' } },
  {
    name: 'f-001',
    kind: 'scalar',
    expression: '{0} / {1} * 100',
    bindings: { '0': '${P}:MEM_MAX', '1': '${P}:MEM_FREE' },
  } as FormulaDeclaration,
];
const MACROS = { P: 'SYN:P1' };

function locals(): LocalPVService {
  const l = new LocalPVService();
  l.connect();
  return l;
}

function run(spec: FormulaSpec, local = locals()) {
  const results: FormulaScalarValue[] = [];
  const errors: Error[] = [];
  const off = createFixtureFormulaSubscriber(local, FIXTURE).subscribe(spec, {
    onResult: (v) => results.push(v),
    onError: (e) => errors.push(e),
  });
  return { results, errors, off };
}

function formulaSpec(rule: Rule): FormulaSpec {
  const compiled = compileRule(rule, FORMULAS, MACROS);
  if (compiled.kind === 'static') throw new Error('expected a live rule');
  return compiled.spec;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createFixtureFormulaSubscriber', () => {
  it('evaluates a conditional rule ladder over fixture values to its arm index', () => {
    const spec = formulaSpec({
      id: 'r-color',
      name: 'color-by-sev',
      targetProperty: 'foregroundColor',
      default: '#ffffff',
      pvs: [{ name: '${P}:SEVR_IN', trigger: true }],
      conditions: [
        { expression: '{0} > 2', value: '#ff0000' },
        { expression: '{0} > 1', value: { $role: 'MINOR', fallback: '#ffaa00' } },
      ],
    } as Rule);
    expect(spec.expression).toBe('0 if ({0} > 2) else (1 if ({0} > 1) else (-1))');
    const { results, errors } = run(spec);
    expect(errors).toEqual([]);
    expect(results).toEqual([1]);
  });

  it('yields -1 (the default arm) when no condition matches', () => {
    const spec = formulaSpec({
      id: 'r-vis',
      name: 'visible-when-off',
      targetProperty: 'visible',
      default: true,
      pvs: [{ name: '${P}:MODE', trigger: true }],
      conditions: [{ expression: '{0} == 0', value: false }],
    } as Rule);
    expect(run(spec).results).toEqual([-1]);
  });

  it('evaluates a formula-arm rule (a screen formula) locally to its scalar, unmapped', () => {
    const spec = formulaSpec({
      id: 'r-width',
      name: 'width-tracks-formula',
      targetProperty: 'width',
      default: 100,
      formula: 'wsum',
    } as Rule);
    expect(run(spec).results).toEqual([7]);
  });

  it('serves formula:// widget channels through ScreenPVService', () => {
    const subscriber = createFixtureFormulaSubscriber(locals(), FIXTURE);
    const channels = new ScreenPVService(FIXTURE, FORMULAS, MACROS, subscriber);
    const listener = vi.fn();
    channels.subscribe('formula://f-001', listener);
    const last = listener.mock.calls.at(-1)![0];
    expect(last).toMatchObject({ value: 400, connected: true });
  });

  it('withholds a result while any input is disconnected', () => {
    const { results, errors } = run({
      kind: 'scalar',
      expression: '{A} + {B}',
      bindings: { A: 'SYN:P1:W1', B: 'SYN:P1:DOWN' },
    });
    expect(results).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('withholds a result for a PV absent from the snapshot', () => {
    const { results } = run({ kind: 'scalar', expression: '{A}', bindings: { A: 'SYN:NOPE' } });
    expect(results).toEqual([]);
  });

  it('reports a PyExprError through onError', () => {
    const { results, errors } = run({
      kind: 'scalar',
      expression: '__import__("os")',
      bindings: { A: 'SYN:P1:W1' },
    });
    expect(results).toEqual([]);
    expect(errors).toHaveLength(1);
  });

  it('still evaluates loc://-only formulas against the screen locals', () => {
    const local = locals();
    local.put('loc://tab', 2);
    const { results } = run(
      { kind: 'scalar', expression: '{T} * 10', bindings: { T: 'loc://tab' } },
      local
    );
    expect(results).toEqual([20]);
  });

  it('keeps the mixed loc:// + gateway error', () => {
    const { results, errors, off } = run({
      kind: 'scalar',
      expression: '{T} + {A}',
      bindings: { T: 'loc://tab', A: 'SYN:P1:W1' },
    });
    expect(results).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/mixes loc:\/\/ locals with gateway channels/);
    expect(() => off()).not.toThrow();
  });

  it('unsubscribes cleanly', () => {
    const { off } = run({ kind: 'scalar', expression: '{A}', bindings: { A: 'SYN:P1:W1' } });
    expect(() => {
      off();
      off();
    }).not.toThrow();
  });
});
