// The workspace's Browse tree: one NavTree whose top-level branches are, in
// order, Pinned, Recent, each shown collection (list order, members in array
// order), Tools and All screens. Each branch is omitted when empty; their rows
// carry the host contract's `.canopy-section-heading`.
//
//   All screens  the manifest grouped by category and, within a category,
//                nested by the id's `/` segments (`bts/foo` sits in folder
//                `bts`). The `drafts` category, where canopy_mcp serves every
//                screen, is not a node of its own: its folders and screens sit
//                directly under the branch. Sub-screens hide behind the
//                remembered toggle (screenList.ts), which filters this branch
//                only; non-ir entries are disabled leaves; `@`-categories
//                (internal stores) are dropped with one console warning. The
//                branch starts expanded and stays as the operator left it: a
//                manual toggle holds for the session (ticks and unticks keep
//                it), never stored; a search opens it while the query lasts.
//   Tools        one entry per configured tool, in registry order, with that
//                tool's saved views beneath it, and an "Other views" group of
//                the views whose tool is not served here (unknown kinds
//                included): listed disabled ("<label> is not available here"),
//                never opened, Delete kept. A tool entry opens or focuses the
//                tool, its '+' — and its menu's "New <label> tab" — opens a
//                blank instance ('+' is disabled at the instance cap). A saved
//                view's menu offers Open, Open in new tab, Revert to saved (when
//                its instance has drifted from it) and Delete.
//   Pinned,      collection members (useCollections.ts): a member renders
//   Recent,      plain while the manifest is pending, disabled with its reason
//   collections  when it does not resolve here. A collection row runs Open all;
//                its menu offers Open all, Untick and, on a personal one,
//                Rename (an inline field, CollectionMenu.tsx) and Delete.
//                Recent's heading menu offers Clear recent and each Recent
//                row's menu Remove (Recent is history).
//
// Editing (personal collections only; facility ones expose none of
// it): a member row has a × (and "Remove from collection" on its menu), Move
// up / Move down on its menu and Alt+Up / Alt+Down while focused, and drags
// onto another row of the same collection to take its place: the drag writes
// its own REORDER_TYPE beside the dock payload, and only that collection's
// rows accept it. Delete and remove act at once with an Undo toast; every
// gesture is one conditional PUT (or DELETE) through useCollectionEdits. The
// collection is held (holdCollection) while its rename field is open or one of
// its members is dragged, so a poll answer meanwhile changes nothing on screen.
//
// Row rules: a member row (screens and tools included) opens through
// the collections' `openMember` when the feature is on, else through
// `onOpen` / `onOpenTool`: click or Enter replaces, Shift (click or Enter) or
// "Open in new tab" appends. Pin and Unpin are on every member row's menu (Unpin
// also on an unresolved one); a pinned row shows a star, and a member row
// without a trailing action shows a dim Pin star, full on hover or focus. Saved
// views and collections have no Pin. Pinned always renders: empty, it holds the
// inert row "Pin a screen with ☆" (no action, not disabled) — except with the
// compactSidebar host capability, where an empty Pinned is omitted. Under the
// one-row sidebar header its search field and ⋯ replace the controls row
// (SidebarQueryContext).
//
// Node ids are `<group>:<key>`: the group is `pinned`, `recent`, a collection
// ref, `tools` or `screens`, the key a member key (folders and views keep
// `folder:` / `view:` ids). `aria-selected` marks the active tab's occurrence
// in the group the user last activated from, if visible, else its first
// visible occurrence (browseSelection). With `onDragStart`, every openable row
// is a drag source for the dock: a member row drags its member, a view row
// `{kind: 'view', id}`; the set of member keys the tree renders goes out
// through `onRenderedKeys` (the drop trust rule).
//
// Search is the omnibox matcher (match.ts: word prefixes, case-
// insensitive) and filters rows in every branch: a member row of Pinned,
// Recent or a collection by its label, with its screen id (or tool label) as
// a keyword; an All screens row by title, with its id as a keyword, among the
// searchable screens (match.ts: ir only, sub-screens per the toggle); a tool
// entry by its label, a saved view by its name. A collection whose name
// matches keeps all its members. A branch left without rows is omitted (the
// empty Pinned too) and every remaining branch and folder opens while the
// query lasts. With no row left anywhere the tree reads "No matches — try
// Quick open (⌘K)", whose button opens Quick open. Titles are rendered as
// text. The menu is rendered into the embed layout's root element
// (EmbedThemeContext), where a host stylesheet reaches it; outside an embed
// layout it keeps Carbon's default, document.body.
//
// Compact sections (the compactSidebar host capability): the order is Pinned (only when non-empty), the ticked
// collections, Tools, Screens (All screens renamed) and Recent last. Recent
// starts collapsed, its opening remembered as RECENT_EXPANDED_MARKER in the
// collapsed set, shows its count after the label and keeps Clear recent on
// its heading menu. Screens folds single-child folder chains into breadcrumb
// rows (treeCompaction.ts) after the Show sub-screens filter. With
// collections on, no query, and Pinned, Recent and the ticked collections all
// empty, the footer hint "☆ on any row pins it here · ⌘K jumps to any screen
// or tool" closes the tree (the firstOpenHint capability). Sections follow
// content and the query only, never hover or timing. Without the capabilities
// the tree keeps the standard order, labels and folders.
//
// One browser key persists the collapsed branches and folders (dock
// scheme, per user); All screens' own state is never stored.

