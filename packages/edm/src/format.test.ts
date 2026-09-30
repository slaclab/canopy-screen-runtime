import { describe, expect, it } from 'vitest';
import {
  cFormat,
  cvtDoubleToExpString,
  cvtDoubleToString,
  cvtLongToHexString,
  expNotation,
} from './format.js';
import { expandMacros, parseMacroString } from './macros.js';

describe('cvtDoubleToString (EPICS cvtFast)', () => {
  it('rounds half up in fixed point', () => {
    expect(cvtDoubleToString(9.77, 2)).toBe('9.77');
    expect(cvtDoubleToString(1.435, 3)).toBe('1.435');
    expect(cvtDoubleToString(0.125, 2)).toBe('0.13');
    expect(cvtDoubleToString(-2.5, 0)).toBe('-3');
    expect(cvtDoubleToString(9.996, 2)).toBe('10.00');
    expect(cvtDoubleToString(5, 0)).toBe('5');
  });

  it('switches to printf for large values and high precision', () => {
    expect(cvtDoubleToString(12345678.9, 5)).toBe('12345678.900');
    expect(cvtDoubleToString(1.5e17, 2)).toBe(' 1.50e+17'); // %9.2e
    expect(cvtDoubleToString(0.5, 9)).toBe(' 5.000000000e-01'); // %16.9e
  });
});

describe('C printf subset', () => {
  it('formats like EDM Text Control format strings', () => {
    expect(cFormat('%.3f', 1.4354)).toBe('1.435');
    expect(cFormat('%4.3g', 8.0273)).toBe('8.03');
    expect(cFormat('%.4g', 1.5e10)).toBe('1.5e+10');
    expect(cFormat('%.2e', 12345)).toBe('1.23e+04');
    expect(cFormat('%-d', 42.7)).toBe('42');
    expect(cFormat('%6d', 42)).toBe('    42');
    expect(cFormat('0x%-X', 255)).toBe('0xFF');
    expect(cFormat('%s', 'abc')).toBe('abc');
  });

  it('prints exponent and engineering notation like EDM', () => {
    expect(cvtDoubleToExpString(9266.4, 3)).toBe('9.266e+03');
    expect(expNotation(0.0092664, 3)).toBe('9.266e-03');
    expect(expNotation(12345, 1)).toBe('12.3e+03');
    expect(cvtLongToHexString(255)).toBe('0xFF');
  });
});

describe('macros', () => {
  it('substitutes $(X) and ${X}, leaving unknown macros literal', () => {
    expect(expandMacros('$(DEV):GET ${DEV}.VAL $(NOPE)', { DEV: 'FEE:VAC' })).toBe(
      'FEE:VAC:GET FEE:VAC.VAL $(NOPE)'
    );
  });

  it('parses symbol strings, keeping commas inside $( )', () => {
    expect(parseMacroString('P=A,R=$(X,Y), Q = 1')).toEqual({ P: 'A', R: '$(X,Y)', Q: '1' });
  });
});
