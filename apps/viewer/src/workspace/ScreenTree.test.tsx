// ScreenTree: the workspace's left screen browser. A WAI-ARIA tree grouped
// by manifest category (the drafts category flattened into the top level),
// nested by the id's `/` segments, with search, the sub-screen toggle,
// disabled non-ir leaves, a Trace entry with its saved views, keyboard
// navigation, remembered folder state and a right-click menu.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ManifestScreen } from '../api.js';
import {
  BRANCH_PINNED,
  NO_MATCHES_PREFIX,
  PINNED_PLACEHOLDER,
  ScreenTree,
  collapsedStorageKey,
} from './ScreenTree.js';
import { showSubScreensKey } from '../screenList.js';
const COLLAPSED_STORAGE_KEY = collapsedStorageKey();
import type { SavedView } from './savedViews.js';
import { TRACE_KEY } from './tabs.js';
import type { BrowseCollections, ToolEntry } from './ScreenTree.js';
import { collectionSummary, collectionSuffix, formatWhen, memberKey } from './collections.js';
import { CollectionBadge } from './CollectionBadge.js';
import type { Member } from './collections.js';
import { EMPTY_STATE } from './useCollections.js';
import type { Collection } from './useCollections.js';
import { openQuickOpen } from './QuickOpen.js';
import { personalRows, rowSummary } from './SaveCollection.js';

vi.mock('./QuickOpen.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./QuickOpen.js')>()),
  openQuickOpen: vi.fn(() => true),
}));

// Same in-memory localStorage shim as App.test.tsx: Node >= 25 can shadow
// jsdom's with an unusable global, and the sub-screen toggle persists there.
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
  entry('transfer', 'bts/b', 'Zeta BTS'),
  entry('transfer', 'bts/a', 'Alpha BTS'),
  entry('transfer', 'gtl/c', 'GTL Overview'),
  entry('transfer', 'bts/embedded/part', 'BTS Part'),
  entry('examples', 'vacuum', 'Vacuum System'),
  entry('examples', 'legacy', 'Legacy Code Screen', 'code'),
  entry('examples', 'xss', '<img src=x onerror=alert(1)>'),
  entry('@drafts', 'draft1', 'A Draft'),
  entry('@drafts', 'draft2', 'Another Draft'),
];

const TRACE: ToolEntry[] = [
  { id: 'trace', label: 'Data Browser', treeLabel: 'Data Browser (Trace)' },
];
const BOTH: ToolEntry[] = [
  ...TRACE,
  { id: 'correlation', label: 'Correlation', treeLabel: 'Correlation Plot' },
];

function treeItem(text: string): HTMLElement {
  const label = screen.getByText(text);
  const item = label.closest('[role="treeitem"]');
  if (!(item instanceof HTMLElement)) throw new Error(`no treeitem for ${text}`);
  return item;
}

function labels(): string[] {
  return Array.from(document.querySelectorAll('[role="treeitem"]')).map(
    (item) => item.querySelector(':scope > .nav-tree__row .nav-tree__label')?.textContent ?? ''
  );
}

/** A top-level branch row (Tools, All screens, ...), or null. */
function branch(name: string): HTMLElement | null {
  return screen.queryByRole('treeitem', { name });
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  globalThis.localStorage?.removeItem(showSubScreensKey());
  globalThis.localStorage?.removeItem(COLLAPSED_STORAGE_KEY);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  warn.mockRestore();
});

describe('ScreenTree structure', () => {
  it('groups by category and nests ids by their / segments, titles sorted', () => {
    render(<ScreenTree screens={SCREENS} onOpen={() => {}} />);
    expect(screen.getByText('transfer')).toBeTruthy();
    expect(screen.getByText('examples')).toBeTruthy();
    expect(screen.getByText('bts')).toBeTruthy();
    expect(screen.getByText('gtl')).toBeTruthy();
    // Categories sorted by name; within bts, titles sorted.
    const order = labels();
    expect(order.indexOf('examples')).toBeLessThan(order.indexOf('transfer'));
    expect(order.indexOf('Alpha BTS')).toBeLessThan(order.indexOf('Zeta BTS'));
    // bts/a nests under the bts folder, which nests under its category.
    const bts = treeItem('bts');
    expect(bts.contains(treeItem('Alpha BTS'))).toBe(true);
    expect(treeItem('transfer').contains(bts)).toBe(true);
    expect(treeItem('examples').contains(treeItem('Vacuum System'))).toBe(true);
  });

  it('drops @-categories with one warning, even across re-renders', () => {
    const { rerender } = render(<ScreenTree screens={SCREENS} onOpen={() => {}} />);
    rerender(<ScreenTree screens={[...SCREENS]} onOpen={() => {}} />);
    expect(screen.queryByText('@drafts')).toBeNull();
    expect(screen.queryByText('A Draft')).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('@drafts');
  });

  it('does not warn when no @-category is present', () => {
    render(<ScreenTree screens={SCREENS.slice(0, 3)} onOpen={() => {}} />);
    expect(warn).not.toHaveBeenCalled();
  });

  it('renders titles as text, never markup', () => {
    const { container } = render(<ScreenTree screens={SCREENS} onOpen={() => {}} />);
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeTruthy();
    expect(container.querySelector('img')).toBeNull();
  });

  it('renders non-ir entries as disabled leaves that do not open', () => {
    const onOpen = vi.fn();
    render(<ScreenTree screens={SCREENS} onOpen={onOpen} />);
    const legacy = treeItem('Legacy Code Screen');
    expect(legacy.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(legacy);
    fireEvent.contextMenu(legacy);
    expect(onOpen).not.toHaveBeenCalled();
    expect(screen.queryByText('Open in new tab')).toBeNull();
  });
});

describe('ScreenTree folders', () => {
  // The whole folder row toggles.
  const toggle = (item: HTMLElement) => {
    const row = item.querySelector(':scope > .nav-tree__row');
    if (!(row instanceof HTMLElement)) throw new Error('no row');
    fireEvent.click(row);
  };

  it('start expanded and stay as the user left them across manifest refreshes', () => {
    const { rerender } = render(<ScreenTree screens={SCREENS} onOpen={() => {}} />);
    for (const folder of ['transfer', 'examples', 'bts', 'gtl']) {
      expect(treeItem(folder).getAttribute('aria-expanded'), folder).toBe('true');
    }
    toggle(treeItem('gtl'));
    expect(treeItem('gtl').getAttribute('aria-expanded')).toBe('false');
    // A re-fetched manifest is a new array with the same entries.
    rerender(<ScreenTree screens={[...SCREENS]} onOpen={() => {}} />);
    expect(treeItem('gtl').getAttribute('aria-expanded')).toBe('false');
    expect(treeItem('bts').getAttribute('aria-expanded')).toBe('true');
    toggle(treeItem('gtl'));
    expect(treeItem('gtl').getAttribute('aria-expanded')).toBe('true');
  });

  it('toggle from a click on the label, and rotate the chevron and swap the icon', () => {
    render(<ScreenTree screens={SCREENS} onOpen={() => {}} />);
    fireEvent.click(screen.getByText('gtl'));
    expect(treeItem('gtl').getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('GTL Overview')).toBeNull();
    expect(
      treeItem('bts').querySelector('.nav-tree__chevron--open'),
      'open chevron'
    ).not.toBeNull();
    expect(
      treeItem('gtl').querySelector(':scope > .nav-tree__row .nav-tree__chevron--open')
    ).toBeNull();
  });

  it('remember the closed folders across mounts, and survive broken storage', () => {
    render(<ScreenTree screens={SCREENS} onOpen={() => {}} />);
    toggle(treeItem('gtl'));
    expect(JSON.parse(globalThis.localStorage.getItem(COLLAPSED_STORAGE_KEY)!)).toEqual([
      'folder:/transfer/gtl',
    ]);
    cleanup();
    render(<ScreenTree screens={SCREENS} onOpen={() => {}} />);
    expect(treeItem('gtl').getAttribute('aria-expanded')).toBe('false');
    cleanup();
    globalThis.localStorage.setItem(COLLAPSED_STORAGE_KEY, '{not json');
    render(<ScreenTree screens={SCREENS} onOpen={() => {}} />);
    expect(treeItem('gtl').getAttribute('aria-expanded')).toBe('true');
  });

  it('open every folder while searching', () => {
    render(<ScreenTree screens={SCREENS} onOpen={() => {}} />);
    toggle(treeItem('gtl'));
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'overview' } });
    expect(screen.getByText('GTL Overview')).toBeTruthy();
  });
});

