// A draggable divider that sizes one flex pane: the workspace's screen
// browser against its content.
//
// The same grip-pill splitter idiom as the host shell, so the screen browser
// separates from its content the way the host's own panes do. The viewer
// loads nothing root-absolute, so the behaviour lives here.
//
// Semantics:
//   drag      pointer capture, so the pointer may leave the 5 px track; one
//             geometry write per frame; a press that never moves is a click,
//             so the two clicks of a double-click commit nothing.
//   size      inline flex-basis + max-width, clamped to [min, max]; null means
//             "the stylesheet's default" until the operator first resizes.
//   keyboard  ArrowRight/ArrowLeft nudge by `step`; Enter/Space toggle.
//             Home/End jump to min/max (the APG window splitter's keys).
//   collapse  double-click (or Enter/Space) shrinks the pane to 0 and back to
//             the size it had, clamped to the current bounds.
//   persist   `{size, collapsed}` after every settled change (drag end,
//             nudge, toggle) — never mid-drag. Every storage access is
//             guarded: blocked storage means the default on read and "not
//             remembered" on write.
//   dragging  the pane carries data-splitter-dragging while a drag runs, so
//             it never animates the property the drag drives.

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from 'react';

/** The default arrow-key increment, px. */
export const SPLITTER_STEP = 16;

/** The persisted record. */
export interface SplitterState {
  /** Expanded size in px; null until the operator first resizes. */
  size: number | null;
  collapsed: boolean;
}

export function clampSize(size: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(size)));
}

/** Parse a stored record; anything unusable is "nothing stored". */
export function parseSplitterState(raw: string | null): SplitterState {
  if (raw === null || raw === '') return { size: null, collapsed: false };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      const { size, collapsed } = parsed as { size?: unknown; collapsed?: unknown };
      return {
        size: typeof size === 'number' && Number.isFinite(size) ? size : null,
        collapsed: collapsed === true,
      };
    }
  } catch {
    // Unparseable: fall through to the default.
  }
  return { size: null, collapsed: false };
}

// localStorage can be missing (Node >= 25 without --localstorage-file) or
// throw (blocked site data, sandboxed frames), like screenList.ts's.
function localStore(): Storage | undefined {
  try {
    const value = (globalThis as { localStorage?: Storage }).localStorage;
    return typeof value?.getItem === 'function' ? value : undefined;
  } catch {
    return undefined;
  }
}

export function readSplitterState(key: string): SplitterState {
  try {
    return parseSplitterState(localStore()?.getItem(key) ?? null);
  } catch {
    return { size: null, collapsed: false };
  }
}

export function writeSplitterState(key: string, state: SplitterState): void {
  try {
    localStore()?.setItem(key, JSON.stringify(state));
  } catch {
    // Not remembered; the split still holds for this page view.
  }
}

export interface PaneSplitterOptions {
  /** localStorage key of the `{size, collapsed}` record. */
  storageKey: string;
  /** Smallest useful pane size, px. */
  min: number;
  /** Largest useful pane size, px; a function is re-read on window resize. */
  max: number | (() => number);
  /** Size a first drag or nudge starts from when the pane cannot be measured. */
  fallbackSize: number;
  /** Arrow-key increment, px. */
  step?: number;
  /** Accessible name of the separator. */
  label: string;
}

export interface PaneSplitter {
  /** Spread on the pane. */
  paneProps: {
    ref: (el: HTMLElement | null) => void;
    style: CSSProperties | undefined;
    'data-splitter-dragging'?: '';
    'data-collapsed'?: '';
  };
  /** Spread on the separator element. */
  handleProps: {
    role: 'separator';
    tabIndex: 0;
    className: string;
    'aria-label': string;
    'aria-orientation': 'vertical';
    'aria-valuenow': number;
    'aria-valuemin': number;
    'aria-valuemax': number;
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void;
    onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void;
    onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => void;
    onDoubleClick: () => void;
    onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => void;
  };
  collapsed: boolean;
  /** Collapse or restore, as the separator's double-click: for a visible control. */
  toggle: () => void;
}

function resolveBound(bound: number | (() => number)): number {
  return typeof bound === 'function' ? bound() : bound;
}

interface Drag {
  pointerId: number;
  start: number;
  startSize: number;
  pending: number;
  moved: boolean;
}

/**
 * The splitter for a pane that precedes its handle on the x axis (anchor
 * 'start', sizing 'flex') — the only geometry the
 * workspace has.
 */
