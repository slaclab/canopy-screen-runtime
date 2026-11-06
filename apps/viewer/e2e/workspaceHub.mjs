// A stand-in for FRONT's workspace hub (canopy_mcp), for the viewer's tests.
//
// The viewer is developed and tested without a FRONT: e2e/server.mjs serves
// this hub behind the advertised workspace path, and vitest replays the shared
// fixture set (e2e/fixtures/workspace/, a byte copy of canopy's
// tests/canopy_mcp/fixtures/workspace/) against it. The fixture set is the
// spec; where this file and the fixtures disagree, the fixtures win.
//
// Pure: no I/O, no timers, no globals. Time comes from the injected `now()`
// (milliseconds) and is read on every call, so deadlines, expiry and
// window_gone are applied lazily, in time order, before each operation (and on
// `tick()`, which a server calls on an interval so a stream receives a batch
// queued behind one that lapsed). Event streams are sinks the caller passes
// in: `{send(event), end()}`, where an event is `{event, data}`.
//
// Two layers:
//
//   WorkspaceHub        the hub: claim / report / goodbye / connect /
//                       disconnect / result for windows, getWorkspace /
//                       setWorkspace for the agent (the MCP tools' in-process
//                       calls; there is no HTTP route that accepts commands)
//   routeWorkspace      the HTTP surface on top of it, relative to the
//                       advertised path: POST claim[?if_vacant=1], PUT active,
//                       DELETE active?window=, GET events?window=, POST
//                       active/<windowId>/result, GET '' (the document); the
//                       cross-site refusal, the 128 KiB body cap and the state
//                       normalisation live here
//
// Node builtins only, ESM, so server.mjs imports it as is.

export const PROTOCOL = 1;

/** Delivered batch deadline, undelivered batch expiry. */
export const BATCH_TTL_MS = 10_000;
/** A window without a stream for this long is gone. */
export const GONE_AFTER_MS = 3_000;
export const MAX_COMMANDS = 20;
export const MAX_PENDING_PER_WINDOW = 32;
export const MAX_BATCH_IDS = 256;
export const MAX_RESULTS = 100;
export const MAX_BODY_BYTES = 128 * 1024;
export const MAX_QUERY_BYTES = 4096;
export const MAX_MACROS = 16;
export const MAX_MACRO_VALUE = 64;
export const MAX_TABS = 50;
export const MAX_LABEL = 120;
export const MAX_LAYOUT_BYTES = 32 * 1024;

export const TOOLS = ['trace', 'correlation', 'waveform'];
/** A drop's edges and outer sides, and a border's side. */
const SIDES = ['left', 'right', 'top', 'bottom'];
/** How open_set and open_collection place their members. */
const AS = ['tabs', 'side', 'layout'];
const STEPS = ['in', 'out', 'fit', 'actual'];
const POSTED_STATUSES = new Set(['applied', 'rejected', 'skipped']);

/**
 * Each verb's arguments (the agent command protocol over CANOPY): type and required. A
 * string argument may carry an enum. `zoom` (exactly one of step and percent)
 * and `open_set` (layout exactly with as layout, its indexes inside members)
 * carry an extra rule in commandProblem; a command naming a tile id needs the
 * batch's base (enqueueProblem).
 */
const KEY = { type: 'string', required: true };
export const VERBS = {
  open: { ref: { type: 'name', required: true }, macros: { type: 'macros' } },
  open_tool: { tool: { type: 'string', required: true, enum: TOOLS }, query: { type: 'query' } },
  focus: { key: KEY },
  close_tab: { key: KEY },
  close_tile: { tile: { type: 'name', required: true } },
  close_others: { key: KEY },
  close_right: { key: KEY },
  close_all: {},
  reopen: { id: { type: 'string' } },
  back: { key: KEY },
  forward: { key: KEY },
  drop: { source: { type: 'source', required: true }, target: { type: 'target', required: true } },
  open_set: {
    members: { type: 'members', required: true },
    as: { type: 'string', required: true, enum: AS },
    layout: { type: 'layout' },
  },
  open_collection: { ref: { type: 'string', required: true }, as: { type: 'string', enum: AS } },
  set_query: { key: KEY, query: { type: 'query', required: true } },
  zoom: { key: KEY, step: { type: 'string', enum: STEPS }, percent: { type: 'percent' } },
  reset_layout: {},
};

