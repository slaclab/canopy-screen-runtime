// Tile focus wiring: which tile the user is working in, told to the
// tabs reducer as `focus(key)`. The reducer's layout holder is the one source of tile
// focus: `tabPlacement` reads which key shows and which tile is focused from it, and
// nothing here listens to dockview's active group, which a `fromJSON` rebuild resets.
//
// The listeners are native DOM listeners, never React props. A React portal (the
// workspace toast column) bubbles its synthetic events to its React ancestors, so a
// React `onPointerDown` on a tile would also fire for a toast that sits outside the tile;
// a native listener only sees events that pass through the element, and the containment
// check below makes that explicit. They run in the capture phase and neither prevent nor
// stop the event, so one click both focuses the tile and reaches the control under the
// pointer.
//
// Nothing is dispatched for an overlay item that is not shown in a tile
// (`data-placed="false"`, written by useTileRect): a hidden tab takes no gesture, and the
// reducer's `focus` on it would switch its tile to it.
import { createContext, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { tileOf } from '@slaclab/canopy-dock-engine';
import type { Layout } from '@slaclab/canopy-dock-engine';

export type TileFocusHandler = (key: string) => void;

/** Carries the overlay's focus handler from `<DockOverlay>` to its items. */
export const TileFocusContext = createContext<TileFocusHandler | undefined>(undefined);

const OVERLAY_ITEM = '.canopy-dock-overlay__item';
const TILE_BAR = '.canopy-tile-bar';

/** Controls that give Escape a meaning of their own (cancel an edit, close a list). */
const ESCAPE_OWNERS =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [aria-expanded="true"]';
/** A dialog that is open inside a tile owns Escape. */
const OPEN_DIALOGS = '.cds--modal.is-visible, dialog[open]';

/** Tab keys hold `/`, `?`, `=` and `&`; every other character becomes `_<hex>_`. */
function domSafe(key: string): string {
  return key.replace(/[^A-Za-z0-9-]/g, (char) => `_${char.codePointAt(0)!.toString(16)}_`);
}

/** The DOM id of the overlay panel root of `key`; the tile bar `aria-controls` it. */
export function tilePanelId(key: string): string {
  return `canopy-tile-panel-${domSafe(key)}`;
}

/** The DOM id of the tile bar title of `key`; the panel root is labelled by it. */
export function tileTitleId(key: string): string {
  return `canopy-tile-title-${domSafe(key)}`;
}

/** Where a key stands in the layout holder. */
export interface TabPlacement {
  /** The tile holding the key, or null when it has none. */
  tile: string | null;
  /** The key is its tile's showing tab: placed, visible and taking input. */
  showing: boolean;
  /** The key is the showing tab of the focused tile. */
  focused: boolean;
}

/** Reads `key`'s placement from the holder's layout and focused tile. */
export function tabPlacement(
  layout: Layout | null,
  focusedTile: string | null,
  key: string
): TabPlacement {
  const tile = tileOf(layout, key);
  const showing = tile !== null && tile.showing === key;
  return {
    tile: tile?.tile ?? null,
    showing,
    focused: showing && focusedTile !== null && tile.tile === focusedTile,
  };
}

function isPlaced(el: HTMLElement): boolean {
  return el.dataset.placed !== 'false';
}

/**
 * Attaches the capture-phase `pointerdown` and `focusin` listeners to `el` and returns
 * their removal. `handler` is read on every event, so the caller may swap it freely.
 */
export function bindTileFocus(
  el: HTMLElement,
  key: string,
  handler: () => TileFocusHandler | undefined
): () => void {
  const onGesture = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof Node) || !el.contains(target)) return;
    if (!isPlaced(el)) return;
    handler()?.(key);
  };
  el.addEventListener('pointerdown', onGesture, true);
  el.addEventListener('focusin', onGesture, true);
  return () => {
    el.removeEventListener('pointerdown', onGesture, true);
    el.removeEventListener('focusin', onGesture, true);
  };
}

/**
 * Returns a callback ref for the root element of `key`'s tile part (an overlay panel root
 * or a tile bar): a pointer press or a focus move inside it calls `onFocus(key)`.
 */
export function useTileFocus(
  key: string,
  onFocus: TileFocusHandler | undefined
): (el: HTMLElement | null) => void {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const latest = useRef(onFocus);
  useLayoutEffect(() => {
    latest.current = onFocus;
  }, [onFocus]);

  useEffect(() => {
    if (!el) return;
    return bindTileFocus(el, key, () => latest.current);
  }, [el, key]);

  return setEl;
}

/** The connected tile bar of `key`. Dockview may hold several renderers for one panel. */
export function findTileBar(key: string): HTMLElement | null {
  for (const bar of document.querySelectorAll<HTMLElement>(`${TILE_BAR}[data-panel-key]`)) {
    if (bar.dataset.panelKey === key && bar.isConnected) return bar;
  }
  return null;
}

/**
 * Moves keyboard focus into the tile of `key`: its tool iframe when it has one, else its
 * panel root. Returns false when the key is not shown in a tile.
 */
export function focusTilePanel(key: string): boolean {
  const root = document.getElementById(tilePanelId(key));
  if (!root || !isPlaced(root)) return false;
  const target = root.querySelector<HTMLElement>('iframe') ?? root;
  target.focus();
  return true;
}

function placedItemOf(layer: HTMLElement, node: Element): HTMLElement | null {
  const item = node.closest<HTMLElement>(OVERLAY_ITEM);
  if (!item || !layer.contains(item) || !isPlaced(item)) return null;
  return item;
}

/**
 * The two window-level parts of tile focus, bound once per overlay layer.
 *
 * - A press inside an iframe never reaches this document, so the tile of a tool frame is
 *   found on window `blur`: the frame that took focus is `document.activeElement`.
 * - An Escape that nothing handled returns focus from a tile to its bar. "Handled" is read
 *   at the window, after every listener below it has run: the event was default-prevented
 *   (a dialog closing), stopped before it got here, or pressed in a control that gives
 *   Escape its own meaning. A tool frame has no such key: its keys stay inside the frame.
 */
export function useOverlayFocus(
  layerRef: RefObject<HTMLElement | null>,
  onFocus: TileFocusHandler | undefined
): void {
  const latest = useRef(onFocus);
  useLayoutEffect(() => {
    latest.current = onFocus;
  }, [onFocus]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    /** Dispatches for the focused tool frame; false while no frame of the layer has focus. */
    const focusFrameTile = (): boolean => {
      const layer = layerRef.current;
      const active = document.activeElement;
      if (!layer || !(active instanceof HTMLIFrameElement)) return false;
      const key = placedItemOf(layer, active)?.dataset.tabKey;
      if (key === undefined) return false;
      latest.current?.(key);
      return true;
    };
    const onBlur = (): void => {
      clearTimeout(timer);
      // Some browsers move `activeElement` to the frame only after `blur` has fired.
      if (!focusFrameTile()) timer = setTimeout(focusFrameTile, 0);
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
      const layer = layerRef.current;
      const target = event.target;
      if (!layer || !(target instanceof Element)) return;
      const item = placedItemOf(layer, target);
      const key = item?.dataset.tabKey;
      if (!item || key === undefined) return;
      if (target.closest(ESCAPE_OWNERS) || item.querySelector(OPEN_DIALOGS)) return;
      findTileBar(key)?.focus();
    };

    window.addEventListener('blur', onBlur);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [layerRef]);
}
