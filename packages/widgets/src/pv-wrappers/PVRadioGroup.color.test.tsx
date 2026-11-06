// A radio group's captions and rings take the foreground it is given (the
// runtime fills the theme's Text role when the screen sets none), so they read
// on the canvas instead of keeping Carbon's own text colour.
import type React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { AlarmSeverity } from '@slaclab/canopy-client';
import type { WidgetRendererProps } from '../registry/WidgetRegistry.js';

vi.mock('@slaclab/canopy-react', () => ({
  usePV: (address?: string) => ({
    address: address ?? '',
    connected: !!address,
    value: 1,
    displayValue: 'On',
    units: '',
    precision: 0,
    enumChoices: ['Off', 'On'],
    severity: AlarmSeverity.NO_ALARM,
    put: vi.fn(),
  }),
}));

const { CarbonPVRadioGroup } = await import('./CarbonWidgets.js');
const Radio = CarbonPVRadioGroup as React.FC<WidgetRendererProps>;

afterEach(cleanup);

const base = {
  id: 'r-1',
  layout: { x: 0, y: 0, width: 120, height: 24 },
  props: {},
  isSelected: false,
  isEditing: false,
} as unknown as WidgetRendererProps;

/** The nearest ancestor of the caption that sets an inline colour. */
function captionBox(text: string): HTMLElement {
  for (let el: HTMLElement | null = screen.getByText(text); el; el = el.parentElement) {
    if (el.style.color) return el;
  }
  throw new Error('no element with an inline color');
}

describe('PVRadioGroup colour', () => {
  it('draws captions and rings in the foreground colour', () => {
    render(
      <Radio
        {...base}
        props={{
          pvName: 'AR01:QF1:OnControl',
          customItems: ['Off', 'On'],
          foregroundColor: 'var(--cr-3, #161616)',
        }}
      />
    );
    const box = captionBox('Off');
    expect(box.style.color).toBe('var(--cr-3, #161616)');
    expect(box.style.getPropertyValue('--cds-icon-primary')).toBe('var(--cr-3, #161616)');
    expect(captionBox('On')).toBe(box);
  });

  it('leaves Carbon its own colours when no foreground is given', () => {
    render(
      <Radio {...base} props={{ pvName: 'AR01:QF1:OnControl', customItems: ['Off', 'On'] }} />
    );
    for (let el: HTMLElement | null = screen.getByText('Off'); el; el = el.parentElement) {
      expect(el.style.color).toBe('');
    }
  });
});
