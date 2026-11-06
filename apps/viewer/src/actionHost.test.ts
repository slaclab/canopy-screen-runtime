// The viewer's ActionHost: manifest reverse lookup to /s/ or /embed/ URLs
// (refetching a stale manifest once on a miss), in-place navigation,
// new-window opening (basename-prefixed, http(s)/root-relative only), close
// and error surfacing.

import { createElement, useContext, useState } from 'react';
import type { ReactNode } from 'react';
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActionHostContext, warnOnlyActionHost } from '@slaclab/canopy-screen-runtime';
import type { Manifest } from './api.js';
import { App } from './App.js';
import {
  createActionHost,
  isOpenableUrl,
  normalizePath,
  routeOf,
  screenPathForLocation,
  screenUrl,
  useViewerActionHost,
} from './actionHost.js';
import type { ActionHostDeps, WorkspaceTabs } from './actionHost.js';
import { tabsStorageKey } from './workspace/tabs.js';
import { DOCK_VERSION, removeDock, writeDock } from './workspace/dock/storage.js';

// Node >= 25 ships an experimental global `localStorage` that is undefined
// unless --localstorage-file is given, and it shadows jsdom's. canopy-shell's
// themeStore (imported through App) reads localStorage at import time, so
// install an in-memory one first (vi.hoisted runs before the imports).
vi.hoisted(() => {
  let usable = false;
  try {
    usable = typeof globalThis.localStorage?.getItem === 'function';
  } catch {
    // Reading the Node global can throw; treat that as unusable.
  }
  if (usable) return;
  const store = new Map<string, string>();
  const memory = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, String(value)),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  };
  for (const target of [globalThis, globalThis.window]) {
    if (target)
      Object.defineProperty(target, 'localStorage', { configurable: true, value: memory });
  }
});

// The workspace's screens are replaced by a probe that reads the host it is
// given, so the provider wiring is tested without rendering a screen. Its
// buttons are named after the screen id, so a test can act from one tile.
let probedHost: unknown = null;
vi.mock('./pages/ScreenPage.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./pages/ScreenPage.js')>();
  return {
    ...actual,
    ScreenPage: function ScreenProbe({ id }: { id: string }) {
      const host = useContext(ActionHostContext);
      probedHost = host;
      const [resolved, setResolved] = useState('');
      const button = (name: string, onClick: () => void) =>
        createElement('button', { type: 'button', onClick }, name);
      return createElement(
        'div',
        null,
        button('fail', () => host.showError('No screen for x.screen.json')),
        button(`fail from ${id}`, () => host.showError(`Failed on ${id}`)),
        button(`navigate from ${id}`, () => host.navigate('/embed/common/common-magnet')),
        button(`close ${id}`, () => host.close()),
        button(`resolve from ${id}`, () => {
          void Promise.resolve(host.resolveManifest?.('../../common/magnet.screen.json')).then(
            (url) => setResolved(String(url))
          );
        }),
        createElement('output', { 'data-testid': `resolved ${id}` }, resolved)
      );
    },
  };
});

const MANIFEST: Manifest = {
  screens: [
    {
      id: 'knob-device',
      kind: 'ir',
      title: 'Knob device',
      category: 'bts',
      path: 'screens/bts/knob-device.screen.json',
    },
    {
      id: 'CBXFEL/Landing',
      kind: 'ir',
      title: 'Landing',
      category: 'cbx fel',
      path: 'screens/cbxfel/CBXFEL/Landing.screen.json',
    },
    {
      id: 'common-magnet',
      kind: 'ir',
      title: 'Magnet',
      category: 'common',
      path: 'screens/common/magnet.screen.json',
    },
    {
      id: 'code-screen',
      kind: 'code',
      title: 'Code',
      category: 'bts',
      path: 'screens/bts/code-screen.screen.json',
    },
  ],
};

const DRAFTS: Manifest = {
  screens: [
    { id: 'a', kind: 'ir', title: 'A', category: 'drafts', path: 'screens/drafts/a.screen.json' },
    { id: 'b', kind: 'ir', title: 'B', category: 'drafts', path: 'screens/drafts/b.screen.json' },
  ],
};

