// QuickOpen: the entry list (sub-screen filter, named tool members with their
// collection as meta, no collections when the feature is off), ranking by the
// shared matcher with open tabs first as "Switch to tab" and the cap of 50,
// the combobox/listbox ARIA, Enter, Shift+Enter and the open modifier by the
// row table, the post-open focus into the opened tile with the opener as
// fallback, Esc's focus return (opener, or the tree search from a tool
// frame), the visible button, the document-level primary+K binding, the
// exported openQuickOpen() action, and the dock live region's text.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';

// Node >= 25 has no usable localStorage without --localstorage-file; the
// shell's theme store reads it at import.
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

import {
  QUICK_OPEN_CAP,
  QuickOpen,
  listEntries,
  openQuickOpen,
  quickOpenEntries,
  tabEntries,
} from './QuickOpen.js';
import { tilePanelId } from './dock/useTileFocus.js';
import { dockAnnouncement } from './WorkspacePage.js';
import type { QuickOpenEntry, QuickOpenProps } from './QuickOpen.js';
import type { ManifestScreen } from '../api.js';
import type { SavedView } from './savedViews.js';
import type { Collection } from './useCollections.js';

const css = readFileSync(createRequire(import.meta.url).resolve('./QuickOpen.css'), 'utf8');

function ms(category: string, id: string, title: string, kind = 'ir'): ManifestScreen {
  return { id, title, category, kind, path: `screens/${category}/${id}.screen.json` };
}

const SCREENS: ManifestScreen[] = [
  ms('examples', 'vacuum', 'Vacuum overview'),
  ms('examples', 'bts/magnets', 'BTS magnets'),
  ms('examples', 'embedded/gauge', 'Gauge piece'),
  ms('examples', 'legacy', 'Legacy wrapper', 'wrapper'),
];

const VIEWS: SavedView[] = [
  { id: 'orbit', name: 'Orbit drift', kind: 'trace', query: 'pv=a' },
  { id: 'gone', name: 'Gone tool view', kind: 'nope', query: '' },
];

const RING: Collection = {
  source: 'facility',
  ref: 'facility:ring',
  id: 'ring',
  name: 'Storage ring',
  members: [
    { screen: 'examples/vacuum' },
    { tool: 'trace', query: 'pv=b', name: 'Beam current' },
    { tool: 'trace', query: 'pv=c' },
  ],
  layout: null,
  default: true,
};

function makeCollections(enabled = true) {
  return {
    enabled,
    collections: [RING],
    openMember: vi.fn(),
    openAll: vi.fn(),
  };
}

function setup(overrides: Partial<QuickOpenProps> = {}) {
  const props: QuickOpenProps = {
    screens: SCREENS,
    tools: ['trace'],
    views: VIEWS,
    collections: makeCollections(),
    onOpen: vi.fn(),
    onOpenTool: vi.fn(),
    onNewTool: vi.fn(),
    onOpenView: vi.fn(),
    showSubScreens: false,
    mac: true,
    ...overrides,
  };
  const utils = render(
    <>
      <input id="screen-tree-search" data-testid="tree-search" />
      <input data-testid="other-field" />
      <button type="button">elsewhere</button>
      <QuickOpen {...props} />
    </>
  );
  return { props, ...utils };
}

function trigger() {
  return screen.getByRole('button', { name: /Quick open/ });
}

function openPalette() {
  fireEvent.click(trigger());
  return screen.getByRole('combobox');
}

function options() {
  return within(screen.getByRole('listbox')).queryAllByRole('option');
}

