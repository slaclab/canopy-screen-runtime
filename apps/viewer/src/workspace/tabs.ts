// Workspace tab model and CANOPY layout holder — pure state, no React.
//
// A tab is identified by its key:
//   screens  `category/id` plus the canonical macro query: the viewer's
//            reserved parameters (embedded, theme, mode, _canopy*) are
//            stripped, a repeated name keeps its last value (as
//            macrosFromSearch does), and the rest is sorted by name, so the
//            same screen with the same macros is always the same tab.
//   tools    `@<tool>` (instance 1) or `@<tool>/<n>` (tools.ts), which ignore
//            every query parameter (a `pv=` in the URL never reaches Trace).
//
// The holder (the dock layout plus the focused tile). `layout` is the dock's layout
// tree (@slaclab/canopy-dock-engine) and `focusedTile` the id of its focused tile;
// the reducer is their only writer, and every change goes through one engine
// operation (@slaclab/canopy-dock-engine): opens through `openItem`, open-many through
// `openSet`, a screen replace and Back/Forward through `replaceKey`, the
// close family through `closeTab`/`closeTile`/`closeOthers`/`closeRight`/
// `closeAll`, undo through `reopen`, a drag through `planDrop`. `restore`
// (a saved dock) and `resized` (sizes only) are the two writers without an
// engine call. Every open key is a tab of exactly one tile: there is no
// undocked or parked tab. Derived after every action, never written on
// their own:
//   keys     keysOf(layout): the open keys, tiles in tree order, then their
//            tabs in order (the strip order).
//   active   the focused tile's showing tab; null exactly when the dock is
//            empty. A focusedTile that is gone falls back to the first tile.
// A change the viewer makes on its own (the next focus after a close, mount)
// never promotes a tool instance in toolMru.
//
// One-tile mode (chrome off, `oneTile`): the holder keeps one tile. Drops and
// layout-replacing sets are refused as NO_DOCK, and any operation that would
// split the dock leaves one tile holding every key in tree order, showing the
// focused tile's tab: opens become tabs of that tile.
//
// Engine operations that need the dock's size read `dockPx` (set by
// `resized`; absent: DEFAULT_DOCK_PX), or the size an action carries.
//
// Each tool instance has its own {query, view, epoch} in `instances`:
//   query    the query its page last reported; null = the tool's config
//            default, '' = blank (and stays blank across reloads).
//   view     the saved view it was last loaded with, kept while the operator
//            edits it, so saving again offers the same name.
//   epoch    bumped whenever a query is loaded into the instance: its iframe
//            (src frozen at mount) remounts. Never stored.
//   from     the key of the collection member it was last opened from
//            (collections.ts memberKey), set by every member open, kept
//            across setQuery and setView, cleared by a load from anywhere else
//            (load replaces the instance). Stored like `view`.
//   title    the name of that member (a saved member's title is its tab
//            title), set with `from` by every member open and by a collection
//            save (`membersSaved`), dropped when the member has no name; same
//            lifecycle and storage as `from`.
// Instance I shows member M when I.from === memberKey(M), or I.from is
// unset and memberKey({tool, query: I.query}) equals it. A null query is the
// member without one and, when the caller names the tool's config default
// (`defaultQuery`, non-blank), also the member with that query, the one a
// save stores for it: instanceShowsMember / memberInstance.
// Closing an instance drops its entry, except the data browser's instance 1
// (`@trace`), whose state survives the close and comes back with it.
//
// `toolMru` lists tool keys only, newest first: a tool instance moves to the
// front whenever the operator makes it active (focus, open, load, drop),
// never when it becomes active because its neighbour closed. It is pruned to
// the open keys after every action. A tool's most recently used instance is
// its first key there, else its lowest open instance.
//
// `history[key]` is the per-slot Back/Forward stack of an open screen:
// `back` and `forward` list screen keys, nearest last. Only a screen `replace`
// pushes: the replaced key goes onto the new key's `back` (its own `back`
// carried over, `forward` cleared), in the same replaceKey that gives the new
// key the old one's place. `historyBack` / `historyForward` replace in place,
// or show the target when it is open elsewhere and drop the entry. Tool tabs
// never gain history and a tool `load` is not recorded. Each stack holds at
// most MAX_HISTORY keys; `settle` drops the history of keys that are not open.
//
// `closedStack` is the workspace's one undo store: the last
// MAX_CLOSED entries, newest last. Each is an engine close record
// (@slaclab/canopy-dock-engine close: `tab`, `tile`, `tabs` group or `layout` group) with
// an `id` (mintClosedId), who closed it (`closedBy`: the agent or you) and
// `panels`, each closed key's instance state and history. One action pushes
// one entry: a close of one tab or tile, a group close (closeOthers,
// closeToRight), and anything that replaces the layout (closeAll, an
// `openSet` as `layout`, `replaceLayout`) as one `layout` group, so one
// reopen restores all of it. A replace, a drop and `restore` push nothing.
// `reopenClosed` takes one entry off the stack (by id, else the newest) and
// runs the engine's reopen on it: a screen open again is only shown (no
// duplicate), a tool keeps its instance number when that is free and comes
// back at a fresh id otherwise, and tool entries at MAX_TOOL_INSTANCES are
// skipped (reopenClosed(state).skipped names them, for the caller's one
// notice). Reopening a `layout` group replaces the dock, so it pushes the
// layout it replaces as a new `layout` group.
//
// The URL shows the active tab; the open tabs, the instances and toolMru live
// in sessionStorage as {keys, active, instances, toolMru, history?,
// closedStack?} (the last two only when non-empty; a stored entry without an
// id gets one on read, an invalid one is dropped) under
// storageKey('canopy-viewer:tabs') (storageScope.ts: per mount and host scope,
// so users served from one origin never share a record). The layout is not
// stored there: the dock store holds it (loadTabs' `layout` / `reopen`).

import type { ManifestScreen } from '../api.js';
import { isTraceQuery } from '../config.js';
import { isSubScreen } from '../screenList.js';
import { memberKey, type Member, type MemberKey, type ScreenMember } from './collections.js';
import { macrosFromSearch } from '../macros.js';
import { storageKey } from '../storageScope.js';
import {
  DEFAULT_TOOL,
  MAX_TOOL_INSTANCES,
  isToolKey,
  parseToolKey,
  toolKey,
  toolOf,
  toolSpec,
} from './tools.js';
import {
  closeAll as engineCloseAll,
  closeOthers as engineCloseOthers,
  closeRight as engineCloseRight,
  closeTab as engineCloseTab,
  closeTile as engineCloseTile,
  reopen as engineReopen,
  findTile,
  planDrop,
  replaceKey,
  tileOf,
  MIN_PX,
  isTile,
  keysOf,
  tileIdsOf,
  validateLayout,
  TOO_MANY_FOR_SIDE,
  openItem,
  openSet,
} from '@slaclab/canopy-dock-engine';
import type {
  CloseRecord,
  CloseResult,
  LayoutGroupRecord,
  TabRecord,
  TabsGroupRecord,
  TileRecord,
  DockPx,
  Side,
  Source,
  Target,
  CollectionLayout,
  Layout,
  Split,
  Tile,
  OpenContext,
} from '@slaclab/canopy-dock-engine';

export type { Layout, Source, Target, Tile };
export { TOO_MANY_FOR_SIDE };

/** The data browser's first instance: the historical Trace tab key. */
export const TRACE_KEY = toolKey(DEFAULT_TOOL);
/** The tabs record's name (a storageKey name). */
export const TABS_STORAGE_NAME = 'canopy-viewer:tabs';

/** The sessionStorage key of the tabs record under a router basename. */
export function tabsStorageKey(basename: string): string {
  return storageKey(TABS_STORAGE_NAME, basename);
}

export interface ToolInstance {
  /** The instance's query: null = the tool's config default, '' = blank. */
  query: string | null;
  /** The saved view it was last loaded with (its id). */
  view?: string | null;
  /** Remount counter of the instance's iframe. Never stored. */
  epoch?: number;
  /** The member it was last opened from; see the module header. */
  from?: MemberKey;
  /** That member's name: the instance's tab title; see the module header. */
  title?: string;
}

/** A screen slot's Back/Forward stacks: screen keys, nearest last. */
export interface TabHistory {
  back: string[];
  forward: string[];
}

/** Who closed an entry: the agent (a workspace command) or the operator. */
export type ClosedBy = 'agent' | 'you';

/** What a closed key needs to come back with: a tool's state, a screen's history. */
export interface ClosedPanel {
  /** A tool instance's state (never its epoch). */
  instance?: ToolInstance;
  /** A screen's history at the close. */
  history?: TabHistory;
}

/** The envelope every closedStack entry carries around its engine record. */
export interface ClosedEnvelope {
  id: string;
  closedBy: ClosedBy;
  /** Per closed key with state to keep (absent key: nothing to restore). */
  panels: Record<string, ClosedPanel>;
}

export type ClosedTabEntry = TabRecord & ClosedEnvelope;
export type ClosedTileEntry = TileRecord & ClosedEnvelope;
export type ClosedTabsGroup = TabsGroupRecord & ClosedEnvelope;
export type ClosedLayoutGroup = LayoutGroupRecord & ClosedEnvelope;

