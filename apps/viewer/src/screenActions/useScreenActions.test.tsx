// useScreenActions: the headless screen action runner. Pinned here: the
// verb view per tile state (no screen, Plot in Data Browser only when
// configured, nav flags, zoom, download); invoke reaching each handler and
// refusing an unavailable one; outcomes as status text or through notify;
// the relay hand-over with no bar; the bar path unchanged; and, in the
// workspace embedded in a host with one tile and no bar mounted, ⌘S / ⌘I / ⌘P
// reaching the tile with their outcome in the toast column.

import { createElement, useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Download, Link } from '@carbon/icons-react';
import type { Manifest } from '../api.js';
import { createBackendBadgeStore } from '../backendBadge.js';
import { EmbedThemeContext } from '../pages/EmbedPage.js';
import type { ScreenHistory } from '../ScreenHeader.js';
import { ServicesContext } from '../services.js';
import type { ViewerServices } from '../services.js';
import { resetHostEmbeddedForTests } from '../workspace/host/hostEmbed.js';
import { WorkspacePage } from '../workspace/WorkspacePage.js';
import { ZoomProvider } from '../ZoomContext.js';
import { ScreenActionBar, ShortcutRelayContext } from './ScreenActionBar.js';
import type { ShortcutRelay } from './ScreenActionBar.js';
import type { ScreenAction, ScreenTarget } from './types.js';
import {
  STATUS_MS,
  ScreenVerbRegistry,
  useScreenActions,
  useScreenVerbs,
} from './useScreenActions.js';
import type { ScreenActionTile } from './useScreenActions.js';

const fakes = vi.hoisted(() => {
  // Node 26's unusable global localStorage/sessionStorage shadow jsdom's.
  const memory = (): Storage => {
    const data = new Map<string, string>();
    return {
      get length() {
        return data.size;
      },
      clear: () => data.clear(),
      getItem: (key) => data.get(key) ?? null,
      key: (index) => [...data.keys()][index] ?? null,
      removeItem: (key) => void data.delete(key),
      setItem: (key, value) => void data.set(key, String(value)),
    };
  };
  const g = globalThis as { localStorage?: Storage; sessionStorage?: Storage };
  for (const name of ['localStorage', 'sessionStorage'] as const) {
    if (typeof g[name]?.getItem === 'function') continue;
    Object.defineProperty(globalThis, name, { configurable: true, value: memory() });
  }
  return {
    download: { calls: [] as string[] },
    exportPng: { calls: [] as string[] },
    print: { calls: [] as string[] },
  };
});

// The workspace's SCREEN_ACTIONS: the real ids and shortcuts, fake handlers
// that record the screen they ran on and report an outcome.
vi.mock('./actions.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./actions.js')>();
  const { Download: Icon } = await import('@carbon/icons-react');
  const fake = (
    id: string,
    label: string,
    shortcut: string,
    calls: string[],
    message: string
  ): ScreenAction => ({
    id,
    label,
    icon: Icon,
    shortcut,
    isAvailable: () => true,
    run: (ctx) => {
      calls.push(`${ctx.screen.category}/${ctx.screen.id}`);
      return Promise.resolve({ message });
    },
  });
  return {
    ...actual,
    SCREEN_ACTIONS: [
      fake('download', 'Download screen', 's', fakes.download.calls, 'Download started'),
      fake('export-png', 'Export PNG', 'i', fakes.exportPng.calls, 'PNG exported'),
      fake('print', 'Print', 'p', fakes.print.calls, 'Printed'),
    ],
  };
});

vi.mock('../pages/ScreenPage.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../pages/ScreenPage.js')>();
  function ScreenProbe(props: {
    category?: string;
    id?: string;
    onTitle?: (title: string) => void;
    onScreen?: (screen: unknown) => void;
  }) {
    const name = `${props.category ?? ''}/${props.id ?? ''}`;
    const { onScreen, onTitle } = props;
    useEffect(() => {
      onScreen?.({
        category: props.category ?? '',
        id: props.id ?? '',
        title: `Rendered ${props.id ?? ''}`,
        macros: {},
        element: null,
        documentUrl: `https://host/doc/${name}.screen.json`,
        reload: () => {},
      });
    }, [onScreen, name, props.category, props.id]);
    useEffect(() => {
      onTitle?.(`Rendered ${props.id ?? ''}`);
    }, [onTitle, props.id]);
    return createElement('div', { 'data-testid': 'screen-probe', 'data-id': props.id });
  }
  return { ...actual, ScreenPage: ScreenProbe };
});