import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import {
  Add,
  Bookmark,
  ChartLineData,
  Close,
  Document,
  Folder as FolderIcon,
  FolderOpen,
  Star,
  StarFilled,
  Time,
} from '@carbon/icons-react';
import { Checkbox, Menu, MenuItem, Modal, Search } from '@carbon/react';
import type { ManifestScreen } from '../api.js';
import { EmbedThemeContext } from '../pages/EmbedPage.js';
import {
  browserStorage,
  isSubScreen,
  setShowSubScreens,
  useShowSubScreens,
} from '../screenList.js';
import { storageKey } from '../storageScope.js';
import {
  CODE_SCREEN,
  NOT_IN_LIBRARY,
  collectionSuffix,
  collectionSummary,
  memberKey,
  memberLabel,
  toolUnavailable,
} from './collections.js';
import type { Member, MemberKey } from './collections.js';
import { CollectionBadge } from './CollectionBadge.js';
import {
  CollectionRenameField,
  MOVE_DOWN_LABEL,
  MOVE_UP_LABEL,
  REMOVE_MEMBER_LABEL,
  collectionEditItems,
  isEditable,
  rawIndexOf,
  useCollectionEdits,
} from './CollectionMenu.js';
import type { BrowserDrag } from './dock/useDockBridge.js';
import { NavTree } from './NavTree.js';
import type { NavActivation, NavNode } from './NavTree.js';
import type { SavedView } from './savedViews.js';
import { instanceShowsMember, screenMemberTabKey, tabKey } from './tabs.js';
import type { OpenMode, TabsState } from './tabs.js';
import { MAX_TOOL_INSTANCES, toolKey, toolLabel, toolOf } from './tools.js';
import { matchEntry, searchable } from './match.js';
import { openQuickOpen } from './QuickOpen.js';
import { SidebarQueryContext } from './WorkspaceSidebar.js';
import { useHostCapabilities } from './host/hostCapabilities.js';
import { formatShortcut, isMac } from '../screenActions/shortcuts.js';
import { compactChains } from './treeCompaction.js';
import type { Collection, CollectionsApi } from './useCollections.js';
import './ScreenTree.css';

/** What the Browse tree uses of the collections hook. */
export type BrowseCollections = Pick<
  CollectionsApi,
  | 'enabled'
  | 'shown'
  | 'state'
  | 'recent'
  | 'pinnedKeys'
  | 'openMember'
  | 'openAll'
  | 'pin'
  | 'unpin'
  | 'untick'
  | 'remove'
  | 'setRecentHover'
> &
  Partial<
    Pick<
      CollectionsApi,
      'recentRemove' | 'recentClear' | 'edit' | 'deleteCollection' | 'holdCollection'
    >
  >;

/** The dataTransfer type of a member drag that reorders its collection. */
export const REORDER_TYPE = 'application/x-canopy-collection-member';

export interface ScreenTreeProps {
  /** The manifest's screens, unfiltered; null before the first manifest. */
  screens: readonly ManifestScreen[] | null;
  /** The configured tools, in registry order; adds the Tools branch. */
  tools?: readonly ToolEntry[];
  /** Open `key` (a screen) in the active tab ('replace') or a new one ('append'). */
  onOpen: (key: string, mode: OpenMode) => void;
  /** A tool entry was activated: focus or open the tool. */
  onOpenTool?: (tool: string) => void;
  /** '+' or "New <label> tab": a new blank instance of the tool. */
  onNewTool?: (tool: string) => void;
  /** The active tab's key, highlighted in the tree. */
  activeKey?: string | null;
  /** The tabs state: which member a tool instance shows (selection). */
  tabs?: TabsState;
  /** Saved views of every kind, listed under their tool. */
  views?: readonly SavedView[];
  /** The saved view the active tool instance was last opened with, highlighted. */
  activeViewId?: string | null;
  /** Open a saved view in its tool (in a new instance when `newTab`). */
  onOpenView?: (view: SavedView, newTab: boolean) => void;
  /** Views whose instance has drifted from them: "Revert to saved" is offered. */
  revertable?: ReadonlySet<string>;
  /** Reload a saved view into the instance showing it. */
  onRevertView?: (view: SavedView) => void;
  /** Delete a saved view (the tree asks for confirmation first). */
  onDeleteView?: (view: SavedView) => void;
  /** A row's `dragstart`: write the transfer for `drag` (the dock takes the drop). */
  onDragStart?: (drag: BrowserDrag, dataTransfer: DataTransfer | null) => void;
  /** The collections hook; absent or not enabled: no Pinned, Recent, collections or Pin. */
  collections?: BrowseCollections;
  /** The member keys the tree renders, whenever that set changes (the drop ctx). */
  onRenderedKeys?: (keys: ReadonlySet<MemberKey>) => void;
  /** Shows the workspace's inline notice (an edit's outcome outside a toast region). */
  onNotice?: (text: string) => void;
}

/** A configured tool as the tree lists it. */
export interface ToolEntry {
  /** tools.ts id. */
  id: string;
  /** Its label (menu wording). */
  label: string;
  /** Its entry's label in the Tools branch. */
  treeLabel: string;
  /** True at MAX_TOOL_INSTANCES open instances: '+' is disabled. */
  full?: boolean;
}

/** The category whose children are the All screens branch's top level. */
export const FLATTENED_CATEGORY = 'drafts';

/** The Tools branch's group of views no tool here can open. */
export const OTHER_VIEWS_LABEL = 'Other views';

/** Labels of the fixed top-level branches. */
export const PINNED_LABEL = 'Pinned';
/** The empty Pinned branch's one inert row (no member, no action). */
export const PINNED_PLACEHOLDER = 'Pin a screen with \u2606';
export const PINNED_PLACEHOLDER_ID = 'pinned-placeholder';
export const RECENT_LABEL = 'Recent';
export const TOOLS_LABEL = 'Tools';
export const ALL_SCREENS_LABEL = 'All screens';
/** The screens branch's label in the compact sections. */
export const SCREENS_LABEL = 'Screens';

/**
 * Stored in the collapsed set when the compact RECENT has been opened: there
 * RECENT starts collapsed, so its remembered state is the inverse of
 * every other branch's and gets its own id.
 */
export const RECENT_EXPANDED_MARKER = 'recent:expanded';

/** The tree's first-open footer hint (the firstOpenHint capability). */
export function sidebarHint(mac: boolean = isMac): string {
  return `\u2606 on any row pins it here \u00b7 ${formatShortcut('k', mac)} jumps to any screen or tool`;
}

/** The filter's no-match message, before the Quick open button. */
export const NO_MATCHES_PREFIX = 'No matches \u2014 try ';

/** The collapsed set's record name (a storageKey name). */
export const COLLAPSED_STORAGE_NAME = 'canopy-viewer:tree-collapsed';

/** The collapsed set's browser key on this page. */
export function collapsedStorageKey(basename?: string): string {
  return storageKey(COLLAPSED_STORAGE_NAME, basename);
}

