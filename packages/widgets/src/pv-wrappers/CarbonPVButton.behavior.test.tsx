// EDM write/state parity for CarbonPVButton: authored press/release values
// reach the control PV, and toggle buttons follow their readback PV. A host
// that marks the button's actions write-inert makes it inert with no gate; a
// button with no control channel is never inert on its own account.
import type React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import type { WidgetRendererProps } from '../registry/WidgetRegistry.js';
import type { WriteGateService } from '../writeGate/types.js';

const puts: Record<string, Array<number | string>> = {};
let pvState: Record<string, { connected: boolean; value: number | string }> = {};

vi.mock('@slaclab/canopy-react', () => ({
  usePV: (address?: string) => ({
    address: address ?? '',
    connected: (address && pvState[address]?.connected) || false,
    value: address ? pvState[address]?.value : undefined,
    displayValue: address ? String(pvState[address]?.value ?? '') : '',
    severity: 0,
    put: (v: number | string) => {
      if (address) (puts[address] ??= []).push(v);
    },
  }),
}));

const { CarbonPVButton, CarbonPVLed, CarbonPVByteIndicator } = await import('./CarbonWidgets.js');
const { AssetResolverContext } = await import('../assets.js');
const { WriteGate } = await import('../writeGate/WriteGate.js');
const Btn = CarbonPVButton as React.FC<WidgetRendererProps>;
const Led = CarbonPVLed as React.FC<WidgetRendererProps>;
const ByteInd = CarbonPVByteIndicator as React.FC<WidgetRendererProps>;

afterEach(cleanup);
beforeEach(() => {
  for (const k of Object.keys(puts)) delete puts[k];
  pvState = {};
});

const base: WidgetRendererProps = {
  id: 'w-1',
  layout: { x: 0, y: 0, width: 100, height: 24 },
  props: {},
  isSelected: false,
  isEditing: false,
} as unknown as WidgetRendererProps;

function renderButton(props: Record<string, unknown>) {
  const C = CarbonPVButton as React.FC<WidgetRendererProps>;
  const utils = render(<C {...base} props={props} />);
  return utils.container.querySelector('button') as HTMLButtonElement;
}

describe('CarbonPVButton write values', () => {
  it('writes the authored numeric pressValue on click', () => {
    const btn = renderButton({ controlPV: 'SIM:CMD', pressValue: '2' });
    fireEvent.click(btn);
    expect(puts['SIM:CMD']).toEqual([2]);
  });

  it('writes a non-numeric pressValue as a string (enum-name writes)', () => {
    const btn = renderButton({ controlPV: 'SIM:CMD', pressValue: 'RESET' });
    fireEvent.click(btn);
    expect(puts['SIM:CMD']).toEqual(['RESET']);
  });

  it('writes press on pointerdown and release on pointerup when releaseValue is set', () => {
    const btn = renderButton({ controlPV: 'SIM:CMD', pressValue: '1', releaseValue: '0' });
    fireEvent.pointerDown(btn);
    expect(puts['SIM:CMD']).toEqual([1]);
    // The release follows the pointer wherever it comes up (window-level).
    fireEvent.pointerUp(window);
    expect(puts['SIM:CMD']).toEqual([1, 0]);
  });

  it('defaults to writing 1 when no pressValue is authored', () => {
    const btn = renderButton({ controlPV: 'SIM:CMD' });
    fireEvent.click(btn);
    expect(puts['SIM:CMD']).toEqual([1]);
  });
});

