// The dock bridge: the single decider between person drags, the layout holder (the tabs
// reducer) and a live dockview, which only renders the holder's layout. It never constructs a dock (createDock.ts does); it takes the api the page made
// and the root element that api was created on.
//
// Dockview never moves anything by itself. Every `onWillShowOverlay`, the api's and each group
// model's, is `preventDefault`ed: a prevented overlay leaves dockview's drop target without a
// state, so its drop neither fires `onDrop` nor stops propagation (droptarget.js:117-129,
// 170-181), while its dragover `preventDefault` keeps native drops firing. The dock refuses
// no drop itself: the engine decides every drop.
//
// Where a drag's source (the engine's `Source`) comes from. dataTransfer data is unreadable during
// dragover, so a source is read from module state: the dock's own drags (tile-bar tabs, the
// grip, strip tabs, sidebar rows) record it through `dockDragStart` (tabAdapter); dockview's
// own tab and header drags are read from each group model's `onTabDragStart` /
// `onGroupDragStart` (re-attached on `onDidAddGroup` after every `fromJSON`), with
// `getPanelData()` as the fallback. A drag with no source is foreign: no preview, no
// `preventDefault`, no drop. The same drag-start hooks raise `dragging` (the overlay shield);
// it falls once the drag ends (a document drop or dragend, or Escape).
//
// Capture-phase `dragover`/`drop` listeners on the dock root (sashes and gaps included), and
// the exported strip handlers for the one-tile strip outside the root, measure the tile header
// rows (`measureTabRects`), run `hitTest` on the holder's latest layout and publish `preview`
// for `DropPreview`: the hovered tile's rect measured from the DOM (its group element), or the
// half of it an edge drop lands in, in the dock's positioned parent's space; `resultRect` only
// decides whether there is a highlight and where the tab marker goes. A dragover that no dock
// surface handled (the pointer left the dock and the strip) clears the preview. A drop
// dispatches `drop {source, target, dock}`; the reducer runs `planDrop`.
//
// Holder -> dock. Whenever `state.layout` changes and differs from what dockview shows, the
// bridge applies it (`applyLayout`, one `fromJSON` under the `applying` guard). A layout
// dockview already shows (a tab click's `focus`, a sash `resized`) is never re-applied. While
// a drag is live no apply runs: the change waits and the one apply runs a `setTimeout(0)`
// after the drag has ended, so dockview's drag source still exists for its own dragend. A
// dock size change (`dockPx`) re-runs the same idempotent apply: the first apply can land on
// a dock with no size yet, which loses the holder's sizes until it is applied again.
//
// Dock -> holder. A person's tab activation (`onDidActivePanelChange`, origin `user`) is
// `focus {key}`. `resized` comes only from a person's sash gesture (`pointerdown` on a
// `.dv-sash` in the root, then a one-shot capture `pointerup` on `document`, read a turn
// later once dockview has finished its own) and from a dock size change (a ResizeObserver on
// the root); never from `onDidLayoutChange`, which fires in a microtask after every apply.
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
} from 'react';
import {
  getPanelData,
  type DockviewApi,
  type DockviewGroupPanel,
  type GroupviewPanelState,
  type SerializedDockview,
} from 'dockview-core';
import { parseMember } from '../collections.js';
import type { Member } from '../collections.js';
import { DEFAULT_DOCK_PX } from '../tabs.js';
import type { DockSize, TabsAction, TabsState } from '../tabs.js';
import { applyLayout as applyToDock, toSerialized } from './applyLayout.js';
import {
  fractionsOf,
  hitTest,
  isTile,
  keysOf,
  tileIdsOf,
  resultRect,
} from '@slaclab/canopy-dock-engine';
import type {
  Rect,
  Side,
  Source,
  TabRects,
  Target,
  Layout,
  ResultRect,
} from '@slaclab/canopy-dock-engine';
import { clearDockDrag, dockDragSource, onDockDragStart } from './tabAdapter.js';
import { measureTabRects } from './TileBar.js';