function makeDeps(overrides: Partial<ActionHostDeps> = {}) {
  return {
    loadManifest: vi.fn<ActionHostDeps['loadManifest']>(async () => MANIFEST),
    currentPathname: vi.fn<ActionHostDeps['currentPathname']>(() => '/'),
    navigate: vi.fn<ActionHostDeps['navigate']>(),
    openWindow: vi.fn<ActionHostDeps['openWindow']>(),
    close: vi.fn<ActionHostDeps['close']>(),
    showError: vi.fn<ActionHostDeps['showError']>(),
    ...overrides,
  } satisfies ActionHostDeps;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('normalizePath', () => {
  it('drops leading slashes and ./ and folds ..', () => {
    expect(normalizePath('/screens/./bts/../bts/x.screen.json')).toBe('screens/bts/x.screen.json');
  });
  it('keeps a leading .. that escapes the root', () => {
    expect(normalizePath('../x.screen.json')).toBe('../x.screen.json');
  });
});

describe('screenUrl', () => {
  it('encodes the category and each id segment, keeping slashes', () => {
    expect(screenUrl(MANIFEST.screens[1]!)).toBe('/s/cbx%20fel/CBXFEL/Landing');
    expect(screenUrl(MANIFEST.screens[0]!)).toBe('/s/bts/knob-device');
  });
  it('uses the given route prefix', () => {
    expect(screenUrl(MANIFEST.screens[1]!, 'embed')).toBe('/embed/cbx%20fel/CBXFEL/Landing');
    expect(screenUrl(MANIFEST.screens[0]!, 's')).toBe('/s/bts/knob-device');
  });
});

describe('routeOf', () => {
  it('is embed on /embed/ and s everywhere else', () => {
    expect(routeOf('/embed/drafts/a')).toBe('embed');
    expect(routeOf('/s/drafts/a')).toBe('s');
    expect(routeOf('/')).toBe('s');
    expect(routeOf('/embedded/x')).toBe('s');
  });
});

describe('isOpenableUrl', () => {
  it('allows http, https and root-relative paths', () => {
    expect(isOpenableUrl('https://example.org/x')).toBe(true);
    expect(isOpenableUrl('http://example.org/')).toBe(true);
    expect(isOpenableUrl('/docs/help.html')).toBe(true);
  });
  it('refuses other schemes, protocol-relative and document-relative URLs', () => {
    expect(isOpenableUrl('javascript:alert(1)')).toBe(false);
    expect(isOpenableUrl('JavaScript:alert(1)')).toBe(false);
    expect(isOpenableUrl('data:text/html,<script>1</script>')).toBe(false);
    expect(isOpenableUrl('file:///etc/passwd')).toBe(false);
    expect(isOpenableUrl('//evil.example/')).toBe(false);
    expect(isOpenableUrl('/\\evil.example/')).toBe(false);
    expect(isOpenableUrl('help.html')).toBe(false);
    expect(isOpenableUrl('')).toBe(false);
  });
});

describe('screenPathForLocation', () => {
  it('maps a /s/ pathname back to the manifest path', () => {
    expect(screenPathForLocation(MANIFEST, '/s/cbx%20fel/CBXFEL/Landing')).toBe(
      'screens/cbxfel/CBXFEL/Landing.screen.json'
    );
  });
  it('is undefined off the screen route or for an unknown screen', () => {
    expect(screenPathForLocation(MANIFEST, '/')).toBeUndefined();
    expect(screenPathForLocation(MANIFEST, '/s/bts/nope')).toBeUndefined();
    expect(screenPathForLocation(MANIFEST, '/s/%E0%A4%A')).toBeUndefined();
  });
  it('maps an /embed/ pathname back to the manifest path', () => {
    expect(screenPathForLocation(MANIFEST, '/embed/bts/knob-device')).toBe(
      'screens/bts/knob-device.screen.json'
    );
  });
});

describe('createActionHost.resolveManifest', () => {
  it('reverse-looks-up a manifest-root path to its /s/ URL', async () => {
    const host = createActionHost(makeDeps());
    await expect(host.resolveManifest('screens/bts/knob-device.screen.json')).resolves.toBe(
      '/s/bts/knob-device'
    );
  });

  it('resolves a path relative to the current screen directory', async () => {
    const deps = makeDeps({ currentPathname: () => '/s/bts/knob-device' });
    const host = createActionHost(deps);
    await expect(host.resolveManifest('../common/magnet.screen.json')).resolves.toBe(
      '/s/common/common-magnet'
    );
    await expect(host.resolveManifest('./knob-device.screen.json')).resolves.toBe(
      '/s/bts/knob-device'
    );
  });

  it('returns null for an unknown file or a non-ir screen', async () => {
    const host = createActionHost(makeDeps());
    await expect(host.resolveManifest('screens/bts/missing.screen.json')).resolves.toBeNull();
    await expect(host.resolveManifest('screens/bts/code-screen.screen.json')).resolves.toBeNull();
  });

  it('loads the manifest once across lookups', async () => {
    const deps = makeDeps();
    const host = createActionHost(deps);
    await host.resolveManifest('screens/bts/knob-device.screen.json');
    await host.resolveManifest('screens/common/magnet.screen.json');
    expect(deps.loadManifest).toHaveBeenCalledTimes(1);
  });

  it('keeps the /embed/ prefix of the current screen', async () => {
    const host = createActionHost(
      makeDeps({ currentPathname: () => '/embed/drafts/a', loadManifest: async () => DRAFTS })
    );
    await expect(host.resolveManifest('b.screen.json')).resolves.toBe('/embed/drafts/b');
    await expect(host.resolveManifest('screens/drafts/b.screen.json')).resolves.toBe(
      '/embed/drafts/b'
    );
  });

  it('refetches the manifest once past the cache on a miss, then finds the new screen', async () => {
    const onlyA: Manifest = { screens: [DRAFTS.screens[0]!] };
    let current = onlyA;
    const loadManifest = vi.fn<ActionHostDeps['loadManifest']>(async () => current);
    const host = createActionHost(
      makeDeps({ loadManifest, currentPathname: () => '/embed/drafts/a' })
    );

    await expect(host.resolveManifest('b.screen.json')).resolves.toBeNull();
    expect(loadManifest).toHaveBeenCalledTimes(2);
    expect(loadManifest).toHaveBeenLastCalledWith({ fresh: true });

    current = DRAFTS; // b is published
    await expect(host.resolveManifest('b.screen.json')).resolves.toBe('/embed/drafts/b');
    expect(loadManifest).toHaveBeenCalledTimes(3);
    expect(loadManifest).toHaveBeenLastCalledWith({ fresh: true });

    // The refreshed manifest is now the cached one: hits do not refetch.
    await expect(host.resolveManifest('a.screen.json')).resolves.toBe('/embed/drafts/a');
    await expect(host.resolveManifest('b.screen.json')).resolves.toBe('/embed/drafts/b');
    expect(loadManifest).toHaveBeenCalledTimes(3);
  });

  it('does not refetch on a hit', async () => {
    const deps = makeDeps();
    const host = createActionHost(deps);
    await host.resolveManifest('screens/bts/knob-device.screen.json');
    expect(deps.loadManifest).toHaveBeenCalledOnce();
    expect(deps.loadManifest).toHaveBeenCalledWith(undefined);
  });

  it('rejects on a manifest failure and retries on the next lookup', async () => {
    const loadManifest = vi
      .fn<ActionHostDeps['loadManifest']>()
      .mockRejectedValueOnce(new Error('404 fetching manifest'))
      .mockResolvedValue(MANIFEST);
    const host = createActionHost(makeDeps({ loadManifest }));
    await expect(host.resolveManifest('screens/bts/knob-device.screen.json')).rejects.toThrow(
      '404'
    );
    await expect(host.resolveManifest('screens/bts/knob-device.screen.json')).resolves.toBe(
      '/s/bts/knob-device'
    );
  });
});

describe('createActionHost callbacks', () => {
  it('passes navigate, openWindow, close and showError through', () => {
    const deps = makeDeps();
    const host = createActionHost(deps);
    host.navigate('/s/bts/knob-device?P=X');
    host.openWindow('/s/bts/knob-device');
    host.close();
    host.showError('No screen for x.screen.json');
    expect(deps.navigate).toHaveBeenCalledWith('/s/bts/knob-device?P=X');
    expect(deps.openWindow).toHaveBeenCalledWith('/s/bts/knob-device');
    expect(deps.close).toHaveBeenCalledOnce();
    expect(deps.showError).toHaveBeenCalledWith('No screen for x.screen.json');
  });

  it('refuses a javascript: URL through showError without opening it', () => {
    const deps = makeDeps();
    const host = createActionHost(deps);
    host.openWindow('javascript:alert(1)');
    expect(deps.openWindow).not.toHaveBeenCalled();
    expect(deps.showError).toHaveBeenCalledOnce();
    expect(deps.showError).toHaveBeenCalledWith(expect.stringContaining('javascript:alert(1)'));
  });

  it('prefixes the basename only for screen URLs it resolved', async () => {
    const deps = makeDeps({
      basename: '/x/y',
      currentPathname: () => '/embed/drafts/a',
      loadManifest: async () => DRAFTS,
    });
    const host = createActionHost(deps);
    const url = await host.resolveManifest('b.screen.json');
    expect(url).toBe('/embed/drafts/b');
    host.openWindow(`${url}?M=1`);
    expect(deps.openWindow).toHaveBeenLastCalledWith('/x/y/embed/drafts/b?M=1');
    // A root-relative open_webpage URL is opened exactly as written.
    host.openWindow('/docs/help.html');
    expect(deps.openWindow).toHaveBeenLastCalledWith('/docs/help.html');
    host.openWindow('https://example.org/');
    expect(deps.openWindow).toHaveBeenLastCalledWith('https://example.org/');
    // Navigation stays router-relative.
    host.navigate(url!);
    expect(deps.navigate).toHaveBeenLastCalledWith('/embed/drafts/b');
  });

  it('adds nothing for a root basename', async () => {
    const deps = makeDeps({ basename: '/', loadManifest: async () => DRAFTS });
    const host = createActionHost(deps);
    const url = await host.resolveManifest('screens/drafts/b.screen.json');
    host.openWindow(url!);
    expect(deps.openWindow).toHaveBeenLastCalledWith('/s/drafts/b');
  });
});

describe('useViewerActionHost', () => {
  function wrapper({ children }: { children: ReactNode }) {
    return createElement(MemoryRouter, { initialEntries: ['/s/bts/knob-device'] }, children);
  }

  function renderViewerHost() {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(MANIFEST), { status: 200 }))
    );
    return renderHook(
      () => ({ viewer: useViewerActionHost('https://host/screens'), location: useLocation() }),
      { wrapper }
    );
  }

  it('navigates in place through the router', () => {
    const { result } = renderViewerHost();
    act(() => result.current.viewer.host.navigate('/s/common/common-magnet?P=Q'));
    expect(result.current.location.pathname).toBe('/s/common/common-magnet');
    expect(result.current.location.search).toBe('?P=Q');
  });

  it('opens a new window with _blank', () => {
    const open = vi.fn(() => null);
    vi.stubGlobal('open', open);
    const { result } = renderViewerHost();
    result.current.viewer.host.openWindow('/s/bts/knob-device');
    expect(open).toHaveBeenCalledWith('/s/bts/knob-device', '_blank');
  });

  it('opens an external page without an opener', () => {
    const open = vi.fn(() => null);
    vi.stubGlobal('open', open);
    const { result } = renderViewerHost();
    result.current.viewer.host.openWindow('https://example.org/');
    expect(open).toHaveBeenCalledWith('https://example.org/', '_blank', 'noopener');
  });

  it('resolves against the current screen through the fetched manifest', async () => {
    const { result } = renderViewerHost();
    await expect(
      result.current.viewer.host.resolveManifest('../common/magnet.screen.json')
    ).resolves.toBe('/s/common/common-magnet');
  });

  it('surfaces showError as state, cleared by clearError and by navigation', () => {
    const { result } = renderViewerHost();
    act(() => result.current.viewer.host.showError('No screen for x.screen.json'));
    expect(result.current.viewer.error).toBe('No screen for x.screen.json');
    act(() => result.current.viewer.clearError());
    expect(result.current.viewer.error).toBeNull();

    act(() => result.current.viewer.host.showError('again'));
    act(() => result.current.viewer.host.navigate('/s/common/common-magnet'));
    expect(result.current.viewer.error).toBeNull();
  });

  it('closes the window when there is no history to go back to', () => {
    const close = vi.spyOn(window, 'close').mockImplementation(() => {});
    const { result } = renderViewerHost();
    result.current.viewer.host.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it('refetches the manifest with cache: no-cache on a miss', async () => {
    const { result } = renderViewerHost();
    const fetch = vi.mocked(globalThis.fetch);
    await expect(
      result.current.viewer.host.resolveManifest('screens/nope.screen.json')
    ).resolves.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0]).toEqual(['https://host/screens/manifest.json']);
    expect(fetch.mock.calls[1]).toEqual([
      'https://host/screens/manifest.json',
      { cache: 'no-cache' },
    ]);
  });

  it('refuses a javascript: URL with an error instead of window.open', () => {
    const open = vi.fn(() => null);
    vi.stubGlobal('open', open);
    const { result } = renderViewerHost();
    act(() => result.current.viewer.host.openWindow('javascript:alert(1)'));
    expect(open).not.toHaveBeenCalled();
    expect(result.current.viewer.error).toContain('javascript:alert(1)');
  });

  it('keeps the same host across re-renders', () => {
    const { result, rerender } = renderViewerHost();
    const first = result.current.viewer.host;
    rerender();
    expect(result.current.viewer.host).toBe(first);
  });
});

