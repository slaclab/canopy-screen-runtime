// The viewer-owned overlay layer. The caller renders `<DockOverlay>` as the
// dock root's next sibling inside a positioned common parent; each panel's content renders
// once inside a `<DockOverlayItem>` keyed by its tab key, so a dockview move or resize only
// rewrites the item's inline geometry and never remounts what is inside it. An inner child
// whose own React key steps (a tool iframe on epoch or binding moves) remounts inside the
// stable item, which keeps its geometry binding.
//
// No stacking context: neither component writes z-index, transform or any other stacking
// property; geometry is inline top/left/width/height from useTileRect, everything else lives
// in dock.css. The drag shield is a class on the layer, never an inline pointer-events value.
//
// Drag shield: while a drag is in flight no overlay item takes pointer events, so
// `dragover` keeps reaching the dock and its drop targets instead of being swallowed by a
// screen or a tool frame (a frame never hands its events back to this document). The layer
// raises it for the caller's `dragging` flag (the bridge's own drags) and, on its own, for
// any native drag that starts outside the layer: a tile-bar tab, a strip tab, a tree row.
// A drag that starts inside a screen is that screen's own and leaves the shield down. The
// shield drops on `dragend` or `drop`, and on the next pointer event as a backstop for a
// source element that left the document mid-drag (its `dragend` never reaches us): a press,
// or a move with no button held, cannot happen while a drag is in flight, so either means
// the drag is over. A shield left up would leave every frame without input.
//
// Item order: the layer keeps its items in the order it has, and places only a new
// key by the caller's order, so a tile move that reorders the open keys never moves an item
// node; a moved iframe would reload.
//
// Focus: the layer takes one optional `onFocus(key)` and hands it to its items,
// each of which is the panel root of its tile: focusable from script only, named by its
// tile bar's title, and the element the bar `aria-controls`.
import {
  Children,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
  type RefObject,
} from 'react';
import {
  TileFocusContext,
  tilePanelId,
  tileTitleId,
  useOverlayFocus,
  useTileFocus,
  type TileFocusHandler,
} from './useTileFocus.js';
import { useTileRect, type TileRectApi } from './useTileRect.js';
import './dock.css';

export const OVERLAY_CLASS = 'canopy-dock-overlay';
export const OVERLAY_DRAGGING_CLASS = 'canopy-dock-overlay--dragging';
export const OVERLAY_ITEM_CLASS = 'canopy-dock-overlay__item';

export interface DockOverlayProps {
  /** True while a dock drag is in flight (DockBridge.dragging): shields every item. */
  dragging: boolean;
  /** A human gesture landed in the tile of `key`: a press, a focus move, a frame taking focus. */
  onFocus?: TileFocusHandler;
  children?: ReactNode;
}

/** Events that end a native drag, or prove one is no longer in flight. */
const DRAG_OVER_EVENTS = ['dragend', 'drop', 'pointerdown'] as const;

/**
 * True while a native drag that started outside `layerRef` is in flight. Listens on the
 * document in the capture phase, so a handler that stops propagation cannot hide the drag.
 */
export function useNativeDrag(layerRef: RefObject<HTMLElement | null>): boolean {
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    let active = false;
    const set = (next: boolean): void => {
      if (next === active) return;
      active = next;
      setDragging(next);
    };
    const onDragStart = (event: DragEvent): void => {
      const target = event.target;
      const layer = layerRef.current;
      if (layer && target instanceof Node && layer.contains(target)) return;
      set(true);
    };
    const onOver = (): void => set(false);
    const onMove = (event: PointerEvent): void => {
      if (event.buttons === 0) set(false);
    };
    document.addEventListener('dragstart', onDragStart, true);
    document.addEventListener('pointermove', onMove, true);
    for (const type of DRAG_OVER_EVENTS) document.addEventListener(type, onOver, true);
    return () => {
      document.removeEventListener('dragstart', onDragStart, true);
      document.removeEventListener('pointermove', onMove, true);
      for (const type of DRAG_OVER_EVENTS) document.removeEventListener(type, onOver, true);
    };
  }, [layerRef]);
  return dragging;
}

