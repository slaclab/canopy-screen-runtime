import type React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { AlarmSeverity } from '@slaclab/canopy-client';
import type { WidgetRendererProps } from '../registry/WidgetRegistry.js';

// A disconnected stub PV by default: components fall back to their
// static/default render, which is what most rendering-fidelity tests
// exercise. `livePV.current` overrides fields for tests that need live data.
const livePV = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
vi.mock('@slaclab/canopy-react', () => ({
  usePV: () => ({
    address: '',
    connected: false,
    value: undefined,
    displayValue: '',
    severity: AlarmSeverity.NO_ALARM,
    units: '',
    put: vi.fn(),
    ...livePV.current,
  }),
}));

const {
  CarbonPVProgressBar,
  CarbonPVButton,
  CarbonPVTextDisplay,
  CarbonPVTextInput,
  CarbonPVByteIndicator,
} = await import('./CarbonWidgets.js');

afterEach(() => {
  cleanup();
  livePV.current = null;
});

const base: WidgetRendererProps = {
  id: 'w-1',
  layout: { x: 0, y: 0, width: 100, height: 24 },
  props: {},
  isSelected: false,
  isEditing: false,
} as unknown as WidgetRendererProps;

function renderWith(
  Comp: (p: WidgetRendererProps) => React.ReactNode,
  props: Record<string, unknown>,
  layout?: Partial<WidgetRendererProps['layout']>
) {
  const C = Comp as React.FC<WidgetRendererProps>;
  return render(<C {...base} layout={{ ...base.layout, ...layout }} props={props} />);
}

describe('CarbonPVProgressBar orientation', () => {
  it('renders a vertical bar with a bottom-anchored fill when orientation=vertical', () => {
    const { container } = renderWith(
      CarbonPVProgressBar,
      { orientation: 'vertical', minValue: 0, maxValue: 100 },
      { width: 10, height: 150 }
    );
    const wrapper = container.querySelector('.carbon-pv-progress--vertical') as HTMLElement;
    expect(wrapper).not.toBeNull();
    expect(wrapper.style.alignItems).toBe('flex-end'); // fill grows up from the bottom
    expect(container.querySelector('.cds--progress-bar')).toBeNull();
  });

  it('renders the horizontal Carbon ProgressBar by default', () => {
    const { container } = renderWith(CarbonPVProgressBar, { minValue: 0, maxValue: 100 });
    expect(container.querySelector('.carbon-pv-progress--vertical')).toBeNull();
    expect(container.querySelector('.cds--progress-bar')).not.toBeNull();
  });
});

describe('CarbonPVButton no-label', () => {
  it('renders no "Off"/"On" text for a text-less momentary button', () => {
    const { container } = renderWith(
      CarbonPVButton,
      { controlPV: 'SIM:MOTOR.TWR', pressValue: '1' },
      { width: 50, height: 30 }
    );
    const btn = container.querySelector('button') as HTMLButtonElement;
    expect(btn).not.toBeNull();
    expect(btn.textContent).toBe('');
  });

  it('renders an open-display icon (svg) for a text-less 20x20 button', () => {
    const { container } = renderWith(CarbonPVButton, {}, { width: 20, height: 20 });
    const btn = container.querySelector('button') as HTMLButtonElement;
    expect(btn.querySelector('svg')).not.toBeNull();
    expect(btn.textContent).toBe('');
  });

  it('still shows an authored label', () => {
    const { container } = renderWith(CarbonPVButton, {
      controlPV: 'SIM:STOP',
      label: 'STOP',
      onLabel: 'STOP',
      offLabel: 'STOP',
    });
    const btn = container.querySelector('button') as HTMLButtonElement;
    expect(btn.textContent).toBe('STOP');
  });
});

describe('CarbonPVTextDisplay align', () => {
  it('centers a static caption when align=center', () => {
    const { container } = renderWith(CarbonPVTextDisplay, {
      text: 'Horizontal Motors',
      align: 'center',
    });
    const value = container.querySelector('.carbon-pv-display__value') as HTMLElement;
    expect(value).not.toBeNull();
    expect(value.style.textAlign).toBe('center');
  });

  it('left-aligns when align is absent (the IR default) in edm mode', () => {
    const { container } = renderWith(CarbonPVTextDisplay, { text: 'Left caption' });
    const value = container.querySelector('.carbon-pv-display__value') as HTMLElement;
    expect(value.style.textAlign).toBe('left');
  });
});