describe('App ActionHost provider', () => {
  it('provides the viewer host to a workspace screen and renders showError as an ErrorPanel', async () => {
    probedHost = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(MANIFEST), { status: 200 }))
    );
    render(
      createElement(
        MemoryRouter,
        { initialEntries: ['/embed/bts/knob-device'] },
        createElement(App, { screensBaseUrl: 'https://host/screens' })
      )
    );
    fireEvent.click(await screen.findByRole('button', { name: 'fail' }));
    expect(probedHost).not.toBeNull();
    expect(probedHost).not.toBe(warnOnlyActionHost);
    // The dock mounts dockview's own role="alert" live region, so the
    // ErrorPanel is picked out by its class rather than by role alone.
    const errorPanel = screen
      .getAllByRole('alert')
      .find((el) => el.classList.contains('viewer-error'));
    expect(errorPanel).toBeDefined();
    expect(errorPanel?.textContent).toContain('No screen for x.screen.json');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(document.querySelector('.viewer-error')).toBeNull();
  });
});

describe('useViewerActionHost under a basename on /embed/', () => {
  function wrapper({ children }: { children: ReactNode }) {
    return createElement(
      MemoryRouter,
      { basename: '/x/y', initialEntries: ['/x/y/embed/drafts/a'] },
      children
    );
  }

  function renderEmbedHost() {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(DRAFTS), { status: 200 }))
    );
    return renderHook(
      () => ({ viewer: useViewerActionHost('https://host/x/y/screens'), location: useLocation() }),
      { wrapper }
    );
  }

  it('resolves to a router-relative /embed/ URL', async () => {
    const { result } = renderEmbedHost();
    await expect(result.current.viewer.host.resolveManifest('b.screen.json')).resolves.toBe(
      '/embed/drafts/b'
    );
  });

  it('opens a resolved screen in a tab under the basename', async () => {
    const open = vi.fn(() => null);
    vi.stubGlobal('open', open);
    const { result } = renderEmbedHost();
    const url = await result.current.viewer.host.resolveManifest('b.screen.json');
    result.current.viewer.host.openWindow(url!);
    expect(open).toHaveBeenCalledWith('/x/y/embed/drafts/b', '_blank');
  });

  it('navigates in place without doubling the basename', async () => {
    const { result } = renderEmbedHost();
    const url = await result.current.viewer.host.resolveManifest('b.screen.json');
    act(() => result.current.viewer.host.navigate(url!));
    expect(result.current.location.pathname).toBe('/embed/drafts/b');
  });

  it('opens a root-relative web page as written', () => {
    const open = vi.fn(() => null);
    vi.stubGlobal('open', open);
    const { result } = renderEmbedHost();
    result.current.viewer.host.openWindow('/docs/help.html');
    expect(open).toHaveBeenCalledWith('/docs/help.html', '_blank');
  });
});

