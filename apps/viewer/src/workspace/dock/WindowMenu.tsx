// The window menu (☰): the workspace's window-wide actions in one place
// rather than per tile. There is exactly one, at the right end of the bar of the
// tile touching the dock's top-right corner (topRightTile); with one tile it
// sits at the right end of the strip, which is then that tile's bar. No row
// of its own.
//
// It holds, in order: "Reset layout" (disabled below two tiles), "Save open
// tabs as collection…" (with collections only; disabled with no tab open),
// "Recently closed" (a submenu of the closed groups newest first, each with
// its closer; disabled while nothing was closed), "Close all" (disabled with
// no tab open), then the focused tool's own "Docs" and "Report a bug" when it
// reported those links in its tool-actions message (opened in a new browser
// tab, cut off from this
// page). An entry whose callback is absent is not shown.
//
// Keyboard: the ☰ is a plain button (Enter/Space, or ↓, opens the menu);
// isWindowMenuShortcut (⌥M on macOS, Alt+M elsewhere, by the physical key) is
// bound once by the page, which owns the open state, so it opens the menu
// wherever the ☰ currently sits. Carbon's Menu moves focus into the menu and
// handles the arrows, Enter and Escape; on close focus goes back to the ☰
// before the chosen entry runs, so an entry that opens a dialog keeps it.

import { useContext, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Menu, MenuItem, MenuItemDivider } from '@carbon/react';
import { EmbedThemeContext } from '../../pages/EmbedPage.js';
import type { ClosedBy } from '../tabs.js';
import type { ToolActionsLinks } from '../toolActionsStore.js';
import { isTile } from '@slaclab/canopy-dock-engine';
import type { Layout } from '@slaclab/canopy-dock-engine';

export const WINDOW_MENU = 'Window menu';
export const RESET_LAYOUT = 'Reset layout';
export const SAVE_AS_COLLECTION = 'Save open tabs as collection…';
export const CLOSE_ALL = 'Close all';
export const RECENTLY_CLOSED = 'Recently closed';
export const TOOL_DOCS = 'Docs';
export const REPORT_BUG = 'Report a bug';

/** One closed group as "Recently closed" lists it. */
export interface ClosedGroupItem {
  id: string;
  /** What it holds: its tab titles, or "Layout reset". */
  label: string;
  closedBy: ClosedBy;
}

/** A "Recently closed" entry's text: what the group holds and who closed it. */
export function closedGroupLabel({ label, closedBy }: ClosedGroupItem): string {
  return `${label} · ${closedBy === 'agent' ? 'agent' : 'you'}`;
}

/** The titles of a closed group's tabs as one label: the first two, then "+N". */
export function closedTitles(titles: readonly string[]): string {
  if (titles.length <= 2) return titles.join(', ');
  return `${titles.slice(0, 2).join(', ')} +${titles.length - 2}`;
}

/** The shortcut that opens the window menu, as shown: ⌥M on macOS, Alt+M elsewhere. */
export function windowMenuShortcutLabel(mac: boolean): string {
  return mac ? '⌥M' : 'Alt+M';
}

/** The key event fields the shortcut reads. */
export interface WindowMenuKeyEvent {
  key: string;
  code?: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

/**
 * ⌥M (Alt+M elsewhere) alone opens the window menu; the chord is the same on
 * every platform. The physical key wins (⌥M types µ on a Mac layout).
 */
export function isWindowMenuShortcut(e: WindowMenuKeyEvent): boolean {
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return false;
  if (typeof e.code === 'string' && e.code !== '') return e.code === 'KeyM';
  return e.key.toLowerCase() === 'm';
}

/**
 * The tile touching the dock's top-right corner: down a row's last item and
 * a column's first, so with any sizes it is the tile whose bar ends at the
 * dock's right edge on the top line. Null for no layout.
 */
export function topRightTile<K>(layout: Layout<K> | null): string | null {
  let node = layout;
  while (node !== null && !isTile(node)) {
    node = (node.split === 'row' ? node.items[node.items.length - 1] : node.items[0]) ?? null;
  }
  return node === null ? null : node.tile;
}

export interface WindowMenuProps {
  /** The menu is open (the page owns it, so its shortcut reaches the one ☰). */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** How many tabs are open; Save and Close all need one. */
  tabCount: number;
  /** Every tile as an equal column. Absent: no "Reset layout". */
  onReset?: () => void;
  /** "Reset layout" is shown disabled (fewer than two tiles). */
  resetDisabled?: boolean;
  /** Ask for the Save collection dialog. Absent: no such entry. */
  onSaveAsCollection?: () => void;
  /** The closed groups, newest first. */
  closedGroups?: readonly ClosedGroupItem[];
  /** Reopen closed group `id` in place. Absent: no "Recently closed". */
  onReopenGroup?: (id: string) => void;
  /** Close every tab as one undoable group. Absent: no "Close all". */
  onCloseAll?: () => void;
  /** The links of the focused tool's tool-actions message. Absent or empty: no Docs / Report a bug. */
  toolLinks?: ToolActionsLinks | null;
  /** The shortcut text for the button's title. */
  shortcutLabel?: string;
}

interface Entry {
  label: string;
  disabled?: boolean;
  /** A divider goes above this entry. */
  group?: boolean;
  children?: { label: string; run: () => void }[];
  run: () => void;
}

/** Open a tool's link in a new browser tab, cut off from this page. */
function openExternal(url: string) {
  window.open(url, '_blank', 'noopener,noreferrer');
}

/** Inline "menu" glyph (three bars), to avoid an @carbon/icons-react dependency. */
function MenuIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
      <path d="M2 3h12v1.5H2zM2 7.25h12v1.5H2zM2 11.5h12V13H2z" />
    </svg>
  );
}