function type(input: HTMLElement, value: string) {
  fireEvent.change(input, { target: { value } });
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('quickOpenEntries', () => {
  it('lists collections, named tool members, tools, views and screens', () => {
    const entries = quickOpenEntries({
      screens: SCREENS,
      tools: ['trace'],
      views: VIEWS,
      collections: [RING],
      showSubScreens: false,
    });
    expect(entries.map((e) => [e.kind, e.label, e.meta])).toEqual([
      ['collection', 'Storage ring', 'Facility collection'],
      ['member', 'Beam current', 'Storage ring'],
      ['tool', 'Data Browser (Trace)', 'Tool'],
      ['view', 'Orbit drift', 'Data Browser view'],
      ['screen', 'Vacuum overview', 'vacuum'],
      ['screen', 'BTS magnets', 'bts/magnets'],
    ]);
  });

  it('shows sub-screens only with the toggle on, and never non-IR screens', () => {
    const entries = quickOpenEntries({ screens: SCREENS, tools: [], showSubScreens: true });
    expect(entries.map((e) => e.label)).toEqual(['Vacuum overview', 'BTS magnets', 'Gauge piece']);
  });

  it('leaves out collection entries without collections, and members of unserved tools', () => {
    expect(
      quickOpenEntries({
        screens: null,
        tools: [],
        collections: [RING],
        showSubScreens: false,
      }).map((e) => e.kind)
    ).toEqual(['collection']);
    expect(
      quickOpenEntries({ screens: null, tools: ['trace'], showSubScreens: false })
    ).toHaveLength(1);
  });
});

describe('ranking', () => {
  const entry = (label: string): QuickOpenEntry => ({
    id: label,
    kind: 'tool',
    tool: 'trace',
    label,
    meta: '',
  });
  const rank = (entries: QuickOpenEntry[], query: string) =>
    listEntries([], entries, query).map((e) => e.label);

  it('matches every query word as a word prefix, label matches first', () => {
    expect(rank([entry('Sorbet'), entry('Beam orbit'), entry('Orbit'), entry('x')], 'orb')).toEqual(
      ['Orbit', 'Beam orbit']
    );
    expect(rank([entry('GTLView'), entry('Vacuum')], 'gtl view')).toEqual(['GTLView']);
    expect(rank([entry('GTLView'), entry('Vacuum')], 'view')).toEqual(['GTLView']);
  });

  it('lists everything on a blank query and caps at 50', () => {
    const many = Array.from({ length: 80 }, (_, i) => entry(`Screen ${i}`));
    expect(QUICK_OPEN_CAP).toBe(50);
    expect(listEntries([], many, '')).toHaveLength(50);
    expect(listEntries([], many, '  ')).toHaveLength(50);
    expect(listEntries([], many, 'screen')).toHaveLength(50);
  });

  it('matches a screen on its id and its category/id path', () => {
    const entries = quickOpenEntries({
      screens: [...SCREENS, ms('sr', 'overview', 'Storage ring')],
      tools: [],
      showSubScreens: false,
    });
    expect(rank(entries, 'bts mag')).toEqual(['BTS magnets']);
    expect(rank(entries, 'sr overview')).toEqual(['Storage ring']);
  });

  it('lists matching open tabs first, then the other matches', () => {
    const tabs = tabEntries([
      { key: 'examples/vacuum', title: 'Vacuum overview' },
      { key: '@trace', title: 'Data Browser' },
    ]);
    const entries = quickOpenEntries({ screens: SCREENS, tools: ['trace'], showSubScreens: false });
    expect(listEntries(tabs, entries, 'vac').map((e) => [e.kind, e.label])).toEqual([
      ['tab', 'Vacuum overview'],
      ['screen', 'Vacuum overview'],
    ]);
    expect(
      listEntries(tabs, entries, '')
        .slice(0, 3)
        .map((e) => e.kind)
    ).toEqual(['tab', 'tab', 'tool']);
  });
});

describe('the dialog', () => {
  it('has a visible "Quick open (⌘K)" button and a combobox over a listbox', () => {
    setup();
    expect(trigger().textContent).toBe('Quick open (⌘K)');
    const input = openPalette();
    expect(screen.getByRole('dialog', { name: 'Quick open' })).toBeTruthy();
    expect(input.tagName).toBe('INPUT');
    expect(input.getAttribute('aria-controls')).toBe(screen.getByRole('listbox').id);
    expect(document.activeElement).toBe(input);
    const first = options()[0];
    expect(input.getAttribute('aria-activedescendant')).toBe(first.id);
    expect(first.getAttribute('aria-selected')).toBe('true');
  });

  it('labels the button Ctrl+K off macOS', () => {
    setup({ mac: false });
    expect(trigger().textContent).toBe('Quick open (Ctrl+K)');
  });

  it('moves the active option with the arrows', () => {
    setup();
    const input = openPalette();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.getAttribute('aria-activedescendant')).toBe(options()[1].id);
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    const list = options();
    expect(input.getAttribute('aria-activedescendant')).toBe(list[list.length - 1].id);
  });

  it('filters as the user types and shows a named member with its collection', () => {
    setup();
    const input = openPalette();
    type(input, 'beam');
    const list = options();
    expect(list).toHaveLength(1);
    expect(list[0].textContent).toBe('Beam currentStorage ring');
  });

  it('omits collection entries when the feature is off', () => {
    setup({ collections: makeCollections(false) });
    openPalette();
    const kinds = options().map((o) => o.getAttribute('data-kind'));
    expect(kinds).not.toContain('collection');
    expect(kinds).not.toContain('member');
  });
});