describe('ScreenTree drafts', () => {
  const DRAFTS: ManifestScreen[] = [
    entry('drafts', 'bts/BTSView', 'BTS View'),
    entry('drafts', 'gtb/GTLView', 'GTL View'),
    entry('drafts', 'loose', 'Loose Draft'),
    entry('examples', 'vacuum', 'Vacuum System'),
  ];

  it('has no drafts node: its folders and screens are the top level of All screens', () => {
    render(<ScreenTree screens={DRAFTS} onOpen={() => {}} />);
    expect(screen.queryByText('drafts')).toBeNull();
    const top = Array.from(
      document.querySelectorAll('[role="tree"] > [role="treeitem"]'),
      (item) => item.querySelector(':scope > .nav-tree__row .nav-tree__label')?.textContent
    );
    expect(top).toEqual(['All screens']);
    const under = Array.from(
      branch('All screens')!.querySelectorAll(':scope > [role="group"] > [role="treeitem"]'),
      (item) => item.querySelector(':scope > .nav-tree__row .nav-tree__label')?.textContent
    );
    expect(under).toEqual(['bts', 'examples', 'gtb', 'Loose Draft']);
    expect(treeItem('bts').getAttribute('aria-level')).toBe('2');
    expect(treeItem('BTS View').getAttribute('aria-level')).toBe('3');
  });

  it('still opens drafts by their full key', () => {
    const onOpen = vi.fn();
    render(<ScreenTree screens={DRAFTS} onOpen={onOpen} />);
    fireEvent.click(screen.getByText('BTS View'));
    expect(onOpen).toHaveBeenCalledWith('drafts/bts/BTSView', 'replace');
  });
});

describe('ScreenTree keyboard', () => {
  const key = (k: string, init: KeyboardEventInit = {}) =>
    fireEvent.keyDown(document.activeElement!, { key: k, ...init });
  const focused = () =>
    document.activeElement?.querySelector(':scope > .nav-tree__row .nav-tree__label')?.textContent;

  it('has one row in the tab order, and moves with the arrows, Home and End', () => {
    render(<ScreenTree screens={SCREENS} onOpen={() => {}} />);
    const tabbable = document.querySelectorAll('[role="treeitem"][tabindex="0"]');
    expect(tabbable).toHaveLength(1);
    (tabbable[0] as HTMLElement).focus();
    expect(focused()).toBe('All screens');
    key('ArrowDown');
    expect(focused()).toBe('examples');
    key('ArrowDown');
    expect(focused()).toBe('<img src=x onerror=alert(1)>');
    key('End');
    expect(focused()).toBe('GTL Overview');
    key('Home');
    expect(focused()).toBe('All screens');
    key('ArrowUp');
    expect(focused()).toBe('All screens');
  });

  it('closes and opens folders with Left and Right, and walks to parent and child', () => {
    render(<ScreenTree screens={SCREENS} onOpen={() => {}} />);
    treeItem('bts').focus();
    key('ArrowLeft');
    expect(treeItem('bts').getAttribute('aria-expanded')).toBe('false');
    key('ArrowLeft');
    expect(focused()).toBe('transfer');
    treeItem('bts').focus();
    key('ArrowRight');
    expect(treeItem('bts').getAttribute('aria-expanded')).toBe('true');
    key('ArrowRight');
    expect(focused()).toBe('Alpha BTS');
  });

  it('Enter opens a screen and toggles a folder; Shift+F10 opens the menu', () => {
    const onOpen = vi.fn();
    render(<ScreenTree screens={SCREENS} onOpen={onOpen} />);
    treeItem('Alpha BTS').focus();
    key('Enter');
    expect(onOpen).toHaveBeenCalledWith('transfer/bts/a', 'replace');
    key('F10', { shiftKey: true });
    fireEvent.click(screen.getByText('Open in new tab'));
    expect(onOpen).toHaveBeenLastCalledWith('transfer/bts/a', 'append');
    treeItem('gtl').focus();
    key('Enter');
    expect(treeItem('gtl').getAttribute('aria-expanded')).toBe('false');
  });
});

describe('ScreenTree sub-screens', () => {
  it('hides sub-screens until the toggle is ticked, and remembers it', () => {
    render(<ScreenTree screens={SCREENS} onOpen={() => {}} />);
    expect(screen.queryByText('BTS Part')).toBeNull();
    const toggle = screen.getByLabelText('Show sub-screens (1)');
    fireEvent.click(toggle);
    expect(screen.getByText('BTS Part')).toBeTruthy();
    expect(globalThis.localStorage.getItem(showSubScreensKey())).toBe('1');
    cleanup();
    render(<ScreenTree screens={SCREENS} onOpen={() => {}} />);
    expect(screen.getByText('BTS Part')).toBeTruthy();
  });

  it('hides the toggle when there are no sub-screens', () => {
    render(<ScreenTree screens={SCREENS.slice(0, 3)} onOpen={() => {}} />);
    expect(screen.queryByLabelText(/Show sub-screens/)).toBeNull();
  });
});

