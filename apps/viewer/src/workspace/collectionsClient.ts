// The collections store's wire format and requests: the types the workspace
// shares, the parsing of a listed collection and of the state document, and
// one function per request. No React; the hooks (useCollections and the
// three it composes) own ordering, polling and the cache.
//
// --- wire ----------------------------------------------------------------------
//
//   list       GET <base>/<path> -> {collections: [...]}, facility first then
//              personal (the server's order is kept). Every listed collection
//              carries `rev` (first 16 hex of the sha256 of its stored bytes);
//              the client keeps it beside `raw` (the listed object minus
//              source/ref/rev/updated) and `rawIndex` (each kept member's index
//              in raw.members), and never invents one.
//   writes     PUT|DELETE <base>/<path>/<id>, personal collections only, always
//              conditional: a create sends `If-None-Match: *`, a replace or an
//              edit sends `If-Match: <rev>` (the rev seen when the gesture
//              began); DELETE sends `If-Match` when given a rev. 412
//              {error: exists|stale|gone} and 428 precondition_required come
//              back as typed results ({ok: false, reason}), never as throws, and
//              the list is refetched; other failures throw CollectionsError.
//              A 2xx PUT answer is the listed document and is applied to the
//              cache at once (it outranks every list GET sent before it); a
//              DELETE (or its 404) drops the collection from the cache.
//   state      GET <base>/<path>-state -> {ticked, unticked, pinned, recent};
//              POST it one op, {op: 'tick'|'untick', ref},
//              {op: 'pin'|'unpin'|'recent'|'recent-remove', member},
//              {op: 'recent-clear'} or {op: 'recent-many', members} (at most
//              MAX_RECENT; the server refuses more), and the answer is the new
//              state document.
//
// --- selection -----------------------------------------------------------------
//
//   shown      (facility collections with `default: true` ∪ ticked) −
//              unticked, in list order. Unknown refs stay stored and hidden:
//              the client prunes nothing.

import type { Dispatch, RefObject } from 'react';
import type { ManifestScreen } from '../api.js';
import { checkCollection, memberKey, parseMember } from './collections.js';
import type { CollectionRaw, Member, MemberKey, OpenManyPlan } from './collections.js';
import { mapCollection } from './dock/collectionLayout.js';
import type { CollectionLayout } from '@slaclab/canopy-dock-engine';
import type { DockPersistence } from './dock/useDockPersistence.js';
import { parseTabKey } from './tabs.js';
import type { ClosedBy, OpenSetAs, TabsAction, TabsState } from './tabs.js';

/** The reserved deep-link parameter: `?_canopyOpen=<source>:<id>`. */
export const OPEN_PARAM = '_canopyOpen';

/** Recent's cap (the server's MAX_RECENT): a `recent-many` carries at most this many. */
export const MAX_RECENT = 10;

/** The screen member a screen tab key names; null for a tool key or a malformed key. */
export function screenMemberOfKey(key: string): Member | null {
  const parsed = parseTabKey(key);
  if (parsed === null || parsed.kind !== 'screen') return null;
  const screen = `${parsed.category}/${parsed.id}`;
  return Object.keys(parsed.macros).length > 0
    ? { screen, macros: { ...parsed.macros } }
    : { screen };
}

/** How many of `members` `plan` opens (a member listed twice counts each time). */
export function countOpened(members: readonly Member[], plan: OpenManyPlan): number {
  let n = 0;
  for (const member of members) {
    try {
      if (plan.keyOf.has(memberKey(member))) n += 1;
    } catch {
      // A member without a key never opens.
    }
  }
  return n;
}

/** The members `plan` opened, in `members` order, each once, at most MAX_RECENT. */
export function openedMembers(members: readonly Member[], plan: OpenManyPlan): Member[] {
  const seen = new Set<MemberKey>();
  const opened: Member[] = [];
  for (const member of members) {
    let key: MemberKey;
    try {
      key = memberKey(member);
    } catch {
      continue;
    }
    if (seen.has(key) || !plan.keyOf.has(key)) continue;
    seen.add(key);
    opened.push(member);
  }
  return opened.slice(0, MAX_RECENT);
}

/** A minted personal id tries -2, -3 … up to this suffix. */
const MAX_ID_SUFFIX = 100;