/** The state a window reports before it has anything: the fixtures' '$empty'. */
export function emptyState() {
  return {
    tabs: [],
    active: null,
    layout: null,
    zoom: {},
    instances: {},
    toolMru: [],
    labels: {},
  };
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInteger(value) {
  return typeof value === 'number' && Number.isInteger(value);
}

function utf8Bytes(text) {
  return new TextEncoder().encode(text).length;
}

/** Printable ASCII without whitespace (0x21-0x7E), the macro value charset. */
const PRINTABLE = /^[\x21-\x7e]*$/;

function macroProblem(macros) {
  if (!isObject(macros)) return 'macros must be an object';
  const names = Object.keys(macros);
  if (names.length > MAX_MACROS) return `at most ${MAX_MACROS} macros`;
  for (const name of names) {
    const value = macros[name];
    if (name === '') return 'a macro name must not be empty';
    if (typeof value !== 'string') return `macro ${name} must be a string`;
    if (value.length > MAX_MACRO_VALUE)
      return `macro ${name} is over ${MAX_MACRO_VALUE} characters`;
    if (!PRINTABLE.test(value)) return `macro ${name} must be printable ASCII without whitespace`;
  }
  return null;
}

// --- layout schema -------------------------------------------------------------------
//
//   Layout = Tile | Split
//   Tile   = {tile, tabs: [key, ...>=1], showing: key in tabs, size?, from?}
//   Split  = {split: 'row' | 'column', items: [Layout, ...>=2], size?}
//
// The dock form (a window's state.layout) is above; size is the fraction of the
// parent along its axis, siblings sum to 1 (+-0.001), missing sizes share the
// remainder. The collection form (open_set's layout) has no tile and no from,
// size is a positive weight and a missing showing means tabs[0]; its keys are
// member indexes and every member is placed. No depth cap; the byte cap stays.
// This mirrors canopy_mcp's check_layout rule for rule, so the first broken rule
// is named by the same reason.

const SIZE_TOLERANCE = 0.001;
const SPLIT_FIELDS = new Set(['split', 'items', 'size']);
const DOCK_TILE_FIELDS = new Set(['tile', 'tabs', 'showing', 'size', 'from']);
const COLLECTION_TILE_FIELDS = new Set(['tabs', 'showing', 'size']);

class LayoutRefused extends Error {
  constructor(reason, where) {
    super(`${where}: ${reason}`);
    this.reason = reason;
    this.where = where;
  }
}

function refuse(reason, where) {
  throw new LayoutRefused(reason, where);
}

function isNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function checkLayoutKey(key, walk, where) {
  if (walk.form === 'dock') {
    if (typeof key !== 'string' || key === '') refuse('bad_key', where);
    return;
  }
  const isIndex = isNumber(key) && Number.isInteger(key) && key >= 0;
  if (walk.members !== null) {
    if (!isIndex || key >= walk.members) refuse('bad_key', where);
    return;
  }
  if (!isIndex && (typeof key !== 'string' || key === '')) refuse('bad_key', where);
}

function checkSize(node, form, where) {
  if (!Object.hasOwn(node, 'size')) return;
  const { size } = node;
  if (!(isNumber(size) && size > 0 && (form === 'collection' || size <= 1 + SIZE_TOLERANCE))) {
    refuse('bad_size', where);
  }
}

function checkFields(node, allowed, where) {
  const unknown = Object.keys(node)
    .filter((field) => !allowed.has(field))
    .sort();
  if (unknown.length > 0) refuse('unknown_field', `${where}.${unknown[0]}`);
}

function checkTile(node, walk, where) {
  checkFields(node, walk.form === 'dock' ? DOCK_TILE_FIELDS : COLLECTION_TILE_FIELDS, where);
  let tileId = '';
  if (walk.form === 'dock') {
    tileId = node.tile;
    if (typeof tileId !== 'string' || tileId === '') refuse('bad_tile_id', `${where}.tile`);
    if (walk.tiles.has(tileId)) refuse('duplicate_tile', `${where}.tile`);
    walk.tiles.add(tileId);
  }
  const { tabs } = node;
  if (!Array.isArray(tabs) || tabs.length === 0) refuse('empty_tabs', `${where}.tabs`);
  tabs.forEach((key, index) => {
    const at = `${where}.tabs[${index}]`;
    checkLayoutKey(key, walk, at);
    if (walk.keys.includes(key)) refuse('duplicate_key', at);
    walk.keys.push(key);
  });
  if (Object.hasOwn(node, 'showing') || walk.form === 'dock') {
    if (!tabs.includes(node.showing)) refuse('showing_not_in_tabs', `${where}.showing`);
  }
  checkSize(node, walk.form, `${where}.size`);
  if (Object.hasOwn(node, 'from')) {
    if (typeof node.from !== 'string' || node.from === tileId)
      refuse('unknown_from', `${where}.from`);
    walk.froms.push([node.from, `${where}.from`]);
  }
}

function checkNode(value, walk, where) {
  if (!isObject(value)) refuse('not_layout', where);
  if (!Object.hasOwn(value, 'split') && !Object.hasOwn(value, 'items')) {
    if (!Object.hasOwn(value, 'tabs') && !Object.hasOwn(value, 'tile')) refuse('not_layout', where);
    checkTile(value, walk, where);
    return;
  }
  checkFields(value, SPLIT_FIELDS, where);
  if (value.split !== 'row' && value.split !== 'column') refuse('bad_split', `${where}.split`);
  const { items } = value;
  if (!Array.isArray(items) || items.length < 2) refuse('split_too_few_items', `${where}.items`);
  checkSize(value, walk.form, `${where}.size`);
  items.forEach((item, index) => checkNode(item, walk, `${where}.items[${index}]`));
  if (walk.form === 'dock') {
    const sizes = items.filter((item) => Object.hasOwn(item, 'size')).map((item) => item.size);
    const given = sizes.reduce((sum, size) => sum + size, 0);
    const missing = items.length - sizes.length;
    const fits = missing === 0 ? Math.abs(given - 1) <= SIZE_TOLERANCE : given < 1 - SIZE_TOLERANCE;
    if (!fits) refuse('bad_size', `${where}.items`);
  }
}

/**
 * The layout's keys in tree order; throws LayoutRefused naming the first broken
 * rule. `form` is 'dock' or 'collection'; `members` (collection form only) is the
 * member count, and then every key is a member index and every member is placed.
 */
export function checkLayout(layout, form = 'dock', members = null) {
  const walk = {
    form,
    members: form === 'collection' ? members : null,
    keys: [],
    tiles: new Set(),
    froms: [],
  };
  checkNode(layout, walk, 'layout');
  for (const [tileId, where] of walk.froms) {
    if (!walk.tiles.has(tileId)) refuse('unknown_from', where);
  }
  if (walk.members !== null) {
    for (let index = 0; index < walk.members; index += 1) {
      if (!walk.keys.includes(index)) refuse('member_missing', 'layout');
    }
  }
  return walk.keys;
}

// --- command shape -------------------------------------------------------------------

function isName(value) {
  return typeof value === 'string' && value !== '';
}

function queryProblem(value, name = 'query') {
  if (typeof value !== 'string') return `${name} must be a string`;
  return utf8Bytes(value) <= MAX_QUERY_BYTES ? null : `${name} is over ${MAX_QUERY_BYTES} bytes`;
}

function hasOnly(value, fields) {
  return Object.keys(value).every((field) => fields.includes(field));
}

/** A member to open: {ref, macros?} (a screen) or {tool, query?} (a tool). */
function memberProblem(value, where) {
  if (isObject(value) && Object.hasOwn(value, 'ref') && hasOnly(value, ['ref', 'macros'])) {
    if (!isName(value.ref)) return `${where}.ref must be a non-empty string`;
    const problem = Object.hasOwn(value, 'macros') ? macroProblem(value.macros) : null;
    return problem ? `${where}: ${problem}` : null;
  }
  if (isObject(value) && Object.hasOwn(value, 'tool') && hasOnly(value, ['tool', 'query'])) {
    if (!TOOLS.includes(value.tool)) return `${where}.tool must be one of ${TOOLS.join(', ')}`;
    const problem = Object.hasOwn(value, 'query') ? queryProblem(value.query) : null;
    return problem ? `${where}: ${problem}` : null;
  }
  return `${where} must be {ref, macros?} or {tool, query?}`;
}

/** {new: member}, {tab: key} or {tile: id}. */
function sourceProblem(value) {
  const kinds = isObject(value) ? Object.keys(value) : [];
  if (kinds.length !== 1 || !['new', 'tab', 'tile'].includes(kinds[0])) {
    return 'source must be one of {new}, {tab}, {tile}';
  }
  const kind = kinds[0];
  if (kind === 'new') return memberProblem(value.new, 'source.new');
  return isName(value[kind]) ? null : `source.${kind} must be a non-empty string`;
}

function sameFields(value, fields) {
  const keys = Object.keys(value);
  return keys.length === fields.length && fields.every((field) => keys.includes(field));
}

/** {tile, zone: centre}, {tile, zone: tab, index}, {tile, edge}, {border: {tile, side}}, {outer}. */
function targetProblem(value) {
  const forms =
    'target must be one of {tile, zone}, {tile, zone, index}, {tile, edge}, {border}, {outer}';
  if (!isObject(value)) return forms;
  const sides = SIDES.join(', ');
  if (sameFields(value, ['outer'])) {
    return SIDES.includes(value.outer) ? null : `target.outer must be one of ${sides}`;
  }
  if (sameFields(value, ['border'])) {
    const { border } = value;
    if (!isObject(border) || !sameFields(border, ['tile', 'side']) || !isName(border.tile)) {
      return 'target.border must be {tile, side}';
    }
    return SIDES.includes(border.side) ? null : `target.border.side must be one of ${sides}`;
  }
  const zone = sameFields(value, ['tile', 'zone']);
  const tab = sameFields(value, ['tile', 'zone', 'index']);
  const edge = sameFields(value, ['tile', 'edge']);
  if (!zone && !tab && !edge) return forms;
  if (!isName(value.tile)) return 'target.tile must be a non-empty string';
  if (edge) return SIDES.includes(value.edge) ? null : `target.edge must be one of ${sides}`;
  if (zone) return value.zone === 'centre' ? null : 'target.zone without index must be centre';
  if (value.zone !== 'tab') return 'target.zone with index must be tab';
  return isInteger(value.index) && value.index >= 0 ? null : 'target.index must be an integer >= 0';
}

function membersProblem(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_TABS) {
    return `members must be a list of 1 to ${MAX_TABS} members`;
  }
  for (const [index, member] of value.entries()) {
    const problem = memberProblem(member, `members[${index}]`);
    if (problem) return problem;
  }
  return null;
}

