// The compact section rules (the compactSidebar and firstOpenHint host
// capabilities, under the one-row sidebar header): the Browse tree orders its
// branches PINNED (only when non-
// empty) · ticked collections · TOOLS · SCREENS · RECENT; RECENT is last,
// collapsed by default (its opened state remembered), carries its count in
// its header and keeps Clear recent on its header menu; the first-open footer
// hint shows while PINNED and RECENT are both empty, shown collections or not; SCREENS
// folds single-child folder chains into breadcrumb rows after the Show
// sub-screens filter. Sections derive from content and the query only, never
// from hover. Without the capabilities the tree keeps its standard order,
// labels and folders.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import type { ManifestScreen } from '../api.js';
import { resetShowSubScreensStore, setShowSubScreens } from '../screenList.js';
import { memberKey } from './collections.js';
import type { Member } from './collections.js';
import {
  ALL_SCREENS_LABEL,
  BRANCH_RECENT,
  RECENT_EXPANDED_MARKER,
  RECENT_LABEL,
  SCREENS_LABEL,
  ScreenTree,
  collapsedStorageKey,
  memberNodeId,
  sidebarHint,
} from './ScreenTree.js';
import type { BrowseCollections, ScreenTreeProps, ToolEntry } from './ScreenTree.js';
import type { Collection } from './useCollections.js';
import { EMPTY_STATE } from './useCollections.js';
import { SidebarQueryContext } from './WorkspaceSidebar.js';
import { HOST_SHELL_CAPABILITIES, HostCapabilitiesContext } from './host/hostCapabilities.js';

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

function entry(category: string, id: string, title: string): ManifestScreen {
  return { id, kind: 'ir', title, category, path: `screens/${category}/${id}.screen.json` };
}

const SCREENS: ManifestScreen[] = [
  entry('library', 'sr/overview', 'SR Overview'),
  entry('library', 'bts/BTSView', 'BTS View'),
  entry('library', 'bts/embedded/_part', 'BTS Part'),
  entry('library', 'gtb/a', 'GTB A'),
  entry('library', 'gtb/b', 'GTB B'),
];

const TOOLS: ToolEntry[] = [
  { id: 'trace', label: 'Data Browser', treeLabel: 'Data Browser (Trace)' },
];

const OVERVIEW: Member = { screen: 'library/sr/overview' };
const BTS: Member = { screen: 'library/bts/BTSView' };
const GTB_A: Member = { screen: 'library/gtb/a' };

const OPS: Collection = {
  source: 'facility',
  ref: 'facility:ops',
  id: 'ops',
  name: 'Operations',
  members: [GTB_A],
  layout: null,
  default: true,
};

function api(over: Partial<BrowseCollections> & { pinned?: Member[] } = {}): BrowseCollections {
  const { pinned = [], ...rest } = over;
  return {
    enabled: true,
    shown: [],
    state: { ...EMPTY_STATE, pinned },
    recent: [],
    pinnedKeys: new Set(pinned.map(memberKey)),
    openMember: vi.fn(),
    openAll: vi.fn(),
    pin: vi.fn(() => Promise.resolve()),
    unpin: vi.fn(() => Promise.resolve()),
    untick: vi.fn(() => Promise.resolve()),
    remove: vi.fn(() => Promise.resolve({ ok: true as const, missing: false })),
    setRecentHover: vi.fn(),
    recentClear: vi.fn(() => Promise.resolve()),
    ...rest,
  };
}

function element(props: Partial<ScreenTreeProps>, query: string | null): ReactElement {
  const tree = <ScreenTree screens={SCREENS} tools={TOOLS} onOpen={() => {}} {...props} />;
  return query === null ? (
    tree
  ) : (
    <HostCapabilitiesContext.Provider value={HOST_SHELL_CAPABILITIES}>
      <SidebarQueryContext.Provider value={query}>{tree}</SidebarQueryContext.Provider>
    </HostCapabilitiesContext.Provider>
  );
}

/** The tree under the one-row sidebar header (its query arrives through context). */
function compact(props: Partial<ScreenTreeProps> = {}, query = '') {
  const view = render(element(props, query));
  return {
    ...view,
    update: (next: Partial<ScreenTreeProps>, q = query) => view.rerender(element(next, q)),
  };
}

function standalone(props: Partial<ScreenTreeProps> = {}) {
  return render(element(props, null));
}

