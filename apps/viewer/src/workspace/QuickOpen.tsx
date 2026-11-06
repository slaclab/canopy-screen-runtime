// Quick open: a palette that finds and opens anything the workspace can
// open by typing part of its name. A visible "Quick open (⌘K)" button, the
// primary+K binding inside this document, and openQuickOpen() (which the page
// calls when a tool frame forwards its own primary+K as `canopy:quick-open`)
// all open the same dialog.
//
// The dialog holds an input with `role=combobox` and a listbox whose active
// option is named by `aria-activedescendant` (no Carbon ComboBox: the input
// keeps focus, the arrows move the active option). Entries, in this order when
// nothing is typed: the open tabs ("Switch to tab · <title>"), collections,
// the named tool members of every collection (meta = the collection's name),
// tools, saved views, screens (match.ts's searchable rule: IR screens outside
// the `@` categories, sub-screens only when the remembered toggle shows them).
// Collections and their members are absent without config.collections.
// Typing ranks with the shared matcher (match.ts: every query word
// prefixes a word of the label or a keyword; a screen's keywords are its id
// and category/id path, a tab's its key). Open tabs that match stay first;
// at most 50 entries are shown.
//
// Enter opens the active entry by the tree's row table; Shift+Enter and the
// open modifier (⌘+Enter on macOS, Ctrl+Enter elsewhere) are the table's
// new-tab column (a click and a Shift/modifier click likewise). A tab entry
// focuses that tab. A screen
// replaces the active tile / appends; a tool opens or focuses its MRU instance
// / opens a new one; a named tool member goes through openMember (focus the
// instance showing it, else a new one) / always a new instance; a saved view is
// openView / openView(newTab); a collection is Open all either way. With the
// feature on, screens and tools open through the collections' openMember too,
// so the palette posts Recent like any single explicit open.
//
// Esc (and a click on the backdrop) closes the dialog and returns focus to the
// opener, or to the tree search when the opener was a tool frame (focus inside
// an iframe, or a forward from one). Opening an entry closes it and moves
// focus into the opened tile on the next paint once the active tab has
// changed (or, when it did not change, into the active tile), falling back to
// the opener when that tile is not shown.
// The binding ignores a key typed into an editable field other than the tree
// search, so it never takes ⌘K from a form.
//
// The dialog is rendered into the embed layout's root element
// (EmbedThemeContext), read when it opens, so the host stylesheet reaches it;
// outside an embed layout it goes to document.body.

import { useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react';
import { createPortal } from 'react-dom';
import type { ManifestScreen } from '../api.js';
import { EmbedThemeContext } from '../pages/EmbedPage.js';
import {
  formatShortcut,
  isMac,
  openModifier,
  primaryShortcutKey,
} from '../screenActions/shortcuts.js';
import { getShowSubScreens } from '../screenList.js';
import { focusTilePanel } from './dock/useTileFocus.js';
import { rankEntries, searchable } from './match.js';
import type { TabStripTab } from './TabStrip.js';
import type { Collection, CollectionsApi } from './useCollections.js';
import type { Member, ToolMember } from './collections.js';
import type { SavedView } from './savedViews.js';
import type { OpenMode } from './tabs.js';
import { tabKey } from './tabs.js';
import { toolLabel, toolSpec } from './tools.js';
import './QuickOpen.css';

/** At most this many entries are listed. */
export const QUICK_OPEN_CAP = 50;

/** The tree search's element id: where Esc returns focus from a tool frame. */
export const TREE_SEARCH_ID = 'screen-tree-search';

/** One palette entry. */
export type QuickOpenEntry = {
  /** Unique within the list; also the option's DOM id suffix. */
  id: string;
  label: string;
  /** Secondary text: the kind, or a named member's collection. */
  meta: string;
  /** Further text the query may match (a screen's id and path, a tab's key). */
  keywords?: readonly string[];
} & (
  | { kind: 'tab'; key: string }
  | { kind: 'collection'; collection: Collection }
  | { kind: 'member'; member: ToolMember; collection: Collection }
  | { kind: 'tool'; tool: string }
  | { kind: 'view'; view: SavedView }
  | { kind: 'screen'; screen: ManifestScreen }
);

export interface QuickOpenSources {
  screens: readonly ManifestScreen[] | null;
  /** The tools served here (configuredTools), in registry order. */
  tools: readonly string[];
  views?: readonly SavedView[];
  /** Every collection; omitted (or the feature off) lists none. */
  collections?: readonly Collection[];
  /** Whether sub-screens are listed (the tree's remembered toggle). */
  showSubScreens: boolean;
}

/** The label prefix of an open tab's entry. */
export const SWITCH_TO_TAB = 'Switch to tab · ';

/** The open tabs' entries, in strip order. */
export function tabEntries(tabs: readonly TabStripTab[]): QuickOpenEntry[] {
  return tabs.map((tab) => ({
    id: `tab:${tab.key}`,
    kind: 'tab',
    label: tab.title,
    meta: 'Open tab',
    keywords: [tab.key],
    key: tab.key,
  }));
}

/**
 * What the palette lists for `query`: everything (open tabs first) when it is
 * blank, else the matches ranked by match.ts with matching open tabs first;
 * at most `cap`.
 */
export function listEntries(
  tabs: readonly QuickOpenEntry[],
  entries: readonly QuickOpenEntry[],
  query: string,
  cap: number = QUICK_OPEN_CAP
): QuickOpenEntry[] {
  if (query.trim() === '') return [...tabs, ...entries].slice(0, cap);
  return [...rankEntries(tabs, query), ...rankEntries(entries, query)].slice(0, cap);
}

/** Every entry the palette can list, in its unfiltered order. */
export function quickOpenEntries(sources: QuickOpenSources): QuickOpenEntry[] {
  const entries: QuickOpenEntry[] = [];
  const served = new Set(sources.tools.filter((tool) => toolSpec(tool) !== undefined));
  const collections = sources.collections ?? [];
  for (const collection of collections) {
    entries.push({
      id: `collection:${collection.ref}`,
      kind: 'collection',
      label: collection.name,
      meta: collection.source === 'facility' ? 'Facility collection' : 'Personal collection',
      collection,
    });
  }
  for (const collection of collections) {
    collection.members.forEach((member, index) => {
      if ('screen' in member || member.name === undefined || !served.has(member.tool)) return;
      entries.push({
        id: `member:${collection.ref}:${index}`,
        kind: 'member',
        label: member.name,
        meta: collection.name,
        member,
        collection,
      });
    });
  }
  for (const tool of served) {
    entries.push({
      id: `tool:${tool}`,
      kind: 'tool',
      label: toolSpec(tool)!.treeLabel,
      meta: 'Tool',
      tool,
    });
  }
  for (const view of sources.views ?? []) {
    if (!served.has(view.kind)) continue;
    entries.push({
      id: `view:${view.kind}:${view.id}`,
      kind: 'view',
      label: view.name,
      meta: `${toolLabel(view.kind)} view`,
      view,
    });
  }
  for (const screen of sources.screens ?? []) {
    if (!searchable(screen, { showSubScreens: sources.showSubScreens })) continue;
    entries.push({
      id: `screen:${screen.category}/${screen.id}`,
      kind: 'screen',
      label: screen.title || screen.id,
      meta: screen.id,
      keywords: [screen.id, `${screen.category}/${screen.id}`],
      screen,
    });
  }
  return entries;
}

/** A post-open focus waiting for the active tab: where it started, the tab named, the opener. */
interface PendingFocus {
  from: string | null;
  key?: string;
  back: HTMLElement | null;
}

/** Runs `callback` on the next paint (a timer where there is no rAF). */
function nextPaint(callback: () => void): void {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(callback);
  else setTimeout(callback, 0);
}

// --- the open action ---------------------------------------------------------

type Opener = (opener: Element | null) => void;
let mounted: Opener | null = null;

/**
 * Opens the mounted palette. `opener` is where Esc returns focus; an iframe
 * (or no argument while focus is inside one) sends it to the tree search.
 * False when no palette is mounted.
 */
export function openQuickOpen(opener?: Element | null): boolean {
  if (!mounted) return false;
  mounted(opener === undefined ? document.activeElement : opener);
  return true;
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

// --- the component -----------------------------------------------------------

export interface QuickOpenProps {
  screens: readonly ManifestScreen[] | null;
  tools: readonly string[];
  views?: readonly SavedView[];
  /** The collections hook; with `enabled` false its entries are absent. */
  collections?: Pick<CollectionsApi, 'enabled' | 'collections' | 'openMember' | 'openAll'>;
  /** Opens a screen tab (used when the collections feature is off). */
  onOpen: (key: string, mode: OpenMode) => void;
  /** Opens or focuses a tool (feature off). */
  onOpenTool?: (tool: string) => void;
  /** Opens a new instance of a tool (feature off). */
  onNewTool?: (tool: string) => void;
  onOpenView?: (view: SavedView, newTab: boolean) => void;
  /** Overrides the remembered sub-screen toggle (read when the dialog opens). */
  showSubScreens?: boolean;
  /** ⌘ (macOS) or Ctrl as the primary modifier. */
  mac?: boolean;
  /** The tree search's element id. */
  searchId?: string;
  /** The open tabs, listed first as "Switch to tab". */
  tabs?: readonly TabStripTab[];
  /** The focused tile's tab; the post-open focus waits for it to change. */
  activeKey?: string | null;
  /** Focuses an open tab (a "Switch to tab" entry). */
  onFocusTab?: (key: string) => void;
  /**
   * Renders the "Quick open (⌘K)" button (default). False keeps the primary+K
   * binding, openQuickOpen() and the dialog, without the button (the one-row
   * compactSidebar header has no Quick open button).
   */
  trigger?: boolean;
}

const NO_TABS: readonly TabStripTab[] = [];

export function QuickOpen({
  screens,
  tools,
  views,
  collections,
  onOpen,
  onOpenTool,
  onNewTool,
  onOpenView,
  showSubScreens,
  mac = isMac,
  searchId = TREE_SEARCH_ID,
  tabs = NO_TABS,
  activeKey = null,
  onFocusTab,
  trigger = true,
}: QuickOpenProps) {
  const theme = useContext(EmbedThemeContext);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [subScreens, setSubScreens] = useState(false);
  const [target, setTarget] = useState<Element | null>(null);
  const openerRef = useRef<Element | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const baseId = useId();
  const listId = `${baseId}-list`;
  const optionId = (entry: QuickOpenEntry) => `${baseId}-${encodeURIComponent(entry.id)}`;

  const anchorRef = theme.anchorRef;
  const show = useCallback(
    (opener: Element | null) => {
      openerRef.current = opener;
      setTarget(anchorRef.current ?? document.body);
      setSubScreens(showSubScreens ?? getShowSubScreens());
      setQuery('');
      setActive(0);
      setOpen(true);
    },
    [anchorRef, showSubScreens]
  );

  // The exported action reaches the mounted palette (last mounted wins).
  useEffect(() => {
    mounted = show;
    return () => {
      if (mounted === show) mounted = null;
    };
  }, [show]);

  // primary+K anywhere in this document, except a form field other than the
  // tree search.
  const bindingRef = useRef({ mac, searchId });
  useEffect(() => {
    bindingRef.current = { mac, searchId };
  });
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const binding = bindingRef.current;
      if (event.defaultPrevented || primaryShortcutKey(event, binding.mac) !== 'k') return;
      const from = event.target;
      if (isEditable(from) && !(from instanceof HTMLElement && from.id === binding.searchId)) {
        return;
      }
      event.preventDefault();
      mounted?.(document.activeElement);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  const enabled = collections?.enabled === true;
  const entries = useMemo(
    () =>
      open
        ? quickOpenEntries({
            screens,
            tools,
            views,
            collections: enabled ? collections!.collections : undefined,
            showSubScreens: subScreens,
          })
        : [],
    [open, screens, tools, views, enabled, collections, subScreens]
  );
  const tabList = useMemo(() => (open ? tabEntries(tabs) : []), [open, tabs]);
  const listed = useMemo(() => listEntries(tabList, entries, query), [tabList, entries, query]);
  const current = listed.length > 0 ? listed[Math.min(active, listed.length - 1)] : undefined;

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Keep the active option in view.
  useEffect(() => {
    if (!open || !current) return;
    const element = document.getElementById(optionId(current));
    element?.scrollIntoView?.({ block: 'nearest' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, current]);

  /** Closes the dialog; returns where focus goes back to (the opener, else the tree search). */
  const dismiss = useCallback((): HTMLElement | null => {
    setOpen(false);
    const opener = openerRef.current;
    openerRef.current = null;
    const fromFrame = opener instanceof HTMLIFrameElement;
    return !fromFrame &&
      opener instanceof HTMLElement &&
      opener.isConnected &&
      opener !== document.body
      ? opener
      : document.getElementById(searchId);
  }, [searchId]);

  const close = useCallback(() => {
    const back = dismiss();
    // After the dialog unmounts, so its input does not take focus back.
    setTimeout(() => back?.focus(), 0);
  }, [dismiss]);

  // The post-open focus: set by run(), landed in the opened tile once
  // the active tab changes, or (when it does not) in the tab the entry named,
  // else the active tile; the opener when that tile is not shown.
  const pendingFocus = useRef<PendingFocus | null>(null);
  const activeRef = useRef(activeKey);
  useEffect(() => {
    activeRef.current = activeKey;
  });
  const land = useCallback((key: string | null) => {
    const pending = pendingFocus.current;
    if (!pending) return;
    pendingFocus.current = null;
    nextPaint(() => {
      if (key === null || !focusTilePanel(key)) pending.back?.focus();
    });
  }, []);
  useEffect(() => {
    const pending = pendingFocus.current;
    if (pending && activeKey !== pending.from) land(activeKey);
  }, [activeKey, land]);

  const run = (entry: QuickOpenEntry, newTab: boolean) => {
    const live = enabled ? collections! : null;
    // A collection opens many tabs and a saved view keeps focus where it is:
    // neither has a post-open focus.
    const pending: PendingFocus | null =
      entry.kind === 'collection' || entry.kind === 'view'
        ? null
        : { from: activeKey, key: entry.kind === 'tab' ? entry.key : undefined, back: null };
    pendingFocus.current = pending;
    switch (entry.kind) {
      case 'tab':
        onFocusTab?.(entry.key);
        break;
      case 'collection':
        live?.openAll(entry.collection);
        break;
      case 'member':
        live?.openMember(entry.member, newTab ? { newTab: true } : {});
        break;
      case 'view':
        onOpenView?.(entry.view, newTab);
        break;
      case 'tool': {
        const member: Member = { tool: entry.tool };
        if (live) live.openMember(member, newTab ? { newTab: true } : {});
        else if (newTab) onNewTool?.(entry.tool);
        else onOpenTool?.(entry.tool);
        break;
      }
      case 'screen': {
        const { category, id } = entry.screen;
        if (live) live.openMember({ screen: `${category}/${id}` }, newTab ? { newTab: true } : {});
        else onOpen(tabKey(category, id), newTab ? 'append' : 'replace');
        break;
      }
    }
    if (!pending) {
      close();
      return;
    }
    pending.back = dismiss();
    // The active tab had not changed once the dispatch settled: focus the tab
    // the entry named, else the active tile.
    setTimeout(() => {
      if (pendingFocus.current === pending) land(pending.key ?? activeRef.current);
    }, 0);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    const count = listed.length;
    const index = Math.min(active, Math.max(count - 1, 0));
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        if (count > 0) setActive((index + 1) % count);
        break;
      case 'ArrowUp':
        event.preventDefault();
        if (count > 0) setActive((index - 1 + count) % count);
        break;
      case 'Home':
        event.preventDefault();
        setActive(0);
        break;
      case 'End':
        event.preventDefault();
        setActive(Math.max(count - 1, 0));
        break;
      case 'Enter':
        event.preventDefault();
        if (current) run(current, event.shiftKey || openModifier(event, mac));
        break;
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        close();
        break;
    }
  };

  const onBackdrop = (event: ReactMouseEvent) => {
    if (event.target === event.currentTarget) close();
  };

  const label = `Quick open (${formatShortcut('k', mac)})`;

  return (
    <>
      {trigger && (
        <button
          type="button"
          className="canopy-btn quick-open__trigger"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={(event) => show(event.currentTarget)}
        >
          {label}
        </button>
      )}
      {open &&
        target &&
        createPortal(
          <div className="quick-open__backdrop" onMouseDown={onBackdrop}>
            <div className="quick-open" role="dialog" aria-modal="true" aria-label="Quick open">
              <input
                ref={inputRef}
                className="quick-open__input"
                type="text"
                role="combobox"
                aria-label="Quick open"
                aria-expanded="true"
                aria-controls={listId}
                aria-autocomplete="list"
                aria-activedescendant={current ? optionId(current) : undefined}
                autoComplete="off"
                spellCheck={false}
                placeholder="Open a screen, tool, view or collection"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setActive(0);
                }}
                onKeyDown={onKeyDown}
              />
              <ul id={listId} className="quick-open__list" role="listbox" aria-label="Matches">
                {listed.map((entry, index) => {
                  const selected = entry === current;
                  return (
                    <li
                      key={entry.id}
                      id={optionId(entry)}
                      role="option"
                      aria-selected={selected}
                      data-kind={entry.kind}
                      className={`canopy-row quick-open__option${selected ? ' quick-open__option--active' : ''}`}
                      onMouseMove={() => {
                        if (index !== active) setActive(index);
                      }}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={(event) => run(entry, event.shiftKey || openModifier(event, mac))}
                    >
                      <span className="canopy-row__label">
                        {entry.kind === 'tab' ? `${SWITCH_TO_TAB}${entry.label}` : entry.label}
                      </span>
                      <span className="canopy-row__meta">{entry.meta}</span>
                    </li>
                  );
                })}
              </ul>
              {listed.length === 0 && <p className="quick-open__empty">No matches</p>}
            </div>
          </div>,
          target
        )}
    </>
  );
}