function collectionLayoutProblem(value, members = null) {
  if (!isObject(value)) return 'layout must be a layout object';
  if (utf8Bytes(JSON.stringify(value)) > MAX_LAYOUT_BYTES) {
    return `layout exceeds ${MAX_LAYOUT_BYTES} bytes`;
  }
  try {
    checkLayout(value, 'collection', members);
  } catch (error) {
    if (error instanceof LayoutRefused) {
      return `layout breaks the layout schema (${error.reason} at ${error.where})`;
    }
    throw error;
  }
  return null;
}

function argProblem(name, spec, value) {
  switch (spec.type) {
    case 'string':
      if (typeof value !== 'string') return `${name} must be a string`;
      if (spec.enum && !spec.enum.includes(value))
        return `${name} must be one of ${spec.enum.join(', ')}`;
      return null;
    case 'name':
      return isName(value) ? null : `${name} must be a non-empty string`;
    case 'percent':
      if (!isInteger(value)) return `${name} must be an integer`;
      return value >= 10 && value <= 400 ? null : `${name} must be 10..400`;
    case 'query':
      return queryProblem(value, name);
    case 'macros':
      return macroProblem(value);
    case 'source':
      return sourceProblem(value);
    case 'target':
      return targetProblem(value);
    case 'members':
      return membersProblem(value);
    case 'layout':
      return collectionLayoutProblem(value);
    default:
      return `${name} has no type`;
  }
}

/** The first syntactic problem of one command, or null. The hub's bounds only. */
export function commandProblem(command) {
  if (!isObject(command)) return 'a command must be an object';
  for (const field of Object.keys(command)) {
    if (field !== 'cmd' && field !== 'args') return `a command takes cmd and args, not ${field}`;
  }
  const { cmd } = command;
  if (typeof cmd !== 'string' || !Object.hasOwn(VERBS, cmd)) return `unknown verb ${String(cmd)}`;
  const args = command.args === undefined ? {} : command.args;
  if (!isObject(args)) return 'args must be an object';
  const specs = VERBS[cmd];
  for (const name of Object.keys(args)) {
    if (!Object.hasOwn(specs, name)) return `${cmd} does not take ${name}`;
    const problem = argProblem(name, specs[name], args[name]);
    if (problem) return problem;
  }
  for (const [name, spec] of Object.entries(specs)) {
    if (spec.required && !Object.hasOwn(args, name)) return `${cmd} needs ${name}`;
  }
  if (cmd === 'zoom') {
    const n = Number(Object.hasOwn(args, 'step')) + Number(Object.hasOwn(args, 'percent'));
    if (n !== 1) return 'zoom takes exactly one of step and percent';
  }
  if (cmd === 'open_set') {
    if (Object.hasOwn(args, 'layout') !== (args.as === 'layout')) {
      return 'open_set takes layout exactly when as is layout';
    }
    if (Object.hasOwn(args, 'layout')) {
      const problem = collectionLayoutProblem(args.layout, args.members.length);
      if (problem) return `open_set: ${problem}`;
    }
  }
  return null;
}