/** Top-level branch ids. */
export const BRANCH_PINNED = 'branch:pinned';
export const BRANCH_RECENT = 'branch:recent';
export const BRANCH_TOOLS = 'branch:tools';
export const BRANCH_SCREENS = 'branch:screens';
const COLLECTION_PREFIX = 'collection:';

/** Member groups (the `<group>` of a member node id). */
export const GROUP_PINNED = 'pinned';
export const GROUP_RECENT = 'recent';
export const GROUP_TOOLS = 'tools';
export const GROUP_SCREENS = 'screens';

/** The node id of `member` in `group`. */
export function memberNodeId(group: string, key: MemberKey | string): string {
  return `${group}:${key}`;
}

/** A collection's branch id. */
export function collectionNodeId(ref: string): string {
  return COLLECTION_PREFIX + ref;
}

interface Leaf {
  key: string;
  /** '<category>/<id>'. */
  screen: string;
  title: string;
  disabled: boolean;
}

interface Folder {
  name: string;
  folders: Map<string, Folder>;
  leaves: Leaf[];
}

function emptyFolder(name: string): Folder {
  return { name, folders: new Map(), leaves: [] };
}

/** The folder `name` in `folders`, created (empty) when absent. */
function folderIn(folders: Map<string, Folder>, name: string): Folder {
  let folder = folders.get(name);
  if (!folder) {
    folder = emptyFolder(name);
    folders.set(name, folder);
  }
  return folder;
}

/** True when `q` is blank or matches `label` (or a keyword) by match.ts. */
function hit(q: string, label: string, keywords?: readonly string[]): boolean {
  return q === '' || matchEntry(q, { label, keywords }) !== null;
}

/** A member's filter keywords: its screen id (without the category) or tool label. */
function memberKeywords(member: Member): string[] {
  if ('tool' in member) return [toolLabel(member.tool), memberLabel(member)];
  const slash = member.screen.indexOf('/');
  return [slash < 0 ? member.screen : member.screen.slice(slash + 1)];
}

/** The root folder: categories (and the flattened category's content). */
function buildTree(screens: readonly ManifestScreen[]): Folder {
  const root = emptyFolder('');
  for (const entry of screens) {
    let folder =
      entry.category === FLATTENED_CATEGORY ? root : folderIn(root.folders, entry.category);
    for (const segment of entry.id.split('/').slice(0, -1)) {
      folder = folderIn(folder.folders, segment);
    }
    folder.leaves.push({
      key: tabKey(entry.category, entry.id),
      screen: `${entry.category}/${entry.id}`,
      title: entry.title,
      disabled: entry.kind !== 'ir',
    });
  }
  return root;
}

const byName = (a: string, b: string) => a.localeCompare(b);

// --- remembered expansion (browser key, guarded) ---

export function readCollapsed(basename?: string): Set<string> {
  try {
    const raw = browserStorage()?.getItem(collapsedStorageKey(basename));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : []);
  } catch {
    return new Set();
  }
}

function writeCollapsed(collapsed: ReadonlySet<string>): void {
  try {
    browserStorage()?.setItem(collapsedStorageKey(), JSON.stringify([...collapsed].sort()));
  } catch {
    // Not remembered; the in-memory state still applies.
  }
}

// --- member status ---

/** How a member row renders: plain (pending), openable, or disabled with a reason. */
export type MemberStatus =
  | { status: 'pending' }
  | { status: 'ok'; title?: string }
  | { status: 'unresolved'; reason: string };

/** A member's row status against the manifest (null: pending) and the served tools. */
export function memberStatus(
  member: Member,
  screens: readonly ManifestScreen[] | null,
  tools: readonly string[]
): MemberStatus {
  if ('tool' in member) {
    return tools.includes(member.tool)
      ? { status: 'ok' }
      : { status: 'unresolved', reason: toolUnavailable(member.tool) };
  }
  if (screens === null) return { status: 'pending' };
  const slash = member.screen.indexOf('/');
  const category = slash < 0 ? '' : member.screen.slice(0, slash);
  const id = slash < 0 ? '' : member.screen.slice(slash + 1);
  const entry =
    category === '' || category.startsWith('@')
      ? undefined
      : screens.find((s) => s.category === category && s.id === id);
  if (!entry) return { status: 'unresolved', reason: NOT_IN_LIBRARY };
  if (entry.kind !== 'ir') return { status: 'unresolved', reason: CODE_SCREEN };
  return { status: 'ok', title: entry.title };
}

// --- selection ---

/** Where a node sits: its member group (member and view rows) and member. */
export interface NodeMeta {
  group: string;
  member?: Member;
}

/**
 * The aria-selected rule: among `candidates` (the nodes showing the active
 * tab), the visible one in `lastGroup` if any, else the first visible one in
 * tree order, else null. A node is visible when every ancestor is expanded.
 */
export function browseSelection(
  nodes: readonly NavNode[],
  expanded: ReadonlySet<string>,
  candidates: ReadonlySet<string>,
  groupOf: (id: string) => string | undefined,
  lastGroup: string | null
): string | null {
  const visible: string[] = [];
  const walk = (list: readonly NavNode[]) => {
    for (const node of list) {
      if (candidates.has(node.id)) visible.push(node.id);
      if (node.children?.length && expanded.has(node.id)) walk(node.children);
    }
  };
  walk(nodes);
  if (lastGroup !== null) {
    const inGroup = visible.find((id) => groupOf(id) === lastGroup);
    if (inGroup !== undefined) return inGroup;
  }
  return visible[0] ?? null;
}

/** Every member key under `nodes` (the rendered set), from the node metadata. */
function renderedKeysOf(meta: ReadonlyMap<string, NodeMeta>): Set<MemberKey> {
  const keys = new Set<MemberKey>();
  for (const { member } of meta.values()) {
    if (member) keys.add(memberKey(member));
  }
  return keys;
}

interface MenuItemSpec {
  label: string;
  kind?: 'danger';
  run: () => void;
}

interface MenuState {
  x: number;
  y: number;
  items: MenuItemSpec[];
  /** The embed layout's root when the menu opened; null outside one. */
  target: HTMLElement | null;
}

const FOLDER_PREFIX = 'folder:';
const VIEW_PREFIX = 'view:';
const OTHER_NODE = 'tools:other';

const NO_TOOLS: readonly ToolEntry[] = [];
const NO_REVERTS: ReadonlySet<string> = new Set();
const NO_KEYS: ReadonlySet<MemberKey> = new Set();
const BRANCH_ROW = 'canopy-section-heading screen-tree__branch-row';