describe('Enter and Shift+Enter (the row table)', () => {
  function choose(label: string, shiftKey: boolean, overrides: Partial<QuickOpenProps> = {}) {
    const result = setup(overrides);
    const input = openPalette();
    type(input, label);
    fireEvent.keyDown(input, { key: 'Enter', shiftKey });
    return result.props;
  }

  it('the open modifier opens a new tab like Shift (⌘ on macOS, Ctrl elsewhere)', () => {
    let { props } = setup();
    let input = openPalette();
    type(input, 'Vacuum overview');
    fireEvent.keyDown(input, { key: 'Enter', metaKey: true });
    expect(props.collections!.openMember).toHaveBeenCalledWith(
      { screen: 'examples/vacuum' },
      { newTab: true }
    );
    cleanup();
    ({ props } = setup({ collections: undefined }));
    input = openPalette();
    type(input, 'Vacuum overview');
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
    expect(props.onOpen).toHaveBeenCalledWith('examples/vacuum', 'replace');
    cleanup();
    ({ props } = setup({ collections: undefined, mac: false }));
    input = openPalette();
    type(input, 'Vacuum overview');
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
    expect(props.onOpen).toHaveBeenCalledWith('examples/vacuum', 'append');
    cleanup();
    ({ props } = setup({ collections: undefined, mac: false }));
    input = openPalette();
    type(input, 'Vacuum overview');
    fireEvent.click(options()[0], { ctrlKey: true });
    expect(props.onOpen).toHaveBeenCalledWith('examples/vacuum', 'append');
  });

  it('opens a screen through openMember (replace / new tab)', () => {
    let props = choose('Vacuum overview', false);
    expect(props.collections!.openMember).toHaveBeenCalledWith({ screen: 'examples/vacuum' }, {});
    expect(screen.queryByRole('dialog')).toBeNull();
    cleanup();
    props = choose('Vacuum overview', true);
    expect(props.collections!.openMember).toHaveBeenCalledWith(
      { screen: 'examples/vacuum' },
      { newTab: true }
    );
  });

  it('opens a screen through onOpen when the feature is off', () => {
    let props = choose('Vacuum overview', false, { collections: makeCollections(false) });
    expect(props.onOpen).toHaveBeenCalledWith('examples/vacuum', 'replace');
    cleanup();
    props = choose('Vacuum overview', true, { collections: undefined });
    expect(props.onOpen).toHaveBeenCalledWith('examples/vacuum', 'append');
  });

  it('opens a tool (bare member) or a new instance', () => {
    let props = choose('Data Browser', false);
    expect(props.collections!.openMember).toHaveBeenCalledWith({ tool: 'trace' }, {});
    cleanup();
    props = choose('Data Browser', true, { collections: undefined });
    expect(props.onNewTool).toHaveBeenCalledWith('trace');
    cleanup();
    props = choose('Data Browser', false, { collections: undefined });
    expect(props.onOpenTool).toHaveBeenCalledWith('trace');
  });

  it('opens a named tool member through openMember', () => {
    let props = choose('Beam current', false);
    expect(props.collections!.openMember).toHaveBeenCalledWith(RING.members[1], {});
    cleanup();
    props = choose('Beam current', true);
    expect(props.collections!.openMember).toHaveBeenCalledWith(RING.members[1], { newTab: true });
  });

  it('opens a saved view with openView / openView(newTab)', () => {
    let props = choose('Orbit drift', false);
    expect(props.onOpenView).toHaveBeenCalledWith(VIEWS[0], false);
    cleanup();
    props = choose('Orbit drift', true);
    expect(props.onOpenView).toHaveBeenCalledWith(VIEWS[0], true);
  });

  it('runs Open all for a collection either way', () => {
    let props = choose('Storage ring', false);
    expect(props.collections!.openAll).toHaveBeenCalledWith(RING);
    cleanup();
    props = choose('Storage ring', true);
    expect(props.collections!.openAll).toHaveBeenCalledWith(RING);
    expect(props.collections!.openMember).not.toHaveBeenCalled();
  });

  it('a click and a Shift+click follow the same table', () => {
    const { props } = setup();
    let input = openPalette();
    type(input, 'Orbit');
    fireEvent.click(options()[0], { shiftKey: true });
    expect(props.onOpenView).toHaveBeenCalledWith(VIEWS[0], true);
    input = openPalette();
    type(input, 'Orbit');
    fireEvent.click(options()[0]);
    expect(props.onOpenView).toHaveBeenLastCalledWith(VIEWS[0], false);
  });
});