/**
 * Whether a well-formed command names a tile id: close_tile, or a drop from a
 * tile, onto a tile or onto a border. Tile ids are reused after a close, so such
 * a batch needs base to show the agent read the layout it is changing.
 */
export function namesTile(command) {
  const args = command.args ?? {};
  if (command.cmd === 'close_tile') return true;
  if (command.cmd === 'drop') {
    return (
      Object.hasOwn(args.source, 'tile') ||
      Object.hasOwn(args.target, 'tile') ||
      Object.hasOwn(args.target, 'border')
    );
  }
  return false;
}

/** The first problem of a set_workspace call's shape (commands, base, batch_id), or null. */
export function enqueueProblem({ commands, base, batch_id: batchId }) {
  if (!Array.isArray(commands)) return 'commands must be a list';
  if (commands.length < 1 || commands.length > MAX_COMMANDS) {
    return `1..${MAX_COMMANDS} commands`;
  }
  const hasBase = base !== undefined && base !== null;
  for (const command of commands) {
    const problem = commandProblem(command);
    if (problem) return problem;
    if (!hasBase && namesTile(command)) return `${command.cmd} names a tile id, so needs base`;
  }
  if (hasBase) {
    if (!isObject(base)) return 'base must be an object';
    for (const field of Object.keys(base)) {
      if (field !== 'window' && field !== 'seq') return `base takes window and seq, not ${field}`;
    }
    if (typeof base.window !== 'string') return 'base.window must be a string';
    if (!isInteger(base.seq)) return 'base.seq must be an integer';
  }
  if (batchId !== undefined && batchId !== null && typeof batchId !== 'string') {
    return 'batch_id must be a string';
  }
  return null;
}

// --- state normalisation ---------------------------------------------------------

const STATE_KEYS = ['tabs', 'active', 'layout', 'zoom', 'instances', 'toolMru', 'labels'];
const TAB_KEYS = new Set(['key', 'kind', 'canBack', 'canForward']);
const INSTANCE_KEYS = new Set(['tool', 'n', 'query', 'view']);
const TOOL_KEY = /^@(trace|correlation|waveform)(\/[1-9][0-9]*)?$/;
const SCREEN_PATH = /^[\x21-\x7e]+$/;
/** C0, DEL, C1 and the bidi controls, stripped from labels. */
const LABEL_STRIP = /[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/gu;

class InvalidState extends Error {}

function invalid(detail) {
  throw new InvalidState(detail);
}

function decodeMacro(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return invalid(`macro ${text} is not percent-encoded`);
  }
}

/**
 * A viewer tab key under the member-key grammar: a tool instance (`@trace`,
 * `@trace/2`) or a screen ref (`<category>/<id>`) with canonical macros
 * (`?A=1&B=2`), at most 16, each value at most 64 printable ASCII characters.
 */
export function isTabKey(key) {
  if (typeof key !== 'string' || key === '') return false;
  if (key.startsWith('@')) return TOOL_KEY.test(key);
  if (!SCREEN_PATH.test(key)) return false;
  const q = key.indexOf('?');
  const path = q === -1 ? key : key.slice(0, q);
  if (!/^[^/?#]+\/[^?#]+$/.test(path)) return false;
  if (q === -1) return true;
  const query = key.slice(q + 1);
  if (query === '') return false;
  const pairs = query.split('&');
  if (pairs.length > MAX_MACROS) return false;
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq <= 0) return false;
    let value;
    try {
      value = decodeURIComponent(pair.slice(eq + 1));
    } catch {
      return false;
    }
    if (value.length > MAX_MACRO_VALUE || !PRINTABLE.test(value)) return false;
  }
  return true;
}

function checkKey(key, where) {
  if (!isTabKey(key)) invalid(`${where}: ${JSON.stringify(key)} is not a tab key`);
  return key;
}

function checkQuery(query, where) {
  if (typeof query !== 'string') invalid(`${where} must be a string`);
  if (utf8Bytes(query) > MAX_QUERY_BYTES) invalid(`${where} is over ${MAX_QUERY_BYTES} bytes`);
  if (!/^[\x20-\x7e]*$/.test(query)) invalid(`${where} must be printable ASCII`);
  return query;
}

/**
 * A window's layout: null exactly when no tab is open, else the layout's dock form
 * (a root Tile allowed, no depth cap, at most 32 KiB) holding every open tab once.
 */
function checkWindowLayout(layout, openKeys) {
  if (openKeys.length === 0) {
    if (layout !== null) invalid('layout must be null while no tab is open');
    return;
  }
  if (layout === null) invalid('layout must hold every open tab');
  if (utf8Bytes(JSON.stringify(layout)) > MAX_LAYOUT_BYTES) invalid('layout over 32 KiB');
  let placed;
  try {
    placed = checkLayout(layout);
  } catch (error) {
    if (error instanceof LayoutRefused) invalid(`${error.where}: ${error.reason}`);
    throw error;
  }
  const open = new Set(openKeys);
  if (placed.length !== open.size || !placed.every((key) => open.has(key))) {
    invalid('layout must hold exactly the open tabs');
  }
}

/**
 * A reported state normalised the way FRONT's hub does on claim, report and
 * result: closed schema, keys under the member-key grammar, queries at most
 * 4096 bytes of printable ASCII, labels at most 120 characters with C0/C1 and
 * bidi controls stripped. Throws InvalidState (-> 422 invalid_state).
 */
