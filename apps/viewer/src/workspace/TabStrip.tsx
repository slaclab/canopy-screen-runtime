// The workspace's tab strip, the list of everything open. It is
// presentational: the tab list, the active key and the callbacks come in as
// props, so the reducer in tabs.ts stays the single source of truth. The strip scrolls horizontally; titles are rendered as text.
//
// It is an APG tablist with manual activation and one tab stop: the focusable
// tab (the last one keyboard focus was on, else the active one, else the
// first) carries tabIndex 0, every other tab -1. ←/→ move focus (wrapping),
// Home/End jump to the ends, Enter/Space activate, Delete or Backspace close
// the focused tab and move focus to its neighbour (right, else left). The
// focusable tab's close button is the next Tab stop, so it is reachable too.
// A tab that gets focus, and the tab that becomes active, is scrolled into
// view; when tabs overflow, the edge with hidden tabs fades out (a CSS mask
// driven by the scroll position), with no chevron buttons.
//
// A click on a tab hands it to the page (onFocus), which shows it in its
// tile; a click on the focused tab does nothing. The close button,
// middle-click and Delete/Backspace close a tab. With onDragStart a tab is
// draggable (the page starts it as the dock's `{tab: key}` source). The strip
// shows only with one tile and is then that tile's bar: onDragOver
// and onDrop hand the event and the strip's measured rects (StripRects: its
// own box and its tabs' boxes, client space) to the page, which passes them to
// the dock bridge's strip handlers, so a drop on the strip lands as a drop on
// the one tile's bar. A tab's context menu (also the ContextMenu key or
// Shift+F10) holds Chrome's per-tab close set: Close, Close others, Close to
// the right. The window-wide actions (Reset layout, Save open tabs as
// collection…, Recently closed, Close all, a tool's Docs and Report a bug)
// live in the ☰ window menu (dock/WindowMenu, which exports their labels);
// the page puts it at the strip row's right end. ⌘⇧T reopens the
// newest closed group (isReopenClosedShortcut, bound once by the page); ⌘W
// stays the browser's. Every close is offered for Undo by the page (one toast,
// "Closed N tabs · Undo"), not by the strip. There is no workspace title bar:
// the focused tab's header sits in its own row (one tile) or its tile's bar
// (dock/TileBar), whose screen detail comes from tabDetail below. The strip
// row carries no action of a single panel.

import { useContext, useEffect, useRef, useState } from 'react';
import type {
  DragEvent as ReactDragEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
} from 'react';
import { Menu, MenuItem } from '@carbon/react';
import { EmbedThemeContext } from '../pages/EmbedPage.js';
import { parseTabKey } from './tabs.js';
import { closedMessage, UNDO } from './useToasts.js';
import './TabStrip.css';

/** One open tab as the strip shows it; the shell derives the title. */
export interface TabStripTab {
  key: string;
  title: string;
}

export interface TabStripProps {
  /** The open tabs, in strip order. */
  tabs: readonly TabStripTab[];
  /** The active tab's key, or null when none is open. */
  activeKey: string | null;
  /** Show `key`: dock it into the focused tile, or focus its tile. */
  onFocus: (key: string) => void;
  /** Close the tab `key` for good. */
  onClose: (key: string) => void;
  /** A tab drag started: record the dock source. Absent: tabs are not draggable. */
  onDragStart?: (key: string, dataTransfer: DataTransfer | null) => void;
  /** A drag moves over the strip (also its dragenter); `rects` is the strip measured now. */
  onDragOver?: (event: ReactDragEvent, rects: StripRects) => void;
  /** A drop on the strip. */
  onDrop?: (event: ReactDragEvent, rects: StripRects) => void;
  /** Close every tab but `key`, as one undoable group. Absent: no such entry. */
  onCloseOthers?: (key: string) => void;
  /** Close the tabs right of `key`, as one undoable group. Absent: no such entry. */
  onCloseToRight?: (key: string) => void;
}

/** A client-space box. */
export interface StripRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The strip as the one tile's bar: its own box and its tabs' boxes, in strip order. */
export interface StripRects {
  barRect: StripRect;
  tabRects: StripRect[];
}

export const CLOSE_TAB = 'Close';
export const CLOSE_OTHERS = 'Close others';
export const CLOSE_TO_RIGHT = 'Close to the right';
export { closedMessage, UNDO };

/** ⌘⇧T (Ctrl+Shift+T elsewhere): reopen the newest closed group. */
export function isReopenClosedShortcut(
  e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>,
  mac: boolean
): boolean {
  if (!e.shiftKey || e.altKey || e.key.toLowerCase() !== 't') return false;
  return mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}

interface MenuItemSpec {
  label: string;
  disabled?: boolean;
  run: () => void;
}

interface Fades {
  start: boolean;
  end: boolean;
}

const NO_FADES: Fades = { start: false, end: false };