export function usePaneSplitter({
  storageKey,
  min,
  max,
  fallbackSize,
  step = SPLITTER_STEP,
  label,
}: PaneSplitterOptions): PaneSplitter {
  const [state, setState] = useState<SplitterState>(() => readSplitterState(storageKey));
  // The bound is re-read on window resize, so a narrowed window re-clamps the
  // pane without anyone dragging it.
  const [maxNow, setMaxNow] = useState(() => Math.max(min, resolveBound(max)));
  useEffect(() => {
    const update = () => setMaxNow(Math.max(min, resolveBound(max)));
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [min, max]);

  // A different key (another base path) is another record.
  const [loadedKey, setLoadedKey] = useState(storageKey);
  if (loadedKey !== storageKey) {
    setLoadedKey(storageKey);
    setState(readSplitterState(storageKey));
  }

  const [dragging, setDragging] = useState(false);
  const pane = useRef<HTMLElement | null>(null);
  const drag = useRef<Drag | null>(null);
  const frame = useRef(0);
  // Handlers read the latest state through a ref; it is written in an effect.
  const latest = useRef({ state, maxNow });
  useEffect(() => {
    latest.current = { state, maxNow };
  }, [state, maxNow]);

  const cancelFrame = useCallback(() => {
    if (frame.current) cancelAnimationFrame(frame.current);
    frame.current = 0;
  }, []);
  // Unmount mid-drag: drop the frame, persist nothing.
  useEffect(() => cancelFrame, [cancelFrame]);

  /** The size a drag or nudge starts from, measuring only as a last resort. */
  const currentSize = useCallback((): number => {
    const { state: s } = latest.current;
    if (s.collapsed) return 0;
    if (s.size !== null) return clampSize(s.size, min, latest.current.maxNow);
    const width = pane.current?.getBoundingClientRect().width ?? 0;
    return width > 0 ? width : fallbackSize;
  }, [min, fallbackSize]);

  /** Apply a settled state and persist it. */
  const commit = useCallback(
    (next: SplitterState) => {
      latest.current = { ...latest.current, state: next };
      setState(next);
      writeSplitterState(storageKey, next);
    },
    [storageKey]
  );

  const resize = useCallback(
    (size: number): SplitterState => ({
      size: clampSize(size, min, latest.current.maxNow),
      collapsed: false,
    }),
    [min]
  );

  const toggleCollapse = useCallback(() => {
    const { state: s, maxNow: m } = latest.current;
    if (s.collapsed) {
      // Restore into the current bounds, so what is persisted is what shows.
      commit({ size: clampSize(s.size ?? fallbackSize, min, m), collapsed: false });
    } else {
      commit({ size: s.size ?? currentSize(), collapsed: true });
    }
  }, [commit, currentSize, fallbackSize, min]);

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // No capture: the drag still tracks while the pointer is over the track.
    }
    const startSize = currentSize();
    drag.current = {
      pointerId: e.pointerId,
      start: e.clientX,
      startSize,
      pending: startSize,
      moved: false,
    };
    setDragging(true);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d) return;
    if (e.clientX !== d.start) d.moved = true;
    d.pending = d.startSize + (e.clientX - d.start);
    // One geometry write per displayed frame: pointer events outrun it.
    if (typeof requestAnimationFrame !== 'function') {
      setState(resize(d.pending));
    } else if (!frame.current) {
      frame.current = requestAnimationFrame(() => {
        frame.current = 0;
        const live = drag.current;
        if (live) setState(resize(live.pending));
      });
    }
  };

  const endDrag = () => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    // Land the final size while transitions are still suppressed.
    cancelFrame();
    if (d.moved) commit(resize(d.pending));
    setDragging(false);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggleCollapse();
      return;
    }
    if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      commit(resize(e.key === 'Home' ? min : latest.current.maxNow));
      return;
    }
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    commit(resize(currentSize() + (e.key === 'ArrowRight' ? step : -step)));
  };

  const setPane = useCallback((el: HTMLElement | null) => {
    pane.current = el;
  }, []);

  const shown = state.collapsed
    ? 0
    : state.size === null
      ? null
      : clampSize(state.size, min, maxNow);
  const style: CSSProperties | undefined =
    shown === null ? undefined : { flexBasis: `${shown}px`, maxWidth: `${shown}px`, minWidth: 0 };

  return {
    paneProps: {
      ref: setPane,
      style,
      ...(dragging ? { 'data-splitter-dragging': '' as const } : {}),
      ...(state.collapsed ? { 'data-collapsed': '' as const } : {}),
    },
    handleProps: {
      role: 'separator',
      tabIndex: 0,
      className: dragging ? 'pane-splitter dragging' : 'pane-splitter',
      'aria-label': label,
      'aria-orientation': 'vertical',
      'aria-valuenow': shown ?? fallbackSize,
      'aria-valuemin': min,
      'aria-valuemax': maxNow,
      onPointerDown,
      onPointerMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
      onDoubleClick: toggleCollapse,
      onKeyDown,
    },
    collapsed: state.collapsed,
    toggle: toggleCollapse,
  };
}
