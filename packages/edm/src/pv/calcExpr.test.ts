import { describe, expect, it } from 'vitest';
import { CalcError, compileCalc, performCalc } from './calcExpr.js';

const calc = (expr: string, args: number[] = [], prev = 0) =>
  performCalc(compileCalc(expr), [...args], prev);

describe('EPICS calc expressions', () => {
  it('evaluates arithmetic with EPICS precedence', () => {
    expect(calc('A+B*C', [1, 2, 3])).toBe(7);
    expect(calc('(A+B)*C', [1, 2, 3])).toBe(9);
    expect(calc('100*(A-B)/A', [4, 1])).toBe(75);
    expect(calc('A**2', [3])).toBe(9);
    expect(calc('2^3^2')).toBe(64); // left-associative, as in EPICS
    expect(calc('-A+1', [5])).toBe(-4);
    expect(calc('7%3')).toBe(1);
    expect(calc('A%0', [7])).toBeNaN();
    expect(calc('1.5e2+.5')).toBe(150.5);
    expect(calc('0x10+1')).toBe(17);
  });

  it('evaluates relational, logical and bitwise operators', () => {
    expect(calc('A=1?2:(A=2?4:0)', [1])).toBe(2);
    expect(calc('A=1?2:(A=2?4:0)', [2])).toBe(4);
    expect(calc('A=1?2:(A=2?4:0)', [9])).toBe(0);
    expect(calc('A#B', [1, 2])).toBe(1);
    expect(calc('A>=3&&A<4', [3.5])).toBe(1);
    expect(calc('A||B', [0, 0])).toBe(0);
    expect(calc('!A', [0])).toBe(1);
    expect(calc('A&6', [12])).toBe(4);
    expect(calc('A|1', [4])).toBe(5);
    expect(calc('A XOR B', [6, 3])).toBe(5);
    expect(calc('~A', [0])).toBe(-1);
    expect(calc('A<<2', [3])).toBe(12);
    expect(calc('A>>1', [-8])).toBe(-4);
    expect(calc('A>>>28', [-1])).toBe(15);
  });

  it('evaluates functions, varargs and constants', () => {
    expect(calc('MAX(A,B,C,D)', [1, 7, 3, 2])).toBe(7);
    expect(calc('MIN(A,B)', [1, 7])).toBe(1);
    expect(calc('max(a,b)', [1, 7])).toBe(7);
    expect(calc('ABS(A)+SQRT(B)', [-2, 9])).toBe(5);
    expect(calc('NINT(A)', [2.5])).toBe(3);
    expect(calc('NINT(A)', [-2.5])).toBe(-3);
    expect(calc('ATAN2(A,B)', [1, 0])).toBe(Math.atan2(0, 1));
    expect(calc('ISNAN(A,B)', [1, NaN])).toBe(1);
    expect(calc('FINITE(A,B)', [1, Infinity])).toBe(0);
    expect(calc('PI*R2D')).toBeCloseTo(180);
    expect(calc('LOG(A)+LN(EXP(B))', [100, 2])).toBeCloseTo(4);
    expect(calc('VAL+1', [], 41)).toBe(42);
  });

  it('runs stores and multiple statements', () => {
    expect(calc('B:=A*2; B+1', [5])).toBe(11);
    const args = [3, 0];
    performCalc(compileCalc('B:=A+1; B'), args);
    expect(args[1]).toBe(4);
  });

  it('rejects malformed expressions', () => {
    for (const bad of ['', 'A+', '(A', 'A)', 'A?B', 'A B', 'FOO(A)', 'MAX()', '1:=A']) {
      expect(() => compileCalc(bad), bad).toThrow(CalcError);
    }
  });
});