/** Which edges hide tabs: a fade shows there. One pixel of slack for zoom rounding. */
function fadesOf(list: HTMLElement): Fades {
  const hidden = list.scrollWidth - list.clientWidth;
  if (hidden <= 1) return NO_FADES;
  return { start: list.scrollLeft > 1, end: list.scrollLeft < hidden - 1 };
}

function tabElement(list: HTMLElement | null, key: string): HTMLElement | undefined {
  if (!list) return undefined;
  return Array.from(list.querySelectorAll<HTMLElement>('[data-tab-key]')).find(
    (t) => t.dataset.tabKey === key
  );
}

function reveal(el: HTMLElement) {
  el.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
}

interface MenuState {
  x: number;
  y: number;
  items: MenuItemSpec[];
  /** The embed layout's root when the menu opened; null outside one. */
  target: HTMLElement | null;
}

/** Inline Carbon "Close" glyph, to avoid an @carbon/icons-react dependency. */
function CloseIcon() {
  return (
    <svg viewBox="0 0 32 32" width="12" height="12" fill="currentColor" aria-hidden="true">
      <path d="M17.4141 16 24 9.4141 22.5859 8 16 14.5859 9.4143 8 8 9.4141 14.5859 16 8 22.5859 9.4143 24 16 17.4141 22.5859 24 24 22.5859 17.4141 16z" />
    </svg>
  );
}

function rectOf(el: Element): StripRect {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}

/** The strip's box and its tabs' boxes, measured now. */
function measureStrip(list: HTMLElement): StripRects {
  return {
    barRect: rectOf(list),
    tabRects: Array.from(list.querySelectorAll('.tab-strip__tab')).map(rectOf),
  };
}

