// The workspace's host header wiring (the contribution out, header actions
// in, ⌘S on a tool tab). Pinned here: host-embedded, the page contributes the
// composer's item list for the focused tab (a Trace tab with its
// canopy:tool-actions report, then a screen tab after a switch); a ⋯ pick the
// host posts back runs against the focused tile (`tool:import` ->
// canopy:tool-invoke to the tool frame); ⌘S with focus in the viewer on a
// tool tab with saved views opens Save view, and so does the tool frame's
// canopy:save-view (its ⌘S), which does nothing without saved views;
// standalone nothing is posted.
//
// Host-embedded is the real isHostEmbedded(): `?embedded=true` on the page URL
// and a parent window, stubbed through window.parent's getter, whose
// postMessage is a spy. ScreenPage is a probe reporting its open screen.

import { createElement, useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { Manifest } from '../api.js';
import { createBackendBadgeStore } from '../backendBadge.js';
import type { ViewerConfig } from '../config.js';
import { EmbedThemeContext } from '../pages/EmbedPage.js';
import { ServicesContext } from '../services.js';
import type { ViewerServices } from '../services.js';
import { ZoomProvider } from '../ZoomContext.js';
import { isMac } from '../screenActions/shortcuts.js';
import { composeHeader } from './host/headerComposer.js';
import type { HeaderInput } from './host/headerComposer.js';
import type { HeaderItem } from './host/hostBridge.js';
import {
  ACTION_TYPE,
  CONTRIBUTION_TYPE,
  resetHostBridgeForTests,
  sanitizeHeaderItems,
} from './host/hostBridge.js';
import { resetHostEmbeddedForTests } from './host/hostEmbed.js';
import { tabsStorageKey } from './tabs.js';
import { SAVE_VIEW, TOOL_ACTIONS, TOOL_INVOKE, parseToolActions } from './toolActionsStore.js';
import { WorkspacePage } from './WorkspacePage.js';

vi.hoisted(() => {
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

const BASE = 'https://host/screens';
const KNOB = 'bts/knob';
const TRACE_KEY = '@trace';
const CONFIG: ViewerConfig = {
  trace: { path: 'trace/', query: 'pv=A&range=-1h' },
  views: { path: 'views' },
} as ViewerConfig;

/** A Trace canopy:tool-actions report (TraceTab.test.tsx's sample). */
const REPORT = {
  type: TOOL_ACTIONS,
  version: 1,
  state: '1 curve · live',
  actions: [{ id: 'import', label: 'Import…', kind: 'button', shortcut: 'primary+O' }],
};

const parentPost = vi.fn();
const FAKE_PARENT = { postMessage: parentPost } as unknown as Window;

/** Make the page host-embedded: a parent window and `?embedded=true`. */
function hostEmbed(): void {
  vi.spyOn(window, 'parent', 'get').mockReturnValue(FAKE_PARENT);
  window.history.replaceState(null, '', '/?embedded=true');
}

function clearStorage(): void {
  for (const store of [globalThis.sessionStorage, globalThis.localStorage]) {
    try {
      store?.clear();
    } catch {
      // Storage unavailable: nothing to clear.
    }
  }
}

beforeEach(() => {
  resetHostEmbeddedForTests();
  resetHostBridgeForTests();
  parentPost.mockReset();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes('/views') ? { views: [] } : MANIFEST;
      return new Response(JSON.stringify(body), { status: 200 });
    })
  );
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
  resetHostEmbeddedForTests();
  resetHostBridgeForTests();
  clearStorage();
});

function renderAt(path: string, config: ViewerConfig = CONFIG) {
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
            <WorkspacePage screensBaseUrl={BASE} config={config} />
          </EmbedThemeContext.Provider>
        </ZoomProvider>
      </MemoryRouter>
    </ServicesContext.Provider>
  );
}

function storeTabs(keys: string[], active: string | null) {
  sessionStorage.setItem(
    tabsStorageKey('/'),
    JSON.stringify({ keys, active, instances: {}, toolMru: [TRACE_KEY] })
  );
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Every contribution posted to the parent, oldest first. */
function contributions(): unknown[] {
  return parentPost.mock.calls
    .map(([data]) => data as { type?: string; items?: unknown })
    .filter((d) => d?.type === CONTRIBUTION_TYPE)
    .map((d) => d.items);
}

function lastItems(): unknown {
  const all = contributions();
  return all[all.length - 1];
}

function traceFrame(): HTMLIFrameElement {
  const frame = document.querySelector<HTMLIFrameElement>('iframe');
  if (!frame?.contentWindow) throw new Error('no tool frame');
  return frame;
}

/** Post a message to the page as `source` at our own origin. */
function send(source: Window, data: unknown): void {
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', { data, origin: window.location.origin, source })
    );
  });
}