/** One entry of the one undo store: an engine close record in its envelope. */
export type ClosedAction = ClosedTabEntry | ClosedTileEntry | ClosedTabsGroup | ClosedLayoutGroup;

/** What a closing action records about its entry, all optional. */
export interface CloseInfo {
  /** The entry id (absent: one is minted). */
  id?: string;
  /** Default: 'you'. */
  closedBy?: ClosedBy;
}

/** The dock's size in px, as the engine's DockPx.px. */
export interface DockSize {
  width: number;
  height: number;
}

/** The size engine operations assume before the dock has reported one. */
export const DEFAULT_DOCK_PX: Readonly<DockSize> = Object.freeze({ width: 1280, height: 800 });

/** The refusal of a drop or a layout-replacing set in one-tile (chrome-off) mode. */
export const NO_DOCK = 'no_dock';

/** Keys kept in each of a slot's Back and Forward stacks. */
export const MAX_HISTORY = 10;
/** Closed entries kept for reopenClosed. */
export const MAX_CLOSED = 10;

export interface TabsState {
  /** Open tab keys: keysOf(layout), derived. */
  keys: string[];
  /** The focused tile's showing tab (derived), null exactly when the dock is empty. */
  active: string | null;
  /** The dock's layout (@slaclab/canopy-dock-engine); null = an empty dock. */
  layout: Layout | null;
  /** The focused tile's id; null exactly when the dock is empty. */
  focusedTile: string | null;
  /** Per tool instance state, by canonical tool key. */
  instances: Record<string, ToolInstance>;
  /** Open tool keys, most recently used first. */
  toolMru: string[];
  /** Per open screen key, its Back/Forward stacks (absent = none). */
  history?: Record<string, TabHistory>;
  /** The last MAX_CLOSED closed entries, newest last (absent = none). */
  closedStack?: ClosedAction[];
  /** The dock's size in px, from `resized` (absent: DEFAULT_DOCK_PX). Never stored. */
  dockPx?: DockSize;
  /** One-tile (chrome-off) mode; see the module header. Never stored. */
  oneTile?: boolean;
}

export const EMPTY_TABS: Readonly<TabsState> = Object.freeze({
  keys: [],
  active: null,
  layout: null,
  focusedTile: null,
  instances: {},
  toolMru: [],
  history: {},
  closedStack: [],
}) as TabsState;

export type OpenMode = 'replace' | 'append';

/** How an `openSet` places its members (@slaclab/canopy-dock-engine open openSet). */
export type OpenSetAs = 'tabs' | 'side' | 'layout';

export type TabsAction =
  /** `replace` puts `key` in the place of `target ?? active` when that is a screen; see tabsReducer. */
  | { type: 'open'; key: string; mode: OpenMode; target?: string }
  /** Show an open key where it is and focus its tile. */
  | { type: 'focus'; key: string }
  /** Focus a tile (its showing tab becomes active). */
  | { type: 'focusTile'; tile: string }
  | { type: 'close'; key: string; closed?: CloseInfo }
  | { type: 'closeActive'; closed?: CloseInfo }
  /** Tile ×: the tile and every tab in it, as one entry. */
  | { type: 'closeTile'; tile: string; closed?: CloseInfo }
  /** Close every other tab of `key`'s tile (which is then shown and focused), as one entry. */
  | { type: 'closeOthers'; key: string; closed?: CloseInfo }
  /** Close the tabs right of `key` in its tile, as one entry. */
  | { type: 'closeToRight'; key: string; closed?: CloseInfo }
  /** Close the whole dock, as one `layout` entry. */
  | { type: 'closeAll'; closed?: CloseInfo }
  /** Take entry `id` (absent: the newest) off closedStack and bring it back. */
  | { type: 'reopenClosed'; id?: string }
  /** Swap screen `key` with the nearest entry of its Back stack. */
  | { type: 'historyBack'; key: string }
  /** Swap screen `key` with the nearest entry of its Forward stack. */
  | { type: 'historyForward'; key: string }
  /** The Tools entry's click: focus the MRU instance, else open instance 1. */
  | { type: 'openTool'; tool: string }
  /** A new instance at the smallest free id ('' = blank), opened as a tab of the focused tile. */
  | { type: 'newInstance'; tool: string; query?: string; view?: string | null }
  /** Load a query into `key` (opened as a tab of the focused tile when closed) and remount it. */
  | { type: 'load'; key: string; query: string; view: string | null }
  /** The saved-view rule: focus the instance showing it, else a new one. */
  | { type: 'openView'; tool: string; query: string; view: string; newTab?: boolean }
  /**
   * The row rules for a member: a screen replaces `target ?? active`
   * (`newTab`: opens as a tab of the focused tile); a bare tool is openTool (`newTab`:
   * newInstance); a tool with a query focuses the instance showing it, else
   * opens a new instance with it, else at the cap loads into the MRU
   * instance (`newTab`: never focuses). Every instance it lands on gets
   * `from` and `title`. `defaultQuery`: the tool's config default, for the
   * "showing it" match.
   */
  | {
      type: 'openMember';
      member: Member;
      newTab?: boolean;
      target?: string;
      defaultQuery?: string;
    }
  /** After a collection save: each open tool tab records the member it was saved as. */
  | { type: 'membersSaved'; entries: readonly SavedTab[] }
  /**
   * Open many (openSet): `members` are tab keys the caller minted;
   * `collection` (keys, not member indexes) is required for `as: 'layout'`.
   * Members that cannot open here (over the tool cap, unknown) are skipped
   * along with `skip`. `instances` seeds the state of tool keys this opens.
   */
  | {
      type: 'openSet';
      members: readonly string[];
      as: OpenSetAs;
      collection?: CollectionLayout<string>;
      caller?: 'agent' | 'person';
      skip?: readonly string[];
      instances?: Readonly<Record<string, ToolInstance>>;
      closed?: CloseInfo;
      dock?: DockSize;
    }
  /** A drag dropped `source` on `target` (planDrop). */
  | { type: 'drop'; source: Source; target: Target; dock?: DockSize }
  /** Replace the dock's layout (Reset, an arrangement), as one `layout` entry. */
  | { type: 'replaceLayout'; layout: Layout | null; closed?: CloseInfo }
  /** A saved dock comes back (persistence): no undo entry. */
  | { type: 'restore'; layout: Layout | null; focusedTile?: string | null }
  /** A sash resize or a dock size change: sizes only, the tree must be the same. */
  | { type: 'resized'; layout?: Layout; dock?: DockSize }
  | { type: 'setQuery'; key: string; query: string }
  | { type: 'setView'; key: string; view: string | null };

/** A tool tab a save stored as member `from` named `title` (absent: unnamed). */
export interface SavedTab {
  key: string;
  from: MemberKey;
  title?: string;
}

export type ParsedTabKey =
  | { kind: 'tool'; tool: string; instance: number }
  | {
      kind: 'screen';
      category: string;
      id: string;
      macros: Record<string, string>;
      /** Canonical macro query without a leading '?' ('' for none). */
      query: string;
    };

function canonicalQuery(search: URLSearchParams | string): string {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search;
  const macros = macrosFromSearch(params);
  const names = Object.keys(macros).sort();
  const out = new URLSearchParams();
  for (const name of names) out.append(name, macros[name]);
  return out.toString();
}

/** The tab key for a screen (or a tool: `@<tool>` with an instance id) and its URL query. */
export function tabKey(
  category: string,
  id: string,
  search: URLSearchParams | string = ''
): string {
  if (category.startsWith('@')) {
    const parsed = (id ? parseToolKey(`${category}/${id}`) : null) ?? parseToolKey(category);
    return parsed ? parsed.key : category;
  }
  const query = canonicalQuery(search);
  return query ? `${category}/${id}?${query}` : `${category}/${id}`;
}

/** Inverse of tabKey; null for a key that names no screen and no registered tool. */
export function parseTabKey(key: string): ParsedTabKey | null {
  if (key.startsWith('@')) {
    if (!isToolKey(key)) return null;
    const { tool, instance } = parseToolKey(key)!;
    return { kind: 'tool', tool, instance };
  }
  const q = key.indexOf('?');
  const path = q < 0 ? key : key.slice(0, q);
  const query = q < 0 ? '' : key.slice(q + 1);
  const slash = path.indexOf('/');
  if (slash <= 0) return null;
  const category = path.slice(0, slash);
  const id = path.slice(slash + 1);
  if (id === '') return null;
  return {
    kind: 'screen',
    category,
    id,
    macros: macrosFromSearch(new URLSearchParams(query)),
    query,
  };
}

/** The open instances of `tool`, in strip order. */
export function instancesOf(state: TabsState, tool: string): string[] {
  return state.keys.filter((key) => toolOf(key) === tool);
}

/** The most recently used of `candidates` (open tool keys), else the lowest instance. */
function mruAmong(state: TabsState, candidates: readonly string[]): string | null {
  if (candidates.length === 0) return null;
  const used = state.toolMru.find((key) => candidates.includes(key));
  if (used !== undefined) return used;
  return [...candidates].sort((a, b) => parseToolKey(a)!.instance - parseToolKey(b)!.instance)[0]!;
}

/** The tool's most recently used open instance, else its lowest open one, else null. */
export function mruInstance(state: TabsState, tool: string): string | null {
  return mruAmong(state, instancesOf(state, tool));
}