interface CollectionNodeHandlers {
  openAll: (collection: Collection) => void;
  untick: (ref: string) => void;
  /** Opens the inline rename field (personal, editable only). */
  rename?: (collection: Collection) => void;
  /** Deletes a personal collection at once (Undo in the toast). */
  remove?: (collection: Collection) => void;
}

/**
 * A shown collection's branch (Open all on activation, its members beneath)
 * and its menu items; the caller wires the menu.
 */
function collectionNode(
  collection: Collection,
  on: CollectionNodeHandlers,
  among?: readonly Collection[]
): { node: NavNode; items: () => MenuItemSpec[] } {
  const { ref } = collection;
  // `among` is the shown list, so two that read the same gain their id.
  const now = new Date();
  const summary = collectionSummary(collection, now, among);
  return {
    node: {
      id: collectionNodeId(ref),
      label: collection.name,
      icon: <CollectionBadge source={collection.source} />,
      // The name ellipsises alone; "· N · <when>" sits beside it as secondary
      // text and the tooltip carries the full summary and description.
      marker: (
        <span
          className="screen-tree__collection-suffix"
          style={{
            color: 'var(--canopy-text-secondary)',
            fontWeight: 'normal',
            whiteSpace: 'nowrap',
            paddingInlineStart: '0.25rem',
          }}
        >
          {`\u00b7 ${collectionSuffix(collection, now, among)}`}
        </span>
      ),
      title: collection.description ? `${summary}\n${collection.description}` : summary,
      className:
        'screen-tree__branch screen-tree__heading screen-tree__collection' +
        (collection.source === 'personal' ? ' screen-tree__collection--personal' : ''),
      rowClassName: BRANCH_ROW,
      data: { 'data-branch': 'collection', 'data-collection-ref': ref },
      onActivate: () => on.openAll(collection),
    },
    items: () => [
      { label: 'Open all', run: () => on.openAll(collection) },
      { label: 'Untick', run: () => on.untick(ref) },
      ...(on.rename && on.remove
        ? collectionEditItems(collection, { rename: on.rename, delete: on.remove })
        : []),
    ],
  };
}