describe('Switch to tab', () => {
  const TABS = [
    { key: 'examples/vacuum', title: 'Vacuum overview' },
    { key: '@trace', title: 'Data Browser' },
  ];

  it('lists the open tabs first and focuses the chosen one', () => {
    const onFocusTab = vi.fn();
    const { props } = setup({ tabs: TABS, activeKey: '@trace', onFocusTab });
    const input = openPalette();
    expect(options()[0].textContent).toBe('Switch to tab · Vacuum overviewOpen tab');
    expect(options()[1].textContent).toBe('Switch to tab · Data BrowserOpen tab');
    type(input, 'vacuum');
    expect(options().map((o) => o.getAttribute('data-kind'))).toEqual(['tab', 'screen']);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onFocusTab).toHaveBeenCalledWith('examples/vacuum');
    expect(props.collections!.openMember).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('post-open focus', () => {
  afterEach(() => {
    for (const el of document.querySelectorAll('[id^="canopy-tile-panel-"]')) el.remove();
  });

  function tile(key: string, placed = true) {
    const root = document.createElement('div');
    root.id = tilePanelId(key);
    root.tabIndex = -1;
    if (!placed) root.dataset.placed = 'false';
    document.body.appendChild(root);
    return root;
  }

  // The same tree as setup()'s, so the rerender keeps the mounted palette.
  function renderAt(activeKey: string | null, props: QuickOpenProps) {
    return (
      <>
        <input id="screen-tree-search" data-testid="tree-search" />
        <input data-testid="other-field" />
        <button type="button">elsewhere</button>
        <QuickOpen {...props} activeKey={activeKey} />
      </>
    );
  }

  it('focuses the opened tile once the active tab changes, not the opener', () => {
    vi.useFakeTimers();
    const opened = tile('examples/vacuum');
    const { props, rerender } = setup({ activeKey: '@trace' });
    trigger().focus();
    const input = openPalette();
    type(input, 'Vacuum overview');
    fireEvent.keyDown(input, { key: 'Enter' });
    rerender(renderAt('examples/vacuum', props));
    act(() => vi.runAllTimers());
    expect(document.activeElement).toBe(opened);
  });

  it('focuses the active tile when the active tab does not change', () => {
    vi.useFakeTimers();
    const same = tile('examples/vacuum');
    setup({ activeKey: 'examples/vacuum' });
    const input = openPalette();
    type(input, 'Vacuum overview');
    fireEvent.keyDown(input, { key: 'Enter' });
    act(() => vi.runAllTimers());
    expect(document.activeElement).toBe(same);
  });

  it('focuses the tile of a switched-to tab', () => {
    vi.useFakeTimers();
    const target = tile('examples/vacuum');
    setup({
      tabs: [{ key: 'examples/vacuum', title: 'Vacuum overview' }],
      activeKey: 'examples/vacuum',
      onFocusTab: vi.fn(),
    });
    const input = openPalette();
    fireEvent.keyDown(input, { key: 'Enter' });
    act(() => vi.runAllTimers());
    expect(document.activeElement).toBe(target);
  });

  it('falls back to the opener when the opened tile is not shown', () => {
    vi.useFakeTimers();
    tile('examples/vacuum', false);
    const { props, rerender } = setup({ activeKey: '@trace' });
    trigger().focus();
    const input = openPalette();
    type(input, 'Vacuum overview');
    fireEvent.keyDown(input, { key: 'Enter' });
    rerender(renderAt('examples/vacuum', props));
    act(() => vi.runAllTimers());
    expect(document.activeElement).toBe(trigger());
  });
});

describe('the dock live region', () => {
  const titles: Record<string, string> = { '@trace': 'Data Browser', 'gtb/GTLView': 'GTLView' };
  const titleOf = (key: string) => titles[key] ?? key;
  const say = (kind: string, id: string, open: string[]) =>
    dockAnnouncement({ kind, panel: { id } }, open, titleOf);

  it('never says "<open tab> closed" across open, close and reopen', () => {
    // open GTLView: the open path re-places Data Browser
    expect(say('open', 'gtb/GTLView', ['@trace', 'gtb/GTLView'])).toBe('GTLView opened');
    expect(say('close', '@trace', ['@trace', 'gtb/GTLView'])).toBeNull();
    // close GTLView
    expect(say('close', 'gtb/GTLView', ['@trace'])).toBe('GTLView closed');
    // reopen GTLView
    expect(say('open', 'gtb/GTLView', ['@trace', 'gtb/GTLView'])).toBe('GTLView opened');
    expect(say('close', '@trace', ['@trace', 'gtb/GTLView'])).toBeNull();
  });

  it('keeps the default for other events', () => {
    expect(say('maximize', '@trace', ['@trace'])).toBeUndefined();
  });
});

describe('Esc and focus return', () => {
  it('returns focus to the opener', () => {
    vi.useFakeTimers();
    setup();
    trigger().focus();
    const input = openPalette();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    act(() => vi.runAllTimers());
    expect(document.activeElement).toBe(trigger());
  });

  it('returns focus to the tree search when the opener was a tool frame', () => {
    vi.useFakeTimers();
    setup();
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    act(() => {
      expect(openQuickOpen(frame)).toBe(true);
    });
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
    act(() => vi.runAllTimers());
    expect(document.activeElement).toBe(screen.getByTestId('tree-search'));
    frame.remove();
  });

  it('openQuickOpen() is false with no palette mounted', () => {
    expect(openQuickOpen()).toBe(false);
  });
});

describe('primary+K', () => {
  it('opens the palette from the document', () => {
    setup();
    const event = new KeyboardEvent('keydown', {
      key: 'k',
      code: 'KeyK',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      screen.getByRole('button', { name: 'elsewhere' }).dispatchEvent(event);
    });
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(event.defaultPrevented).toBe(true);
  });

  it('opens from the tree search but not from another editable field', () => {
    setup();
    fireEvent.keyDown(screen.getByTestId('other-field'), { key: 'k', code: 'KeyK', metaKey: true });
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.keyDown(screen.getByTestId('tree-search'), { key: 'k', code: 'KeyK', metaKey: true });
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('ignores Ctrl+K on macOS and Shift or Alt combos', () => {
    setup();
    const body = document.body;
    fireEvent.keyDown(body, { key: 'k', code: 'KeyK', ctrlKey: true });
    fireEvent.keyDown(body, { key: 'K', code: 'KeyK', metaKey: true, shiftKey: true });
    fireEvent.keyDown(body, { key: 'k', code: 'KeyK', metaKey: true, altKey: true });
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.keyDown(body, { key: 'k', code: 'KeyK', metaKey: true });
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('uses Ctrl off macOS', () => {
    setup({ mac: false });
    fireEvent.keyDown(document.body, { key: 'k', code: 'KeyK', ctrlKey: true });
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
});

describe('stylesheet', () => {
  it('takes font sizes from the contract type scale only', () => {
    const sizes = [...css.matchAll(/font-size\s*:\s*([^;]+);/g)].map((m) => m[1].trim());
    expect(sizes.length).toBeGreaterThan(0);
    for (const size of sizes) expect(size).toMatch(/^var\(--canopy-text-(md|sm)\)$/);
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).toContain('.quick-open__option--active');
  });
});