export function normaliseState(raw) {
  if (!isObject(raw)) invalid('state must be an object');
  for (const field of Object.keys(raw)) {
    if (!STATE_KEYS.includes(field)) invalid(`state does not take ${field}`);
  }
  for (const field of STATE_KEYS) {
    if (!Object.hasOwn(raw, field)) invalid(`state needs ${field}`);
  }
  const { tabs, active, layout, zoom, instances, toolMru, labels } = raw;
  if (!Array.isArray(tabs) || tabs.length > MAX_TABS)
    invalid(`tabs is a list of at most ${MAX_TABS}`);
  for (const tab of tabs) {
    if (!isObject(tab)) invalid('a tab must be an object');
    for (const field of Object.keys(tab)) {
      if (!TAB_KEYS.has(field)) invalid(`a tab does not take ${field}`);
    }
    checkKey(tab.key, 'tab');
    if (tab.kind !== 'screen' && tab.kind !== 'tool') invalid('tab kind is screen or tool');
    for (const flag of ['canBack', 'canForward']) {
      if (typeof tab[flag] !== 'boolean') invalid(`tab ${flag} must be a boolean`);
    }
  }
  if (active !== null) checkKey(active, 'active');
  checkWindowLayout(
    layout,
    tabs.map((tab) => tab.key)
  );
  if (!isObject(zoom)) invalid('zoom must be an object');
  for (const [key, entry] of Object.entries(zoom)) {
    checkKey(key, 'zoom');
    const fit = isObject(entry) && entry.mode === 'fit' && Object.keys(entry).length === 1;
    const manual =
      isObject(entry) &&
      entry.mode === 'manual' &&
      Object.keys(entry).length === 2 &&
      isInteger(entry.percent) &&
      entry.percent >= 10 &&
      entry.percent <= 400;
    if (!fit && !manual) invalid(`zoom for ${key} is {mode: fit} or {mode: manual, percent}`);
  }
  if (!isObject(instances)) invalid('instances must be an object');
  for (const [key, instance] of Object.entries(instances)) {
    if (!TOOL_KEY.test(key)) invalid(`instances: ${key} is not a tool key`);
    if (!isObject(instance)) invalid('an instance must be an object');
    for (const field of Object.keys(instance)) {
      if (!INSTANCE_KEYS.has(field)) invalid(`an instance does not take ${field}`);
    }
    if (!TOOLS.includes(instance.tool)) invalid(`instance tool is one of ${TOOLS.join(', ')}`);
    if (!isInteger(instance.n) || instance.n < 1) invalid('instance n is a positive integer');
    if (instance.query !== null && instance.query !== undefined)
      checkQuery(instance.query, 'query');
  }
  if (!Array.isArray(toolMru)) invalid('toolMru must be a list');
  for (const key of toolMru) {
    if (typeof key !== 'string' || !TOOL_KEY.test(key)) invalid('toolMru holds tool keys');
  }
  if (!isObject(labels)) invalid('labels must be an object');
  const clean = {};
  for (const [key, label] of Object.entries(labels)) {
    checkKey(key, 'labels');
    if (typeof label !== 'string') invalid('a label must be a string');
    const stripped = label.replace(LABEL_STRIP, '');
    if ([...stripped].length > MAX_LABEL) invalid(`a label is at most ${MAX_LABEL} characters`);
    clean[key] = stripped;
  }
  return structuredClone({ tabs, active, layout, zoom, instances, toolMru, labels: clean });
}

// --- the hub -----------------------------------------------------------------------

function isoAt(ms) {
  return new Date(ms).toISOString();
}

function randomEpoch() {
  return Math.random().toString(36).slice(2, 6).padEnd(4, '0');
}

/**
 * One process-wide hub (FRONT keeps one; the e2e server one per e2e user).
 *
 * Options: `epoch` (default random; the fixtures use 'e1'), `now` (ms clock,
 * default Date.now), `context` (() => {collections, sidebar}, the parts of the
 * document FRONT derives from its collections store; default empty).
 */
export class WorkspaceHub {
  constructor({ epoch = randomEpoch(), now = () => Date.now(), context } = {}) {
    this.epoch = epoch;
    this._now = now;
    this._context = context ?? (() => ({}));
    this._slot = {
      activeWindow: null,
      shown: false,
      seq: 0,
      truncated: false,
      state: emptyState(),
      focusedAt: null,
      updatedAt: null,
    };
    /** windowId -> report high-water mark (reset on a claim by another window). */
    this._highWater = new Map();
    /** windowId -> current stream {windowId, sink, open}. */
    this._streams = new Map();
    /** windowId -> when it last had no stream (stream end, goodbye, claim without one). */
    this._streamlessSince = new Map();
    /** Unresolved and resolved batches the hub still tracks, in mint order. */
    this._batches = [];
    /** batch id -> batch: the batch_id lookup, least recently used first. */
    this._lru = new Map();
    this._results = [];
    this._batchN = 0;
    this._commandN = 0;
  }

  // --- time ------------------------------------------------------------------

  /** Apply every deadline, expiry and window_gone that is due, in time order. */
  tick() {
    const now = this._now();
    for (;;) {
      const due = this._nextDue(now);
      if (due === null) return;
      due.apply();
    }
  }

  _nextDue(now) {
    let best = null;
    const consider = (at, apply) => {
      if (at <= now && (best === null || at < best.at)) best = { at, apply };
    };
    for (const batch of this._batches) {
      if (batch.resolved) continue;
      if (batch.deliveredAt !== null) {
        const at = batch.deliveredAt + BATCH_TTL_MS;
        consider(at, () => this._lapse(batch, at));
      } else {
        const at = batch.enqueuedAt + BATCH_TTL_MS;
        consider(at, () => this._resolve(batch, 'expired', at));
      }
    }
    for (const windowId of new Set(this._unresolved().map((b) => b.window))) {
      if (this._streamOpen(windowId)) continue;
      const since = this._streamlessSince.get(windowId);
      if (since === undefined) continue;
      const at = since + GONE_AFTER_MS;
      consider(at, () => this._gone(windowId, at));
    }
    return best;
  }

