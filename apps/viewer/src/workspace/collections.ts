// Collections: named lists of members, each something the workspace can open.
//
// --- member keys -------------------------------------------------------------
//
//   members    two persisted shapes:
//                {screen: '<category>/<id>', macros?: {<name>: <value>}}
//                {tool: '<tool id>', query?: '<opaque>', name?: '<label>'}
//              an absent query is the tool's config default, '' a blank one.
//   key        memberKey(member) is a member's identity, its own grammar and
//              never a tab key:
//                screen:<screen>[?<canonical macros>]  (only when one survives)
//                tool:<tool>[?<query verbatim>]        (only when query present)
//              `name` never contributes. The canonical macros drop the names
//              the viewer keeps for itself (embedded, theme, mode and every
//              `_canopy*` name; case-sensitive, as macros.ts), sort the rest by
//              Unicode code point (not UTF-16 code unit) and write each pair
//              as name=value, both sides RFC 3986 percent-encoded over UTF-8
//              (A-Z a-z 0-9 - . _ ~ literal, space %20), joined by '&'.
//   vectors    e2e/fixtures/collections/member-key-vectors.json, a byte copy
//              of canopy's tests/canopy_mcp/fixtures/collections/ file, pins
//              this grammar for this and canopy's Python implementation.
//   label      memberLabel: `name` ?? '<tool label>: <describeQuery(query)>',
//              the bare tool label without a query.
//
// --- resolution ----------------------------------------------------------------
//
//   resolveMember(member, ctx, {source, atCap}) is the tab key a member opens
//   into, resolved against the manifest's IR screens and the tools served
//   here (ctx.tools, configuredTools). Never resolved, each with its reason:
//     pending      a screen member before the first manifest (ctx.screens
//                  null); a failed refresh keeps the last manifest, so the
//                  last result stays
//     unresolved   'Not in the library' (no such IR screen, or a reserved
//                  '@' category), 'Code screen — not viewable' (listed, not
//                  IR), '<Tool> not available here' (a tool not served)
//   A screen opens its tab key (tabKey with the member's macros). A bare
//   {tool} is the Tools row's click: the tool's most recently used instance,
//   else its first. A {tool, query} member is the instance showing it (its
//   `from` is the member's key, or, with no `from`, its query keys the same
//   member; a config-default instance also shows the member with the
//   ctx.toolQuery default), else a new instance loading the query, else at the cap: with
//   atCap 'mru' the most recently used instance loads it (flagged, so the
//   caller shows the cap notice), with 'skip' it is not opened (Open all).
//   drop trust   a drag's payload is authored by whoever started the drag, so
//                with source 'drop' a member resolves only when its key is in
//                ctx.renderedKeys, the members the Browse tree renders right
//                now; anything else is 'untrusted', as no row produced it.
//
// --- open all ------------------------------------------------------------------
//
//   planOpenMany(state, members, ctx) is Open all as a pure plan: the
//   tab key each member opens into, resolved against the state planned so far
//   (so the cap counts the instances this plan already opened):
//     screen       its tab key (tabKey with the member's macros)
//     tool         the instance showing the member, else a new instance
//                  at the smallest free id (with its query, or the config
//                  default for a bare member); every instance it lands on
//                  records `from` and the member's name as `title`
//     skipped      at MAX_TOOL_INSTANCES (never the MRU instance) and every
//                  unresolved member, each with its reason; skipNotice is the
//                  one notice that summarises them
//     pending      any screen member before the first manifest: nothing is
//                  planned (the input state comes back, `pending` set) and
//                  the caller runs it again once the manifest is in
//   `state` is a preview, never committed: every planned key opened as a tab
//   with its instance state (query, from, title), so a caller can count it
//   and seed the instances. The caller commits through the holder's one
//   `openSet` (tabs.ts): the planned keys in member order, `as` tabs, side by
//   side or by the collection's layout, whose member indexes become the
//   planned keys (dock/layout.ts mapCollection: a skipped member's index is
//   dropped and the layout normalised). Opening the same members again
//   changes no key.
//
// --- layout --------------------------------------------------------------------
//
//   shape      the dock layout's collection form (@slaclab/canopy-dock-engine): a tile
//              {tabs: [member index, ...], showing?, size?} or a split
//              {split: 'row'|'column', items: [...>=2], size?}; a root tile
//              is a one-tile layout. Every member is placed exactly once.
//   rules      checkCollection(doc) checks a document's layout as canopy's
//              validator does (canopy_mcp collections.py), first broken rule
//              wins, in the same words "<where>: <reason>: <text>"
//              (LAYOUT_REASON_TEXT): at most MAX_LAYOUT_BYTES of compact
//              UTF-8 JSON, then the dock layout's validateLayout with the member
//              count. A partly placed layout is member_missing. There is no
//              depth cap.
//   refused    the server lists a file it cannot read as {id, name, members,
//              refused: '<the refusal>'}; a collection whose layout the
//              viewer refuses is treated the same (useCollections). A refused
//              collection shows its reason and never opens.
//   fixtures   e2e/fixtures/collections/{valid,invalid}/, byte
//              copies of canopy's set, replay the same outcomes.
//   dock       dock/layout.ts mapCollection / collectionOfDock convert a
//              layout to tab keys (open) and from the dock (Save).
//
// --- edits -------------------------------------------------------------------
//
//   raw        a collection as listed minus source/ref/rev/updated: the
//              document a conditional PUT sends back. Edits work on it, not on
//              the parsed collection, which skips unkeyable members; so every
//              member index here is a raw index (the parsed rawIndex[i]), as
//              are the layout's tabs.
//   renamed    the same document under another name.
//   withoutMember  drops members[index]; in the layout its index goes, every
//              later index moves down by one, a tile left without tabs goes
//              and the layout is normalised (mapCollection); a layout left
//              without tiles is dropped.
//   reordered  moves members[from] to index `to`; every layout index (and
//              `showing`) follows its member through the permutation, the
//              layout's shape and sizes unchanged.
//   Every edit of a valid document gives a valid one.