/** A create that meets 412 `exists` refetches the list and retries this often. */
export const MAX_SAVE_RETRIES = 3;

/** The conditional poll of the list and the state runs this often while in view. */
export const COLLECTIONS_POLL_MS = 10_000;

export type CollectionSource = 'facility' | 'personal';

export interface Collection {
  source: CollectionSource;
  /** '<source>:<id>'. */
  ref: string;
  id: string;
  name: string;
  description?: string;
  /** The members, in array order (a member the client cannot key is dropped). */
  members: Member[];
  /**
   * The layout, its tabs indexes into `members` (a dropped member's index
   * pruned); null without one, and on a refused collection.
   */
  layout: CollectionLayout<number> | null;
  /**
   * Why the collection cannot be opened: the server's `refused` (a file it
   * cannot read) or the viewer's own refusal of its layout, in canopy's words.
   */
  refused?: string;
  /** Facility only: shown unless unticked. */
  default: boolean;
  updated?: string;
  /** The listed revision; sent back as `If-Match` by a replace, edit or delete. */
  rev?: string;
  /**
   * The listed object minus source/ref/rev/updated: what an edit PUTs back.
   * Always set by parseCollection (optional only for hand-built values).
   */
  raw?: Record<string, unknown>;
  /** Each member's index in raw.members, aligned with `members` (set by parseCollection). */
  rawIndex?: number[];
}

/** Why a conditional write was refused (412 exists|stale|gone, 428). */
export type WriteConflict = 'exists' | 'stale' | 'gone' | 'precondition_required';

/** The outcome of a conditional PUT. */
export type WriteResult =
  | { ok: true; ref: string; collection: Collection | null }
  | { ok: false; reason: WriteConflict; status: number };

/** The outcome of a DELETE; `missing` when it was already gone (404). */
export type RemoveResult =
  | { ok: true; missing: boolean }
  | { ok: false; reason: WriteConflict; status: number };

/** A PUT's precondition: create only (`If-None-Match: *`) or replace `rev` (`If-Match`). */
export type Precondition = { create: true } | { rev: string };

/** The outcome of an Undo: its one conditional PUT (and, after a delete, the tick). */
export type UndoResult = { ok: true } | { ok: false; reason: WriteConflict };

/** The outcome of an edit gesture (rename, remove a member, reorder). */
export type EditResult =
  | { ok: true; collection: Collection | null; undo: () => Promise<UndoResult> }
  | { ok: false; reason: WriteConflict };

/** The outcome of a Delete gesture; `missing` when it was already gone (404). */
export type DeleteResult =
  | { ok: true; missing: boolean; undo: () => Promise<UndoResult> }
  | { ok: false; reason: WriteConflict };

export interface CollectionsStateDoc {
  ticked: string[];
  unticked: string[];
  pinned: Member[];
  recent: Member[];
}

export const EMPTY_STATE: Readonly<CollectionsStateDoc> = Object.freeze({
  ticked: [],
  unticked: [],
  pinned: [],
  recent: [],
}) as CollectionsStateDoc;

export interface CollectionDraft {
  name: string;
  description?: string;
  members: Member[];
  /** The layout in collection form, its tabs indexes into `members`. */
  layout?: CollectionLayout<number>;
}

export interface UseCollectionsOptions {
  /** config.collections?.path; undefined: the feature is off and nothing is fetched. */
  path: string | undefined;
  /** What the store's URLs resolve against (document.baseURI). */
  base: string;
  /** The committed tabs state. */
  state: TabsState;
  /** The latest tabs state, read when a plan is made. */
  stateRef: { readonly current: TabsState };
  dispatch: Dispatch<TabsAction>;
  /** The manifest's screens; null before the first manifest. */
  screens: readonly ManifestScreen[] | null;
  /** The tools served here (configuredTools). */
  tools: readonly string[];
  /** False under `_canopyChrome=0` (latched). */
  chrome: boolean;
  persistence: Pick<DockPersistence, 'schedule'>;
  /** Shows the workspace's one inline notice. */
  notify: (text: string) => void;
  /** The latched `_canopyOpen` value, null when absent. */
  openRef?: string | null;
  /** The router-relative URL now (pathname + search). */
  here?: string;
  /** A replace navigation to a router-relative URL. */
  writeUrl?: (target: string) => void;
  /** The workspace root: the poll runs only while it intersects the viewport. */
  root?: RefObject<HTMLElement | null>;
  /** The tab key the document's URL named at mount (latched); null: none. */
  urlKey?: string | null;
  /** The tab keys session restore brought back at mount (latched). */
  restoredKeys?: readonly string[];
}