  _lapse(batch, at) {
    this._resolve(batch, 'lost', at);
    this._deliver(batch.window, at);
  }

  _gone(windowId, at) {
    for (const batch of this._unresolved()) {
      if (batch.window === windowId) this._resolve(batch, 'window_gone', at);
    }
  }

  // --- batches -----------------------------------------------------------------

  _unresolved() {
    return this._batches.filter((b) => !b.resolved);
  }

  /** Every command without a result gets `status`; the batch is done. */
  _resolve(batch, status, at, posted = new Map()) {
    batch.resolved = true;
    for (const command of batch.commands) {
      const entry = posted.get(command.id) ?? { status };
      const result = { id: command.id, ...entry };
      batch.results.push(result);
      this._results.push({
        id: command.id,
        batch: batch.id,
        window: batch.window,
        cmd: command.cmd,
        ...entry,
        at: isoAt(at),
      });
    }
    if (this._results.length > MAX_RESULTS) {
      this._results.splice(0, this._results.length - MAX_RESULTS);
    }
    this._forget();
  }

  /** Drop resolved batches the batch_id lookup no longer remembers. */
  _forget() {
    this._batches = this._batches.filter((b) => !b.resolved || this._lru.has(b.id));
  }

  /** Deliver `windowId`'s next batch when its stream is open and it holds none. */
  _deliver(windowId, at) {
    const stream = this._streams.get(windowId);
    if (!stream?.open) return;
    const mine = this._unresolved().filter((b) => b.window === windowId);
    if (mine.some((b) => b.deliveredAt !== null)) return;
    const next = mine.find((b) => b.enqueuedAt + BATCH_TTL_MS > at);
    if (!next) return;
    next.deliveredAt = at;
    const data = { batch: next.id, window: next.window };
    if (next.base) data.base = next.base;
    data.deadline = isoAt(at + BATCH_TTL_MS);
    data.commands = next.commands.map(({ id, cmd, args }) => ({ id, cmd, args }));
    stream.sink.send({ event: 'batch', data: structuredClone(data) });
  }

  _batchView(batch) {
    return {
      id: batch.id,
      status: batch.resolved ? 'done' : 'pending',
      results: batch.resolved ? structuredClone(batch.results) : [],
    };
  }

  // --- windows ---------------------------------------------------------------------

  _streamOpen(windowId) {
    return this._streams.get(windowId)?.open === true;
  }

  /** The active window can take a batch: a stream, or claimed/streamless under 3 s. */
  _present() {
    const windowId = this._slot.activeWindow;
    if (windowId === null) return false;
    if (this._streamOpen(windowId)) return true;
    const since = this._streamlessSince.get(windowId);
    return since !== undefined && this._now() - since < GONE_AFTER_MS;
  }

  _endStream(windowId, finalEvent) {
    const stream = this._streams.get(windowId);
    if (!stream?.open) return;
    stream.open = false;
    this._streams.delete(windowId);
    if (finalEvent) stream.sink.send(finalEvent);
    stream.sink.end();
  }

  /**
   * POST <ws>/claim. Always wins unless `ifVacant` and a connected window holds
   * the slot. `body` is validated: {windowId, seq, shown, state, truncated?}.
   */
  claim(body, { ifVacant = false } = {}) {
    this.tick();
    const now = this._now();
    const previous = this._slot.activeWindow;
    if (ifVacant && previous !== null && this._streamOpen(previous)) {
      return error(409, 'not_vacant');
    }
    const { windowId } = body;
    if (previous !== null && previous !== windowId) {
      this._gone(previous, now);
      this._endStream(previous, { event: 'inactive', data: {} });
      this._highWater.clear();
    }
    this._slot = {
      activeWindow: windowId,
      shown: body.shown,
      seq: body.seq,
      truncated: body.truncated === true,
      state: body.state,
      focusedAt: isoAt(now),
      updatedAt: isoAt(now),
    };
    this._highWater.set(windowId, body.seq);
    if (!this._streamOpen(windowId)) this._streamlessSince.set(windowId, now);
    return { status: 200, body: { active: true, previous, epoch: this.epoch } };
  }

  /** PUT <ws>/active: only the slot holder; a seq at or below its high-water mark is a no-op. */
  report(body) {
    this.tick();
    const { windowId } = body;
    if (windowId !== this._slot.activeWindow) return error(409, 'not_active');
    if (body.seq <= (this._highWater.get(windowId) ?? -Infinity)) return { status: 204 };
    this._highWater.set(windowId, body.seq);
    Object.assign(this._slot, {
      seq: body.seq,
      shown: body.shown,
      truncated: body.truncated === true,
      state: body.state,
      updatedAt: isoAt(this._now()),
    });
    return { status: 204 };
  }

  /** DELETE <ws>/active?window=: the holder is disconnected at once; anyone else changes nothing. */
  goodbye(windowId) {
    this.tick();
    if (windowId === this._slot.activeWindow) {
      this._endStream(windowId, null);
      this._streamlessSince.set(windowId, this._now());
    }
    return { status: 204 };
  }

  /**
   * GET <ws>/events?window=. The slot holder gets a stream: `sink.send` receives
   * hello (and a batch when one is waiting) before this returns, then every
   * later event; `sink.end` when the hub ends it. Anyone else: 204. A window's
   * new stream replaces its old one (ended without an event, no window_gone).
   */
  connect(windowId, sink) {
    this.tick();
    if (windowId !== this._slot.activeWindow) return { status: 204 };
    this._endStream(windowId, null);
    const stream = { windowId, sink, open: true };
    this._streams.set(windowId, stream);
    this._streamlessSince.delete(windowId);
    sink.send({
      event: 'hello',
      data: { epoch: this.epoch, activeWindow: windowId, seq: this._slot.seq },
    });
    this._deliver(windowId, this._now());
    return { status: 200, stream };
  }

