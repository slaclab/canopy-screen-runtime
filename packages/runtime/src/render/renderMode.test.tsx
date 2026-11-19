// Render mode through the runtime: the IR's alarm flags reach the widgets
// under their widget-set names, and ScreenRenderer provides the mode to every
// widget (embedded screens included).

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { PVData, PVService } from '@slaclab/canopy-client';
import { PVServiceProvider } from '@slaclab/canopy-react';
import { RenderModeContext, registerBuiltinWidgets } from '@slaclab/canopy-screen-widgets';
import type { PropertyValue, ScreenJSON, WidgetNode } from '@slaclab/canopy-screen-ir';
import { mapIRWidget } from './irMap.js';
import { ScreenRenderer } from './ScreenRenderer.js';

/** Every PV connected, MINOR. */
class MinorPVService implements PVService {
  readonly isConnected = true;
  private readonly data: PVData = {
    value: 8.11,
    displayValue: '8.11 u',
    severity: 1,
    connected: true,
    timestamp: 0,
    units: 'u',
    precision: 2,
    lowerLimit: 0,
    upperLimit: 10,
  };
  subscribe(_name: string, listener: (d: PVData) => void) {
    listener(this.data);
    return () => {};
  }
  getSnapshot() {
    return this.data;
  }
  put() {}
  connect() {}
  disconnect() {}
}

beforeAll(() => {
  registerBuiltinWidgets();
});

afterEach(cleanup);

function wrap(children: ReactNode) {
  return <PVServiceProvider service={new MinorPVService()}>{children}</PVServiceProvider>;
}

// The converter's alarm-sensitive readout (bkhAi_10ch_convert w-006).
const READOUT: Record<string, PropertyValue> = {
  pv: 'BKHF:CH01',
  showUnits: true,
  alarmSensitive: true,
  foregroundColor: '#00ff00',
  backgroundColor: '#000000',
  fontSize: 12,
};

function screenWith(children: WidgetNode[]): ScreenJSON {
  return {
    schemaVersion: '1.0',
    kind: 'screen',
    id: 'modes',
    metadata: { title: 't', source: { type: 'edl-converter' }, size: { width: 300, height: 100 } },
    macros: [],
    root: {
      id: 'root',
      type: 'absolute-canvas',
      props: {},
      geometry: { x: 0, y: 0, width: 300, height: 100 },
      children,
    },
  };
}

const READOUT_SCREEN = screenWith([
  {
    id: 'w-006',
    type: 'pv-label',
    props: READOUT,
    geometry: { x: 0, y: 0, width: 124, height: 20 },
  },
]);

const valueEl = () => screen.getByText('8.11 u');

describe('IR alarm flags → widget props', () => {
  it('maps alarmSensitive → alarmSensitiveContent and alarmBorder → alarmSensitiveBorder', () => {
    const props = mapIRWidget('pv-label', {
      pv: 'X',
      alarmSensitive: true,
      alarmBorder: false,
    })!.props;
    expect(props.alarmSensitiveContent).toBe(true);
    expect(props.alarmSensitiveBorder).toBe(false);
    expect(props).not.toHaveProperty('alarmSensitive');
    expect(props).not.toHaveProperty('alarmBorder');
  });

  it('invents no defaults (the render mode owns them) and lets explicit names win', () => {
    const plain = mapIRWidget('pv-label', { pv: 'X' })!.props;
    expect(plain).not.toHaveProperty('alarmSensitiveContent');
    expect(plain).not.toHaveProperty('alarmSensitiveBorder');
    const explicit = mapIRWidget('pv-text-input', {
      pv: 'X',
      alarmSensitive: true,
      alarmSensitiveContent: false,
    })!.props;
    expect(explicit.alarmSensitiveContent).toBe(false);
  });
});

describe('ScreenRenderer renderMode', () => {
  it("defaults to 'edm': alarm-sensitive text turns EDM MINOR yellow, no pill", () => {
    render(wrap(<ScreenRenderer screen={READOUT_SCREEN} />));
    expect(screen.getByTestId('screen-root').dataset.renderMode).toBe('edm');
    expect(valueEl().style.color).toBe('rgb(255, 255, 0)');
    expect(screen.queryByText('MINOR')).toBeNull();
  });

  it("renderMode='carbon' restores the severity pill and the authored text colour", () => {
    render(wrap(<ScreenRenderer screen={READOUT_SCREEN} renderMode="carbon" />));
    expect(screen.getByTestId('screen-root').dataset.renderMode).toBe('carbon');
    expect(screen.getByText('MINOR')).toBeTruthy();
    expect(valueEl().style.color).toBe('rgb(0, 255, 0)');
  });

  it('inherits an enclosing RenderModeContext when no prop is given', () => {
    render(
      wrap(
        <RenderModeContext.Provider value="carbon">
          <ScreenRenderer screen={READOUT_SCREEN} />
        </RenderModeContext.Provider>
      )
    );
    expect(screen.getByTestId('screen-root').dataset.renderMode).toBe('carbon');
  });

  it('reaches widgets inside embedded screens', async () => {
    const host = screenWith([
      {
        id: 'embed',
        type: 'embedded-display',
        props: { file: 'child.screen.json' },
        geometry: { x: 0, y: 0, width: 200, height: 50 },
      },
    ]);
    const resolveScreen = vi.fn().mockResolvedValue(READOUT_SCREEN);
    render(
      wrap(<ScreenRenderer screen={host} resolveScreen={resolveScreen} renderMode="carbon" />)
    );
    expect(await screen.findByText('MINOR')).toBeTruthy();
  });
});
