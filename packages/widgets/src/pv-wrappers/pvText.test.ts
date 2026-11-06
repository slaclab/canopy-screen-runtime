import { describe, expect, it } from 'vitest';
import { displayText, entryText, widgetPrecision } from './pvText.js';

// A connected numeric PV as the SDK delivers it: displayValue already formatted
// with the PV's own precision (here PREC 0, the case that showed 0.05 as "0").
const pv = (over: Partial<Parameters<typeof displayText>[0]> = {}) => ({
  value: 0.05,
  displayValue: '0 mrad',
  units: 'mrad',
  precision: 0,
  enumChoices: undefined,
  ...over,
});

/** A widget that authored `precision` and opted out of the PV's (PyDM's flag). */
const own = (precision: unknown) => ({ precision, precisionFromPV: false });

describe('widgetPrecision', () => {
  it('is the authored precision when precisionFromPV is false', () => {
    expect(widgetPrecision(own(3))).toBe(3);
    expect(widgetPrecision(own(0))).toBe(0);
  });

  it('is undefined unless precisionFromPV is false (the PyDM default)', () => {
    expect(widgetPrecision({ precision: 3 })).toBeUndefined();
    expect(widgetPrecision({ precision: 3, precisionFromPV: true })).toBeUndefined();
  });

  it('is undefined when no usable precision is authored', () => {
    expect(widgetPrecision({ precisionFromPV: false })).toBeUndefined();
    // Phoebus spells "use the PV" as -1.
    expect(widgetPrecision(own(-1))).toBeUndefined();
    expect(widgetPrecision(own(2.5))).toBeUndefined();
    expect(widgetPrecision(own('3'))).toBeUndefined();
    expect(widgetPrecision(own(101))).toBeUndefined();
  });
});

describe('displayText', () => {
  it('formats a number with the authored precision and the PV units', () => {
    expect(displayText(pv(), own(3))).toBe('0.050 mrad');
    expect(displayText(pv({ value: 0.2186, units: '' }), own(3))).toBe('0.219');
  });

  it('is the PV displayValue when the widget leaves the precision to the PV', () => {
    expect(displayText(pv(), {})).toBe('0 mrad');
    expect(displayText(pv(), { precision: 3 })).toBe('0 mrad');
    expect(displayText(pv(), { precision: 3, precisionFromPV: true })).toBe('0 mrad');
  });

  it('leaves an enum label and a non-number alone', () => {
    expect(
      displayText(pv({ value: 1, displayValue: 'On', enumChoices: ['Off', 'On'] }), own(2))
    ).toBe('On');
    expect(displayText(pv({ value: 'idle', displayValue: 'idle' }), own(2))).toBe('idle');
  });
});

describe('entryText', () => {
  it('formats a number with the authored precision, without units', () => {
    expect(entryText(pv(), own(3))).toBe('0.050');
  });

  it('falls back to the PV precision, then the raw value', () => {
    expect(entryText(pv({ precision: 2 }), {})).toBe('0.05');
    expect(entryText(pv({ precision: 0 }), {})).toBe('0.05');
    expect(entryText(pv({ precision: 4 }), { precision: 3 })).toBe('0.0500');
  });

  it('shows an enum label', () => {
    expect(entryText(pv({ value: 1, enumChoices: ['Off', 'On'] }), own(2))).toBe('On');
  });
});
