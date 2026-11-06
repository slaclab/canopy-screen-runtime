// The Browse tree: Pinned, Recent, the shown
// collections, Tools and All screens in one NavTree; All screens' selection-
// driven expansion; `<group>:<key>` node ids; the aria-selected rule; the Pin
// star; member and collection row menus; row rules through openMember; the
// sub-screen toggle scoped to All screens; the rendered member-key set; the
// scoped browser keys; personal-collection editing: Rename as an
// inline field held across polls, Delete and × at once with an Undo toast,
// Move up/down and Alt+Up/Down, the same-collection drop zone, the
// conditional-write outcome wording, and none of it on a facility collection.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ManifestScreen } from '../api.js';
import { showSubScreensKey } from '../screenList.js';
import {
  CODE_SCREEN,
  NOT_IN_LIBRARY,
  memberKey,
  renamed,
  reordered,
  toolUnavailable,
  withoutMember,
} from './collections.js';
import type { Member, MemberKey } from './collections.js';
import type { NavNode } from './NavTree.js';
import {
  BRANCH_PINNED,
  BRANCH_SCREENS,
  REORDER_TYPE,
  ScreenTree,
  browseSelection,
  collapsedStorageKey,
  memberNodeId,
} from './ScreenTree.js';
import type { BrowseCollections, ScreenTreeProps, ToolEntry } from './ScreenTree.js';
import { EMPTY_TABS } from './tabs.js';
import type { TabsState } from './tabs.js';
import type { Collection } from './useCollections.js';
import { EMPTY_STATE } from './useCollections.js';
import type { CollectionsApi, EditResult, DeleteResult } from './useCollections.js';
import { ToastContext } from './useToasts.js';
import type { ToastSpec, ToastStore } from './useToasts.js';

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

function entry(category: string, id: string, title: string, kind = 'ir'): ManifestScreen {
  return { id, kind, title, category, path: `screens/${category}/${id}.screen.json` };
}

const SCREENS: ManifestScreen[] = [
  entry('library', 'sr/overview', 'SR Overview'),
  entry('library', 'bts/BTSView', 'BTS View'),
  entry('library', 'bts/embedded/_part', 'BTS Part'),
  entry('library', 'legacy', 'Legacy', 'code'),
];

const TOOLS: ToolEntry[] = [
  { id: 'trace', label: 'Data Browser', treeLabel: 'Data Browser (Trace)' },
];

const OVERVIEW: Member = { screen: 'library/sr/overview' };
const BTS: Member = { screen: 'library/bts/BTSView' };
const PART: Member = { screen: 'library/bts/embedded/_part' };
const GONE: Member = { screen: 'library/gone' };
const CODE: Member = { screen: 'library/legacy' };
const NAMED_TRACE: Member = { tool: 'trace', query: 'pvs=A', name: 'Orbit trace' };
const ELSEWHERE: Member = { tool: 'nowhere', name: 'Elsewhere' };

function collection(
  source: 'facility' | 'personal',
  id: string,
  name: string,
  members: Member[]
): Collection {
  return {
    source,
    ref: `${source}:${id}`,
    id,
    name,
    members,
    layout: null,
    default: source === 'facility',
  };
}

const OPS = collection('facility', 'ops', 'Operations', [BTS, NAMED_TRACE, PART]);
const MINE = collection('personal', 'mine', 'My panels', [OVERVIEW, GONE, CODE, ELSEWHERE]);

/** MINE as listed: raw keeps an unkeyable member at raw index 1, so rawIndex skips it. */
const EDITABLE: Collection = {
  ...MINE,
  rev: 'rev0',
  raw: {
    id: 'mine',
    name: 'My panels',
    members: [OVERVIEW, { bogus: true }, GONE, CODE, ELSEWHERE],
  },
  rawIndex: [0, 2, 3, 4],
};

type EditFn = NonNullable<CollectionsApi['edit']>;
type DeleteFn = NonNullable<CollectionsApi['deleteCollection']>;

/** The edit half of the hook, every gesture succeeding with its own undo. */
function editApi(over: { edit?: EditResult; del?: DeleteResult } = {}): Pick<
  BrowseCollections,
  'edit' | 'deleteCollection' | 'holdCollection'
> & {
  undo: ReturnType<typeof vi.fn>;
} {
  const undo = vi.fn(() => Promise.resolve({ ok: true as const }));
  return {
    undo,
    edit: vi.fn<EditFn>(() =>
      Promise.resolve(over.edit ?? { ok: true as const, collection: null, undo })
    ),
    deleteCollection: vi.fn<DeleteFn>(() =>
      Promise.resolve(over.del ?? { ok: true as const, missing: false, undo })
    ),
    holdCollection: vi.fn(),
  };
}

/** A toast store that records what was shown. */
function toastStore(): ToastStore & { shown: ToastSpec[] } {
  const shown: ToastSpec[] = [];
  return {
    shown,
    toast: null,
    show: vi.fn((spec: ToastSpec) => {
      shown.push(spec);
      return shown.length;
    }),
    dismiss: vi.fn(),
    runAction: vi.fn(),
    setPaused: vi.fn(),
  };
}