// --- screen-browser drag shapes (kept for the page and ScreenTree) --------------------

/** A saved-view row's drag; it keeps the openView drop path. */
export interface ViewDrag {
  kind: 'view';
  id: string;
}

/** What a screen-browser row drags: a member (a screen or a tool entry) or a saved view. */
export type BrowserDrag = Member | ViewDrag;

/** True for a saved-view drag, false for a member. */
export function isViewDrag(drag: BrowserDrag): drag is ViewDrag {
  return (drag as Partial<ViewDrag>).kind === 'view';
}

/** The BrowserDrag a JSON payload carries, or null for anything else (shape only). */
export function parseBrowserDrag(payload: string): BrowserDrag | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const { kind, id } = parsed as Record<string, unknown>;
  if (kind === 'view') return typeof id === 'string' ? { kind, id } : null;
  return parseMember(parsed);
}

// --- the bridge ------------------------------------------------------------------------

/** The class of every dockview sash (splitview.js). */
const SASH_SELECTOR = '.dv-sash';

/** Px tolerance within which a dockview size counts as the holder's. */
const SIZE_TOLERANCE = 2;

/** What `DropPreview` paints: the target under the pointer and its highlight. */
export interface DockPreview {
  target: Target | null;
  result: ResultRect | null;
}

const NO_PREVIEW: DockPreview = Object.freeze({ target: null, result: null }) as DockPreview;

/** The parts of a drag event the drop handlers read (a native or a React DragEvent). */
export interface DragLike {
  clientX: number;
  clientY: number;
  preventDefault(): void;
  dataTransfer: DataTransfer | null;
}

export interface DockBridgeOptions {
  /** The element the dock was created on; the capture listeners go here. */
  root?: HTMLElement | null;
  /** The title a panel with no stored state carries (its tab's label). */
  titleOf?: (key: string) => string;
  /** State for a key with no stored panel entry (merged over the title). */
  newPanel?: (key: string) => Partial<GroupviewPanelState>;
}

export interface DockBridge {
  /** True while a drag of a recognised source is live; the overlay shield. */
  dragging: boolean;
  /** The current drop preview; feed it to `DropPreview`. */
  preview: DockPreview;
  /** Clears the preview (DropPreview's `onClear`). */
  clearPreview(): void;
  /** The one-tile strip's dragover; `strip` is its measured rects, keyed to the one tile. */
  stripDragOver(event: DragLike, strip?: TabRects): void;
  /** The one-tile strip's drop. */
  stripDrop(event: DragLike, strip?: TabRects): void;
  /** True while a layout is being applied (URL mirror and persist stay inert). */
  isApplying(): boolean;
}

type GridNode = SerializedDockview['grid']['root'];

function rectOf(element: Element): Rect {
  const r = element.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}

/** The `edge` half of `rect` (the first half takes the rounded half, as the split does). */
function halfOf(rect: Rect, edge: Side): Rect {
  if (edge === 'left' || edge === 'right') {
    const first = Math.round(rect.width / 2);
    return edge === 'left'
      ? { ...rect, width: first }
      : { ...rect, x: rect.x + first, width: rect.width - first };
  }
  const first = Math.round(rect.height / 2);
  return edge === 'top'
    ? { ...rect, height: first }
    : { ...rect, y: rect.y + first, height: rect.height - first };
}

/** The native event behind a native or a React drag event. */
function nativeOf(event: DragLike): object {
  return (event as { nativeEvent?: object }).nativeEvent ?? event;
}

