// useCollections: the workspace's collections client and Open all, composed
// from three hooks over one set of options:
//
//   useCollectionsStore   the list and the state document: fetch, conditional
//                         poll, ordering, the held collection, and the state
//                         ops (tick, untick, Pin, Recent)
//   useCollectionWrites   the personal collections' writes: Save, the edit
//                         gestures and Delete, each with its Undo
//   useCollectionOpen     a member open, Open all, the `_canopyOpen` deep link
//                         and the Recent records they make
//
// collectionsClient.ts holds the wire format, the shared types and the
// requests.
//
// --- drop trust ----------------------------------------------------------------
//
//   renderedKeys is the set of member keys the Browse tree lists: Pinned,
//   Recent, the shown collections' members, a bare member per served tool and
//   every IR screen outside the '@' categories (All screens).

import { useMemo } from 'react';
import { memberKey } from './collections.js';
import type { MemberKey } from './collections.js';
import { EMPTY_STATE, shownSelection } from './collectionsClient.js';
import type { CollectionsApi, UseCollectionsOptions } from './collectionsClient.js';
import { useCollectionOpen } from './useCollectionOpen.js';
import { useCollectionWrites } from './useCollectionWrites.js';
import { useCollectionsStore } from './useCollectionsStore.js';

export {
  COLLECTIONS_POLL_MS,
  CollectionsError,
  EMPTY_STATE,
  MAX_RECENT,
  MAX_SAVE_RETRIES,
  NO_DOCK_NOTICE,
  NO_LAYOUT,
  OPEN_PARAM,
  SIDE_NOTICE,
  collectionsUrl,
  conflictReason,
  freeId,
  opNotice,
  openedMembers,
  parseCollection,
  parseStateDoc,
  refusedNotice,
  screenMemberOfKey,
  shownSelection,
  stateUrl,
  upsertCollection,
  withoutOpenParam,
} from './collectionsClient.js';
export type {
  Collection,
  CollectionDraft,
  CollectionSource,
  CollectionsApi,
  CollectionsStateDoc,
  DeleteResult,
  EditResult,
  OpenAllOptions,
  OpenAllResult,
  Precondition,
  RemoveResult,
  UndoResult,
  UseCollectionsOptions,
  WriteConflict,
  WriteResult,
} from './collectionsClient.js';

export function useCollections(options: UseCollectionsOptions): CollectionsApi {
  const { path, base, screens, tools } = options;
  const store = useCollectionsStore(path, base, options);
  const opens = useCollectionOpen(options, store);
  const writes = useCollectionWrites(path, base, store);
  const { collections, doc, recent, error, refresh, holdCollection, setRecentHover } = store;
  const { tick, untick, pin, unpin, recentOp, recentRemove, recentClear } = store;
  const { recordOpen, openMember, openAll, openAllCount, runDeepLink } = opens;
  const { save, put, remove, edit } = writes;

  // --- derived ---

  const enabled = path !== undefined;
  const shown = useMemo(
    () => (enabled ? shownSelection(collections, doc) : []),
    [enabled, collections, doc]
  );
  const pinnedKeys = useMemo(
    () => new Set<MemberKey>(enabled ? doc.pinned.map(memberKey) : []),
    [enabled, doc.pinned]
  );
  const renderedKeys = useMemo(() => {
    const keys = new Set<MemberKey>();
    if (enabled) {
      for (const m of doc.pinned) keys.add(memberKey(m));
      for (const m of recent) keys.add(memberKey(m));
      for (const c of shown) for (const m of c.members) keys.add(memberKey(m));
    }
    for (const tool of tools) keys.add(memberKey({ tool }));
    for (const entry of screens ?? []) {
      if (entry.kind === 'ir' && !entry.category.startsWith('@')) {
        keys.add(memberKey({ screen: `${entry.category}/${entry.id}` }));
      }
    }
    return keys;
  }, [enabled, doc.pinned, recent, shown, tools, screens]);

  return {
    enabled,
    collections: enabled ? collections : [],
    shown,
    state: enabled ? doc : EMPTY_STATE,
    recent: enabled ? recent : [],
    pinnedKeys,
    renderedKeys,
    error: enabled ? error : null,
    refresh,
    tick,
    untick,
    pin,
    unpin,
    recentOp,
    recordOpen,
    recentRemove,
    recentClear,
    openAllCount,
    openMember,
    openAll,
    runDeepLink,
    setRecentHover,
    save,
    put,
    remove,
    holdCollection,
    edit,
    deleteCollection: writes.deleteCollection,
  };
}