function api(over: Partial<BrowseCollections> = {}): BrowseCollections {
  const pinned = over.state?.pinned ?? [];
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
    ...over,
  };
}

function withPinned(members: Member[], over: Partial<BrowseCollections> = {}): BrowseCollections {
  return api({
    state: { ...EMPTY_STATE, pinned: members },
    pinnedKeys: new Set(members.map(memberKey)),
    ...over,
  });
}

function tree(props: Partial<ScreenTreeProps> = {}) {
  return render(<ScreenTree screens={SCREENS} tools={TOOLS} onOpen={() => {}} {...props} />);
}

function topLabels(): string[] {
  return Array.from(
    document.querySelectorAll('[role="tree"] > [role="treeitem"]'),
    (item) => item.querySelector(':scope > .nav-tree__row .nav-tree__label')?.textContent ?? ''
  );
}

function branch(name: string): HTMLElement {
  return screen.getByRole('treeitem', { name });
}

/** The member row of `member` in `group`. */
function row(group: string, member: Member): HTMLElement {
  const el = document.getElementById(
    `screen-tree-${encodeURIComponent(memberNodeId(group, memberKey(member)))}`
  );
  if (!el) throw new Error(`no row ${group}:${memberKey(member)}`);
  return el;
}

const rowOf = (item: HTMLElement) => item.querySelector<HTMLElement>(':scope > .nav-tree__row')!;

beforeEach(() => {
  globalThis.localStorage?.clear();
});

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute('data-canopy-storage-scope');
  vi.restoreAllMocks();
});

describe('Browse tree branches', () => {
  it('orders Pinned, Recent, the shown collections, Tools, All screens', () => {
    tree({
      collections: withPinned([OVERVIEW], { recent: [BTS], shown: [OPS, MINE] }),
    });
    expect(topLabels()).toEqual([
      'Pinned',
      'Recent',
      'Operations',
      'My panels',
      'Tools',
      'All screens',
    ]);
    for (const item of document.querySelectorAll<HTMLElement>(
      '[role="tree"] > [role="treeitem"]'
    )) {
      expect(rowOf(item).classList.contains('canopy-section-heading')).toBe(true);
      expect(item.getAttribute('aria-level')).toBe('1');
    }
    // Members in array order.
    const members = Array.from(
      branch('Operations').querySelectorAll(':scope > [role="group"] > [role="treeitem"]'),
      (item) => item.getAttribute('data-member-key')
    );
    expect(members).toEqual([BTS, NAMED_TRACE, PART].map(memberKey));
  });

  it('sets a collection heading like the fixed branches, its full name on hover', () => {
    tree({ collections: api({ shown: [OPS, MINE] }) });
    for (const name of ['Operations', 'My panels', 'Tools', 'All screens']) {
      expect(branch(name).classList.contains('screen-tree__heading')).toBe(true);
    }
    expect(branch('Operations').getAttribute('title')).toContain('Operations');
  });

  it('omits each empty branch but Pinned; without the feature only Tools and All screens', () => {
    tree({ collections: api() });
    expect(topLabels()).toEqual(['Pinned', 'Tools', 'All screens']);
    cleanup();
    tree({ collections: api({ enabled: false, shown: [OPS], recent: [BTS] }) });
    expect(topLabels()).toEqual(['Tools', 'All screens']);
    expect(screen.queryByRole('button', { name: 'Pin' })).toBeNull();
    cleanup();
    tree({ tools: [], screens: [] });
    expect(topLabels()).toEqual([]);
    expect(screen.getByText('No screens to show.')).toBeTruthy();
  });

  it('uses <group>:<key> node ids', () => {
    tree({ collections: withPinned([OVERVIEW], { shown: [OPS] }) });
    expect(row('pinned', OVERVIEW).id).toBe(
      'screen-tree-' + encodeURIComponent('pinned:screen:library/sr/overview')
    );
    expect(row('facility:ops', NAMED_TRACE).getAttribute('data-group')).toBe('facility:ops');
    expect(row('tools', { tool: 'trace' }).getAttribute('data-tool')).toBe('trace');
    expect(row('screens', BTS).getAttribute('data-screen-key')).toBe('library/bts/BTSView');
  });

  it('filters Pinned, Recent and collections by row while searching', () => {
    tree({ collections: withPinned([OVERVIEW], { recent: [BTS], shown: [OPS] }) });
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'overview' } });
    // Pinned keeps its matching row; Recent and Operations have none left.
    expect(topLabels()).toEqual(['Pinned', 'All screens']);
    expect(branch('All screens').getAttribute('aria-expanded')).toBe('true');
    // The Pinned row and the All screens row.
    expect(screen.getAllByText('SR Overview')).toHaveLength(2);
  });
});