const target: ScreenTarget = {
  category: 'bts',
  id: 'BTSView',
  title: 'BTS',
  macros: {},
  element: null,
  documentUrl: 'http://h/screens/bts/BTSView.screen.json',
  collectPVs: async () => [],
};

function action(id: string, overrides: Partial<ScreenAction> = {}): ScreenAction {
  return {
    id,
    label: id,
    icon: Download,
    isAvailable: () => true,
    run: vi.fn(),
    ...overrides,
  };
}

/** Plot in Data Browser's real availability rule (actions.ts). */
const plot = () =>
  action('plot-data-browser', {
    isAvailable: (ctx) => ctx.plotInDataBrowser !== undefined && !!ctx.screen.collectPVs,
  });

const history = (back: boolean, forward: boolean): ScreenHistory => ({
  back: { enabled: back, onClick: () => {} },
  forward: { enabled: forward, onClick: () => {} },
});

function tile(overrides: Partial<ScreenActionTile> = {}): ScreenActionTile {
  return { screen: target, zoom: { scale: 1, fit: false }, ...overrides };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useScreenActions: the verb view', () => {
  it('lists every verb in order with its availability, nav flags, zoom and download', () => {
    const actions = [plot(), action('reload'), action('download', { shortcut: 's' })];
    const { result } = renderHook(() =>
      useScreenActions(
        tile({ actions, zoom: { scale: 0.8, fit: true }, history: history(true, false) })
      )
    );
    expect(result.current.view).toEqual({
      canGoBack: true,
      canGoForward: false,
      verbs: [
        { id: 'plot-data-browser', available: false },
        { id: 'reload', available: true },
        { id: 'download', available: true },
      ],
      zoom: { scale: 0.8, fit: true },
      download: { available: true },
    });
  });

  it('offers Plot in Data Browser only when the data browser is configured', () => {
    const actions = [plot(), action('reload')];
    const { result } = renderHook(() =>
      useScreenActions(tile({ actions, plotInDataBrowser: () => {} }))
    );
    expect(result.current.view.verbs[0]).toEqual({ id: 'plot-data-browser', available: true });
  });

  it('without a screen: no verb, no download, no nav', () => {
    const actions = [action('reload'), action('download')];
    const { result } = renderHook(() => useScreenActions(tile({ actions, screen: null })));
    expect(result.current.ctx).toBeUndefined();
    expect(result.current.view.verbs.every((v) => !v.available)).toBe(true);
    expect(result.current.view.download).toEqual({ available: false });
    expect(result.current.view.canGoBack).toBe(false);
    expect(result.current.view.canGoForward).toBe(false);
    expect(result.current.invoke('reload')).toBe(false);
  });

  it('reports download unavailable when Download screen is', () => {
    const actions = [action('download', { isAvailable: () => false })];
    const { result } = renderHook(() => useScreenActions(tile({ actions })));
    expect(result.current.view.download).toEqual({ available: false });
  });

  it('the view follows the tile: zoom and history changes re-render it', () => {
    const actions = [action('reload')];
    const { result, rerender } = renderHook((props: ScreenActionTile) => useScreenActions(props), {
      initialProps: tile({ actions }),
    });
    const before = result.current.view;
    rerender(tile({ actions }));
    expect(result.current.view).toBe(before);
    rerender(tile({ actions, zoom: { scale: 2, fit: false }, history: history(false, true) }));
    expect(result.current.view.zoom).toEqual({ scale: 2, fit: false });
    expect(result.current.view.canGoForward).toBe(true);
  });
});

