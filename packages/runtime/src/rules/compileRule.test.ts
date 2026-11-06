// Golden tests for the Rule → Formula Engine FormulaSpec compiler.
//
// Each case pins the EXACT compiled spec — expression string and bindings —
// so any change to the encoding (ladder shape, arm indexing, token naming,
// macro resolution) shows up as a diff here, reviewed on purpose. A ladder
// evaluates to an ARM INDEX (-1 = default); the raw arms ride alongside.

import { describe, expect, it } from 'vitest';
import type { ColorRole, FormulaDeclaration, Rule } from '@slaclab/canopy-screen-ir';
import {
  compileFormulaSpec,
  compileRule,
  DEFAULT_ARM,
  ladderExpression,
  RuleCompileError,
  toWireExpression,
} from './compileRule.js';

const MACROS = { P: 'DEV:1', PREFIX: 'DEMO:VAC1' } as const;

const FORMULAS: readonly FormulaDeclaration[] = [
  {
    name: 'sum',
    kind: 'scalar',
    expression: 'A+B',
    bindings: { A: '${P}:VAL', B: '${P}:OFFSET' },
  },
  {
    name: 'f-001',
    expression: 'A + B',
    bindings: { A: '${P}:V1', B: '${P}:V2' },
  },
];

function conditional(partial: Partial<Rule> & Pick<Rule, 'targetProperty' | 'default'>): Rule {
  return {
    id: 'r-test',
    name: 'test rule',
    pvs: [],
    conditions: [],
    ...partial,
  } as Rule;
}