/** How an Open all runs. */
export interface OpenAllOptions {
  /**
   * How the members open (tabs.ts openSet): default `layout` when the
   * collection (or `layout`) has one, else `side`.
   */
  as?: OpenSetAs;
  /** An exact layout over the collection's member indexes (the agent's); implies `layout`. */
  layout?: CollectionLayout<number>;
  /** Default 'person': a person's side-by-side open falls back to tabs with a notice. */
  caller?: 'agent' | 'person';
  /** Who the undo entry of a replaced dock names; default 'you'. */
  closedBy?: ClosedBy;
}

/** What an Open all did, once committed. */
export interface OpenAllResult {
  /** The tab key each member landed on, in member order (members not opened left out). */
  keys: string[];
  /** Whether it changed the dock's layout or focus. */
  changed: boolean;
  /** The undo entry id of the dock an `as: 'layout'` open replaced; null otherwise. */
  group: string | null;
  /** Why nothing opened (a refused collection or layout, NO_DOCK, too_many_for_side). */
  refusal?: string;
  /** A fallback taken (too_many_for_side: opened as tabs). */
  notice?: string;
}

export interface CollectionsApi {
  /** False without config.collections: no popover, Pin, Recent or collection entries. */
  enabled: boolean;
  /** Every collection, in list order. */
  collections: Collection[];
  /** The shown selection, in list order. */
  shown: Collection[];
  state: CollectionsStateDoc;
  /** Recent as displayed (held back while the pointer is in the branch). */
  recent: Member[];
  pinnedKeys: ReadonlySet<MemberKey>;
  /** The member keys the Browse tree lists, for the drop ctx. */
  renderedKeys: ReadonlySet<MemberKey>;
  /** The last list error, null after a good GET. */
  error: string | null;
  refresh: () => void;
  tick: (ref: string) => Promise<void>;
  untick: (ref: string) => Promise<void>;
  pin: (member: Member) => Promise<void>;
  unpin: (member: Member) => Promise<void>;
  recentOp: (member: Member) => Promise<void>;
  /** The Recent choke point: records one open (an explicit or outside open). */
  recordOpen: (member: Member) => Promise<void>;
  /** A Recent row's Remove; its answer is shown even while hovered. */
  recentRemove: (member: Member) => Promise<void>;
  /** The Recent section's Clear recent; its answer is shown even while hovered. */
  recentClear: () => Promise<void>;
  /**
   * What Open all of `collection` would open now: `opened` of `total`
   * members, from the plan (null while it waits for the first manifest).
   */
  openAllCount: (collection: Collection) => { opened: number; total: number } | null;
  /** A single explicit member open (the tree's row rules) and its Recent post. */
  openMember: (member: Member, options?: { newTab?: boolean; target?: string }) => void;
  openAll: (collection: Collection, options?: OpenAllOptions) => Promise<OpenAllResult>;
  /**
   * Open all of collection `ref` as a deep link: held until the first list
   * and manifest settle, one notice when it cannot run.
   */
  runDeepLink: (ref: string) => void;
  /** The pointer entered (true) or left (false) the Recent branch. */
  setRecentHover: (inside: boolean) => void;
  /**
   * Creates (id minted from a fresh list) or, with `replace`, replaces a
   * personal collection under `If-Match: rev` (the cached rev when omitted).
   */
  save: (draft: CollectionDraft, replace?: string, rev?: string) => Promise<WriteResult>;
  /** One conditional PUT of a personal collection's raw document (an edit, an undo). */
  put: (
    id: string,
    raw: Record<string, unknown>,
    precondition: Precondition
  ) => Promise<WriteResult>;
  /** Deletes a personal collection, under `If-Match` when `rev` is given; 404 is fine. */
  remove: (id: string, rev?: string) => Promise<RemoveResult>;
  /**
   * Holds collection `ref` as shown while its rename field or member drag is
   * active (null releases it): list answers for it are buffered and applied
   * on release.
   */
  holdCollection: (ref: string | null) => void;
  /**
   * An edit gesture on a personal collection: `change` maps the raw document
   * captured now (raw indices, collections.ts) to the one PUT under the rev
   * captured now. `undo` re-PUTs the captured raw under the rev the edit
   * returned.
   */
  edit: (
    collection: Collection,
    change: (raw: CollectionRaw) => Record<string, unknown>
  ) => Promise<EditResult>;
  /**
   * Deletes a personal collection at once under its captured rev; `undo`
   * re-creates the captured raw (`If-None-Match: *`) and ticks it again when
   * it was ticked.
   */
  deleteCollection: (collection: Collection) => Promise<DeleteResult>;
}

