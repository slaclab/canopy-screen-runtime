// ScreenTree under a host theme root: the context menu is portalled into the
// embed layout's root element (EmbedThemeContext's anchor) instead of
// document.body, so a host stylesheet scoped to that root reaches it. Outside
// an EmbedPage there is no anchor and the menu keeps Carbon's default target.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { useMemo, useRef } from 'react';
import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ManifestScreen } from '../api.js';
import { EmbedThemeContext } from '../pages/EmbedPage.js';
import { ScreenTree } from './ScreenTree.js';

// Same in-memory localStorage shim as ScreenTree.test.tsx: Node >= 25 can
// shadow jsdom's with an unusable global, and the tree persists there.
vi.hoisted(() => {
  let usable = false;
  try {
    usable = typeof globalThis.localStorage?.getItem === 'function';
  } catch {
    // Treat a throwing getter as unusable.
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
      Object.defineProperty(target, 'localStorage', { value: memory, configurable: true });
  }
});

const SCREENS: ManifestScreen[] = [
  {
    id: 'vacuum',
    kind: 'ir',
    title: 'Vacuum System',
    category: 'examples',
    path: 'screens/examples/vacuum.screen.json',
  },
];

/** The embed layout's root as EmbedPage renders it, with the tree inside. */
function HostRoot({ children }: { children: ReactNode }) {
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const theme = useMemo(() => ({ mode: 'dark' as const, id: 'host-dark', anchorRef }), []);
  return (
    <div ref={anchorRef} data-canopy-host-root="" data-theme="host-dark">
      <EmbedThemeContext.Provider value={theme}>{children}</EmbedThemeContext.Provider>
    </div>
  );
}

afterEach(() => {
  cleanup();
});

describe('ScreenTree context menu target', () => {
  it('renders the menu inside the host theme root', () => {
    render(
      <HostRoot>
        <ScreenTree screens={SCREENS} onOpen={vi.fn()} />
      </HostRoot>
    );
    expect(document.querySelector('.cds--menu')).toBeNull();
    fireEvent.contextMenu(screen.getByText('Vacuum System'));
    const menu = document.querySelector('.cds--menu');
    expect(menu).not.toBeNull();
    expect(menu!.closest('[data-canopy-host-root]')).not.toBeNull();
    expect(document.querySelectorAll('.cds--menu')).toHaveLength(1);
  });

  it('still runs the item and closes from inside the root', () => {
    const onOpen = vi.fn();
    render(
      <HostRoot>
        <ScreenTree screens={SCREENS} onOpen={onOpen} />
      </HostRoot>
    );
    fireEvent.contextMenu(screen.getByText('Vacuum System'));
    fireEvent.click(screen.getByText('Open in new tab'));
    expect(onOpen).toHaveBeenCalledWith('examples/vacuum', 'append');
    expect(document.querySelector('.cds--menu')).toBeNull();
  });

  it('keeps the default target outside an embed layout', () => {
    render(<ScreenTree screens={SCREENS} onOpen={vi.fn()} />);
    fireEvent.contextMenu(screen.getByText('Vacuum System'));
    const menu = document.querySelector('.cds--menu');
    expect(menu).not.toBeNull();
    expect(menu!.closest('[data-canopy-host-root]')).toBeNull();
    expect(document.body.contains(menu)).toBe(true);
  });

  it('puts the screen-tree-search testid on the search input', () => {
    render(<ScreenTree screens={SCREENS} onOpen={vi.fn()} />);
    const input = screen.getByTestId('screen-tree-search');
    expect(input.tagName).toBe('INPUT');
    expect(input.id).toBe('screen-tree-search');
  });
});