// --- list text -----------------------------------------------------------------
//
//   formatWhen(updated, now?) is the <when>: "Today <short time>" for a
//              timestamp on now's local calendar day, else
//              Intl.DateTimeFormat(undefined, {dateStyle: 'medium',
//              timeStyle: 'short'}); '' for an absent or unparseable one.
//   collectionSuffix(c, now?) is "N · <when>" (N the member count; just "N"
//              without a <when>); collectionSummary(c, now?) is
//              "<name> · <suffix>". Every collection list (sidebar heading,
//              popover row, Replace dropdown) shows the suffix as secondary
//              text and the summary in `title`, so same-name collections
//              (which are allowed) read apart. Both take an optional `among`,
//              the list shown beside it: when another collection there reads
//              the same "<name> · N · <when>" (same name, count and minute),
//              " · <id>" is appended (" · #k", k its 1-based place among the
//              colliding ones, when ids are absent or repeat); a summary that
//              collides with nothing stays unchanged.

import type { ManifestScreen } from '../api.js';
import {
  freeInstance,
  instancesOf,
  memberInstance,
  mruInstance,
  tabKey,
  tabsReducer,
  withMember,
} from './tabs.js';
import type { TabsState } from './tabs.js';
import { MAX_TOOL_INSTANCES, toolKey, toolLabel, toolSpec } from './tools.js';
import { MAX_LAYOUT_BYTES, mapCollection } from './dock/collectionLayout.js';
import { validateLayout as validateLayoutTree } from '@slaclab/canopy-dock-engine';
import type { CollectionLayout, LayoutReason } from '@slaclab/canopy-dock-engine';

declare const memberKeyBrand: unique symbol;

/** A member's identity key; only memberKey() makes one. */
export type MemberKey = string & { readonly [memberKeyBrand]: true };

export interface ScreenMember {
  /** '<category>/<id>'. */
  screen: string;
  macros?: Record<string, string>;
  name?: string;
}

export interface ToolMember {
  tool: string;
  /** Absent: the tool's config default; '': a blank instance. */
  query?: string;
  name?: string;
}

export type Member = ScreenMember | ToolMember;

/** The value is not a member that has a key. */
export class InvalidMember extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMember';
  }
}

// Mirrors macros.ts (RESERVED, RESERVED_PREFIX) and canopy's report.py.
const RESERVED_MACROS: ReadonlySet<string> = new Set(['embedded', 'theme', 'mode']);
const RESERVED_MACRO_PREFIX = '_canopy';