/** The open instances of `tool` showing saved view `view`, most recently used first. */
export function viewInstance(state: TabsState, tool: string, view: string): string | null {
  return mruAmong(
    state,
    instancesOf(state, tool).filter((key) => state.instances[key]?.view === view)
  );
}

/** A stored or given `from`: a tool member key of `tool`, else undefined. */
export function toolMemberKeyOf(tool: string, raw: unknown): MemberKey | undefined {
  if (typeof raw !== 'string') return undefined;
  const prefix = `tool:${tool}`;
  return raw === prefix || raw.startsWith(`${prefix}?`) ? (raw as MemberKey) : undefined;
}

/** The key of the bare or queried member an instance with `query` holds implicitly. */
function implicitMemberKey(tool: string, query: string | null): MemberKey | null {
  try {
    return memberKey(query === null ? { tool } : { tool, query });
  } catch {
    return null;
  }
}

/**
 * Whether tool instance `key` shows the member with key `member`: its
 * `from` is that key, or it has no `from` and its query is that member's; a
 * null query is also the member with `defaultQuery` (the tool's config
 * default, when non-blank), as a save stores it. Screen keys never do (a
 * screen member is shown by its own tab key).
 */
export function instanceShowsMember(
  state: TabsState,
  key: string,
  member: MemberKey,
  defaultQuery?: string
): boolean {
  const tool = toolOf(key);
  if (tool === undefined || !state.keys.includes(key)) return false;
  const instance = state.instances[key];
  if (instance?.from !== undefined) return instance.from === member;
  const query = instance?.query ?? null;
  if (implicitMemberKey(tool, query) === member) return true;
  return (
    query === null &&
    defaultQuery !== undefined &&
    defaultQuery !== '' &&
    implicitMemberKey(tool, defaultQuery) === member
  );
}

/** The open instance of `tool` showing `member`, most recently used first, else null. */
export function memberInstance(
  state: TabsState,
  tool: string,
  member: MemberKey,
  defaultQuery?: string
): string | null {
  return mruAmong(
    state,
    instancesOf(state, tool).filter((key) => instanceShowsMember(state, key, member, defaultQuery))
  );
}

/** A screen member's tab key, or null for a reference that names no screen. */
export function screenMemberTabKey(member: ScreenMember): string | null {
  const slash = member.screen.indexOf('/');
  if (slash <= 0 || member.screen.startsWith('@')) return null;
  const id = member.screen.slice(slash + 1);
  if (id === '') return null;
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(member.macros ?? {})) params.append(name, value);
  return tabKey(member.screen.slice(0, slash), id, params);
}

/** False when `key` would be a new instance of a tool already at the cap. */
export function canOpen(state: TabsState, key: string): boolean {
  if (state.keys.includes(key)) return true;
  const tool = toolOf(key);
  return tool === undefined || instancesOf(state, tool).length < MAX_TOOL_INSTANCES;
}

/** `open`'s guard: open already, a screen, or a tool instance under the cap. */
function openable(state: TabsState, key: string): boolean {
  if (key.startsWith('@') && !isToolKey(key)) return false;
  return canOpen(state, key);
}

/** The smallest instance id of `tool` that is not open. */
export function freeInstance(state: TabsState, tool: string): number {
  const open = new Set(instancesOf(state, tool).map((key) => parseToolKey(key)!.instance));
  let n = 1;
  while (open.has(n)) n += 1;
  return n;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((k, i) => k === b[i]);
}

// --- the holder ---------------------------------------------------------------

/** One tile holding every key of `layout` in tree order, showing the focused tile's tab. */
function flatten(layout: Layout, focusedTile: string | null): Tile {
  const focused =
    (focusedTile === null ? null : findTile(layout, focusedTile)) ??
    findTile(layout, tileIdsOf(layout)[0]!)!;
  return { tile: focused.tile, tabs: keysOf(layout), showing: focused.showing };
}

/**
 * `keys`, `active` and a valid `focusedTile` derived from the layout (and
 * one-tile mode applied). Unchanged parts keep their identity.
 */
function derive(state: TabsState): TabsState {
  let { layout, focusedTile } = state;
  if (layout !== null && state.oneTile === true && !isTile(layout)) {
    layout = flatten(layout, focusedTile);
  }
  const ids = tileIdsOf(layout);
  if (focusedTile === null || !ids.includes(focusedTile)) focusedTile = ids[0] ?? null;
  const active = focusedTile === null ? null : findTile(layout, focusedTile)!.showing;
  const derived = keysOf(layout);
  const keys = sameList(state.keys, derived) ? state.keys : derived;
  if (
    layout === state.layout &&
    focusedTile === state.focusedTile &&
    active === state.active &&
    keys === state.keys
  ) {
    return state;
  }
  return { ...state, layout, focusedTile, active, keys };
}

/** The state with a new layout and (when given) focused tile, derived; same state when neither changes. */
function withLayout(state: TabsState, layout: Layout | null, focus?: string | null): TabsState {
  const focusedTile = focus ?? state.focusedTile;
  if (layout === state.layout && focusedTile === state.focusedTile) return state;
  return derive({ ...state, layout, focusedTile });
}

/**
 * A holder state for `layout` with focus on `focusedTile` (absent or gone:
 * the first tile), every other field from `base`. Derived and settled.
 */
export function fromLayout(
  layout: Layout | null,
  focusedTile: string | null = null,
  base: TabsState = EMPTY_TABS
): TabsState {
  return settle(derive({ ...base, layout, focusedTile }));
}

function dockOf(state: TabsState, given?: DockSize): DockPx {
  return { px: given ?? state.dockPx ?? DEFAULT_DOCK_PX, minPx: MIN_PX };
}

function contextOf(state: TabsState, extra: Partial<OpenContext> = {}): OpenContext {
  return { focusedTile: state.focusedTile, dock: dockOf(state), ...extra };
}

/** The open rule (openItem): an open key is shown where it is, a new one becomes a tab of the focused tile. */
function show(state: TabsState, key: string): TabsState {
  const out = openItem(state.layout, key, contextOf(state));
  return withLayout(state, out.layout, out.focus ?? null);
}

/** `key` (a tool key) first in toolMru. */
function touch(state: TabsState, key: string): TabsState {
  if (!isToolKey(key) || state.toolMru[0] === key) return state;
  return { ...state, toolMru: [key, ...state.toolMru.filter((k) => k !== key)] };
}

/** Whether two layouts are the same tree but for sizes. */
function sameShape(a: Layout | null, b: Layout | null): boolean {
  if (a === null || b === null) return a === b;
  if (isTile(a) || isTile(b)) {
    if (!isTile(a) || !isTile(b)) return false;
    return (
      a.tile === b.tile && a.showing === b.showing && a.from === b.from && sameList(a.tabs, b.tabs)
    );
  }
  const x = a as Split;
  const y = b as Split;
  return (
    x.split === y.split &&
    x.items.length === y.items.length &&
    x.items.every((item, i) => sameShape(item, y.items[i]!))
  );
}

/** `layout` without the keys `keep` rejects, each closed by the leave rule. */
function pruneLayout(layout: Layout | null, keep: (key: string) => boolean): Layout | null {
  let next = layout;
  for (const key of keysOf(layout)) {
    if (!keep(key)) next = engineCloseTab(next, key).layout;
  }
  return next;
}

/** A dock-form layout, else undefined. */
function validDock(raw: unknown): Layout | null | undefined {
  if (raw === null) return null;
  return validateLayout(raw).valid ? (raw as Layout) : undefined;
}

/**
 * The invariants every action ends with: the derived fields, toolMru holds
 * open keys only, and only open instances (and the data browser's
 * survive-close `@trace`) keep state. Unchanged parts keep their identity.
 */
function settle(state: TabsState): TabsState {
  let next = derive(state);
  const open = new Set(next.keys);
  const mru = next.toolMru.filter((key) => open.has(key));
  if (mru.length !== next.toolMru.length) next = { ...next, toolMru: mru };
  const stale = Object.keys(next.instances).filter((key) => key !== TRACE_KEY && !open.has(key));
  if (stale.length > 0) {
    const instances = { ...next.instances };
    for (const key of stale) delete instances[key];
    next = { ...next, instances };
  }
  if (next.history !== undefined) {
    const gone = Object.keys(next.history).filter((key) => isToolKey(key) || !open.has(key));
    if (gone.length > 0) {
      const history = { ...next.history };
      for (const key of gone) delete history[key];
      next = { ...next, history };
    }
  }
  return next;
}

function withInstance(state: TabsState, key: string, instance: ToolInstance): TabsState {
  return { ...state, instances: { ...state.instances, [key]: instance } };
}

/**
 * Instance `key` (a tool key) records member `from` and its name `title`
 * (none: no title); unchanged when it already does.
 */
export function withMember(
  state: TabsState,
  key: string,
  from: MemberKey,
  title: string | undefined
): TabsState {
  const prev = state.instances[key];
  if (prev?.from === from && prev.title === title) return state;
  const instance: ToolInstance = { ...prev, query: prev?.query ?? null, from };
  if (title === undefined) delete instance.title;
  else instance.title = title;
  return withInstance(state, key, instance);
}