describe('All screens expansion', () => {
  it('is expanded by default, with or without a shown selection', () => {
    tree({ collections: api() });
    expect(branch('All screens').getAttribute('aria-expanded')).toBe('true');
    cleanup();
    tree({ collections: api({ shown: [OPS] }) });
    expect(branch('All screens').getAttribute('aria-expanded')).toBe('true');
  });

  it('stays expanded across a tick', () => {
    const { rerender } = tree({ collections: api() });
    rerender(
      <ScreenTree
        screens={SCREENS}
        tools={TOOLS}
        onOpen={() => {}}
        collections={api({ shown: [OPS] })}
      />
    );
    expect(branch('All screens').getAttribute('aria-expanded')).toBe('true');
  });

  it('keeps a manual collapse across ticks and unticks for the session, never storing it', () => {
    const one = api({ shown: [OPS] });
    const { rerender } = tree({ collections: one });
    fireEvent.click(rowOf(branch('All screens')));
    expect(branch('All screens').getAttribute('aria-expanded')).toBe('false');
    expect(globalThis.localStorage.getItem(collapsedStorageKey()) ?? '[]').not.toContain(
      BRANCH_SCREENS
    );
    // A tick keeps it.
    rerender(
      <ScreenTree
        screens={SCREENS}
        tools={TOOLS}
        onOpen={() => {}}
        collections={api({ shown: [OPS, MINE] })}
      />
    );
    expect(branch('All screens').getAttribute('aria-expanded')).toBe('false');
    // So does an untick of everything.
    rerender(<ScreenTree screens={SCREENS} tools={TOOLS} onOpen={() => {}} collections={api()} />);
    expect(branch('All screens').getAttribute('aria-expanded')).toBe('false');
    // A search opens it while the query lasts.
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'overview' } });
    expect(branch('All screens').getAttribute('aria-expanded')).toBe('true');
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } });
    expect(branch('All screens').getAttribute('aria-expanded')).toBe('false');
    // A fresh mount (reload) starts expanded again.
    cleanup();
    tree({ collections: api({ shown: [OPS] }) });
    expect(branch('All screens').getAttribute('aria-expanded')).toBe('true');
  });

  it('remembers other collapsed branches under the one scoped key', () => {
    tree({ collections: api({ shown: [OPS] }) });
    fireEvent.click(rowOf(branch('Tools')));
    expect(JSON.parse(globalThis.localStorage.getItem(collapsedStorageKey())!)).toEqual([
      'branch:tools',
    ]);
    cleanup();
    tree({ collections: api({ shown: [OPS] }) });
    expect(branch('Tools').getAttribute('aria-expanded')).toBe('false');
  });
});

describe('Browse tree storage keys', () => {
  it('scopes both keys per mount and per host user', () => {
    expect(collapsedStorageKey('/')).toBe('canopy-viewer:tree-collapsed:/');
    expect(showSubScreensKey('/x/y/')).toBe('canopy-viewer:show-sub-screens:/x/y');
    document.documentElement.setAttribute('data-canopy-storage-scope', 'alice');
    expect(collapsedStorageKey('/x')).toBe('canopy-viewer:tree-collapsed:/x--alice');
    globalThis.localStorage.setItem(showSubScreensKey('/'), '1');
    document.documentElement.setAttribute('data-canopy-storage-scope', 'bob');
    tree();
    // Alice's choice does not reach Bob.
    expect(screen.queryByText('BTS Part')).toBeNull();
  });
});

describe('Browse tree sub-screen toggle', () => {
  it('filters All screens only, never a collection member', () => {
    tree({ collections: api({ shown: [OPS] }) });
    expect(row('facility:ops', PART)).toBeTruthy();
    expect(() => row('screens', PART)).toThrow();
    fireEvent.click(screen.getByLabelText(/Show sub-screens/));
    expect(row('screens', PART)).toBeTruthy();
  });
});