describe('ScreenTree search', () => {
  function search(value: string) {
    fireEvent.change(screen.getByRole('searchbox'), { target: { value } });
  }

  it('matches title case-insensitively', () => {
    render(<ScreenTree screens={SCREENS} onOpen={() => {}} />);
    search('alpha');
    expect(screen.getByText('Alpha BTS')).toBeTruthy();
    expect(screen.queryByText('Zeta BTS')).toBeNull();
    expect(screen.queryByText('Vacuum System')).toBeNull();
    // A category with no matches disappears.
    expect(screen.queryByText('examples')).toBeNull();
  });

  it('matches the id by word prefix, case-insensitively', () => {
    render(<ScreenTree screens={SCREENS} onOpen={() => {}} />);
    // 'GTLC' prefixes only the id's joined words (gtl, c), not the title's.
    search('GTLC');
    expect(screen.getByText('GTL Overview')).toBeTruthy();
    expect(screen.queryByText('Alpha BTS')).toBeNull();
  });

  it('matches word prefixes, not substrings', () => {
    render(<ScreenTree screens={SCREENS} onOpen={() => {}} />);
    search('lpha');
    expect(screen.queryByText('Alpha BTS')).toBeNull();
    search('alp bts');
    expect(screen.getByText('Alpha BTS')).toBeTruthy();
    expect(screen.queryByText('Zeta BTS')).toBeNull();
  });

  it('does not match on the category alone', () => {
    render(<ScreenTree screens={SCREENS} onOpen={() => {}} />);
    search('examples');
    expect(screen.queryByText('Vacuum System')).toBeNull();
    expect(document.querySelector('.screen-tree__empty')?.textContent).toContain(NO_MATCHES_PREFIX);
  });
});

describe('ScreenTree opening', () => {
  it('left-click opens a screen replacing the active tab', () => {
    const onOpen = vi.fn();
    render(<ScreenTree screens={SCREENS} onOpen={onOpen} />);
    fireEvent.click(screen.getByText('Alpha BTS'));
    expect(onOpen).toHaveBeenCalledWith('transfer/bts/a', 'replace');
  });

  it('right-click offers Open in new tab, which appends', () => {
    const onOpen = vi.fn();
    render(<ScreenTree screens={SCREENS} onOpen={onOpen} />);
    fireEvent.contextMenu(screen.getByText('Vacuum System'));
    fireEvent.click(screen.getByText('Open in new tab'));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith('examples/vacuum', 'append');
  });

  it('right-click on a folder opens no menu', () => {
    render(<ScreenTree screens={SCREENS} onOpen={() => {}} />);
    fireEvent.contextMenu(screen.getByText('bts'));
    expect(screen.queryByText('Open in new tab')).toBeNull();
  });
});

describe('ScreenTree Tools section', () => {
  const LABEL = 'Data Browser (Trace)';

  it('is absent without a trace config; All screens is the only branch', () => {
    render(<ScreenTree screens={SCREENS} onOpen={() => {}} />);
    expect(screen.queryByText(LABEL)).toBeNull();
    expect(branch('Tools')).toBeNull();
    expect(branch('All screens')).not.toBeNull();
    expect(document.querySelector('[data-screen-key="@trace"]')).toBeNull();
  });

  it('puts the data browser under a Tools branch above an All screens branch', () => {
    render(<ScreenTree screens={SCREENS} tools={TRACE} onOpen={() => {}} />);
    const tools = branch('Tools')!;
    const screens = branch('All screens')!;
    for (const row of [tools, screens]) {
      expect(row.querySelector(':scope > .nav-tree__row')!.className).toContain(
        'canopy-section-heading'
      );
      expect(row.getAttribute('aria-level')).toBe('1');
    }
    const entry = document.querySelector('[data-screen-key="@trace"]')!;
    expect(entry.textContent).toContain(LABEL);
    expect(entry.querySelector('svg')).not.toBeNull();
    const follows = (a: Node, b: Node) =>
      (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    expect(follows(tools, entry)).toBe(true);
    expect(tools.contains(entry)).toBe(true);
    expect(follows(entry, screens)).toBe(true);
    expect(screens.contains(screen.getByText('bts'))).toBe(true);
  });

  it('opens the data browser on click; "New Data Browser tab" and + open a blank one', () => {
    const onOpenTool = vi.fn();
    const onNewTool = vi.fn();
    render(
      <ScreenTree
        screens={SCREENS}
        tools={TRACE}
        onOpen={() => {}}
        onOpenTool={onOpenTool}
        onNewTool={onNewTool}
      />
    );
    fireEvent.click(screen.getByText(LABEL));
    expect(onOpenTool).toHaveBeenLastCalledWith('trace');
    fireEvent.contextMenu(screen.getByText(LABEL));
    fireEvent.click(screen.getByText('New Data Browser tab'));
    expect(onNewTool).toHaveBeenLastCalledWith('trace');
    fireEvent.click(screen.getByRole('button', { name: 'New Data Browser tab' }));
    expect(onNewTool).toHaveBeenCalledTimes(2);
    expect(onOpenTool).toHaveBeenCalledTimes(1);
  });

  it('disables + at the instance cap, saying why, and never opens the tool instead', () => {
    const onOpenTool = vi.fn();
    const onNewTool = vi.fn();
    render(
      <ScreenTree
        screens={SCREENS}
        tools={[{ ...TRACE[0]!, full: true }]}
        onOpen={() => {}}
        onOpenTool={onOpenTool}
        onNewTool={onNewTool}
      />
    );
    const plus = screen.getByRole('button', { name: 'New Data Browser tab' });
    expect(plus.getAttribute('aria-disabled')).toBe('true');
    expect(plus.getAttribute('title')).toBe('At most 10 Data Browser tabs');
    fireEvent.click(plus);
    expect(onNewTool).not.toHaveBeenCalled();
    expect(onOpenTool).not.toHaveBeenCalled();
  });

  it('lists one entry per configured tool, in registry order', () => {
    render(<ScreenTree screens={SCREENS} tools={BOTH} onOpen={() => {}} />);
    const entries = [...document.querySelectorAll('[data-tool]')].map((e) =>
      e.getAttribute('data-screen-key')
    );
    expect(entries).toEqual(['@trace', '@correlation']);
  });

  it('highlights the correlation entry for any of its instances', () => {
    render(
      <ScreenTree screens={SCREENS} tools={BOTH} onOpen={() => {}} activeKey="@correlation/3" />
    );
    const entry = document.querySelector('[data-screen-key="@correlation"]')!;
    expect(entry.getAttribute('aria-selected')).toBe('true');
  });

  it('highlights the data browser when it is the active tab', () => {
    render(<ScreenTree screens={SCREENS} tools={TRACE} onOpen={() => {}} activeKey={TRACE_KEY} />);
    const entry = document.querySelector('[data-screen-key="@trace"]')!;
    expect(entry.getAttribute('aria-selected')).toBe('true');
  });

  it('names each item by its own label only', () => {
    render(<ScreenTree screens={SCREENS} onOpen={() => {}} />);
    expect(screen.getByRole('treeitem', { name: 'bts' })).toBe(treeItem('bts'));
  });

  it.each(['data', 'BROWSER', 'trace'])('keeps the data browser for the query %s', (q) => {
    render(<ScreenTree screens={SCREENS} tools={TRACE} onOpen={() => {}} />);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: q } });
    expect(screen.getByText(LABEL)).toBeTruthy();
    expect(branch('Tools')).not.toBeNull();
  });

  it('hides the Tools section when the query does not match it', () => {
    render(<ScreenTree screens={SCREENS} tools={TRACE} onOpen={() => {}} />);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'bts' } });
    expect(screen.queryByText(LABEL)).toBeNull();
    expect(branch('Tools')).toBeNull();
    expect(branch('All screens')).not.toBeNull();
  });
});