  /** The client ended `stream` (the connection closed). A replaced stream is a no-op. */
  disconnect(stream) {
    this.tick();
    if (!stream?.open || this._streams.get(stream.windowId) !== stream) return;
    stream.open = false;
    this._streams.delete(stream.windowId);
    this._streamlessSince.set(stream.windowId, this._now());
  }

  /**
   * POST <ws>/active/<windowId>/result {batch, seq, state, results}. 409
   * not_claimed unless that window holds the batch, 409 batch_closed once it is
   * resolved. The state is written only from the slot holder with a higher seq.
   */
  result(windowId, body) {
    this.tick();
    const now = this._now();
    const batch = this._batches.find((b) => b.id === body.batch);
    if (!batch || batch.window !== windowId || batch.deliveredAt === null) {
      return error(409, 'not_claimed');
    }
    if (batch.resolved) return error(409, 'batch_closed');
    const ids = new Set(batch.commands.map((c) => c.id));
    const posted = new Map();
    for (const entry of body.results) {
      if (!ids.has(entry.id) || posted.has(entry.id)) continue;
      const { id: _id, ...rest } = entry;
      posted.set(entry.id, rest);
    }
    this._resolve(batch, 'lost', now, posted);
    if (windowId === this._slot.activeWindow && body.seq > this._slot.seq) {
      this._highWater.set(windowId, Math.max(this._highWater.get(windowId) ?? body.seq, body.seq));
      Object.assign(this._slot, { seq: body.seq, state: body.state, updatedAt: isoAt(now) });
    }
    this._deliver(windowId, now);
    return { status: 204 };
  }

  /** Shutdown: every stream ends. The hub is not used afterwards (FRONT swaps in a fresh one). */
  close() {
    for (const windowId of [...this._streams.keys()]) this._endStream(windowId, null);
  }

  // --- the agent -------------------------------------------------------------------

  /** get_workspace: the document. */
  getWorkspace() {
    this.tick();
    const slot = this._slot;
    const context = this._context() ?? {};
    return structuredClone({
      protocol: PROTOCOL,
      epoch: this.epoch,
      activeWindow: slot.activeWindow,
      connected: slot.activeWindow !== null && this._streamOpen(slot.activeWindow),
      shown: slot.shown,
      focusedAt: slot.focusedAt,
      updatedAt: slot.updatedAt,
      seq: slot.seq,
      truncated: slot.truncated,
      state: slot.state,
      collections: context.collections ?? { shown: [] },
      sidebar: context.sidebar ?? { pinned: [], recent: [] },
      pending: this._unresolved().flatMap((b) => b.commands.map((c) => c.id)),
      results: this._results,
    });
  }

  /**
   * set_workspace {commands, base?, batch_id?, wait_s?}: the document plus
   * `batch`. Returns at once (a pending batch reports results []); `wait_s` is
   * the caller's to honour by polling with the batch_id.
   */
  setWorkspace({ commands, base, batch_id: batchId } = {}) {
    this.tick();
    const refused = (reason) => ({
      ...this.getWorkspace(),
      batch: { id: null, status: 'refused', reason, results: [] },
    });
    if (enqueueProblem({ commands, base, batch_id: batchId })) return refused('invalid_command');
    if (typeof batchId === 'string') {
      const known = this._lru.get(batchId);
      if (!known) return refused('unknown_batch');
      this._lru.delete(batchId);
      this._lru.set(batchId, known);
      return { ...this.getWorkspace(), batch: this._batchView(known) };
    }
    const windowId = this._slot.activeWindow;
    if (base !== undefined && base !== null && base.window !== windowId)
      return refused('stale_state');
    if (!this._present()) return refused('no_window');
    if (!this._slot.shown) return refused('window_hidden');
    const queued = this._unresolved()
      .filter((b) => b.window === windowId)
      .reduce((n, b) => n + b.commands.length, 0);
    if (queued + commands.length > MAX_PENDING_PER_WINDOW) return refused('queue_full');

    const now = this._now();
    this._batchN += 1;
    const batch = {
      id: `b-${this.epoch}-${this._batchN}`,
      window: windowId,
      base: base ? { window: base.window, seq: base.seq } : null,
      commands: commands.map((c) => {
        this._commandN += 1;
        return {
          id: `c-${this.epoch}-${this._commandN}`,
          cmd: c.cmd,
          args: structuredClone(c.args ?? {}),
        };
      }),
      enqueuedAt: now,
      deliveredAt: null,
      resolved: false,
      results: [],
    };
    this._batches.push(batch);
    this._lru.set(batch.id, batch);
    while (this._lru.size > MAX_BATCH_IDS) this._lru.delete(this._lru.keys().next().value);
    this._forget();
    this._deliver(windowId, now);
    return { ...this.getWorkspace(), batch: this._batchView(batch) };
  }
}

// --- the HTTP surface ------------------------------------------------------------------

function header(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === 'function') return headers.get(name) ?? undefined;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

function bodyBytes(body) {
  if (body === undefined || body === null) return new Uint8Array();
  if (typeof body === 'string') return new TextEncoder().encode(body);
  return body;
}

const error = (status, code, detail) => ({
  status,
  body: { code, detail: detail ?? code },
});

