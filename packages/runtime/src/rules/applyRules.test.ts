// Precedence and composition: base props < rule output; `visible` ANDs.

import { describe, expect, it, vi } from 'vitest';
import type { Rule } from '@slaclab/canopy-screen-ir';
import { applyRuleOutputs } from './applyRules.js';

const GEOM = { x: 10, y: 20, width: 100, height: 30 };

function rule(targetProperty: string, name = `rule:${targetProperty}`): Rule {
  return { id: name, name, targetProperty, default: null, pvs: [], conditions: [] };
}

describe('applyRuleOutputs', () => {
  it('keeps base props/geometry with no rules', () => {
    const out = applyRuleOutputs({ text: 'hi' }, GEOM, undefined, []);
    expect(out).toEqual({ props: { text: 'hi' }, geometry: GEOM, visible: true });
  });

  it('rule output overrides the base prop (base < rule)', () => {
    const out = applyRuleOutputs(
      { foregroundColor: '#ffffff' },
      GEOM,
      [rule('foregroundColor')],
      ['#ff0000']
    );
    expect(out.props.foregroundColor).toBe('#ff0000');
  });

  it('pending outputs (undefined) leave base values untouched', () => {
    const out = applyRuleOutputs(
      { foregroundColor: '#ffffff' },
      GEOM,
      [rule('foregroundColor')],
      [undefined]
    );
    expect(out.props.foregroundColor).toBe('#ffffff');
  });

  it('a later rule on the same target wins', () => {
    const out = applyRuleOutputs(
      {},
      GEOM,
      [rule('label', 'first'), rule('label', 'second')],
      ['a', 'b']
    );
    expect(out.props.label).toBe('b');
  });

  it('visible composes by AND across base and every rule', () => {
    const rules = [rule('visible', 'v1'), rule('visible', 'v2')];
    expect(applyRuleOutputs({}, GEOM, rules, [true, true]).visible).toBe(true);
    expect(applyRuleOutputs({}, GEOM, rules, [true, false]).visible).toBe(false);
    expect(applyRuleOutputs({ visible: false }, GEOM, rules, [true, true]).visible).toBe(false);
    // Numeric truthiness from the Formula Engine (1/0) coerces.
    expect(applyRuleOutputs({}, GEOM, rules, [1, 1]).visible).toBe(true);
    expect(applyRuleOutputs({}, GEOM, rules, [1, 0]).visible).toBe(false);
  });

  it('geometry targets patch geometry, not props', () => {
    const out = applyRuleOutputs({}, GEOM, [rule('width')], [250]);
    expect(out.geometry).toEqual({ ...GEOM, width: 250 });
    expect(out.props.width).toBeUndefined();
  });

  it('coerces numeric strings for geometry and drops non-numeric ones', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(applyRuleOutputs({}, GEOM, [rule('width')], ['320']).geometry.width).toBe(320);
    expect(applyRuleOutputs({}, GEOM, [rule('width')], ['wide']).geometry.width).toBe(100);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('type-checks outputs against the base prop where feasible', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // number base + numeric string → coerced
    expect(
      applyRuleOutputs({ precision: 2 }, GEOM, [rule('precision')], ['4']).props.precision
    ).toBe(4);
    // boolean base + number → truthiness
    expect(applyRuleOutputs({ fill: false }, GEOM, [rule('fill')], [1]).props.fill).toBe(true);
    // string base + number → stringified
    expect(applyRuleOutputs({ label: 'x' }, GEOM, [rule('label')], [7]).props.label).toBe('7');
    // number base + garbage string → dropped with a warning
    expect(
      applyRuleOutputs({ precision: 2 }, GEOM, [rule('precision')], ['nope']).props.precision
    ).toBe(2);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
