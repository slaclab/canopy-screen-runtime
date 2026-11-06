// CollectionMenu: the inline editing of personal collections,
// shared by the sidebar's collection headings (ScreenTree) and the
// Collections popover's rows.
//
//   menu       collectionEditItems(collection, …) are the Rename and Delete
//              items of a collection's row menu; a facility collection has
//              none. A refused collection (useCollections `refused`: an old
//              shape or a layout the viewer refuses) cannot be opened or
//              edited: its menu names the reason in a disabled first item
//              (refusedLabel) and offers Delete only, and the edit gestures
//              leave it alone with that reason as their notice.
//              CollectionMenu renders a list of items as the Carbon context
//              menu the tree uses.
//   rename     CollectionRenameField is the inline field that replaces the
//              name while renaming: focused with its text selected; Enter or
//              leaving the field commits a changed, non-blank name, Esc (or
//              an unchanged or blank name) cancels. The caller holds the
//              collection (holdCollection) from opening the field until it
//              commits or cancels, so a poll answer meanwhile never resets
//              what is typed.
//   gestures   useCollectionEdits(api) runs rename, remove-member, reorder and
//              delete through the hook's edit()/deleteCollection() (one
//              conditional PUT or DELETE under the rev captured when the
//              gesture began) and words each outcome as a toast:
//              Delete and remove act at once with Undo; 412 stale → "“<name>”
//              changed on another console — try again", 412 gone → "“<name>”
//              was deleted on another console", Delete 412 stale → "Not
//              deleted: changed on another console", Delete 404 → nothing.
//              An Undo that is refused says so: an id taken meanwhile →
//              "Could not undo: a collection with that id now exists".

import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Menu, MenuItem } from '@carbon/react';
import { renamed, reordered, withoutMember } from './collections.js';
import { useToast } from './useToasts.js';
import type { ToastSpec } from './useToasts.js';
import { refusedNotice } from './useCollections.js';
import type { Collection, CollectionsApi, UndoResult, WriteConflict } from './useCollections.js';

/** One item of a row menu. */
export interface CollectionMenuItem {
  label: string;
  kind?: 'danger';
  /** Shown, not runnable (a refused collection's reason). */
  disabled?: boolean;
  run: () => void;
}

export const RENAME_LABEL = 'Rename';
export const DELETE_LABEL = 'Delete';
export const REMOVE_MEMBER_LABEL = 'Remove from collection';
export const MOVE_UP_LABEL = 'Move up';
export const MOVE_DOWN_LABEL = 'Move down';
export const UNDO_LABEL = 'Undo';

/** Whether a collection offers editing: personal, with the raw document an edit PUTs. */
export function isEditable(collection: Collection): boolean {
  return collection.source === 'personal' && collection.raw !== undefined;
}

/** The disabled menu item naming why a refused collection cannot be opened. */
export function refusedLabel(refused: string): string {
  return `Cannot be opened: ${refused}`;
}

/**
 * The Rename and Delete items of `collection`'s row menu (none for a facility
 * one); a refused collection's reason and Delete only.
 */
export function collectionEditItems(
  collection: Collection,
  on: { rename: (collection: Collection) => void; delete: (collection: Collection) => void }
): CollectionMenuItem[] {
  if (!isEditable(collection)) return [];
  if (collection.refused !== undefined) {
    return [
      { label: refusedLabel(collection.refused), disabled: true, run: () => {} },
      { label: DELETE_LABEL, kind: 'danger', run: () => on.delete(collection) },
    ];
  }
  return [
    { label: RENAME_LABEL, run: () => on.rename(collection) },
    { label: DELETE_LABEL, kind: 'danger', run: () => on.delete(collection) },
  ];
}

// --- outcome wording ---------------------------------------------------------

/** The gesture an outcome belongs to. */
export type EditGesture = 'rename' | 'remove' | 'reorder' | 'delete';