// --- parsing -----------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The keys the server adds when it lists a collection; never stored, never sent. */
const LISTED_KEYS: ReadonlySet<string> = new Set(['source', 'ref', 'rev', 'updated']);

/** One listed collection, or null when it lacks what the client needs. */
export function parseCollection(raw: unknown): Collection | null {
  if (!isRecord(raw)) return null;
  const { source, ref, id, name } = raw;
  if (source !== 'facility' && source !== 'personal') return null;
  if (typeof id !== 'string' || id === '' || typeof name !== 'string') return null;
  if (typeof ref !== 'string' || ref !== `${source}:${id}`) return null;
  if (!Array.isArray(raw.members)) return null;
  const members: Member[] = [];
  const rawIndex: number[] = [];
  (raw.members as unknown[]).forEach((entry, index) => {
    const member = parseMember(entry);
    if (!member) return;
    members.push(member);
    rawIndex.push(index);
  });
  const stored: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!LISTED_KEYS.has(key)) stored[key] = value;
  }
  const collection: Collection = {
    source,
    ref,
    id,
    name,
    members,
    layout: null,
    default: source === 'facility' && raw.default === true,
    raw: stored,
    rawIndex,
  };
  if (typeof raw.rev === 'string' && raw.rev !== '') collection.rev = raw.rev;
  if (typeof raw.description === 'string') collection.description = raw.description;
  if (typeof raw.updated === 'string') collection.updated = raw.updated;
  if (typeof raw.refused === 'string') {
    collection.refused = raw.refused;
    return collection;
  }
  const check = checkCollection(raw);
  if (!check.ok) {
    collection.refused = check.error;
  } else if (check.layout !== null) {
    // Raw indexes -> indexes into `members`: an unkeyable member's tab is pruned.
    const parsedOf = new Map(rawIndex.map((rawAt, at) => [rawAt, at]));
    collection.layout = mapCollection(check.layout, (index) => parsedOf.get(index));
  }
  return collection;
}

function refList(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((r): r is string => typeof r === 'string') : [];
}

function memberList(raw: unknown): Member[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((m) => parseMember(m)).filter((m): m is Member => m !== null);
}

/** The state document, or null when it is not one. */
export function parseStateDoc(raw: unknown): CollectionsStateDoc | null {
  if (!isRecord(raw)) return null;
  return {
    ticked: refList(raw.ticked),
    unticked: refList(raw.unticked),
    pinned: memberList(raw.pinned),
    recent: memberList(raw.recent),
  };
}

/** The shown selection: (facility defaults ∪ ticked) − unticked, in list order. */
export function shownSelection(
  collections: readonly Collection[],
  state: Pick<CollectionsStateDoc, 'ticked' | 'unticked'>
): Collection[] {
  const ticked = new Set(state.ticked);
  const unticked = new Set(state.unticked);
  return collections.filter((c) => (c.default || ticked.has(c.ref)) && !unticked.has(c.ref));
}

// --- HTTP --------------------------------------------------------------------

/** The collections URL (or one collection's) under `base`. */
export function collectionsUrl(path: string, base: string, id?: string): string {
  const list = new URL(path.replace(/\/+$/, ''), base).href;
  return id === undefined ? list : `${list}/${encodeURIComponent(id)}`;
}

/** The state URL, `<base>/<path>-state`. */
export function stateUrl(path: string, base: string): string {
  return new URL(`${path.replace(/\/+$/, '')}-state`, base).href;
}

/** A failed request: `code` is the body's `code`, else the status line. */
export class CollectionsError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = 'CollectionsError';
    this.code = code;
    this.status = status;
  }
}