describe('CarbonPVButton write-inert', () => {
  const REASON = 'writes are off for Probe; turn them back on from the control-target chip';
  const LOCKED = Object.freeze({ disabled: true, reason: REASON });
  const locked: WriteGateService = {
    confirmWrites: () => false,
    run: () => Promise.resolve([]),
    // The same object while nothing changed, as the contract requires.
    writes: () => LOCKED,
    subscribeWrites: () => () => {},
  };

  function renderLocked(props: Record<string, unknown>) {
    const C = CarbonPVButton as React.FC<WidgetRendererProps>;
    const utils = render(
      <WriteGate.Provider value={locked}>
        <C {...base} props={props} />
      </WriteGate.Provider>
    );
    return utils.container.querySelector('button') as HTMLButtonElement;
  }

  it('a host-set reason makes it inert: aria-disabled, focusable, no write', () => {
    const btn = renderButton({ controlPV: 'SIM:CMD', label: 'Go', writesInert: REASON });
    expect(btn.getAttribute('aria-disabled')).toBe('true');
    expect(btn.title).toBe(REASON);
    const described = document.getElementById(btn.getAttribute('aria-describedby') ?? '');
    expect(described?.textContent).toBe(REASON);
    expect(btn.disabled).toBe(false);
    btn.focus();
    expect(document.activeElement).toBe(btn);
    fireEvent.click(btn);
    fireEvent.pointerDown(btn);
    expect(puts).toEqual({});
  });

  it('a host-set reason that is not a string is ignored', () => {
    const btn = renderButton({ controlPV: 'SIM:CMD', writesInert: true });
    expect(btn.getAttribute('aria-disabled')).toBeNull();
    fireEvent.click(btn);
    expect(puts['SIM:CMD']).toEqual([1]);
  });

  it('a channel-less button stays live under a disabled gate (navigation-only actions)', () => {
    const btn = renderLocked({ label: 'Open panel' });
    expect(btn.getAttribute('aria-disabled')).toBeNull();
    expect(btn.hasAttribute('title')).toBe(false);
    expect(btn.style.cursor).toBe('pointer');
  });

  it('a machine control under a disabled gate is inert and shows a not-allowed cursor', () => {
    const btn = renderLocked({ controlPV: 'SIM:CMD', label: 'HCM 01' });
    expect(btn.getAttribute('aria-disabled')).toBe('true');
    expect(btn.title).toBe(REASON);
    expect(btn.style.cursor).toBe('not-allowed');
    expect(btn.textContent).toBe('HCM 01');
  });
});

describe('CarbonPVButton EDM state semantics', () => {
  it('treats fractional readbacks as OFF (EDM integer truncation)', () => {
    pvState['SIM:STATE'] = { connected: true, value: 0.5 };
    const btn = renderButton({
      controlPV: 'SIM:CTRL',
      readbackPV: 'SIM:STATE',
      onLabel: 'Enabled',
      offLabel: 'Disabled',
    });
    expect(btn.textContent).toBe('Disabled');
  });

  it('colors the face by state when onColor/offColor are authored', () => {
    pvState['SIM:STATE'] = { connected: true, value: 1 };
    const btn = renderButton({
      controlPV: 'SIM:CTRL',
      readbackPV: 'SIM:STATE',
      onColor: '#00ff00',
      offColor: '#ffff00',
      label: 'SW',
    });
    expect(btn.style.backgroundColor).toBe('rgb(0, 255, 0)');
    cleanup();
    pvState['SIM:STATE'] = { connected: true, value: 0 };
    const off = renderButton({
      controlPV: 'SIM:CTRL',
      readbackPV: 'SIM:STATE',
      onColor: '#00ff00',
      offColor: '#ffff00',
      label: 'SW',
    });
    expect(off.style.backgroundColor).toBe('rgb(255, 255, 0)');
  });
});