/** The toast text of a refused gesture on the collection named `name`. */
export function conflictNotice(gesture: EditGesture, name: string, reason: WriteConflict): string {
  if (reason === 'gone') return `“${name}” was deleted on another console`;
  if (gesture === 'delete') return 'Not deleted: changed on another console';
  return `“${name}” changed on another console — try again`;
}

/** The toast text of a refused Undo of `gesture`. */
export function undoNotice(gesture: EditGesture, name: string, reason: WriteConflict): string {
  if (gesture === 'delete' || reason === 'exists') {
    return 'Could not undo: a collection with that id now exists';
  }
  if (reason === 'gone') return `Could not undo: “${name}” was deleted on another console`;
  return `Could not undo: “${name}” changed on another console`;
}

function failureText(what: string, err: unknown): string {
  return `Could not ${what}: ${err instanceof Error ? err.message : String(err)}`;
}

// --- gestures ----------------------------------------------------------------

/** What the gestures use of the collections hook. */
export type EditApi = Partial<Pick<CollectionsApi, 'edit' | 'deleteCollection'>>;

export interface CollectionEdits {
  /** Renames to `name` (trimmed); a blank or unchanged name does nothing. */
  rename: (collection: Collection, name: string) => Promise<void>;
  /** Removes member `index` (an index into `collection.members`), with Undo. */
  removeMember: (collection: Collection, index: number, label: string) => Promise<void>;
  /** Moves member `from` to the place of member `to` (indices into `collection.members`). */
  move: (collection: Collection, from: number, to: number) => Promise<void>;
  /** Deletes the collection at once, with Undo. */
  remove: (collection: Collection) => Promise<void>;
}

/** The raw index of member `index` (`rawIndex[i]`; the index itself on a hand-built value). */
export function rawIndexOf(collection: Collection, index: number): number {
  return collection.rawIndex?.[index] ?? index;
}

/**
 * The edit gestures over `api`, each worded as a toast (the workspace's
 * ToastContext), or through `notify` outside one (no Undo then).
 */
export function useCollectionEdits(
  api: EditApi | undefined,
  notify?: (text: string) => void
): CollectionEdits {
  const toasts = useToast();
  const latest = useRef({ api, notify, toasts });
  useEffect(() => {
    latest.current = { api, notify, toasts };
  });

  const show = useCallback((spec: ToastSpec) => {
    const { toasts: store, notify: fallback } = latest.current;
    if (store) store.show(spec);
    else fallback?.(spec.message);
  }, []);

  /** Runs an Undo and words a refusal or a failure. */
  const runUndo = useCallback(
    (gesture: EditGesture, name: string, undo: () => Promise<UndoResult>) => {
      undo().then(
        (result) => {
          if (!result.ok) show({ message: undoNotice(gesture, name, result.reason) });
        },
        (err: unknown) => show({ message: failureText('undo', err) })
      );
    },
    [show]
  );

  const editWith = useCallback(
    async (
      gesture: Exclude<EditGesture, 'delete'>,
      collection: Collection,
      change: Parameters<CollectionsApi['edit']>[1],
      done?: string
    ) => {
      const edit = latest.current.api?.edit;
      if (!edit) return;
      if (collection.refused !== undefined) {
        show({ message: refusedNotice(collection) });
        return;
      }
      try {
        const result = await edit(collection, change);
        if (!result.ok) {
          show({ message: conflictNotice(gesture, collection.name, result.reason) });
          return;
        }
        if (done !== undefined) {
          show({
            message: done,
            action: {
              label: UNDO_LABEL,
              run: () => runUndo(gesture, collection.name, result.undo),
            },
          });
        }
      } catch (err) {
        show({ message: failureText(`change “${collection.name}”`, err) });
      }
    },
    [show, runUndo]
  );

  const rename = useCallback(
    async (collection: Collection, name: string) => {
      const next = name.trim();
      if (next === '' || next === collection.name) return;
      await editWith('rename', collection, (raw) => renamed(raw, next));
    },
    [editWith]
  );

  const removeMember = useCallback(
    async (collection: Collection, index: number, label: string) => {
      const at = rawIndexOf(collection, index);
      await editWith(
        'remove',
        collection,
        (raw) => withoutMember(raw, at),
        `Removed “${label}” from “${collection.name}”`
      );
    },
    [editWith]
  );

  const move = useCallback(
    async (collection: Collection, from: number, to: number) => {
      if (from === to || to < 0 || to >= collection.members.length) return;
      const a = rawIndexOf(collection, from);
      const b = rawIndexOf(collection, to);
      await editWith('reorder', collection, (raw) => reordered(raw, a, b));
    },
    [editWith]
  );

  const remove = useCallback(
    async (collection: Collection) => {
      const del = latest.current.api?.deleteCollection;
      if (!del) return;
      try {
        const result = await del(collection);
        if (!result.ok) {
          show({ message: conflictNotice('delete', collection.name, result.reason) });
          return;
        }
        // Already gone (404): done, silently.
        if (result.missing) return;
        show({
          message: `Deleted “${collection.name}”`,
          action: {
            label: UNDO_LABEL,
            run: () => runUndo('delete', collection.name, result.undo),
          },
        });
      } catch (err) {
        show({ message: failureText(`delete “${collection.name}”`, err) });
      }
    },
    [show, runUndo]
  );

  return { rename, removeMember, move, remove };
}