async function failure(response: Response, what: string): Promise<CollectionsError> {
  let code = `${response.status} ${response.statusText}`.trim();
  try {
    const body: unknown = await response.json();
    if (isRecord(body) && typeof body.code === 'string') code = body.code;
  } catch {
    // No JSON body: the status line says enough.
  }
  return new CollectionsError(code, response.status, `${what}: ${code}`);
}

/** The typed reason of a refused conditional write, null when it is not one. */
export function conflictReason(status: number, code: string): WriteConflict | null {
  if (status === 428) return 'precondition_required';
  if (status !== 412) return null;
  // An unknown 412 code still means the precondition failed: treat it as stale.
  return code === 'exists' || code === 'gone' ? code : 'stale';
}

/** The headers of a conditional request. */
function preconditionHeaders(precondition: Precondition | null): Record<string, string> {
  if (precondition === null) return {};
  return 'create' in precondition ? { 'If-None-Match': '*' } : { 'If-Match': precondition.rev };
}

/** `raw` without the listed-only keys, as a PUT body. */
function storedBody(raw: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!LISTED_KEYS.has(key)) body[key] = value;
  }
  return body;
}

export type PutAnswer =
  | { ok: true; listed: Collection | null }
  | { ok: false; reason: WriteConflict; status: number };

export async function putCollection(
  path: string,
  base: string,
  id: string,
  body: Record<string, unknown>,
  precondition: Precondition | null
): Promise<PutAnswer> {
  const response = await fetch(collectionsUrl(path, base, id), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...preconditionHeaders(precondition) },
    body: JSON.stringify(storedBody(body)),
  });
  if (!response.ok) {
    const err = await failure(response, 'Could not save the collection');
    const reason = conflictReason(err.status, err.code);
    if (reason === null) throw err;
    return { ok: false, reason, status: err.status };
  }
  let listed: Collection | null = null;
  try {
    listed = parseCollection(await response.json());
  } catch {
    // No listed document in the answer: the caller refetches the list.
  }
  return { ok: true, listed };
}

export async function deleteCollectionRequest(
  path: string,
  base: string,
  id: string,
  rev: string | undefined
): Promise<RemoveResult> {
  const response = await fetch(collectionsUrl(path, base, id), {
    method: 'DELETE',
    headers: preconditionHeaders(rev === undefined ? null : { rev }),
  });
  if (response.ok) return { ok: true, missing: false };
  if (response.status === 404) return { ok: true, missing: true };
  const err = await failure(response, 'Could not delete the collection');
  const reason = conflictReason(err.status, err.code);
  if (reason === null) throw err;
  return { ok: false, reason, status: err.status };
}

/** The first free personal id for `stem` (stem, stem-2, …), null when none is left. */
export function freeId(stem: string, collections: readonly Collection[]): string | null {
  const taken = new Set(collections.filter((c) => c.source === 'personal').map((c) => c.id));
  for (let suffix = 1; suffix <= MAX_ID_SUFFIX; suffix += 1) {
    const id = suffix === 1 ? stem : `${stem}-${suffix}`;
    if (!taken.has(id)) return id;
  }
  return null;
}

/**
 * `list` with `next` in place of the collection of the same ref; a new one
 * goes last (personal) or after the last facility collection (facility).
 */
export function upsertCollection(list: readonly Collection[], next: Collection): Collection[] {
  const at = list.findIndex((c) => c.ref === next.ref);
  if (at !== -1) return list.map((c, i) => (i === at ? next : c));
  if (next.source === 'personal') return [...list, next];
  const end = list.findIndex((c) => c.source !== 'facility');
  return end === -1 ? [...list, next] : [...list.slice(0, end), next, ...list.slice(end)];
}

/** A conditional GET's answer: unchanged (304), or the new value and its ETag. */
type Conditional<T> = { changed: false } | { changed: true; value: T; etag: string | null };

/**
 * GET `url`, conditional on `etag` when one is known: no-store then, so the
 * browser cache hands the 304 through instead of its stored 200.
 */
function conditionalGet(url: string, etag: string | null): Promise<Response> {
  return etag === null
    ? fetch(url, { cache: 'no-cache' })
    : fetch(url, { cache: 'no-store', headers: { 'If-None-Match': etag } });
}

