// A pv-label shows the PV at the PV's precision (PyDM's default) unless it
// sets precisionFromPV: false beside an authored `precision`, as a converter
// writes it for a source display that authored one; everything else keeps the
// client's displayValue, which already follows the PV's precision.
import type React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { AlarmSeverity } from '@slaclab/canopy-client';
import type { WidgetRendererProps } from '../registry/WidgetRegistry.js';

// The PV as the client hands it over: `displayValue` is `value` at the PV's own
// precision with the units appended, as HarePVService formats it.
let pvState = {
  connected: true,
  value: 0.05 as number | string,
  precision: 0,
  units: 'mrad',
  enumChoices: undefined as string[] | undefined,
};

vi.mock('@slaclab/canopy-react', () => ({
  usePV: (address?: string) => {
    const bound = !!address;
    const { value, precision, units, enumChoices } = pvState;
    const choice = typeof value === 'number' ? enumChoices?.[value] : undefined;
    const text = choice ?? (typeof value === 'number' ? value.toFixed(precision) : String(value));
    return {
      address: address ?? '',
      connected: bound && pvState.connected,
      value: bound ? value : undefined,
      displayValue: bound ? (units ? `${text} ${units}` : text) : '',
      units,
      precision,
      enumChoices,
      severity: AlarmSeverity.NO_ALARM,
      put: vi.fn(),
    };
  },
}));

const { CarbonPVTextDisplay } = await import('./CarbonWidgets.js');
const { displayText } = await import('./pvText.js');
const Display = CarbonPVTextDisplay as React.FC<WidgetRendererProps>;

afterEach(cleanup);
beforeEach(() => {
  pvState = { connected: true, value: 0.05, precision: 0, units: 'mrad', enumChoices: undefined };
});

const base: WidgetRendererProps = {
  id: 'w-1',
  layout: { x: 0, y: 0, width: 100, height: 24 },
  props: {},
  isSelected: false,
  isEditing: false,
} as unknown as WidgetRendererProps;

function shown(props: Record<string, unknown>): string {
  const { container } = render(<Display {...base} props={props} />);
  return (container.querySelector('.carbon-pv-display__value') as HTMLElement).textContent ?? '';
}

describe('pv-label precision', () => {
  it("precisionFromPV: false lets the screen's precision beat a PV precision of 0", () => {
    expect(shown({ pvName: 'AR03:HCM4:Monitor', precision: 3, precisionFromPV: false })).toBe(
      '0.050 mrad'
    );
  });

  it('a label stating no precision shows the PV at its own precision', () => {
    expect(shown({ pvName: 'AR03:HCM4:Monitor' })).toBe('0 mrad');
  });

  it('a precision without precisionFromPV: false defers to the PV (the PyDM default)', () => {
    expect(shown({ pvName: 'AR03:HCM4:Monitor', precision: 3 })).toBe('0 mrad');
    expect(shown({ pvName: 'AR03:HCM4:Monitor', precision: 3, precisionFromPV: true })).toBe(
      '0 mrad'
    );
  });

  it('precisionFromPV: false also overrides a PV precision above the screen one', () => {
    pvState = { ...pvState, value: 0.2186, precision: 4, units: '' };
    expect(shown({ pvName: 'AR:Tune:X', precision: 2, precisionFromPV: false })).toBe('0.22');
  });

  it('an enum shows its choice, never a number', () => {
    pvState = { ...pvState, value: 1, precision: 0, units: '', enumChoices: ['Off', 'On'] };
    expect(shown({ pvName: 'AR:Mode', precision: 3, precisionFromPV: false })).toBe('On');
  });

  it('a string value is shown as is', () => {
    pvState = { ...pvState, value: 'ready', units: '' };
    expect(shown({ pvName: 'AR:State', precision: 3, precisionFromPV: false })).toBe('ready');
  });

  it('a disconnected PV shows no number (the edm profile draws an empty, outlined box)', () => {
    pvState = { ...pvState, connected: false };
    expect(shown({ pvName: 'AR03:HCM4:Monitor', precision: 3, precisionFromPV: false })).toBe('');
  });

  it('a precision that is no whole number from 0 to 100 leaves the PV its own', () => {
    // Phoebus spells "use the PV" as -1; it must not become 0 decimals.
    const pv = { value: 0.05, displayValue: '0', units: '', precision: 0, enumChoices: undefined };
    const authored = (precision: number) => ({ precision, precisionFromPV: false });
    expect(displayText(pv, authored(-1))).toBe('0');
    expect(displayText(pv, authored(101))).toBe('0');
    expect(displayText(pv, authored(2.9))).toBe('0');
  });
});
