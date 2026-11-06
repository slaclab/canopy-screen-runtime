// The personal collections' writes: Save (create or replace), the edit
// gestures (rename, remove a member, reorder) and Delete, each with its Undo.
// Writes to one id run one after another; each is counted in the store's
// the store's in-flight writes, so the store's list GET and poll wait for it.
//
//   edits      edit(collection, change) and deleteCollection(collection)
//              capture {raw, rev} (a Delete also wasTicked) when the gesture
//              starts and send that rev; `change` is a collections.ts edit on
//              raw indices. Their `undo` re-PUTs the captured raw: after an
//              edit under the rev the edit returned, after a Delete with
//              `If-None-Match: *` and then a tick when it was ticked. The
//              toasts that word each outcome live in CollectionMenu.tsx.
//   save       a new collection's id is minted from a fresh list GET (the
//              first free viewId(name), then -2, -3 …), so a duplicate name
//              costs one PUT; a 412 `exists` (a true race) refetches and
//              retries at most MAX_SAVE_RETRIES times.

import { useCallback, useLayoutEffect, useRef } from 'react';
import type { CollectionRaw } from './collections.js';
import {
  EMPTY_STATE,
  MAX_SAVE_RETRIES,
  deleteCollectionRequest,
  freeId,
  listCollectionsIf,
  putCollection,
  upsertCollection,
} from './collectionsClient.js';
import type {
  Collection,
  CollectionDraft,
  CollectionsStateDoc,
  DeleteResult,
  EditResult,
  Precondition,
  RemoveResult,
  UndoResult,
  WriteResult,
} from './collectionsClient.js';
import type { CollectionsStore } from './useCollectionsStore.js';
import { viewId } from './savedViews.js';

export interface CollectionWrites {
  save: (draft: CollectionDraft, replace?: string, rev?: string) => Promise<WriteResult>;
  put: (
    id: string,
    raw: Record<string, unknown>,
    precondition: Precondition
  ) => Promise<WriteResult>;
  remove: (id: string, rev?: string) => Promise<RemoveResult>;
  edit: (
    collection: Collection,
    change: (raw: CollectionRaw) => Record<string, unknown>
  ) => Promise<EditResult>;
  deleteCollection: (collection: Collection) => Promise<DeleteResult>;
}