function parseJson(bytes) {
  try {
    return { value: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { problem: 'the body is not JSON' };
  }
}

/** A claim or report body, state normalised; or an error answer. */
function windowBody(raw) {
  if (!isObject(raw)) return { answer: error(400, 'invalid_body', 'the body must be an object') };
  for (const field of Object.keys(raw)) {
    if (!['windowId', 'seq', 'shown', 'state', 'truncated'].includes(field)) {
      return { answer: error(400, 'invalid_body', `the body does not take ${field}`) };
    }
  }
  if (typeof raw.windowId !== 'string' || raw.windowId === '' || raw.windowId.length > 128) {
    return { answer: error(400, 'invalid_body', 'windowId must be text') };
  }
  if (!isInteger(raw.seq) || raw.seq < 0)
    return { answer: error(400, 'invalid_body', 'seq must be an integer') };
  if (typeof raw.shown !== 'boolean')
    return { answer: error(400, 'invalid_body', 'shown must be a boolean') };
  if (raw.truncated !== undefined && typeof raw.truncated !== 'boolean') {
    return { answer: error(400, 'invalid_body', 'truncated must be a boolean') };
  }
  try {
    return { body: { ...raw, state: normaliseState(raw.state) } };
  } catch (e) {
    if (e instanceof InvalidState) return { answer: error(422, 'invalid_state', e.message) };
    throw e;
  }
}

function resultBody(raw) {
  if (!isObject(raw)) return { answer: error(400, 'invalid_body', 'the body must be an object') };
  for (const field of Object.keys(raw)) {
    if (!['batch', 'seq', 'state', 'results'].includes(field)) {
      return { answer: error(400, 'invalid_body', `the body does not take ${field}`) };
    }
  }
  if (typeof raw.batch !== 'string')
    return { answer: error(400, 'invalid_body', 'batch must be text') };
  if (!isInteger(raw.seq) || raw.seq < 0)
    return { answer: error(400, 'invalid_body', 'seq must be an integer') };
  if (!Array.isArray(raw.results))
    return { answer: error(400, 'invalid_body', 'results must be a list') };
  for (const entry of raw.results) {
    if (!isObject(entry) || typeof entry.id !== 'string' || !POSTED_STATUSES.has(entry.status)) {
      return {
        answer: error(
          400,
          'invalid_body',
          'a result is {id, status: applied|rejected|skipped, ...}'
        ),
      };
    }
  }
  try {
    return { body: { ...raw, state: normaliseState(raw.state) } };
  } catch (e) {
    if (e instanceof InvalidState) return { answer: error(422, 'invalid_state', e.message) };
    throw e;
  }
}

/** The advertisement FRONT adds to config.json under the opt-in. */
export const ADVERTISEMENT = { path: 'workspace', protocol: PROTOCOL };

/** `config` (config.json text) with the workspace advertised when `optIn`, else unchanged. */
export function advertiseWorkspace(config, optIn) {
  if (!optIn) return config;
  return JSON.stringify({ ...JSON.parse(config), workspace: ADVERTISEMENT });
}

/**
 * One request to the workspace routes. `path` is relative to the advertised
 * workspace path, with its query string ('claim?if_vacant=1',
 * 'events?window=w-A', 'active/w-A/result', '' for the document). `headers` is
 * a plain object or a Headers; `body` a string or bytes. `sink` is the event
 * sink for GET events. Answers {status, body?, stream?}; a 200 on events
 * carries the stream whose sink has already received hello. `hub` null (the
 * opt-in off) answers 404 to everything.
 */
export function routeWorkspace(hub, { method, path, headers, body, sink }) {
  // Opt-in off: no hub, no advertisement, and every workspace route is a 404.
  if (hub === null || hub === undefined) return error(404, 'not_found');
  const site = header(headers, 'sec-fetch-site');
  if (site !== undefined && site !== 'same-origin' && site !== 'none') {
    return error(403, 'cross_site');
  }
  const url = new URL(path.replace(/^\/+/, ''), 'http://workspace.invalid/');
  const route = url.pathname.slice(1);
  const params = url.searchParams;
  const bytes = bodyBytes(body);
  if (bytes.length > MAX_BODY_BYTES) return error(413, 'too_large');
  const json = () => {
    const parsed = parseJson(bytes);
    return parsed.problem ? { answer: error(400, 'invalid_body', parsed.problem) } : parsed;
  };

  if (route === '') {
    if (method !== 'GET') return error(405, 'method_not_allowed');
    return { status: 200, body: hub.getWorkspace() };
  }
  if (route === 'claim') {
    if (method !== 'POST') return error(405, 'method_not_allowed');
    const parsed = json();
    if (parsed.answer) return parsed.answer;
    const checked = windowBody(parsed.value);
    if (checked.answer) return checked.answer;
    return hub.claim(checked.body, { ifVacant: params.get('if_vacant') === '1' });
  }
  if (route === 'active') {
    if (method === 'DELETE') return hub.goodbye(params.get('window') ?? '');
    if (method !== 'PUT') return error(405, 'method_not_allowed');
    const parsed = json();
    if (parsed.answer) return parsed.answer;
    const checked = windowBody(parsed.value);
    if (checked.answer) return checked.answer;
    return hub.report(checked.body);
  }
  if (route === 'events') {
    if (method !== 'GET') return error(405, 'method_not_allowed');
    const windowId = params.get('window');
    if (!windowId) return error(400, 'invalid_body', 'events needs ?window=');
    return hub.connect(windowId, sink ?? { send() {}, end() {} });
  }
  const resultRoute = /^active\/([^/]+)\/result$/.exec(route);
  if (resultRoute) {
    if (method !== 'POST') return error(405, 'method_not_allowed');
    const parsed = json();
    if (parsed.answer) return parsed.answer;
    const checked = resultBody(parsed.value);
    if (checked.answer) return checked.answer;
    return hub.result(decodeURIComponent(resultRoute[1]), checked.body);
  }
  return error(404, 'not_found');
}

/** One SSE frame for an event (pings are the caller's: ': ping\n\n'). */
export function sseFrame({ event, data }) {
  return `event: ${event}\ndata: ${JSON.stringify(data ?? {})}\n\n`;
}
