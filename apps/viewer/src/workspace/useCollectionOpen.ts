// Opening collections and their members: a single member open, Open all, the
// `_canopyOpen` deep link, and the Recent records they make.
//
//   recent     Recent is history: every open lands in it, through one choke
//              point, recordOpen(member). It is called by openMember (a single
//              explicit member open), by the page's outside-navigation handler
//              (a path URL, a host or agent navigation) and, once at mount,
//              for the document's own URL screen (`urlKey`) when it is not
//              among the restored keys (`restoredKeys`): a fresh `src`
//              navigation records, a reload does not. Open all posts one
//              `recent-many` with the first MAX_RECENT of the members its
//              committed plan opened, in display order (the first ends on
//              top). Session restore, reconcile and dock sync never record.
//              Removing from Recent and the hover hold are the store's
//              (useCollectionsStore).
//
// --- open all ------------------------------------------------------------------
//
//   openAll(collection, options) plans with planOpenMany (waiting for the first
//   manifest while a screen member is pending) and commits through the
//   holder's one `openSet` (tabs.ts) with the planned tab keys in member order
//   and their instance state; the holder drives the dock from its layout.
//     as        `layout` when the collection has a layout (its member indexes
//               mapped to the planned keys by mapCollection: a skipped
//               member's tab pruned, the layout normalised), else `side`: a
//               person's click opens side by side, else as a near-square
//               grid, else as tabs of one tile with SIDE_NOTICE. An agent
//               passes `as` (tabs, side, layout) or an exact `layout`.
//     refused   a refused collection (the server's `refused`, or a layout the
//               viewer refuses, such as a partly placed one) never opens: one
//               notice with the reason, the dock unchanged. So
//               does a refusal of the holder (NO_DOCK, too_many_for_side for
//               an agent), read beforehand from stepTabs.
//     chrome    without chrome (`_canopyChrome=0`) the dock keeps one tile: a
//               person's layout open becomes `tabs`, and nothing is persisted.
//   Skips (the plan's and the holder's) are summarised in one notice
//   (skipNotice). An instance that already showed a member records it
//   (`membersSaved`), as a new instance does. Persistence is armed
//   (schedule(true)) so the next reload restores the dock. A layout open
//   pushes one `layout` undo entry, minted here: its id is the result's
//   `group`. The returned promise settles once everything has committed,
//   with the tab key of each member in member order and whether the layout
//   or focus changed.
//
// --- deep link -----------------------------------------------------------------
//
//   runDeepLink(ref) runs Open all of collection `ref` once per call, after
//   the first list GET has settled and the first manifest is in (a call
//   before that is held; a later call replaces a held one); an unknown ref
//   or an absent/erroring store notifies once. `_canopyOpen=<ref>`
//   (OPEN_PARAM), latched by the page and passed in as openRef, is the
//   first-render caller; the host's in-place `canopy-host-navigate` message is the
//   other. The parameter, when in the URL, is then dropped with a replace
//   navigation (writeUrl). Without chrome a deep link is ignored: no open,
//   no URL write, one console.warn.

import { useCallback, useEffect, useLayoutEffect, useReducer, useRef } from 'react';
import {
  NOT_IN_LIBRARY,
  atCapReason,
  layoutRefusal,
  memberKey,
  planOpenMany,
  skipNotice,
} from './collections.js';
import type { Member, OpenManyPlan } from './collections.js';
import {
  NO_DOCK_NOTICE,
  NO_LAYOUT,
  OPEN_PARAM,
  SIDE_NOTICE,
  countOpened,
  openedMembers,
  refusedNotice,
  screenMemberOfKey,
  withoutOpenParam,
} from './collectionsClient.js';
import type {
  Collection,
  OpenAllOptions,
  OpenAllResult,
  UseCollectionsOptions,
} from './collectionsClient.js';
import { mapCollection } from './dock/collectionLayout.js';
import { validateLayout as validateLayoutTree } from '@slaclab/canopy-dock-engine';
import { NO_DOCK, TOO_MANY_FOR_SIDE, mintClosedId, stepTabs } from './tabs.js';
import type { OpenSetAs, SavedTab, TabsAction, TabsState, ToolInstance } from './tabs.js';
import { isToolKey } from './tools.js';
import type { CollectionsStore } from './useCollectionsStore.js';

/** An Open all held until the first manifest. */
interface WaitingOpen {
  collection: Collection;
  options: OpenAllOptions;
  resolve: (result: OpenAllResult) => void;
}

