// Layout tree -> dockview: the one serializer from the dock engine's layout tree to dockview-core
// 7.0.2's SerializedDockview, and the one place a layout is applied to a dock.
//
//   - group id = tile id, a group's views = the tile's tabs, active view = showing;
//   - sizes = fractions x px, laid out exactly as `geometry` does (and as dockview's
//     splitview does), so the rendered groups match `geometry` within 2 px;
//   - dockview's grid root must be a branch: a root Tile is wrapped in one;
//   - every panel entry keeps the per-panel state it already had (params, title,
//     components) and carries the 40 px minimums, which dockview reads off a group's
//     active panel, so every group has them.
//
// `applyLayout` runs `fromJSON` through the caller's guard (the bridge's `applying`
// wrapper) and keeps keyboard focus across the rebuild: dockview disposes and rebuilds
// every group header, so a focused tile-bar tab is re-found by tile and key once its
// portal is back, falling back to the showing tab of the tile that now holds that key
// (or, when the key is gone, of the tile it was in).
import type {
  DockviewApi,
  GroupviewPanelState,
  Orientation,
  SerializedDockview,
  SerializedGridObject,
} from 'dockview-core';
import {
  findTile,
  tileOf,
  axisOf,
  itemFractions,
  layoutSizes,
  minimumSize,
  isTile,
  normalize,
} from '@slaclab/canopy-dock-engine';
import type { Axis, Layout, Tile } from '@slaclab/canopy-dock-engine';

// --- constants ----------------------------------------------------------------

/** The dock's minimum tile size on both axes (the layout's 40 px floor). */
export const MIN_TILE_PX = 40;
/** Component name of a panel the dock has no stored state for. */
export const PLACEHOLDER_COMPONENT = 'canopy-panel';
/** Attribute the tile bar exposes its tab key on. */
const KEY_ATTRIBUTE = 'data-panel-key';

const HORIZONTAL = 'HORIZONTAL' as Orientation;
const VERTICAL = 'VERTICAL' as Orientation;

// dockview-core does not export its group view state; derive it from the grid.
type GroupViewState =
  SerializedDockview['grid']['root'] extends SerializedGridObject<infer T> ? T : never;
type GridNode = SerializedGridObject<GroupViewState>;

/** The dock's size in px. */
export interface DockSize {
  width: number;
  height: number;
}

export interface SerializeOptions {
  /** Stored per-panel state by key (as `api.toJSON().panels`); kept for every key. */
  panels?: Readonly<Record<string, GroupviewPanelState>>;
  /** State for a key with no stored entry (merged over `{id, contentComponent}`). */
  newPanel?: (key: string) => Partial<GroupviewPanelState>;
  /** The group to make active (a tile id); ignored when no tile has it. */
  activeTile?: string | null;
}

// --- serializer -----------------------------------------------------------------

function panelEntry(key: string, options: SerializeOptions): GroupviewPanelState {
  const stored = options.panels?.[key];
  const base: GroupviewPanelState = stored
    ? { ...stored }
    : { id: key, contentComponent: PLACEHOLDER_COMPONENT, ...options.newPanel?.(key) };
  return { ...base, id: key, minimumWidth: MIN_TILE_PX, minimumHeight: MIN_TILE_PX };
}

function leafOf(tile: Tile, size: number): GridNode {
  return {
    type: 'leaf',
    data: { views: [...tile.tabs], activeView: tile.showing, id: tile.tile },
    size,
  };
}

/**
 * A node laid out over `span` px along its parent's axis, its children over the
 * `orthogonal` span along `axis` (the axis this node lays its items along).
 */
function nodeOf(node: Layout, size: number, rect: DockSize): GridNode {
  if (isTile(node)) return leafOf(node, size);
  const axis: Axis = axisOf(node.split);
  const span = axis === 'width' ? rect.width : rect.height;
  const minimums = node.items.map((item) => minimumSize(item, axis, MIN_TILE_PX));
  const sizes = layoutSizes(itemFractions(node.items), span, minimums);
  const data = node.items.map((item, i) => {
    const px = sizes[i]!;
    const child: DockSize = axis === 'width' ? { ...rect, width: px } : { ...rect, height: px };
    return nodeOf(item, px, child);
  });
  return { type: 'branch', data, size };
}

/**
 * The SerializedDockview for a layout tree on a dock of `dockPx`; `null` is the empty
 * dock. The input is normalised first and never mutated.
 */
export function toSerialized(
  layout: Layout | null,
  dockPx: DockSize,
  options: SerializeOptions = {}
): SerializedDockview {
  const width = Math.max(0, Math.round(dockPx.width));
  const height = Math.max(0, Math.round(dockPx.height));
  const rect = { width, height };
  const tree = layout === null ? null : normalize(layout);

  let root: GridNode;
  let orientation = HORIZONTAL;
  if (tree === null) {
    root = { type: 'branch', data: [] };
  } else if (isTile(tree)) {
    // dockview's fromJSON throws unless the root is a branch.
    root = { type: 'branch', data: [leafOf(tree, width)], size: height };
  } else {
    orientation = tree.split === 'row' ? HORIZONTAL : VERTICAL;
    // The root branch's `size` is its extent across its own axis.
    root = nodeOf(tree, tree.split === 'row' ? height : width, rect);
  }

  const panels: Record<string, GroupviewPanelState> = {};
  const tiles: Tile[] = [];
  const visit = (node: Layout): void => {
    if (isTile(node)) tiles.push(node);
    else node.items.forEach(visit);
  };
  if (tree !== null) visit(tree);
  for (const tile of tiles) for (const key of tile.tabs) panels[key] = panelEntry(key, options);

  const serialized: SerializedDockview = {
    grid: { root, width, height, orientation },
    panels,
  };
  const active = options.activeTile;
  if (active != null && tiles.some((t) => t.tile === active)) serialized.activeGroup = active;
  return serialized;
}