export function ScreenTree({
  screens: manifest,
  tools = NO_TOOLS,
  onOpen,
  onOpenTool,
  onNewTool,
  activeKey = null,
  tabs,
  views = [],
  activeViewId = null,
  onOpenView,
  revertable = NO_REVERTS,
  onRevertView,
  onDeleteView,
  onDragStart,
  collections,
  onRenderedKeys,
  onNotice,
}: ScreenTreeProps) {
  // Under a one-row sidebar header, the header owns the search field (its
  // query arrives through context) and its ⋯ owns Show sub-screens; this tree
  // then drops its controls row. The compact sections and the first-open hint
  // are host capabilities.
  const headerQuery = useContext(SidebarQueryContext);
  const inHeader = headerQuery !== null;
  const { compactSidebar: compact, firstOpenHint } = useHostCapabilities();
  const [ownQuery, setQuery] = useState('');
  const query = headerQuery ?? ownQuery;
  const showSubScreens = useShowSubScreens();
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => readCollapsed());
  const [confirmDelete, setConfirmDelete] = useState<SavedView | null>(null);
  /** The collection whose rename field is open, as it was when it opened. */
  const [renaming, setRenaming] = useState<Collection | null>(null);
  /** The member drag that may reorder its collection: its ref and member index. */
  const reorderDrag = useRef<{ ref: string; index: number } | null>(null);
  /** All screens' manual state for this session; null = the default (expanded). */
  const [screensOpen, setScreensOpen] = useState<boolean | null>(null);
  /** The member group the user last activated a row from. */
  const [lastGroup, setLastGroup] = useState<string | null>(null);
  const warned = useRef(new Set<string>());
  const inRecent = useRef(false);
  const { anchorRef } = useContext(EmbedThemeContext);

  const live = collections?.enabled ? collections : undefined;
  const edits = useCollectionEdits(live, onNotice);
  const canEdit = (collection: Collection) =>
    !!live?.edit && !!live.deleteCollection && isEditable(collection);

  /** The rename field opens on the heading, its collection held until it closes. */
  const startRename = (collection: Collection) => {
    live?.holdCollection?.(collection.ref);
    setRenaming(collection);
  };

  /** Commits (a new name) or cancels (null) the open rename; focus returns to the heading. */
  const finishRename = (collection: Collection, name: string | null) => {
    setRenaming(null);
    live?.holdCollection?.(null);
    if (name !== null) void edits.rename(collection, name);
    document
      .getElementById(`screen-tree-${encodeURIComponent(collectionNodeId(collection.ref))}`)
      ?.focus();
  };
  const shown = live?.shown ?? [];
  const pinnedKeys = live?.pinnedKeys ?? NO_KEYS;
  const toolIds = useMemo(() => tools.map((tool) => tool.id), [tools]);

  // Called from the rows' context-menu handlers only: the anchor is read when
  // the menu opens, never during render.
  const openMenu = (x: number, y: number, items: MenuItemSpec[]) =>
    setMenu({ x, y, items, target: anchorRef.current });

  const setExpanded = (id: string, expanded: boolean) => {
    if (id === BRANCH_SCREENS) {
      setScreensOpen(expanded);
      return;
    }
    if (compact && id === BRANCH_RECENT) {
      // Compact RECENT is collapsed by default, so the stored fact is the opening.
      setCollapsed((prev) => {
        if (prev.has(RECENT_EXPANDED_MARKER) === expanded) return prev;
        const next = new Set(prev);
        if (expanded) next.add(RECENT_EXPANDED_MARKER);
        else next.delete(RECENT_EXPANDED_MARKER);
        writeCollapsed(next);
        return next;
      });
      return;
    }
    setCollapsed((prev) => {
      if (prev.has(id) !== expanded) return prev;
      const next = new Set(prev);
      if (expanded) next.delete(id);
      else next.add(id);
      writeCollapsed(next);
      return next;
    });
  };

  const [listed, dropped] = useMemo(() => {
    const internal = new Set<string>();
    const kept = (manifest ?? []).filter((entry) => {
      if (!entry.category.startsWith('@')) return true;
      internal.add(entry.category);
      return false;
    });
    return [kept, [...internal].sort()] as const;
  }, [manifest]);

  // One warning per dropped category for the life of the tree, although the
  // manifest is re-fetched every second.
  useEffect(() => {
    const fresh = dropped.filter((category) => !warned.current.has(category));
    if (fresh.length === 0) return;
    for (const category of fresh) warned.current.add(category);
    console.warn(`ScreenTree: dropping internal categories ${fresh.join(', ')}`);
  }, [dropped]);

  const subScreenCount = useMemo(
    () => listed.filter((entry) => isSubScreen(entry.id)).length,
    [listed]
  );

  const q = query.trim();
  const root = useMemo(
    () =>
      buildTree(
        listed.filter((entry) =>
          q === ''
            ? showSubScreens || !isSubScreen(entry.id)
            : searchable(entry, { showSubScreens }) && hit(q, entry.title, [entry.id])
        )
      ),
    [listed, showSubScreens, q]
  );

  const toggleSubScreens = (show: boolean) => setShowSubScreens(show);

  // --- shared row pieces ---

  const meta = new Map<string, NodeMeta>();

  const pinItems = (member: Member, pinned: boolean): MenuItemSpec[] =>
    live
      ? [
          pinned
            ? { label: 'Unpin', run: () => void live.unpin(member) }
            : { label: 'Pin', run: () => void live.pin(member) },
        ]
      : [];

  /** The star of a member row: Pin on hover/focus, or the pinned marker that unpins. */
  const starOf = (member: Member, pinned: boolean): NavNode['hoverAction'] =>
    live
      ? pinned
        ? {
            label: 'Unpin',
            icon: <StarFilled size={16} />,
            persistent: true,
            onClick: () => void live.unpin(member),
          }
        : { label: 'Pin', icon: <Star size={16} />, onClick: () => void live.pin(member) }
      : undefined;

  /** Opens a member row by the row rules. */
  const openRow = (group: string, member: Member, newTab: boolean) => {
    setLastGroup(group);
    if (live) {
      live.openMember(member, newTab ? { newTab: true } : {});
      return;
    }
    if ('screen' in member) {
      const key = screenMemberTabKey(member);
      if (key !== null) onOpen(key, newTab ? 'append' : 'replace');
    } else if (newTab) {
      onNewTool?.(member.tool);
    } else {
      onOpenTool?.(member.tool);
    }
  };

  /** A member row's label: its name, else the screen's title, else memberLabel. */
  const labelOf = (member: Member, status: MemberStatus): string =>
    member.name ??
    ('screen' in member && status.status === 'ok' && status.title
      ? status.title
      : memberLabel(member));

  /** Whether the filter keeps a member row (always, without a query). */
  const memberHit = (member: Member): boolean =>
    q === '' ||
    hit(q, labelOf(member, memberStatus(member, manifest, toolIds)), memberKeywords(member));

  /** A member row of Pinned, Recent or a collection (`edit`: a personal one's, editable). */
  const memberNode = (
    group: string,
    member: Member,
    edit?: { collection: Collection; index: number }
  ): NavNode => {
    const key = memberKey(member);
    const id = memberNodeId(group, key);
    meta.set(id, { group, member });
    const status = memberStatus(member, manifest, toolIds);
    const disabled = status.status === 'unresolved';
    const pinned = pinnedKeys.has(key);
    const label = labelOf(member, status);
    const isTool = 'tool' in member;
    const editing = edit ? editNode(edit.collection, edit.index, label) : undefined;
    const dockDrag =
      disabled || !onDragStart
        ? undefined
        : (transfer: DataTransfer | null) => onDragStart(member, transfer);
    return {
      id,
      label,
      icon: isTool ? <ChartLineData size={16} /> : <Document size={16} />,
      disabled,
      title: disabled ? `${label}: ${status.reason}` : label,
      className:
        'screen-tree__leaf screen-tree__member' +
        (isTool && member.tool === 'trace' ? ' screen-tree__trace' : '') +
        (disabled ? ' screen-tree__leaf--disabled' : '') +
        (pinned ? ' screen-tree__member--pinned' : ''),
      data: { 'data-member-key': key, 'data-group': group },
      onActivate: disabled ? undefined : ({ newTab }) => openRow(group, member, newTab),
      onMenu: (x, y) =>
        openMenu(x, y, [
          ...(disabled
            ? []
            : [{ label: 'Open in new tab', run: () => openRow(group, member, true) }]),
          ...(disabled && !pinned ? [] : pinItems(member, pinned)),
          ...(group === GROUP_RECENT && live?.recentRemove
            ? [{ label: 'Remove', run: () => void live.recentRemove?.(member) }]
            : []),
          ...(editing?.items ?? []),
        ]),
      hoverAction: disabled && !pinned ? undefined : starOf(member, pinned),
      ...(editing
        ? {
            removeAction: editing.removeAction,
            onMove: editing.onMove,
            dropZone: editing.dropZone,
            onDragEnd: editing.onDragEnd,
          }
        : {}),
      onDragStart: editing ? editing.dragStart(dockDrag) : dockDrag,
    };
  };

  /** The edit affordances of member `index` (shown as `label`) of a personal collection. */
  const editNode = (collection: Collection, index: number, label: string) => {
    const { ref } = collection;
    const last = collection.members.length - 1;
    const move = (delta: -1 | 1) => void edits.move(collection, index, index + delta);
    const removeMember = () => void edits.removeMember(collection, index, label);
    return {
      items: [
        ...(index > 0 ? [{ label: MOVE_UP_LABEL, run: () => move(-1) }] : []),
        ...(index < last ? [{ label: MOVE_DOWN_LABEL, run: () => move(1) }] : []),
        { label: REMOVE_MEMBER_LABEL, kind: 'danger' as const, run: removeMember },
      ],
      removeAction: {
        label: REMOVE_MEMBER_LABEL,
        icon: <Close size={16} />,
        onClick: removeMember,
      },
      onMove: (delta: -1 | 1) => {
        if (index + delta >= 0 && index + delta <= last) move(delta);
      },
      /** Writes the reorder payload beside the dock's and holds the collection. */
      dragStart:
        (dock: ((transfer: DataTransfer | null) => void) | undefined) =>
        (transfer: DataTransfer | null) => {
          dock?.(transfer);
          try {
            transfer?.setData(
              REORDER_TYPE,
              JSON.stringify({ ref, index: rawIndexOf(collection, index) })
            );
          } catch {
            // A transfer that refuses the type: the in-memory drag still reorders.
          }
          reorderDrag.current = { ref, index };
          live?.holdCollection?.(ref);
        },
      onDragEnd: () => {
        if (reorderDrag.current === null) return;
        reorderDrag.current = null;
        live?.holdCollection?.(null);
      },
      dropZone: {
        accepts: (transfer: DataTransfer | null) => {
          const drag = reorderDrag.current;
          if (drag === null || drag.ref !== ref || drag.index === index) return false;
          return transfer === null || Array.from(transfer.types ?? []).includes(REORDER_TYPE);
        },
        onDrop: () => {
          const drag = reorderDrag.current;
          reorderDrag.current = null;
          live?.holdCollection?.(null);
          if (drag !== null && drag.ref === ref) void edits.move(collection, drag.index, index);
        },
      },
    };
  };

  // --- All screens ---

  const screenNodes = ((): NavNode[] => {
    const leafNode = (leaf: Leaf): NavNode => {
      const member: Member = { screen: leaf.screen };
      const key = memberKey(member);
      const id = memberNodeId(GROUP_SCREENS, key);
      if (!leaf.disabled) meta.set(id, { group: GROUP_SCREENS, member });
      const pinned = pinnedKeys.has(key);
      return {
        id,
        label: leaf.title,
        icon: <Document size={16} />,
        disabled: leaf.disabled,
        title: leaf.disabled ? 'code screen — not yet viewable' : leaf.title,
        className:
          'screen-tree__leaf' +
          (leaf.disabled ? ' screen-tree__leaf--disabled' : '') +
          (pinned ? ' screen-tree__member--pinned' : ''),
        data: leaf.disabled
          ? undefined
          : { 'data-screen-key': leaf.key, 'data-member-key': key, 'data-group': GROUP_SCREENS },
        onActivate: leaf.disabled
          ? undefined
          : ({ newTab }: NavActivation) => openRow(GROUP_SCREENS, member, newTab),
        onMenu: leaf.disabled
          ? undefined
          : (x, y) =>
              openMenu(x, y, [
                { label: 'Open in new tab', run: () => openRow(GROUP_SCREENS, member, true) },
                ...pinItems(member, pinned),
              ]),
        hoverAction: leaf.disabled ? undefined : starOf(member, pinned),
        onDragStart:
          leaf.disabled || !onDragStart ? undefined : (transfer) => onDragStart(member, transfer),
      };
    };
    const children = (folder: Folder, path: string): NavNode[] => [
      ...[...folder.folders.values()]
        .sort((a, b) => byName(a.name, b.name))
        .map((child): NavNode => {
          const here = `${path}/${child.name}`;
          const open = q !== '' || !collapsed.has(FOLDER_PREFIX + here);
          return {
            id: FOLDER_PREFIX + here,
            label: child.name,
            icon: open ? <FolderOpen size={16} /> : <FolderIcon size={16} />,
            className: 'screen-tree__folder',
            children: children(child, here),
          };
        }),
      ...[...folder.leaves].sort((a, b) => byName(a.title, b.title)).map(leafNode),
    ];
    // Compact (compactSidebar): single-child folder chains fold into breadcrumb
    // rows; `root` is already filtered by Show sub-screens and the query.
    const top = children(root, '');
    return compact ? compactChains(top) : top;
  })();

  // --- Tools ---

  const viewMatches = (view: SavedView) => hit(q, view.name);
  const otherViews = views.filter((view) => !toolIds.includes(view.kind));

  const deleteItem = (view: SavedView) =>
    onDeleteView
      ? [{ label: 'Delete view…', kind: 'danger' as const, run: () => setConfirmDelete(view) }]
      : [];

  const viewNode = (view: SavedView): NavNode => {
    const id = VIEW_PREFIX + view.id;
    meta.set(id, { group: GROUP_TOOLS });
    return {
      id,
      label: view.name,
      icon: <Bookmark size={16} />,
      title: `${view.name} (saved view)`,
      className: 'screen-tree__view',
      data: { 'data-view-id': view.id, 'data-view-kind': view.kind },
      onActivate: onOpenView
        ? ({ newTab }) => {
            setLastGroup(GROUP_TOOLS);
            onOpenView(view, newTab);
          }
        : undefined,
      onDragStart:
        onOpenView && onDragStart
          ? (transfer) => onDragStart({ kind: 'view', id: view.id }, transfer)
          : undefined,
      onMenu: (x, y) =>
        openMenu(x, y, [
          ...(onOpenView
            ? [
                { label: 'Open', run: () => onOpenView(view, false) },
                { label: 'Open in new tab', run: () => onOpenView(view, true) },
              ]
            : []),
          ...(onRevertView && revertable.has(view.id)
            ? [{ label: 'Revert to saved', run: () => onRevertView(view) }]
            : []),
          ...deleteItem(view),
        ]),
    };
  };

  const toolNodes: NavNode[] = [];
  for (const tool of tools) {
    const shownViews = views.filter((view) => view.kind === tool.id && viewMatches(view));
    if (!hit(q, tool.treeLabel, [tool.label]) && shownViews.length === 0) continue;
    const newTab = `New ${tool.label} tab`;
    const member: Member = { tool: tool.id };
    const key = memberKey(member);
    const id = memberNodeId(GROUP_TOOLS, key);
    meta.set(id, { group: GROUP_TOOLS, member });
    const pinned = pinnedKeys.has(key);
    const action = onNewTool
      ? {
          label: newTab,
          title: tool.full ? `At most ${MAX_TOOL_INSTANCES} ${tool.label} tabs` : newTab,
          icon: <Add size={16} />,
          disabled: tool.full,
          onClick: () => onNewTool(tool.id),
        }
      : undefined;
    const menuItems = (): MenuItemSpec[] => [
      ...(onNewTool && !tool.full ? [{ label: newTab, run: () => onNewTool(tool.id) }] : []),
      ...pinItems(member, pinned),
    ];
    toolNodes.push({
      id,
      label: tool.treeLabel,
      icon: <ChartLineData size={16} />,
      className:
        'screen-tree__leaf screen-tree__tool' +
        (tool.id === 'trace' ? ' screen-tree__trace' : '') +
        (pinned ? ' screen-tree__member--pinned' : ''),
      data: {
        'data-screen-key': toolKey(tool.id),
        'data-tool': tool.id,
        'data-member-key': key,
        'data-group': GROUP_TOOLS,
      },
      onActivate:
        onOpenTool || live
          ? ({ newTab }) => openRow(GROUP_TOOLS, member, newTab && (!!live || !!onNewTool))
          : undefined,
      onDragStart:
        (onOpenTool || live) && onDragStart
          ? (transfer) => onDragStart(member, transfer)
          : undefined,
      onMenu: onNewTool || live ? (x, y) => openMenu(x, y, menuItems()) : undefined,
      action,
      marker: action && pinned ? <StarFilled size={16} /> : undefined,
      hoverAction: action ? undefined : starOf(member, pinned),
      children: shownViews.map(viewNode),
    });
  }
  const shownOther = otherViews.filter(viewMatches);
  if (shownOther.length > 0) {
    toolNodes.push({
      id: OTHER_NODE,
      label: OTHER_VIEWS_LABEL,
      icon: <FolderIcon size={16} />,
      className: 'screen-tree__folder',
      children: shownOther.map((view): NavNode => {
        meta.set(VIEW_PREFIX + view.id, { group: GROUP_TOOLS });
        return {
          id: VIEW_PREFIX + view.id,
          label: view.name,
          icon: <Bookmark size={16} />,
          disabled: true,
          title: `${toolLabel(view.kind)} is not available here`,
          className: 'screen-tree__view screen-tree__view--unavailable',
          data: { 'data-view-id': view.id, 'data-view-kind': view.kind },
          onMenu:
            onDeleteView === undefined ? undefined : (x, y) => openMenu(x, y, deleteItem(view)),
        };
      }),
    });
  }

  // --- selection branches (rows filtered while searching) ---

  const selectionNodes: NavNode[] = [];
  if (live) {
    const pinnedMembers = live.state.pinned.filter(memberHit);
    const recentMembers = live.recent.filter(memberHit);
    // Pinned always renders unless a query leaves it empty; empty, it holds
    // one inert placeholder leaf (a NavTree node is a branch only with
    // children). In the compact sections an empty Pinned is omitted.
    if (pinnedMembers.length > 0 || (q === '' && !compact)) {
      selectionNodes.push({
        id: BRANCH_PINNED,
        label: PINNED_LABEL,
        icon: <StarFilled size={16} />,
        className: 'screen-tree__branch screen-tree__heading',
        rowClassName: BRANCH_ROW,
        data: { 'data-branch': 'pinned' },
        children:
          pinnedMembers.length > 0
            ? pinnedMembers.map((m) => memberNode(GROUP_PINNED, m))
            : [
                {
                  id: PINNED_PLACEHOLDER_ID,
                  label: PINNED_PLACEHOLDER,
                  className: 'screen-tree__placeholder',
                },
              ],
      });
    }
    if (recentMembers.length > 0) {
      // openMenu reads the embed anchor only from the context-menu event.
      // eslint-disable-next-line react-hooks/refs -- never called during render
      selectionNodes.push({
        id: BRANCH_RECENT,
        label: RECENT_LABEL,
        icon: <Time size={16} />,
        className: 'screen-tree__branch screen-tree__heading',
        rowClassName: BRANCH_ROW,
        data: { 'data-branch': 'recent' },
        ...(compact ? { count: recentMembers.length } : {}),
        children: recentMembers.map((m) => memberNode(GROUP_RECENT, m)),
        onMenu: live.recentClear
          ? (x, y) =>
              openMenu(x, y, [{ label: 'Clear recent', run: () => void live.recentClear?.() }])
          : undefined,
      });
    }
    for (const collection of shown) {
      // A collection whose name matches keeps every member.
      const members = hit(q, collection.name)
        ? collection.members
        : collection.members.filter(memberHit);
      if (members.length === 0) continue;
      const editable = canEdit(collection);
      const { node, items } = collectionNode(
        collection,
        {
          openAll: live.openAll,
          untick: (ref) => void live.untick(ref),
          ...(editable
            ? { rename: startRename, remove: (c: Collection) => void edits.remove(c) }
            : {}),
        },
        shown
      );
      const group = node.id.slice(COLLECTION_PREFIX.length);
      const open = renaming !== null && renaming.ref === collection.ref ? renaming : null;
      // openMenu reads the embed anchor only from the context-menu event.
      // eslint-disable-next-line react-hooks/refs -- never called during render
      selectionNodes.push({
        ...node,
        ...(open
          ? {
              editor: (
                <CollectionRenameField
                  name={open.name}
                  onCommit={(name) => finishRename(open, name)}
                  onCancel={() => finishRename(open, null)}
                />
              ),
            }
          : {}),
        children: members.map((m) =>
          memberNode(
            group,
            m,
            editable ? { collection, index: collection.members.indexOf(m) } : undefined
          )
        ),
        onMenu: (x, y) => openMenu(x, y, items()),
      });
    }
  }

  // Standard: Pinned, Recent, collections, Tools, All screens. Compact:
  // Pinned, collections, Tools, Screens, then Recent last.
  const recentNode = compact ? selectionNodes.find((n) => n.id === BRANCH_RECENT) : undefined;
  const nodes: NavNode[] = selectionNodes.filter((n) => n !== recentNode);

  if (toolNodes.length > 0) {
    nodes.push({
      id: BRANCH_TOOLS,
      label: TOOLS_LABEL,
      className: 'screen-tree__branch screen-tree__heading',
      rowClassName: BRANCH_ROW,
      data: { 'data-branch': 'tools' },
      children: toolNodes,
    });
  }
  if (screenNodes.length > 0) {
    nodes.push({
      id: BRANCH_SCREENS,
      label: compact ? SCREENS_LABEL : ALL_SCREENS_LABEL,
      className: 'screen-tree__branch screen-tree__heading screen-tree__screens',
      rowClassName: BRANCH_ROW,
      data: { 'data-branch': 'screens' },
      children: screenNodes,
    });
  }

  if (recentNode) nodes.push(recentNode);

  // The first-open hint (firstOpenHint), with collections (the ☆ is
  // theirs), no query, and nothing pinned or recent. A shown collection —
  // a deployment's facility collection is ticked by default — does not hide
  // it: the ☆ and ⌘K are still news on first open. Content only — never
  // hover or timing.
  const showHint =
    firstOpenHint &&
    live !== undefined &&
    q === '' &&
    live.state.pinned.length === 0 &&
    live.recent.length === 0;

  const screensExpanded = q !== '' || (screensOpen ?? true);
  const expandedIds = new Set<string>();
  const walkExpanded = (list: readonly NavNode[]) => {
    for (const node of list) {
      if (!node.children?.length) continue;
      const open =
        node.id === BRANCH_SCREENS
          ? screensExpanded
          : q !== '' ||
            (compact && node.id === BRANCH_RECENT
              ? collapsed.has(RECENT_EXPANDED_MARKER)
              : !collapsed.has(node.id));
      if (open) expandedIds.add(node.id);
      walkExpanded(node.children);
    }
  };
  walkExpanded(nodes);

  // --- aria-selected ---

  const candidates = new Set<string>();
  const activeTool = toolOf(activeKey);
  let viewSelected: string | null = null;
  if (activeKey !== null) {
    for (const [id, { member }] of meta) {
      if (!member) continue;
      if (activeTool !== undefined) {
        if (!('tool' in member) || member.tool !== activeTool) continue;
        const toolRow = id === memberNodeId(GROUP_TOOLS, memberKey({ tool: activeTool }));
        if (toolRow || (tabs && instanceShowsMember(tabs, activeKey, memberKey(member)))) {
          candidates.add(id);
        }
      } else if ('screen' in member && screenMemberTabKey(member) === activeKey) {
        candidates.add(id);
      }
    }
    if (activeTool !== undefined && activeViewId !== null) {
      const viewId = VIEW_PREFIX + activeViewId;
      const owner = toolNodes.find((n) => n.id === memberNodeId(GROUP_TOOLS, `tool:${activeTool}`));
      if (owner?.children?.some((n) => n.id === viewId) && expandedIds.has(owner.id)) {
        if (expandedIds.has(BRANCH_TOOLS)) viewSelected = viewId;
      }
    }
  }
  const selectedId =
    viewSelected ??
    browseSelection(nodes, expandedIds, candidates, (id) => meta.get(id)?.group, lastGroup);

  // --- rendered member keys (drop trust) ---

  const renderedId = [...renderedKeysOf(meta)].sort().join('\n');
  const renderedKeys = useMemo(
    () => new Set(renderedId === '' ? [] : (renderedId.split('\n') as MemberKey[])),
    [renderedId]
  );
  // Reported when the set's content changes, not on every render.
  useEffect(() => onRenderedKeys?.(renderedKeys), [renderedKeys, onRenderedKeys]);

  // --- Recent hover (its re-sort waits until the pointer leaves) ---

  const setRecentHover = (inside: boolean) => {
    if (inRecent.current === inside) return;
    inRecent.current = inside;
    live?.setRecentHover(inside);
  };
  const onPointerOver = (event: ReactPointerEvent) => {
    const target = event.target as Element | null;
    setRecentHover(!!target?.closest?.('[data-branch="recent"]'));
  };

  // Without a query: an empty library. With one: no row left in any branch.
  const empty = q === '' ? screenNodes.length === 0 : nodes.length === 0;
  const quickOpenLabel = `Quick open (${formatShortcut('k')})`;

  return (
    <nav className="screen-tree" aria-label="Screens">
      {!inHeader && (
        <div className="screen-tree__controls">
          <Search
            id="screen-tree-search"
            data-testid="screen-tree-search"
            size="sm"
            labelText="Search screens"
            placeholder="Filter by title or id"
            value={query}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setQuery(e.target.value)}
          />
          {subScreenCount > 0 && (
            <Checkbox
              id="screen-tree-show-sub-screens"
              labelText={`Show sub-screens (${subScreenCount})`}
              checked={showSubScreens}
              onChange={(_event, { checked }) => toggleSubScreens(checked)}
            />
          )}
        </div>
      )}
      <div
        className="screen-tree__body"
        onPointerOver={live ? onPointerOver : undefined}
        onPointerLeave={live ? () => setRecentHover(false) : undefined}
      >
        {nodes.length > 0 && (
          <NavTree
            label="Browse"
            nodes={nodes}
            expanded={expandedIds}
            onExpandedChange={setExpanded}
            selectedId={selectedId}
            idPrefix="screen-tree-"
          />
        )}
        {empty && (
          <p className="screen-tree__empty">
            {q === '' ? (
              'No screens to show.'
            ) : (
              <>
                {NO_MATCHES_PREFIX}
                <button
                  type="button"
                  className="screen-tree__empty-action"
                  onClick={(event) => openQuickOpen(event.currentTarget)}
                >
                  {quickOpenLabel}
                </button>
              </>
            )}
          </p>
        )}
        {showHint && <p className="screen-tree__hint">{sidebarHint()}</p>}
      </div>
      {menu && menu.items.length > 0 && (
        <Menu
          label="Tree actions"
          mode="basic"
          size="sm"
          open
          x={menu.x}
          y={menu.y}
          target={menu.target ?? undefined}
          onClose={() => setMenu(null)}
        >
          {menu.items.map((item) => (
            <MenuItem
              key={item.label}
              label={item.label}
              kind={item.kind ?? 'default'}
              onClick={() => {
                item.run();
                setMenu(null);
              }}
            />
          ))}
        </Menu>
      )}
      {confirmDelete && onDeleteView && (
        <DeleteViewDialog
          view={confirmDelete}
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => {
            onDeleteView(confirmDelete);
            setConfirmDelete(null);
          }}
        />
      )}
    </nav>
  );
}

function DeleteViewDialog({
  view,
  onCancel,
  onConfirm,
}: {
  view: SavedView;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal
      open
      danger
      size="xs"
      modalHeading={`Delete “${view.name}”?`}
      primaryButtonText="Delete"
      secondaryButtonText="Cancel"
      onRequestClose={onCancel}
      onRequestSubmit={onConfirm}
    >
      <p>The saved view is removed for everyone who uses this viewer.</p>
    </Modal>
  );
}
