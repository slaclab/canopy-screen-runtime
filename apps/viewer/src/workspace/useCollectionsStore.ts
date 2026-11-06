// The collections store as the workspace holds it: the list and the state
// document, fetched, polled and ordered, plus the state ops (tick, untick,
// Pin, Recent). useCollections composes it with the personal writes and the
// opens.
//
//   serial     writes to one collection id run one after another through a
//              per-id promise chain, and every state POST runs through one
//              chain; `writes` and `statePosts` count what is in flight.
//   ordering   the state document carries no revision, so every state request
//              (GET or POST) is numbered and an answer is applied only when it
//              is newer than the last one applied; a POST's answer is applied
//              as is (no follow-up GET). The list is numbered the same way, and
//              a write's answer takes the next number when it lands.
//   poll       refresh() (mount, window focus, and the conditional poll) skips
//              the list GET while a write is in flight and the state GET while
//              a state POST is in flight: a GET served before the write commits
//              could otherwise land after it and revert it on screen. Both GETs
//              are conditional: each keeps the last applied answer's ETag and
//              sends it as `If-None-Match` (cache: no-store, so the 304 is not
//              turned back into a cached 200); a 304 touches no state. The
//              ETag is dropped whenever the cache changes without a GET (a
//              write or POST answer, a delete) and when path/base change.
//              The poll runs every COLLECTIONS_POLL_MS while the workspace
//              root intersects the viewport (an IntersectionObserver on
//              `root`, not document.visibilityState; without a root or an
//              observer it always runs), once more when the root comes back
//              into view, never while a previous poll's GETs are unanswered,
//              and not at all while any write or state POST is in flight.
//   hold       holdCollection(ref) (an active rename field or member drag)
//              keeps that collection as shown while list answers arrive: the
//              newest listed version of it (or its absence) is buffered and
//              applied on holdCollection(null) (commit or cancel); every other
//              collection updates at once. A write answer drops the buffer.
//
//   ops        tick, untick, pin, unpin, recent, recent-many, recent-remove,
//              recent-clear. 409 pinned_full / selection_full and 413
//              too_large notify in their own words, any other failure of
//              tick/untick/pin/unpin/recent-remove/recent-clear notifies with
//              its code; a failed `recent` or `recent-many` logs one
//              console.warn and nothing else.
//   recent     the displayed Recent: while the pointer is in the Recent branch
//              (setRecentHover) a new Recent order is held back and shown once
//              the pointer leaves, so the row under the pointer does not move;
//              the answers of recent-remove and recent-clear bypass that hold
//              (the row goes at once).

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { Member } from './collections.js';
import {
  COLLECTIONS_POLL_MS,
  EMPTY_STATE,
  QUIET_OPS,
  UNHELD_OPS,
  listCollectionsIf,
  opNotice,
  postState,
  readStateIf,
  upsertCollection,
} from './collectionsClient.js';
import type { Collection, CollectionsStateDoc, StateOp } from './collectionsClient.js';

export const sameJson = <T>(prev: T, next: T): T =>
  JSON.stringify(prev) === JSON.stringify(next) ? prev : next;

/** `next` with collection `ref` kept as `prev` shows it (where it stood, when `next` lacks it). */
function keepHeld(prev: readonly Collection[], next: Collection[], ref: string): Collection[] {
  const was = prev.findIndex((c) => c.ref === ref);
  if (was === -1) return next;
  const shown = prev[was]!;
  const at = next.findIndex((c) => c.ref === ref);
  if (at !== -1) return next.map((c, i) => (i === at ? shown : c));
  const end = Math.min(was, next.length);
  return [...next.slice(0, end), shown, ...next.slice(end)];
}

/** `list` with the buffered listing of `ref` applied: replaced, added, or dropped (null). */
function releaseHeld(
  list: readonly Collection[],
  ref: string,
  listed: Collection | null
): Collection[] {
  return listed === null ? list.filter((c) => c.ref !== ref) : upsertCollection(list, listed);
}

/** What the store hook reads from the page's options, the latest render's. */
export interface StoreOptions {
  notify: (text: string) => void;
  root?: RefObject<HTMLElement | null>;
}

export interface CollectionsStore {
  collections: Collection[];
  error: string | null;
  doc: CollectionsStateDoc;
  recent: Member[];
  /** null: the first list GET has not settled; else whether it succeeded. */
  firstList: boolean | null;
  refresh: () => void;
  refreshList: () => Promise<void>;
  refreshState: () => Promise<void>;
  /** Applies a list answered by request `seq`, if it is the newest. */
  applyList: (seq: number, next: Collection[], etag?: string | null) => boolean;
  /** Applies a write's answer to the cache at once: it outranks every earlier GET. */
  applyWrite: (change: (prev: Collection[]) => Collection[]) => void;
  /** The next list request number (a list GET or a write answer takes one). */
  nextListSeq: () => number;
  /** A collection write started / ended; the list GET and the poll wait while any is in flight. */
  writeStarted: () => void;
  writeEnded: () => void;
  holdCollection: (ref: string | null) => void;
  /** Runs every state POST one after another, counted in statePosts. */
  runOp: (op: StateOp) => Promise<void>;
  tick: (ref: string) => Promise<void>;
  untick: (ref: string) => Promise<void>;
  pin: (member: Member) => Promise<void>;
  unpin: (member: Member) => Promise<void>;
  recentOp: (member: Member) => Promise<void>;
  recentRemove: (member: Member) => Promise<void>;
  recentClear: () => Promise<void>;
  setRecentHover: (inside: boolean) => void;
}