describe('ScreenTree saved views', () => {
  const VIEWS: SavedView[] = [
    { id: 'gun-vacuum', name: 'Gun vacuum', kind: 'trace', query: 'pv=GUN:VAC&range=-1h' },
    { id: 'rf-overnight', name: 'RF overnight', kind: 'trace', query: 'pv=RF:FWD&range=-12h' },
  ];
  const MIXED: SavedView[] = [
    ...VIEWS,
    { id: 'correlation_gun-vacuum', name: 'Gun vacuum', kind: 'correlation', query: 'x=A&y=B' },
    { id: 'future_x', name: 'Future thing', kind: 'future-tool', query: '' },
  ];

  it('groups views under their tool; others are listed disabled with Delete kept', () => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
    const onOpenView = vi.fn();
    const onDeleteView = vi.fn();
    render(
      <ScreenTree
        screens={SCREENS}
        tools={TRACE}
        views={MIXED}
        onOpen={() => {}}
        onOpenView={onOpenView}
        onDeleteView={onDeleteView}
      />
    );
    const browser = document.querySelector<HTMLElement>('[data-screen-key="@trace"]')!;
    const inBrowser = [...browser.querySelectorAll('[data-view-id]')].map((e) =>
      e.getAttribute('data-view-id')
    );
    expect(inBrowser).toEqual(['gun-vacuum', 'rf-overnight']);
    const other = screen.getByRole('treeitem', { name: 'Other views' });
    const corr = other.querySelector<HTMLElement>('[data-view-id="correlation_gun-vacuum"]')!;
    expect(corr.getAttribute('aria-disabled')).toBe('true');
    expect(corr.getAttribute('title')).toBe('Correlation is not available here');
    expect(other.querySelector('[data-view-id="future_x"]')!.getAttribute('title')).toBe(
      'future-tool is not available here'
    );
    fireEvent.click(corr.querySelector('.nav-tree__row')!);
    expect(onOpenView).not.toHaveBeenCalled();
    fireEvent.contextMenu(corr.querySelector('.nav-tree__row')!);
    expect(screen.queryByText('Open')).toBeNull();
    fireEvent.click(screen.getByText('Delete view…'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onDeleteView).toHaveBeenCalledWith(MIXED[2]);
    vi.unstubAllGlobals();
  });

  it('lists a correlation view and a Trace view of the same name under their own tools', () => {
    render(<ScreenTree screens={SCREENS} tools={BOTH} views={MIXED} onOpen={() => {}} />);
    const corr = document.querySelector<HTMLElement>('[data-screen-key="@correlation"]')!;
    expect(corr.querySelector('[data-view-id="correlation_gun-vacuum"]')).not.toBeNull();
    const browser = document.querySelector<HTMLElement>('[data-screen-key="@trace"]')!;
    expect(browser.querySelector('[data-view-id="gun-vacuum"]')).not.toBeNull();
  });

  it('shows Tools with saved views even when no tool is configured', () => {
    render(<ScreenTree screens={SCREENS} views={MIXED} onOpen={() => {}} />);
    expect(branch('Tools')).not.toBeNull();
    expect(screen.getByRole('treeitem', { name: 'Other views' })).toBeTruthy();
  });

  it('offers Open in new tab, and Revert to saved only for a drifted view', () => {
    const onOpenView = vi.fn();
    const onRevertView = vi.fn();
    render(
      <ScreenTree
        screens={SCREENS}
        tools={TRACE}
        views={VIEWS}
        onOpen={() => {}}
        onOpenView={onOpenView}
        revertable={new Set(['rf-overnight'])}
        onRevertView={onRevertView}
      />
    );
    fireEvent.contextMenu(screen.getByText('Gun vacuum'));
    expect(screen.queryByText('Revert to saved')).toBeNull();
    fireEvent.click(screen.getByText('Open in new tab'));
    expect(onOpenView).toHaveBeenLastCalledWith(VIEWS[0], true);
    fireEvent.contextMenu(screen.getByText('RF overnight'));
    fireEvent.click(screen.getByText('Revert to saved'));
    expect(onRevertView).toHaveBeenCalledWith(VIEWS[1]);
  });

  it('lists the saved views under the data browser', () => {
    render(<ScreenTree screens={SCREENS} tools={TRACE} views={VIEWS} onOpen={() => {}} />);
    const browser = document.querySelector<HTMLElement>('[data-screen-key="@trace"]')!;
    expect(browser.getAttribute('aria-expanded')).toBe('true');
    expect(browser.contains(treeItem('Gun vacuum'))).toBe(true);
    expect(treeItem('RF overnight').getAttribute('aria-level')).toBe('3');
  });

  it('opens a view on click; the data browser row opens the browser, its chevron toggles', () => {
    const onOpen = vi.fn();
    const onOpenView = vi.fn();
    render(
      <ScreenTree
        screens={SCREENS}
        tools={TRACE}
        views={VIEWS}
        onOpen={() => {}}
        onOpenTool={onOpen}
        onOpenView={onOpenView}
      />
    );
    fireEvent.click(screen.getByText('RF overnight'));
    expect(onOpenView).toHaveBeenCalledWith(VIEWS[1], false);
    const browser = document.querySelector<HTMLElement>('[data-screen-key="@trace"]')!;
    fireEvent.click(browser.querySelector('[data-testid="nav-tree-chevron"]')!);
    expect(onOpen).not.toHaveBeenCalled();
    expect(browser.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('RF overnight')).toBeNull();
    fireEvent.click(screen.getByText('Data Browser (Trace)'));
    expect(onOpen).toHaveBeenCalledWith('trace');
  });

  it('highlights the view the data browser was opened with', () => {
    render(
      <ScreenTree
        screens={SCREENS}
        tools={TRACE}
        views={VIEWS}
        onOpen={() => {}}
        activeKey={TRACE_KEY}
        activeViewId="gun-vacuum"
      />
    );
    expect(treeItem('Gun vacuum').getAttribute('aria-selected')).toBe('true');
    const browser = document.querySelector('[data-screen-key="@trace"]')!;
    expect(browser.getAttribute('aria-selected')).toBe('false');
  });

  it('deletes a view from its menu after a confirmation', () => {
    // Carbon's Modal observes its body; jsdom has no ResizeObserver.
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
    const onDeleteView = vi.fn();
    render(
      <ScreenTree
        screens={SCREENS}
        tools={TRACE}
        views={VIEWS}
        onOpen={() => {}}
        onDeleteView={onDeleteView}
      />
    );
    fireEvent.contextMenu(screen.getByText('Gun vacuum'));
    fireEvent.click(screen.getByText('Delete view…'));
    expect(onDeleteView).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onDeleteView).toHaveBeenCalledWith(VIEWS[0]);
    vi.unstubAllGlobals();
  });

  it('keeps the Tools section for a query matching only a view name', () => {
    render(<ScreenTree screens={SCREENS} tools={TRACE} views={VIEWS} onOpen={() => {}} />);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'overnight' } });
    expect(screen.getByText('RF overnight')).toBeTruthy();
    expect(screen.queryByText('Gun vacuum')).toBeNull();
  });
});