describe('Browse tree member rows', () => {
  it('render unresolved members disabled with their reason, pending ones plain', () => {
    tree({ collections: api({ shown: [MINE] }) });
    expect(row('personal:mine', GONE).getAttribute('aria-disabled')).toBe('true');
    expect(row('personal:mine', GONE).getAttribute('title')).toContain(NOT_IN_LIBRARY);
    expect(row('personal:mine', CODE).getAttribute('title')).toContain(CODE_SCREEN);
    expect(row('personal:mine', ELSEWHERE).getAttribute('title')).toContain(
      toolUnavailable('nowhere')
    );
    cleanup();
    tree({ screens: null, collections: api({ shown: [MINE] }) });
    expect(row('personal:mine', GONE).getAttribute('aria-disabled')).toBeNull();
    expect(row('personal:mine', OVERVIEW).getAttribute('aria-disabled')).toBeNull();
  });

  it('label a screen member by its title, a named tool member by its name', () => {
    tree({ collections: api({ shown: [OPS] }) });
    expect(rowOf(row('facility:ops', BTS)).textContent).toContain('BTS View');
    expect(rowOf(row('facility:ops', NAMED_TRACE)).textContent).toContain('Orbit trace');
  });

  it('open through openMember: click replaces, Shift or Shift+Enter appends', () => {
    const c = api({ shown: [OPS] });
    tree({ collections: c });
    fireEvent.click(rowOf(row('facility:ops', BTS)));
    expect(c.openMember).toHaveBeenLastCalledWith(BTS, {});
    fireEvent.click(rowOf(row('facility:ops', NAMED_TRACE)), { shiftKey: true });
    expect(c.openMember).toHaveBeenLastCalledWith(NAMED_TRACE, { newTab: true });
    const item = row('facility:ops', BTS);
    item.focus();
    fireEvent.keyDown(item, { key: 'Enter', shiftKey: true });
    expect(c.openMember).toHaveBeenLastCalledWith(BTS, { newTab: true });
    // The Tools row and an All screens leaf follow the same rules.
    fireEvent.click(rowOf(row('tools', { tool: 'trace' })));
    expect(c.openMember).toHaveBeenLastCalledWith({ tool: 'trace' }, {});
    fireEvent.click(rowOf(row('screens', OVERVIEW)), { shiftKey: true });
    expect(c.openMember).toHaveBeenLastCalledWith(OVERVIEW, { newTab: true });
  });

  it('without the feature fall back to onOpen / onOpenTool / onNewTool', () => {
    const onOpen = vi.fn();
    const onOpenTool = vi.fn();
    const onNewTool = vi.fn();
    tree({ onOpen, onOpenTool, onNewTool });
    fireEvent.click(rowOf(row('screens', OVERVIEW)));
    expect(onOpen).toHaveBeenLastCalledWith('library/sr/overview', 'replace');
    fireEvent.click(rowOf(row('screens', OVERVIEW)), { shiftKey: true });
    expect(onOpen).toHaveBeenLastCalledWith('library/sr/overview', 'append');
    fireEvent.click(rowOf(row('tools', { tool: 'trace' })), { shiftKey: true });
    expect(onNewTool).toHaveBeenLastCalledWith('trace');
    expect(onOpenTool).not.toHaveBeenCalled();
  });

  it('offer Open in new tab and Pin, or Unpin when pinned (also unresolved)', () => {
    const c = withPinned([GONE], { shown: [OPS, MINE] });
    tree({ collections: c });
    fireEvent.contextMenu(rowOf(row('facility:ops', BTS)));
    fireEvent.click(screen.getByText('Open in new tab'));
    expect(c.openMember).toHaveBeenLastCalledWith(BTS, { newTab: true });
    fireEvent.contextMenu(rowOf(row('facility:ops', BTS)));
    fireEvent.click(screen.getByText('Pin'));
    expect(c.pin).toHaveBeenLastCalledWith(BTS);
    // An unresolved pinned member: Unpin only.
    fireEvent.contextMenu(rowOf(row('pinned', GONE)));
    expect(screen.queryByText('Open in new tab')).toBeNull();
    fireEvent.click(screen.getByText('Unpin'));
    expect(c.unpin).toHaveBeenLastCalledWith(GONE);
    // An unresolved unpinned member has no menu items at all.
    fireEvent.contextMenu(rowOf(row('personal:mine', CODE)));
    expect(screen.queryByText('Pin')).toBeNull();
  });

  it('show a Pin star without a trailing action, and the pinned star that unpins', () => {
    const c = withPinned([OVERVIEW, { tool: 'trace' }], { shown: [OPS] });
    tree({ collections: c, onNewTool: () => {} });
    const pin = row('facility:ops', BTS).querySelector<HTMLElement>('.nav-tree__action--hover')!;
    expect(pin.getAttribute('aria-label')).toBe('Pin');
    expect(pin.classList.contains('nav-tree__action--persistent')).toBe(false);
    fireEvent.click(pin);
    expect(c.pin).toHaveBeenLastCalledWith(BTS);
    expect(c.openMember).not.toHaveBeenCalled();
    const star = row('pinned', OVERVIEW).querySelector<HTMLElement>('.nav-tree__action--hover')!;
    expect(star.getAttribute('aria-label')).toBe('Unpin');
    expect(star.classList.contains('nav-tree__action--persistent')).toBe(true);
    fireEvent.click(star);
    expect(c.unpin).toHaveBeenLastCalledWith(OVERVIEW);
    // The Tools row keeps its '+': the pinned star is an icon-only marker there.
    const tool = row('tools', { tool: 'trace' });
    expect(tool.querySelector('.nav-tree__action--hover')).toBeNull();
    expect(tool.querySelector('.nav-tree__marker svg')).not.toBeNull();
    expect(tool.querySelector('.nav-tree__marker')!.getAttribute('aria-hidden')).toBe('true');
  });

  it('drag their member', () => {
    const onDragStart = vi.fn();
    tree({ collections: api({ shown: [OPS] }), onDragStart });
    fireEvent.dragStart(rowOf(row('facility:ops', NAMED_TRACE)));
    expect(onDragStart).toHaveBeenLastCalledWith(NAMED_TRACE, null);
  });
});

