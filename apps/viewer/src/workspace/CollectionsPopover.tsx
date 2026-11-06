// The Collections popover: the one place to tick which collections the Browse
// tree shows. A trigger button (aria-expanded / aria-controls) opens a
// Carbon Popover listing every collection in two groups, Facility and
// Personal, each in list order. A row is a checkbox bound to the tick/untick
// state ops (checked = in the shown selection) and an "Open all" button whose
// accessible name carries the collection's name; Tab moves checkbox → Open all
// within a row, then to the next row. The footer asks the page for the
// "Save open tabs as collection…" dialog.
//
// Esc and an outside click close the popover and return focus to the trigger;
// Open all and the footer close it too. It always starts closed: its open state
// is never persisted. Without config.collections (api.enabled false) it
// renders nothing. It has no filter box and no chips.
//
// The ops report their own failures through the workspace's inline notice
// (useCollections), so the popover only fires them.
//
// A row reads "<name> · N · <when>" (collections.ts), so same-name
// collections stay distinguishable; the name ellipsises and the row's title
// holds the whole string. The badge tells personal from facility. The
// description shows clamped to two lines, its title the full text, and the
// button reads "Open all (N)", or "Open all (k of N)" when only k members
// would open here (openAllCount). A refused collection (one the server
// cannot read, or a layout the viewer refuses; useCollections `refused`)
// cannot be opened: its Open all is disabled and the row names the reason
// below its line (refusedText). An editable personal row has a menu button
// (and a context menu) with Rename and Delete (CollectionMenu.tsx):
// Rename swaps the name for the inline field, the collection held until it
// closes; the menu renders inside the popover so it never reads as an outside
// click, and a clicked item (unmounted before Carbon's window listener sees
// the click) does not close it either, so Rename by mouse works as Enter
// does. Placement is Carbon's fixed floating styles (they escape the aside's
// clip; no portal, no manual positioning), switched on by the
// enableV12DynamicFloatingStyles flag rather than autoAlign: autoAlign's flip
// measures against the clipping aside, finds no placement fits a 180 px
// sidebar and settles on the centred `bottom`, whose left edge is off-screen.
// Without flip the content always opens bottom-start under the trigger, and
// its width is capped at the viewport, so a 180 px sidebar never hides the
// checkbox, the name, Open all or the save footer.
//
// Controlled open: the host's ⋯ entry and the sidebar ⋯ entry open this same
// popover, anchored in the sidebar, through openCollections(). An uncontrolled
// popover keeps its open flag in a small module store (useCollectionsOpen()
// reads it, closeCollections() clears it), reset on unmount so a remount still
// starts closed. A popover inside the collapsed sidebar's 0 px aside is
// invisible, so openCollections() first expands the sidebar the page
// registered with registerCollectionsSidebar(). Passing `open` makes the
// popover controlled: it follows the prop, ignores the store, and reports its
// own open / close gestures through `onOpenChange` (called for an uncontrolled
// popover's gestures too). The trigger keeps working standalone either way.

import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Checkbox, FeatureFlags, Popover, PopoverContent } from '@carbon/react';
import { OverflowMenuVertical } from '@carbon/icons-react';
import { collectionSuffix, collectionSummary } from './collections.js';
import { CollectionBadge } from './CollectionBadge.js';
import {
  CollectionMenu,
  CollectionRenameField,
  collectionEditItems,
  isEditable,
  useCollectionEdits,
} from './CollectionMenu.js';
import type { CollectionMenuItem } from './CollectionMenu.js';
import type { Collection, CollectionsApi } from './useCollections.js';
import './CollectionsPopover.css';

export interface CollectionsPopoverProps {
  api: Pick<CollectionsApi, 'enabled' | 'collections' | 'shown' | 'tick' | 'untick' | 'openAll'> &
    Partial<Pick<CollectionsApi, 'openAllCount' | 'edit' | 'deleteCollection' | 'holdCollection'>>;
  /** Opens the "Save open tabs as collection…" dialog (page-owned). */
  onSave: () => void;
  /** Controlled open flag; when given the popover ignores the open store. */
  open?: boolean;
  /** Called with the next open flag on the popover's own open / close gestures. */
  onOpenChange?: (open: boolean) => void;
  /**
   * Renders the "Collections" trigger button (default). False keeps the
   * popover, opened through openCollections() only (the one-row sidebar
   * header opens it from its ⋯).
   */
  trigger?: boolean;
}

// --- the open store ----------------------------------------------------------