export function useCollectionWrites(
  path: string | undefined,
  base: string,
  store: CollectionsStore
): CollectionWrites {
  const { collections, doc, writeStarted, writeEnded, nextListSeq } = store;
  const { applyList, applyWrite, refreshList, refreshState, tick } = store;
  const writeChains = useRef(new Map<string, Promise<unknown>>());

  // The committed list, for a replace that was given no rev.
  const cached = useRef<Collection[]>([]);
  useLayoutEffect(() => {
    cached.current = collections;
  }, [collections]);

  /** Runs `write` after every earlier write to the same id, counted as in flight. */
  const serial = useCallback(
    <T>(id: string, write: () => Promise<T>): Promise<T> => {
      writeStarted();
      const prev = writeChains.current.get(id) ?? Promise.resolve();
      const next = prev.then(write).finally(() => {
        writeEnded();
      });
      const tail = next.then(
        () => undefined,
        () => undefined
      );
      writeChains.current.set(id, tail);
      void tail.then(() => {
        if (writeChains.current.get(id) === tail) writeChains.current.delete(id);
      });
      return next;
    },
    [writeStarted, writeEnded]
  );

  /** One PUT through the id's chain; a 2xx answer is applied to the cache at once. */
  const writeOnce = useCallback(
    (id: string, body: Record<string, unknown>, precondition: Precondition | null) =>
      serial(id, async (): Promise<WriteResult> => {
        if (path === undefined) throw new Error('Collections are not available');
        const answer = await putCollection(path, base, id, body, precondition);
        if (!answer.ok) return answer;
        const ref = `personal:${id}`;
        const { listed } = answer;
        if (listed !== null && listed.ref === ref) {
          applyWrite((prev) => upsertCollection(prev, listed));
        } else {
          // An answer without the listed document: read the list instead.
          void refreshList();
        }
        return { ok: true, ref, collection: listed };
      }),
    [path, base, serial, applyWrite, refreshList]
  );

  const put = useCallback(
    async (id: string, raw: Record<string, unknown>, precondition: Precondition) => {
      const result = await writeOnce(id, raw, precondition);
      // Refused: show what the server holds now.
      if (!result.ok) void refreshList();
      return result;
    },
    [writeOnce, refreshList]
  );

  const save = useCallback(
    async (draft: CollectionDraft, replace?: string, rev?: string): Promise<WriteResult> => {
      if (path === undefined) throw new Error('Collections are not available');
      const body: Record<string, unknown> = { name: draft.name.trim(), members: draft.members };
      if (draft.description !== undefined) body.description = draft.description;
      if (draft.layout !== undefined) body.layout = draft.layout;
      if (replace !== undefined) {
        const seen = rev ?? cached.current.find((c) => c.ref === `personal:${replace}`)?.rev;
        // No rev known: the server answers 428, which comes back typed.
        const result = await writeOnce(replace, body, seen === undefined ? null : { rev: seen });
        if (!result.ok) void refreshList();
        return result;
      }
      const stem = viewId(draft.name);
      if (stem === '') {
        throw new Error('Could not save the collection: the name has no letters or digits');
      }
      for (let attempt = 0; ; attempt += 1) {
        // Mint from a fresh list, so a duplicate name costs one PUT.
        const seq = nextListSeq();
        const answer = await listCollectionsIf(path, base, null);
        const fresh = answer.changed ? answer.value : [];
        applyList(seq, fresh, answer.changed ? answer.etag : null);
        const id = freeId(stem, fresh);
        if (id === null) {
          throw new Error('Could not save the collection: no free id for that name');
        }
        const result = await writeOnce(id, body, { create: true });
        if (result.ok || result.reason !== 'exists' || attempt >= MAX_SAVE_RETRIES) {
          if (!result.ok) void refreshList();
          return result;
        }
      }
    },
    [path, base, writeOnce, applyList, refreshList, nextListSeq]
  );

  const remove = useCallback(
    (id: string, rev?: string): Promise<RemoveResult> =>
      serial(id, async () => {
        if (path === undefined) return { ok: true, missing: true } as const;
        const result = await deleteCollectionRequest(path, base, id, rev);
        if (result.ok) {
          const ref = `personal:${id}`;
          applyWrite((prev) => prev.filter((c) => c.ref !== ref));
          // The server pruned the ref from ticked/unticked.
          void refreshState();
        } else {
          void refreshList();
        }
        return result;
      }),
    [path, base, serial, applyWrite, refreshList, refreshState]
  );

  // --- edit gestures: capture {raw, rev} at the start, one PUT, Undo ---

  // The committed state document, for a Delete's `wasTicked`.
  const docNow = useRef<CollectionsStateDoc>(EMPTY_STATE);
  useLayoutEffect(() => {
    docNow.current = doc;
  }, [doc]);

  /** One PUT of `body` under `rev` (none known: the server answers 428, typed). */
  const putUnder = useCallback(
    async (id: string, body: Record<string, unknown>, rev: string | undefined) => {
      const result = await writeOnce(id, body, rev === undefined ? null : { rev });
      if (!result.ok) void refreshList();
      return result;
    },
    [writeOnce, refreshList]
  );

  const edit = useCallback(
    async (
      collection: Collection,
      change: (raw: CollectionRaw) => Record<string, unknown>
    ): Promise<EditResult> => {
      if (collection.source !== 'personal' || collection.raw === undefined) {
        throw new Error('Only a personal collection can be changed');
      }
      const { id, ref } = collection;
      const captured = { raw: collection.raw, rev: collection.rev };
      const result = await putUnder(id, change(captured.raw), captured.rev);
      if (!result.ok) return { ok: false, reason: result.reason };
      const returned = result.collection?.rev;
      const undo = async (): Promise<UndoResult> => {
        // The rev the edit returned; without one in its answer, the cached rev.
        const rev = returned ?? cached.current.find((c) => c.ref === ref)?.rev;
        const back = await putUnder(id, captured.raw, rev);
        return back.ok ? { ok: true } : { ok: false, reason: back.reason };
      };
      return { ok: true, collection: result.collection, undo };
    },
    [putUnder]
  );

  const deleteGesture = useCallback(
    async (collection: Collection): Promise<DeleteResult> => {
      if (collection.source !== 'personal' || collection.raw === undefined) {
        throw new Error('Only a personal collection can be deleted');
      }
      const { id, ref } = collection;
      const captured = {
        raw: collection.raw,
        rev: collection.rev,
        wasTicked: docNow.current.ticked.includes(ref),
      };
      const result = await remove(id, captured.rev);
      if (!result.ok) return { ok: false, reason: result.reason };
      const undo = async (): Promise<UndoResult> => {
        const back = await writeOnce(id, captured.raw, { create: true });
        if (!back.ok) {
          void refreshList();
          return { ok: false, reason: back.reason };
        }
        if (captured.wasTicked) await tick(ref);
        return { ok: true };
      };
      return { ok: true, missing: result.missing, undo };
    },
    [remove, writeOnce, refreshList, tick]
  );

  return { save, put, remove, edit, deleteCollection: deleteGesture };
}