function openMember(
  state: TabsState,
  member: Member,
  newTab: boolean,
  target: string | undefined,
  defaultQuery: string | undefined
): TabsState {
  if ('screen' in member) {
    const key = screenMemberTabKey(member);
    if (key === null) return state;
    return reduce(state, { type: 'open', key, mode: newTab ? 'append' : 'replace', target });
  }
  const { tool } = member;
  if (toolSpec(tool) === undefined) return state;
  const from = implicitMemberKey(tool, member.query ?? null);
  if (from === null) return state;
  const withFrom = (s: TabsState, key: string) => withMember(s, key, from, member.name);
  if (member.query === undefined) {
    if (newTab) {
      if (instancesOf(state, tool).length >= MAX_TOOL_INSTANCES) return state;
      const key = toolKey(tool, freeInstance(state, tool));
      const next = reduce(state, { type: 'newInstance', tool });
      return next === state ? state : withFrom(next, key);
    }
    // Focusing the MRU instance loads nothing into it, so its `from` stays;
    // only an instance this click opens records the member.
    if (mruInstance(state, tool) !== null) return reduce(state, { type: 'openTool', tool });
    const next = reduce(state, { type: 'openTool', tool });
    return next === state ? state : withFrom(next, toolKey(tool));
  }
  const { query } = member;
  if (!newTab) {
    const showing = memberInstance(state, tool, from, defaultQuery);
    if (showing !== null) return withFrom(touch(show(state, showing), showing), showing);
  }
  const key =
    instancesOf(state, tool).length < MAX_TOOL_INSTANCES
      ? toolKey(tool, freeInstance(state, tool))
      : mruInstance(state, tool)!;
  const next = load(state, key, query, null);
  return next === state ? state : withFrom(next, key);
}

/** Open (as a tab of the focused tile) or show `key`, then load `query` into it with a fresh epoch. */
function load(state: TabsState, key: string, query: string, view: string | null): TabsState {
  if (!isToolKey(key) || !isTraceQuery(query) || !canOpen(state, key)) return state;
  const opened = show(state, key);
  const epoch = (state.instances[key]?.epoch ?? 0) + 1;
  return touch(withInstance(opened, key, { query, view, epoch }), key);
}

/** The newest MAX_HISTORY entries of a stack. */
function capped(stack: string[]): string[] {
  return stack.length > MAX_HISTORY ? stack.slice(-MAX_HISTORY) : stack;
}

/** `entry` with `history` set (or dropped when both stacks are empty). */
function withHistory(state: TabsState, key: string, entry: TabHistory | undefined): TabsState {
  const history = { ...state.history };
  if (entry === undefined || (entry.back.length === 0 && entry.forward.length === 0)) {
    if (!(key in history)) return state;
    delete history[key];
  } else {
    history[key] = entry;
  }
  return { ...state, history };
}

/**
 * Back (`back`) or Forward: screen `key` is replaced in place (replaceKey)
 * by the nearest entry of that stack, `key` going onto the other one; a
 * target open elsewhere is shown instead and its entry dropped.
 */
function historyStep(state: TabsState, key: string, dir: 'back' | 'forward'): TabsState {
  const entry = state.history?.[key];
  if (!state.keys.includes(key) || entry === undefined) return state;
  const from = entry[dir];
  const target = from[from.length - 1];
  if (target === undefined) return state;
  const rest = from.slice(0, -1);
  if (state.keys.includes(target)) {
    const next = withHistory(state, key, { ...entry, [dir]: rest });
    return touch(show(next, target), target);
  }
  const replaced = replaceKey(state.layout, key, target);
  let next = withLayout(state, replaced.layout);
  next = withHistory(next, key, undefined);
  const moved: TabHistory =
    dir === 'back'
      ? { back: rest, forward: capped([...entry.forward, key]) }
      : { back: capped([...entry.back, key]), forward: rest };
  next = withHistory(next, target, moved);
  return show(next, target);
}

// --- the undo store -------------------------------------------------------------

let closedSeq = 0;

/** A closed-entry id no entry of `taken` carries (`u-<epoch>-<n>`). */
export function mintClosedId(taken: readonly ClosedAction[] = []): string {
  const ids = new Set(taken.map((entry) => entry.id));
  let id: string;
  do {
    closedSeq += 1;
    id = `u-${Date.now().toString(36)}-${closedSeq.toString(36)}`;
  } while (ids.has(id));
  return id;
}

/** `entry` on top of `stack`, under a fresh id when its own is taken, capped at MAX_CLOSED. */
function pushClosed(stack: readonly ClosedAction[], entry: ClosedAction): ClosedAction[] {
  const unique = stack.some((e) => e.id === entry.id)
    ? { ...entry, id: mintClosedId(stack) }
    : entry;
  return [...stack, unique].slice(-MAX_CLOSED);
}

/** Every key a close record holds. */
export function recordKeys(record: CloseRecord): string[] {
  switch (record.kind) {
    case 'tab':
      return [record.key];
    case 'tile':
      return [...record.tabs];
    case 'tabs':
      return record.records.map((r) => r.key);
    case 'layout':
      return keysOf(record.layout);
  }
}

/** The engine record inside a closedStack entry (its envelope dropped). */
function recordOf(entry: ClosedAction): CloseRecord {
  switch (entry.kind) {
    case 'tab':
      return {
        kind: 'tab',
        key: entry.key,
        tile: entry.tile,
        index: entry.index,
        showing: entry.showing,
      };
    case 'tile':
      return {
        kind: 'tile',
        tile: entry.tile,
        tabs: [...entry.tabs],
        showing: entry.showing,
        neighbour: entry.neighbour,
        side: entry.side,
        ...(entry.share === undefined ? {} : { share: entry.share }),
      };
    case 'tabs':
      return { kind: 'tabs', records: entry.records.map((r) => ({ ...r })) };
    case 'layout':
      return { kind: 'layout', layout: entry.layout };
  }
}

/** What `keys` need to come back: each tool's instance (no epoch), each screen's history. */
function panelsOf(state: TabsState, keys: readonly string[]): Record<string, ClosedPanel> {
  const panels: Record<string, ClosedPanel> = {};
  for (const key of keys) {
    const panel: ClosedPanel = {};
    const instance = state.instances[key];
    if (instance !== undefined) {
      const kept: ToolInstance = { ...instance };
      delete kept.epoch;
      panel.instance = kept;
    }
    const history = state.history?.[key];
    if (history !== undefined) panel.history = history;
    if (panel.instance !== undefined || panel.history !== undefined) panels[key] = panel;
  }
  return panels;
}

/** `record` pushed onto closedStack in its envelope; the keys it holds give their panels. */
function pushRecord(
  state: TabsState,
  record: CloseRecord,
  info: CloseInfo = {},
  keys: readonly string[] = recordKeys(record)
): TabsState {
  const stack = state.closedStack ?? [];
  const entry = {
    ...record,
    id: info.id ?? mintClosedId(stack),
    closedBy: info.closedBy ?? 'you',
    panels: panelsOf(state, keys),
  } as ClosedAction;
  return { ...state, closedStack: pushClosed(stack, entry) };
}

/**
 * A close's result applied: its record on closedStack, its layout in the
 * holder. A closed focused tile hands focus to the neighbour that took its
 * space. A close that closed nothing changes nothing.
 */
function applyClose(state: TabsState, result: CloseResult, info?: CloseInfo): TabsState {
  const { record } = result;
  if (!result.changed || record === null || record === undefined) return state;
  let focus = result.focus ?? null;
  if (focus === null && record.kind === 'tile' && record.tile === state.focusedTile) {
    focus = record.neighbour;
  }
  return withLayout(pushRecord(state, record, info), result.layout, focus);
}

/** The layout `next` replacing the dock, as one `layout` entry (none when the dock was empty). */
function replaceDock(
  state: TabsState,
  next: Layout | null,
  focus: string | null,
  info?: CloseInfo
): TabsState {
  if (JSON.stringify(state.layout) === JSON.stringify(next)) return state;
  const kept = new Set(keysOf(next));
  const recorded =
    state.layout === null
      ? state
      : pushRecord(
          state,
          { kind: 'layout', layout: state.layout },
          info,
          state.keys.filter((k) => !kept.has(k))
        );
  return withLayout(recorded, next, focus);
}

/** A reopened tab: the entry's key and the key it came back under. */
export interface ReopenedKey {
  key: string;
  as: string;
}

export interface ReopenResult {
  state: TabsState;
  /** Tool entries refused at MAX_TOOL_INSTANCES (the caller shows one notice). */
  skipped: string[];
  /** The entry taken off the stack; undefined when there was none. */
  entry?: ClosedAction;
  /** The keys that came back, in record order, with the key each has now. */
  reopened: ReopenedKey[];
}

/** The closed entry `id` names, or the newest when `id` is absent. */
export function findClosed(state: TabsState, id?: string): ClosedAction | undefined {
  const stack = state.closedStack ?? [];
  return id === undefined ? stack[stack.length - 1] : stack.find((entry) => entry.id === id);
}

/**
 * The key each of `keys` reopens under: a screen as itself (shown when open
 * again), a tool as itself when that instance is free, else at the smallest
 * free id; null for a tool at the cap (`skipped`) or a key that names nothing.
 */