/** The tab key of each member `plan` opened or found, in member order. */
function plannedKeys(collection: Collection, plan: OpenManyPlan): string[] {
  const keys: string[] = [];
  for (const member of collection.members) {
    const key = plan.keyOf.get(memberKey(member));
    if (key !== undefined && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

/** What an Open all can change about the dock: its layout and focus. */
function tabsPicture(state: TabsState): string {
  return JSON.stringify([state.layout, state.focusedTile]);
}

export const NOTHING_OPENED: OpenAllResult = Object.freeze({
  keys: [],
  changed: false,
  group: null,
});

export interface CollectionOpens {
  /** The Recent choke point: records one open (an explicit or outside open). */
  recordOpen: (member: Member) => Promise<void>;
  openMember: (member: Member, options?: { newTab?: boolean; target?: string }) => void;
  openAll: (collection: Collection, options?: OpenAllOptions) => Promise<OpenAllResult>;
  openAllCount: (collection: Collection) => { opened: number; total: number } | null;
  runDeepLink: (ref: string) => void;
}

export function useCollectionOpen(
  options: UseCollectionsOptions,
  store: Pick<CollectionsStore, 'collections' | 'firstList' | 'runOp' | 'recentOp'>
): CollectionOpens {
  const { path, chrome, dispatch, screens } = options;
  const latest = useRef(options);
  // eslint-disable-next-line react-hooks/refs -- read only in callbacks and effects, never to render
  latest.current = options;
  const { collections, firstList, runOp } = store;
  // The one Recent choke point (see `recent` in the header).
  const recordOpen = store.recentOp;
  const [, bump] = useReducer((n: number) => n + 1, 0);

  // At mount: the document's own URL screen, unless session restore brought
  // it back (a reload). Latched: a later URL is an outside navigation, which
  // the page records itself.
  const mountOpen = useRef<{ key: string | null; restored: readonly string[] } | null>({
    key: options.urlKey ?? null,
    restored: options.restoredKeys ?? [],
  });
  useEffect(() => {
    const pending = mountOpen.current;
    if (path === undefined || pending === null) return;
    mountOpen.current = null;
    if (pending.key === null || pending.restored.includes(pending.key)) return;
    const member = screenMemberOfKey(pending.key);
    if (member !== null) void recordOpen(member);
  }, [path, recordOpen]);

  const openMember = useCallback(
    (member: Member, opts: { newTab?: boolean; target?: string } = {}) => {
      dispatch({
        type: 'openMember',
        member,
        ...(opts.newTab ? { newTab: true } : {}),
        ...(opts.target !== undefined ? { target: opts.target } : {}),
      });
      void recordOpen(member);
    },
    [dispatch, recordOpen]
  );

  const waiting = useRef<WaitingOpen | null>(null);
  const settling = useRef<{ resolve: (result: OpenAllResult) => void; result: OpenAllResult }[]>(
    []
  );

  const runOpenAll = useCallback(
    (open: WaitingOpen): boolean => {
      const { collection, options, resolve } = open;
      const { stateRef, screens: now, tools: served, notify, persistence } = latest.current;
      const refuse = (refusal: string, text: string): true => {
        notify(text);
        resolve({ ...NOTHING_OPENED, refusal });
        return true;
      };
      if (collection.refused !== undefined) {
        return refuse(collection.refused, refusedNotice(collection));
      }
      const caller = options.caller ?? 'person';
      let layout = collection.layout;
      if (options.layout !== undefined) {
        const check = validateLayoutTree(options.layout, {
          form: 'collection',
          members: collection.members.length,
        });
        if (!check.valid) {
          const text = layoutRefusal(check.reason, check.where);
          return refuse(text, `“${collection.name}” cannot be opened: ${text}`);
        }
        layout = options.layout;
      }
      let as: OpenSetAs =
        options.as ?? (options.layout !== undefined || layout !== null ? 'layout' : 'side');
      if (as === 'layout' && layout === null) {
        if (caller === 'agent') return refuse(NO_LAYOUT, `“${collection.name}” has no layout.`);
        as = 'side';
      }
      // Without chrome the dock keeps one tile: a person's layout opens as tabs.
      if (as === 'layout' && !chrome && caller === 'person') as = 'tabs';

      const before = stateRef.current;
      const plan = planOpenMany(before, collection.members, { screens: now, tools: served });
      if (plan.pending) return false;
      const keys = plannedKeys(collection, plan);
      const keyOfIndex = (index: number): string | undefined => {
        const member = collection.members[index];
        return member === undefined ? undefined : plan.keyOf.get(memberKey(member));
      };
      const keyed =
        as === 'layout' && layout !== null
          ? (mapCollection(layout, keyOfIndex) ?? undefined)
          : undefined;
      const instances: Record<string, ToolInstance> = {};
      for (const key of keys) {
        const planned = plan.state.instances[key];
        if (planned === undefined || !isToolKey(key)) continue;
        // The epoch is the holder's to bump; the rest seeds the new instance.
        const seed: ToolInstance = { ...planned };
        delete seed.epoch;
        instances[key] = seed;
      }
      const group = mintClosedId(before.closedStack ?? []);
      const action: TabsAction = {
        type: 'openSet',
        members: keys,
        as,
        ...(keyed !== undefined ? { collection: keyed } : {}),
        caller,
        instances,
        closed: { id: group, closedBy: options.closedBy ?? 'you' },
      };
      const step = stepTabs(before, action);
      if (step.refusal !== undefined) {
        const text = step.refusal === NO_DOCK ? NO_DOCK_NOTICE : step.refusal;
        return refuse(step.refusal, `“${collection.name}” cannot be opened: ${text}`);
      }
      dispatch(action);
      // An instance that already showed a member records it, as a new one does.
      const entries: SavedTab[] = [];
      for (const key of keys) {
        const planned = plan.state.instances[key];
        const was = before.instances[key];
        if (!before.keys.includes(key) || planned?.from === undefined || !isToolKey(key)) continue;
        if (was?.from === planned.from && was.title === planned.title) continue;
        entries.push({
          key,
          from: planned.from,
          ...(planned.title !== undefined ? { title: planned.title } : {}),
        });
      }
      if (entries.length > 0) dispatch({ type: 'membersSaved', entries });

      const nowOpen = new Set(step.state.keys);
      const landed = keys.filter((key) => nowOpen.has(key));
      // Recent: what this open opened, in display order (first on top).
      const opened = openedMembers(collection.members, plan).filter((member) =>
        nowOpen.has(plan.keyOf.get(memberKey(member))!)
      );
      if (opened.length > 0) void runOp({ op: 'recent-many', members: opened });

      const skipped = [...plan.skipped];
      const held = new Set(step.skipped ?? []);
      for (const member of collection.members) {
        const key = plan.keyOf.get(memberKey(member));
        if (key === undefined || !held.has(key)) continue;
        held.delete(key);
        skipped.push({
          member,
          reason: 'tool' in member ? atCapReason(member.tool) : NOT_IN_LIBRARY,
        });
      }
      const messages: string[] = [];
      const skips = skipNotice(skipped);
      if (skips !== null) messages.push(skips);
      if (step.notice === TOO_MANY_FOR_SIDE) messages.push(SIDE_NOTICE);
      if (messages.length > 0) notify(messages.join(' '));
      if (chrome) persistence.schedule(true);

      const replaced = step.state.closedStack?.at(-1)?.id === group;
      settling.current.push({
        resolve,
        result: {
          keys: landed,
          changed: tabsPicture(step.state) !== tabsPicture(before),
          group: replaced ? group : null,
          ...(step.notice !== undefined ? { notice: step.notice } : {}),
        },
      });
      // The settle effect must run even when the open changed nothing.
      bump();
      return true;
    },
    [chrome, dispatch, runOp]
  );

  const openAllCount = useCallback((collection: Collection) => {
    const { stateRef, screens: now, tools: served } = latest.current;
    const plan = planOpenMany(stateRef.current, collection.members, {
      screens: now,
      tools: served,
    });
    if (plan.pending) return null;
    return {
      opened: countOpened(collection.members, plan),
      total: collection.members.length,
    };
  }, []);

  const openAll = useCallback(
    (collection: Collection, options: OpenAllOptions = {}): Promise<OpenAllResult> =>
      new Promise<OpenAllResult>((resolve) => {
        const open: WaitingOpen = { collection, options, resolve };
        if (runOpenAll(open)) return;
        // Only the last Open all waits; an earlier one opened nothing.
        waiting.current?.resolve(NOTHING_OPENED);
        waiting.current = open;
      }),
    [runOpenAll]
  );

  // A pending Open all runs once the first manifest is in.
  useEffect(() => {
    if (screens === null || waiting.current === null) return;
    const open = waiting.current;
    if (runOpenAll(open)) waiting.current = null;
  }, [screens, runOpenAll]);

  // An Open all settles once its dispatches have committed.
  useLayoutEffect(() => {
    if (settling.current.length === 0) return;
    const done = settling.current;
    settling.current = [];
    for (const { resolve, result } of done) resolve(result);
  });

  // --- the `_canopyOpen` deep link ---

  // The held deep-link ref (null: none); seeded by the latched openRef.
  const pendingLink = useRef<string | null>(options.openRef ?? null);
  const [linkSeq, bumpLink] = useReducer((n: number) => n + 1, 0);
  const runDeepLink = useCallback((ref: string) => {
    pendingLink.current = ref;
    bumpLink();
  }, []);
  useEffect(() => {
    const ref = pendingLink.current;
    if (ref === null) return;
    if (!chrome) {
      pendingLink.current = null;
      console.warn(`${OPEN_PARAM} is ignored without chrome`);
      return;
    }
    const finish = () => {
      pendingLink.current = null;
      const { here, writeUrl } = latest.current;
      if (here !== undefined && writeUrl) {
        const target = withoutOpenParam(here);
        if (target !== here) writeUrl(target);
      }
    };
    if (path === undefined) {
      finish();
      latest.current.notify(`Collection ${ref} is not available here.`);
      return;
    }
    if (firstList === null || screens === null) return;
    finish();
    if (firstList === false) {
      latest.current.notify(`Collection ${ref} could not be opened: collections are unavailable.`);
      return;
    }
    const collection = collections.find((c) => c.ref === ref);
    if (!collection) {
      latest.current.notify(`No collection ${ref}.`);
      return;
    }
    openAll(collection);
  }, [linkSeq, chrome, path, firstList, screens, collections, openAll]);

  return { recordOpen, openMember, openAll, openAllCount, runDeepLink };
}
