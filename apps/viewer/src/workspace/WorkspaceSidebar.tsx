// The workspace's screen browser pane and the splitter beside it. Only this
// component re-renders while the splitter drags: `children` (the tree) is an
// element WorkspacePage built, so React reuses it untouched.
//
// The splitter record is per base path: a host that serves several users on
// one origin under per-user prefixes would otherwise let one user's width
// leak into another's.
//
// `header` is an optional row above the tree (the Collections popover trigger
// and the Quick open button); like `children` it is an element the page built.
//
// Collapse: the header row always ends in a visible chevron button
// (`aria-expanded`/`aria-controls` on the pane). A collapsed pane is replaced
// on screen by a 24 px rail holding the expand button; the separator stays
// beside it, so a drag or Enter on it still restores the pane. Focus follows
// the button that replaces the one pressed; a splitter toggle leaves it alone.
//
// With the compactSidebar host capability the header is one row: the search field
// ("Search screens & tools", the platform's ⌘K / Ctrl+K kbd inside) · a
// sidebar ⋯ (Show sub-screens ✓, and Collections… when collections are on) ·
// the collapse chevron. The field keeps the tree search's id (TREE_SEARCH_ID),
// so primary+K typed in it still opens quick open; typing only filters:
// the query reaches ScreenTree through SidebarQueryContext, re-rendering the
// tree and nothing else. Show sub-screens is the screenList.ts store. The
// page's `header` (a trigger-less Collections popover and QuickOpen) sits
// between the field and the ⋯, so Collections… opens the popover anchored
// here (openCollections()). Either way the
// sidebar registers itself with registerCollectionsSidebar(), so that entry
// (and the host's) expands a collapsed pane first. Without the capability the
// `header` row is the page's controls as given.

import { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from 'react';
import type { ChangeEvent, ReactNode } from 'react';
import { ChevronLeft, ChevronRight, OverflowMenuVertical } from '@carbon/icons-react';
import { Menu, MenuItem, MenuItemSelectable, Search } from '@carbon/react';
import { EmbedThemeContext } from '../pages/EmbedPage.js';
import { formatShortcut, isMac } from '../screenActions/shortcuts.js';
import { setShowSubScreens, useShowSubScreens } from '../screenList.js';
import { storageKey } from '../storageScope.js';
import { openCollections, registerCollectionsSidebar } from './CollectionsPopover.js';
import { useHostCapabilities } from './host/hostCapabilities.js';
import { TREE_SEARCH_ID } from './QuickOpen.js';
import { usePaneSplitter } from './usePaneSplitter.js';
import './paneSplitter.css';

/**
 * The one-row header's filter query, for the tree below it; null when the
 * sidebar has no header search, so the tree keeps its own controls.
 */
export const SidebarQueryContext = createContext<string | null>(null);

/** The one-row header field's placeholder and accessible name. */
export const SIDEBAR_SEARCH_LABEL = 'Search screens & tools';
/** The sidebar ⋯ button's accessible name. */
export const SIDEBAR_MENU_LABEL = 'Screen browser options';
export const SHOW_SUB_SCREENS_LABEL = 'Show sub-screens';
export const COLLECTIONS_ENTRY_LABEL = 'Collections\u2026';

/** Bounds of the screen browser's width, in px. */
export const SIDEBAR_MIN = 180;
export const SIDEBAR_MAX = 560;
/** The stylesheet default (16rem), used when the pane cannot be measured. */
export const SIDEBAR_DEFAULT = 256;

/** At most 60 % of the window, so the content keeps room on a narrow one. */
function sidebarMax(): number {
  return Math.min(SIDEBAR_MAX, Math.floor(window.innerWidth * 0.6));
}

/** The splitter's storage key for a router basename (`/`, `/x/y`, `/x/y/`). */
export function sidebarStorageKey(basename: string): string {
  return storageKey('canopy-workspace-sidebar', basename);
}

/** The one-row header's ⋯: Show sub-screens ✓ and, when on, Collections…. */
function SidebarMenu({ collections }: { collections: boolean }) {
  const { anchorRef } = useContext(EmbedThemeContext);
  const showSubScreens = useShowSubScreens();
  const button = useRef<HTMLButtonElement | null>(null);
  const [place, setPlace] = useState<{ x: number; y: number; target: Element | null } | null>(null);
  const toggle = () => {
    if (place) return setPlace(null);
    const rect = button.current?.getBoundingClientRect();
    setPlace({ x: rect?.left ?? 0, y: rect?.bottom ?? 0, target: anchorRef.current });
  };
  return (
    <>
      <button
        ref={button}
        type="button"
        className="workspace__sidebar-toggle workspace__sidebar-menu"
        aria-label={SIDEBAR_MENU_LABEL}
        title={SIDEBAR_MENU_LABEL}
        aria-haspopup="menu"
        aria-expanded={place !== null}
        onClick={toggle}
      >
        <OverflowMenuVertical size={16} aria-hidden="true" />
      </button>
      {place && (
        <Menu
          label={SIDEBAR_MENU_LABEL}
          mode="full"
          size="sm"
          open
          x={place.x}
          y={place.y}
          target={place.target ?? undefined}
          onClose={() => setPlace(null)}
        >
          <MenuItemSelectable
            label={SHOW_SUB_SCREENS_LABEL}
            selected={showSubScreens}
            onChange={(checked) => setShowSubScreens(checked)}
          />
          {collections && (
            <MenuItem
              label={COLLECTIONS_ENTRY_LABEL}
              onClick={() => {
                setPlace(null);
                openCollections();
              }}
            />
          )}
        </Menu>
      )}
    </>
  );
}

/** The one-row header's search field: drives the tree filter, never opens quick open. */
function SidebarSearch({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  return (
    <div
      className="workspace__sidebar-search"
      style={{ position: 'relative', flex: '1 1 auto', minWidth: 0 }}
    >
      <Search
        id={TREE_SEARCH_ID}
        data-testid="screen-tree-search"
        size="sm"
        labelText={SIDEBAR_SEARCH_LABEL}
        placeholder={SIDEBAR_SEARCH_LABEL}
        value={value}
        onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)}
      />
      {value === '' && (
        <kbd
          className="workspace__sidebar-kbd"
          aria-hidden="true"
          style={{
            position: 'absolute',
            insetInlineEnd: '0.5rem',
            insetBlockStart: '50%',
            transform: 'translateY(-50%)',
            pointerEvents: 'none',
            fontSize: 'var(--canopy-text-sm, 0.75rem)',
            color: 'var(--canopy-text-muted)',
          }}
        >
          {formatShortcut('k', isMac)}
        </kbd>
      )}
    </div>
  );
}