function isReservedMacro(name: string): boolean {
  return RESERVED_MACROS.has(name) || name.startsWith(RESERVED_MACRO_PREFIX);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function has(obj: Record<string, unknown>, field: string): boolean {
  return Object.hasOwn(obj, field) && obj[field] !== undefined;
}

/** RFC 3986 over UTF-8, as Python's quote(text, safe=''); throws on a lone surrogate. */
function encode(text: string): string {
  try {
    return encodeURIComponent(text).replace(
      /[!'()*]/g,
      (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
    );
  } catch {
    throw new InvalidMember('a macro is not valid Unicode text');
  }
}

/** Compare by Unicode code point, not by UTF-16 code unit. */
function byCodePoint(a: string, b: string): number {
  const ia = a[Symbol.iterator]();
  const ib = b[Symbol.iterator]();
  for (;;) {
    const ca = ia.next();
    const cb = ib.next();
    if (ca.done || cb.done) return (ca.done ? 0 : 1) - (cb.done ? 0 : 1);
    const diff = ca.value.codePointAt(0)! - cb.value.codePointAt(0)!;
    if (diff !== 0) return diff;
  }
}

function checkMacros(raw: unknown): Record<string, string> {
  if (!isPlainObject(raw)) throw new InvalidMember('macros must be an object');
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value !== 'string')
      throw new InvalidMember('a macro name and value must be strings');
    out[name] = value;
  }
  return out;
}

function canonicalMacros(macros: Record<string, string>): string {
  return Object.keys(macros)
    .sort(byCodePoint)
    .filter((name) => !isReservedMacro(name))
    .map((name) => `${encode(name)}=${encode(macros[name]!)}`)
    .join('&');
}

/** The checked member `raw` describes, with only its persisted fields. */
function checkMember(raw: unknown): Member {
  if (!isPlainObject(raw)) throw new InvalidMember('a member must be an object');
  const hasScreen = has(raw, 'screen');
  if (hasScreen === has(raw, 'tool')) {
    throw new InvalidMember('a member names exactly one of screen and tool');
  }
  // `name` is no part of the key; parseMember alone insists it is a string.
  const name = typeof raw.name === 'string' ? raw.name : undefined;
  if (hasScreen) {
    const screen = raw.screen;
    if (typeof screen !== 'string' || screen === '') {
      throw new InvalidMember('screen must be a non-empty string');
    }
    const member: ScreenMember = { screen };
    if (has(raw, 'macros')) member.macros = checkMacros(raw.macros);
    if (name !== undefined) member.name = name;
    // Encoding is part of the check: a lone surrogate has no key.
    if (member.macros) canonicalMacros(member.macros);
    return member;
  }
  const tool = raw.tool;
  if (typeof tool !== 'string' || tool === '') {
    throw new InvalidMember('tool must be a non-empty string');
  }
  const member: ToolMember = { tool };
  if (Object.hasOwn(raw, 'query')) {
    if (typeof raw.query !== 'string') throw new InvalidMember('query must be a string');
    member.query = raw.query;
  }
  if (name !== undefined) member.name = name;
  return member;
}

/**
 * The member `raw` describes (persisted fields only, macros copied), or null when
 * it has no key or carries a non-string `name`.
 */
export function parseMember(raw: unknown): Member | null {
  if (isPlainObject(raw) && has(raw, 'name') && typeof raw.name !== 'string') return null;
  try {
    return checkMember(raw);
  } catch (err) {
    if (err instanceof InvalidMember) return null;
    throw err;
  }
}

/** The identity key of `member`; throws InvalidMember for a value that has none. */
export function memberKey(member: Member): MemberKey {
  const checked = checkMember(member);
  if ('screen' in checked) {
    const query = checked.macros ? canonicalMacros(checked.macros) : '';
    return (query ? `screen:${checked.screen}?${query}` : `screen:${checked.screen}`) as MemberKey;
  }
  return (
    checked.query === undefined ? `tool:${checked.tool}` : `tool:${checked.tool}?${checked.query}`
  ) as MemberKey;
}

/**
 * What a member is called: its `name`, else '<tool label>: <describeQuery(query)>'
 * (the bare tool label without a query). An unnamed screen is its reference; an
 * unregistered tool its id.
 */
export function memberLabel(member: Member): string {
  if (member.name !== undefined) return member.name;
  if ('screen' in member) return member.screen;
  const spec = toolSpec(member.tool);
  if (!spec) return member.tool;
  return member.query === undefined
    ? spec.label
    : `${spec.label}: ${spec.describeQuery(member.query)}`;
}

// --- resolution --------------------------------------------------------------

export interface ResolveContext {
  state: TabsState;
  /** The manifest's screens; null before the first manifest (screen members are pending). */
  screens: readonly ManifestScreen[] | null;
  /** The tools served here (tools.ts ids). */
  tools: readonly string[];
  /** The member keys the Browse tree renders now; a drop is honoured only for one of them. */
  renderedKeys?: ReadonlySet<MemberKey>;
  /**
   * A tool's config default query: an instance on its default shows the
   * member a save stores for it (tabs.ts instanceShowsMember).
   */
  toolQuery?: (tool: string) => string | undefined;
}

export interface ResolveOptions {
  /** 'drop': the member came from a drag payload (see drop trust); 'open': from a row or a collection. */
  source: 'drop' | 'open';
  /** At a tool's instance cap: load into its most recently used instance, or skip the member. */
  atCap: 'mru' | 'skip';
}

export type MemberResolution =
  | {
      status: 'resolved';
      /** The tab key to open, focus or place. */
      key: string;
      /** The member's key (the instance's `from` once opened). */
      member: MemberKey;
      /** A tool query to load into `key` once it is open (a new or the cap's instance). */
      load?: { query: string; view: null };
      /** Set when `key` is the tool's most recently used instance because it is at its cap. */
      atCap?: string;
    }
  | { status: 'pending' }
  | { status: 'unresolved'; reason: string }
  /** atCap 'skip' and the tool has MAX_TOOL_INSTANCES instances open. */
  | { status: 'skipped'; tool: string }
  /** A drop of a member the Browse tree does not render. */
  | { status: 'untrusted' };

export const NOT_IN_LIBRARY = 'Not in the library';
export const CODE_SCREEN = 'Code screen — not viewable';

/** '<Tool> not available here', the reason of a tool member whose tool is not served. */
export function toolUnavailable(tool: string): string {
  return `${toolLabel(tool)} not available here`;
}

function resolveScreen(
  member: ScreenMember,
  screens: readonly ManifestScreen[] | null
): { key: string } | { status: 'pending' } | { status: 'unresolved'; reason: string } {
  if (screens === null) return { status: 'pending' };
  const slash = member.screen.indexOf('/');
  const category = slash < 0 ? '' : member.screen.slice(0, slash);
  const id = slash < 0 ? '' : member.screen.slice(slash + 1);
  // An '@' category would read as a tool key; no screen lives there.
  if (category === '' || id === '' || category.startsWith('@')) {
    return { status: 'unresolved', reason: NOT_IN_LIBRARY };
  }
  const entry = screens.find((screen) => screen.category === category && screen.id === id);
  if (!entry) return { status: 'unresolved', reason: NOT_IN_LIBRARY };
  if (entry.kind !== 'ir') return { status: 'unresolved', reason: CODE_SCREEN };
  return { key: tabKey(category, id, new URLSearchParams(member.macros ?? {})) };
}

/**
 * The tab key `member` opens into (see the module header): resolved, pending
 * before the first manifest, unresolved with a reason, skipped at the cap
 * (atCap 'skip'), or untrusted (a drop of a member the Browse tree does not
 * render). Throws InvalidMember for a value that is no member.
 */
export function resolveMember(
  member: Member,
  ctx: ResolveContext,
  { source, atCap }: ResolveOptions
): MemberResolution {
  const key = memberKey(member);
  if (source === 'drop' && !ctx.renderedKeys?.has(key)) return { status: 'untrusted' };
  if ('screen' in member) {
    const screen = resolveScreen(member, ctx.screens);
    return 'key' in screen ? { status: 'resolved', key: screen.key, member: key } : screen;
  }
  const { tool, query } = member;
  if (!ctx.tools.includes(tool)) return { status: 'unresolved', reason: toolUnavailable(tool) };
  const { state } = ctx;
  if (query === undefined) {
    return { status: 'resolved', key: mruInstance(state, tool) ?? toolKey(tool), member: key };
  }
  const showing = memberInstance(state, tool, key, ctx.toolQuery?.(tool));
  if (showing !== null) return { status: 'resolved', key: showing, member: key };
  const load = { query, view: null };
  if (instancesOf(state, tool).length < MAX_TOOL_INSTANCES) {
    return {
      status: 'resolved',
      key: toolKey(tool, freeInstance(state, tool)),
      member: key,
      load,
    };
  }
  if (atCap === 'skip') return { status: 'skipped', tool };
  return { status: 'resolved', key: mruInstance(state, tool)!, member: key, load, atCap: tool };
}

// --- open all ----------------------------------------------------------------

export type OpenManyContext = Omit<ResolveContext, 'state' | 'renderedKeys'>;

/** A member Open all did not open, and why. */
export interface SkippedMember {
  member: Member;
  reason: string;
}

export interface OpenManyPlan {
  /**
   * A preview, never committed: every planned key open with its instance
   * state (see the open all header); the input state itself while pending.
   */
  state: TabsState;
  /** The tab key each opened member's key landed on. */
  keyOf: ReadonlyMap<MemberKey, string>;
  /** The members not opened, in member order. */
  skipped: SkippedMember[];
  /** A screen member waits for the first manifest: nothing was planned. */
  pending: boolean;
}

/** The reason of a tool member Open all skips at the cap (the cap notice's words). */
export function atCapReason(tool: string): string {
  return `At most ${MAX_TOOL_INSTANCES} ${toolLabel(tool)} tabs`;
}

/** Instance `key` records member `from` and its name, kept when it already does. */
function planFrom(state: TabsState, key: string, from: MemberKey, member: ToolMember): TabsState {
  return withMember(state, key, from, member.name);
}

/** One tool member in append mode: focus the instance showing it, else a new one. */
function planTool(
  state: TabsState,
  member: ToolMember,
  from: MemberKey,
  ctx: OpenManyContext
): { state: TabsState; key: string } | SkippedMember {
  const { tool, query } = member;
  if (!ctx.tools.includes(tool)) return { member, reason: toolUnavailable(tool) };
  const showing = memberInstance(state, tool, from, ctx.toolQuery?.(tool));
  if (showing !== null) {
    return {
      state: planFrom(tabsReducer(state, { type: 'focus', key: showing }), showing, from, member),
      key: showing,
    };
  }
  if (instancesOf(state, tool).length >= MAX_TOOL_INSTANCES) {
    return { member, reason: atCapReason(tool) };
  }
  const key = toolKey(tool, freeInstance(state, tool));
  const next =
    query === undefined
      ? tabsReducer(state, { type: 'open', key, mode: 'append' })
      : tabsReducer(state, { type: 'load', key, query, view: null });
  if (!next.keys.includes(key)) return { member, reason: toolUnavailable(tool) };
  return { state: planFrom(next, key, from, member), key };
}

/**
 * Open all of `members` from `state` (see the module header): the state
 * to commit, the tab key of every opened member, the skipped members with
 * their reasons, or `pending` before the first manifest. Throws InvalidMember
 * for a value that is no member.
 */
export function planOpenMany(
  state: TabsState,
  members: readonly Member[],
  ctx: OpenManyContext
): OpenManyPlan {
  const keyOf = new Map<MemberKey, string>();
  const skipped: SkippedMember[] = [];
  let next = state;
  for (const member of members) {
    const from = memberKey(member);
    if (keyOf.has(from)) continue;
    let key: string;
    if ('screen' in member) {
      const resolved = resolveMember(
        member,
        { state: next, screens: ctx.screens, tools: ctx.tools },
        { source: 'open', atCap: 'skip' }
      );
      if (resolved.status === 'pending')
        return { state, keyOf: new Map(), skipped: [], pending: true };
      if (resolved.status !== 'resolved') {
        skipped.push({
          member,
          reason: resolved.status === 'unresolved' ? resolved.reason : NOT_IN_LIBRARY,
        });
        continue;
      }
      key = resolved.key;
      next = tabsReducer(next, { type: 'open', key, mode: 'append' });
    } else {
      const planned = planTool(next, member, from, ctx);
      if ('reason' in planned) {
        skipped.push(planned);
        continue;
      }
      ({ state: next, key } = planned);
    }
    keyOf.set(from, key);
  }
  return { state: next, keyOf, skipped, pending: false };
}

/** The one notice summarising an Open all's skips, or null when nothing was skipped. */
export function skipNotice(skipped: readonly SkippedMember[]): string | null {
  if (skipped.length === 0) return null;
  const list = skipped.map(({ member, reason }) => `${memberLabel(member)} (${reason})`);
  const count = skipped.length === 1 ? '1 member' : `${skipped.length} members`;
  return `Skipped ${count}: ${list.join('; ')}`;
}

// --- layout ------------------------------------------------------------------

export { MAX_LAYOUT_BYTES };

/** Each refusal reason in canopy's words (canopy_mcp collections.py _REASON_TEXT). */
export const LAYOUT_REASON_TEXT: Readonly<Record<LayoutReason, string>> = Object.freeze({
  not_layout: 'a layout node is a tile (tabs) or a split (split, items)',
  unknown_field: 'unknown field',
  bad_split: "split must be 'row' or 'column'",
  bad_tile_id: 'tile must be a non-empty string',
  duplicate_tile: 'a tile id is used twice',
  bad_key: 'a tab must name a member by its 0-based index',
  empty_tabs: 'tabs must list at least one tab',
  duplicate_key: 'a tab is placed twice',
  showing_not_in_tabs: "showing must be one of the tile's tabs",
  split_too_few_items: 'a split holds at least two items',
  bad_size: 'size must be a positive number',
  unknown_from: 'from must name another tile of the layout',
  member_missing: 'every member is placed in a tile',
});

/** A refusal as canopy words it: "<where>: <reason>: <text>". */
export function layoutRefusal(reason: LayoutReason, where: string): string {
  return `${where}: ${reason}: ${LAYOUT_REASON_TEXT[reason]}`;
}

export type CollectionCheck =
  | {
      ok: true;
      /** The document's layout (member indexes), or null when it carries none. */
      layout: CollectionLayout<number> | null;
    }
  | { ok: false; error: string; reason?: LayoutReason };

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * The layout rules over a collection document (see the layout header): the
 * byte cap and the dock layout's collection form with every
 * member placed once. Refuses with the first broken rule in canopy's words;
 * every other collection rule is canopy's, so a document breaking only those
 * passes here (a document without a members array checks its layout against
 * no member count).
 */
export function checkCollection(doc: unknown): CollectionCheck {
  if (!isPlainObject(doc)) return { ok: false, error: 'a collection must be an object' };
  if (!Object.hasOwn(doc, 'layout')) return { ok: true, layout: null };
  const layout: unknown = doc.layout;
  if (utf8Length(JSON.stringify(layout) ?? '') > MAX_LAYOUT_BYTES) {
    return { ok: false, error: `layout exceeds ${MAX_LAYOUT_BYTES} bytes (MAX_LAYOUT_BYTES)` };
  }
  const members = Array.isArray(doc.members) ? doc.members.length : undefined;
  const check = validateLayoutTree(layout, {
    form: 'collection',
    ...(members !== undefined ? { members } : {}),
  });
  if (!check.valid) {
    return { ok: false, error: layoutRefusal(check.reason, check.where), reason: check.reason };
  }
  return { ok: true, layout: layout as CollectionLayout<number> };
}

// --- edits -------------------------------------------------------------------

/** A collection document as a conditional PUT sends it (see the edits header). */
export type CollectionRaw = Readonly<Record<string, unknown>>;

function rawMembers(raw: CollectionRaw): unknown[] {
  const members = raw.members;
  if (!Array.isArray(members)) throw new TypeError('the collection has no members array');
  return members;
}

function checkIndex(members: readonly unknown[], index: number, what: string): void {
  if (!Number.isInteger(index) || index < 0 || index >= members.length) {
    throw new RangeError(`${what} ${index} is no member index (0..${members.length - 1})`);
  }
}

/** `out` with raw.layout's indexes through `map` (dropped when no tile is left). */
function withLayoutMapped(
  raw: CollectionRaw,
  out: Record<string, unknown>,
  map: (index: number) => number | undefined
): Record<string, unknown> {
  if (!Object.hasOwn(raw, 'layout') || !isPlainObject(raw.layout)) return out;
  const layout = mapCollection(raw.layout as unknown as CollectionLayout<number>, (key) =>
    typeof key === 'number' ? map(key) : undefined
  );
  if (layout === null) delete out.layout;
  else out.layout = layout;
  return out;
}

/** `raw` under the name `name`, every other field as it was. */
export function renamed(raw: CollectionRaw, name: string): Record<string, unknown> {
  return { ...raw, name };
}

/** `raw` without members[index] (a raw index); the layout renumbered (see the edits header). */
export function withoutMember(raw: CollectionRaw, index: number): Record<string, unknown> {
  const members = rawMembers(raw);
  checkIndex(members, index, 'index');
  const out: Record<string, unknown> = {
    ...raw,
    members: members.filter((_, i) => i !== index),
  };
  return withLayoutMapped(raw, out, (i) => (i === index ? undefined : i > index ? i - 1 : i));
}

/** `raw` with members[from] moved to index `to` (raw indices); the layout follows. */
export function reordered(raw: CollectionRaw, from: number, to: number): Record<string, unknown> {
  const members = rawMembers(raw);
  checkIndex(members, from, 'from');
  checkIndex(members, to, 'to');
  const order = members.map((_, i) => i);
  const [moved] = order.splice(from, 1);
  order.splice(to, 0, moved!);
  const placeOf = new Map(order.map((old, place) => [old, place]));
  const out: Record<string, unknown> = { ...raw, members: order.map((old) => members[old]) };
  return withLayoutMapped(raw, out, (i) => placeOf.get(i));
}

// --- list text ---------------------------------------------------------------

/** What the list text reads of a collection. */
export interface CollectionListed {
  /** Disambiguates a collision; compared to tell the collection itself apart. */
  id?: string;
  name: string;
  members: readonly unknown[];
  updated?: string;
}

const SUMMARY_SEP = ' \u00b7 ';

/** The `<when>`: "Today <time>" on now's local day, else medium date + short time. */
export function formatWhen(updated: string | undefined, now: Date = new Date()): string {
  if (!updated) return '';
  const at = new Date(updated);
  if (Number.isNaN(at.getTime())) return '';
  const today =
    at.getFullYear() === now.getFullYear() &&
    at.getMonth() === now.getMonth() &&
    at.getDate() === now.getDate();
  if (today) {
    return `Today ${new Intl.DateTimeFormat(undefined, { timeStyle: 'short' }).format(at)}`;
  }
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(at);
}

/** "N · <when>" without a disambiguator. */
function plainSuffix(collection: CollectionListed, now: Date): string {
  const count = String(collection.members.length);
  const when = formatWhen(collection.updated, now);
  return when ? `${count}${SUMMARY_SEP}${when}` : count;
}

function plainSummary(collection: CollectionListed, now: Date): string {
  return `${collection.name}${SUMMARY_SEP}${plainSuffix(collection, now)}`;
}

/**
 * What tells `collection` apart from the collections in `among` that read
 * the same plain summary — its id when every colliding one has a distinct id,
 * else "#k" (its 1-based place among them, in `among` order); '' when nothing
 * collides.
 */
function collisionTag(
  collection: CollectionListed,
  now: Date,
  among: readonly CollectionListed[]
): string {
  const plain = plainSummary(collection, now);
  const group = among.filter((other) => plainSummary(other, now) === plain);
  let index = group.indexOf(collection);
  if (index < 0 && collection.id !== undefined) {
    index = group.findIndex((other) => other.id === collection.id);
  }
  if (index < 0) {
    group.push(collection);
    index = group.length - 1;
  }
  if (group.length < 2) return '';
  const ids = group.map((other) => other.id);
  const distinct = ids.every((id) => id) && new Set(ids).size === ids.length;
  return distinct ? collection.id! : `#${index + 1}`;
}

/**
 * "N · <when>", or "N" when the collection carries no updated time; with
 * " · <id>" (or " · #k") appended when it collides in `among`.
 */
export function collectionSuffix(
  collection: CollectionListed,
  now: Date = new Date(),
  among?: readonly CollectionListed[]
): string {
  const plain = plainSuffix(collection, now);
  const tag = among ? collisionTag(collection, now, among) : '';
  return tag ? `${plain}${SUMMARY_SEP}${tag}` : plain;
}

/** "<name> · <suffix>", the full string a list row's `title` carries. */
export function collectionSummary(
  collection: CollectionListed,
  now: Date = new Date(),
  among?: readonly CollectionListed[]
): string {
  return `${collection.name}${SUMMARY_SEP}${collectionSuffix(collection, now, among)}`;
}
