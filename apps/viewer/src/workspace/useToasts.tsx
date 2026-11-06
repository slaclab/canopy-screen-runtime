// The workspace's notification toast: short confirmations such as
// "Saved “<name>”" or "Closed 3 tabs", with at most one action (normally
// Undo).
//
// The rules:
// - One toast at a time. A new toast replaces the shown one, which is then
//   committed: its action can no longer run, and its `onCommit` is called.
// - It dismisses itself after 10 s; the clock is paused while the pointer is
//   over the toast or focus is inside it, and restarts in full on leaving.
// - The region is `role=status aria-live=polite`, a fixed sibling of (never
//   inside) the write-safety `WriteToastColumn`, which this leaves untouched.
// - Esc dismisses (from inside the toast, or from anywhere a dialog, menu or
//   form field does not own the key).
// - The primary shortcut + Z (⌘Z on macOS, Ctrl+Z elsewhere) runs the action
//   while the toast is shown and focus is not in an editable target.
//
// A workspace owns one store (`useToasts`), renders `ToastRegion` beside the
// write column and hands the store down through `ToastContext`; a component
// below shows a toast with `useToast()?.show(...)`.
//
// The undo toast: every closed group, single or bulk, by the strip
// or by the agent, is offered through one `offerUndo(groupId, count)`
// (useOfferUndo): "Closed N tabs · Undo", or "Layout reset · Undo" for a
// layout group. Its Undo reopens that group by id, so an Undo after the group
// left the stack (reopened from the strip's list or ⌘⇧T) does nothing.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { isMac, primaryShortcutKey } from '../screenActions/shortcuts.js';
import './ToastRegion.css';

/** The undo toast's action label. */
export const UNDO = 'Undo';
/** The undo toast's message for a layout group. */
export const LAYOUT_RESET = 'Layout reset';

/** The undo toast's message for a group of `count` closed tabs. */
export function closedMessage(count: number): string {
  return `Closed ${count} ${count === 1 ? 'tab' : 'tabs'}`;
}

/** How long a toast stays when nobody hovers or focuses it. */
export const TOAST_TIMEOUT_MS = 10_000;

export interface ToastAction {
  /** The button label, e.g. "Undo". */
  readonly label: string;
  readonly run: () => void;
}

export interface ToastSpec {
  readonly message: string;
  readonly action?: ToastAction;
  /** Called once when the toast leaves without its action having run. */
  readonly onCommit?: () => void;
}

export interface ShownToast extends ToastSpec {
  readonly id: number;
}

export interface ToastStore {
  /** The toast on screen, or null. */
  readonly toast: ShownToast | null;
  /** Show `spec`, replacing (and committing) the current toast; returns its id. */
  show(spec: ToastSpec): number;
  /** Dismiss the current toast (or only toast `id`, when given): it commits. */
  dismiss(id?: number): void;
  /** Run the current toast's action, then close it. */
  runAction(): void;
  /** Pause (true) or resume (false) the auto-dismiss clock. */
  setPaused(paused: boolean): void;
}