describe('ScreenTree drag sources', () => {
  const VIEWS: SavedView[] = [
    { id: 'gun-vacuum', name: 'Gun vacuum', kind: 'trace', query: 'pv=GUN:VAC&range=-1h' },
  ];
  const row = (text: string): HTMLElement =>
    treeItem(text).querySelector<HTMLElement>(':scope > .nav-tree__row')!;
  const transfer = { setData: () => {}, effectAllowed: 'none' };

  it('a screen, a tool entry and an available view drag what they are; a code screen and a folder do not', () => {
    const onDragStart = vi.fn();
    render(
      <ScreenTree
        screens={SCREENS}
        tools={TRACE}
        views={VIEWS}
        onOpen={() => {}}
        onOpenTool={() => {}}
        onOpenView={() => {}}
        onDragStart={onDragStart}
      />
    );
    fireEvent.dragStart(row('Alpha BTS'), { dataTransfer: transfer });
    expect(onDragStart).toHaveBeenLastCalledWith({ screen: 'transfer/bts/a' }, expect.anything());
    fireEvent.dragStart(row('Data Browser (Trace)'), { dataTransfer: transfer });
    expect(onDragStart).toHaveBeenLastCalledWith({ tool: 'trace' }, expect.anything());
    fireEvent.dragStart(row('Gun vacuum'), { dataTransfer: transfer });
    expect(onDragStart).toHaveBeenLastCalledWith(
      { kind: 'view', id: 'gun-vacuum' },
      expect.anything()
    );
    expect(onDragStart).toHaveBeenCalledTimes(3);
    expect(row('Alpha BTS').getAttribute('draggable')).toBe('true');
    expect(row('Legacy Code Screen').hasAttribute('draggable')).toBe(false);
    expect(row('bts').hasAttribute('draggable')).toBe(false);
  });

  it('dims the dragged row until dragend, and no other', () => {
    render(<ScreenTree screens={SCREENS} onOpen={() => {}} onDragStart={() => {}} />);
    const source = row('Alpha BTS');
    fireEvent.dragStart(source, { dataTransfer: transfer });
    expect(source.classList.contains('nav-tree__row--dragging')).toBe(true);
    expect(row('Zeta BTS').classList.contains('nav-tree__row--dragging')).toBe(false);
    fireEvent.dragEnd(source);
    expect(source.classList.contains('nav-tree__row--dragging')).toBe(false);
  });

  it('is no drag source without onDragStart, and a click still opens in place', () => {
    const onOpen = vi.fn();
    render(<ScreenTree screens={SCREENS} onOpen={onOpen} />);
    expect(row('Alpha BTS').hasAttribute('draggable')).toBe(false);
    fireEvent.click(row('Alpha BTS'));
    expect(onOpen).toHaveBeenCalledWith('transfer/bts/a', 'replace');
  });
});

