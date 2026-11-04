// Render modes on PV readouts: `edm` recolours alarm-sensitive text with
// EDM's colors.list alarm colours (no pills) and outlines disconnected
// readouts; `carbon` keeps today's severity pills, default alarm borders and
// '---' placeholders.

import type React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { AlarmSeverity } from '@slaclab/canopy-client';
import type { WidgetRendererProps } from '../registry/WidgetRegistry.js';
import { RENDER_PROFILES, RenderModeContext, parseRenderMode } from '../renderMode.js';
import type { RenderMode } from '../renderMode.js';
import { EDM_ALARM_PALETTE } from '../alarm.js';

const livePV = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
vi.mock('@slaclab/canopy-react', () => ({
  usePV: () => ({
    address: 'X',
    connected: true,
    value: 1.5,
    displayValue: '1.50 u',
    severity: AlarmSeverity.NO_ALARM,
    units: 'u',
    precision: 2,
    put: vi.fn(),
    ...livePV.current,
  }),
}));

const { CarbonPVTextDisplay, CarbonPVTextInput } = await import('./CarbonWidgets.js');

afterEach(() => {
  cleanup();
  livePV.current = null;
});

const YELLOW = 'rgb(255, 255, 0)';
const RED = 'rgb(255, 0, 0)';
const WHITE = 'rgb(255, 255, 255)';
const GREEN = 'rgb(0, 255, 0)';

// The converter's alarm-sensitive value readout (bkhAi_10ch_convert w-006).
const READOUT = {
  pvName: 'X',
  alarmSensitiveContent: true,
  foregroundColor: '#00ff00',
  backgroundColor: '#000000',
};

function renderIn(
  mode: RenderMode | undefined,
  Comp: (p: WidgetRendererProps) => React.ReactNode,
  props: Record<string, unknown>,
  pv?: Record<string, unknown>
) {
  livePV.current = pv ?? null;
  const C = Comp as React.FC<WidgetRendererProps>;
  const el = (
    <C
      id="w"
      type="PVTextDisplay"
      layout={{ x: 0, y: 0, width: 124, height: 20 }}
      props={props}
      isSelected={false}
      isEditing={false}
    />
  );
  const { container } = render(
    mode ? <RenderModeContext.Provider value={mode}>{el}</RenderModeContext.Provider> : el
  );
  return container;
}

const box = (c: HTMLElement) => c.querySelector('.carbon-pv-display') as HTMLElement;
const value = (c: HTMLElement) => c.querySelector('.carbon-pv-display__value') as HTMLElement;
const pill = (c: HTMLElement) => c.querySelector('.carbon-pv-display__alarm-tag');

describe('render mode API', () => {
  it('parses only known modes', () => {
    expect(parseRenderMode('edm')).toBe('edm');
    expect(parseRenderMode('carbon')).toBe('carbon');
    expect(parseRenderMode('legacy')).toBeUndefined();
    expect(parseRenderMode(null)).toBeUndefined();
  });

  it("edm's palette is colors.list's alarm block (noalarm '*' = own colour)", () => {
    expect(RENDER_PROFILES.edm.alarmPalette).toBe(EDM_ALARM_PALETTE);
    expect(EDM_ALARM_PALETTE).toEqual({
      [AlarmSeverity.NO_ALARM]: null,
      [AlarmSeverity.MINOR]: '#ffff00',
      [AlarmSeverity.MAJOR]: '#ff0000',
      [AlarmSeverity.INVALID]: '#ffffff',
      [AlarmSeverity.DISCONNECTED]: '#ffffff',
    });
  });
});

