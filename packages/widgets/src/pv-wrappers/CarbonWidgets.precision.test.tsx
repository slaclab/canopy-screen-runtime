// One precision rule for the text display, the text input and the meter
// (pvText): the PV's precision (the SDK's displayValue) unless the widget sets
// precisionFromPV: false beside an authored `precision`. With the flag, a PV
// served with PREC 0 shows 0.05 as 0.050, not "0".
import type React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { AlarmSeverity } from '@slaclab/canopy-client';
import type { WidgetRendererProps } from '../registry/WidgetRegistry.js';

// A connected corrector at 0.05 mrad whose PV states PREC 0.
vi.mock('@slaclab/canopy-react', () => ({
  usePV: (address?: string) => ({
    address: address ?? '',
    connected: !!address,
    value: 0.05,
    displayValue: '0 mrad',
    units: 'mrad',
    precision: 0,
    lowerLimit: 0,
    upperLimit: 1,
    severity: AlarmSeverity.NO_ALARM,
    put: vi.fn(),
  }),
}));

const { CarbonPVTextDisplay, CarbonPVTextInput, CarbonPVMeter } =
  await import('./CarbonWidgets.js');

afterEach(cleanup);

const base = {
  id: 'w-1',
  layout: { x: 0, y: 0, width: 200, height: 100 },
  props: {},
  isSelected: false,
  isEditing: false,
} as unknown as WidgetRendererProps;

function renderWith(C: unknown, props: Record<string, unknown>) {
  const Comp = C as React.FC<WidgetRendererProps>;
  return render(<Comp {...base} props={{ pvName: 'AR03:HCM4', ...props }} />).container;
}

describe('CarbonPVTextDisplay precision', () => {
  const shown = (props: Record<string, unknown>) =>
    renderWith(CarbonPVTextDisplay, props).querySelector('.carbon-pv-display__value')?.textContent;

  it('shows the authored precision when precisionFromPV is false', () => {
    expect(shown({ precision: 3, precisionFromPV: false })).toBe('0.050 mrad');
  });

  it('shows the PV displayValue when no precision is authored', () => {
    expect(shown({})).toBe('0 mrad');
  });

  it('shows the PV displayValue unless precisionFromPV is false', () => {
    expect(shown({ precision: 3 })).toBe('0 mrad');
    expect(shown({ precision: 3, precisionFromPV: true })).toBe('0 mrad');
  });
});

describe('CarbonPVTextInput precision', () => {
  const shown = (props: Record<string, unknown>) =>
    (renderWith(CarbonPVTextInput, props).querySelector('input') as HTMLInputElement).value;

  it('shows the authored precision when precisionFromPV is false', () => {
    expect(shown({ precision: 3, precisionFromPV: false })).toBe('0.050');
  });

  it('shows the raw value when neither states a precision', () => {
    expect(shown({})).toBe('0.05');
    expect(shown({ precision: 3 })).toBe('0.05');
  });
});

describe('CarbonPVMeter precision', () => {
  it('shows the authored precision when precisionFromPV is false', () => {
    expect(
      renderWith(CarbonPVMeter, { precision: 2, precisionFromPV: false }).textContent
    ).toContain('0.05 mrad');
  });

  it('shows the PV displayValue when no precision is authored', () => {
    expect(renderWith(CarbonPVMeter, {}).textContent).toContain('0 mrad');
  });
});
