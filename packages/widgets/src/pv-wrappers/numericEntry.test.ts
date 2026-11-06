import { describe, expect, it } from 'vitest';
import { EMPTY_ENTRY_MESSAGE, NOT_A_NUMBER_MESSAGE, parseNumericEntry } from './numericEntry.js';

describe('parseNumericEntry', () => {
  it.each([
    ['0.5', 0.5],
    ['-0.3', -0.3],
    ['1e3', 1000],
    ['  12 ', 12],
    ['0x10', 16],
    ['5000', 5000],
  ])('accepts %j as %d', (text, value) => {
    expect(parseNumericEntry(text)).toEqual({ ok: true, value });
  });

  it.each(['', '   '])('refuses %j as empty', (text) => {
    expect(parseNumericEntry(text)).toEqual({
      ok: false,
      reason: 'empty',
      message: EMPTY_ENTRY_MESSAGE,
    });
  });

  it.each(['abc', '12abc', '1,5', 'Infinity', 'NaN', '--1'])(
    'refuses %j as not a number',
    (text) => {
      expect(parseNumericEntry(text)).toEqual({
        ok: false,
        reason: 'not_a_number',
        message: NOT_A_NUMBER_MESSAGE,
      });
    }
  );
});