describe('useScreenActions: invoke and outcomes', () => {
  it('each invoke reaches its handler with the tile context', async () => {
    const actions = [action('reload'), action('download'), action('print'), action('copy-link')];
    const { result } = renderHook(() =>
      useScreenActions(tile({ actions, link: 'http://h/x', zoom: { scale: 2, fit: false } }))
    );
    for (const a of actions) {
      await act(async () => {
        expect(result.current.invoke(a.id)).toBe(true);
      });
      expect(a.run).toHaveBeenCalledTimes(1);
      expect(a.run).toHaveBeenCalledWith(
        expect.objectContaining({
          screen: target,
          link: 'http://h/x',
          zoom: { scale: 2, fit: false },
        })
      );
    }
  });

  it('refuses an unavailable or unknown id', () => {
    const hidden = action('hidden', { isAvailable: () => false });
    const { result } = renderHook(() => useScreenActions(tile({ actions: [hidden] })));
    expect(result.current.invoke('hidden')).toBe(false);
    expect(result.current.invoke('nope')).toBe(false);
    expect(hidden.run).not.toHaveBeenCalled();
  });

  it('drops a second run while the first is pending', async () => {
    let finish: () => void = () => {};
    const slow = action('slow', {
      run: vi.fn(() => new Promise<void>((resolve) => (finish = resolve))),
    });
    const { result } = renderHook(() => useScreenActions(tile({ actions: [slow] })));
    await act(async () => {
      result.current.invoke('slow');
      result.current.invoke('slow');
    });
    expect(slow.run).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    await act(async () => {
      result.current.invoke('slow');
    });
    expect(slow.run).toHaveBeenCalledTimes(2);
  });

  it('without notify: the outcome is status text that clears', async () => {
    vi.useFakeTimers();
    const copy = action('copy', { run: async () => ({ message: 'Copied' }) });
    const broken = action('broken', {
      label: 'Print',
      run: () => {
        throw new Error('no printer');
      },
    });
    const { result } = renderHook(() => useScreenActions(tile({ actions: [copy, broken] })));
    await act(async () => {
      result.current.invoke('copy');
    });
    expect(result.current.status).toEqual({ text: 'Copied', error: false });
    await act(async () => {
      result.current.invoke('broken');
    });
    expect(result.current.status).toEqual({ text: 'Print failed: no printer', error: true });
    act(() => {
      vi.advanceTimersByTime(STATUS_MS);
    });
    expect(result.current.status).toBeNull();
  });

  it('with notify: results and errors go there, not to the status', async () => {
    const notify = vi.fn();
    const copy = action('copy', { run: async () => ({ message: 'Copied' }) });
    const broken = action('broken', {
      label: 'Export PNG',
      run: () => Promise.reject(new Error('no canvas')),
    });
    const { result } = renderHook(() =>
      useScreenActions(tile({ actions: [copy, broken], notify }))
    );
    await act(async () => {
      result.current.invoke('copy');
    });
    await act(async () => {
      result.current.invoke('broken');
    });
    expect(notify.mock.calls).toEqual([
      ['Copied', false],
      ['Export PNG failed: no canvas', true],
    ]);
    expect(result.current.status).toBeNull();
  });
});

describe('useScreenActions: the relay with no bar mounted', () => {
  it('attaches the runner to the relay and detaches on unmount', async () => {
    let attached: ((a: ScreenAction) => void) | null = null;
    const detach = vi.fn();
    const relay: ShortcutRelay = {
      attach: (run) => {
        attached = run;
        return detach;
      },
    };
    const print = action('print', { shortcut: 'p' });
    const { unmount } = renderHook(() => useScreenActions(tile({ actions: [print], relay })));
    expect(attached).not.toBeNull();
    await act(async () => attached?.(print));
    expect(print.run).toHaveBeenCalledTimes(1);
    unmount();
    expect(detach).toHaveBeenCalledTimes(1);
  });

  it('attaches nothing without a relay', () => {
    const { result } = renderHook(() => useScreenActions(tile({ relay: null })));
    expect(result.current.view.verbs.length).toBeGreaterThan(0);
  });
});

describe('ScreenVerbRegistry', () => {
  it('publishes, re-renders readers, and withdraws', () => {
    const registry = new ScreenVerbRegistry();
    const { result } = renderHook(() => useScreenVerbs(registry, 'screen:bts/knob'));
    expect(result.current).toBeUndefined();
    const entry = {
      view: {
        canGoBack: false,
        canGoForward: false,
        verbs: [],
        zoom: { scale: 1, fit: true },
        download: { available: false },
      },
      invoke: () => false,
    };
    act(() => registry.set('screen:bts/knob', entry));
    expect(result.current).toBe(entry);
    act(() => registry.set('screen:bts/knob', undefined));
    expect(result.current).toBeUndefined();
  });
});