describe('createActionHost openTab', () => {
  it('hands a resolved screen to openTab instead of a window', async () => {
    const openTab = vi.fn<NonNullable<ActionHostDeps['openTab']>>(() => true);
    const deps = makeDeps({ currentPathname: () => '/embed/bts/knob-device', openTab });
    const host = createActionHost({ ...deps, basename: '/x/y' });
    const url = await host.resolveManifest('screens/common/magnet.screen.json');
    host.openWindow(`${url}?P=1`);
    expect(openTab).toHaveBeenCalledWith('/embed/common/common-magnet?P=1');
    expect(deps.openWindow).not.toHaveBeenCalled();
  });

  it('falls back to a basename-prefixed window when openTab declines', async () => {
    const openTab = vi.fn<NonNullable<ActionHostDeps['openTab']>>(() => false);
    const deps = makeDeps({ currentPathname: () => '/embed/bts/knob-device', openTab });
    const host = createActionHost({ ...deps, basename: '/x/y' });
    const url = await host.resolveManifest('screens/common/magnet.screen.json');
    host.openWindow(url!);
    expect(deps.openWindow).toHaveBeenCalledWith('/x/y/embed/common/common-magnet');
  });

  it('never offers a non-screen URL to openTab', () => {
    const openTab = vi.fn<NonNullable<ActionHostDeps['openTab']>>(() => true);
    const deps = makeDeps({ openTab });
    const host = createActionHost(deps);
    host.openWindow('/docs/help.html');
    host.openWindow('https://example.org/');
    expect(openTab).not.toHaveBeenCalled();
    expect(deps.openWindow).toHaveBeenCalledTimes(2);
  });
});