describe('Browse tree collection rows', () => {
  it('run Open all on click; the menu offers Open all, Untick, and Rename/Delete for personal', () => {
    const c = api({ shown: [OPS, EDITABLE], ...editApi() });
    tree({ collections: c });
    fireEvent.click(rowOf(branch('Operations')));
    expect(c.openAll).toHaveBeenLastCalledWith(OPS);
    fireEvent.contextMenu(rowOf(branch('Operations')));
    expect(screen.queryByText('Delete')).toBeNull();
    expect(screen.queryByText('Rename')).toBeNull();
    expect(screen.queryByText('Pin')).toBeNull();
    fireEvent.click(screen.getByText('Untick'));
    expect(c.untick).toHaveBeenLastCalledWith('facility:ops');
    fireEvent.contextMenu(rowOf(branch('My panels')));
    expect(screen.getByText('Rename')).toBeTruthy();
    expect(screen.getByText('Delete')).toBeTruthy();
    fireEvent.click(screen.getByText('Open all'));
    expect(c.openAll).toHaveBeenLastCalledWith(EDITABLE);
  });
});

describe('Browse tree selection', () => {
  it('marks the occurrence in the group last activated from, else the first visible one', () => {
    const c = withPinned([BTS], { shown: [OPS] });
    const { rerender } = tree({ collections: c, activeKey: 'library/bts/BTSView' });
    expect(row('pinned', BTS).getAttribute('aria-selected')).toBe('true');
    expect(row('facility:ops', BTS).getAttribute('aria-selected')).toBe('false');
    fireEvent.click(rowOf(row('facility:ops', BTS)));
    rerender(
      <ScreenTree
        screens={SCREENS}
        tools={TOOLS}
        onOpen={() => {}}
        collections={c}
        activeKey="library/bts/BTSView"
      />
    );
    expect(row('facility:ops', BTS).getAttribute('aria-selected')).toBe('true');
    expect(row('pinned', BTS).getAttribute('aria-selected')).toBe('false');
  });

  it('skips an occurrence inside a collapsed branch', () => {
    tree({ collections: withPinned([BTS], { shown: [OPS] }), activeKey: 'library/bts/BTSView' });
    fireEvent.click(rowOf(branch('Pinned')));
    expect(row('facility:ops', BTS).getAttribute('aria-selected')).toBe('true');
  });

  it('for a tool tab marks the members its instance shows, plus its Tools row', () => {
    const tabs: TabsState = {
      ...EMPTY_TABS,
      keys: ['@trace', '@trace/2'],
      active: '@trace/2',
      layout: { tile: 't1', tabs: ['@trace', '@trace/2'], showing: '@trace/2' },
      focusedTile: 't1',
      toolMru: ['@trace/2', '@trace'],
      instances: {
        '@trace': { query: null },
        '@trace/2': { query: 'pvs=B', from: memberKey(NAMED_TRACE) },
      },
    };
    tree({ collections: api({ shown: [OPS] }), activeKey: '@trace/2', tabs });
    expect(row('facility:ops', NAMED_TRACE).getAttribute('aria-selected')).toBe('true');
    // Its Tools row is the candidate when the member is not visible.
    cleanup();
    tree({ collections: api({ shown: [OPS] }), activeKey: '@trace', tabs });
    expect(row('tools', { tool: 'trace' }).getAttribute('aria-selected')).toBe('true');
    expect(row('facility:ops', NAMED_TRACE).getAttribute('aria-selected')).toBe('false');
  });

  it('browseSelection: the last group if visible, else the first visible, else none', () => {
    const leaf = (id: string): NavNode => ({ id, label: id });
    const nodes: NavNode[] = [
      { id: BRANCH_PINNED, label: 'Pinned', children: [leaf('pinned:k')] },
      { id: 'collection:c', label: 'C', children: [leaf('c:k')] },
    ];
    const groupOf = (id: string) => id.slice(0, id.lastIndexOf(':'));
    const all = new Set([BRANCH_PINNED, 'collection:c']);
    const both = new Set(['pinned:k', 'c:k']);
    expect(browseSelection(nodes, all, both, groupOf, null)).toBe('pinned:k');
    expect(browseSelection(nodes, all, both, groupOf, 'c')).toBe('c:k');
    // Pinned collapsed: its occurrence is not visible.
    expect(browseSelection(nodes, new Set(['collection:c']), both, groupOf, 'pinned')).toBe('c:k');
    expect(browseSelection(nodes, new Set(), both, groupOf, null)).toBeNull();
  });
});

