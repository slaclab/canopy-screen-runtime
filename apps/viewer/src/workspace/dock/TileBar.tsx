// The tile bar: one bar per tile, listing the tile's tabs. It is
// mounted as the group's prefix header action (tabAdapter), so dockview's own per-panel tabs
// are hidden and N tabs never give N bars. The showing tab's header controls and the window
// menu (☰) slot are not in the bar: `TileActions` renders them in the right header actions.
//
// Parts, left to right:
// - the **grip**, HTML5-draggable, which starts a drag of the whole tile (`{tile: id}`), so
//   every tile has a handle however many tabs it holds;
// - one **tab** per key, HTML5-draggable (`{tab: key}`), each with its own ×. The showing tab
//   is marked (`aria-selected`, `--showing`). A click shows a tab (`onShow`); its × closes it
//   (`onCloseTab`). Both drags start through `dockDragStart`, the helper the strip uses too.
//
// Keyboard (WAI-ARIA tabs, automatic activation): the bar is a `tablist` and the tile's one
// tab stop; the showing tab is its `aria-activedescendant`. ArrowLeft/ArrowRight (wrapping),
// Home and End show another tab; Delete or Backspace closes the showing tab; Enter or
// ArrowDown moves focus into the tile's panel root. Because focus stays on the bar root,
// `data-panel-key` on the root names the showing tab, which is what focus wiring
// (useTileFocus, applyLayout's focus restore) looks for.
//
// The listeners are native (`addEventListener`), not React handlers: the bar is portalled,
// and React's synthetic handlers run at the React root, after dockview's own listeners.
// Interactive children stop `pointerdown` natively so a button never starts a drag. Nothing
// the bar renders floats: no popover, no dialog, plain native `title`s.
//
// Sharing the header row: the bar sits in dockview's prefix container and the actions in its
// right container, and neither container is ours to style. So the shares are measured here
// (`shareTileHeader`) and handed to TileBar.css as two custom properties on our own elements.
// The tabs come first: each tab is 96 to 220 px wide, and the tab list takes its own width,
// up to what leaves the showing screen's header its floor (◀ ▶, the zoom button and "⋯");
// several tabs take no more than half the row; one tab always fits. Tabs that do not fit
// scroll sideways in the list, which keeps the showing tab, × included, in view whenever it,
// the tabs or the sizes change; a vertical wheel scrolls it sideways. The actions take the
// rest, and a screen header under them (`TileHeaderContext`) collapses within that lane in
// the tile's order (ScreenHeader.tsx).
//
// The focused hairline is painted only when `focused && multiTile && documentFocused`:
// one tile alone, or a window without focus, shows no focus mark.
// Focus: a press or a focus move anywhere in the bar reports `onFocus(panelKey)` from
// the capture phase, so it also runs for the buttons whose `pointerdown` is stopped.
//
// `measureTabRects` reads every mounted bar's rect and its tabs' rects for hit testing.
import { createContext, useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';
import {
  bindTileFocus,
  focusTilePanel,
  tilePanelId,
  tileTitleId,
  type TileFocusHandler,
} from './useTileFocus.js';
import { TILE_BAR_INTERACTIVE, dockDragStart } from './tabAdapter.js';
import type { TabRects } from '@slaclab/canopy-dock-engine';
import './TileBar.css';

export { TILE_BAR_INTERACTIVE };

/** A tab's × tooltip. */
export const TILE_TAB_CLOSE_TITLE = 'Close tab';

/** The grip's tooltip. */
export const TILE_GRIP_TITLE = 'Drag to move this tile';

/** Keys that never travel past the bar (dockview acts on them further up). */
const STOPPED_KEYS = new Set(['Delete', 'Backspace', 'Enter', ' ']);

/** Keys that move keyboard focus from the bar into its tile. */
const ENTER_TILE_KEYS = new Set(['Enter', 'ArrowDown']);

/** Keys that close the showing tab. */
const CLOSE_KEYS = new Set(['Delete', 'Backspace']);

/** How a screen header fits a tile's header slot. */
export interface TileHeaderFit {
  /** The "More controls" button's width in a tile; TileBar.css sets it (px). */
  triggerPx: number;
  /** The compact zoom button ("41 % ▾") width in a tile; TileBar.css sets it (px). */
  zoomButtonPx: number;
  /**
   * The header's floor: what it keeps in the bar at its narrowest ordinary step (◀ ▶, the zoom
   * button and "⋯"); 0 when it needs nothing (it unmounted). Set per tile by `TileActions`.
   */
  reportNeed?(px: number): void;
}

/** The tile header's fit: TileBar.css gives the two buttons these widths. */
export const TILE_HEADER_FIT: Readonly<TileHeaderFit> = Object.freeze({
  triggerPx: 32,
  zoomButtonPx: 72,
});

/** Set by `TileActions` around its header slot; null (a standalone header) elsewhere. */
export const TileHeaderContext = createContext<Readonly<TileHeaderFit> | null>(null);

/** The least the tab list keeps: the grip (20 px), the bar's 4 px padding and one 96 px tab. */
export const TILE_TABS_MIN_PX = 120;

/** The custom property TileBar.css caps the right header actions with (px). */
export const TILE_ACTIONS_CAP = '--canopy-tile-actions-cap';

/** The custom property TileBar.css caps the bar with (px). */
export const TILE_BAR_CAP = '--canopy-tile-bar-cap';

/**
 * The shares of a tile's header row `width`, in whole pixels. The tab list keeps its natural
 * width (`tabs`) up to what leaves the header its `floor`, and with several tabs (`lone`
 * false) or no floor (a tool's controls) no more than half the row; never less than
 * `TILE_TABS_MIN_PX`. The actions may take what the tab list leaves; the bar takes what the
 * actions, `actions` wide, leave.
 */
export function tileHeaderCaps(
  width: number,
  tabs: number,
  actions: number,
  floor = 0,
  lone = false
): { actions: number; bar: number } {
  const room = width - floor;
  const share = floor > 0 && lone ? room : Math.min(room, width / 2);
  const list = Math.min(tabs, Math.max(TILE_TABS_MIN_PX, share));
  return {
    actions: Math.max(0, Math.floor(width - list)),
    bar: Math.max(0, Math.floor(width - actions)),
  };
}

/**
 * The scroll offset that shows a tab `tabLeft`..`tabLeft + tabWidth` (list content
 * coordinates) in a list `view` wide scrolled to `scrollLeft`. A tab wider than the view keeps
 * its right end, where its × is, in view.
 */
export function revealScrollLeft(
  scrollLeft: number,
  view: number,
  tabLeft: number,
  tabWidth: number
): number {
  const right = tabLeft + tabWidth;
  if (tabWidth > view) return right - view;
  if (tabLeft < scrollLeft) return tabLeft;
  if (right > scrollLeft + view) return right - view;
  return scrollLeft;
}

/** The least and most a tab is wide (TileBar.css). */
export const TAB_MIN_PX = 96;
export const TAB_MAX_PX = 220;

/**
 * The width `list`'s tabs take side by side with nothing squeezing them: each tab its whole
 * title and chrome, clamped to TAB_MIN_PX..TAB_MAX_PX. Read from each title's own text width,
 * so a list the row squeezes now still measures what it would take.
 */
function naturalTabs(list: HTMLElement): number {
  let total = 0;
  for (const tab of list.querySelectorAll<HTMLElement>('.canopy-tile-bar__tab')) {
    const title = tab.querySelector<HTMLElement>('.canopy-tile-bar__title');
    const chrome = tab.offsetWidth - (title?.clientWidth ?? 0);
    // scrollWidth rounds down: 2 px more keeps a title that just fits from ellipsizing.
    const natural = chrome + (title?.scrollWidth ?? 0) + 2;
    total += Math.min(TAB_MAX_PX, Math.max(TAB_MIN_PX, Math.ceil(natural)));
  }
  return total;
}

/** Writes a px custom property only when it changes, so a resize observer sees no echo. */
function setCap(element: HTMLElement, name: string, px: number) {
  const value = `${px}px`;
  if (element.style.getPropertyValue(name) !== value) element.style.setProperty(name, value);
}

/** The bar of a header row: the one in the prefix, not one left in dockview's hidden tabs. */
function rowBar(row: Element): HTMLElement | null {
  for (const bar of row.querySelectorAll<HTMLElement>('.canopy-tile-bar')) {
    if (!bar.closest('.dv-tabs-container')) return bar;
  }
  return null;
}

/** The content width of `row`, or 0 when it is not laid out. */
function rowWidth(row: Element): number {
  const style = getComputedStyle(row);
  const pad = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
  return row.clientWidth - pad;
}

/**
 * Sizes the bar and the right header actions of the header row holding `element` (the bar or
 * the actions) so they share it without overlapping. A no-op outside a dockview
 * header row or before it is laid out.
 */
export function shareTileHeader(element: Element): void {
  const row = element.closest(GROUP_HEADER);
  if (!row) return;
  const bar = rowBar(row);
  const width = rowWidth(row);
  if (!bar || width <= 0) return;
  const list = bar.querySelector<HTMLElement>('.canopy-tile-bar__tabs');
  const tabs = list ? bar.offsetWidth - list.clientWidth + naturalTabs(list) : bar.scrollWidth;
  const actions = row.querySelector<HTMLElement>('.canopy-tile-bar__actions');
  if (!actions) {
    setCap(bar, TILE_BAR_CAP, Math.floor(width));
    return;
  }
  // A header's floor is its slot's; the actions add the ☰ slot, gap and padding.
  const headerFloor = Number(actions.dataset.headerNeed) || 0;
  const slot = actions.querySelector('.canopy-tile-bar__header');
  const extras = slot
    ? actions.getBoundingClientRect().width - slot.getBoundingClientRect().width
    : 0;
  const lone = (list?.querySelectorAll('[role="tab"]').length ?? 0) <= 1;
  const floor = headerFloor > 0 ? Math.ceil(headerFloor + Math.max(0, extras)) : 0;
  // The actions' cap first: their width under it is what the bar's cap is read from.
  setCap(actions, TILE_ACTIONS_CAP, tileHeaderCaps(width, tabs, 0, floor, lone).actions);
  const used = Math.ceil(actions.getBoundingClientRect().width);
  setCap(bar, TILE_BAR_CAP, tileHeaderCaps(width, tabs, used).bar);
}

/** Scrolls `list` so its showing tab, × included, is in view; never scrolls the page. */
function revealShowing(list: HTMLElement): void {
  const tab = list.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
  if (!tab || list.clientWidth <= 0 || list.scrollWidth <= list.clientWidth) {
    if (tab && list.scrollLeft !== 0 && list.scrollWidth <= list.clientWidth) list.scrollLeft = 0;
    return;
  }
  const r = tab.getBoundingClientRect();
  const left = r.left - list.getBoundingClientRect().left + list.scrollLeft;
  const next = revealScrollLeft(list.scrollLeft, list.clientWidth, left, r.width);
  if (next !== list.scrollLeft) list.scrollLeft = next;
}

/**
 * Keeps the header row holding `element` shared while it, `element` or the tab list resize.
 * Returns the disconnect.
 */
function observeHeaderRow(element: HTMLElement, after?: () => void): () => void {
  if (typeof ResizeObserver === 'undefined') return () => {};
  const observer = new ResizeObserver(() => {
    shareTileHeader(element);
    after?.();
  });
  observer.observe(element);
  const row = element.closest(GROUP_HEADER);
  if (row) observer.observe(row);
  return () => observer.disconnect();
}

/** The tile focus a mounted bar reports: its showing tab and its `onFocus`. */
interface BarFocus {
  key: string;
  onFocus?: TileFocusHandler;
}

/** Each mounted bar root's focus, read by its tile's `TileActions` at gesture time. */
const barFocus = new WeakMap<Element, () => BarFocus>();

/** The dockview header that holds both a tile's bar (prefix) and its actions (right). */
const GROUP_HEADER = '.dv-tabs-and-actions-container';

/** The bar of `tile` in the dockview header around `el`, or anywhere in its dock. */
function barOf(el: Element, tile: string): Element | null {
  for (const scope of [el.closest(GROUP_HEADER), el.closest('.dv-dockview')]) {
    if (!scope) continue;
    for (const bar of scope.querySelectorAll<HTMLElement>('.canopy-tile-bar[data-tile]')) {
      if (bar.dataset.tile === tile) return bar;
    }
  }
  return null;
}

/** The hairline needs all three flags: focused, two or more tiles, document focused. */
export function tileBarHairline(
  focused: boolean,
  multiTile: boolean,
  documentFocused: boolean
): boolean {
  return focused && multiTile && documentFocused;
}

/**
 * Whether tiles carry a bar at all, the same embedded in a host page and standalone: one tile
 * shows its tabs in the strip row and has no bar; two or more tiles each have a bar and the
 * strip is gone.
 */
export function tileBarsShown(tileCount: number): boolean {
  return tileCount >= 2;
}

/** The DOM id of the bar tab of `key` (the bar's `aria-activedescendant`). */
export function tileTabId(key: string): string {
  return tileTitleId(key).replace(/^canopy-tile-title-/, 'canopy-tile-tab-');
}

export interface TileBarTab {
  key: string;
  title: string;
}

export interface TileBarProps {
  /** The tile id (the dockview group id); the grip drags it. Without it there is no grip. */
  tile?: string;
  /** The tile's tabs in order; defaults to the one tab `panelKey`/`title`. */
  tabs?: readonly TileBarTab[];
  /** The showing tab's key; exposed as `data-panel-key` for focus wiring. */
  panelKey: string;
  /** The showing tab's title (used when `tabs` is not given). */
  title: string;
  focused: boolean;
  /** Two or more tiles are open. */
  multiTile: boolean;
  /** The document (the CANOPY frame) has focus. */
  documentFocused: boolean;
  /** A tab was clicked or chosen by keyboard: show `key` in this tile. */
  onShow?: (key: string) => void;
  /** A tab's × or Delete on the bar: close `key`. */
  onCloseTab?: (key: string) => void;
  /** The one-tab form without `onCloseTab`: the × closes the tile. */
  onRemove?: () => void;
  /** A press or a focus move landed in this bar: the tile of `key` is the focused one. */
  onFocus?: TileFocusHandler;
}

/** Inline Carbon "Close" glyph, as the tab strip draws it. */
function CloseIcon() {
  return (
    <svg viewBox="0 0 32 32" width="12" height="12" fill="currentColor" aria-hidden="true">
      <path d="M17.4141 16 24 9.4141 22.5859 8 16 14.5859 9.4143 8 8 9.4141 14.5859 16 8 22.5859 9.4143 24 16 17.4141 22.5859 24 24 22.5859 17.4141 16z" />
    </svg>
  );
}

/** Inline Carbon "Draggable" glyph. */
function GripIcon() {
  return (
    <svg viewBox="0 0 32 32" width="12" height="12" fill="currentColor" aria-hidden="true">
      <path d="M10 6h4v4h-4zm8 0h4v4h-4zm-8 8h4v4h-4zm8 0h4v4h-4zm-8 8h4v4h-4zm8 0h4v4h-4z" />
    </svg>
  );
}

/** The key `step` tabs away from `current` (wrapping), or the first/last for Home/End. */
function nextKey(keys: readonly string[], current: string, key: string): string | null {
  if (keys.length === 0) return null;
  if (key === 'Home') return keys[0]!;
  if (key === 'End') return keys[keys.length - 1]!;
  const at = Math.max(0, keys.indexOf(current));
  if (key === 'ArrowRight') return keys[(at + 1) % keys.length]!;
  if (key === 'ArrowLeft') return keys[(at - 1 + keys.length) % keys.length]!;
  return null;
}

export function TileBar({
  tile,
  tabs,
  panelKey,
  title,
  focused,
  multiTile,
  documentFocused,
  onShow,
  onCloseTab,
  onRemove,
  onFocus,
}: TileBarProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const list: readonly TileBarTab[] = tabs ?? [{ key: panelKey, title }];
  const closeTab = (key: string) => {
    if (onCloseTab) onCloseTab(key);
    else onRemove?.();
  };
  // The native listeners read the latest props through a ref.
  const latest = useRef({ onFocus, onShow, closeTab, keys: list.map((t) => t.key), panelKey });
  useLayoutEffect(() => {
    latest.current = { onFocus, onShow, closeTab, keys: list.map((t) => t.key), panelKey };
  });

  // After every render (a tab added, closed, renamed or shown): share the row again, then
  // bring the showing tab into view.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (root) shareTileHeader(root);
    if (listRef.current) revealShowing(listRef.current);
  });

  useEffect(() => {
    const root = rootRef.current;
    const tabList = listRef.current;
    if (!root || !tabList) return;
    const reveal = () => revealShowing(tabList);
    const unobserve = observeHeaderRow(root, reveal);
    // A vertical wheel (most mice) scrolls an overflowing tab list sideways.
    const onWheel = (event: WheelEvent) => {
      if (tabList.scrollWidth <= tabList.clientWidth) return;
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      event.preventDefault();
      tabList.scrollLeft += event.deltaY;
    };
    tabList.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      unobserve();
      tabList.removeEventListener('wheel', onWheel);
    };
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      const hit = target?.closest?.(TILE_BAR_INTERACTIVE);
      if (hit && root.contains(hit)) event.stopPropagation();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (STOPPED_KEYS.has(event.key)) event.stopPropagation();
      if (event.target !== root) return;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const now = latest.current;
      if (ENTER_TILE_KEYS.has(event.key)) {
        // ArrowDown would otherwise scroll the page under the dock.
        if (focusTilePanel(now.panelKey)) event.preventDefault();
        return;
      }
      if (CLOSE_KEYS.has(event.key)) {
        event.preventDefault();
        now.closeTab(now.panelKey);
        return;
      }
      const next = nextKey(now.keys, now.panelKey, event.key);
      if (next === null) return;
      event.preventDefault();
      if (next !== now.panelKey) now.onShow?.(next);
    };
    const onDragStart = (event: DragEvent) => {
      const target = event.target as Element | null;
      const grip = target?.closest?.('.canopy-tile-bar__grip');
      const tab = target?.closest?.<HTMLElement>('.canopy-tile-bar__tab');
      if (grip && root.contains(grip) && root.dataset.tile !== undefined) {
        dockDragStart({ tile: root.dataset.tile }, event.dataTransfer);
      } else if (tab && root.contains(tab) && tab.dataset.tabKey !== undefined) {
        dockDragStart({ tab: tab.dataset.tabKey }, event.dataTransfer);
      }
    };
    const unbindFocus = bindTileFocus(root, panelKey, () => latest.current.onFocus);
    barFocus.set(root, () => ({ key: latest.current.panelKey, onFocus: latest.current.onFocus }));
    root.addEventListener('pointerdown', onPointerDown);
    root.addEventListener('keydown', onKeyDown);
    root.addEventListener('dragstart', onDragStart);
    return () => {
      unbindFocus();
      barFocus.delete(root);
      root.removeEventListener('pointerdown', onPointerDown);
      root.removeEventListener('keydown', onKeyDown);
      root.removeEventListener('dragstart', onDragStart);
    };
  }, [panelKey]);

  const className = tileBarHairline(focused, multiTile, documentFocused)
    ? 'canopy-tile-bar canopy-tile-bar--focused'
    : 'canopy-tile-bar';

  return (
    <div
      ref={rootRef}
      className={className}
      role="tablist"
      aria-orientation="horizontal"
      aria-label="Tile tabs"
      aria-activedescendant={tileTabId(panelKey)}
      tabIndex={0}
      data-panel-key={panelKey}
      data-tile={tile}
      data-testid="tile-bar"
    >
      {tile !== undefined && (
        <span
          className="canopy-tile-bar__grip"
          draggable={true}
          title={TILE_GRIP_TITLE}
          aria-hidden="true"
        >
          <GripIcon />
        </span>
      )}
      <div ref={listRef} className="canopy-tile-bar__tabs">
        {list.map((tab) => {
          const showing = tab.key === panelKey;
          return (
            <div
              key={tab.key}
              id={tileTabId(tab.key)}
              role="tab"
              aria-selected={showing}
              aria-controls={tilePanelId(tab.key)}
              className={
                showing
                  ? 'canopy-tile-bar__tab canopy-tile-bar__tab--showing'
                  : 'canopy-tile-bar__tab'
              }
              draggable={true}
              data-tab-key={tab.key}
              title={tab.title}
              onClick={() => {
                if (!showing) onShow?.(tab.key);
              }}
            >
              <span id={tileTitleId(tab.key)} className="canopy-tile-bar__title">
                {tab.title}
              </span>
              <button
                type="button"
                className="canopy-tile-bar__close"
                tabIndex={-1}
                title={TILE_TAB_CLOSE_TITLE}
                aria-label={`${TILE_TAB_CLOSE_TITLE}: ${tab.title}`}
                onClick={(event) => {
                  event.stopPropagation();
                  closeTab(tab.key);
                }}
              >
                <CloseIcon />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Records a header's need (0: none) on its actions; true when that changed it. */
function applyNeed(actions: HTMLElement, px: number): boolean {
  const value = px > 0 ? String(px) : undefined;
  if (actions.dataset.headerNeed === value) return false;
  if (value === undefined) delete actions.dataset.headerNeed;
  else actions.dataset.headerNeed = value;
  return true;
}

export interface TileActionsProps {
  tile: string;
  /** The showing tab's own header controls (the screen header, a tool's actions). */
  header?: ReactNode;
  /** The window menu (☰) slot; filled only on the tile at the dock's top-right corner. */
  menu?: ReactNode;
  /** The showing tab's key; defaults to the one the tile's bar shows. */
  panelKey?: string;
  /** A press or a focus move landed in these actions; defaults to the tile's bar's. */
  onFocus?: TileFocusHandler;
}

/**
 * The right header actions of a tile: the showing tab's controls, then the ☰ slot.
 *
 * Focus: a press or a focus move in the header slot focuses their tile, exactly as
 * one in the bar does (the ☰ slot is window-wide and never moves the focused tile), so a header control of an unfocused tile (its zoom, Save view, an action
 * reached by Tab) acts on a tile that is then the focused one. Without its own `panelKey`
 * and `onFocus` the actions report through the tile's bar, found in the same dockview
 * header, which renders beside them.
 */
export function TileActions({ tile, header, menu, panelKey, onFocus }: TileActionsProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  // The header slot's fit: the tile's, plus where its screen header reports its need. A
  // report before this root is attached (a child's layout effect) is applied by ours below.
  const need = useRef(0);
  const fit = useMemo<TileHeaderFit>(
    () => ({
      ...TILE_HEADER_FIT,
      reportNeed(px: number) {
        need.current = px > 0 ? Math.ceil(px) : 0;
        const root = rootRef.current;
        if (root && applyNeed(root, need.current)) shareTileHeader(root);
      },
    }),
    []
  );
  const latest = useRef({ tile, panelKey, onFocus });
  useLayoutEffect(() => {
    latest.current = { tile, panelKey, onFocus };
    // The actions' content changed (a screen header, a tool's buttons, the ☰): share again.
    if (rootRef.current) {
      applyNeed(rootRef.current, need.current);
      shareTileHeader(rootRef.current);
    }
  });
  useEffect(() => {
    const root = rootRef.current;
    return root ? observeHeaderRow(root) : undefined;
  }, []);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onPointerDown = (event: PointerEvent) => {
      const hit = (event.target as Element | null)?.closest?.(TILE_BAR_INTERACTIVE);
      if (hit && root.contains(hit)) event.stopPropagation();
    };
    const onGesture = (event: Event) => {
      // Only the header slot is the tile's: the ☰ menu slot is window-wide, so a
      // press or a focus return on it must leave the focused tile where it is.
      const target = event.target instanceof Node ? event.target : null;
      const element = target instanceof Element ? target : target?.parentElement;
      const header = element?.closest('.canopy-tile-bar__header');
      if (!header || !root.contains(header)) return;
      const now = latest.current;
      const bar = now.panelKey !== undefined && now.onFocus ? null : barOf(root, now.tile);
      const fromBar = bar ? barFocus.get(bar)?.() : undefined;
      const key = now.panelKey ?? fromBar?.key;
      const handler = now.onFocus ?? fromBar?.onFocus;
      if (key !== undefined) handler?.(key);
    };
    // Capture, so the buttons whose `pointerdown` is stopped still report.
    root.addEventListener('pointerdown', onGesture, true);
    root.addEventListener('focusin', onGesture, true);
    root.addEventListener('pointerdown', onPointerDown);
    return () => {
      root.removeEventListener('pointerdown', onGesture, true);
      root.removeEventListener('focusin', onGesture, true);
      root.removeEventListener('pointerdown', onPointerDown);
    };
  }, []);
  return (
    <div
      ref={rootRef}
      className="canopy-tile-bar__actions"
      data-tile={tile}
      data-testid="tile-actions"
    >
      {header !== undefined && (
        <div className="canopy-tile-bar__header">
          <TileHeaderContext.Provider value={fit}>{header}</TileHeaderContext.Provider>
        </div>
      )}
      {menu !== undefined && <div className="canopy-tile-bar__menu">{menu}</div>}
    </div>
  );
}

function rectOf(element: Element): { x: number; y: number; width: number; height: number } {
  const r = element.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}

/** dockview-core 7.0.2's header row: the tile bar's lane and the actions lane side by side. */
export const HEADER_ROW = '.dv-tabs-and-actions-container';

/**
 * The bar and tab rects of every mounted tile bar under `scope`, keyed by tile id, in client
 * coordinates (the `TabRects` input of `hitTest`). The bar rect is the tile's whole header
 * row (tabs and the screen's toolbar), one drop target; the bar alone when it has no row.
 * With one tile the strip stands in for the bar; the strip measures itself.
 */
export function measureTabRects(scope: ParentNode = document): TabRects {
  const rects: TabRects = {};
  for (const bar of scope.querySelectorAll<HTMLElement>('.canopy-tile-bar[data-tile]')) {
    const tile = bar.dataset.tile;
    if (tile === undefined || !bar.isConnected || tile in rects) continue;
    rects[tile] = {
      barRect: rectOf(bar.closest(HEADER_ROW) ?? bar),
      tabRects: [...bar.querySelectorAll('.canopy-tile-bar__tab')].map(rectOf),
    };
  }
  return rects;
}