/** The items the host should receive for the composer's input (wire form). */
function expected(overrides: Partial<HeaderInput>): HeaderItem[] {
  return sanitizeHeaderItems(
    composeHeader({
      activeTab: null,
      screenView: null,
      toolActions: null,
      savedViewsEnabled: true,
      collectionsEnabled: false,
      dockAvailable: true,
      resetDisabled: true,
      multiTile: false,
      health: 'healthy',
      showSubScreens: false,
      ...overrides,
    })
  );
}

describe('host header wiring', () => {
  it('contributes the Trace tab header with its tool-actions report, then the screen tab header', async () => {
    hostEmbed();
    storeTabs([TRACE_KEY, KNOB], TRACE_KEY);
    renderAt(`/embed/${TRACE_KEY}`);
    await waitFor(() => expect(document.querySelector('iframe')).not.toBeNull());
    await settle();
    const frame = traceFrame();
    send(frame.contentWindow!, REPORT);
    await settle();

    const dockAvailable = document.querySelector('.dv-dockview') !== null;
    const items = lastItems() as { id: string }[];
    expect(items).toEqual(
      expected({
        activeTab: { kind: 'tool', title: 'Data Browser' },
        toolActions: parseToolActions(REPORT),
        dockAvailable,
      })
    );
    // A tool tab with saved views offers Save view and the tool's ⋯ entry.
    expect(JSON.stringify(items)).toContain('tool:import');
    expect(items.some((i) => i.id === 'save-view')).toBe(true);

    const before = contributions().length;
    fireEvent.click(screen.getByRole('tab', { name: /Knob device|Rendered knob/ }));
    await screen.findByTestId('screen-probe');
    await settle();
    expect(contributions().length).toBeGreaterThan(before);
    const screenItems = lastItems() as { id: string }[];
    expect(screenItems.some((i) => i.id === 'save-view')).toBe(false);
    expect(JSON.stringify(screenItems)).not.toContain('tool:import');
    expect(JSON.stringify(screenItems)).toContain('bts/knob');
  });

  it('a host ⋯ pick of tool:import posts canopy:tool-invoke to the focused tool frame', async () => {
    hostEmbed();
    storeTabs([TRACE_KEY], TRACE_KEY);
    renderAt(`/embed/${TRACE_KEY}`);
    await waitFor(() => expect(document.querySelector('iframe')).not.toBeNull());
    await settle();
    const frame = traceFrame();
    const framePost = vi.spyOn(frame.contentWindow!, 'postMessage');
    send(frame.contentWindow!, REPORT);
    await settle();
    send(FAKE_PARENT, { type: ACTION_TYPE, id: 'more', value: 'tool:import' });
    expect(framePost).toHaveBeenCalledWith(
      { type: TOOL_INVOKE, id: 'import' },
      window.location.origin
    );
  });

  it('⌘S with focus in the viewer on a tool tab opens Save view', async () => {
    hostEmbed();
    storeTabs([TRACE_KEY], TRACE_KEY);
    renderAt(`/embed/${TRACE_KEY}`);
    await waitFor(() => expect(document.querySelector('iframe')).not.toBeNull());
    await settle();
    const event = new KeyboardEvent('keydown', {
      key: 's',
      code: 'KeyS',
      metaKey: isMac,
      ctrlKey: !isMac,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      window.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });

  it('the tool frame’s canopy:save-view opens Save view for its instance', async () => {
    hostEmbed();
    storeTabs([TRACE_KEY], TRACE_KEY);
    renderAt(`/embed/${TRACE_KEY}`);
    await waitFor(() => expect(document.querySelector('iframe')).not.toBeNull());
    await settle();
    expect(screen.queryByRole('dialog')).toBeNull();
    send(traceFrame().contentWindow!, { type: SAVE_VIEW });
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });

  it('without saved views the tool frame’s canopy:save-view does nothing', async () => {
    hostEmbed();
    storeTabs([TRACE_KEY], TRACE_KEY);
    const withoutViews: ViewerConfig = { ...CONFIG };
    delete withoutViews.views;
    renderAt(`/embed/${TRACE_KEY}`, withoutViews);
    await waitFor(() => expect(document.querySelector('iframe')).not.toBeNull());
    await settle();
    send(traceFrame().contentWindow!, { type: SAVE_VIEW });
    await settle();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('standalone: nothing is posted to a parent header', async () => {
    storeTabs([TRACE_KEY], TRACE_KEY);
    renderAt(`/embed/${TRACE_KEY}`);
    await waitFor(() => expect(document.querySelector('iframe')).not.toBeNull());
    await settle();
    expect(contributions()).toEqual([]);
    expect(parentPost).not.toHaveBeenCalled();
  });
});