describe('CarbonPVTextDisplay precision', () => {
  function shown(props: Record<string, unknown>, pv: Record<string, unknown>): string {
    livePV.current = { connected: true, ...pv };
    const { container } = renderWith(CarbonPVTextDisplay, { pvName: 'X', ...props });
    return (container.querySelector('.carbon-pv-display__value') as HTMLElement).textContent ?? '';
  }

  it("shows the service's displayValue by default (precision from the PV)", () => {
    expect(shown({ precision: 3 }, { value: 1.731, displayValue: '1.73 u', units: 'u' })).toBe(
      '1.73 u'
    );
  });

  it('applies the authored precision when precisionFromPV is false', () => {
    expect(
      shown({ precision: 3, precisionFromPV: false }, { value: -1.6175621, displayValue: 'x' })
    ).toBe('-1.618');
    expect(
      shown(
        { precision: 3, precisionFromPV: false },
        { value: 1.731, displayValue: '1.73 u', units: 'u' }
      )
    ).toBe('1.731 u');
  });

  it('keeps enum labels and non-numeric values as the service formats them', () => {
    expect(
      shown(
        { precision: 3, precisionFromPV: false },
        { value: 2, displayValue: 'State 3', enumChoices: ['State 1', 'State 2', 'State 3'] }
      )
    ).toBe('State 3');
    expect(
      shown({ precision: 3, precisionFromPV: false }, { value: 'ON', displayValue: 'ON' })
    ).toBe('ON');
  });
});

describe('IR colours on text readouts', () => {
  const field = (c: HTMLElement) => c.querySelector('.carbon-pv-display') as HTMLElement;
  const valueEl = (c: HTMLElement) => c.querySelector('.carbon-pv-display__value') as HTMLElement;

  it('paints an authored background and foreground (EDM textupdate fgColor/bgColor)', () => {
    livePV.current = { connected: true, value: 1, displayValue: '1.00' };
    const { container } = renderWith(CarbonPVTextDisplay, {
      pvName: 'X',
      foregroundColor: '#2d2d2d',
      backgroundColor: '#dadada',
    });
    expect(field(container).style.backgroundColor).toBe('rgb(218, 218, 218)');
    // The authored field is edge to edge: no Carbon frame around it.
    expect(field(container).style.borderColor).toBe('transparent');
    expect(valueEl(container).style.color).toBe('rgb(45, 45, 45)');
  });

  it('draws a foreground-only readout on the display background (no Carbon field)', () => {
    livePV.current = { connected: true, value: 1, displayValue: '1.00' };
    const { container } = renderWith(CarbonPVTextDisplay, {
      pvName: 'X',
      foregroundColor: '#000000',
    });
    expect(field(container).style.backgroundColor).toBe('transparent');
    expect(valueEl(container).style.color).toBe('rgb(0, 0, 0)');
  });

  it('keeps the Carbon field and text colour when the IR carries no colours', () => {
    livePV.current = { connected: true, value: 1, displayValue: '1.00' };
    const { container } = renderWith(CarbonPVTextDisplay, { pvName: 'X' });
    expect(field(container).style.backgroundColor).toBe('');
    expect(field(container).style.borderColor).toBe('');
    expect(valueEl(container).style.color).toBe('');
  });

  it('honours an authored font family on the value', () => {
    const { container } = renderWith(CarbonPVTextDisplay, {
      text: 'caption',
      fontFamily: 'Helvetica',
    });
    expect(valueEl(container).style.fontFamily).toBe('Helvetica');
  });

  it('paints text-input colours and font on the Carbon input itself', () => {
    livePV.current = { connected: true, value: 1, displayValue: '1' };
    const { container } = renderWith(CarbonPVTextInput, {
      pvName: 'X',
      foregroundColor: '#000000',
      backgroundColor: '#ffffff',
      fontSize: 10,
      fontFamily: 'Helvetica',
    });
    const input = container.querySelector('input') as HTMLInputElement;
    expect(input.style.color).toBe('rgb(0, 0, 0)');
    expect(input.style.backgroundColor).toBe('rgb(255, 255, 255)');
    expect(input.style.fontSize).toBe('10px');
    expect(input.style.fontFamily).toBe('Helvetica');
  });

  it('leaves the Carbon input untouched without IR colours', () => {
    livePV.current = { connected: true, value: 1, displayValue: '1' };
    const { container } = renderWith(CarbonPVTextInput, { pvName: 'X' });
    const input = container.querySelector('input') as HTMLInputElement;
    expect(input.style.color).toBe('');
    expect(input.style.backgroundColor).toBe('');
  });
});

describe('IR colours on buttons and bit indicators', () => {
  it('paints an authored button face and caption (related-display / shell / message)', () => {
    const { container } = renderWith(CarbonPVButton, {
      label: 'Convert...',
      foregroundColor: '#000000',
      backgroundColor: '#c8c8c8',
    });
    const btn = container.querySelector('button') as HTMLButtonElement;
    expect(btn.style.backgroundColor).toBe('rgb(200, 200, 200)');
    expect(btn.style.color).toBe('rgb(0, 0, 0)');
  });

  it('paints byte cells with the authored on/off colours', () => {
    livePV.current = { connected: true, value: 0b01, displayValue: '1' };
    const { container } = renderWith(
      CarbonPVByteIndicator,
      { pvName: 'X', numBits: 2, onColor: '#00ff00', offColor: '#003000' },
      { width: 40, height: 20 }
    );
    const cells = container.querySelectorAll<HTMLElement>('.carbon-pv-byte > div');
    expect(cells[0].style.backgroundColor).toBe('rgb(0, 255, 0)');
    expect(cells[1].style.backgroundColor).toBe('rgb(0, 48, 0)');
  });
});