describe('ScreenTree Pinned branch and Pin star', () => {
  const VACUUM: Member = { screen: 'examples/vacuum' };

  function collections(pinned: Member[], over: Partial<BrowseCollections> = {}): BrowseCollections {
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
      remove: vi.fn() as unknown as BrowseCollections['remove'],
      setRecentHover: vi.fn(),
      ...over,
    };
  }

  const pinnedRows = () =>
    Array.from(
      document.querySelectorAll<HTMLElement>(
        `[data-branch="pinned"] > [role="group"] > [role="treeitem"]`
      )
    );

  it('renders Pinned even when empty, holding one inert placeholder row', () => {
    const openMember = vi.fn();
    const c = collections([], { openMember });
    const onOpen = vi.fn();
    render(<ScreenTree screens={SCREENS} tools={TRACE} onOpen={onOpen} collections={c} />);
    const pinned = branch('Pinned');
    expect(pinned).not.toBeNull();
    expect(pinned!.id).toBe('screen-tree-' + encodeURIComponent(BRANCH_PINNED));
    // Top-level order still starts with Pinned.
    expect(labels()[0]).toBe('Pinned');
    const rows = pinnedRows();
    expect(rows).toHaveLength(1);
    const placeholder = rows[0]!;
    expect(placeholder.textContent).toBe(PINNED_PLACEHOLDER);
    expect(PINNED_PLACEHOLDER).toBe('Pin a screen with \u2606');
    // Inert, not disabled: no italic class, no aria-disabled, no member, no star.
    expect(placeholder.classList.contains('nav-tree__item--disabled')).toBe(false);
    expect(placeholder.getAttribute('aria-disabled')).not.toBe('true');
    expect(placeholder.hasAttribute('data-member-key')).toBe(false);
    expect(placeholder.querySelector('.nav-tree__action--hover')).toBeNull();
    expect(placeholder.querySelector('button')).toBeNull();
    fireEvent.click(placeholder.querySelector('.nav-tree__row')!);
    fireEvent.keyDown(placeholder, { key: 'Enter' });
    expect(openMember).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('replaces the placeholder with the pinned members once something is pinned', () => {
    render(
      <ScreenTree
        screens={SCREENS}
        tools={TRACE}
        onOpen={() => {}}
        collections={collections([VACUUM])}
      />
    );
    const rows = pinnedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.getAttribute('data-member-key')).toBe(memberKey(VACUUM));
    expect(screen.queryByText(PINNED_PLACEHOLDER)).toBeNull();
  });

  it('has no Pinned branch without the feature', () => {
    render(
      <ScreenTree
        screens={SCREENS}
        tools={TRACE}
        onOpen={() => {}}
        collections={collections([], { enabled: false })}
      />
    );
    expect(branch('Pinned')).toBeNull();
    expect(screen.queryByText(PINNED_PLACEHOLDER)).toBeNull();
  });

  it('shows the hover star dimmed on every member row, full on hover, focus or pinned', () => {
    const css = readFileSync(
      createRequire(import.meta.url).resolve('./ScreenTree.css'),
      'utf8'
    ).replace(/\/\*[\s\S]*?\*\//g, '');
    const block = (selector: string): string => {
      const at = css.indexOf(selector);
      expect(at, selector).toBeGreaterThanOrEqual(0);
      return css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at));
    };
    // Never hidden any more: reduced opacity instead of visibility.
    expect(css).not.toMatch(/visibility\s*:\s*hidden/);
    const dim = block('.screen-tree .nav-tree__action--hover {');
    const dimOpacity = Number(/opacity:\s*([\d.]+)/.exec(dim)?.[1]);
    expect(dimOpacity).toBeGreaterThan(0);
    expect(dimOpacity).toBeLessThan(1);
    // One rule restores full opacity for row hover, keyboard focus and pinned.
    const full = /([^{}]+)\{\s*opacity:\s*1;?\s*\}/.exec(css);
    expect(full).not.toBeNull();
    const selectors = full![1]!;
    expect(selectors).toContain('.nav-tree__row:hover .nav-tree__action--hover');
    expect(selectors).toContain(
      '.nav-tree__item:focus-visible > .nav-tree__row .nav-tree__action--hover'
    );
    expect(selectors).toContain('.nav-tree__action--persistent');

    // Every member row carries the star (in the DOM, not hidden).
    render(
      <ScreenTree
        screens={SCREENS}
        tools={TRACE}
        onOpen={() => {}}
        collections={collections([VACUUM], { recent: [{ screen: 'transfer/gtl/c' }] })}
      />
    );
    const recentRow = document.querySelector<HTMLElement>(
      '[data-branch="recent"] > [role="group"] > [role="treeitem"]'
    )!;
    const star = recentRow.querySelector<HTMLElement>('.nav-tree__action--hover')!;
    expect(star.getAttribute('aria-label')).toBe('Pin');
    expect(star.classList.contains('nav-tree__action--persistent')).toBe(false);
    const pinnedStar = pinnedRows()[0]!.querySelector<HTMLElement>('.nav-tree__action--hover')!;
    expect(pinnedStar.getAttribute('aria-label')).toBe('Unpin');
    expect(pinnedStar.classList.contains('nav-tree__action--persistent')).toBe(true);
  });
});