describe('useViewerActionHost with workspace tabs', () => {
  function wrapper({ children }: { children: ReactNode }) {
    return createElement(
      MemoryRouter,
      { basename: '/x/y', initialEntries: ['/x/y/embed/bts/knob-device'] },
      children
    );
  }

  function makeTabs(pathname?: string) {
    return {
      open: vi.fn<(url: string, mode: 'replace' | 'append') => void>(),
      close: vi.fn<() => void>(),
      currentPathname: vi.fn<() => string | undefined>(() => pathname),
    };
  }

  function renderTabsHost(tabs: ReturnType<typeof makeTabs>) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(MANIFEST), { status: 200 }))
    );
    return renderHook(
      ({ t }) => ({
        viewer: useViewerActionHost('https://host/x/y/screens', t),
        location: useLocation(),
      }),
      { wrapper, initialProps: { t: tabs } }
    );
  }

  it('navigate opens the screen in the active tab, not through the router', () => {
    const tabs = makeTabs();
    const { result } = renderTabsHost(tabs);
    act(() => result.current.viewer.host.navigate('/embed/common/common-magnet?P=Q'));
    expect(tabs.open).toHaveBeenCalledWith('/embed/common/common-magnet?P=Q', 'replace');
    expect(result.current.location.pathname).toBe('/embed/bts/knob-device');
  });

  it('a resolved screen opened in a tab/window appends a tab without window.open', async () => {
    const open = vi.fn(() => null);
    vi.stubGlobal('open', open);
    const tabs = makeTabs();
    const { result } = renderTabsHost(tabs);
    const url = await result.current.viewer.host.resolveManifest('../common/magnet.screen.json');
    expect(url).toBe('/embed/common/common-magnet');
    result.current.viewer.host.openWindow(`${url}?P=1`);
    expect(tabs.open).toHaveBeenCalledWith('/embed/common/common-magnet?P=1', 'append');
    expect(open).not.toHaveBeenCalled();
  });

  it('a non-screen URL still uses window.open', () => {
    const open = vi.fn(() => null);
    vi.stubGlobal('open', open);
    const tabs = makeTabs();
    const { result } = renderTabsHost(tabs);
    result.current.viewer.host.openWindow('https://example.org/');
    expect(open).toHaveBeenCalledWith('https://example.org/', '_blank', 'noopener');
    expect(tabs.open).not.toHaveBeenCalled();
  });

  it('close closes the active tab and never goes back or closes the window', () => {
    const close = vi.spyOn(window, 'close').mockImplementation(() => {});
    const tabs = makeTabs();
    const { result } = renderTabsHost(tabs);
    result.current.viewer.host.close();
    expect(tabs.close).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
    expect(result.current.location.pathname).toBe('/embed/bts/knob-device');
  });

  it('resolves relative files against the active tab, not the router location', async () => {
    const tabs = makeTabs('/embed/cbx%20fel/CBXFEL/Landing');
    const { result } = renderTabsHost(tabs);
    // From cbx fel/CBXFEL/Landing (screens/cbxfel/CBXFEL/) up two to screens/.
    await expect(
      result.current.viewer.host.resolveManifest('../../common/magnet.screen.json')
    ).resolves.toBe('/embed/common/common-magnet');
  });

  it('keeps the same host when the tabs object changes, and uses the newest one', () => {
    const first = makeTabs();
    const { result, rerender } = renderTabsHost(first);
    const host = result.current.viewer.host;
    const second = makeTabs();
    rerender({ t: second });
    expect(result.current.viewer.host).toBe(host);
    act(() => host.navigate('/embed/common/common-magnet'));
    expect(second.open).toHaveBeenCalledOnce();
    expect(first.open).not.toHaveBeenCalled();
  });
});