export function useCollectionsStore(
  path: string | undefined,
  base: string,
  options: StoreOptions
): CollectionsStore {
  const latest = useRef(options);
  // eslint-disable-next-line react-hooks/refs -- read only in callbacks and effects, never to render
  latest.current = options;
  const [collections, setCollections] = useState<Collection[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [doc, setDoc] = useState<CollectionsStateDoc>(EMPTY_STATE);
  const [recent, setRecent] = useState<Member[]>([]);
  // null: the first list GET has not settled; else whether it succeeded.
  const [firstList, setFirstList] = useState<boolean | null>(null);

  const listSeq = useRef(0);
  const listApplied = useRef(0);
  const stateSeq = useRef(0);
  const stateApplied = useRef(0);
  // The ETag of the last applied GET answer; null: the next GET is unconditional.
  const listEtag = useRef<string | null>(null);
  const stateEtag = useRef<string | null>(null);
  // The held collection (rename/drag active) and its buffered listing.
  const held = useRef<string | null>(null);
  const heldBuffer = useRef<{ listed: Collection | null } | null>(null);
  const hover = useRef(false);
  const heldRecent = useRef<Member[] | null>(null);

  const showRecent = useCallback((next: Member[]) => {
    if (hover.current) heldRecent.current = next;
    else setRecent((prev) => sameJson(prev, next));
  }, []);

  /** Applies a state document answered by request `seq`, if it is the newest. */
  const applyState = useCallback(
    (seq: number, next: CollectionsStateDoc, etag: string | null = null, unheld = false) => {
      if (seq <= stateApplied.current) return;
      stateApplied.current = seq;
      // A POST answer brings no ETag: the next GET is unconditional.
      stateEtag.current = etag;
      setDoc((prev) => sameJson(prev, next));
      if (unheld) {
        // The user's own Remove / Clear recent: shown even under the pointer.
        heldRecent.current = null;
        setRecent((prev) => sameJson(prev, next.recent));
      } else {
        showRecent(next.recent);
      }
    },
    [showRecent]
  );

  // In flight: collection writes (any id, counted by the writes hook) and
  // state POSTs; refresh() skips the matching GET while either is non-zero
  // (see `poll` in the header).
  const writes = useRef(0);
  const statePosts = useRef(0);
  const stateChain = useRef<Promise<unknown>>(Promise.resolve());

  /** Applies a list answered by request `seq`, if it is the newest. */
  const applyList = useCallback(
    (seq: number, next: Collection[], etag: string | null = null): boolean => {
      if (seq <= listApplied.current) return false;
      listApplied.current = seq;
      listEtag.current = etag;
      const ref = held.current;
      if (ref !== null) heldBuffer.current = { listed: next.find((c) => c.ref === ref) ?? null };
      setCollections((prev) => sameJson(prev, ref === null ? next : keepHeld(prev, next, ref)));
      setError(null);
      setFirstList((prev) => prev ?? true);
      return true;
    },
    []
  );

  /** Applies a write's answer to the cache at once: it outranks every earlier GET. */
  const applyWrite = useCallback((change: (prev: Collection[]) => Collection[]) => {
    listApplied.current = ++listSeq.current;
    // The cache no longer matches the last GET: no 304 may pin it, no buffer outlive it.
    listEtag.current = null;
    heldBuffer.current = null;
    setCollections((prev) => sameJson(prev, change(prev)));
  }, []);

  const refreshList = useCallback((): Promise<void> => {
    if (path === undefined) return Promise.resolve();
    const seq = ++listSeq.current;
    return listCollectionsIf(path, base, listEtag.current).then(
      (answer) => {
        if (answer.changed) applyList(seq, answer.value, answer.etag);
        else if (seq > listApplied.current) listApplied.current = seq;
      },
      (err: unknown) => {
        if (seq <= listApplied.current) return;
        listApplied.current = seq;
        listEtag.current = null;
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        setFirstList((prev) => prev ?? false);
        latest.current.notify(message);
      }
    );
  }, [path, base, applyList]);

  const refreshState = useCallback((): Promise<void> => {
    if (path === undefined) return Promise.resolve();
    // The POST's own answer is newer than anything this GET could bring.
    if (statePosts.current > 0) return Promise.resolve();
    const seq = ++stateSeq.current;
    return readStateIf(path, base, stateEtag.current).then(
      (answer) => {
        if (answer.changed) applyState(seq, answer.value, answer.etag);
        else if (seq > stateApplied.current) stateApplied.current = seq;
      },
      (err: unknown) => {
        if (seq > stateApplied.current) {
          stateEtag.current = null;
          console.warn(err instanceof Error ? err.message : String(err));
        }
      }
    );
  }, [path, base, applyState]);

  const refresh = useCallback(() => {
    if (writes.current === 0) void refreshList();
    void refreshState();
  }, [refreshList, refreshState]);

  // The poll: one at a time, none while a write or a state POST is in flight.
  const polling = useRef(false);
  const poll = useCallback(() => {
    if (polling.current || writes.current > 0 || statePosts.current > 0) return;
    polling.current = true;
    void Promise.all([refreshList(), refreshState()]).finally(() => {
      polling.current = false;
    });
  }, [refreshList, refreshState]);

  useEffect(() => {
    if (path === undefined) return;
    // A new store (or a restart) begins unconditional.
    listEtag.current = null;
    stateEtag.current = null;
    refresh();
    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);
    // In view unless an observer on the workspace root says otherwise.
    let inView = true;
    let observer: IntersectionObserver | null = null;
    const root = latest.current.root?.current ?? null;
    if (root !== null && typeof IntersectionObserver !== 'undefined') {
      inView = false;
      let reported = false;
      observer = new IntersectionObserver((entries) => {
        const last = entries[entries.length - 1];
        if (!last) return;
        const was = inView;
        inView = last.isIntersecting;
        // Back in view: poll at once (the first report follows the mount GET).
        if (inView && !was && reported) poll();
        reported = true;
      });
      observer.observe(root);
    }
    const timer = setInterval(() => {
      if (inView) poll();
    }, COLLECTIONS_POLL_MS);
    return () => {
      window.removeEventListener('focus', onFocus);
      observer?.disconnect();
      clearInterval(timer);
    };
  }, [path, refresh, poll]);

  const nextListSeq = useCallback(() => ++listSeq.current, []);
  const writeStarted = useCallback(() => {
    writes.current += 1;
  }, []);
  const writeEnded = useCallback(() => {
    writes.current -= 1;
  }, []);

  const holdCollection = useCallback((ref: string | null) => {
    const was = held.current;
    if (was === ref) return;
    const buffered = heldBuffer.current;
    held.current = ref;
    heldBuffer.current = null;
    if (was !== null && buffered !== null) {
      setCollections((prev) => sameJson(prev, releaseHeld(prev, was, buffered.listed)));
    }
  }, []);

  /** Runs every state POST one after another, counted in statePosts. */
  const runOp = useCallback(
    (op: StateOp): Promise<void> => {
      if (path === undefined) return Promise.resolve();
      statePosts.current += 1;
      const run = async () => {
        const seq = ++stateSeq.current;
        let failed: { err: unknown } | null = null;
        try {
          applyState(seq, await postState(path, base, op), null, UNHELD_OPS.has(op.op));
        } catch (err) {
          failed = { err };
        } finally {
          statePosts.current -= 1;
        }
        if (failed === null) return;
        if (QUIET_OPS.has(op.op)) {
          console.warn(failed.err instanceof Error ? failed.err.message : String(failed.err));
          return;
        }
        latest.current.notify(opNotice(op.op, failed.err));
        // The answer was lost or refused: read what the server holds now.
        void refreshState();
      };
      const next = stateChain.current.then(run, run);
      stateChain.current = next;
      return next;
    },
    [path, base, applyState, refreshState]
  );

  const tick = useCallback((ref: string) => runOp({ op: 'tick', ref }), [runOp]);
  const untick = useCallback((ref: string) => runOp({ op: 'untick', ref }), [runOp]);
  const pin = useCallback((member: Member) => runOp({ op: 'pin', member }), [runOp]);
  const unpin = useCallback((member: Member) => runOp({ op: 'unpin', member }), [runOp]);
  const recentOp = useCallback((member: Member) => runOp({ op: 'recent', member }), [runOp]);

  const recentRemove = useCallback(
    (member: Member) => runOp({ op: 'recent-remove', member }),
    [runOp]
  );
  const recentClear = useCallback(() => runOp({ op: 'recent-clear' }), [runOp]);

  const setRecentHover = useCallback((inside: boolean) => {
    hover.current = inside;
    if (!inside && heldRecent.current !== null) {
      const next = heldRecent.current;
      heldRecent.current = null;
      setRecent((prev) => sameJson(prev, next));
    }
  }, []);

  return {
    collections,
    error,
    doc,
    recent,
    firstList,
    refresh,
    refreshList,
    refreshState,
    applyList,
    applyWrite,
    nextListSeq,
    writeStarted,
    writeEnded,
    holdCollection,
    runOp,
    tick,
    untick,
    pin,
    unpin,
    recentOp,
    recentRemove,
    recentClear,
    setRecentHover,
  };
}