export function TabStrip({
  tabs,
  activeKey,
  onFocus,
  onClose,
  onDragStart,
  onDragOver,
  onDrop,
  onCloseOthers,
  onCloseToRight,
}: TabStripProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [fades, setFades] = useState<Fades>(NO_FADES);
  /** The tab that takes keyboard focus once a closed tab has left the list. */
  const pendingFocus = useRef<{ closed: string; next: string | null } | null>(null);
  const { anchorRef } = useContext(EmbedThemeContext);

  const keys = tabs.map((t) => t.key);
  // The one tab stop: the last keyboard-focused tab, else the active, else the first.
  const rovingKey =
    focusKey !== null && keys.includes(focusKey)
      ? focusKey
      : activeKey !== null && keys.includes(activeKey)
        ? activeKey
        : (keys[0] ?? null);

  useEffect(() => {
    if (activeKey === null) return;
    const list = listRef.current;
    const el = tabElement(list, activeKey);
    if (!list || !el) return;
    const again = () => reveal(el);
    again();
    // Tab metrics can change after this effect ran (a late web-font face or a
    // strip resize): reveal the active tab again then.
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(again);
    observer.observe(list);
    observer.observe(el);
    return () => observer.disconnect();
  }, [activeKey, tabs.length]);

  // The edge fades follow the scroll position, the strip's size and the tab list.
  const syncFades = () => {
    const list = listRef.current;
    if (!list) return;
    const next = fadesOf(list);
    setFades((prev) => (prev.start === next.start && prev.end === next.end ? prev : next));
  };
  useEffect(() => {
    syncFades();
    const list = listRef.current;
    if (!list || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(syncFades);
    observer.observe(list);
    return () => observer.disconnect();
  }, [tabs]);

  // A tab closed with focus inside it hands focus to its neighbour once it is gone.
  useEffect(() => {
    const pending = pendingFocus.current;
    if (pending === null || keys.includes(pending.closed)) return;
    pendingFocus.current = null;
    if (pending.next !== null) tabElement(listRef.current, pending.next)?.focus();
  });

  const focusTab = (key: string) => {
    setFocusKey(key);
    tabElement(listRef.current, key)?.focus();
  };

  /** Close `key`; when focus was inside it, focus moves to its neighbour. */
  const closeTab = (key: string) => {
    const el = tabElement(listRef.current, key);
    const hadFocus = el !== undefined && el.contains(document.activeElement);
    if (hadFocus) {
      const index = keys.indexOf(key);
      const neighbour = keys[index + 1] ?? keys[index - 1] ?? null;
      pendingFocus.current = { closed: key, next: neighbour };
      if (neighbour !== null) setFocusKey(neighbour);
    }
    onClose(key);
  };

  // The focused tab is already shown: a click on it does nothing.
  const show = (key: string) => {
    if (key !== activeKey) onFocus(key);
  };

  /** A tab's menu: Chrome's per-tab close set. */
  const itemsFor = (key: string): MenuItemSpec[] => {
    const items: MenuItemSpec[] = [{ label: CLOSE_TAB, run: () => onClose(key) }];
    const index = keys.indexOf(key);
    if (onCloseOthers) {
      items.push({
        label: CLOSE_OTHERS,
        disabled: keys.length - 1 === 0,
        run: () => onCloseOthers(key),
      });
    }
    if (onCloseToRight) {
      items.push({
        label: CLOSE_TO_RIGHT,
        disabled: index < 0 || keys.length - index - 1 === 0,
        run: () => onCloseToRight(key),
      });
    }
    return items;
  };

  /** The tablist keys: move focus, activate, close. */
  const tabKeyDown = (e: ReactKeyboardEvent<HTMLElement>, key: string) => {
    if (menuKey(e, key)) return;
    // Keys on the close button are the button's own (Enter/Space click it).
    if (e.target !== e.currentTarget) return;
    const index = keys.indexOf(key);
    let next: string | undefined;
    switch (e.key) {
      case 'ArrowRight':
        next = keys[(index + 1) % keys.length];
        break;
      case 'ArrowLeft':
        next = keys[(index - 1 + keys.length) % keys.length];
        break;
      case 'Home':
        next = keys[0];
        break;
      case 'End':
        next = keys[keys.length - 1];
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        show(key);
        return;
      case 'Delete':
      case 'Backspace':
        e.preventDefault();
        closeTab(key);
        return;
      default:
        return;
    }
    e.preventDefault();
    if (next !== undefined) focusTab(next);
  };

  // The anchor is read when the menu opens, never during render.
  const openMenu = (x: number, y: number, key: string) => {
    setMenu({ x, y, items: itemsFor(key), target: anchorRef.current });
  };

  /** The ContextMenu key or Shift+F10 opens a tab's menu below it. */
  const menuKey = (e: ReactKeyboardEvent<HTMLElement>, key: string): boolean => {
    if (e.key !== 'ContextMenu' && !(e.key === 'F10' && e.shiftKey)) return false;
    const rect = e.currentTarget.getBoundingClientRect();
    openMenu(rect.left, rect.bottom, key);
    e.preventDefault();
    return true;
  };

  const dragOver = onDragOver
    ? (e: ReactDragEvent) => {
        if (listRef.current) onDragOver(e, measureStrip(listRef.current));
      }
    : undefined;

  let stripClass = 'tab-strip';
  if (fades.start) stripClass += ' tab-strip--fade-start';
  if (fades.end) stripClass += ' tab-strip--fade-end';

  return (
    <div
      className={stripClass}
      role="tablist"
      aria-label="Open tabs"
      ref={listRef}
      onScroll={syncFades}
      onDragEnter={dragOver}
      onDragOver={dragOver}
      onDrop={
        onDrop
          ? (e: ReactDragEvent) => {
              if (listRef.current) onDrop(e, measureStrip(listRef.current));
            }
          : undefined
      }
    >
      {tabs.map(({ key, title }) => {
        const active = key === activeKey;
        let className = 'tab-strip__tab';
        if (active) className += ' tab-strip__tab--active';
        return (
          <div
            key={key}
            className={className}
            role="tab"
            aria-selected={active}
            tabIndex={key === rovingKey ? 0 : -1}
            data-tab-key={key}
            title={title}
            draggable={onDragStart !== undefined}
            onDragStart={
              onDragStart
                ? (e: ReactDragEvent) => onDragStart(key, e.dataTransfer ?? null)
                : undefined
            }
            onClick={() => show(key)}
            onFocus={(e) => {
              if (e.target !== e.currentTarget) return;
              setFocusKey(key);
              reveal(e.currentTarget);
            }}
            onKeyDown={(e) => tabKeyDown(e, key)}
            onMouseDown={(e: ReactMouseEvent) => {
              // Suppress the browser's middle-button autoscroll.
              if (e.button === 1) e.preventDefault();
            }}
            onAuxClick={(e: ReactMouseEvent) => {
              if (e.button !== 1) return;
              e.preventDefault();
              closeTab(key);
            }}
            onContextMenu={(e: ReactMouseEvent) => {
              e.preventDefault();
              openMenu(e.clientX, e.clientY, key);
            }}
          >
            <span className="tab-strip__title">{title}</span>
            <button
              type="button"
              className="tab-strip__close"
              aria-label={`Close ${title}`}
              title="Close"
              tabIndex={key === rovingKey ? 0 : -1}
              draggable={false}
              onClick={(e) => {
                e.stopPropagation();
                closeTab(key);
              }}
            >
              <CloseIcon />
            </button>
          </div>
        );
      })}
      {menu && (
        <Menu
          label="Tab actions"
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
              disabled={item.disabled}
              onClick={() => {
                if (!item.disabled) item.run();
                setMenu(null);
              }}
            />
          ))}
        </Menu>
      )}
    </div>
  );
}

/** Screen-header detail for a tab: `category/id` plus `?macros`; none for a tool. */
export function tabDetail(key: string | null): string | undefined {
  if (key === null) return undefined;
  const parsed = parseTabKey(key);
  if (!parsed || parsed.kind !== 'screen') return undefined;
  const base = `${parsed.category}/${parsed.id}`;
  return parsed.query ? `${base}?${parsed.query}` : base;
}