describe('CarbonPVButton toggle + readback', () => {
  it('shows onLabel and writes 0 when the readback reads nonzero', () => {
    pvState['SIM:STATE'] = { connected: true, value: 1 };
    const btn = renderButton({
      controlPV: 'SIM:CTRL',
      readbackPV: 'SIM:STATE',
      buttonType: 'toggle',
      onLabel: 'Enabled',
      offLabel: 'Disabled',
    });
    expect(btn.textContent).toBe('Enabled');
    fireEvent.click(btn);
    expect(puts['SIM:CTRL']).toEqual([0]);
  });

  it('shows offLabel and writes 1 when the readback reads zero', () => {
    pvState['SIM:STATE'] = { connected: true, value: 0 };
    const btn = renderButton({
      controlPV: 'SIM:CTRL',
      readbackPV: 'SIM:STATE',
      buttonType: 'toggle',
      onLabel: 'Enabled',
      offLabel: 'Disabled',
    });
    expect(btn.textContent).toBe('Disabled');
    fireEvent.click(btn);
    expect(puts['SIM:CTRL']).toEqual([1]);
  });
});

describe('CarbonPVButton transparent (Phoebus transparent=true)', () => {
  it('paints no chrome: transparent background, no shadow, no border', () => {
    const btn = renderButton({ controlPV: 'SIM:CMD', transparent: true, label: 'Go' });
    expect(btn.style.backgroundColor).toBe('transparent');
    expect(btn.style.boxShadow).toBe('none');
    // `border: 'none'` is set unconditionally on every button; jsdom's CSSOM
    // drops the `border` shorthand, so it is not observable here.
    expect(btn.textContent).toBe('Go');
  });

  it('still writes the authored pressValue on click', () => {
    const btn = renderButton({ controlPV: 'SIM:CMD', pressValue: '2', transparent: true });
    fireEvent.click(btn);
    expect(puts['SIM:CMD']).toEqual([2]);
  });

  it('wins over a connected colorPV and onColor', () => {
    pvState['X'] = { connected: true, value: '#00ff00' };
    pvState['SIM:STATE'] = { connected: true, value: 1 };
    const btn = renderButton({
      controlPV: 'SIM:CTRL',
      readbackPV: 'SIM:STATE',
      transparent: true,
      onColor: '#f00',
      colorPV: 'X',
      backgroundColor: '#0000ff',
    });
    expect(btn.style.backgroundColor).toBe('transparent');
  });

  it('keeps the invisible null return', () => {
    const { container } = render(<Btn {...base} props={{ transparent: true, invisible: true }} />);
    expect(container.querySelector('button')).toBeNull();
  });
});

describe('CarbonPVButton state images', () => {
  const imgs = { onImage: 'images/on.png', offImage: 'images/off.png', label: 'SW' };

  it('shows the on image when the readback is on', () => {
    pvState['SIM:STATE'] = { connected: true, value: 1 };
    const btn = renderButton({ controlPV: 'SIM:CTRL', readbackPV: 'SIM:STATE', ...imgs });
    const img = btn.querySelectorAll('img');
    expect(img).toHaveLength(1);
    expect(img[0].getAttribute('src')).toBe('images/on.png');
    expect(img[0].style.objectFit).toBe('contain');
  });

  it('shows the off image when the readback is off', () => {
    pvState['SIM:STATE'] = { connected: true, value: 0 };
    const btn = renderButton({ controlPV: 'SIM:CTRL', readbackPV: 'SIM:STATE', ...imgs });
    expect(btn.querySelector('img')?.getAttribute('src')).toBe('images/off.png');
  });

  it('shows no state (no image, the plain label) when the readback is disconnected', () => {
    const btn = renderButton({ controlPV: 'SIM:CTRL', readbackPV: 'SIM:STATE', ...imgs });
    expect(btn.querySelector('img')).toBeNull();
    expect(btn.dataset.pvNostate).toBe('true');
    expect(btn.textContent).toBe('SW');
  });

  it('keeps its image for a disconnected loc:// readback (a local, never a machine PV)', () => {
    const btn = renderButton({ controlPV: 'loc://tv', readbackPV: 'loc://tv', ...imgs });
    expect(btn.querySelector('img')?.getAttribute('src')).toBe('images/off.png');
    expect(btn.dataset.pvNostate).toBeUndefined();
    expect(btn.closest('[data-pv-nostate]')).toBeNull();
  });

  it('resolves the image ref through the AssetResolverContext', () => {
    pvState['SIM:STATE'] = { connected: true, value: 1 };
    const { container } = render(
      <AssetResolverContext.Provider value={(ref) => `/assets/${ref}`}>
        <Btn {...base} props={{ readbackPV: 'SIM:STATE', ...imgs }} />
      </AssetResolverContext.Provider>
    );
    expect(container.querySelector('img')?.getAttribute('src')).toBe('/assets/images/on.png');
  });

  it('falls back to the label when the image fails to load', () => {
    pvState['SIM:STATE'] = { connected: true, value: 0 };
    const btn = renderButton({ controlPV: 'SIM:CTRL', readbackPV: 'SIM:STATE', ...imgs });
    fireEvent.error(btn.querySelector('img') as HTMLImageElement);
    expect(btn.querySelector('img')).toBeNull();
    expect(btn.textContent).toBe('SW');
  });

  it('writes on click with an image face', () => {
    const btn = renderButton({ controlPV: 'SIM:CTRL', pressValue: '3', ...imgs });
    fireEvent.click(btn);
    expect(puts['SIM:CTRL']).toEqual([3]);
  });
});

