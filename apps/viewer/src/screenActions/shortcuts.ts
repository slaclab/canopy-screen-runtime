// Keyboard shortcuts for screen actions, matched the way Trace matches its
// own (react-trace src/hooks/useKeyboardShortcuts.ts), so ⌘S / ⌘P / ⌘I mean
// the same thing in a screen tab as in the data browser beside it: the
// primary modifier is ⌘ on macOS and Ctrl elsewhere, Shift or Alt combos
// pass through, typing in a form field is never hijacked, and only a bound,
// available action takes the key from the browser (preventDefault).
//
// The listener sits on this document's window, so it only sees keys while
// focus is inside the viewer: a host page or the Trace frame keep their own.
// A page binds one listener: the /s/ deep link's action bar owns it there;
// the workspace owns it itself, for the focused tile, and its tile bars bind
// none.

import { useEffect, useRef } from 'react';

/** `items` by their lowercase shortcut letter; an item without one is left out. */
export function shortcutBindings<T extends { shortcut?: string }>(
  items: readonly T[]
): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of items) {
    if (item.shortcut) map.set(item.shortcut.toLowerCase(), item);
  }
  return map;
}

export const isMac =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform);

/** `⌘S` on macOS, `Ctrl+S` elsewhere. */
export function formatShortcut(key: string, mac: boolean = isMac): string {
  const letter = key.toUpperCase();
  return mac ? `⌘${letter}` : `Ctrl+${letter}`;
}

/** The event fields a shortcut match depends on. */
export interface KeyEventLike {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * The lowercase letter `e` presses with the primary modifier alone, or null.
 * The physical key (e.code) wins over e.key, which layouts can remap.
 */
export function primaryShortcutKey(e: KeyEventLike, mac: boolean = isMac): string | null {
  if (e.shiftKey || e.altKey) return null;
  const primary = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (!primary) return null;
  const fromCode =
    typeof e.code === 'string' && /^Key[A-Z]$/.test(e.code) ? e.code.slice(3).toLowerCase() : '';
  return fromCode || e.key.toLowerCase();
}

/** The modifier fields an "open in a new tab" click depends on. */
export interface ModifierEventLike {
  ctrlKey: boolean;
  metaKey: boolean;
}

/**
 * Whether `e` holds the browser's "open in a new tab" modifier: ⌘ on macOS,
 * Ctrl elsewhere, held alone. Ctrl on macOS is not it (a Ctrl-click there is
 * the context-menu click), nor is ⌘ elsewhere.
 */
export function openModifier(e: ModifierEventLike, mac: boolean = isMac): boolean {
  return mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

/**
 * While mounted, call `onShortcut(value)` for a shortcut letter bound in
 * `bindings`. Both are read through a ref, so the listener is attached once.
 */
export function useShortcuts<T>(
  bindings: ReadonlyMap<string, T>,
  onShortcut: (value: T) => void
): void {
  const ref = useRef({ bindings, onShortcut });
  useEffect(() => {
    ref.current = { bindings, onShortcut };
  });
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isEditableTarget(e.target)) return;
      const key = primaryShortcutKey(e);
      if (key === null) return;
      const { bindings: bound, onShortcut: handle } = ref.current;
      if (!bound.has(key)) return;
      e.preventDefault();
      handle(bound.get(key) as T);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