export function WorkspaceSidebar({
  basename,
  header,
  collections = false,
  children,
}: {
  /** Router basename; scopes the persisted width (see above). */
  basename: string;
  /** Controls shown above the tree, before the collapse chevron. */
  header?: ReactNode;
  /** Whether the one-row header's ⋯ lists Collections… (config.collections is on). */
  collections?: boolean;
  children: ReactNode;
}) {
  const { compactSidebar: compact } = useHostCapabilities();
  const { paneProps, handleProps, collapsed, toggle } = usePaneSplitter({
    storageKey: sidebarStorageKey(basename),
    min: SIDEBAR_MIN,
    max: sidebarMax,
    fallbackSize: SIDEBAR_DEFAULT,
    label: 'Resize screen browser',
  });
  const paneId = useId();
  const collapseRef = useRef<HTMLButtonElement | null>(null);
  const expandRef = useRef<HTMLButtonElement | null>(null);
  // Set by a button press only, so a splitter toggle never moves focus.
  const focusNext = useRef(false);
  useEffect(() => {
    if (!focusNext.current) return;
    focusNext.current = false;
    (collapsed ? expandRef : collapseRef).current?.focus();
  }, [collapsed]);
  const press = () => {
    focusNext.current = true;
    toggle();
  };
  // openCollections() (either ⋯) expands a collapsed pane first.
  const collapsedRef = useRef(collapsed);
  useEffect(() => {
    collapsedRef.current = collapsed;
  }, [collapsed]);
  const expand = useCallback(() => {
    if (collapsedRef.current) toggle();
  }, [toggle]);
  useEffect(
    () => registerCollectionsSidebar({ collapsed: () => collapsedRef.current, expand }),
    [expand]
  );
  const [query, setQuery] = useState('');
  return (
    <>
      <aside id={paneId} className="workspace__sidebar" {...paneProps}>
        <div className="workspace__sidebar-header" data-testid="workspace-sidebar-header">
          {compact ? (
            <>
              <SidebarSearch value={query} onChange={setQuery} />
              <div className="workspace__sidebar-anchor" style={{ display: 'contents' }}>
                {header}
              </div>
              <SidebarMenu collections={collections} />
            </>
          ) : (
            header
          )}
          <button
            ref={collapseRef}
            type="button"
            className="workspace__sidebar-toggle"
            aria-label="Collapse screen browser"
            title="Collapse screen browser"
            aria-expanded={true}
            aria-controls={paneId}
            onClick={press}
          >
            <ChevronLeft size={16} aria-hidden="true" />
          </button>
        </div>
        {compact ? (
          <SidebarQueryContext.Provider value={query}>{children}</SidebarQueryContext.Provider>
        ) : (
          children
        )}
      </aside>
      {collapsed && (
        <div className="workspace__sidebar-rail" data-testid="workspace-sidebar-rail">
          <button
            ref={expandRef}
            type="button"
            className="workspace__sidebar-toggle"
            aria-label="Expand screen browser"
            title="Expand screen browser"
            aria-expanded={false}
            aria-controls={paneId}
            onClick={press}
          >
            <ChevronRight size={16} aria-hidden="true" />
          </button>
        </div>
      )}
      <div {...handleProps} data-testid="workspace-splitter" />
    </>
  );
}