/**
 * `next` in the order of `previous`: keys still present keep their order among themselves, and
 * a new key goes right after the key before it in `next` (first, with none). Only new keys are
 * placed by the caller's order, so the overlay's item order never follows a reorder.
 */
export function stableOrder(previous: readonly string[], next: readonly string[]): string[] {
  const present = new Set(next);
  const order = previous.filter((key) => present.has(key));
  const placed = new Set(order);
  let after: string | null = null;
  for (const key of next) {
    if (!placed.has(key)) {
      order.splice(after === null ? 0 : order.indexOf(after) + 1, 0, key);
      placed.add(key);
    }
    after = key;
  }
  return order;
}

/**
 * The children in a stable order of their React keys (`stableOrder`). A tile move reorders the caller's
 * keys (they follow the layout); were the items reordered with them, React would move the
 * item nodes, and a moved iframe reloads (its screen or tool starts over). Items never
 * overlap and carry no stacking, so their document order means nothing to the person.
 */
function useStableChildren(children: ReactNode): ReactNode[] {
  const byKey = new Map<string, ReactNode>();
  const unkeyed: ReactNode[] = [];
  for (const child of Children.toArray(children)) {
    if (isValidElement(child) && child.key !== null) byKey.set(String(child.key), child);
    else unkeyed.push(child);
  }
  const keys = [...byKey.keys()];
  const [order, setOrder] = useState<readonly string[]>(keys);
  const next = stableOrder(order, keys);
  // Derived from the previous render's order (React's "adjust state on a prop change").
  if (next.length !== order.length || next.some((key, i) => key !== order[i])) setOrder(next);
  return [...next.map((key) => byKey.get(key)!), ...unkeyed];
}

export function DockOverlay({ dragging: bridgeDragging, onFocus, children }: DockOverlayProps) {
  const layerRef = useRef<HTMLDivElement>(null);
  useOverlayFocus(layerRef, onFocus);
  const dragging = useNativeDrag(layerRef) || bridgeDragging;
  const items = useStableChildren(children);
  return (
    <div
      ref={layerRef}
      className={dragging ? `${OVERLAY_CLASS} ${OVERLAY_DRAGGING_CLASS}` : OVERLAY_CLASS}
      data-dragging={dragging ? 'true' : undefined}
    >
      <TileFocusContext.Provider value={onFocus}>{items}</TileFocusContext.Provider>
    </div>
  );
}

export interface DockOverlayItemProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  'className' | 'style' | 'children'
> {
  api: TileRectApi | null;
  /**
   * The tab key, which is also the dockview panel id of its placeholder. Render one item
   * per open key, hidden tabs included: a hidden tab stays mounted, unplaced.
   */
  tileKey: string;
  /**
   * The showing tab of the holder's focused tile (`tabPlacement(...).focused`): the marker
   * print rules key on. Read from the layout holder, never from dockview's active group.
   */
  focused?: boolean;
  children?: ReactNode;
}

export function DockOverlayItem({
  api,
  tileKey,
  focused = false,
  children,
  ...rest
}: DockOverlayItemProps) {
  const rectRef = useTileRect(api, tileKey);
  const focusRef = useTileFocus(tileKey, useContext(TileFocusContext));
  const ref = useCallback(
    (el: HTMLDivElement | null) => {
      rectRef(el);
      focusRef(el);
    },
    [rectRef, focusRef]
  );
  return (
    <div
      role="group"
      tabIndex={-1}
      id={tilePanelId(tileKey)}
      aria-labelledby={tileTitleId(tileKey)}
      {...rest}
      ref={ref}
      className={OVERLAY_ITEM_CLASS}
      data-tab-key={tileKey}
      data-focused={focused ? 'true' : undefined}
    >
      {children}
    </div>
  );
}