function reopenKeys(
  state: TabsState,
  keys: readonly string[],
  skipped: string[]
): Map<string, string> {
  const open = new Set(state.keys);
  const mapped = new Map<string, string>();
  for (const key of keys) {
    if (!key.startsWith('@')) {
      if (parseTabKey(key) !== null) mapped.set(key, key);
      continue;
    }
    const tool = toolOf(key);
    if (tool === undefined || toolSpec(tool) === undefined) continue;
    const count = [...open].filter((k) => toolOf(k) === tool).length;
    if (count >= MAX_TOOL_INSTANCES) {
      skipped.push(key);
      continue;
    }
    let as = key;
    if (open.has(key)) {
      let n = 1;
      while (open.has(toolKey(tool, n))) n += 1;
      as = toolKey(tool, n);
    }
    open.add(as);
    mapped.set(key, as);
  }
  return mapped;
}

/** `record` with its keys renamed by `mapped`; keys it does not map are left out (null: none left). */
function renameRecord(record: CloseRecord, mapped: Map<string, string>): CloseRecord | null {
  switch (record.kind) {
    case 'tab': {
      const as = mapped.get(record.key);
      return as === undefined ? null : { ...record, key: as };
    }
    case 'tile': {
      const tabs = record.tabs.flatMap((k) => (mapped.has(k) ? [mapped.get(k)!] : []));
      if (tabs.length === 0) return null;
      const showing = mapped.get(record.showing) ?? tabs[0]!;
      return { ...record, tabs, showing };
    }
    case 'tabs': {
      const records = record.records.flatMap((r) =>
        mapped.has(r.key) ? [{ ...r, key: mapped.get(r.key)! }] : []
      );
      return records.length === 0 ? null : { kind: 'tabs', records };
    }
    case 'layout':
      return {
        kind: 'layout',
        layout: pruneLayout(record.layout, (key) => mapped.get(key) === key),
      };
  }
}

/**
 * Take entry `id` (absent: the newest) off closedStack and run the engine's
 * reopen on it (see the module header). Every reopened tool gets its stored
 * state back with a fresh epoch, every reopened screen its history. The
 * result is not settled (tabsReducer does that).
 */
export function reopenClosed(state: TabsState, id?: string): ReopenResult {
  const entry = findClosed(state, id);
  if (entry === undefined) return { state, skipped: [], reopened: [] };
  const stack = state.closedStack ?? [];
  let next: TabsState = { ...state, closedStack: stack.filter((e) => e !== entry) };
  const skipped: string[] = [];
  const record = recordOf(entry);
  const keys = recordKeys(record);
  // A layout entry replaces the dock: its keys need no renaming against it.
  const mapped =
    record.kind === 'layout'
      ? reopenKeys({ ...next, keys: [] }, keys, skipped)
      : reopenKeys(next, keys, skipped);
  const renamed = renameRecord(record, mapped);
  if (renamed === null) return { state: next, skipped, entry, reopened: [] };
  const before = new Set(next.keys);
  if (renamed.kind === 'layout') {
    next = replaceDock(next, renamed.layout, null);
  } else {
    const out = engineReopen(next.layout, renamed, contextOf(next));
    next = withLayout(next, out.layout, out.focus ?? null);
  }
  const reopened: ReopenedKey[] = [];
  for (const key of keys) {
    const as = mapped.get(key);
    if (as === undefined || !next.keys.includes(as)) continue;
    reopened.push({ key, as });
    if (before.has(as)) continue;
    const panel = entry.panels[key];
    if (isToolKey(as)) {
      const epoch = (next.instances[as]?.epoch ?? 0) + 1;
      next = withInstance(next, as, {
        ...panel?.instance,
        query: panel?.instance?.query ?? null,
        epoch,
      });
      next = touch(next, as);
    } else if (panel?.history !== undefined) {
      next = withHistory(next, as, panel.history);
    }
  }
  return { state: next, skipped, entry, reopened };
}

// --- the reducer ----------------------------------------------------------------

/** What one action reports beyond its state. */
export interface TabsStep {
  state: TabsState;
  /** Why the action was refused (NO_DOCK, TOO_MANY_FOR_SIDE); the state is unchanged. */
  refusal?: string;
  /** A person's set fell back (TOO_MANY_FOR_SIDE: opened as tabs). */
  notice?: string;
  /** Members a set or a reopen left out. */
  skipped?: string[];
}

type StepOut = Omit<TabsStep, 'state'>;

/** A drop (planDrop): the moved key's tile gets focus. */
function drop(state: TabsState, source: Source, target: Target, dock?: DockSize): TabsState {
  if ('new' in source && !state.keys.includes(source.new) && !openable(state, source.new)) {
    return state;
  }
  const out = planDrop(state.layout, source, target, dockOf(state, dock));
  if (!out.changed) return state;
  const moved =
    'tile' in source
      ? (findTile(state.layout, source.tile)?.showing ?? null)
      : 'tab' in source
        ? source.tab
        : source.new;
  const focus = moved === null ? null : (tileOf(out.layout, moved)?.tile ?? null);
  const next = withLayout(state, out.layout, focus);
  return moved === null ? next : touch(next, moved);
}

function openSetAction(
  state: TabsState,
  action: Extract<TabsAction, { type: 'openSet' }>,
  out: StepOut
): TabsState {
  if (action.as === 'layout' && state.oneTile === true) {
    out.refusal = NO_DOCK;
    return state;
  }
  // Members over the tool cap (counting the ones this set opens) are skipped too.
  const skip = new Set(action.skip ?? []);
  const opening = new Set(action.as === 'layout' ? [] : state.keys);
  const perTool = new Map<string, number>();
  for (const key of opening) {
    const tool = toolOf(key);
    if (tool !== undefined) perTool.set(tool, (perTool.get(tool) ?? 0) + 1);
  }
  for (const key of action.members) {
    if (skip.has(key) || opening.has(key)) continue;
    if (key.startsWith('@')) {
      const tool = toolOf(key);
      if (!isToolKey(key) || tool === undefined) {
        skip.add(key);
        continue;
      }
      const count = perTool.get(tool) ?? 0;
      if (count >= MAX_TOOL_INSTANCES) {
        skip.add(key);
        continue;
      }
      perTool.set(tool, count + 1);
    } else if (parseTabKey(key) === null) {
      skip.add(key);
      continue;
    }
    opening.add(key);
  }
  const result = openSet(
    state.layout,
    [...action.members],
    action.as,
    action.collection,
    contextOf(state, {
      caller: action.caller ?? 'person',
      skip: [...skip],
      dock: dockOf(state, action.dock),
    })
  );
  if (result.skipped !== undefined && result.skipped.length > 0) out.skipped = result.skipped;
  if (result.refusal !== undefined) {
    out.refusal = result.refusal;
    return state;
  }
  if (result.notice !== undefined) out.notice = result.notice;
  if (!result.changed) return state;
  const before = new Set(state.keys);
  let next =
    result.record !== undefined
      ? replaceDock(state, result.layout, result.focus ?? null, action.closed)
      : withLayout(state, result.layout, result.focus ?? null);
  for (const key of next.keys) {
    const seeded = action.instances?.[key];
    if (before.has(key) || seeded === undefined || !isToolKey(key)) continue;
    const epoch = (next.instances[key]?.epoch ?? 0) + 1;
    next = withInstance(next, key, { ...seeded, epoch });
  }
  return next;
}

