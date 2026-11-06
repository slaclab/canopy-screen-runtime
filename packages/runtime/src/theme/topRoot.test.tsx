// The top ScreenRenderer root mirrors the mode store onto data-theme and
// color-scheme imperatively: a store flip re-renders no WidgetNodeView.

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { MockPVService } from '@slaclab/canopy-client';
import { PVServiceProvider } from '@slaclab/canopy-react';
import type { ScreenJSON } from '@slaclab/canopy-screen-ir';
import { registerBuiltinWidgets } from '@slaclab/canopy-screen-widgets';
import { __setWidgetRenderProbe, ScreenRenderer } from '../render/ScreenRenderer.js';
import { setMode } from './modeStore.js';

const doc: ScreenJSON = {
  schemaVersion: '1.0',
  kind: 'screen',
  id: 's',
  metadata: { title: 's', source: { type: 'hand-authored' }, size: { width: 20, height: 20 } },
  macros: [],
  root: {
    id: 'r',
    type: 'absolute-canvas',
    props: {},
    geometry: { x: 0, y: 0, width: 20, height: 20 },
    children: [
      {
        id: 'a',
        type: 'text-label',
        props: { text: 'x' },
        geometry: { x: 0, y: 0, width: 10, height: 10 },
      },
    ],
  },
};

let service: MockPVService;

beforeAll(() => {
  registerBuiltinWidgets();
});

beforeEach(() => {
  service = new MockPVService();
  service.connect();
});

afterEach(() => {
  cleanup();
  service.disconnect();
  __setWidgetRenderProbe(null);
  setMode('light');
});

function renderScreen() {
  return render(
    <PVServiceProvider service={service}>
      <ScreenRenderer screen={doc} />
    </PVServiceProvider>
  );
}

describe('top root mode mirroring', () => {
  // Runs first, before any test writes the store.
  it('writes data-theme="light" and color-scheme: light from an unseeded store', () => {
    const root = renderScreen().getByTestId('screen-root');
    expect(root.dataset.theme).toBe('light');
    expect(root.style.colorScheme).toBe('light');
    expect(root.style.getPropertyValue('color-scheme')).toBe('light');
  });

  it('writes the attributes on a store flip without rendering any widget', () => {
    let renders = 0;
    __setWidgetRenderProbe(() => {
      renders += 1;
    });
    const root = renderScreen().getByTestId('screen-root');
    expect(renders).toBeGreaterThan(0);
    renders = 0;
    act(() => setMode('dark'));
    expect(root.dataset.theme).toBe('dark');
    expect(root.style.colorScheme).toBe('dark');
    act(() => setMode('light'));
    expect(root.dataset.theme).toBe('light');
    expect(root.style.colorScheme).toBe('light');
    expect(renders).toBe(0);
  });

  it('reads a mode seeded before mount', () => {
    setMode('dark');
    const root = renderScreen().getByTestId('screen-root');
    expect(root.dataset.theme).toBe('dark');
  });

  it('stops following the store after unmount', () => {
    const view = renderScreen();
    const root = view.getByTestId('screen-root');
    view.unmount();
    setMode('dark');
    expect(root.dataset.theme).toBe('light');
  });

  it('is a no-op probe when unset', () => {
    __setWidgetRenderProbe(null);
    expect(() => renderScreen()).not.toThrow();
  });
});
