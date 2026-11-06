// WorkspaceSidebar + usePaneSplitter: the screen browser's splitter (the same
// grip-pill splitter idiom as the host shell). jsdom has no layout and no PointerEvent, so
// pointer events are MouseEvents of the pointer types (React keys on the
// type) and an unsized pane "measures" as the 256 px stylesheet default.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ManifestScreen } from '../api.js';
import { formatShortcut } from '../screenActions/shortcuts.js';
import { resetShowSubScreensStore, setShowSubScreens } from '../screenList.js';
import { CollectionsPopover } from './CollectionsPopover.js';
import {
  HOST_SHELL_CAPABILITIES,
  HostCapabilitiesContext,
  STANDALONE_CAPABILITIES,
} from './host/hostCapabilities.js';
import type { CollectionsPopoverProps } from './CollectionsPopover.js';
import { QuickOpen } from './QuickOpen.js';
import { ScreenTree } from './ScreenTree.js';
import { parseSplitterState } from './usePaneSplitter.js';
import {
  SIDEBAR_DEFAULT,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  SIDEBAR_MENU_LABEL,
  SIDEBAR_SEARCH_LABEL,
  WorkspaceSidebar,
  sidebarStorageKey,
} from './WorkspaceSidebar.js';

const KEY = 'canopy-workspace-sidebar:/';

function renderSidebar(basename = '/') {
  return render(
    <div>
      <WorkspaceSidebar basename={basename}>
        <input aria-label="tree probe" />
      </WorkspaceSidebar>
    </div>
  );
}

const handle = () => screen.getByRole('separator', { name: 'Resize screen browser' });
// The aside, not handle().previousElementSibling: a collapsed pane has the rail between.
const pane = () => document.querySelector('aside.workspace__sidebar') as HTMLElement;
const stored = (key = KEY) => parseSplitterState(localStorage.getItem(key));

function pointer(type: string, clientX: number) {
  fireEvent(handle(), new MouseEvent(type, { bubbles: true, cancelable: true, clientX }));
}

function drag(from: number, to: number) {
  pointer('pointerdown', from);
  pointer('pointermove', to);
  pointer('pointerup', to);
}

/** A Storage stand-in (Node >= 25 shadows jsdom's localStorage with an unusable global). */
function memoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, String(value)),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  };
}

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  window.innerWidth = 1600;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('sidebarStorageKey', () => {
  it('scopes the record to the base path, trailing slash or not', () => {
    expect(sidebarStorageKey('/')).toBe('canopy-workspace-sidebar:/');
    expect(sidebarStorageKey('')).toBe('canopy-workspace-sidebar:/');
    expect(sidebarStorageKey('/u/alice/panel/canopy/')).toBe(
      'canopy-workspace-sidebar:/u/alice/panel/canopy'
    );
    expect(sidebarStorageKey('/u/alice/panel/canopy')).toBe(
      sidebarStorageKey('/u/alice/panel/canopy/')
    );
    expect(sidebarStorageKey('/u/alice/panel/canopy')).not.toBe(
      sidebarStorageKey('/u/bob/panel/canopy')
    );
  });
});