describe('useViewerActionHost hostFor (one host per workspace tile)', () => {
  function wrapper({ children }: { children: ReactNode }) {
    return createElement(
      MemoryRouter,
      { basename: '/x/y', initialEntries: ['/x/y/embed/bts/knob-device'] },
      children
    );
  }

  function tileTabs(pathname?: string) {
    return {
      open: vi.fn<WorkspaceTabs['open']>(),
      close: vi.fn<WorkspaceTabs['close']>(),
      currentPathname: vi.fn<() => string | undefined>(() => pathname),
    };
  }

  function renderHosts() {
    const fetchStub = vi.fn(async () => new Response(JSON.stringify(MANIFEST), { status: 200 }));
    vi.stubGlobal('fetch', fetchStub);
    const hook = renderHook(
      () => ({ viewer: useViewerActionHost('https://host/x/y/screens'), location: useLocation() }),
      { wrapper }
    );
    return { ...hook, fetchStub };
  }

  it('drives the tile it was made for: navigate, open in a tab, close', async () => {
    const { result } = renderHosts();
    const tabs = tileTabs('/embed/bts/knob-device');
    const host = result.current.viewer.hostFor(tabs);
    act(() => host.navigate('/embed/common/common-magnet'));
    expect(tabs.open).toHaveBeenCalledWith('/embed/common/common-magnet', 'replace');
    const url = await host.resolveManifest('../common/magnet.screen.json');
    host.openWindow(`${url}?P=1`);
    expect(tabs.open).toHaveBeenLastCalledWith('/embed/common/common-magnet?P=1', 'append');
    host.close();
    expect(tabs.close).toHaveBeenCalledOnce();
    expect(result.current.location.pathname).toBe('/embed/bts/knob-device');
  });

  it('resolves relative files against its own tile, whatever the router shows', async () => {
    const { result } = renderHosts();
    const landing = result.current.viewer.hostFor(tileTabs('/embed/cbx%20fel/CBXFEL/Landing'));
    const knob = result.current.viewer.hostFor(tileTabs('/embed/bts/knob-device'));
    await expect(landing.resolveManifest('../../common/magnet.screen.json')).resolves.toBe(
      '/embed/common/common-magnet'
    );
    await expect(knob.resolveManifest('../common/magnet.screen.json')).resolves.toBe(
      '/embed/common/common-magnet'
    );
  });

  it('routes every tile host error to the one shared error', () => {
    const { result } = renderHosts();
    const host = result.current.viewer.hostFor(tileTabs());
    act(() => host.showError('Failed on a tile'));
    expect(result.current.viewer.error).toBe('Failed on a tile');
    act(() => result.current.viewer.clearError());
    expect(result.current.viewer.error).toBeNull();
  });

  it('shares one manifest fetch between tile hosts', async () => {
    const { result, fetchStub } = renderHosts();
    const a = result.current.viewer.hostFor(tileTabs('/embed/bts/knob-device'));
    const b = result.current.viewer.hostFor(tileTabs('/embed/bts/knob-device'));
    await a.resolveManifest('screens/common/magnet.screen.json');
    await b.resolveManifest('screens/common/magnet.screen.json');
    await result.current.viewer.host.resolveManifest('screens/common/magnet.screen.json');
    expect(fetchStub).toHaveBeenCalledOnce();
  });

  it('keeps hostFor stable across re-renders', () => {
    const { result, rerender } = renderHosts();
    const first = result.current.viewer.hostFor;
    rerender();
    expect(result.current.viewer.hostFor).toBe(first);
  });
});