describe('LED glow alpha', () => {
  function glowOf(el: Element | null): string {
    return (el as HTMLElement).getAttribute('style') ?? '';
  }

  it('CarbonPVLed strips an existing alpha before appending 80', () => {
    pvState['SIM:LED'] = { connected: true, value: 1 };
    const { container } = render(
      <Led {...base} props={{ pvName: 'SIM:LED', onColor: '#00ff00cc' }} />
    );
    const style = glowOf(container.querySelector('.carbon-pv-led'));
    expect(style).not.toMatch(/#00ff00cc80/i);
    expect(style).toMatch(/#00ff0080|rgba\(0, 255, 0, 0\.5/i);
  });

  it('a connected LED has state: no data-pv-nostate', () => {
    pvState['SIM:LED'] = { connected: true, value: 0 };
    const { container } = render(<Led {...base} props={{ pvName: 'SIM:LED' }} />);
    expect(container.querySelector('[data-pv-nostate]')).toBeNull();
    expect((container.querySelector('.carbon-pv-led') as HTMLElement).style.backgroundColor).toBe(
      'rgb(82, 82, 82)'
    );
  });

  it('CarbonPVLed keeps an opaque colour unchanged plus 80', () => {
    pvState['SIM:LED'] = { connected: true, value: 1 };
    const { container } = render(
      <Led {...base} props={{ pvName: 'SIM:LED', onColor: '#00ff00' }} />
    );
    expect(glowOf(container.querySelector('.carbon-pv-led'))).toMatch(
      /#00ff0080|rgba\(0, 255, 0, 0\.5/i
    );
  });

  it('CarbonPVLed glows a role colour through color-mix, never a hex suffix', () => {
    pvState['SIM:LED'] = { connected: true, value: 1 };
    const { container } = render(
      <Led {...base} props={{ pvName: 'SIM:LED', onColor: 'var(--cr-3, #00ff00)' }} />
    );
    const style = glowOf(container.querySelector('.carbon-pv-led'));
    expect(style).not.toMatch(/\)80/);
    expect(style).toContain('color-mix(in srgb, var(--cr-3, #00ff00) 50%, transparent)');
  });

  it('CarbonPVByteIndicator strips an existing alpha before appending 80', () => {
    pvState['SIM:BYTE'] = { connected: true, value: 1 };
    const { container } = render(
      <ByteInd {...base} props={{ pvName: 'SIM:BYTE', numBits: 1, onColor: '#00ff00cc' }} />
    );
    const style = glowOf(container.querySelector('.carbon-pv-byte > div'));
    expect(style).not.toMatch(/#00ff00cc80/i);
    expect(style).toMatch(/#00ff0080|rgba\(0, 255, 0, 0\.5/i);
  });
});