describe('WorkspaceSidebar splitter', () => {
  it('is a focusable vertical separator beside the pane, unsized by default', () => {
    renderSidebar();
    const h = handle();
    expect(h.getAttribute('aria-orientation')).toBe('vertical');
    expect(h.tabIndex).toBe(0);
    expect(h.getAttribute('aria-valuemin')).toBe(String(SIDEBAR_MIN));
    expect(h.getAttribute('aria-valuemax')).toBe(String(SIDEBAR_MAX));
    expect(h.getAttribute('aria-valuenow')).toBe(String(SIDEBAR_DEFAULT));
    expect(pane().tagName).toBe('ASIDE');
    expect(pane().style.flexBasis).toBe('');
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('drags the width and persists {size, collapsed} on release', () => {
    renderSidebar();
    pointer('pointerdown', 300);
    expect(pane().hasAttribute('data-splitter-dragging')).toBe(true);
    expect(handle().classList.contains('dragging')).toBe(true);
    pointer('pointermove', 400);
    // Nothing persists mid-drag.
    expect(localStorage.getItem(KEY)).toBeNull();
    pointer('pointerup', 400);
    expect(pane().style.flexBasis).toBe('356px');
    expect(pane().style.maxWidth).toBe('356px');
    expect(pane().hasAttribute('data-splitter-dragging')).toBe(false);
    expect(handle().classList.contains('dragging')).toBe(false);
    expect(handle().getAttribute('aria-valuenow')).toBe('356');
    expect(stored()).toEqual({ size: 356, collapsed: false });
  });

  it('clamps a drag to 180-560 px', () => {
    renderSidebar();
    drag(300, 1500);
    expect(pane().style.flexBasis).toBe(`${SIDEBAR_MAX}px`);
    drag(300, -900);
    expect(pane().style.flexBasis).toBe(`${SIDEBAR_MIN}px`);
    expect(stored()).toEqual({ size: SIDEBAR_MIN, collapsed: false });
  });

  it('caps the width at 60 % of a narrow window', () => {
    window.innerWidth = 500;
    renderSidebar();
    expect(handle().getAttribute('aria-valuemax')).toBe('300');
    drag(300, 900);
    expect(pane().style.flexBasis).toBe('300px');
  });

  it('a press that never moves commits nothing', () => {
    renderSidebar();
    pointer('pointerdown', 300);
    pointer('pointerup', 300);
    expect(pane().style.flexBasis).toBe('');
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('arrow keys nudge by 16 px, clamped', () => {
    renderSidebar();
    fireEvent.keyDown(handle(), { key: 'ArrowRight' });
    expect(pane().style.flexBasis).toBe(`${SIDEBAR_DEFAULT + 16}px`);
    fireEvent.keyDown(handle(), { key: 'ArrowLeft' });
    fireEvent.keyDown(handle(), { key: 'ArrowLeft' });
    expect(pane().style.flexBasis).toBe(`${SIDEBAR_DEFAULT - 16}px`);
    expect(stored()).toEqual({ size: SIDEBAR_DEFAULT - 16, collapsed: false });
    for (let i = 0; i < 10; i++) fireEvent.keyDown(handle(), { key: 'ArrowLeft' });
    expect(pane().style.flexBasis).toBe(`${SIDEBAR_MIN}px`);
    // Other keys are left alone.
    fireEvent.keyDown(handle(), { key: 'ArrowUp' });
    expect(pane().style.flexBasis).toBe(`${SIDEBAR_MIN}px`);
  });

  it('double-click collapses and restores the previous width', () => {
    renderSidebar();
    drag(300, 380);
    expect(pane().style.flexBasis).toBe('336px');

    fireEvent.doubleClick(handle());
    expect(pane().style.flexBasis).toBe('0px');
    expect(pane().hasAttribute('data-collapsed')).toBe(true);
    expect(stored()).toEqual({ size: 336, collapsed: true });

    fireEvent.doubleClick(handle());
    expect(pane().style.flexBasis).toBe('336px');
    expect(pane().hasAttribute('data-collapsed')).toBe(false);
    expect(stored()).toEqual({ size: 336, collapsed: false });
  });

  it('Enter and Space toggle the collapse too', () => {
    renderSidebar();
    fireEvent.keyDown(handle(), { key: 'Enter' });
    expect(pane().style.flexBasis).toBe('0px');
    expect(stored()).toEqual({ size: SIDEBAR_DEFAULT, collapsed: true });
    fireEvent.keyDown(handle(), { key: ' ' });
    expect(pane().style.flexBasis).toBe(`${SIDEBAR_DEFAULT}px`);
  });

  it('a drag from collapsed starts at 0 and expands', () => {
    renderSidebar();
    fireEvent.doubleClick(handle());
    drag(10, 210);
    expect(pane().style.flexBasis).toBe('200px');
    expect(stored()).toEqual({ size: 200, collapsed: false });
  });

  it('restores the stored record on mount, collapsed included', () => {
    localStorage.setItem(KEY, JSON.stringify({ size: 420, collapsed: false }));
    renderSidebar();
    expect(pane().style.flexBasis).toBe('420px');
    cleanup();

    localStorage.setItem(KEY, JSON.stringify({ size: 420, collapsed: true }));
    renderSidebar();
    expect(pane().style.flexBasis).toBe('0px');
    fireEvent.doubleClick(handle());
    expect(pane().style.flexBasis).toBe('420px');
  });

  it('clamps a stored size from outside the bounds', () => {
    localStorage.setItem(KEY, JSON.stringify({ size: 9000, collapsed: false }));
    renderSidebar();
    expect(pane().style.flexBasis).toBe(`${SIDEBAR_MAX}px`);
  });

  it('ignores an unusable stored record', () => {
    localStorage.setItem(KEY, 'not json');
    renderSidebar();
    expect(pane().style.flexBasis).toBe('');
    cleanup();
    localStorage.setItem(KEY, JSON.stringify({ size: 'wide' }));
    renderSidebar();
    expect(pane().style.flexBasis).toBe('');
  });

  it('keeps one record per base path', () => {
    const alice = sidebarStorageKey('/u/alice/panel/canopy/');
    const bob = sidebarStorageKey('/u/bob/panel/canopy/');
    localStorage.setItem(bob, JSON.stringify({ size: 500, collapsed: false }));

    renderSidebar('/u/alice/panel/canopy/');
    expect(pane().style.flexBasis).toBe('');
    drag(300, 320);
    expect(stored(alice)).toEqual({ size: SIDEBAR_DEFAULT + 20, collapsed: false });
    expect(stored(bob)).toEqual({ size: 500, collapsed: false });
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('falls back to the default and still resizes when storage throws', () => {
    const getItem = vi.fn(() => {
      throw new Error('SecurityError');
    });
    const setItem = vi.fn(() => {
      throw new Error('QuotaExceededError');
    });
    vi.stubGlobal('localStorage', { ...memoryStorage(), getItem, setItem });
    renderSidebar();
    expect(getItem).toHaveBeenCalledWith(KEY);
    expect(pane().style.flexBasis).toBe('');
    drag(300, 340);
    expect(pane().style.flexBasis).toBe(`${SIDEBAR_DEFAULT + 40}px`);
    fireEvent.doubleClick(handle());
    expect(pane().style.flexBasis).toBe('0px');
    expect(setItem).toHaveBeenCalled();
  });

  it('works without any localStorage', () => {
    vi.stubGlobal('localStorage', undefined);
    renderSidebar();
    fireEvent.keyDown(handle(), { key: 'ArrowRight' });
    expect(pane().style.flexBasis).toBe(`${SIDEBAR_DEFAULT + 16}px`);
  });
});

describe('WorkspaceSidebar header', () => {
  afterEach(cleanup);

  it('renders the header above the tree, inside the pane', () => {
    render(
      <WorkspaceSidebar basename="/" header={<button type="button">Quick open</button>}>
        <input aria-label="tree probe" />
      </WorkspaceSidebar>
    );
    const header = screen.getByTestId('workspace-sidebar-header');
    const tree = screen.getByRole('textbox', { name: 'tree probe' });
    expect(header.parentElement).toBe(tree.parentElement);
    expect(header.parentElement?.tagName).toBe('ASIDE');
    expect(header.nextElementSibling).toBe(tree);
    expect(screen.getByRole('button', { name: 'Quick open' }).parentElement).toBe(header);
  });

  it('without header content the row holds only the collapse control', () => {
    renderSidebar();
    const header = screen.getByTestId('workspace-sidebar-header');
    expect(header.querySelectorAll('button')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Collapse screen browser' })).toBeTruthy();
  });
});

describe('WorkspaceSidebar collapse control', () => {
  const collapseBtn = () => screen.getByRole('button', { name: 'Collapse screen browser' });
  const expandBtn = () => screen.getByRole('button', { name: 'Expand screen browser' });
  const rail = () => screen.getByTestId('workspace-sidebar-rail');

  it('a visible chevron in the header names the pane it controls', () => {
    render(
      <WorkspaceSidebar basename="/" header={<button type="button">Quick open</button>}>
        <input aria-label="tree probe" />
      </WorkspaceSidebar>
    );
    const btn = collapseBtn();
    expect(btn.closest('[data-testid="workspace-sidebar-header"]')).not.toBeNull();
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    const id = btn.getAttribute('aria-controls');
    expect(id).toBeTruthy();
    expect(document.getElementById(id!)).toBe(pane());
    expect(screen.queryByTestId('workspace-sidebar-rail')).toBeNull();
  });

  it('collapses to a rail with an expand button, and back', () => {
    renderSidebar();
    fireEvent.click(collapseBtn());
    expect(pane().hasAttribute('data-collapsed')).toBe(true);
    expect(pane().style.flexBasis).toBe('0px');
    expect(stored()).toEqual({ size: SIDEBAR_DEFAULT, collapsed: true });

    const r = rail();
    expect(r.classList.contains('workspace__sidebar-rail')).toBe(true);
    // The rail replaces the pane on screen: it sits between pane and splitter.
    expect(r.nextElementSibling).toBe(handle());
    expect(r.previousElementSibling?.tagName).toBe('ASIDE');
    const btn = expandBtn();
    expect(r.contains(btn)).toBe(true);
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(btn.getAttribute('aria-controls')).toBe(r.previousElementSibling?.id);
    // Focus follows the control that replaced the one pressed.
    expect(document.activeElement).toBe(btn);

    fireEvent.click(btn);
    expect(pane().hasAttribute('data-collapsed')).toBe(false);
    expect(pane().style.flexBasis).toBe(`${SIDEBAR_DEFAULT}px`);
    expect(screen.queryByTestId('workspace-sidebar-rail')).toBeNull();
    expect(collapseBtn().getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(collapseBtn());
  });

  it('the rail shows for a collapse from the splitter or from storage', () => {
    renderSidebar();
    fireEvent.doubleClick(handle());
    expect(expandBtn().getAttribute('aria-expanded')).toBe('false');
    // A splitter toggle leaves focus where it was.
    expect(document.activeElement).not.toBe(expandBtn());
    cleanup();

    localStorage.setItem(KEY, JSON.stringify({ size: 400, collapsed: true }));
    renderSidebar();
    expect(rail()).toBeTruthy();
    fireEvent.click(expandBtn());
    expect(pane().style.flexBasis).toBe('400px');
  });

  it('Home and End on the splitter jump to min and max', () => {
    renderSidebar();
    fireEvent.keyDown(handle(), { key: 'End' });
    expect(pane().style.flexBasis).toBe(`${SIDEBAR_MAX}px`);
    expect(handle().getAttribute('aria-valuenow')).toBe(String(SIDEBAR_MAX));
    fireEvent.keyDown(handle(), { key: 'Home' });
    expect(pane().style.flexBasis).toBe(`${SIDEBAR_MIN}px`);
    expect(stored()).toEqual({ size: SIDEBAR_MIN, collapsed: false });
  });
});

// --- the one-row header (compactSidebar) -------------------------------------

function entry(category: string, id: string, title: string): ManifestScreen {
  return { id, kind: 'ir', title, category, path: `screens/${category}/${id}.screen.json` };
}

const SCREENS: ManifestScreen[] = [
  entry('transfer', 'bts/a', 'Alpha BTS'),
  entry('transfer', 'gtl/c', 'GTL Overview'),
  entry('transfer', 'bts/embedded/part', 'BTS Part'),
];

function collectionsApi(): CollectionsPopoverProps['api'] {
  return {
    enabled: true,
    collections: [],
    shown: [],
    tick: vi.fn(() => Promise.resolve()),
    untick: vi.fn(() => Promise.resolve()),
    openAll: vi.fn(),
  };
}

function renderCompact(options: { compact?: boolean; collections?: boolean } = {}) {
  const { compact = true, collections = true } = options;
  return render(
    <HostCapabilitiesContext.Provider
      value={compact ? HOST_SHELL_CAPABILITIES : STANDALONE_CAPABILITIES}
    >
      <WorkspaceSidebar
        basename="/"
        collections={collections}
        header={
          <>
            {collections && (
              <CollectionsPopover api={collectionsApi()} onSave={() => {}} trigger={!compact} />
            )}
            <QuickOpen screens={SCREENS} tools={[]} onOpen={() => {}} mac trigger={!compact} />
          </>
        }
      >
        <ScreenTree screens={SCREENS} onOpen={() => {}} />
      </WorkspaceSidebar>
    </HostCapabilitiesContext.Provider>
  );
}

const headerRow = () => screen.getByTestId('workspace-sidebar-header');
const field = () => screen.getByRole('searchbox', { name: SIDEBAR_SEARCH_LABEL });
const menuButton = () => screen.getByRole('button', { name: SIDEBAR_MENU_LABEL });
const treeText = () => document.querySelector('nav.screen-tree')?.textContent ?? '';

describe('WorkspaceSidebar one-row header (compactSidebar)', () => {
  beforeEach(() => resetShowSubScreensStore());

  it('is one row: search field, sidebar menu, collapse chevron, in that order', () => {
    renderCompact();
    const row = headerRow();
    const input = field();
    expect(input.getAttribute('placeholder')).toBe(SIDEBAR_SEARCH_LABEL);
    // The tree search's id, so primary+K typed in it still reaches quick open.
    expect(input.id).toBe('screen-tree-search');
    // The platform-formatted shortcut sits inside the field.
    expect(row.querySelector('kbd')?.textContent).toBe(formatShortcut('k'));
    const parts = [
      input,
      menuButton(),
      screen.getByRole('button', { name: 'Collapse screen browser' }),
    ];
    for (const part of parts) expect(row.contains(part)).toBe(true);
    for (let i = 1; i < parts.length; i++) {
      expect(
        parts[i - 1]!.compareDocumentPosition(parts[i]!) & Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();
    }
    // One row: no Quick open button, no Collections trigger.
    expect(screen.queryByRole('button', { name: /Quick open/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Collections' })).toBeNull();
    // Only the header's field: the tree drops its own controls row.
    expect(document.querySelectorAll('#screen-tree-search')).toHaveLength(1);
    expect(screen.queryByRole('checkbox', { name: /Show sub-screens/ })).toBeNull();
  });

  it('typing in the field narrows the tree and never opens quick open', () => {
    renderCompact();
    expect(treeText()).toContain('Alpha BTS');
    expect(treeText()).toContain('GTL Overview');
    fireEvent.change(field(), { target: { value: 'gtl' } });
    expect(treeText()).toContain('GTL Overview');
    expect(treeText()).not.toContain('Alpha BTS');
    expect(screen.queryByRole('dialog', { name: 'Quick open' })).toBeNull();
    fireEvent.change(field(), { target: { value: '' } });
    expect(treeText()).toContain('Alpha BTS');
  });

  it('primary+K with focus in the field opens quick open', () => {
    renderCompact();
    field().focus();
    fireEvent.keyDown(field(), { key: 'k', metaKey: true });
    expect(screen.getByRole('dialog', { name: 'Quick open' })).toBeTruthy();
  });

  it('Show sub-screens in the menu toggles the store, and the store re-renders the tree', () => {
    renderCompact();
    expect(treeText()).not.toContain('BTS Part');
    fireEvent.click(menuButton());
    const menu = screen.getByRole('menu', { name: SIDEBAR_MENU_LABEL });
    const item = within(menu).getByRole('menuitemcheckbox', { name: 'Show sub-screens' });
    expect(item.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(item);
    expect(treeText()).toContain('BTS Part');
    expect(localStorage.getItem('canopy-viewer:show-sub-screens:/')).toBe('1');
    // A write from anywhere else (the host header, say) reaches the tree too.
    act(() => setShowSubScreens(false));
    expect(treeText()).not.toContain('BTS Part');
  });

  it('Collections\u2026 expands a collapsed sidebar, then opens the popover', () => {
    renderCompact();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse screen browser' }));
    expect(pane().hasAttribute('data-collapsed')).toBe(true);
    fireEvent.click(menuButton());
    fireEvent.click(screen.getByRole('menuitem', { name: 'Collections\u2026' }));
    expect(pane().hasAttribute('data-collapsed')).toBe(false);
    expect(document.querySelector('.collections-popover__body')).not.toBeNull();
  });

  it('omits Collections\u2026 when collections are off', () => {
    renderCompact({ collections: false });
    fireEvent.click(menuButton());
    expect(screen.getByRole('menuitemcheckbox', { name: 'Show sub-screens' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Collections\u2026' })).toBeNull();
  });

  it('collapses to a rail holding only the expand button, and back', () => {
    renderCompact();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse screen browser' }));
    const rail = screen.getByTestId('workspace-sidebar-rail');
    expect(rail.querySelectorAll('button')).toHaveLength(1);
    expect(rail.querySelector('input')).toBeNull();
    fireEvent.click(within(rail).getByRole('button', { name: 'Expand screen browser' }));
    expect(screen.queryByTestId('workspace-sidebar-rail')).toBeNull();
    expect(field()).toBeTruthy();
  });

  it('without the capability keeps the Collections / Quick open row and the tree controls', () => {
    renderCompact({ compact: false });
    const row = headerRow();
    expect(within(row).getByRole('button', { name: 'Collections' })).toBeTruthy();
    expect(within(row).getByRole('button', { name: 'Quick open (\u2318K)' })).toBeTruthy();
    expect(within(row).queryByRole('button', { name: SIDEBAR_MENU_LABEL })).toBeNull();
    expect(row.querySelector('input')).toBeNull();
    // The tree's own field and checkbox stay.
    expect(screen.getByRole('searchbox', { name: 'Search screens' })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: /Show sub-screens/ })).toBeTruthy();
  });
});