export async function listCollectionsIf(
  path: string,
  base: string,
  etag: string | null
): Promise<Conditional<Collection[]>> {
  const response = await conditionalGet(collectionsUrl(path, base), etag);
  if (etag !== null && response.status === 304) return { changed: false };
  if (!response.ok) throw await failure(response, 'Could not load collections');
  const body: unknown = await response.json();
  if (!isRecord(body) || !Array.isArray(body.collections)) {
    throw new Error('Could not load collections: malformed list');
  }
  const value = body.collections.map(parseCollection).filter((c): c is Collection => c !== null);
  return { changed: true, value, etag: response.headers.get('ETag') };
}

export async function readStateIf(
  path: string,
  base: string,
  etag: string | null
): Promise<Conditional<CollectionsStateDoc>> {
  const response = await conditionalGet(stateUrl(path, base), etag);
  if (etag !== null && response.status === 304) return { changed: false };
  if (!response.ok) throw await failure(response, 'Could not load the collections state');
  const doc = parseStateDoc(await response.json());
  if (!doc) throw new Error('Could not load the collections state: malformed document');
  return { changed: true, value: doc, etag: response.headers.get('ETag') };
}

export type StateOp =
  | { op: 'tick' | 'untick'; ref: string }
  | { op: 'pin' | 'unpin' | 'recent' | 'recent-remove'; member: Member }
  | { op: 'recent-clear' }
  | { op: 'recent-many'; members: Member[] };

/** Ops whose answer is shown at once, through the Recent hover hold. */
export const UNHELD_OPS: ReadonlySet<string> = new Set(['recent-remove', 'recent-clear']);
/** Ops whose failure is quiet (one console.warn). */
export const QUIET_OPS: ReadonlySet<string> = new Set(['recent', 'recent-many']);

export async function postState(
  path: string,
  base: string,
  op: StateOp
): Promise<CollectionsStateDoc> {
  const body = op;
  const response = await fetch(stateUrl(path, base), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw await failure(response, `Could not ${op.op}`);
  const doc = parseStateDoc(await response.json());
  if (!doc) throw new Error(`Could not ${op.op}: malformed state document`);
  return doc;
}

/** The notice for a failed tick/untick/pin/unpin. */
export function opNotice(op: string, err: unknown): string {
  const code = err instanceof CollectionsError ? err.code : null;
  if (code === 'pinned_full') return 'Pinned is full (at most 50 members): unpin one first.';
  if (code === 'selection_full') {
    return 'Too many collections ticked (at most 100): untick one first.';
  }
  if (code === 'too_large') return 'The collections state is too large to change.';
  if (code === 'read_only_store') return 'Collections cannot be changed here.';
  const what =
    op === 'tick' || op === 'untick'
      ? 'change the selection'
      : op === 'recent-remove'
        ? 'remove the member from Recent'
        : op === 'recent-clear'
          ? 'clear Recent'
          : `${op} the member`;
  return `Could not ${what}: ${err instanceof Error ? err.message : String(err)}`;
}

/** The notice when a person's side-by-side open fell back to tabs of one tile. */
export const SIDE_NOTICE = 'Too many to open side by side: opened as tabs of one tile.';

/** Why a layout cannot open without chrome (the holder's NO_DOCK). */
export const NO_DOCK_NOTICE = 'the dock keeps one tile here';

/** An agent's `as: 'layout'` of a collection without one. */
export const NO_LAYOUT = 'no_layout';

/** The notice when a refused collection is asked to open. */
export function refusedNotice(collection: Pick<Collection, 'name' | 'refused'>): string {
  return `“${collection.name}” cannot be opened: ${collection.refused ?? ''}`;
}

/** `target` without the `_canopyOpen` parameter (other parameters kept). */
export function withoutOpenParam(target: string): string {
  const hashAt = target.indexOf('#');
  const hash = hashAt === -1 ? '' : target.slice(hashAt);
  const rest = hashAt === -1 ? target : target.slice(0, hashAt);
  const queryAt = rest.indexOf('?');
  if (queryAt === -1) return target;
  const params = new URLSearchParams(rest.slice(queryAt + 1));
  if (!params.has(OPEN_PARAM)) return target;
  params.delete(OPEN_PARAM);
  const search = params.toString();
  return rest.slice(0, queryAt) + (search ? `?${search}` : '') + hash;
}