function reduce(state: TabsState, action: TabsAction, out: StepOut = {}): TabsState {
  switch (action.type) {
    case 'open': {
      const { key, mode } = action;
      if (state.keys.includes(key)) return touch(show(state, key), key);
      if (!openable(state, key)) return state;
      const target = action.target ?? state.active;
      if (
        mode === 'replace' &&
        target !== null &&
        state.keys.includes(target) &&
        !isToolKey(target)
      ) {
        // The new key takes the target's place in its tile (replaceKey); the
        // target leaves the dock and goes onto the new key's Back stack.
        const history = { ...state.history };
        const prior = history[target];
        delete history[target];
        if (!isToolKey(key)) {
          history[key] = { back: capped([...(prior?.back ?? []), target]), forward: [] };
        }
        const replaced = replaceKey(state.layout, target, key);
        return touch(show(withLayout({ ...state, history }, replaced.layout), key), key);
      }
      return touch(show(state, key), key);
    }
    case 'focus':
      return state.keys.includes(action.key) ? touch(show(state, action.key), action.key) : state;
    case 'focusTile': {
      const tile = findTile(state.layout, action.tile);
      if (tile === null) return state;
      return touch(withLayout(state, state.layout, tile.tile), tile.showing);
    }
    case 'close':
      return applyClose(state, engineCloseTab(state.layout, action.key), action.closed);
    case 'closeActive':
      return state.active === null
        ? state
        : applyClose(state, engineCloseTab(state.layout, state.active), action.closed);
    case 'closeTile':
      return applyClose(state, engineCloseTile(state.layout, action.tile), action.closed);
    case 'closeOthers': {
      if (!state.keys.includes(action.key)) return state;
      const next = applyClose(state, engineCloseOthers(state.layout, action.key), action.closed);
      return touch(show(next, action.key), action.key);
    }
    case 'closeToRight':
      return applyClose(state, engineCloseRight(state.layout, action.key), action.closed);
    case 'closeAll':
      return applyClose(state, engineCloseAll(state.layout), action.closed);
    case 'reopenClosed': {
      const result = reopenClosed(state, action.id);
      if (result.skipped.length > 0) out.skipped = result.skipped;
      return result.state;
    }
    case 'historyBack':
      return historyStep(state, action.key, 'back');
    case 'historyForward':
      return historyStep(state, action.key, 'forward');
    case 'openTool': {
      if (toolSpec(action.tool) === undefined) return state;
      const mru = mruInstance(state, action.tool);
      if (mru !== null) return touch(show(state, mru), mru);
      // With none open: instance 1 (with Trace's survived state), opened as
      // a tree click always opened a tab — replacing the active screen.
      return reduce(state, { type: 'open', key: toolKey(action.tool), mode: 'replace' }, out);
    }
    case 'newInstance': {
      const { tool } = action;
      const query = action.query ?? '';
      if (toolSpec(tool) === undefined || !isTraceQuery(query)) return state;
      if (instancesOf(state, tool).length >= MAX_TOOL_INSTANCES) return state;
      return load(state, toolKey(tool, freeInstance(state, tool)), query, action.view ?? null);
    }
    case 'load':
      return load(state, action.key, action.query, action.view);
    case 'openView': {
      const { tool, query, view } = action;
      if (toolSpec(tool) === undefined || !isTraceQuery(query)) return state;
      if (!action.newTab) {
        const showing = viewInstance(state, tool, view);
        if (showing !== null) return touch(show(state, showing), showing);
      }
      if (instancesOf(state, tool).length < MAX_TOOL_INSTANCES) {
        return reduce(state, { type: 'newInstance', tool, query, view }, out);
      }
      // At the cap: into the most recently used instance, as Revert does.
      return load(state, mruInstance(state, tool)!, query, view);
    }
    case 'openMember':
      return openMember(
        state,
        action.member,
        action.newTab === true,
        action.target,
        action.defaultQuery
      );
    case 'membersSaved': {
      let next = state;
      for (const { key, from, title } of action.entries) {
        if (isToolKey(key) && next.keys.includes(key)) next = withMember(next, key, from, title);
      }
      return next;
    }
    case 'openSet':
      return openSetAction(state, action, out);
    case 'drop':
      if (state.oneTile === true) {
        out.refusal = NO_DOCK;
        return state;
      }
      return drop(state, action.source, action.target, action.dock);
    case 'replaceLayout': {
      if (state.oneTile === true) {
        out.refusal = NO_DOCK;
        return state;
      }
      const layout = validDock(action.layout);
      if (layout === undefined) return state;
      const pruned = pruneLayout(layout, (key) => openable({ ...state, keys: [] }, key));
      return replaceDock(state, pruned, null, action.closed);
    }
    case 'restore': {
      const layout = validDock(action.layout);
      if (layout === undefined) return state;
      const pruned = pruneLayout(layout, (key) => openable({ ...state, keys: [] }, key));
      return withLayout(state, pruned, action.focusedTile ?? null);
    }
    case 'resized': {
      let next = state;
      const { dock } = action;
      if (
        dock !== undefined &&
        (state.dockPx?.width !== dock.width || state.dockPx?.height !== dock.height)
      ) {
        next = { ...next, dockPx: { width: dock.width, height: dock.height } };
      }
      const layout = action.layout === undefined ? undefined : validDock(action.layout);
      if (
        layout !== undefined &&
        layout !== null &&
        layout !== state.layout &&
        sameShape(layout, state.layout)
      ) {
        next = { ...next, layout };
      }
      return next;
    }
    case 'setQuery': {
      const { key, query } = action;
      const spec = toolSpec(toolOf(key) ?? '');
      if (!spec || !spec.isValidQuery(query)) return state;
      const prev = state.instances[key];
      if (prev?.query === query) return state;
      return withInstance(state, key, { ...prev, query });
    }
    case 'setView': {
      const { key, view } = action;
      if (!isToolKey(key)) return state;
      const prev = state.instances[key];
      if ((prev?.view ?? null) === view) return state;
      return withInstance(state, key, { ...prev, query: prev?.query ?? null, view });
    }
  }
}

/**
 * One action with what it reports: a refusal (state unchanged), a notice,
 * the members it skipped. The state is settled unless unchanged.
 */
export function stepTabs(state: TabsState, action: TabsAction): TabsStep {
  const out: StepOut = {};
  const next = reduce(state, action, out);
  return { ...out, state: next === state ? state : settle(next) };
}

/**
 * `open` shows an already-open key where it is; otherwise `replace` puts
 * the key in the place of `target ?? active` (replaceKey; the open rule when
 * that is no open screen) and `append` opens it by the open rule, as a tab
 * of the focused tile. Both focus the result. A new instance of a tool
 * already at MAX_TOOL_INSTANCES is refused (state unchanged), whatever opens
 * it.
 */
export function tabsReducer(state: TabsState, action: TabsAction): TabsState {
  return stepTabs(state, action).state;
}

export interface LoadOptions {
  /** The tools config.json serves (tools.ts ids); other tool keys are dropped. */
  tools: readonly string[];
  /**
   * True when this session stored no tabs yet (a first visit, not a session
   * whose operator closed every tab): a bare `/embed/` then opens the data
   * browser (`@trace`) when it is configured.
   */
  fresh?: boolean;
  /**
   * HostCapabilities.homeOnFirstOpen: a fresh bare visit opens nothing here
   * and reports `pendingHome` instead; the workspace opens the home screen
   * (or the first screen of the tree) once the manifest arrives. Without it a
   * fresh bare visit opens `@trace`.
   */
  homeOnFirstOpen?: boolean;
  /**
   * Reload path: the stored dock layout. Nothing is reopened: its keys
   * that are not open are pruned (the leave rule), and open keys it lacks
   * join the focused tile. `layout: null` is an empty stored dock. Absent:
   * no stored layout, every open key is a tab of one tile.
   */
  layout?: StoredLayout;
  /**
   * New session: the stored layout plus its tool `{query, view}`
   * per key. The keys are validated like stored tabs and opened before the
   * URL key. Takes the place of `layout`.
   */
  reopen?: { panels: readonly ReopenPanel[]; layout: Layout | null; focusedTile?: string | null };
  /** One-tile (chrome-off) mode for the session. */
  oneTile?: boolean;
}

export interface StoredLayout {
  /** The stored dock layout (invalid: ignored, as if absent). */
  layout: Layout | null;
  /** The stored focused tile. */
  focusedTile?: string | null;
}

export interface ReopenPanel {
  key: string;
  /** A tool's stored query ('' = blank; absent = the config default). */
  query?: string;
  /** A tool's stored saved-view id. */
  view?: string;
  /** A tool's stored member provenance (a member key). */
  from?: string;
  /** That member's stored name (the tab title). */
  title?: string;
}

/** Why a tool key cannot open here, or null when it can. */
export function toolProblem(key: string, tools: readonly string[]): string | null {
  const parsed = parseToolKey(key);
  if (!parsed || toolSpec(parsed.tool) === undefined) return `${key} is not a known tool`;
  if (!tools.includes(parsed.tool)) return `${toolSpec(parsed.tool)!.label} is not configured`;
  return null;
}

/** `layout` with every key in canonical form; undefined when that is no valid dock layout. */
function canonicalLayout(layout: unknown): Layout | null | undefined {
  if (layout === null) return null;
  const visit = (node: unknown): unknown => {
    if (!isRecord(node)) return node;
    if (Array.isArray(node.items)) return { ...node, items: node.items.map(visit) };
    if (!Array.isArray(node.tabs)) return node;
    return {
      ...node,
      tabs: node.tabs.map((k) => (typeof k === 'string' ? canonicalKey(k) : k)),
      showing: typeof node.showing === 'string' ? canonicalKey(node.showing) : node.showing,
    };
  };
  return validDock(visit(layout));
}

/** `keys` appended to tile `id` of `layout` as hidden tabs (an empty dock: one new tile). */
function joinTile(
  layout: Layout | null,
  id: string | null,
  keys: readonly string[]
): Layout | null {
  if (keys.length === 0) return layout;
  if (layout === null) return { tile: 't1', tabs: [...keys], showing: keys[0]! };
  const target =
    (id === null ? null : findTile(layout, id)) ?? findTile(layout, tileIdsOf(layout)[0]!)!;
  const visit = (node: Layout): Layout => {
    if (!isTile(node)) return { ...node, items: node.items.map(visit) };
    return node.tile === target.tile ? { ...node, tabs: [...node.tabs, ...keys] } : node;
  };
  return visit(layout);
}

/**
 * The load rules. Restore the stored keys; a URL key is shown when
 * already open and opened as a tab of the focused tile otherwise (never replaces). Tool keys of
 * unregistered or unconfigured tools, and instances past the cap, are dropped
 * with one warning each. A fresh session on a bare `/embed/` with the data
 * browser configured opens `@trace` when nothing else is open.
 *
 * Without a stored layout every open key is a tab of one tile, showing the
 * stored active (or the first key when that is gone). With one (`layout` on
 * reload, `reopen` on a new session, which first opens its keys) the dock is
 * that layout pruned to the open keys, open keys it lacks joining its
 * focused tile, and focus goes to the URL key, else the session's active key,
 * else the stored focused tile.
 */