/** True when two serialized grid nodes have the same tree, tiles and sizes (within 2 px). */
function sameGrid(a: GridNode, b: GridNode): boolean {
  if (a.type !== b.type) return false;
  if (Math.abs((a.size ?? 0) - (b.size ?? 0)) > SIZE_TOLERANCE) return false;
  if (a.type === 'leaf') {
    const x = a.data as { views: string[]; activeView?: string; id: string };
    const y = b.data as { views: string[]; activeView?: string; id: string };
    return (
      x.id === y.id &&
      x.activeView === y.activeView &&
      x.views.length === y.views.length &&
      x.views.every((v, i) => v === y.views[i])
    );
  }
  const xs = a.data as GridNode[];
  const ys = b.data as GridNode[];
  return xs.length === ys.length && xs.every((child, i) => sameGrid(child, ys[i]!));
}

/** True when the dock already shows `layout` on a dock of `dockPx`. */
function inSync(api: DockviewApi, layout: Layout | null, dockPx: DockSize): boolean {
  const shown = api.toJSON().grid;
  const wanted = toSerialized(layout, dockPx).grid;
  if (layout === null) return api.panels.length === 0;
  return shown.orientation === wanted.orientation && sameGrid(shown.root, wanted.root);
}

/** `layout` with each split's item sizes read back from dockview's grid; null on any mismatch. */
function withGridSizes(layout: Layout, grid: GridNode, top = true): Layout | null {
  if (isTile(layout)) {
    // A root Tile is wrapped in a one-child branch.
    return top || grid.type === 'leaf' ? layout : null;
  }
  if (grid.type !== 'branch') return null;
  const children = grid.data as GridNode[];
  if (children.length !== layout.items.length) return null;
  const fractions = fractionsOf(children.map((child) => child.size ?? 0));
  const items: Layout[] = [];
  for (let i = 0; i < layout.items.length; i += 1) {
    const item = withGridSizes(layout.items[i]!, children[i]!, false);
    if (item === null) return null;
    items.push({ ...item, size: fractions[i]! });
  }
  return { ...layout, items };
}