let storeOpen = false;
const listeners = new Set<() => void>();
/** Uncontrolled, enabled popovers currently mounted. */
let mountedCount = 0;

function setStoreOpen(next: boolean): void {
  if (storeOpen === next) return;
  storeOpen = next;
  for (const listener of [...listeners]) listener();
}

function subscribeOpen(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getOpen(): boolean {
  return storeOpen;
}

/** Whether the (uncontrolled) Collections popover is open. */
export function useCollectionsOpen(): boolean {
  return useSyncExternalStore(subscribeOpen, getOpen, getOpen);
}

/** What openCollections() needs from the sidebar holding the popover. */
export interface CollectionsSidebar {
  collapsed: () => boolean;
  expand: () => void;
}

let sidebar: CollectionsSidebar | null = null;

/**
 * Registers the sidebar the popover lives in, so openCollections() can expand
 * it first. Returns the unregister function (a no-op once replaced).
 */
export function registerCollectionsSidebar(next: CollectionsSidebar): () => void {
  sidebar = next;
  return () => {
    if (sidebar === next) sidebar = null;
  };
}

/**
 * Opens the mounted Collections popover, expanding a collapsed sidebar first.
 * False when no (enabled, uncontrolled) popover is mounted.
 */
export function openCollections(): boolean {
  if (mountedCount === 0) return false;
  if (sidebar?.collapsed()) sidebar.expand();
  setStoreOpen(true);
  return true;
}

/** Closes the Collections popover (a no-op when it is closed). */
export function closeCollections(): void {
  setStoreOpen(false);
}

const GROUPS: { source: Collection['source']; label: string }[] = [
  { source: 'facility', label: 'Facility' },
  { source: 'personal', label: 'Personal' },
];

export const SAVE_LABEL = 'Save open tabs as collection…';

/**
 * How a row names its collection — the name, or, when another collection
 * in `among` (the shown list) reads the same, its full summary with the id.
 */
export function rowName(collection: Collection, among?: readonly Collection[]): string {
  if (!among) return collection.name;
  const now = new Date();
  const apart = collectionSummary(collection, now, among);
  return apart === collectionSummary(collection, now) ? collection.name : apart;
}

/** The accessible name of a row's Open all button. */
export function openAllLabel(collection: Collection, among?: readonly Collection[]): string {
  return `Open all ${rowName(collection, among)}`;
}

/** The visible text of a row's Open all: "(N)", or "(k of N)" when fewer would open. */
export function openAllText(count: { opened: number; total: number } | null, members: number) {
  if (count === null || count.opened >= count.total) {
    return `Open all (${count?.total ?? members})`;
  }
  return `Open all (${count.opened} of ${count.total})`;
}

/** The line a refused row shows below its name. */
export function refusedText(refused: string): string {
  return `Cannot be opened: ${refused}`;
}

/** The accessible name of a row's menu button. */
export function rowActionsLabel(collection: Collection, among?: readonly Collection[]): string {
  return `Actions for ${rowName(collection, among)}`;
}

interface RowMenu {
  ref: string;
  x: number;
  y: number;
  items: CollectionMenuItem[];
  /** The popover's root: the menu renders inside it, so its clicks stay inside. */
  target: HTMLElement;
}

export function CollectionsPopover({
  api,
  onSave,
  open: openProp,
  onOpenChange,
  trigger = true,
}: CollectionsPopoverProps) {
  const stored = useCollectionsOpen();
  const controlled = openProp !== undefined;
  const open = controlled ? openProp : stored;
  const setOpen = useCallback(
    (next: boolean) => {
      if (!controlled) setStoreOpen(next);
      onOpenChange?.(next);
    },
    [controlled, onOpenChange]
  );
  // An uncontrolled, enabled popover is the target of openCollections(); its
  // open flag never outlives it.
  const target = api.enabled && !controlled;
  useEffect(() => {
    if (!target) return;
    mountedCount += 1;
    return () => {
      mountedCount -= 1;
      setStoreOpen(false);
    };
  }, [target]);
  const [menu, setMenu] = useState<RowMenu | null>(null);
  /** The collection whose rename field is open, as it was when it opened. */
  const [renaming, setRenaming] = useState<Collection | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const contentRef = useRef<HTMLSpanElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const edits = useCollectionEdits(api.enabled ? api : undefined);
  const baseId = useId();
  const contentId = `${baseId}-collections`;

  /** The ref this popover holds (an open rename field), released on any close. */
  const held = useRef<string | null>(null);
  const holdCollection = api.holdCollection;

  /** Set while a row menu item's click is still being dispatched. */
  const menuActed = useRef(false);

  const focusTrigger = useCallback(() => triggerRef.current?.focus(), []);

  /** Closes, dropping an open row menu or rename field (and its hold). */
  const hide = useCallback(() => {
    setOpen(false);
    setMenu(null);
    setRenaming(null);
    if (held.current !== null) {
      held.current = null;
      holdCollection?.(null);
    }
  }, [holdCollection, setOpen]);

  /** Close; `refocus` puts focus back on the trigger. */
  const close = useCallback(
    (refocus: boolean) => {
      hide();
      if (refocus) focusTrigger();
    },
    [hide, focusTrigger]
  );

  // Carbon calls this on an outside click and when focus leaves the popover.
  // Focus goes back to the trigger only when nothing else took it (a click on
  // a bare area, or the focused control unmounting); a Tab or click onto
  // another control keeps that control focused.
  //
  // A row menu item that just ran is not an outside click: in a
  // browser React unmounts the clicked item before Carbon's window click
  // listener runs, so the detached target reads as outside the popover.
  const onRequestClose = useCallback(() => {
    if (menuActed.current) return;
    hide();
    setTimeout(() => {
      const active = document.activeElement;
      if (!active || active === document.body || !active.isConnected) focusTrigger();
    }, 0);
  }, [hide, focusTrigger]);

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      // An open row menu takes its own Esc (it bubbles here through the portal).
      if (event.key !== 'Escape' || !open || menu !== null) return;
      event.stopPropagation();
      event.preventDefault();
      close(true);
    },
    [open, close, menu]
  );

  // On open, focus the first control, so the keyboard lands in the list.
  useEffect(() => {
    if (!open) return;
    const first = contentRef.current?.querySelector<HTMLElement>('input, button');
    first?.focus();
  }, [open]);

  if (!api.enabled) return null;

  const shown = new Set(api.shown.map((c) => c.ref));

  const toggle = (collection: Collection, checked: boolean) => {
    void (checked ? api.tick(collection.ref) : api.untick(collection.ref));
  };

  const openAll = (collection: Collection) => {
    close(true);
    api.openAll(collection);
  };

  const canEdit = (collection: Collection) =>
    !!api.edit && !!api.deleteCollection && isEditable(collection);

  const rowSelector = (ref: string) => `[data-collection-ref="${CSS.escape(ref)}"]`;

  /** Focus back on the row's menu button (or its checkbox) after a menu or rename. */
  const focusRow = (ref: string) => {
    const row = contentRef.current?.querySelector(rowSelector(ref));
    row
      ?.querySelector<HTMLElement>('.collections-popover__actions, input[type="checkbox"]')
      ?.focus();
  };

  const startRename = (collection: Collection) => {
    held.current = collection.ref;
    api.holdCollection?.(collection.ref);
    setRenaming(collection);
  };

  const finishRename = (collection: Collection, name: string | null) => {
    setRenaming(null);
    held.current = null;
    api.holdCollection?.(null);
    if (name !== null) void edits.rename(collection, name);
    setTimeout(() => focusRow(collection.ref), 0);
  };

  const openMenu = (collection: Collection, x: number, y: number) => {
    const items = collectionEditItems(collection, {
      rename: startRename,
      delete: (c) => void edits.remove(c),
    }).map((item) => ({
      ...item,
      run: () => {
        menuActed.current = true;
        setTimeout(() => {
          menuActed.current = false;
        }, 0);
        item.run();
      },
    }));
    const target = rootRef.current;
    if (items.length > 0 && target) setMenu({ ref: collection.ref, x, y, items, target });
  };

  const closeMenu = () => {
    const was = menu;
    setMenu(null);
    // Rename moves focus into its field; otherwise focus returns to the row.
    if (was)
      setTimeout(() => {
        const active = document.activeElement;
        if (!active || active === document.body || !active.isConnected) focusRow(was.ref);
      }, 0);
  };

  const save = () => {
    close(false);
    onSave();
  };

  const groups = GROUPS.map((group) => ({
    ...group,
    items: api.collections.filter((c) => c.source === group.source),
  })).filter((group) => group.items.length > 0);

  return (
    <FeatureFlags enableV12DynamicFloatingStyles>
      <Popover
        as="div"
        ref={rootRef}
        open={open}
        align="bottom-start"
        onRequestClose={onRequestClose}
        onKeyDown={onKeyDown}
        className="collections-popover"
        data-testid="collections-popover"
      >
        {trigger && (
          <button
            ref={triggerRef}
            type="button"
            className="canopy-btn collections-popover__trigger"
            aria-expanded={open}
            aria-controls={contentId}
            aria-haspopup="true"
            data-testid="collections-popover-trigger"
            onClick={() => (open ? hide() : setOpen(true))}
          >
            Collections
          </button>
        )}
        <PopoverContent
          id={contentId}
          ref={contentRef}
          className="collections-popover__content"
          role="group"
          aria-label="Collections"
        >
          {open && (
            <div className="collections-popover__body">
              {groups.length === 0 && <p className="collections-popover__empty">No collections.</p>}
              {groups.map((group) => (
                <div
                  key={group.source}
                  className="collections-popover__group"
                  role="group"
                  aria-labelledby={`${baseId}-${group.source}`}
                >
                  <h3
                    id={`${baseId}-${group.source}`}
                    className="canopy-section-heading collections-popover__heading"
                  >
                    {group.label}
                  </h3>
                  <ul className="collections-popover__list">
                    {group.items.map((collection) => (
                      <li
                        key={collection.ref}
                        className="collections-popover__row"
                        data-collection-ref={collection.ref}
                        onContextMenu={
                          canEdit(collection)
                            ? (event) => {
                                event.preventDefault();
                                openMenu(collection, event.clientX, event.clientY);
                              }
                            : undefined
                        }
                      >
                        <div className="collections-popover__line">
                          <div
                            className="collections-popover__label"
                            title={collectionSummary(collection, undefined, api.collections)}
                          >
                            {renaming?.ref === collection.ref ? (
                              <CollectionRenameField
                                name={renaming.name}
                                onCommit={(name) => finishRename(renaming, name)}
                                onCancel={() => finishRename(renaming, null)}
                              />
                            ) : (
                              <Checkbox
                                id={`${baseId}-tick-${collection.ref}`}
                                className="collections-popover__check"
                                labelText={
                                  <span className="collections-popover__name">
                                    {collection.name}
                                  </span>
                                }
                                checked={shown.has(collection.ref)}
                                onChange={(_event, { checked }) => toggle(collection, checked)}
                              />
                            )}
                            <CollectionBadge source={collection.source} />
                            <span className="collections-popover__suffix">
                              {`\u00b7 ${collectionSuffix(collection, undefined, api.collections)}`}
                            </span>
                          </div>
                          <button
                            type="button"
                            className="canopy-btn collections-popover__open-all"
                            aria-label={openAllLabel(collection, api.collections)}
                            title={
                              collection.refused === undefined
                                ? openAllLabel(collection, api.collections)
                                : refusedText(collection.refused)
                            }
                            disabled={collection.refused !== undefined}
                            onClick={() => openAll(collection)}
                          >
                            {openAllText(
                              api.openAllCount?.(collection) ?? null,
                              collection.members.length
                            )}
                          </button>
                          {canEdit(collection) && (
                            <button
                              type="button"
                              className="canopy-btn collections-popover__actions"
                              aria-label={rowActionsLabel(collection, api.collections)}
                              title={rowActionsLabel(collection, api.collections)}
                              aria-haspopup="menu"
                              aria-expanded={menu?.ref === collection.ref}
                              onClick={(event) => {
                                const box = event.currentTarget.getBoundingClientRect();
                                openMenu(collection, box.left, box.bottom);
                              }}
                            >
                              <OverflowMenuVertical size={16} />
                            </button>
                          )}
                        </div>
                        {collection.refused !== undefined && (
                          <p
                            className="collections-popover__description collections-popover__refused"
                            data-testid="collection-refused"
                          >
                            {refusedText(collection.refused)}
                          </p>
                        )}
                        {collection.description && (
                          <p
                            className="collections-popover__description collections-popover__description--clamp"
                            title={collection.description}
                          >
                            {collection.description}
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              <div className="collections-popover__footer">
                <button
                  type="button"
                  className="canopy-btn collections-popover__save"
                  onClick={save}
                >
                  {SAVE_LABEL}
                </button>
              </div>
            </div>
          )}
        </PopoverContent>
        {menu && (
          <CollectionMenu
            x={menu.x}
            y={menu.y}
            items={menu.items}
            target={menu.target}
            onClose={closeMenu}
          />
        )}
      </Popover>
    </FeatureFlags>
  );
}