describe('compileRule — conditional arm goldens', () => {
  it('compiles a single-condition boolean rule with macro-resolved pv names', () => {
    // vacuum-system.screen.json r-001.
    const rule = conditional({
      targetProperty: 'alarmBorder',
      pvs: [{ name: '${PREFIX}:STATUS:SEV', trigger: true }],
      conditions: [{ expression: '{0} > 1', value: true }],
      default: false,
    });

    expect(compileRule(rule, [], MACROS)).toEqual({
      kind: 'ladder',
      targetProperty: 'alarmBorder',
      spec: {
        kind: 'scalar',
        expression: '0 if ({0} > 1) else (-1)',
        bindings: { '0': 'DEMO:VAC1:STATUS:SEV' },
      },
      values: [true],
      default: false,
    });
  });

  it('compiles a multi-condition ladder, first truthy wins, string values', () => {
    // simple.screen.json r-001 (color-by-alarm) with its formula://sum inlined.
    const rule = conditional({
      targetProperty: 'foregroundColor',
      default: '#ffffff',
      pvs: [
        { name: '${P}:SEVR', trigger: true },
        { name: 'formula://sum', trigger: true },
      ],
      conditions: [
        { expression: '{0} > 1', value: '#ff0000' },
        { expression: '{1} > 100', value: '#ffff00' },
      ],
    });

    expect(compileRule(rule, FORMULAS, MACROS)).toEqual({
      kind: 'ladder',
      targetProperty: 'foregroundColor',
      spec: {
        kind: 'scalar',
        expression: '0 if ({0} > 1) else (1 if (({sum.A}+{sum.B}) > 100) else (-1))',
        bindings: {
          '0': 'DEV:1:SEVR',
          'sum.A': 'DEV:1:VAL',
          'sum.B': 'DEV:1:OFFSET',
        },
      },
      values: ['#ff0000', '#ffff00'],
      default: '#ffffff',
    });
  });

  it('keeps ColorRole arms raw and by reference; the spec never sees a color', () => {
    const major: ColorRole = { $role: 'MAJOR', fallback: '#ff0000' };
    const text: ColorRole = { $role: 'Text', fallback: '#000000', fallbackDark: '#ffffff' };
    const rule = conditional({
      targetProperty: 'foregroundColor',
      default: text,
      pvs: [{ name: '${P}:SEVR', trigger: true }],
      conditions: [
        { expression: '{0} > 1', value: major },
        { expression: '{0} > 0', value: '#ffff00' },
      ],
    });

    const compiled = compileRule(rule, [], MACROS);
    expect(compiled).toEqual({
      kind: 'ladder',
      targetProperty: 'foregroundColor',
      spec: {
        kind: 'scalar',
        expression: '0 if ({0} > 1) else (1 if ({0} > 0) else (-1))',
        bindings: { '0': 'DEV:1:SEVR' },
      },
      values: [major, '#ffff00'],
      default: text,
    });
    if (compiled.kind !== 'ladder') throw new Error('expected a ladder');
    expect(compiled.values[0]).toBe(major);
    expect(compiled.default).toBe(text);
    expect(compiled.spec.expression).not.toContain('#');
  });

  it('inlines a formula:// binding used against a plain pv (formula-driven r-002)', () => {
    const rule = conditional({
      targetProperty: 'visible',
      default: true,
      pvs: [
        { name: 'formula://f-001', trigger: true },
        { name: '${P}:THRESHOLD', trigger: true },
      ],
      conditions: [{ expression: '{0} > {1}', value: false }],
    });

    expect(compileRule(rule, FORMULAS, MACROS)).toEqual({
      kind: 'ladder',
      targetProperty: 'visible',
      spec: {
        kind: 'scalar',
        expression: '0 if (({f-001.A} + {f-001.B}) > {1}) else (-1)',
        bindings: {
          '1': 'DEV:1:THRESHOLD',
          'f-001.A': 'DEV:1:V1',
          'f-001.B': 'DEV:1:V2',
        },
      },
      values: [false],
      default: true,
    });
  });

  it('resolves legacy $(NAME) macros and keeps numeric/null arms raw', () => {
    const rule = conditional({
      targetProperty: 'precision',
      default: null,
      pvs: [{ name: '$(P):RES', trigger: true }],
      conditions: [{ expression: '{0} >= 0 && {0} < 10', value: 3 }],
    });

    expect(compileRule(rule, [], MACROS)).toEqual({
      kind: 'ladder',
      targetProperty: 'precision',
      spec: {
        kind: 'scalar',
        // The Formula Engine itself normalizes && to `and` (parser _BOOL_REPLACEMENTS);
        // conditions pass through verbatim.
        expression: '0 if ({0} >= 0 && {0} < 10) else (-1)',
        bindings: { '0': 'DEV:1:RES' },
      },
      values: [3],
      default: null,
    });
  });

  it('drops trigger-only bindings never referenced by a condition (the Formula Engine rejects unused bindings)', () => {
    const rule = conditional({
      targetProperty: 'text',
      default: 'idle',
      pvs: [
        { name: 'DEV:STATE', trigger: true },
        { name: 'DEV:HEARTBEAT', trigger: true }, // never referenced
      ],
      conditions: [{ expression: '{0} == 1', value: 'running' }],
    });

    expect(compileRule(rule, [], {})).toEqual({
      kind: 'ladder',
      targetProperty: 'text',
      spec: {
        kind: 'scalar',
        expression: '0 if ({0} == 1) else (-1)',
        bindings: { '0': 'DEV:STATE' },
      },
      values: ['running'],
      default: 'idle',
    });
  });

  it('compiles a default-only rule (no conditions) to a static value', () => {
    const rule = conditional({
      targetProperty: 'fontSize',
      default: 14,
      pvs: [{ name: 'DEV:UNUSED', trigger: true }],
      conditions: [],
    });

    expect(compileRule(rule, [], {})).toEqual({
      kind: 'static',
      targetProperty: 'fontSize',
      value: 14,
    });
  });

  it('keeps a ColorRole default raw on the static path (resolved later, by the hook)', () => {
    const role: ColorRole = { $role: 'MAJOR', fallback: '#ff0000' };
    const rule = conditional({ targetProperty: 'foregroundColor', default: role });
    const compiled = compileRule(rule, [], {});
    expect(compiled).toEqual({ kind: 'static', targetProperty: 'foregroundColor', value: role });
    if (compiled.kind !== 'static') throw new Error('expected static');
    expect(compiled.value).toBe(role);
  });

  it('constant-folds to a raw ColorRole arm, not its fallback', () => {
    const ok: ColorRole = { $role: 'OK', fallback: '#00ff00' };
    const rule = conditional({
      targetProperty: 'backgroundColor',
      default: '#ffffff',
      pvs: [],
      conditions: [{ expression: '1 > 0', value: ok }],
    });
    const compiled = compileRule(rule, [], {});
    expect(compiled).toEqual({ kind: 'static', targetProperty: 'backgroundColor', value: ok });
    if (compiled.kind !== 'static') throw new Error('expected static');
    expect(compiled.value).toBe(ok);
  });

  it('constant-folds a ladder with no live input to the first truthy arm', () => {
    // No {N} token anywhere: evaluated once at compile time, no subscription.
    const rule = conditional({
      targetProperty: 'label',
      default: 'n/a',
      pvs: [],
      conditions: [
        { expression: '1 < 0', value: 'never' },
        { expression: '1 > 0', value: 'constant' },
      ],
    });

    expect(compileRule(rule, [], {})).toEqual({
      kind: 'static',
      targetProperty: 'label',
      value: 'constant',
    });
  });

  it('rejects a condition referencing a pv index that is not bound', () => {
    const rule = conditional({
      targetProperty: 'visible',
      default: true,
      pvs: [{ name: 'DEV:A', trigger: true }],
      conditions: [{ expression: '{1} > 0', value: false }],
    });
    expect(() => compileRule(rule, [], {})).toThrow(RuleCompileError);
  });

  it('rejects a non-{N} condition token', () => {
    const rule = conditional({
      targetProperty: 'visible',
      default: true,
      pvs: [{ name: 'DEV:A', trigger: true }],
      conditions: [{ expression: '{A} > 0', value: false }],
    });
    expect(() => compileRule(rule, [], {})).toThrow(RuleCompileError);
  });

  it('rejects a dangling formula:// pv binding', () => {
    const rule = conditional({
      targetProperty: 'visible',
      default: true,
      pvs: [{ name: 'formula://nope', trigger: true }],
      conditions: [{ expression: '{0} > 0', value: false }],
    });
    expect(() => compileRule(rule, [], {})).toThrow(
      /no formulas\[\] entry declares 'formula:\/\/nope'/
    );
  });
});