describe('Browse tree rendered keys and Recent hover', () => {
  it('reports the member keys it renders when that set changes', () => {
    const onRenderedKeys = vi.fn();
    const { rerender } = tree({ collections: api({ shown: [OPS] }), onRenderedKeys });
    const keys = onRenderedKeys.mock.lastCall![0] as ReadonlySet<MemberKey>;
    expect(keys.has(memberKey(NAMED_TRACE))).toBe(true);
    expect(keys.has(memberKey({ tool: 'trace' }))).toBe(true);
    expect(keys.has(memberKey(OVERVIEW))).toBe(true);
    expect(keys.has(memberKey(CODE))).toBe(false);
    const calls = onRenderedKeys.mock.calls.length;
    rerender(
      <ScreenTree
        screens={SCREENS}
        tools={TOOLS}
        onOpen={() => {}}
        collections={api({ shown: [OPS] })}
        onRenderedKeys={onRenderedKeys}
      />
    );
    expect(onRenderedKeys.mock.calls.length).toBe(calls);
    rerender(
      <ScreenTree
        screens={SCREENS}
        tools={TOOLS}
        onOpen={() => {}}
        collections={api({ shown: [] })}
        onRenderedKeys={onRenderedKeys}
      />
    );
    const after = onRenderedKeys.mock.lastCall![0] as ReadonlySet<MemberKey>;
    expect(after.has(memberKey(NAMED_TRACE))).toBe(false);
  });

  it('tells the hook when the pointer enters and leaves Recent', () => {
    const c = api({ recent: [BTS] });
    tree({ collections: c });
    fireEvent.pointerOver(rowOf(row('recent', BTS)));
    expect(c.setRecentHover).toHaveBeenLastCalledWith(true);
    fireEvent.pointerOver(rowOf(branch('Tools')));
    expect(c.setRecentHover).toHaveBeenLastCalledWith(false);
    fireEvent.pointerOver(rowOf(row('recent', BTS)));
    fireEvent.pointerLeave(document.querySelector('.screen-tree__body')!);
    expect(c.setRecentHover).toHaveBeenLastCalledWith(false);
    expect(c.setRecentHover).toHaveBeenCalledTimes(4);
  });
});