export interface UseToastsOptions {
  /** Which primary modifier the shortcut uses (default: the platform's). */
  readonly mac?: boolean;
  readonly timeoutMs?: number;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

/** A target whose own UI (a dialog, a menu, a list) is the one Esc closes. */
function ownsEscape(target: EventTarget | null): boolean {
  if (isEditableTarget(target)) return true;
  if (!(target instanceof Element)) return false;
  return (
    target.closest('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]') !==
    null
  );
}

const REGION_SELECTOR = '[data-canopy-toast-region]';

/** The workspace's toast store. */
export function useToasts(options: UseToastsOptions = {}): ToastStore {
  const mac = options.mac ?? isMac;
  const timeoutMs = options.timeoutMs ?? TOAST_TIMEOUT_MS;
  const [toast, setToast] = useState<ShownToast | null>(null);
  const [paused, setPausedState] = useState(false);
  const current = useRef<ShownToast | null>(null);
  const nextId = useRef(1);

  const close = useCallback((commit: boolean) => {
    const shown = current.current;
    if (!shown) return;
    current.current = null;
    setToast(null);
    setPausedState(false);
    if (commit) shown.onCommit?.();
  }, []);

  const show = useCallback((spec: ToastSpec): number => {
    const previous = current.current;
    const next: ShownToast = { ...spec, id: nextId.current++ };
    current.current = next;
    setToast(next);
    setPausedState(false);
    previous?.onCommit?.();
    return next.id;
  }, []);

  const dismiss = useCallback(
    (id?: number) => {
      if (id !== undefined && current.current?.id !== id) return;
      close(true);
    },
    [close]
  );

  const runAction = useCallback(() => {
    const shown = current.current;
    if (!shown) return;
    close(false);
    shown.action?.run();
  }, [close]);

  const setPaused = useCallback((value: boolean) => setPausedState(value), []);

  // The auto-dismiss clock: restarted for every toast, stopped while paused.
  useEffect(() => {
    if (!toast || paused) return undefined;
    const id = toast.id;
    const timer = setTimeout(() => {
      if (current.current?.id === id) close(true);
    }, timeoutMs);
    return () => clearTimeout(timer);
  }, [toast, paused, timeoutMs, close]);

  // Esc and the primary+Z shortcut, only while a toast is shown.
  useEffect(() => {
    if (!toast) return undefined;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (e.key === 'Escape') {
        const inside = e.target instanceof Element && e.target.closest(REGION_SELECTOR) !== null;
        if (!inside && ownsEscape(e.target)) return;
        e.preventDefault();
        close(true);
        return;
      }
      if (!toast.action || isEditableTarget(e.target)) return;
      if (primaryShortcutKey(e, mac) !== 'z') return;
      e.preventDefault();
      runAction();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [toast, mac, close, runAction]);

  return useMemo(
    () => ({ toast, show, dismiss, runAction, setPaused }),
    [toast, show, dismiss, runAction, setPaused]
  );
}

/** What a closed group restores: tabs (the count's) or a layout. */
export type UndoKind = 'tabs' | 'layout';

/** Offer the Undo of closed group `groupId` (`count` tabs, or a layout) as the one toast. */
export type OfferUndo = (groupId: string, count: number, kind?: UndoKind) => void;

/**
 * The workspace's one `offerUndo`: shows the undo toast on `store` (replacing
 * the current one), whose Undo calls `reopen(groupId)`. Nothing is shown
 * for an empty tabs group or without a store.
 */
export function useOfferUndo(
  store: ToastStore | null,
  reopen: (groupId: string) => void
): OfferUndo {
  const reopenRef = useRef(reopen);
  useEffect(() => {
    reopenRef.current = reopen;
  });
  const show = store?.show;
  return useCallback(
    (groupId: string, count: number, kind: UndoKind = 'tabs') => {
      if (!show || (kind === 'tabs' && count <= 0)) return;
      show({
        message: kind === 'layout' ? LAYOUT_RESET : closedMessage(count),
        action: { label: UNDO, run: () => reopenRef.current(groupId) },
      });
    },
    [show]
  );
}

/** The workspace's toast store, for the components below it. */
export const ToastContext = createContext<ToastStore | null>(null);

/** The workspace's toast store, or null outside a workspace. */
export function useToast(): ToastStore | null {
  return useContext(ToastContext);
}

/**
 * The fixed region the toast renders in: bottom-centre, so it sits beside the
 * write column (bottom-left) and clear of the host's bottom-right
 * overlay. The live region is always mounted so a screen reader hears
 * each new message.
 */
export function ToastRegion({ store }: { store: ToastStore }) {
  const { toast, dismiss, runAction, setPaused } = store;
  const hovered = useRef(false);
  const focused = useRef(false);
  const sync = () => setPaused(hovered.current || focused.current);

  // A closed toast fires no leave/blur, so forget the pointer and focus then;
  // a replacing toast starts paused when the pointer or focus is still on it.
  useEffect(() => {
    if (!toast) {
      hovered.current = false;
      focused.current = false;
    } else if (hovered.current || focused.current) {
      setPaused(true);
    }
  }, [toast, setPaused]);

  return (
    <div
      className="canopy-toast-region"
      data-testid="canopy-toast-region"
      data-canopy-toast-region=""
      role="status"
      aria-live="polite"
    >
      {toast && (
        <div
          key={toast.id}
          className="canopy-toast"
          data-testid="canopy-toast"
          onMouseEnter={() => {
            hovered.current = true;
            sync();
          }}
          onMouseLeave={() => {
            hovered.current = false;
            sync();
          }}
          onFocus={() => {
            focused.current = true;
            sync();
          }}
          onBlur={(e) => {
            if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
            focused.current = false;
            sync();
          }}
        >
          <span className="canopy-toast__message">{toast.message}</span>
          {toast.action && (
            <button type="button" className="canopy-toast__action" onClick={runAction}>
              {toast.action.label}
            </button>
          )}
          <button
            type="button"
            className="canopy-toast__close"
            aria-label="Dismiss"
            onClick={() => dismiss()}
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
}
