// An unset text-label colour is the Text role: resolved like an authored role,
// against the active scheme, with the sheet carrying the light and dark values.

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MockPVService } from '@slaclab/canopy-client';
import { PVServiceProvider } from '@slaclab/canopy-react';
import { canopyDefaultFlat } from '@slaclab/canopy-screen-ir';
import type { FlatScheme, PropertyValue, ScreenJSON, WidgetNode } from '@slaclab/canopy-screen-ir';
import { registerBuiltinWidgets } from '@slaclab/canopy-screen-widgets';
import { ScreenRenderer } from '../render/ScreenRenderer.js';
import { setMode } from './modeStore.js';

const TEXT = canopyDefaultFlat.roles.indexOf('Text');
const LIGHT = canopyDefaultFlat.light[TEXT];
const DARK = canopyDefaultFlat.dark[TEXT];

function label(id: string, props: Record<string, PropertyValue>): WidgetNode {
  return { id, type: 'text-label', props, geometry: { x: 0, y: 0, width: 100, height: 20 } };
}

function doc(children: WidgetNode[]): ScreenJSON {
  return {
    schemaVersion: '1.0',
    kind: 'screen',
    id: 'label',
    metadata: { title: 'l', source: { type: 'hand-authored' }, size: { width: 100, height: 40 } },
    macros: [],
    root: {
      id: 'root',
      type: 'absolute-canvas',
      props: {},
      geometry: { x: 0, y: 0, width: 100, height: 40 },
      children,
    },
  };
}

let service: MockPVService;

beforeAll(() => registerBuiltinWidgets());

beforeEach(() => {
  service = new MockPVService();
  service.connect();
});

afterEach(() => {
  cleanup();
  service.disconnect();
  setMode('light');
});

function wrap(children: ReactNode) {
  return <PVServiceProvider service={service}>{children}</PVServiceProvider>;
}

/** The inline colour of the element that carries the label's colour. */
function labelColor(text: string): string {
  for (let el: HTMLElement | null = screen.getByText(text); el; el = el.parentElement) {
    if (el.style.color) return el.style.color;
  }
  throw new Error('no element with an inline color');
}

describe('an unset text-label colour in the renderer', () => {
  it('renders the Text role, whose light and dark values the sheet carries', () => {
    render(wrap(<ScreenRenderer screen={doc([label('a', { text: 'plain' })])} />));
    expect(labelColor('plain')).toBe(`var(--cr-${TEXT}, ${LIGHT})`);

    const root = screen.getByTestId('screen-root');
    const sheet = document.querySelector(
      `style[data-canopy-scheme="${canopyDefaultFlat.meta.flatHash}"]`
    );
    const [light, dark] = (sheet?.textContent ?? '').split('\n');
    expect(light).toContain('[data-theme="light"]');
    expect(light).toContain(`--cr-${TEXT}:${LIGHT}`);
    expect(dark).toContain('[data-theme="dark"]');
    expect(dark).toContain(`--cr-${TEXT}:${DARK}`);

    expect(root.dataset.theme).toBe('light');
    act(() => setMode('dark'));
    expect(root.dataset.theme).toBe('dark');
    expect(labelColor('plain')).toBe(`var(--cr-${TEXT}, ${LIGHT})`);
  });

  it('follows the colorScheme prop and leaves an authored colour alone', () => {
    const scheme: FlatScheme = {
      ...canopyDefaultFlat,
      roles: ['OK', 'Text'],
      light: ['#00aa00', '#101010'],
      dark: ['#00ff00', '#efefef'],
      meta: { ...canopyDefaultFlat.meta, flatHash: 'site-hash' },
    };
    render(
      wrap(
        <ScreenRenderer
          colorScheme={scheme}
          screen={doc([
            label('a', { text: 'plain' }),
            label('b', { text: 'authored', foregroundColor: { $role: 'OK', fallback: '#00ff00' } }),
          ])}
        />
      )
    );
    expect(labelColor('plain')).toBe(`var(--cr-1, ${LIGHT})`);
    expect(labelColor('authored')).toBe('var(--cr-0, #00ff00)');
  });
});