describe('WorkspacePage: one action host per tile', () => {
  const KNOB = 'bts/knob-device';
  const LANDING = 'cbx fel/CBXFEL/Landing?P=1';
  const MAGNET = 'common/common-magnet';

  afterEach(() => {
    sessionStorage.clear();
    localStorage.clear();
  });

  // Two tiles side by side, one screen each, the knob device focused (the
  // URL names it), as a reload of such a session would restore them.
  function renderTwoTiles() {
    const keys = [KNOB, LANDING];
    sessionStorage.setItem(
      tabsStorageKey('/'),
      JSON.stringify({ keys, active: KNOB, instances: {}, toolMru: [] })
    );
    // writeDock skips a value equal to the last one it saw; start clean.
    removeDock('/');
    writeDock('/', {
      version: DOCK_VERSION,
      layout: {
        split: 'row',
        items: [
          { tile: 't1', tabs: [KNOB], showing: KNOB, size: 0.5 },
          { tile: 't2', tabs: [LANDING], showing: LANDING, size: 0.5 },
        ],
      },
      panels: {},
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(MANIFEST), { status: 200 }))
    );
    render(
      createElement(
        MemoryRouter,
        { initialEntries: ['/embed/bts/knob-device'] },
        createElement(App, { screensBaseUrl: 'https://host/screens' })
      )
    );
  }

  /** The showing tab of each tile, in tile order (the dock root's data-showing). */
  const showing = (): unknown =>
    JSON.parse(screen.getByTestId('workspace-dock').getAttribute('data-showing') ?? '[]');
  const focusedKey = () =>
    document.querySelector('.workspace__screen[data-active="true"]')?.getAttribute('data-tab-key');

  it('starts with one screen per tile and the knob device focused', async () => {
    renderTwoTiles();
    await screen.findByRole('button', { name: 'navigate from CBXFEL/Landing' });
    expect(showing()).toEqual([KNOB, LANDING]);
    expect(focusedKey()).toBe(KNOB);
  });

  it('a navigate from an unfocused tile swaps its own occupant, not the focused one', async () => {
    renderTwoTiles();
    fireEvent.click(await screen.findByRole('button', { name: 'navigate from CBXFEL/Landing' }));
    await waitFor(() => expect(showing()).toEqual([KNOB, MAGNET]));
    expect(focusedKey()).toBe(MAGNET);
  });

  it('close from a tile closes that key, not the focused one', async () => {
    renderTwoTiles();
    fireEvent.click(await screen.findByRole('button', { name: 'close CBXFEL/Landing' }));
    await waitFor(() => expect(showing()).toEqual([KNOB]));
    expect(document.querySelector(`[data-tab-key="${LANDING}"]`)).toBeNull();
    expect(document.querySelector(`[data-tab-key="${KNOB}"]`)).not.toBeNull();
  });

  it("a macro screen's relative path resolves against its own tile", async () => {
    renderTwoTiles();
    fireEvent.click(await screen.findByRole('button', { name: 'resolve from CBXFEL/Landing' }));
    await waitFor(() =>
      expect(screen.getByTestId('resolved CBXFEL/Landing').textContent).toBe(
        '/embed/common/common-magnet'
      )
    );
    // From the knob device (screens/bts/) the same file escapes the root.
    fireEvent.click(screen.getByRole('button', { name: 'resolve from knob-device' }));
    await waitFor(() =>
      expect(screen.getByTestId('resolved knob-device').textContent).toBe('null')
    );
  });

  it("an unfocused tile's error shows in the workspace banner", async () => {
    renderTwoTiles();
    fireEvent.click(await screen.findByRole('button', { name: 'fail from CBXFEL/Landing' }));
    const banner = await waitFor(() => {
      const el = document.querySelector('.viewer-error');
      expect(el).not.toBeNull();
      return el!;
    });
    expect(banner.textContent).toContain('Failed on CBXFEL/Landing');
  });
});
