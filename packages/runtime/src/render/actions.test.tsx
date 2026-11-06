// Widget actions wired into the renderer: a click on a widget carrying
// `props.actions` runs dispatchActions with the instance PV service, the
// widget's macros, the declaring document and the ActionHost callbacks.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MockPVService } from '@slaclab/canopy-client';
import { PVServiceProvider } from '@slaclab/canopy-react';
import { WriteGate, registerBuiltinWidgets } from '@slaclab/canopy-screen-widgets';
import type { WriteGateService, WriteRequest } from '@slaclab/canopy-screen-widgets';
import type { PropertyValue, ScreenJSON, WidgetNode } from '@slaclab/canopy-screen-ir';
import { ScreenRenderer } from './ScreenRenderer.js';
import { ActionHostContext } from '../actions/ActionHostContext.js';
import type { ActionHost } from '../actions/ActionHostContext.js';

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
  vi.restoreAllMocks();
});

function makeHost() {
  return {
    resolveManifest: vi.fn<ActionHost['resolveManifest']>(() => '/view/details'),
    navigate: vi.fn<ActionHost['navigate']>(),
    openWindow: vi.fn<ActionHost['openWindow']>(),
    close: vi.fn<ActionHost['close']>(),
    showError: vi.fn<ActionHost['showError']>(),
  } satisfies ActionHost;
}

function wrap(children: ReactNode, host?: ActionHost) {
  const inner = host ? (
    <ActionHostContext.Provider value={host}>{children}</ActionHostContext.Provider>
  ) : (
    children
  );
  return <PVServiceProvider service={service}>{inner}</PVServiceProvider>;
}

function doc(id: string, children: WidgetNode[], macros: ScreenJSON['macros'] = []): ScreenJSON {
  return {
    schemaVersion: '1.0',
    kind: 'screen',
    id,
    metadata: { title: id, source: { type: 'hand-authored' }, size: { width: 400, height: 300 } },
    macros,
    root: {
      id: `${id}-root`,
      type: 'absolute-canvas',
      props: {},
      geometry: { x: 0, y: 0, width: 400, height: 300 },
      children,
    },
  };
}

function button(id: string, label: string, actions: unknown[]): WidgetNode {
  return {
    id,
    type: 'regular-button',
    props: { label, actions: actions as unknown as PropertyValue },
    geometry: { x: 10, y: 10, width: 100, height: 30 },
  };
}

describe('widget actions', () => {
  it('writes every write_pv action through the PV service on click, in order', async () => {
    const put = vi.spyOn(service, 'put');
    const screenJson = doc(
      'top',
      [
        button('b1', 'Go', [
          { type: 'write_pv', pvName: '${P}:A', value: 1 },
          { type: 'write_pv', pvName: 'X:B', value: 'on' },
        ]),
      ],
      [{ name: 'P', default: 'SYS' }]
    );
    render(wrap(<ScreenRenderer screen={screenJson} />));

    fireEvent.click(screen.getByRole('button', { name: 'Go' }));

    await waitFor(() => expect(put).toHaveBeenCalledTimes(2));
    expect(put.mock.calls[0]).toEqual(['SYS:A', 1]);
    expect(put.mock.calls[1]).toEqual(['X:B', 'on']);
  });

  it("sends a click's machine writes as one run of the provided WriteGate, loc:// on the router", async () => {
    const put = vi.spyOn(service, 'put');
    const runs: WriteRequest[][] = [];
    const gate: WriteGateService = {
      confirmWrites: () => true,
      run: async (writes) => {
        runs.push([...writes]);
        return writes.map(() => ({
          outcome: 'confirmed' as const,
          code: null,
          status: null,
          detail: 'written',
          coalesced: false,
        }));
      },
    };
    const screenJson = doc('top', [
      button('b1', 'Go', [
        { type: 'write_pv', pvName: 'SYS:A', value: 1 },
        { type: 'write_pv', pvName: 'loc://L', value: 5 },
        { type: 'write_pv', pvName: 'X:B', value: 'on' },
      ]),
    ]);
    render(
      wrap(
        <WriteGate.Provider value={gate}>
          <ScreenRenderer screen={screenJson} />
        </WriteGate.Provider>
      )
    );

    fireEvent.click(screen.getByRole('button', { name: 'Go' }));

    await waitFor(() => expect(runs).toHaveLength(1));
    expect(runs[0]).toEqual([
      { pv: 'SYS:A', value: 1 },
      { pv: 'X:B', value: 'on' },
    ]);
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put.mock.calls[0][0]).toBe('loc://L');
  });

  it('resolves open_display files against the declaring embedded document', async () => {
    const host = makeHost();
    const child = doc('child', [
      button('open', 'Details', [
        { type: 'open_display', file: '../details.screen.json', target: 'replace' },
      ]),
    ]);
    const parent = doc('parent', [
      {
        id: 'embed',
        type: 'embedded-display',
        props: { file: 'embedded/child' },
        geometry: { x: 0, y: 0, width: 300, height: 200 },
      },
    ]);
    const resolveScreen = vi.fn().mockResolvedValue(child);
    render(
      wrap(
        <ScreenRenderer screen={parent} screenPath="a/b/parent" resolveScreen={resolveScreen} />,
        host
      )
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Details' }));

    await waitFor(() => expect(host.navigate).toHaveBeenCalledWith('/view/details'));
    expect(host.resolveManifest).toHaveBeenCalledWith('a/b/details.screen.json');
  });

  it('attaches no click handler when the actions list is malformed', async () => {
    const put = vi.spyOn(service, 'put');
    const screenJson = doc('top', [
      button('b1', 'Bad', [
        { type: 'write_pv', pvName: 'X:A', value: 1 },
        { type: 'write_pv', pvName: 'X:B' },
      ]),
    ]);
    render(wrap(<ScreenRenderer screen={screenJson} />));

    fireEvent.click(screen.getByRole('button', { name: 'Bad' }));
    await new Promise((r) => setTimeout(r, 0));
    expect(put).not.toHaveBeenCalled();
  });

  it('works without an ActionHost provider (warn-only default)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const screenJson = doc('top', [button('c', 'Close', [{ type: 'close_display' }])]);
    render(wrap(<ScreenRenderer screen={screenJson} />));

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    await waitFor(() => expect(warn).toHaveBeenCalled());
    expect(String(warn.mock.calls[0][0])).toContain('ActionHost');
  });
});