describe('Browse tree collection editing', () => {
  function edited(props: Partial<ScreenTreeProps> = {}) {
    const store = toastStore();
    const view = render(
      <ToastContext.Provider value={store}>
        <ScreenTree screens={SCREENS} tools={TOOLS} onOpen={() => {}} {...props} />
      </ToastContext.Provider>
    );
    const rerender = (next: Partial<ScreenTreeProps>) =>
      view.rerender(
        <ToastContext.Provider value={store}>
          <ScreenTree screens={SCREENS} tools={TOOLS} onOpen={() => {}} {...props} {...next} />
        </ToastContext.Provider>
      );
    return { store, rerender };
  }

  /** The change an edit mock was last called with, applied to EDITABLE's raw. */
  function lastChange(edit: unknown) {
    const [target, change] = (edit as ReturnType<typeof vi.fn>).mock.lastCall as Parameters<EditFn>;
    expect(target).toBe(EDITABLE);
    return change(EDITABLE.raw!);
  }

  const renameField = () => screen.getByRole('textbox', { name: 'Rename \u201cMy panels\u201d' });

  it('Delete acts at once (no dialog) and offers Undo in a toast', async () => {
    const e = editApi();
    const c = api({ shown: [EDITABLE], ...e });
    const { store } = edited({ collections: c });
    fireEvent.contextMenu(rowOf(branch('My panels')));
    await act(async () => {
      fireEvent.click(screen.getByText('Delete'));
    });
    expect(c.deleteCollection).toHaveBeenCalledWith(EDITABLE);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(store.shown).toHaveLength(1);
    expect(store.shown[0]!.message).toBe('Deleted \u201cMy panels\u201d');
    expect(store.shown[0]!.action?.label).toBe('Undo');
    await act(async () => {
      store.shown[0]!.action!.run();
    });
    expect(e.undo).toHaveBeenCalledTimes(1);
  });

  it('words a refused Delete and an Undo that finds the id taken; a 404 Delete is silent', async () => {
    const undo = vi.fn(() => Promise.resolve({ ok: false as const, reason: 'exists' as const }));
    let e = editApi({ del: { ok: false, reason: 'stale' } });
    const { store, rerender } = edited({ collections: api({ shown: [EDITABLE], ...e }) });
    fireEvent.contextMenu(rowOf(branch('My panels')));
    await act(async () => {
      fireEvent.click(screen.getByText('Delete'));
    });
    expect(store.shown.at(-1)!.message).toBe('Not deleted: changed on another console');
    expect(store.shown.at(-1)!.action).toBeUndefined();

    e = editApi({ del: { ok: true, missing: true, undo } });
    rerender({ collections: api({ shown: [EDITABLE], ...e }) });
    fireEvent.contextMenu(rowOf(branch('My panels')));
    await act(async () => {
      fireEvent.click(screen.getByText('Delete'));
    });
    expect(store.shown).toHaveLength(1);

    e = editApi({ del: { ok: true, missing: false, undo } });
    rerender({ collections: api({ shown: [EDITABLE], ...e }) });
    fireEvent.contextMenu(rowOf(branch('My panels')));
    await act(async () => {
      fireEvent.click(screen.getByText('Delete'));
    });
    await act(async () => {
      store.shown.at(-1)!.action!.run();
    });
    expect(store.shown.at(-1)!.message).toBe(
      'Could not undo: a collection with that id now exists'
    );
  });

  it('Rename opens an inline field holding the collection; Enter commits one edit', async () => {
    const e = editApi();
    const c = api({ shown: [EDITABLE], ...e });
    edited({ collections: c });
    fireEvent.contextMenu(rowOf(branch('My panels')));
    fireEvent.click(screen.getByText('Rename'));
    const field = renameField() as HTMLInputElement;
    expect(document.activeElement).toBe(field);
    expect(field.value).toBe('My panels');
    expect(c.holdCollection).toHaveBeenLastCalledWith('personal:mine');
    // Typing in the field never opens the collection.
    fireEvent.click(field);
    expect(c.openAll).not.toHaveBeenCalled();
    fireEvent.change(field, { target: { value: '  Ring panels ' } });
    await act(async () => {
      fireEvent.keyDown(field, { key: 'Enter' });
    });
    expect(c.holdCollection).toHaveBeenLastCalledWith(null);
    expect(c.edit).toHaveBeenCalledTimes(1);
    expect(lastChange(c.edit)).toEqual(renamed(EDITABLE.raw!, 'Ring panels'));
    expect(screen.queryByRole('textbox', { name: /Rename/ })).toBeNull();
    expect(document.activeElement).toBe(branch('My panels'));
  });

  it('Esc, or an unchanged name, cancels the rename without a write', () => {
    const c = api({ shown: [EDITABLE], ...editApi() });
    edited({ collections: c });
    fireEvent.contextMenu(rowOf(branch('My panels')));
    fireEvent.click(screen.getByText('Rename'));
    fireEvent.change(renameField(), { target: { value: 'Other' } });
    fireEvent.keyDown(renameField(), { key: 'Escape' });
    expect(screen.queryByRole('textbox', { name: /Rename/ })).toBeNull();
    fireEvent.contextMenu(rowOf(branch('My panels')));
    fireEvent.click(screen.getByText('Rename'));
    fireEvent.blur(renameField());
    expect(c.edit).not.toHaveBeenCalled();
    expect(c.holdCollection).toHaveBeenLastCalledWith(null);
  });

  it('a poll during rename keeps the input and what was typed', () => {
    const e = editApi();
    const { rerender } = edited({ collections: api({ shown: [EDITABLE], ...e }) });
    fireEvent.contextMenu(rowOf(branch('My panels')));
    fireEvent.click(screen.getByText('Rename'));
    fireEvent.change(renameField(), { target: { value: 'Half typed' } });
    // A poll answer lands: a new list object (here the server's newer rev).
    rerender({ collections: api({ shown: [{ ...EDITABLE, rev: 'rev1' }], ...e }) });
    const field = renameField() as HTMLInputElement;
    expect(field.value).toBe('Half typed');
    expect(document.activeElement).toBe(field);
  });

  it('× and "Remove from collection" remove the member by its raw index, with Undo', async () => {
    const e = editApi();
    const c = api({ shown: [EDITABLE], ...e });
    const { store } = edited({ collections: c });
    const x = row('personal:mine', GONE).querySelector<HTMLElement>('.nav-tree__action--remove')!;
    expect(x.getAttribute('aria-label')).toBe('Remove from collection');
    await act(async () => {
      fireEvent.click(x);
    });
    expect(c.openMember).not.toHaveBeenCalled();
    // GONE is members[1], raw index 2 (the unkeyable member sits at raw 1).
    expect(lastChange(c.edit)).toEqual(withoutMember(EDITABLE.raw!, 2));
    expect(store.shown.at(-1)!.message).toBe(
      'Removed \u201clibrary/gone\u201d from \u201cMy panels\u201d'
    );
    await act(async () => {
      store.shown.at(-1)!.action!.run();
    });
    expect(e.undo).toHaveBeenCalledTimes(1);
    fireEvent.contextMenu(rowOf(row('personal:mine', ELSEWHERE)));
    await act(async () => {
      fireEvent.click(screen.getByText('Remove from collection'));
    });
    expect(lastChange(c.edit)).toEqual(withoutMember(EDITABLE.raw!, 4));
  });

  it('Move up / Move down on the member menu, and Alt+Up / Alt+Down, reorder by raw index', async () => {
    const c = api({ shown: [EDITABLE], ...editApi() });
    edited({ collections: c });
    fireEvent.contextMenu(rowOf(row('personal:mine', OVERVIEW)));
    expect(screen.queryByText('Move up')).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByText('Move down'));
    });
    expect(lastChange(c.edit)).toEqual(reordered(EDITABLE.raw!, 0, 2));
    fireEvent.contextMenu(rowOf(row('personal:mine', ELSEWHERE)));
    expect(screen.queryByText('Move down')).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByText('Move up'));
    });
    expect(lastChange(c.edit)).toEqual(reordered(EDITABLE.raw!, 4, 3));
    const code = row('personal:mine', CODE);
    code.focus();
    await act(async () => {
      fireEvent.keyDown(code, { key: 'ArrowUp', altKey: true });
    });
    expect(lastChange(c.edit)).toEqual(reordered(EDITABLE.raw!, 3, 2));
    // Focus stays on the moved row (the tree does not move focus up).
    expect(document.activeElement).toBe(code);
    await act(async () => {
      fireEvent.keyDown(code, { key: 'ArrowDown', altKey: true });
    });
    expect(lastChange(c.edit)).toEqual(reordered(EDITABLE.raw!, 3, 4));
    expect(c.edit).toHaveBeenCalledTimes(4);
    // Alt+Down on the last row does nothing.
    const last = row('personal:mine', ELSEWHERE);
    await act(async () => {
      fireEvent.keyDown(last, { key: 'ArrowDown', altKey: true });
    });
    expect(c.edit).toHaveBeenCalledTimes(4);
  });

  it('words a stale edit and an edit of a collection deleted elsewhere', async () => {
    const stale = api({ shown: [EDITABLE], ...editApi({ edit: { ok: false, reason: 'stale' } }) });
    const { store, rerender } = edited({ collections: stale });
    await act(async () => {
      fireEvent.click(
        row('personal:mine', GONE).querySelector<HTMLElement>('.nav-tree__action--remove')!
      );
    });
    expect(store.shown.at(-1)!.message).toBe(
      '\u201cMy panels\u201d changed on another console \u2014 try again'
    );
    expect(store.shown.at(-1)!.action).toBeUndefined();
    rerender({
      collections: api({ shown: [EDITABLE], ...editApi({ edit: { ok: false, reason: 'gone' } }) }),
    });
    await act(async () => {
      fireEvent.keyDown(row('personal:mine', GONE), { key: 'ArrowUp', altKey: true });
    });
    expect(store.shown.at(-1)!.message).toBe(
      '\u201cMy panels\u201d was deleted on another console'
    );
  });

  it('a member drags onto a row of its own collection only, holding the collection', async () => {
    const c = api({ shown: [OPS, EDITABLE], ...editApi() });
    const onDragStart = vi.fn();
    edited({ collections: c, onDragStart });
    const data = new Map<string, string>();
    const transfer = {
      get types() {
        return [...data.keys()];
      },
      setData: (type: string, value: string) => void data.set(type, value),
      getData: (type: string) => data.get(type) ?? '',
      dropEffect: 'none',
    };
    fireEvent.dragStart(rowOf(row('personal:mine', OVERVIEW)), { dataTransfer: transfer });
    // The dock payload is written as before, the reorder type beside it.
    expect(onDragStart).toHaveBeenLastCalledWith(OVERVIEW, transfer);
    expect(JSON.parse(data.get(REORDER_TYPE)!)).toEqual({ ref: 'personal:mine', index: 0 });
    expect(c.holdCollection).toHaveBeenLastCalledWith('personal:mine');
    // Another collection's row refuses it.
    const foreign = rowOf(row('facility:ops', BTS));
    expect(fireEvent.dragOver(foreign, { dataTransfer: transfer })).toBe(true);
    // A row of the same collection takes it.
    const target = rowOf(row('personal:mine', CODE));
    expect(fireEvent.dragOver(target, { dataTransfer: transfer })).toBe(false);
    await act(async () => {
      fireEvent.drop(target, { dataTransfer: transfer });
    });
    expect(lastChange(c.edit)).toEqual(reordered(EDITABLE.raw!, 0, 3));
    expect(c.holdCollection).toHaveBeenLastCalledWith(null);
    fireEvent.dragEnd(rowOf(row('personal:mine', OVERVIEW)));
    expect(c.edit).toHaveBeenCalledTimes(1);
  });

  it('a drag without the reorder type (a dock drag) is not a reorder', () => {
    const c = api({ shown: [EDITABLE], ...editApi() });
    edited({ collections: c });
    const plain = { types: ['application/x-canopy-dock'], dropEffect: 'none' };
    expect(fireEvent.dragOver(rowOf(row('personal:mine', CODE)), { dataTransfer: plain })).toBe(
      true
    );
  });

  it('facility collections and hand-built ones without raw expose no editing', () => {
    const c = api({ shown: [OPS, MINE], ...editApi() });
    edited({ collections: c });
    expect(document.querySelector('.nav-tree__action--remove')).toBeNull();
    fireEvent.contextMenu(rowOf(row('facility:ops', BTS)));
    expect(screen.queryByText('Move down')).toBeNull();
    expect(screen.queryByText('Remove from collection')).toBeNull();
    fireEvent.keyDown(row('facility:ops', BTS), { key: 'ArrowDown', altKey: true });
    expect(c.edit).not.toHaveBeenCalled();
    fireEvent.contextMenu(rowOf(branch('Operations')));
    expect(screen.queryByText('Rename')).toBeNull();
  });
});