function topLabels(): string[] {
  return Array.from(
    document.querySelectorAll('[role="tree"] > [role="treeitem"]'),
    (item) => item.querySelector(':scope > .nav-tree__row .nav-tree__label')?.textContent ?? ''
  );
}

function branchItem(id: string): HTMLElement {
  const el = document.getElementById(`screen-tree-${encodeURIComponent(id)}`);
  if (!el) throw new Error(`no treeitem ${id}`);
  return el;
}

function rowOf(item: HTMLElement): HTMLElement {
  return item.querySelector(':scope > .nav-tree__row') as HTMLElement;
}

function hint(): HTMLElement | null {
  return document.querySelector('.screen-tree__hint');
}

function stored(): string[] {
  const raw = localStorage.getItem(collapsedStorageKey());
  return raw ? (JSON.parse(raw) as string[]) : [];
}

beforeEach(() => {
  localStorage.clear();
  resetShowSubScreensStore();
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('sidebarHint', () => {
  it('names the pin star and the quick-open shortcut', () => {
    expect(sidebarHint(true)).toBe('☆ on any row pins it here · ⌘K jumps to any screen or tool');
    expect(sidebarHint(false)).toBe(
      '☆ on any row pins it here · Ctrl+K jumps to any screen or tool'
    );
  });
});

describe('compact sections', () => {
  it('never-stored: TOOLS, SCREENS and the footer hint, no PINNED or RECENT', () => {
    compact({ collections: api() });
    expect(topLabels()).toEqual(['Tools', SCREENS_LABEL]);
    expect(SCREENS_LABEL).toBe('Screens');
    expect(hint()?.textContent).toBe(sidebarHint());
    expect(screen.queryByText(/Pin a screen with/)).toBeNull();
  });

  it('pin one: PINNED comes first and the hint goes', () => {
    compact({ collections: api({ pinned: [OVERVIEW] }) });
    expect(topLabels()).toEqual(['Pinned', 'Tools', SCREENS_LABEL]);
    expect(hint()).toBeNull();
  });

  it('open two: RECENT is last, collapsed, with count 2', () => {
    compact({ collections: api({ recent: [OVERVIEW, BTS] }) });
    expect(topLabels()).toEqual(['Tools', SCREENS_LABEL, RECENT_LABEL]);
    const recent = branchItem(BRANCH_RECENT);
    expect(recent.getAttribute('aria-expanded')).toBe('false');
    expect(rowOf(recent).querySelector('.nav-tree__count')?.textContent).toBe('2');
    expect(screen.getByRole('treeitem', { name: RECENT_LABEL })).toBe(recent);
    expect(
      document.getElementById(
        `screen-tree-${encodeURIComponent(memberNodeId('recent', memberKey(OVERVIEW)))}`
      )
    ).toBeNull();
    expect(hint()).toBeNull();
  });

  it('ticked collections sit between PINNED and TOOLS', () => {
    compact({ collections: api({ pinned: [OVERVIEW], shown: [OPS], recent: [BTS] }) });
    expect(topLabels()).toEqual(['Pinned', 'Operations', 'Tools', SCREENS_LABEL, RECENT_LABEL]);
    expect(hint()).toBeNull();
  });

  it('a shown collection keeps the hint while PINNED and RECENT are empty', () => {
    compact({ collections: api({ shown: [OPS] }) });
    expect(topLabels()).toEqual(['Operations', 'Tools', SCREENS_LABEL]);
    expect(hint()?.textContent).toBe(sidebarHint());
  });

  it('beside a shown collection, one pin or one recent hides the hint', () => {
    const view = compact({ collections: api({ shown: [OPS] }) });
    expect(hint()).not.toBeNull();
    view.update({ collections: api({ shown: [OPS], pinned: [OVERVIEW] }) });
    expect(topLabels()).toEqual(['Pinned', 'Operations', 'Tools', SCREENS_LABEL]);
    expect(hint()).toBeNull();
    view.update({ collections: api({ shown: [OPS], recent: [BTS] }) });
    expect(topLabels()).toEqual(['Operations', 'Tools', SCREENS_LABEL, RECENT_LABEL]);
    expect(hint()).toBeNull();
  });

  it('Clear recent sits on the RECENT header menu and an emptied RECENT leaves', () => {
    const live = api({ recent: [OVERVIEW, BTS] });
    const view = compact({ collections: live });
    fireEvent.contextMenu(rowOf(branchItem(BRANCH_RECENT)));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Clear recent' }));
    expect(live.recentClear).toHaveBeenCalledTimes(1);
    view.update({ collections: { ...live, recent: [] } });
    expect(topLabels()).toEqual(['Tools', SCREENS_LABEL]);
    expect(hint()?.textContent).toBe(sidebarHint());
  });

  it('opening RECENT is remembered across mounts; closing it forgets', () => {
    const live = api({ recent: [OVERVIEW, BTS] });
    compact({ collections: live });
    fireEvent.click(rowOf(branchItem(BRANCH_RECENT)));
    expect(branchItem(BRANCH_RECENT).getAttribute('aria-expanded')).toBe('true');
    expect(stored()).toContain(RECENT_EXPANDED_MARKER);
    expect(stored()).not.toContain(BRANCH_RECENT);
    cleanup();
    compact({ collections: live });
    expect(branchItem(BRANCH_RECENT).getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(rowOf(branchItem(BRANCH_RECENT)));
    expect(branchItem(BRANCH_RECENT).getAttribute('aria-expanded')).toBe('false');
    expect(stored()).not.toContain(RECENT_EXPANDED_MARKER);
  });

  it('a query opens RECENT while it lasts and hides the hint', () => {
    const live = api({ recent: [OVERVIEW] });
    const view = compact({ collections: live }, 'SR');
    expect(branchItem(BRANCH_RECENT).getAttribute('aria-expanded')).toBe('true');
    view.update({ collections: api() }, 'SR');
    expect(hint()).toBeNull();
  });

  it('hovering never changes the sections', () => {
    compact({ collections: api({ recent: [OVERVIEW, BTS] }) });
    const before = topLabels();
    const recent = rowOf(branchItem(BRANCH_RECENT));
    fireEvent.pointerOver(recent);
    fireEvent.pointerLeave(recent);
    expect(topLabels()).toEqual(before);
    expect(branchItem(BRANCH_RECENT).getAttribute('aria-expanded')).toBe('false');
  });

  it('without collections the compact tree shows TOOLS and SCREENS and no hint', () => {
    compact();
    expect(topLabels()).toEqual(['Tools', SCREENS_LABEL]);
    expect(hint()).toBeNull();
  });
});

describe('compact SCREENS folders', () => {
  it('folds single-child folder chains into breadcrumb rows after the sub-screen filter', () => {
    compact({ collections: api() });
    const bts = document.getElementById(
      `screen-tree-${encodeURIComponent(memberNodeId('screens', memberKey(BTS)))}`
    )!;
    expect(rowOf(bts).querySelector('.nav-tree__label')?.textContent).toBe('bts › BTS View');
    expect(rowOf(bts).querySelector('.nav-tree__breadcrumb')?.textContent).toBe('bts › ');
    expect(screen.queryByRole('treeitem', { name: 'bts' })).toBeNull();
    expect(screen.getByRole('treeitem', { name: 'sr › SR Overview' })).toBeTruthy();
    // A folder with two visible children stays a folder.
    expect(screen.getByRole('treeitem', { name: 'gtb' })).toBeTruthy();
  });

  it('with sub-screens shown, bts stays a folder', () => {
    setShowSubScreens(true);
    compact({ collections: api() });
    expect(screen.getByRole('treeitem', { name: 'bts' })).toBeTruthy();
    expect(screen.getByRole('treeitem', { name: 'embedded \u203a BTS Part' })).toBeTruthy();
  });
});

describe('standard order without the capabilities', () => {
  it('keeps Pinned, Recent, collections, Tools, All screens and plain folders', () => {
    standalone({ collections: api({ pinned: [OVERVIEW], shown: [OPS], recent: [BTS] }) });
    expect(topLabels()).toEqual(['Pinned', 'Recent', 'Operations', 'Tools', ALL_SCREENS_LABEL]);
    expect(ALL_SCREENS_LABEL).toBe('All screens');
    expect(branchItem(BRANCH_RECENT).getAttribute('aria-expanded')).toBe('true');
    expect(rowOf(branchItem(BRANCH_RECENT)).querySelector('.nav-tree__count')).toBeNull();
    expect(screen.getByRole('treeitem', { name: 'bts' })).toBeTruthy();
    expect(hint()).toBeNull();
  });

  it('keeps the empty Pinned placeholder', () => {
    standalone({ collections: api() });
    expect(topLabels()).toEqual(['Pinned', 'Tools', ALL_SCREENS_LABEL]);
    expect(screen.getByText(/Pin a screen with/)).toBeTruthy();
  });
});
