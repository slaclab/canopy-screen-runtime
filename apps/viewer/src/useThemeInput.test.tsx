// The shared theme input of the viewer's two mode-store writers: ids resolve
// through config.themes then their own name, the caller's default applies
// without one, the store is seeded before any child's layout effect runs,
// a host message wins over the URL, and the load-time ?theme= is latched.
// The hook returns the raw id in force, and only a message from the viewer's
// own origin counts.

import { useEffect, useLayoutEffect } from 'react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { getMode, setMode, subscribe } from '@slaclab/canopy-screen-runtime';
import type { ThemeName } from './config.js';
import { resolveMode, THEME_MESSAGE, useThemeInput } from './useThemeInput.js';

// Node >= 25 ships a global `localStorage` that is undefined without
// --localstorage-file and shadows jsdom's; install an in-memory one before
// canopy-shell reads it at import time.
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

afterEach(() => {
  cleanup();
  setMode('light');
});

describe('resolveMode', () => {
  it('uses the fallback when no id is given', () => {
    expect(resolveMode(null, {}, 'light')).toBe('light');
    expect(resolveMode('', {}, 'light')).toBe('light');
    expect(resolveMode(null, {}, 'dark')).toBe('dark');
  });

  it('maps through config.themes first', () => {
    expect(resolveMode('host-paper', { 'host-paper': 'light' }, 'dark')).toBe('light');
    expect(resolveMode('light', { light: 'dark' }, 'light')).toBe('dark');
  });

  it('then reads the id itself: light or *-light is light, anything else dark', () => {
    expect(resolveMode('light', {}, 'dark')).toBe('light');
    expect(resolveMode('host-light', {}, 'dark')).toBe('light');
    expect(resolveMode('dark', {}, 'light')).toBe('dark');
    expect(resolveMode('host-night', {}, 'light')).toBe('dark');
  });
});

/** Records the store's mode in its first layout effect, like a screen root. */
function FirstLayoutMode({ seen }: { seen: ThemeName[] }) {
  useLayoutEffect(() => {
    seen.push(getMode());
  }, [seen]);
  return null;
}

let navigateTo: ((to: string) => void) | null = null;
function NavigateProbe() {
  const navigate = useNavigate();
  useEffect(() => {
    navigateTo = navigate;
  }, [navigate]);
  return null;
}

function Writer({
  themes = {},
  fallback,
  children,
}: {
  themes?: Record<string, ThemeName>;
  fallback: ThemeName;
  children?: ReactNode;
}) {
  const raw = useThemeInput(themes, fallback);
  return (
    <>
      <span data-testid="raw">{raw === null ? '(none)' : raw}</span>
      {children}
    </>
  );
}

const rawTheme = (view: { getByTestId: (id: string) => HTMLElement }) =>
  view.getByTestId('raw').textContent;

function renderWriter(path: string, fallback: ThemeName, themes: Record<string, ThemeName> = {}) {
  const seen: ThemeName[] = [];
  const view = render(
    <MemoryRouter initialEntries={[path]}>
      <NavigateProbe />
      <Writer themes={themes} fallback={fallback}>
        <FirstLayoutMode seen={seen} />
      </Writer>
    </MemoryRouter>
  );
  return { seen, view };
}

function hostMessage(
  theme: string,
  source: MessageEventSource | null = window.parent,
  origin: string = window.location.origin,
  type: string = THEME_MESSAGE
) {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: { type, theme }, source, origin }));
  });
}

describe('useThemeInput', () => {
  it('seeds the fallback before the first child layout effect', () => {
    setMode('dark');
    const { seen } = renderWriter('/s/a/b', 'light');
    expect(seen).toEqual(['light']);
    expect(getMode()).toBe('light');
  });

  it('seeds ?theme= before the first child layout effect', () => {
    setMode('light');
    const { seen } = renderWriter('/s/a/b?theme=host-night', 'light');
    expect(seen).toEqual(['dark']);
  });

  it('resolves ?theme= through config.themes', () => {
    setMode('dark');
    const { seen } = renderWriter('/s/a/b?theme=paper', 'dark', { paper: 'light' });
    expect(seen).toEqual(['light']);
  });

  it('names the message canopy:theme', () => {
    expect(THEME_MESSAGE).toBe('canopy:theme');
  });

  it('follows theme messages from the parent only', () => {
    renderWriter('/s/a/b?theme=light', 'light', { 'host-night': 'dark' });
    expect(getMode()).toBe('light');
    hostMessage('host-night');
    expect(getMode()).toBe('dark');
    // Not from the parent, or not a theme message: ignored.
    hostMessage('light', null);
    expect(getMode()).toBe('dark');
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'something-else', theme: 'light' },
          source: window.parent,
          origin: window.location.origin,
        })
      );
    });
    expect(getMode()).toBe('dark');
  });

  it('foreign origin ignored', () => {
    const { view } = renderWriter('/s/a/b?theme=light', 'light');
    hostMessage('retro-dark', window.parent, 'https://elsewhere.example');
    expect(getMode()).toBe('light');
    expect(rawTheme(view)).toBe('light');
    // A message without an origin (never the case in a browser) is foreign too.
    hostMessage('retro-dark', window.parent, '');
    expect(getMode()).toBe('light');
    // Positive control: the same message from the viewer's own origin applies.
    hostMessage('retro-dark');
    expect(getMode()).toBe('dark');
    expect(rawTheme(view)).toBe('retro-dark');
  });

  it('returns the raw id in force: none, the URL, then a host message', () => {
    const bare = renderWriter('/s/a/b', 'light');
    expect(rawTheme(bare.view)).toBe('(none)');
    bare.view.unmount();

    const { view } = renderWriter('/s/a/b?theme=desy-dark', 'light');
    expect(rawTheme(view)).toBe('desy-dark');
    // Same mode, another theme: the store is untouched, the id follows.
    hostMessage('retro-dark');
    expect(rawTheme(view)).toBe('retro-dark');
    expect(getMode()).toBe('dark');
    // The id is handed on as received; checking it is the consumer's job.
    hostMessage('Not A Theme');
    expect(rawTheme(view)).toBe('Not A Theme');
  });

  it('keeps the load-time ?theme= after navigation drops it', () => {
    renderWriter('/s/a/b?theme=dark', 'light');
    expect(getMode()).toBe('dark');
    act(() => navigateTo!('/s/a/c'));
    expect(getMode()).toBe('dark');
  });

  it('applies a later ?theme= change', () => {
    renderWriter('/s/a/b?theme=dark', 'light');
    act(() => navigateTo!('/s/a/b?theme=light'));
    expect(getMode()).toBe('light');
  });

  it('writes the store once per change: the seed, never again for the same mode', () => {
    setMode('light');
    let notified = 0;
    const unsubscribe = subscribe(() => {
      notified += 1;
    });
    renderWriter('/s/a/b?theme=dark', 'light');
    // A host message naming the mode already in force notifies nobody.
    hostMessage('dark');
    unsubscribe();
    expect(notified).toBe(1);
  });
});