describe('ScreenActionBar on the hook: the bar path unchanged', () => {
  it('a click runs the action and its outcome shows in the bar', async () => {
    const copy = action('copy-link', {
      label: 'Copy link',
      icon: Link,
      run: vi.fn(async () => ({ message: 'Copied' })),
    });
    render(
      <ScreenActionBar ctx={{ screen: target, zoom: { scale: 1, fit: false } }} actions={[copy]} />
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
    });
    expect(copy.run).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('screen-action-status').textContent).toBe('Copied');
  });

  it('below a relay the bar hands over its runner and binds no listener', async () => {
    let attached: ((a: ScreenAction) => void) | null = null;
    const relay: ShortcutRelay = {
      attach: (run) => {
        attached = run;
        return () => {};
      },
    };
    const save = action('save', { label: 'Download screen', shortcut: 's' });
    render(
      <ShortcutRelayContext.Provider value={relay}>
        <ScreenActionBar
          ctx={{ screen: target, zoom: { scale: 1, fit: false } }}
          actions={[save]}
        />
      </ShortcutRelayContext.Provider>
    );
    await act(async () => {
      fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    });
    expect(save.run).not.toHaveBeenCalled();
    await act(async () => attached?.(save));
    expect(save.run).toHaveBeenCalledTimes(1);
  });

  it('standalone the bar binds its own shortcut', async () => {
    const save = action('save', { label: 'Download screen', shortcut: 's' });
    render(
      <ScreenActionBar ctx={{ screen: target, zoom: { scale: 1, fit: false } }} actions={[save]} />
    );
    await act(async () => {
      fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    });
    expect(save.run).toHaveBeenCalledTimes(1);
  });
});

// The workspace embedded in a host, one docked screen tile: no tile bar, no screen
// header, so no ScreenActionBar is mounted; the shortcuts still run.

const MANIFEST: Manifest = {
  screens: [
    {
      id: 'knob',
      kind: 'ir',
      title: 'Knob device',
      category: 'bts',
      path: 'screens/bts/knob.screen.json',
    },
  ],
};

const FAKE_PARENT = { postMessage: () => {} } as unknown as Window;

function renderWorkspace(path: string) {
  const backend = createBackendBadgeStore({
    backend: { name: 'example', label: 'Simulator', notice: null },
    binding: 'va@3',
  });
  const services = { backend } as unknown as ViewerServices;
  return render(
    <ServicesContext.Provider value={services}>
      <MemoryRouter initialEntries={[path]}>
        <ZoomProvider>
          <EmbedThemeContext.Provider
            value={{ mode: 'dark', id: 'dark', anchorRef: { current: null } }}
          >
            <WorkspacePage screensBaseUrl="https://host/screens" />
          </EmbedThemeContext.Provider>
        </ZoomProvider>
      </MemoryRouter>
    </ServicesContext.Provider>
  );
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('workspace embedded in a host, one tile, no bar: ⌘S ⌘I ⌘P', () => {
  beforeEach(() => {
    resetHostEmbeddedForTests();
    fakes.download.calls.length = 0;
    fakes.exportPng.calls.length = 0;
    fakes.print.calls.length = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(MANIFEST), { status: 200 }))
    );
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(window, 'parent', 'get').mockReturnValue(FAKE_PARENT);
    window.history.replaceState(null, '', '/?embedded=true');
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    window.history.replaceState(null, '', '/');
    resetHostEmbeddedForTests();
    for (const store of [globalThis.sessionStorage, globalThis.localStorage]) {
      try {
        store?.clear();
      } catch {
        // Storage unavailable: nothing to clear.
      }
    }
  });

  it('runs Download screen, Export PNG and Print on the tile and toasts the outcome', async () => {
    renderWorkspace('/embed/bts/knob');
    await screen.findByTestId('screen-probe');
    await settle();
    // No bar is mounted: no action button and no screen header anywhere.
    expect(document.querySelector('[data-screen-action]')).toBeNull();
    expect(document.querySelector('[data-testid="screen-header-title"]')).toBeNull();

    await act(async () => {
      fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    });
    expect(fakes.download.calls).toEqual(['bts/knob']);
    expect(await screen.findByText('Download started')).toBeTruthy();

    await act(async () => {
      fireEvent.keyDown(window, { key: 'i', ctrlKey: true });
    });
    expect(fakes.exportPng.calls).toEqual(['bts/knob']);
    expect(await screen.findByText('PNG exported')).toBeTruthy();

    await act(async () => {
      fireEvent.keyDown(window, { key: 'p', ctrlKey: true });
    });
    expect(fakes.print.calls).toEqual(['bts/knob']);
    expect(await screen.findByText('Printed')).toBeTruthy();
  });

  it('standalone, the lone tile keeps its bar, which runs ⌘S with its own status', async () => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    window.history.replaceState(null, '', '/');
    resetHostEmbeddedForTests();
    renderWorkspace('/embed/bts/knob');
    await screen.findByTestId('screen-probe');
    await settle();
    expect(document.querySelector('[data-screen-action="download"]')).not.toBeNull();
    await act(async () => {
      fireEvent.keyDown(window, { key: 's', ctrlKey: true });
    });
    expect(fakes.download.calls).toEqual(['bts/knob']);
    expect(screen.getByTestId('screen-action-status').textContent).toBe('Download started');
  });
});