describe('compileRule — formula arm goldens', () => {
  it('compiles to the named formula spec directly (tokenized, macro-resolved)', () => {
    const rule: Rule = {
      id: 'r-002',
      name: 'visible-when',
      targetProperty: 'visible',
      default: true,
      formula: 'sum',
    };

    expect(compileRule(rule, FORMULAS, MACROS)).toEqual({
      kind: 'formula',
      targetProperty: 'visible',
      spec: {
        kind: 'scalar',
        expression: '{A}+{B}',
        bindings: { A: 'DEV:1:VAL', B: 'DEV:1:OFFSET' },
      },
    });
  });

  it('honors a non-scalar formula kind and tolerates the formula:// prefix', () => {
    const formulas: FormulaDeclaration[] = [
      { name: 'wave', kind: 'waveform', expression: 'W * 2', bindings: { W: 'DEV:WAVE' } },
    ];
    const rule: Rule = {
      id: 'r-w',
      name: 'waveform rule',
      targetProperty: 'points',
      default: null,
      formula: 'formula://wave',
    };

    expect(compileRule(rule, formulas, {})).toEqual({
      kind: 'formula',
      targetProperty: 'points',
      spec: { kind: 'waveform', expression: '{W} * 2', bindings: { W: 'DEV:WAVE' } },
    });
  });

  it('rejects a formula name with no declaration', () => {
    const rule: Rule = {
      id: 'r-x',
      name: 'dangling',
      targetProperty: 'visible',
      default: true,
      formula: 'missing',
    };
    expect(() => compileRule(rule, FORMULAS, {})).toThrow(RuleCompileError);
  });
});

describe('compileFormulaSpec', () => {
  it('drops declared-but-unused bindings (the Formula Engine rejects extras)', () => {
    const spec = compileFormulaSpec(
      { name: 'f', expression: 'A * 2', bindings: { A: 'DEV:A', B: 'DEV:B' } },
      {}
    );
    expect(spec).toEqual({ kind: 'scalar', expression: '{A} * 2', bindings: { A: 'DEV:A' } });
  });

  it('rejects a formula with no tokens at all', () => {
    expect(() => compileFormulaSpec({ name: 'f', expression: '1 + 2' }, {})).toThrow(
      RuleCompileError
    );
  });

  it('rejects a wire-form expression with unbound tokens', () => {
    expect(() =>
      compileFormulaSpec({ name: 'f', expression: '{A} + {C}', bindings: { A: 'DEV:A' } }, {})
    ).toThrow(/unbound token/);
  });

  it('binds the only token of a wire-form expression', () => {
    const spec = compileFormulaSpec(
      { name: 'f', expression: '242 - clip({g}, 0, 60)', bindings: { g: 'SR:ID:07:GAP' } },
      {}
    );
    expect(spec.bindings).toEqual({ g: 'SR:ID:07:GAP' });
  });

  it('binds every token of a wire-form expression, the first included', () => {
    const spec = compileFormulaSpec(
      { name: 'f', expression: '{a} + {b}', bindings: { a: 'DEV:A', b: 'DEV:B' } },
      {}
    );
    expect(spec.bindings).toEqual({ a: 'DEV:A', b: 'DEV:B' });
  });

  it('rejects an unbound first token of a wire-form expression', () => {
    expect(() =>
      compileFormulaSpec({ name: 'f', expression: '{C} + {A}', bindings: { A: 'DEV:A' } }, {})
    ).toThrow(/unbound token\(s\): C/);
  });
});