export function WindowMenu({
  open,
  onOpenChange,
  tabCount,
  onReset,
  resetDisabled = false,
  onSaveAsCollection,
  closedGroups,
  onReopenGroup,
  onCloseAll,
  toolLinks,
  shortcutLabel,
}: WindowMenuProps) {
  // The ☰ as state (a callback ref), so an open menu reads its box in render.
  const [button, setButton] = useState<HTMLButtonElement | null>(null);
  const { anchorRef } = useContext(EmbedThemeContext);
  // Where the menu portals: the embed layout's root, else the body. Resolved before the menu
  // mounts and held while it is open. Carbon's Menu is `position: fixed` and writes its insets
  // from the ☰'s viewport box once, when it opens; moved to another portal target afterwards it
  // would be remounted without them and fall to its static position, below the page. The root
  // makes no containing block for fixed boxes (no transform, filter or contain), so viewport
  // coordinates hold in either target.
  const [target, setTarget] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    setTarget(open ? (anchorRef.current ?? document.body) : null);
  }, [open, anchorRef]);

  const entries: Entry[] = [];
  if (onReset) entries.push({ label: RESET_LAYOUT, disabled: resetDisabled, run: onReset });
  if (onSaveAsCollection) {
    entries.push({ label: SAVE_AS_COLLECTION, disabled: tabCount === 0, run: onSaveAsCollection });
  }
  const closing: Entry[] = [];
  if (onReopenGroup) {
    const groups = closedGroups ?? [];
    closing.push(
      groups.length > 0
        ? {
            label: RECENTLY_CLOSED,
            run: () => {},
            children: groups.map((item) => ({
              label: closedGroupLabel(item),
              run: () => onReopenGroup(item.id),
            })),
          }
        : { label: RECENTLY_CLOSED, disabled: true, run: () => {} }
    );
  }
  if (onCloseAll) closing.push({ label: CLOSE_ALL, disabled: tabCount === 0, run: onCloseAll });
  const links: Entry[] = [];
  const docs = toolLinks?.docs;
  const bug = toolLinks?.bug;
  if (docs) links.push({ label: TOOL_DOCS, run: () => openExternal(docs) });
  if (bug) links.push({ label: REPORT_BUG, run: () => openExternal(bug) });
  for (const part of [closing, links]) {
    if (part.length === 0) continue;
    if (entries.length > 0) part[0] = { ...part[0]!, group: true };
    entries.push(...part);
  }

  /** Close the menu, hand focus back to the ☰, then run the entry. */
  const choose = (run: () => void) => {
    onOpenChange(false);
    button?.focus();
    run();
  };

  // A press on the ☰ while the menu is open first moves focus out of the menu, which closes
  // it (Carbon closes on blur); the click that follows must leave it closed, not reopen it.
  const pressedOpen = useRef(false);
  const onButtonClick = () => {
    const wasOpen = open || pressedOpen.current;
    pressedOpen.current = false;
    onOpenChange(!wasOpen);
  };

  const onButtonKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== 'ArrowDown') return;
    e.preventDefault();
    onOpenChange(true);
  };

  // The menu hangs below the ☰, wherever it sits when it opens.
  const box = open && button ? button.getBoundingClientRect() : null;

  const title = shortcutLabel ? `${WINDOW_MENU} (${shortcutLabel})` : WINDOW_MENU;

  return (
    <>
      <button
        ref={setButton}
        type="button"
        className="canopy-window-menu"
        aria-label={WINDOW_MENU}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-keyshortcuts={shortcutLabel ? 'Alt+M' : undefined}
        title={title}
        data-testid="window-menu"
        draggable={false}
        onPointerDown={() => {
          pressedOpen.current = open;
        }}
        onClick={onButtonClick}
        onKeyDown={onButtonKeyDown}
      >
        <MenuIcon />
      </button>
      {open && box && target && entries.length > 0 && (
        <Menu
          label={WINDOW_MENU}
          mode="basic"
          size="sm"
          open
          x={[box.left, box.right]}
          y={[box.top, box.bottom]}
          menuAlignment="bottom-end"
          target={target}
          onClose={() => {
            onOpenChange(false);
            button?.focus();
          }}
        >
          {entries.flatMap((item) => {
            const entry = item.children ? (
              <MenuItem key={item.label} label={item.label}>
                {item.children.map((child, i) => (
                  <MenuItem
                    key={`${i}:${child.label}`}
                    label={child.label}
                    onClick={() => choose(child.run)}
                  />
                ))}
              </MenuItem>
            ) : (
              <MenuItem
                key={item.label}
                label={item.label}
                disabled={item.disabled}
                onClick={() => {
                  if (item.disabled) return;
                  choose(item.run);
                }}
              />
            );
            return item.group
              ? [<MenuItemDivider key={`${item.label}-divider`} />, entry]
              : [entry];
          })}
        </Menu>
      )}
    </>
  );
}