export function loadTabs(
  stored: TabsState,
  urlKey: string | null,
  options: LoadOptions
): LoadResult {
  const warnings: string[] = [];
  const keys: string[] = [];
  const perTool = new Map<string, number>();
  /** Whether `key` may open here, counting it against its tool's cap. */
  const admit = (key: string, dropped: string): boolean => {
    if (!key.startsWith('@')) return true;
    const problem = toolProblem(key, options.tools);
    if (problem) {
      warnings.push(`${problem}; ${dropped}.`);
      return false;
    }
    const tool = toolOf(key)!;
    const count = perTool.get(tool) ?? 0;
    if (count >= MAX_TOOL_INSTANCES) {
      warnings.push(`At most ${MAX_TOOL_INSTANCES} ${tool} tabs; ${dropped}.`);
      return false;
    }
    perTool.set(tool, count + 1);
    return true;
  };
  for (const key of stored.keys) {
    if (admit(key, `dropped the stored ${key} tab`)) keys.push(key);
  }

  let instances = stored.instances;
  let base: StoredLayout | undefined = options.layout;
  if (options.reopen) {
    const reopened = new Set<string>();
    const order: string[] = [];
    for (const panel of options.reopen.panels) order.push(canonicalKey(panel.key));
    const layout = canonicalLayout(options.reopen.layout);
    for (const key of keysOf(layout ?? null)) if (!order.includes(key)) order.push(key);
    for (const key of order) {
      if (key === '' || reopened.has(key)) continue;
      if (!keys.includes(key)) {
        if (!admit(key, `did not reopen the stored ${key} tile`)) continue;
        keys.push(key);
        const panel = options.reopen.panels.find((p) => canonicalKey(p.key) === key);
        if (isToolKey(key) && panel !== undefined) {
          // Seeded, not loaded (no epoch): each frame mounts once.
          const query = storedQuery(key, panel.query);
          const seeded: ToolInstance =
            typeof panel.view === 'string' && panel.view !== ''
              ? { query, view: panel.view }
              : { query };
          const from = toolMemberKeyOf(toolOf(key)!, panel.from);
          if (from !== undefined) {
            seeded.from = from;
            if (typeof panel.title === 'string' && panel.title !== '') seeded.title = panel.title;
          }
          instances = { ...instances, [key]: seeded };
        }
      }
      reopened.add(key);
    }
    base =
      layout === undefined
        ? undefined
        : { layout, focusedTile: options.reopen.focusedTile ?? null };
  }

  // History of the stored keys that stay open (settle drops the rest).
  const history: Record<string, TabHistory> = {};
  for (const [key, entry] of Object.entries(stored.history ?? {})) {
    if (stored.keys.includes(key)) history[key] = entry;
  }
  const closedStack = stored.closedStack ?? [];
  const sessionActive =
    stored.active !== null && keys.includes(stored.active) ? stored.active : null;
  const layout = base === undefined ? undefined : canonicalLayout(base.layout);
  const rest: TabsState = {
    ...EMPTY_TABS,
    instances,
    toolMru: stored.toolMru,
    history,
    closedStack,
  };
  if (options.oneTile === true) rest.oneTile = true;
  let state: TabsState;
  if (layout === undefined) {
    const showing = sessionActive ?? keys[0];
    state = fromLayout(
      showing === undefined ? null : { tile: 't1', tabs: keys, showing },
      null,
      rest
    );
  } else {
    const open = new Set(keys);
    const pruned = pruneLayout(layout, (key) => open.has(key));
    const placed = new Set(keysOf(pruned));
    const focusedTile = base?.focusedTile ?? null;
    const joined = joinTile(
      pruned,
      focusedTile,
      keys.filter((k) => !placed.has(k))
    );
    state = fromLayout(joined, focusedTile, rest);
  }

  if (urlKey !== null && urlKey.startsWith('@')) {
    const problem = toolProblem(urlKey, options.tools);
    if (problem) {
      warnings.push(`${problem}; ignoring /embed/${urlKey}.`);
      urlKey = null;
    } else if (!canOpen(state, urlKey)) {
      warnings.push(
        `At most ${MAX_TOOL_INSTANCES} ${toolOf(urlKey)} tabs; ignoring /embed/${urlKey}.`
      );
      urlKey = null;
    }
  }
  if (urlKey !== null) {
    state = tabsReducer(state, { type: 'open', key: urlKey, mode: 'append' });
  } else if (layout !== undefined && sessionActive !== null) {
    // The session's own focus, not an operator's: toolMru stays as it is.
    state = settle(show(state, sessionActive));
  }
  if (urlKey === null && options.fresh && state.keys.length === 0) {
    if (options.homeOnFirstOpen) return { state, warnings, pendingHome: true };
    if (options.tools.includes(DEFAULT_TOOL)) {
      state = tabsReducer(state, { type: 'open', key: TRACE_KEY, mode: 'append' });
    }
  }
  return { state, warnings };
}

export interface LoadResult {
  state: TabsState;
  warnings: string[];
  /**
   * Present (true) only on a homeOnFirstOpen first visit that opened nothing:
   * the workspace opens the first-open target once the manifest arrives.
   */
  pendingHome?: true;
}

/** The manifest category a configured home screen id is resolved in. */
export const HOME_CATEGORY = 'library';

interface OrderFolder {
  name: string;
  folders: Map<string, OrderFolder>;
  leaves: ManifestScreen[];
}

/**
 * What a homeOnFirstOpen first visit opens: the configured `home` library
 * screen when the manifest lists it as a viewable screen, else the first
 * viewable, non-sub-screen leaf of the screens tree in its render order
 * (folders by name before leaves by title, depth first, the `drafts`
 * category flattened into the root, internal `@` categories dropped), else
 * null (nothing opens).
 */
export function firstOpenKey(screens: readonly ManifestScreen[], home?: string): string | null {
  if (home !== undefined) {
    const entry = screens.find(
      (s) => s.category === HOME_CATEGORY && s.id === home && s.kind === 'ir'
    );
    if (entry) return tabKey(entry.category, entry.id);
  }
  const root: OrderFolder = { name: '', folders: new Map(), leaves: [] };
  const folderIn = (parent: OrderFolder, name: string): OrderFolder => {
    let folder = parent.folders.get(name);
    if (!folder) {
      folder = { name, folders: new Map(), leaves: [] };
      parent.folders.set(name, folder);
    }
    return folder;
  };
  for (const entry of screens) {
    if (entry.category.startsWith('@') || entry.kind !== 'ir' || isSubScreen(entry.id)) continue;
    // 'drafts' is ScreenTree's FLATTENED_CATEGORY (not imported: ScreenTree imports this module).
    let folder = entry.category === 'drafts' ? root : folderIn(root, entry.category);
    for (const segment of entry.id.split('/').slice(0, -1)) folder = folderIn(folder, segment);
    folder.leaves.push(entry);
  }
  const first = (folder: OrderFolder): ManifestScreen | null => {
    const folders = [...folder.folders.values()].sort((a, b) => a.name.localeCompare(b.name));
    for (const child of folders) {
      const hit = first(child);
      if (hit) return hit;
    }
    const leaves = [...folder.leaves].sort((a, b) => a.title.localeCompare(b.title));
    return leaves[0] ?? null;
  };
  const entry = first(root);
  return entry ? tabKey(entry.category, entry.id) : null;
}

// --- sessionStorage, guarded like ZoomContext: any failure means "nothing
// stored" on read and "not persisted" on write. ---

function sessionStore(): Storage | undefined {
  try {
    const value = (globalThis as { sessionStorage?: Storage }).sessionStorage;
    return typeof value?.getItem === 'function' ? value : undefined;
  } catch {
    return undefined;
  }
}