// --- focus ------------------------------------------------------------------------

/** What had keyboard focus before a rebuild. */
interface SavedFocus {
  element: HTMLElement;
  /** Set when the element is a tile-bar tab: its key and the tile (group) it was in. */
  bar: { key: string; tile: string | null } | null;
}

function dockElementOf(api: DockviewApi, target: Element): string | null {
  for (const group of api.groups) {
    if (group.element.contains(target)) return group.id;
  }
  return null;
}

function saveFocus(api: DockviewApi): SavedFocus | null {
  const active = typeof document === 'undefined' ? null : document.activeElement;
  if (!(active instanceof HTMLElement) || active === document.body) return null;
  const barElement = active.closest<HTMLElement>(`[${KEY_ATTRIBUTE}]`);
  const inDock = barElement !== null && dockElementOf(api, barElement) !== null;
  const key = inDock ? barElement.getAttribute(KEY_ATTRIBUTE) : null;
  return {
    element: active,
    bar: key !== null ? { key, tile: dockElementOf(api, barElement!) } : null,
  };
}

/** The bar for `key` inside group `tile`, once its portal is mounted. */
function barIn(api: DockviewApi, tile: string, key: string): HTMLElement | null {
  const group = api.groups.find((g) => g.id === tile);
  if (!group) return null;
  for (const element of group.element.querySelectorAll<HTMLElement>(`[${KEY_ATTRIBUTE}]`)) {
    if (element.getAttribute(KEY_ATTRIBUTE) === key) return element;
  }
  return null;
}

/** Where focus should go after the rebuild, as (tile, key); null when nowhere. */
function focusTarget(
  saved: SavedFocus,
  layout: Layout | null
): { tile: string; key: string } | null {
  if (!saved.bar) return null;
  const { key, tile } = saved.bar;
  const was = tile === null ? null : findTile(layout, tile);
  if (was && was.tabs.includes(key)) return { tile: was.tile, key };
  const holder = tileOf(layout, key);
  if (holder) return { tile: holder.tile, key: holder.showing };
  // The key is gone (closed): the neighbour now showing in its old tile.
  if (was) return { tile: was.tile, key: was.showing };
  return null;
}

/** How many macrotask turns the restore waits for the rebuilt portals. */
const RESTORE_TURNS = 10;

function restoreFocus(
  api: DockviewApi,
  saved: SavedFocus,
  layout: Layout | null
): Promise<boolean> {
  if (!saved.bar) {
    // Not a tab (the terminal's xterm, the overlay content): it lives outside the
    // rebuilt tabs, so it only needs focus back if the rebuild took it.
    if (!saved.element.isConnected) return Promise.resolve(false);
    if (document.activeElement !== saved.element) saved.element.focus({ preventScroll: true });
    return Promise.resolve(true);
  }
  const target = focusTarget(saved, layout);
  if (!target) return Promise.resolve(false);
  const attempt = (): boolean => {
    const bar = barIn(api, target.tile, target.key);
    if (!bar) return false;
    bar.focus({ preventScroll: true });
    return true;
  };
  if (attempt()) return Promise.resolve(true);
  // The bars come back through React portals after the registry re-registers.
  return new Promise((resolve) => {
    let turns = 0;
    const retry = () => {
      // Someone else moved focus meanwhile: leave it.
      const current = document.activeElement;
      if (current && current !== document.body && current.isConnected) return resolve(false);
      if (attempt()) return resolve(true);
      if (++turns >= RESTORE_TURNS) return resolve(false);
      setTimeout(retry, 0);
    };
    queueMicrotask(retry);
  });
}

// --- apply ------------------------------------------------------------------------

export interface ApplyOptions extends Omit<SerializeOptions, 'panels'> {
  /**
   * Runs `fromJSON` for the serialized layout; the bridge passes its own
   * `applyLayout(serialized)` so the apply runs under its `applying` guard.
   * Defaults to `api.fromJSON`.
   */
  apply?: (serialized: SerializedDockview) => void;
  /** The dock's size; defaults to dockview's own width and height. */
  dockPx?: DockSize;
}

/**
 * Apply a layout tree to the dock: `fromJSON(toSerialized(...))` under the caller's
 * guard, keeping every panel's stored state and keyboard focus. Resolves to whether
 * focus was restored (false too when nothing in the dock had it).
 */
export function applyLayout(
  api: DockviewApi,
  layout: Layout | null,
  options: ApplyOptions = {}
): Promise<boolean> {
  const { apply, dockPx, ...serializeOptions } = options;
  const saved = saveFocus(api);
  const serialized = toSerialized(layout, dockPx ?? { width: api.width, height: api.height }, {
    ...serializeOptions,
    panels: api.toJSON().panels,
  });
  if (apply) apply(serialized);
  else api.fromJSON(serialized);
  return saved
    ? restoreFocus(api, saved, layout === null ? null : normalize(layout))
    : Promise.resolve(false);
}