describe('ScreenTree filter over every branch', () => {
  const GUN_TRACE: Member = {
    tool: 'trace',
    name: 'Gun high voltage and heater',
    query: 'pv=EG______HV_____AM00&range=-1h',
  } as Member;
  const VACUUM: Member = { screen: 'examples/vacuum' };
  const ALPHA: Member = { screen: 'transfer/bts/a' };
  const GTL: Member = { screen: 'transfer/gtl/c' };

  function injector(members: Member[]): Collection {
    return {
      source: 'facility',
      ref: 'facility:injector',
      id: 'injector',
      name: 'Injector',
      members,
      layout: null,
      default: true,
    };
  }

  function collections(over: Partial<BrowseCollections> = {}): BrowseCollections {
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
      remove: vi.fn() as unknown as BrowseCollections['remove'],
      setRecentHover: vi.fn(),
      ...over,
    };
  }

  function search(value: string) {
    fireEvent.change(screen.getByRole('searchbox'), { target: { value } });
  }

  /** The member keys rendered under a top-level branch (by data-branch). */
  function membersOf(branchName: string): string[] {
    return Array.from(
      document.querySelectorAll<HTMLElement>(
        `[data-branch="${branchName}"] > [role="group"] > [role="treeitem"]`
      )
    ).map((row) => row.getAttribute('data-member-key') ?? '');
  }

  const topLabels = () =>
    Array.from(document.querySelectorAll<HTMLElement>('[role="tree"] > [role="treeitem"]')).map(
      (item) => item.querySelector(':scope > .nav-tree__row .nav-tree__label')?.textContent
    );

  it('"gun" lists the Injector trace member', () => {
    render(
      <ScreenTree
        screens={SCREENS}
        tools={TRACE}
        onOpen={() => {}}
        collections={collections({ shown: [injector([VACUUM, GUN_TRACE])] })}
      />
    );
    search('gun');
    expect(screen.getByText('Gun high voltage and heater')).toBeTruthy();
    expect(membersOf('collection')).toEqual([memberKey(GUN_TRACE)]);
    // The collection heading stays; its non-matching member and the
    // non-matching branches are filtered out.
    expect(branch('Injector')).not.toBeNull();
    expect(branch('Injector')!.getAttribute('aria-expanded')).toBe('true');
    expect(topLabels()).toEqual(['Injector']);
    expect(screen.queryByText(/No matches/)).toBeNull();
  });

  it('filters Pinned, Recent, collections and All screens rows instead of hiding branches', () => {
    render(
      <ScreenTree
        screens={SCREENS}
        tools={TRACE}
        onOpen={() => {}}
        collections={collections({
          state: { ...EMPTY_STATE, pinned: [VACUUM, ALPHA] },
          recent: [GTL, ALPHA],
          shown: [injector([VACUUM, ALPHA, GUN_TRACE])],
        })}
      />
    );
    search('alpha');
    expect(topLabels()).toEqual(['Pinned', 'Recent', 'Injector', 'All screens']);
    expect(membersOf('pinned')).toEqual([memberKey(ALPHA)]);
    expect(membersOf('recent')).toEqual([memberKey(ALPHA)]);
    expect(membersOf('collection')).toEqual([memberKey(ALPHA)]);
    for (const name of ['Pinned', 'Recent', 'Injector', 'All screens']) {
      expect(branch(name)!.getAttribute('aria-expanded')).toBe('true');
    }
    expect(screen.queryByText('Vacuum System')).toBeNull();
    expect(screen.queryByText(PINNED_PLACEHOLDER)).toBeNull();
    // Clearing the query restores every row.
    search('');
    expect(membersOf('pinned')).toEqual([memberKey(VACUUM), memberKey(ALPHA)]);
    expect(membersOf('collection')).toHaveLength(3);
  });

  it('drops a selection branch with no matching row, including the empty Pinned', () => {
    render(
      <ScreenTree
        screens={SCREENS}
        tools={TRACE}
        onOpen={() => {}}
        collections={collections({ recent: [VACUUM], shown: [injector([GUN_TRACE])] })}
      />
    );
    search('vacuum');
    expect(topLabels()).toEqual(['Recent', 'All screens']);
  });

  it('matches a member by its screen path as well as its label', () => {
    render(
      <ScreenTree
        screens={SCREENS}
        onOpen={() => {}}
        collections={collections({ recent: [GTL] })}
      />
    );
    search('gtl c');
    expect(membersOf('recent')).toEqual([memberKey(GTL)]);
  });

  it('with no match anywhere, names Quick open and its button opens it', () => {
    vi.mocked(openQuickOpen).mockClear();
    render(
      <ScreenTree
        screens={SCREENS}
        tools={TRACE}
        onOpen={() => {}}
        collections={collections({ shown: [injector([GUN_TRACE])] })}
      />
    );
    search('no-such-screen');
    expect(document.querySelector('[role="tree"]')).toBeNull();
    const empty = document.querySelector<HTMLElement>('.screen-tree__empty')!;
    expect(empty.textContent).toMatch(/^No matches \u2014 try Quick open \((\u2318K|Ctrl\+K)\)$/);
    const button = screen.getByRole('button', { name: /Quick open/ });
    fireEvent.click(button);
    expect(openQuickOpen).toHaveBeenCalledWith(button);
  });

  it('keeps "No screens to show." for an empty library without a query', () => {
    render(<ScreenTree screens={[]} onOpen={() => {}} />);
    expect(screen.getByText('No screens to show.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Quick open/ })).toBeNull();
  });
});

describe('ScreenTree collection headings and badges', () => {
  const A: Member = { screen: 'transfer/bts/a' };
  const C: Member = { screen: 'transfer/gtl/c' };
  // Local wall-clock times, so the "today" test is timezone-independent.
  const NOW = new Date(2026, 9, 17, 15, 30);
  const TODAY = new Date(2026, 9, 17, 9, 5).toISOString();
  const EARLIER = new Date(2026, 8, 3, 14, 0).toISOString();

  function collection(over: Partial<Collection>): Collection {
    const members = over.members ?? [A, C];
    return {
      source: 'facility',
      ref: 'facility:injector',
      id: 'injector',
      name: 'Injector',
      members,
      layout: null,
      default: true,
      ...over,
    };
  }

  function browse(shown: Collection[]): BrowseCollections {
    return {
      enabled: true,
      shown,
      state: { ...EMPTY_STATE },
      recent: [],
      pinnedKeys: new Set(),
      openMember: vi.fn(),
      openAll: vi.fn(),
      pin: vi.fn(() => Promise.resolve()),
      unpin: vi.fn(() => Promise.resolve()),
      untick: vi.fn(() => Promise.resolve()),
      remove: vi.fn() as unknown as BrowseCollections['remove'],
      setRecentHover: vi.fn(),
    };
  }

  const heading = (ref: string) =>
    document.querySelector<HTMLElement>(
      `[data-branch="collection"][data-collection-ref="${ref}"]`
    )!;
  const row = (ref: string) => heading(ref).querySelector<HTMLElement>(':scope > .nav-tree__row')!;

  describe('formatWhen', () => {
    it('reads "Today HH:MM" for an update earlier today', () => {
      const time = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' }).format(
        new Date(TODAY)
      );
      expect(formatWhen(TODAY, NOW)).toBe(`Today ${time}`);
    });

    it('uses the medium date and short time for an earlier day', () => {
      const full = new Intl.DateTimeFormat(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(new Date(EARLIER));
      expect(formatWhen(EARLIER, NOW)).toBe(full);
      expect(formatWhen(EARLIER, NOW)).not.toMatch(/^Today/);
    });

    it('is empty for an absent or unparseable timestamp', () => {
      expect(formatWhen(undefined, NOW)).toBe('');
      expect(formatWhen('not a date', NOW)).toBe('');
    });
  });

  describe('collectionSummary / collectionSuffix', () => {
    it('reads "<name> \u00b7 N \u00b7 <when>"', () => {
      const c = collection({ name: 'Injector', updated: EARLIER });
      const when = formatWhen(EARLIER, NOW);
      expect(collectionSuffix(c, NOW)).toBe(`2 \u00b7 ${when}`);
      expect(collectionSummary(c, NOW)).toBe(`Injector \u00b7 2 \u00b7 ${when}`);
    });

    it('drops the <when> part when the collection has no updated time', () => {
      const c = collection({ name: 'Injector', members: [A] });
      expect(collectionSuffix(c, NOW)).toBe('1');
      expect(collectionSummary(c, NOW)).toBe('Injector \u00b7 1');
    });

    it('tells two same-name collections apart by their suffix', () => {
      const one = collection({ name: 'Mine', members: [A], updated: EARLIER });
      const two = collection({ name: 'Mine', members: [A, C], updated: TODAY });
      expect(collectionSummary(one, NOW)).not.toBe(collectionSummary(two, NOW));
    });

    describe('two same-name saves in the same minute with the same count', () => {
      // Saved 20 s apart: same name, same member count, same minute.
      const AT = new Date(2026, 9, 17, 14, 2, 10).toISOString();
      const AT_LATER = new Date(2026, 9, 17, 14, 2, 30).toISOString();
      const personal = (id: string, updated: string, name = 'rv-dup'): Collection =>
        collection({
          source: 'personal',
          ref: `personal:${id}`,
          id,
          name,
          members: [A],
          updated,
          default: false,
        });
      const first = personal('rv-dup', AT);
      const second = personal('rv-dup-2', AT_LATER);
      const other = personal('other', AT, 'Other');
      const shown = [first, second, other];

      it('read the same without the list beside them', () => {
        expect(collectionSummary(first, NOW)).toBe(collectionSummary(second, NOW));
      });

      it('read apart by their id once the shown list is given', () => {
        const plain = `rv-dup \u00b7 1 \u00b7 ${formatWhen(AT, NOW)}`;
        expect(collectionSummary(first, NOW, shown)).toBe(`${plain} \u00b7 rv-dup`);
        expect(collectionSummary(second, NOW, shown)).toBe(`${plain} \u00b7 rv-dup-2`);
        expect(collectionSuffix(second, NOW, shown)).toBe(
          `1 \u00b7 ${formatWhen(AT, NOW)} \u00b7 rv-dup-2`
        );
      });

      it('leave a summary that collides with nothing unchanged', () => {
        expect(collectionSummary(other, NOW, shown)).toBe(collectionSummary(other, NOW));
        const apart = personal('rv-dup-3', EARLIER);
        expect(collectionSummary(apart, NOW, [...shown, apart])).toBe(
          collectionSummary(apart, NOW)
        );
        expect(collectionSummary(first, NOW, [first, other])).toBe(collectionSummary(first, NOW));
      });

      it('fall back to an ordinal when ids are absent or repeat', () => {
        const a = { name: 'rv-dup', members: [A], updated: AT };
        const b = { name: 'rv-dup', members: [A], updated: AT_LATER };
        expect(collectionSuffix(a, NOW, [a, b])).toMatch(/ \u00b7 #1$/);
        expect(collectionSuffix(b, NOW, [a, b])).toMatch(/ \u00b7 #2$/);
        const facility = collection({ id: 'rv-dup', name: 'rv-dup', members: [A], updated: AT });
        expect(collectionSuffix(facility, NOW, [first, facility])).toMatch(/ \u00b7 #2$/);
        expect(collectionSuffix(first, NOW, [first, facility])).toMatch(/ \u00b7 #1$/);
      });

      it('read apart in the Replace dropdown text', () => {
        const rows = personalRows(shown);
        const texts = rows.map((r) => rowSummary(r, NOW, rows));
        expect(new Set(texts).size).toBe(3);
        expect(texts[1]).toMatch(/ \u00b7 rv-dup-2$/);
        expect(texts[2]).toBe(collectionSummary(other, NOW));
      });
    });
  });

  describe('CollectionBadge', () => {
    it('marks a personal collection and differs from a facility one', () => {
      const { container: personal } = render(<CollectionBadge source="personal" />);
      const { container: facility } = render(<CollectionBadge source="facility" />);
      const p = personal.querySelector<HTMLElement>('.collection-badge')!;
      const f = facility.querySelector<HTMLElement>('.collection-badge')!;
      expect(p.getAttribute('data-source')).toBe('personal');
      expect(f.getAttribute('data-source')).toBe('facility');
      expect(p.getAttribute('title')).toBe('Personal collection');
      expect(f.getAttribute('title')).toBe('Facility collection');
      expect(p.innerHTML).not.toBe(f.innerHTML);
    });
  });

  it('renders personal and facility headings with different badges', () => {
    const facility = collection({});
    const personal = collection({
      source: 'personal',
      ref: 'personal:mine',
      id: 'mine',
      name: 'Mine',
      default: false,
    });
    render(
      <ScreenTree screens={SCREENS} onOpen={() => {}} collections={browse([facility, personal])} />
    );
    const fBadge = row('facility:injector').querySelector<HTMLElement>(
      '.nav-tree__icon .collection-badge'
    )!;
    const pBadge = row('personal:mine').querySelector<HTMLElement>(
      '.nav-tree__icon .collection-badge'
    )!;
    expect(fBadge.getAttribute('data-source')).toBe('facility');
    expect(pBadge.getAttribute('data-source')).toBe('personal');
    expect(pBadge.innerHTML).not.toBe(fBadge.innerHTML);
    expect(heading('personal:mine').classList.contains('screen-tree__collection--personal')).toBe(
      true
    );
    expect(
      heading('facility:injector').classList.contains('screen-tree__collection--personal')
    ).toBe(false);
  });

  it('shows the "\u00b7 N \u00b7 <when>" suffix as secondary text, the full string in title', () => {
    const c = collection({ updated: EARLIER });
    render(<ScreenTree screens={SCREENS} onOpen={() => {}} collections={browse([c])} />);
    const label = row('facility:injector').querySelector('.nav-tree__label')!;
    // The label stays the name (it ellipsises alone); the suffix sits beside it.
    expect(label.textContent).toBe('Injector');
    const suffix = row('facility:injector').querySelector<HTMLElement>(
      '.screen-tree__collection-suffix'
    )!;
    expect(suffix).not.toBeNull();
    expect(suffix.textContent).toBe(`\u00b7 ${collectionSuffix(c)}`);
    expect(suffix.textContent).toContain('2');
    expect(heading('facility:injector').getAttribute('title')).toBe(collectionSummary(c));
  });

  it('keeps the description in the title after the summary line', () => {
    const c = collection({ updated: EARLIER, description: 'Gun to booster' });
    render(<ScreenTree screens={SCREENS} onOpen={() => {}} collections={browse([c])} />);
    expect(heading('facility:injector').getAttribute('title')).toBe(
      `${collectionSummary(c)}\nGun to booster`
    );
  });

  it('reads two same-name, same-minute, same-count headings apart', () => {
    const AT = new Date(2026, 9, 17, 14, 2, 10).toISOString();
    const AT_LATER = new Date(2026, 9, 17, 14, 2, 30).toISOString();
    const mine = (id: string, updated: string) =>
      collection({
        source: 'personal',
        ref: `personal:${id}`,
        id,
        name: 'rv-dup',
        members: [A],
        updated,
        default: false,
      });
    const first = mine('rv-dup', AT);
    const second = mine('rv-dup-2', AT_LATER);
    const other = collection({ updated: EARLIER });
    render(
      <ScreenTree
        screens={SCREENS}
        onOpen={() => {}}
        collections={browse([first, second, other])}
      />
    );
    const suffix = (ref: string) =>
      row(ref).querySelector<HTMLElement>('.screen-tree__collection-suffix')!.textContent;
    expect(suffix('personal:rv-dup')).toMatch(/ \u00b7 rv-dup$/);
    expect(suffix('personal:rv-dup-2')).toMatch(/ \u00b7 rv-dup-2$/);
    const t1 = heading('personal:rv-dup').getAttribute('title');
    const t2 = heading('personal:rv-dup-2').getAttribute('title');
    expect(t1).not.toBe(t2);
    expect(t2).toMatch(/^rv-dup \u00b7 1 \u00b7 .* \u00b7 rv-dup-2$/);
    // The name itself stays plain; a heading that collides with nothing is unchanged.
    expect(row('personal:rv-dup-2').querySelector('.nav-tree__label')!.textContent).toBe('rv-dup');
    expect(suffix('facility:injector')).toBe(`\u00b7 ${collectionSuffix(other)}`);
    expect(heading('facility:injector').getAttribute('title')).toBe(collectionSummary(other));
  });
});