function emptyTabs(): TabsState {
  return {
    keys: [],
    active: null,
    layout: null,
    focusedTile: null,
    instances: {},
    toolMru: [],
    history: {},
    closedStack: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A stored key in canonical form (`@trace/1` -> `@trace`). */
function canonicalKey(key: string): string {
  return parseToolKey(key)?.key ?? key;
}

/** A stored instance query: the tool's own check, '' (blank) or null (default). */
function storedQuery(key: string, raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  if (raw === '') return '';
  const spec = toolSpec(toolOf(key) ?? '');
  return spec && spec.isValidQuery(raw) ? raw : null;
}

/** A stored instance record of tool key `key`. */
function parseInstance(key: string, value: Record<string, unknown>): ToolInstance {
  const query = storedQuery(key, value.query);
  const instance: ToolInstance =
    typeof value.view === 'string' ? { query, view: value.view } : { query };
  const from = toolMemberKeyOf(toolOf(key)!, value.from);
  if (from !== undefined) {
    instance.from = from;
    if (typeof value.title === 'string' && value.title !== '') instance.title = value.title;
  }
  return instance;
}

/** A stored history stack: screen keys only, the newest MAX_HISTORY. */
function parseStack(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const keys = raw.filter(
    (k): k is string => typeof k === 'string' && !k.startsWith('@') && parseTabKey(k) !== null
  );
  return capped(keys);
}

/** A stored history entry, or undefined when it holds nothing. */
function parseHistory(raw: unknown): TabHistory | undefined {
  if (!isRecord(raw)) return undefined;
  const back = parseStack(raw.back);
  const forward = parseStack(raw.forward);
  return back.length === 0 && forward.length === 0 ? undefined : { back, forward };
}

/** The stored history of the stored screen keys `keys`. */
function parseHistories(raw: unknown, keys: readonly string[]): Record<string, TabHistory> {
  const history: Record<string, TabHistory> = {};
  if (!isRecord(raw)) return history;
  for (const [key, value] of Object.entries(raw)) {
    if (key.startsWith('@') || !keys.includes(key)) continue;
    const entry = parseHistory(value);
    if (entry !== undefined) history[key] = entry;
  }
  return history;
}

const SIDES: readonly string[] = ['left', 'right', 'top', 'bottom'];

/** A stored key in canonical form when it names something that could reopen, else null. */
function reopenableKey(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw === '') return null;
  const key = canonicalKey(raw);
  if (key.startsWith('@') ? !isToolKey(key) : parseTabKey(key) === null) return null;
  return key;
}

function isIndex(raw: unknown): raw is number {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0;
}

function parseTabRecord(raw: unknown): TabRecord | null {
  if (!isRecord(raw)) return null;
  const key = reopenableKey(raw.key);
  if (key === null || typeof raw.tile !== 'string' || raw.tile === '' || !isIndex(raw.index)) {
    return null;
  }
  return { kind: 'tab', key, tile: raw.tile, index: raw.index, showing: raw.showing === true };
}

/** A stored engine record, or null when it is not a valid one. */
function parseRecord(raw: Record<string, unknown>): CloseRecord | null {
  switch (raw.kind) {
    case 'tab':
      return parseTabRecord(raw);
    case 'tile': {
      if (typeof raw.tile !== 'string' || raw.tile === '' || !Array.isArray(raw.tabs)) return null;
      const tabs: string[] = [];
      for (const k of raw.tabs) {
        const key = reopenableKey(k);
        if (key !== null && !tabs.includes(key)) tabs.push(key);
      }
      if (tabs.length === 0) return null;
      const shown = reopenableKey(raw.showing);
      const showing = shown !== null && tabs.includes(shown) ? shown : tabs[0]!;
      const neighbour =
        typeof raw.neighbour === 'string' && raw.neighbour !== '' ? raw.neighbour : null;
      const side =
        typeof raw.side === 'string' && SIDES.includes(raw.side) ? (raw.side as Side) : null;
      const record: TileRecord = { kind: 'tile', tile: raw.tile, tabs, showing, neighbour, side };
      // A share from before shares existed is absent; a bad one is dropped (halve).
      if (typeof raw.share === 'number' && raw.share > 0 && raw.share < 1) record.share = raw.share;
      return record;
    }
    case 'tabs': {
      if (!Array.isArray(raw.records)) return null;
      const records: TabRecord[] = [];
      for (const r of raw.records) {
        const record = parseTabRecord(r);
        if (record !== null) records.push(record);
      }
      return records.length === 0 ? null : { kind: 'tabs', records };
    }
    case 'layout': {
      const layout = canonicalLayout(raw.layout);
      return layout === undefined ? null : { kind: 'layout', layout };
    }
    default:
      return null;
  }
}

/** The stored panels of `keys`: tool instances and screen histories. */
function parsePanels(raw: unknown, keys: readonly string[]): Record<string, ClosedPanel> {
  const panels: Record<string, ClosedPanel> = {};
  if (!isRecord(raw)) return panels;
  for (const [rawKey, value] of Object.entries(raw)) {
    const key = canonicalKey(rawKey);
    if (!keys.includes(key) || !isRecord(value)) continue;
    const panel: ClosedPanel = {};
    if (key.startsWith('@')) {
      if (isRecord(value.instance)) panel.instance = parseInstance(key, value.instance);
    } else {
      const history = parseHistory(value.history);
      if (history !== undefined) panel.history = history;
    }
    if (panel.instance !== undefined || panel.history !== undefined) panels[key] = panel;
  }
  return panels;
}

/**
 * The stored closedStack: valid engine records, the newest MAX_CLOSED. An
 * entry without an id (or with a duplicate one) gets a fresh one; a missing
 * closer reads as 'you'. An entry that is no engine record is dropped.
 */
function parseClosedStack(raw: unknown): ClosedAction[] {
  if (!Array.isArray(raw)) return [];
  const stack: ClosedAction[] = [];
  for (const action of raw.slice(-MAX_CLOSED)) {
    if (!isRecord(action)) continue;
    const record = parseRecord(action);
    if (record === null) continue;
    const id =
      typeof action.id === 'string' && action.id !== '' && !stack.some((e) => e.id === action.id)
        ? action.id
        : mintClosedId(stack);
    const closedBy: ClosedBy = action.closedBy === 'agent' ? 'agent' : 'you';
    const panels = parsePanels(action.panels, recordKeys(record));
    stack.push({ ...record, id, closedBy, panels } as ClosedAction);
  }
  return stack;
}
function parseInstances(record: Record<string, unknown>): Record<string, ToolInstance> {
  const instances: Record<string, ToolInstance> = {};
  if (!isRecord(record.instances)) return instances;
  for (const [rawKey, value] of Object.entries(record.instances)) {
    const key = canonicalKey(rawKey);
    if (!isToolKey(key) || !isRecord(value)) continue;
    instances[key] = parseInstance(key, value);
  }
  return instances;
}

function parseStored(raw: unknown): TabsState {
  if (!isRecord(raw)) return emptyTabs();
  if (!Array.isArray(raw.keys)) return emptyTabs();
  const keys: string[] = [];
  for (const rawKey of raw.keys) {
    if (typeof rawKey !== 'string' || rawKey === '') continue;
    const key = canonicalKey(rawKey);
    if (!keys.includes(key)) keys.push(key);
  }
  const active =
    typeof raw.active === 'string' && keys.includes(canonicalKey(raw.active))
      ? canonicalKey(raw.active)
      : null;
  const toolMru: string[] = [];
  if (Array.isArray(raw.toolMru)) {
    for (const rawKey of raw.toolMru) {
      if (typeof rawKey !== 'string') continue;
      const key = canonicalKey(rawKey);
      if (isToolKey(key) && !toolMru.includes(key)) toolMru.push(key);
    }
  }
  // The layout is not stored here: until the dock store says otherwise, every
  // stored key is a tab of one tile, showing the stored active.
  const showing = active ?? keys[0];
  const parsed: TabsState = derive({
    keys,
    active,
    layout: showing === undefined ? null : { tile: 't1', tabs: keys, showing },
    focusedTile: null,
    instances: parseInstances(raw),
    toolMru,
  });
  // History and closedStack only when stored (written only when non-empty).
  const history = parseHistories(raw.history, keys);
  if (Object.keys(history).length > 0) parsed.history = history;
  const closedStack = parseClosedStack(raw.closedStack);
  if (closedStack.length > 0) parsed.closedStack = closedStack;
  return parsed;
}
export function readTabs(basename = '/'): TabsState {
  try {
    const raw = sessionStore()?.getItem(tabsStorageKey(basename));
    if (!raw) return emptyTabs();
    return parseStored(JSON.parse(raw));
  } catch {
    return emptyTabs();
  }
}

/** True when this session has stored tabs for the mount (even an empty set). */
export function hasStoredTabs(basename = '/'): boolean {
  try {
    return sessionStore()?.getItem(tabsStorageKey(basename)) != null;
  } catch {
    return false;
  }
}

interface StoredInstance {
  query: string | null;
  view?: string;
  from?: string;
  title?: string;
}

/** An instance as stored: never its epoch. */
function storedInstance({ query, view, from, title }: ToolInstance): StoredInstance {
  const stored: StoredInstance = view ? { query, view } : { query };
  if (from) {
    stored.from = from;
    if (title) stored.title = title;
  }
  return stored;
}

/** A closedStack entry as stored: its record, id, closer and panels (no epoch). */
function storedEntry(entry: ClosedAction): Record<string, unknown> {
  const panels: Record<string, unknown> = {};
  for (const [key, panel] of Object.entries(entry.panels)) {
    const stored: Record<string, unknown> = {};
    if (panel.instance !== undefined) stored.instance = storedInstance(panel.instance);
    if (panel.history !== undefined) stored.history = panel.history;
    panels[key] = stored;
  }
  return { ...recordOf(entry), id: entry.id, closedBy: entry.closedBy, panels };
}

export function writeTabs(state: TabsState, basename = '/'): void {
  try {
    const instances: Record<string, StoredInstance> = {};
    for (const [key, instance] of Object.entries(state.instances)) {
      instances[key] = storedInstance(instance);
    }
    const { keys, active, toolMru } = state;
    const record: Record<string, unknown> = { keys, active, instances, toolMru };
    if (state.history !== undefined && Object.keys(state.history).length > 0) {
      record.history = state.history;
    }
    const stack = state.closedStack ?? [];
    if (stack.length > 0) record.closedStack = stack.map(storedEntry);
    sessionStore()?.setItem(tabsStorageKey(basename), JSON.stringify(record));
  } catch {
    // Not persisted; the in-memory tabs still apply.
  }
}