// --- the inline rename field ---------------------------------------------------

export interface CollectionRenameFieldProps {
  /** The name when the field opened. */
  name: string;
  /** A changed, non-blank name (trimmed) was committed. */
  onCommit: (name: string) => void;
  /** Esc, or a commit of an unchanged or blank name. */
  onCancel: () => void;
}

export function CollectionRenameField({ name, onCommit, onCancel }: CollectionRenameFieldProps) {
  const [value, setValue] = useState(name);
  const input = useRef<HTMLInputElement>(null);
  // Commit and cancel run once: Enter commits, then the blur that follows is ignored.
  const settled = useRef(false);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  const finish = (commit: boolean) => {
    if (settled.current) return;
    settled.current = true;
    const next = value.trim();
    if (commit && next !== '' && next !== name) onCommit(next);
    else onCancel();
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    // The field owns its keys: none reaches the tree or a toast shortcut.
    event.stopPropagation();
    if (event.key === 'Enter') {
      event.preventDefault();
      finish(true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      finish(false);
    }
  };

  return (
    <input
      ref={input}
      type="text"
      className="collection-rename"
      aria-label={`Rename “${name}”`}
      value={value}
      maxLength={200}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={onKeyDown}
      onBlur={() => finish(true)}
      style={{
        flex: '1 1 auto',
        minInlineSize: 0,
        font: 'inherit',
        textTransform: 'none',
        color: 'var(--canopy-text-primary, inherit)',
        background: 'var(--canopy-bg-field, transparent)',
        border: '1px solid var(--canopy-border-interactive, currentColor)',
        padding: '0 0.25rem',
      }}
    />
  );
}

// --- the menu ------------------------------------------------------------------

export interface CollectionMenuProps {
  x: number;
  y: number;
  items: readonly CollectionMenuItem[];
  /** Where Carbon renders the menu (the embed layout's root); default document.body. */
  target?: HTMLElement;
  onClose: () => void;
  label?: string;
}

/** A row menu at a viewport position: each item runs, then the menu closes. */
export function CollectionMenu({
  x,
  y,
  items,
  target,
  onClose,
  label = 'Collection actions',
}: CollectionMenuProps) {
  if (items.length === 0) return null;
  return (
    <Menu label={label} mode="basic" size="sm" open x={x} y={y} target={target} onClose={onClose}>
      {items.map((item) => (
        <MenuItem
          key={item.label}
          label={item.label}
          kind={item.kind ?? 'default'}
          disabled={item.disabled}
          onClick={() => {
            item.run();
            onClose();
          }}
        />
      ))}
    </Menu>
  );
}