export function useDockBridge(
  api: DockviewApi | null,
  state: TabsState,
  dispatch: Dispatch<TabsAction>,
  options: DockBridgeOptions = {}
): DockBridge {
  const stateRef = useRef(state);
  const optionsRef = useRef(options);
  const apiRef = useRef(api);
  /** The last dragover a dock surface (the root or the strip) handled. */
  const handled = useRef<object | null>(null);
  /** True for the duration of a fromJSON. */
  const applying = useRef(false);
  /** Raised around the bridge's own api calls; events seen while > 0 are echoes. */
  const suppress = useRef(0);
  /** The holder layout the dock was last applied from or found in sync with. */
  const applied = useRef<Layout | null | undefined>(undefined);
  /** True while a drag is live; applies wait. */
  const dragLive = useRef(false);
  /** A dockview tab/header drag's source, from its group model's drag-start event. */
  const dockviewSource = useRef<Source | null>(null);
  /** Lowers the live drag; null while none is up. */
  const lowerDrag = useRef<(() => void) | null>(null);
  const [dragging, setDragging] = useState(false);
  const [preview, setPreview] = useState<DockPreview>(NO_PREVIEW);
  const previewKey = useRef('null');

  const root = options.root ?? null;

  useLayoutEffect(() => {
    stateRef.current = state;
    optionsRef.current = options;
    apiRef.current = api;
  });

  // A dragover that reached the document without a dock surface handling it is off the dock
  // and the strip (the screen header, the page): no highlight there.
  useEffect(() => {
    const over = (event: DragEvent) => {
      if (handled.current !== event && previewKey.current !== 'null') {
        previewKey.current = 'null';
        setPreview(NO_PREVIEW);
      }
    };
    document.addEventListener('dragover', over);
    return () => document.removeEventListener('dragover', over);
  }, []);

  const dockSizeOf = useCallback((): DockSize => {
    if (api && api.width > 0 && api.height > 0) return { width: api.width, height: api.height };
    return stateRef.current.dockPx ?? DEFAULT_DOCK_PX;
  }, [api]);

  const showPreview = useCallback((next: DockPreview) => {
    const key = JSON.stringify(next);
    if (key === previewKey.current) return;
    previewKey.current = key;
    setPreview(next.target === null ? NO_PREVIEW : next);
  }, []);

  const clearPreview = useCallback(() => {
    previewKey.current = 'null';
    setPreview(NO_PREVIEW);
  }, []);

  /** Applies the holder's layout now, under the applying guard. */
  const applyNow = useCallback(() => {
    if (!api) return;
    const { layout, focusedTile } = stateRef.current;
    applied.current = layout;
    const dockPx = dockSizeOf();
    if (inSync(api, layout, dockPx)) return;
    const { titleOf, newPanel } = optionsRef.current;
    applying.current = true;
    suppress.current += 1;
    try {
      void applyToDock(api, layout, {
        dockPx,
        activeTile: focusedTile,
        newPanel: (key) => ({ title: titleOf?.(key) ?? key, ...newPanel?.(key) }),
        apply: (serialized) => api.fromJSON(serialized),
      });
    } finally {
      suppress.current -= 1;
      applying.current = false;
    }
  }, [api, dockSizeOf]);

  /** Raises the shield once per drag; the drag's end lowers it and runs a waiting apply. */
  const raiseDrag = useCallback(() => {
    dragLive.current = true;
    if (lowerDrag.current) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const end = () => {
      if (timer !== null) return;
      // A turn later: the root's own drop handler still reads the source, and dockview's
      // drag source still exists for its dragend.
      timer = setTimeout(lower, 0);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') end();
    };
    const lower = () => {
      document.removeEventListener('drop', end, true);
      document.removeEventListener('dragend', end, true);
      document.removeEventListener('keydown', onKey, true);
      if (timer !== null) clearTimeout(timer);
      lowerDrag.current = null;
      dragLive.current = false;
      dockviewSource.current = null;
      setDragging(false);
      previewKey.current = 'null';
      setPreview(NO_PREVIEW);
      // A layout or a dock size that changed mid-drag; idempotent when neither did.
      applyNow();
    };
    lowerDrag.current = lower;
    document.addEventListener('drop', end, true);
    document.addEventListener('dragend', end, true);
    document.addEventListener('keydown', onKey, true);
    setDragging(true);
  }, [applyNow]);

  useEffect(
    () => () => {
      lowerDrag.current?.();
    },
    []
  );

  // Holder -> dock: apply every layout the dock does not already show, never mid-drag.
  useLayoutEffect(() => {
    if (!api) return;
    if (state.layout === applied.current) return;
    if (dragLive.current) return; // applied once the drag ends
    applyNow();
  }, [api, state.layout, applyNow]);

  // Holder -> dock on a dock size change. The first apply can run before dockview has a size
  // (its width is 0 until the root is laid out), and dockview then lays the tiles out in equal
  // shares: the holder's sizes are lost although its layout never changed. The ResizeObserver's
  // `resized {dock}` that follows changes only `dockPx`, so re-run the apply for it. It is
  // idempotent: a dock that already shows the holder's sizes (within 2 px) is left alone.
  const dockWidth = state.dockPx?.width;
  const dockHeight = state.dockPx?.height;
  useLayoutEffect(() => {
    if (!api || applied.current === undefined) return;
    if (dragLive.current) return; // the drag's end applies
    applyNow();
  }, [api, dockWidth, dockHeight, applyNow]);

  // Holder focus -> dockview's active group.
  useLayoutEffect(() => {
    if (!api || dragLive.current) return;
    const tile = state.focusedTile;
    if (tile === null || api.activeGroup?.id === tile) return;
    const group = api.getGroup(tile);
    if (!group) return;
    suppress.current += 1;
    try {
      group.api.setActive();
    } finally {
      suppress.current -= 1;
    }
  }, [api, state.focusedTile, state.layout]);

  /** The live drag's source, or null for a foreign drag (or none). */
  const currentSource = useCallback((): Source | null => {
    const own = dockDragSource() ?? dockviewSource.current;
    if (own) return own;
    const data = getPanelData();
    if (!data) return null;
    const { layout } = stateRef.current;
    if (data.panelId !== null) {
      return keysOf(layout).includes(data.panelId) ? { tab: data.panelId } : null;
    }
    return tileIdsOf(layout).includes(data.groupId) ? { tile: data.groupId } : null;
  }, []);

  /** The target and preview for a drag of `source` at the event's point. */
  const targetAt = useCallback((event: DragLike, source: Source, strip?: TabRects): DockPreview => {
    const { layout } = stateRef.current;
    const dockRoot = optionsRef.current.root ?? null;
    if (layout === null || dockRoot === null) return NO_PREVIEW;
    const dockRect = rectOf(dockRoot);
    const tabRects: TabRects = { ...measureTabRects(dockRoot), ...strip };
    const point = { x: event.clientX, y: event.clientY };
    const target = hitTest(layout, dockRect, tabRects, point, source);
    if (target === null) return NO_PREVIEW;
    const result = resultRect(layout, dockRect, tabRects, source, target);
    if (result === null) return { target, result: null };
    // The highlight sits on the hovered tile as the DOM lays it out.
    const group =
      'tile' in target
        ? (apiRef.current?.getGroup(target.tile) as DockviewGroupPanel | undefined)
        : undefined;
    const tile = group?.element.isConnected ? rectOf(group.element) : null;
    const rect = tile === null ? result.rect : 'edge' in target ? halfOf(tile, target.edge) : tile;
    // Client space -> the positioned parent's (DropPreview's) space.
    const parent = dockRoot.offsetParent ?? dockRoot.parentElement;
    const origin = parent ? parent.getBoundingClientRect() : { left: 0, top: 0 };
    const dx = -origin.left;
    const dy = -origin.top;
    return {
      target,
      result: {
        rect: { ...rect, x: rect.x + dx, y: rect.y + dy },
        marker:
          result.marker === null
            ? null
            : { ...result.marker, x: result.marker.x + dx, y: result.marker.y + dy },
      },
    };
  }, []);

  const onDragOver = useCallback(
    (event: DragLike, strip?: TabRects) => {
      const source = currentSource();
      if (source === null) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      handled.current = nativeOf(event);
      raiseDrag();
      showPreview(targetAt(event, source, strip));
    },
    [currentSource, raiseDrag, showPreview, targetAt]
  );

  const onDrop = useCallback(
    (event: DragLike, strip?: TabRects) => {
      const source = currentSource();
      if (source === null) return;
      event.preventDefault();
      const { target } = targetAt(event, source, strip);
      clearDockDrag();
      dockviewSource.current = null;
      clearPreview();
      if (target === null) return;
      const dockRoot = optionsRef.current.root ?? null;
      const box = dockRoot ? rectOf(dockRoot) : null;
      const dock =
        box && box.width > 0 && box.height > 0
          ? { width: Math.round(box.width), height: Math.round(box.height) }
          : dockSizeOf();
      dispatch({ type: 'drop', source, target, dock });
    },
    [clearPreview, currentSource, dispatch, dockSizeOf, targetAt]
  );

  // Dockview never acts on a drop: every overlay is prevented; drag starts raise the shield.
  useEffect(() => {
    if (!api) return;
    const wired = new Map<string, { dispose(): void }[]>();
    const wire = (group: DockviewGroupPanel) => {
      if (wired.has(group.id)) return;
      const { model } = group;
      wired.set(group.id, [
        model.onWillShowOverlay((event) => event.preventDefault()),
        model.onTabDragStart((event) => {
          dockviewSource.current = { tab: event.panel.id };
          raiseDrag();
        }),
        model.onGroupDragStart((event) => {
          dockviewSource.current = { tile: event.group.id };
          raiseDrag();
        }),
      ]);
    };
    const unwire = (group: DockviewGroupPanel) => {
      for (const subscription of wired.get(group.id) ?? []) subscription.dispose();
      wired.delete(group.id);
    };
    for (const group of api.groups) wire(group);
    const subscriptions = [
      api.onDidAddGroup(wire),
      api.onDidRemoveGroup(unwire),
      api.onWillShowOverlay((event) => event.preventDefault()),
    ];
    const unsubscribeStart = onDockDragStart(() => raiseDrag());
    return () => {
      unsubscribeStart();
      for (const subscription of subscriptions) subscription.dispose();
      for (const disposables of wired.values()) {
        for (const subscription of disposables) subscription.dispose();
      }
      wired.clear();
    };
  }, [api, raiseDrag]);

  // Capture-phase drag listeners on the dock root, and the sash gesture.
  useEffect(() => {
    if (!api || root === null) return;
    const over = (event: DragEvent) => onDragOver(event);
    const drop = (event: DragEvent) => onDrop(event);
    const sashDown = (event: PointerEvent) => {
      const sash = (event.target as Element | null)?.closest?.(SASH_SELECTOR);
      if (!sash || !root.contains(sash)) return;
      const up = () => {
        document.removeEventListener('pointerup', up, true);
        // dockview ends its sash drag on the document too: read the sizes after it has.
        setTimeout(() => {
          const { layout } = stateRef.current;
          if (layout === null || applying.current) return;
          const sized = withGridSizes(layout, api.toJSON().grid.root);
          if (sized !== null) dispatch({ type: 'resized', layout: sized });
        }, 0);
      };
      document.addEventListener('pointerup', up, true);
    };
    root.addEventListener('dragover', over, true);
    root.addEventListener('drop', drop, true);
    root.addEventListener('pointerdown', sashDown, true);
    let observer: ResizeObserver | null = null;
    let frame: number | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver((entries) => {
        const box = entries[entries.length - 1]?.contentRect;
        if (!box || box.width <= 0 || box.height <= 0) return;
        // dockview lays itself out to a new root size a frame later (its own observer defers
        // through requestAnimationFrame, and was created first, so its frame runs first). Only
        // then does the dock show its new size: re-apply the holder's sizes on top of it,
        // idempotently, which also restores what an apply to a dock with no size yet lost.
        if (frame === null && typeof requestAnimationFrame !== 'undefined') {
          frame = requestAnimationFrame(() => {
            frame = null;
            if (!dragLive.current && !applying.current && api.width > 0) applyNow();
          });
        }
        const dock = { width: Math.round(box.width), height: Math.round(box.height) };
        const known = stateRef.current.dockPx;
        if (known?.width === dock.width && known?.height === dock.height) return;
        dispatch({ type: 'resized', dock });
      });
      observer.observe(root);
    }
    return () => {
      root.removeEventListener('dragover', over, true);
      root.removeEventListener('drop', drop, true);
      root.removeEventListener('pointerdown', sashDown, true);
      observer?.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [api, root, dispatch, onDragOver, onDrop, applyNow]);

  // Dock -> holder: a person's tab activation.
  useEffect(() => {
    if (!api) return;
    const subscription = api.onDidActivePanelChange((event) => {
      if (suppress.current > 0 || applying.current || event.origin !== 'user') return;
      const key = event.panel?.id;
      if (key === undefined || !stateRef.current.keys.includes(key)) return;
      dispatch({ type: 'focus', key });
    });
    return () => subscription.dispose();
  }, [api, dispatch]);

  const stripDragOver = useCallback(
    (event: DragLike, strip?: TabRects) => onDragOver(event, strip),
    [onDragOver]
  );
  const stripDrop = useCallback(
    (event: DragLike, strip?: TabRects) => onDrop(event, strip),
    [onDrop]
  );
  const isApplying = useCallback(() => applying.current, []);

  return useMemo(
    () => ({ dragging, preview, clearPreview, stripDragOver, stripDrop, isApplying }),
    [dragging, preview, clearPreview, stripDragOver, stripDrop, isApplying]
  );
}
