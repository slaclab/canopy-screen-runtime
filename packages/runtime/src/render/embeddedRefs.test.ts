// Embedded screen refs through the renderer: each ref resolves against the
// document that declares it, and two spellings of one document are a cycle.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { MockPVService } from '@slaclab/canopy-client';
import { PVServiceProvider } from '@slaclab/canopy-react';
import { registerBuiltinWidgets } from '@slaclab/canopy-screen-widgets';
import type { ScreenJSON, WidgetNode } from '@slaclab/canopy-screen-ir';
import { ScreenRenderer } from './ScreenRenderer.js';

function doc(id: string, root: WidgetNode): ScreenJSON {
  return {
    schemaVersion: '1.0',
    kind: 'screen',
    id,
    metadata: { title: id, source: { type: 'hand-authored' }, size: { width: 200, height: 100 } },
    macros: [],
    root,
  };
}

function embedding(id: string, file: string): ScreenJSON {
  return doc(id, {
    id: `${id}-root`,
    type: 'absolute-canvas',
    props: {},
    geometry: { x: 0, y: 0, width: 200, height: 100 },
    children: [
      {
        id: `${id}-embed`,
        type: 'embedded-display',
        props: { file },
        geometry: { x: 0, y: 0, width: 200, height: 100 },
      },
    ],
  });
}

function label(id: string, text: string): ScreenJSON {
  return doc(id, {
    id: `${id}-root`,
    type: 'text-label',
    props: { text },
    geometry: { x: 0, y: 0, width: 100, height: 20 },
  });
}

describe('EmbeddedScreenNode ref resolution', () => {
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
  });

  function show(
    top: ScreenJSON,
    resolveScreen: (ref: string) => Promise<ScreenJSON>,
    path?: string
  ) {
    render(
      createElement(PVServiceProvider, {
        service,
        children: createElement(ScreenRenderer, { screen: top, resolveScreen, screenPath: path }),
      })
    );
  }

  it('resolves a nested embed against its parent document', async () => {
    const screens: Record<string, ScreenJSON> = {
      'a/b/embedded/child': embedding('child', '../details'),
      'a/b/details': label('details', 'nested-ok'),
    };
    const resolveScreen = vi.fn((ref: string) =>
      screens[ref] ? Promise.resolve(screens[ref]) : Promise.reject(new Error(`no ${ref}`))
    );
    show(embedding('top', 'embedded/child'), resolveScreen, 'a/b/top');

    expect(await screen.findByText('nested-ok')).toBeTruthy();
    expect(resolveScreen.mock.calls.map((c) => c[0])).toEqual([
      'a/b/embedded/child',
      'a/b/details',
    ]);
  });

  it('without screenPath, hands out paths relative to the top document directory', async () => {
    const screens: Record<string, ScreenJSON> = {
      'embedded/child': embedding('child', 'grand'),
      'embedded/grand': label('grand', 'relative-ok'),
    };
    const resolveScreen = vi.fn((ref: string) =>
      screens[ref] ? Promise.resolve(screens[ref]) : Promise.reject(new Error(`no ${ref}`))
    );
    show(embedding('top', 'embedded/child'), resolveScreen);

    expect(await screen.findByText('relative-ok')).toBeTruthy();
    expect(resolveScreen.mock.calls.map((c) => c[0])).toEqual(['embedded/child', 'embedded/grand']);
  });

  it('treats differently-spelled refs to the same document as a cycle', async () => {
    const screens: Record<string, ScreenJSON> = {
      'a/sub/child': embedding('child', '../top'),
    };
    const resolveScreen = vi.fn((ref: string) =>
      screens[ref] ? Promise.resolve(screens[ref]) : Promise.reject(new Error(`no ${ref}`))
    );
    show(embedding('top', './sub/child'), resolveScreen, 'a/top');

    const box = await screen.findByTestId('widget-error');
    expect(box.textContent).toContain('cycle');
    expect(resolveScreen).toHaveBeenCalledTimes(1);
  });
});