describe('ladderExpression', () => {
  it('nests conditions inside-out with the default arm at the tail', () => {
    expect(ladderExpression([])).toBe(String(DEFAULT_ARM));
    expect(ladderExpression(['{0} > 1'])).toBe('0 if ({0} > 1) else (-1)');
    expect(ladderExpression(['a', 'b', 'c'])).toBe(
      '0 if (a) else (1 if (b) else (2 if (c) else (-1)))'
    );
  });
});

describe('toWireExpression', () => {
  it('wraps standalone binding names in braces', () => {
    expect(toWireExpression('A + B * 2', ['A', 'B'])).toBe('{A} + {B} * 2');
  });

  it('does not split longer identifiers or function names', () => {
    expect(toWireExpression('AB + A + sqrt(A)', ['A', 'AB'])).toBe('{AB} + {A} + sqrt({A})');
  });

  it('passes an already-tokenized expression through untouched', () => {
    expect(toWireExpression('{A} + {B}', ['A', 'B'])).toBe('{A} + {B}');
  });

  it('handles multi-character keys longest-first', () => {
    expect(toWireExpression('mean(VAL, VAL2)', ['VAL', 'VAL2'])).toBe('mean({VAL}, {VAL2})');
  });
});

describe('compileRule — macro substitution in conditions', () => {
  const ladder = (macros: Record<string, string>) =>
    compileRule(
      conditional({
        targetProperty: 'background',
        default: 'grey',
        pvs: [{ name: '${P}:STAT', trigger: true }],
        conditions: [
          { expression: '${CODE} == 1', value: 'green' },
          { expression: '$(CODE) == 2', value: 'red' },
        ],
      }),
      [],
      macros
    );

  it('folds a macro-only ladder to the arm its macro value selects', () => {
    expect(ladder({ P: 'DEV:1', CODE: '1' })).toEqual({
      kind: 'static',
      targetProperty: 'background',
      value: 'green',
    });
    expect(ladder({ P: 'DEV:1', CODE: '2' })).toEqual({
      kind: 'static',
      targetProperty: 'background',
      value: 'red',
    });
  });

  it('folds a macro-only ladder to its default when no arm matches', () => {
    expect(ladder({ P: 'DEV:1', CODE: '7' })).toEqual({
      kind: 'static',
      targetProperty: 'background',
      value: 'grey',
    });
  });

  it('folds boolean-operator spellings the Formula Engine would normalize', () => {
    const rule = conditional({
      targetProperty: 'visible',
      default: false,
      pvs: [],
      conditions: [{ expression: '${A} == 1 && !(${B} == 1)', value: true }],
    });
    expect(compileRule(rule, [], { A: '1', B: '0' })).toEqual({
      kind: 'static',
      targetProperty: 'visible',
      value: true,
    });
  });

  it('substitutes macros in a mixed condition and keeps its {N} tokens live', () => {
    const rule = conditional({
      targetProperty: 'alarmBorder',
      default: false,
      pvs: [{ name: '${P}:SEV', trigger: true }],
      conditions: [{ expression: '{0} > ${LIMIT}', value: true }],
    });
    expect(compileRule(rule, [], { P: 'DEV:1', LIMIT: '3' })).toEqual({
      kind: 'ladder',
      targetProperty: 'alarmBorder',
      spec: {
        kind: 'scalar',
        expression: '0 if ({0} > 3) else (-1)',
        bindings: { '0': 'DEV:1:SEV' },
      },
      values: [true],
      default: false,
    });
  });

  it('leaves an unresolved macro verbatim in a live condition', () => {
    const rule = conditional({
      targetProperty: 'alarmBorder',
      default: false,
      pvs: [{ name: 'DEV:SEV', trigger: true }],
      conditions: [{ expression: '{0} > ${LIMIT}', value: true }],
    });
    expect(compileRule(rule, [], {})).toEqual({
      kind: 'ladder',
      targetProperty: 'alarmBorder',
      spec: {
        kind: 'scalar',
        expression: '0 if ({0} > ${LIMIT}) else (-1)',
        bindings: { '0': 'DEV:SEV' },
      },
      values: [true],
      default: false,
    });
  });

  it('falls to the default when a macro-only condition has an unresolved macro', () => {
    expect(ladder({ P: 'DEV:1' })).toEqual({
      kind: 'static',
      targetProperty: 'background',
      value: 'grey',
    });
  });
});
