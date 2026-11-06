// What a numeric PV's text entry parses to. Pure, so the field can show the
// verdict while the operator types and refuse the same draft on Enter.

/** The reason a draft cannot be written, as the field shows it. */
export const EMPTY_ENTRY_MESSAGE = 'Enter a number';
export const NOT_A_NUMBER_MESSAGE = 'Not a number';

export type NumericEntry =
  | { ok: true; value: number }
  | { ok: false; reason: 'empty' | 'not_a_number'; message: string };

/**
 * Parse `text` as the value of a numeric PV: surrounding whitespace is
 * ignored; a sign, a fraction, an exponent (`1e3`) and a hexadecimal literal
 * (`0x10`) are accepted; empty text and anything `Number()` cannot read as a
 * finite number are refused (`12abc`, `abc`, `Infinity`, `NaN`).
 */
export function parseNumericEntry(text: string): NumericEntry {
  const trimmed = text.trim();
  if (trimmed === '') return { ok: false, reason: 'empty', message: EMPTY_ENTRY_MESSAGE };
  const value = Number(trimmed);
  if (!Number.isFinite(value)) {
    return { ok: false, reason: 'not_a_number', message: NOT_A_NUMBER_MESSAGE };
  }
  return { ok: true, value };
}