describe('edm mode (default) — PVTextDisplay', () => {
  it.each([
    [AlarmSeverity.MINOR, YELLOW],
    [AlarmSeverity.MAJOR, RED],
    [AlarmSeverity.INVALID, WHITE],
  ])('colours alarm-sensitive text by severity %i, with no pill', (severity, colour) => {
    const c = renderIn(undefined, CarbonPVTextDisplay, READOUT, { severity });
    expect(value(c).style.color).toBe(colour);
    expect(pill(c)).toBeNull();
    // No alarm border unless the widget asks for one (IR alarmBorder).
    expect(box(c).style.borderWidth).toBe('');
  });

  it('keeps the authored colour at NO_ALARM', () => {
    const c = renderIn('edm', CarbonPVTextDisplay, READOUT);
    expect(value(c).style.color).toBe(GREEN);
  });

  it('ignores severity on a readout that is not alarm-sensitive', () => {
    const c = renderIn(
      'edm',
      CarbonPVTextDisplay,
      { ...READOUT, alarmSensitiveContent: false },
      {
        severity: AlarmSeverity.MAJOR,
      }
    );
    expect(value(c).style.color).toBe(GREEN);
    expect(pill(c)).toBeNull();
    expect(box(c).style.borderWidth).toBe('');
  });

  it('keeps an alarm-sensitive border, in the EDM severity colour', () => {
    const c = renderIn(
      'edm',
      CarbonPVTextDisplay,
      { ...READOUT, alarmSensitiveBorder: true },
      {
        severity: AlarmSeverity.MINOR,
      }
    );
    expect(box(c).style.borderColor).toBe(YELLOW);
    expect(box(c).style.borderWidth).toBe('2px');
  });

  it("draws a disconnected readout as EDM's empty box outlined in the disconnected colour", () => {
    const c = renderIn('edm', CarbonPVTextDisplay, READOUT, {
      connected: false,
      severity: AlarmSeverity.DISCONNECTED,
    });
    expect(value(c).textContent).toBe('');
    expect(box(c).style.borderColor).toBe(WHITE);
    expect(box(c).style.borderWidth).toBe('2px');
    expect(box(c).style.backgroundColor).toBe('transparent');
  });

  it('uses EDM text metrics on an IR-coloured readout, a small inset in a Carbon field', () => {
    expect(box(renderIn('edm', CarbonPVTextDisplay, READOUT)).style.paddingLeft).toBe('0px');
    cleanup();
    expect(box(renderIn('edm', CarbonPVTextDisplay, { pvName: 'X' })).style.paddingLeft).toBe(
      '4px'
    );
  });
});

describe('carbon mode — PVTextDisplay', () => {
  it('shows a severity pill and the default alarm border, text keeps its colour', () => {
    const c = renderIn('carbon', CarbonPVTextDisplay, READOUT, { severity: AlarmSeverity.MINOR });
    expect(pill(c)?.textContent).toBe('MINOR');
    expect(value(c).style.color).toBe(GREEN);
    expect(box(c).style.borderWidth).toBe('2px');
  });

  it('shows a pill even on a readout that is not alarm-sensitive (as before)', () => {
    const c = renderIn(
      'carbon',
      CarbonPVTextDisplay,
      { pvName: 'X' },
      {
        severity: AlarmSeverity.MAJOR,
      }
    );
    expect(pill(c)?.textContent).toBe('MAJOR');
  });

  it("shows '---' for a disconnected readout and keeps Carbon padding/alignment", () => {
    const c = renderIn('carbon', CarbonPVTextDisplay, READOUT, {
      connected: false,
      severity: AlarmSeverity.DISCONNECTED,
    });
    expect(value(c).textContent).toBe('---');
    expect(box(c).style.paddingLeft).toBe('');
    expect(value(c).style.textAlign).toBe('');
  });
});

describe('render modes — PVTextInput', () => {
  const INPUT = { pvName: 'X', alarmSensitiveContent: true, foregroundColor: '#000000' };
  const input = (c: HTMLElement) => c.querySelector('input') as HTMLInputElement;

  it('edm: recolours alarm-sensitive input text and trims the Carbon field padding', () => {
    const c = renderIn('edm', CarbonPVTextInput, INPUT, { severity: AlarmSeverity.MAJOR });
    expect(input(c).style.color).toBe(RED);
    expect(input(c).style.paddingLeft).toBe('4px');
  });

  it('edm: a disconnected input is an empty outlined box', () => {
    const c = renderIn('edm', CarbonPVTextInput, INPUT, {
      connected: false,
      severity: AlarmSeverity.DISCONNECTED,
    });
    expect(input(c).value).toBe('');
    expect((c.querySelector('.carbon-pv-input') as HTMLElement).style.borderColor).toBe(WHITE);
  });

  it("carbon: keeps the authored colour, Carbon padding and '---'", () => {
    const live = renderIn('carbon', CarbonPVTextInput, INPUT, { severity: AlarmSeverity.MAJOR });
    expect(input(live).style.color).toBe('rgb(0, 0, 0)');
    expect(input(live).style.paddingLeft).toBe('');
    cleanup();
    const down = renderIn('carbon', CarbonPVTextInput, INPUT, {
      connected: false,
      severity: AlarmSeverity.DISCONNECTED,
    });
    expect(input(down).value).toBe('---');
  });
});
