#!/usr/bin/env node
// Test server for the Playwright suite: serves the built viewer (dist/) under
// a path prefix, the way canopy_mcp's static routes do behind a host's proxy.
// It mirrors that route rule so the browser tests exercise the same URL shape
// the real deployment produces:
//
//   <prefix>/, <prefix>/s/*, <prefix>/embed/*  -> dist/index.html with exactly
//                                                one <base href="<prefix>/">
//                                                first in <head>
//   <prefix>/assets/*                          -> dist/assets/*
//   <prefix>/config.json                       -> the fixture config
//   <prefix>/drafts/*                          -> the fixture drafts folder
//   <prefix>/health                            -> {"status":"ok"}
//   <prefix>/views, <prefix>/views/<id>        -> saved tool views, in memory,
//                                                with canopy_mcp's GET/PUT/
//                                                DELETE contract: PUT takes
//                                                {name, query, kind?} and no
//                                                other key, kind defaults to
//                                                'trace' and persists, and a
//                                                PUT changing an id's kind is
//                                                a 409
//   <prefix>/collections,                      -> collections and their state,
//   <prefix>/collections/<id>,                    in memory per e2e user, with
//   <prefix>/collections-state                    canopy_mcp's contract (see
//                                                Collections below)
//
// plus a Trace stand-in and the hooks the workspace specs drive it through:
//
//   <prefix>/trace/                            -> fixtures/trace-stub/index.html
//                                                with <base href="<prefix>/trace/">
//   <prefix>/trace/correlation.html,           -> the same stub page (the
//   <prefix>/trace/waveform.html                  correlation and waveform
//                                                tools' stand-in), same <base>
//   <prefix>/trace/assets/trace-open.js        -> the stub's on-request
//                                                canopy:trace-open hook:
//                                                window.__postTraceOpen(tool,
//                                                query) posts {type:
//                                                'canopy:trace-open', tool,
//                                                query} to the parent
//   <prefix>/trace/assets/*                    -> fixtures/trace-stub/assets/*
//   <prefix>/mole/v1/archivers?probe=<id>      -> {"archivers":[]}, counted per
//                                                probe (none -> 'default')
//   <prefix>/__mole-count?probe=<id>           -> {"probe":<id>,"count":<n>}
//   <prefix>/__host.html?probe=<id>            -> a top page that stores the
//                                                workspace tabs ['@trace'] (under
//                                                canopy-viewer:tabs:<prefix>) with
//                                                the @trace query pv=PROBE:<id>&range=-1h,
//                                                then iframes <prefix>/embed/@trace
//                                                (1200x800, #toggle-trace hides it)
//   POST <prefix>/__collections-reset          -> re-seeds the e2e user's
//        ?mode=off|on|default                     collections (see below);
//                                                200 {"user","mode"}
//   <prefix>/workspace, <prefix>/workspace/*   -> the workspace hub stand-in
//                                                (e2e/workspaceHub.mjs), per
//                                                e2e user, once opted in (see
//                                                Workspace below)
//   POST <prefix>/__workspace-reset            -> a fresh hub for the e2e user;
//        ?mode=on|off                             200 {"user","mode","epoch"}
//   POST <prefix>/__workspace-enqueue          -> the agent's set_workspace,
//                                                {commands, base?, batch_id?,
//                                                wait_s?}: 200 with the document
//                                                and its batch
//   GET  <prefix>/__workspace                  -> the agent's get_workspace
//
// Workspace. FRONT's hub replayed by e2e/workspaceHub.mjs, the module vitest
// holds to the shared fixtures (e2e/fixtures/workspace/), one hub per e2e user
// (the collections cookie or header). Off until POST __workspace-reset?mode=on
// for that user ('default' stays off, like collections): off, /config.json has
// no `workspace` key and every workspace route is a 404, as in FRONT without
// its opt-in. On, /config.json advertises workspace: {path: 'workspace',
// protocol: 1} and <prefix>/workspace/... answers the routes the hub module
// documents (claim, active, events, active/<windowId>/result, the document).
// Commands reach a window only through the test-only __workspace-enqueue: FRONT
// has no HTTP route that accepts commands, and the app bundle never calls it.
// wait_s (0..10, default 0) waits for the batch to resolve before answering.
//
// Collections. Playwright runs specs fully parallel against this one process,
// so every collections answer is keyed by an e2e user: the `canopy-e2e-user`
// cookie, else the `x-canopy-e2e-user` header, else 'default' (malformed ->
// 400). e2e/collectionsFixture.ts sets the cookie per test and resets.
// A reset seeds the user's personal store from fixtures/collections/valid/
// personal/, an empty state (responses/state-empty.json), and a mode:
//
//   off      (every user until reset; the only mode 'default' may take)
//            /config.json is the fixture bytes, with no `collections` key,
//            so specs that never opt in keep today's tree
//   on       /config.json adds collections: {path: 'collections'}; the
//            facility store (valid/facility/, id = file stem) is served with
//            no `default` key
//   default  as on, and facility collections keep `default: true`
//
// The routes follow canopy_mcp.collections: GET /collections -> {collections}
// (facility first, then personal, each by case-folded name then id, each with
// source, ref and rev); GET|PUT|DELETE /collections/<id> on the personal store.
// `rev` is opaque here (canopy hashes the stored bytes): every write bumps it,
// it is never stored in the doc, and a client-sent rev/source/ref/updated is
// dropped before validation. A PUT states its precondition:
//
//   neither header            428 precondition_required, nothing written
//   If-None-Match: *          create only: 201, 412 exists when stored
//   If-Match: <rev>[, ...]    replace that rev only: 200, 412 gone when not
//                             stored, 412 stale on another rev (each rev bare,
//                             quoted or W/; * matches any; If-Match decides
//                             when both are sent)
//
// The 200/201 body is the listed doc with its new rev; 400 invalid_collection
// for a `default` key. DELETE -> 204 with personal:<id> pruned from the state,
// 404 when missing, 412 stale under an If-Match naming another rev.
// GET /collections and GET /collections-state answer an ETag (the quoted
// sha256 hex of the body) and a bodiless 304 on a matching If-None-Match.
// POST /collections-state takes one op of OP_FIELDS: tick/untick {ref},
// pin/unpin/recent/recent-remove {member}, recent-clear {}, recent-many
// {members} (at most MAX_RECENT, else 400 invalid_op; the first ends first);
// 400 invalid_op, 409 pinned_full / selection_full, 413 too_large (8 KiB an
// op, 48 KiB a recent-many op). Error bodies are the byte copies in
// fixtures/collections/responses/ where one exists.
//
// Like production, a bare <prefix>/trace and any other /trace/* path is a 404.
//
// The hare PV socket (<prefix>/hare/v1/ws/pvs) and its REST writes are not
// served here: specs mock them in the page (installHareMock and
// installPvWriteRoute in e2e/hostFixture.ts, frames from e2e/machineFrames.ts),
// so every heartbeat, close and write a spec drives stays in that test.
//
// Anything else is a 404, so a request the viewer should not make surfaces
// as a failure in the tests. Dependency-free: node: builtins only.
//
// Environment: E2E_PORT (default 4179), E2E_PREFIX (default /x/y),
// VIEWER_DIST (default ../dist), E2E_DRAFTS (default ./fixtures/drafts).

import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { advertiseWorkspace, routeWorkspace, sseFrame, WorkspaceHub } from './workspaceHub.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.E2E_PORT ?? 4179);
const prefix = (process.env.E2E_PREFIX ?? '/x/y').replace(/\/+$/, '');
const dist = resolve(process.env.VIEWER_DIST ?? join(here, '..', 'dist'));
const drafts = resolve(process.env.E2E_DRAFTS ?? join(here, 'fixtures', 'drafts'));
const config = readFileSync(join(here, 'fixtures', 'config.json'), 'utf8');
const traceStub = join(here, 'fixtures', 'trace-stub');

/** Saved views by id (canopy_mcp keeps them on disk; here they live in memory). */
const views = new Map();
const VIEW_ID = /^[A-Za-z0-9_-]{1,64}$/;
const VIEW_KIND = /^[a-z][a-z0-9-]{0,31}$/;
const VIEW_KEYS = new Set(['name', 'query', 'kind']);

function readBody(req) {
  return readBytes(req).then((bytes) => bytes.toString('utf8'));
}

function readBytes(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolveBody(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// --- Collections ---------------------------------------------------------------

const collectionsFixtures = join(here, 'fixtures', 'collections');
const COLLECTION_ID = VIEW_ID;
const E2E_USER = /^[A-Za-z0-9_-]{1,64}$/;
const E2E_USER_COOKIE = 'canopy-e2e-user';
const E2E_USER_HEADER = 'x-canopy-e2e-user';
const COLLECTION_MODES = new Set(['off', 'on', 'default']);
const MAX_PINNED = 50;
const MAX_REFS = 100;
const MAX_RECENT = 10;
const MAX_STATE_OP_BYTES = 8 * 1024;
const MAX_RECENT_MANY_OP_BYTES = 48 * 1024;
const MAX_POST_BODY_BYTES = 64 * 1024;
const MAX_PUT_BODY_BYTES = 1024 * 1024;
const RESERVED_MACROS = new Set(['embedded', 'theme', 'mode']);
/** canopy_mcp.collections.OP_FIELDS: each op and the one field it carries besides `op`. */
const OP_FIELDS = {
  tick: 'ref',
  untick: 'ref',
  pin: 'member',
  unpin: 'member',
  recent: 'member',
  'recent-remove': 'member',
  'recent-clear': null,
  'recent-many': 'members',
};
/** The keys a listed doc carries that a stored one does not; a PUT drops them. */
const LISTED_KEYS = ['source', 'ref', 'rev', 'updated'];

/** The byte-copied canopy error bodies, by error code. */
const errorBodies = new Map(
  readdirSync(join(collectionsFixtures, 'responses'))
    .filter((name) => name.startsWith('error-') && name.endsWith('.json'))
    .map((name) => [
      name.slice('error-'.length, -'.json'.length).replaceAll('-', '_'),
      readFileSync(join(collectionsFixtures, 'responses', name)),
    ])
);
const emptyState = readFileSync(join(collectionsFixtures, 'responses', 'state-empty.json'), 'utf8');

function readJsonDir(dir) {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => ({
      stem: name.slice(0, -'.json'.length),
      doc: JSON.parse(readFileSync(join(dir, name), 'utf8')),
    }));
}

/** Facility collections (id = file stem), shared read-only by every user. */
const facilityDocs = readJsonDir(join(collectionsFixtures, 'valid', 'facility')).map(
  ({ stem, doc }) => ({ ...doc, id: stem })
);
/** The personal seed every reset copies. */
const personalSeed = readJsonDir(join(collectionsFixtures, 'valid', 'personal')).map(
  ({ doc }) => doc
);

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

/** Every write mints a fresh rev, even for bytes written before. */
let writeSeq = 0;
function freshRev(doc) {
  writeSeq += 1;
  return sha256(`${writeSeq}\0${JSON.stringify(doc)}`).slice(0, 16);
}

/** facility id -> rev; facility docs never change. */
const facilityRevs = new Map(
  facilityDocs.map((doc) => [doc.id, sha256(JSON.stringify(doc)).slice(0, 16)])
);

/**
 * e2e user -> {mode, personal: Map<id, {doc, rev}>, state}. Absent = mode
 * 'off', seed data. The rev sits beside the doc, never in it.
 */
const collectionUsers = new Map();

function seededUser(mode) {
  return {
    mode,
    personal: new Map(
      personalSeed.map((doc) => [doc.id, { doc: structuredClone(doc), rev: freshRev(doc) }])
    ),
    state: JSON.parse(emptyState),
  };
}

/** The revs an If-Match header names: comma-separated, each bare, quoted or W/. */
function parseIfMatch(header) {
  const revs = new Set();
  for (let part of header.split(',')) {
    part = part.trim();
    if (part.startsWith('W/')) part = part.slice(2).trim();
    if (part.length >= 2 && part.startsWith('"') && part.endsWith('"')) part = part.slice(1, -1);
    if (part) revs.add(part);
  }
  return revs;
}

function revMatches(rev, ifMatch) {
  return ifMatch.has('*') || ifMatch.has(rev);
}

function userEntry(user) {
  let entry = collectionUsers.get(user);
  if (entry === undefined) {
    entry = seededUser('off');
    collectionUsers.set(user, entry);
  }
  return entry;
}

/** The e2e user of a request: cookie, then header, then 'default'; null when malformed. */
function e2eUserOf(req) {
  let user;
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq !== -1 && part.slice(0, eq).trim() === E2E_USER_COOKIE) user = part.slice(eq + 1).trim();
  }
  user ??= req.headers[E2E_USER_HEADER];
  if (user === undefined) return 'default';
  return typeof user === 'string' && E2E_USER.test(user) ? user : null;
}

/** /config.json for `user`: the fixture bytes, plus `collections` / `workspace` when opted in. */
function configFor(user) {
  const entry = collectionUsers.get(user);
  const withCollections =
    entry === undefined || entry.mode === 'off'
      ? config
      : JSON.stringify({ ...JSON.parse(config), collections: { path: 'collections' } });
  return advertiseWorkspace(withCollections, workspaceHubs.has(user));
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function encodeRfc3986(text) {
  return encodeURIComponent(text).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function byCodePoint(a, b) {
  const ia = a[Symbol.iterator]();
  const ib = b[Symbol.iterator]();
  for (;;) {
    const ca = ia.next();
    const cb = ib.next();
    if (ca.done || cb.done) return (ca.done ? 0 : 1) - (cb.done ? 0 : 1);
    const diff = ca.value.codePointAt(0) - cb.value.codePointAt(0);
    if (diff !== 0) return diff;
  }
}

/**
 * A state-op member, persisted fields only, or null when it breaks the member
 * rules (no slot: canopy's state members are personal members without one).
 * A port of src/workspace/collections.ts checkMember, held to the same vectors.
 */
function checkStateMember(raw) {
  if (!isPlainObject(raw)) return null;
  const isScreen = Object.hasOwn(raw, 'screen');
  if (isScreen === Object.hasOwn(raw, 'tool')) return null;
  const allowed = isScreen ? ['screen', 'macros', 'name'] : ['tool', 'query', 'name'];
  if (Object.keys(raw).some((key) => !allowed.includes(key))) return null;
  if (Object.hasOwn(raw, 'name') && typeof raw.name !== 'string') return null;
  if (isScreen) {
    if (typeof raw.screen !== 'string' || raw.screen === '') return null;
    const member = { screen: raw.screen };
    if (Object.hasOwn(raw, 'macros')) {
      if (!isPlainObject(raw.macros)) return null;
      if (Object.values(raw.macros).some((v) => typeof v !== 'string')) return null;
      member.macros = { ...raw.macros };
    }
    if (raw.name !== undefined) member.name = raw.name;
    return memberKeyOf(member) === null ? null : member;
  }
  if (typeof raw.tool !== 'string' || raw.tool === '') return null;
  const member = { tool: raw.tool };
  if (Object.hasOwn(raw, 'query')) {
    if (typeof raw.query !== 'string') return null;
    member.query = raw.query;
  }
  if (raw.name !== undefined) member.name = raw.name;
  return member;
}

/** memberKey(member) of src/workspace/collections.ts; null for a member with none. */
function memberKeyOf(member) {
  if ('tool' in member) {
    return member.query === undefined
      ? `tool:${member.tool}`
      : `tool:${member.tool}?${member.query}`;
  }
  let query = '';
  try {
    query = Object.keys(member.macros ?? {})
      .sort(byCodePoint)
      .filter((name) => !RESERVED_MACROS.has(name) && !name.startsWith('_canopy'))
      .map((name) => `${encodeRfc3986(name)}=${encodeRfc3986(member.macros[name])}`)
      .join('&');
  } catch {
    return null;
  }
  return query ? `screen:${member.screen}?${query}` : `screen:${member.screen}`;
}

function byNameThenId(a, b) {
  const an = a.name.toLowerCase();
  const bn = b.name.toLowerCase();
  if (an !== bn) return an < bn ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function listed(source, doc, rev) {
  const { id, ...rest } = doc;
  return { source, ref: `${source}:${id}`, rev, id, ...rest };
}

function collectionList(entry) {
  const facility = facilityDocs
    .map((doc) => {
      if (entry.mode === 'default') return doc;
      const { default: _default, ...rest } = doc;
      return rest;
    })
    .sort(byNameThenId)
    .map((doc) => listed('facility', doc, facilityRevs.get(doc.id)));
  const personal = [...entry.personal.values()]
    .sort((a, b) => byNameThenId(a.doc, b.doc))
    .map(({ doc, rev }) => listed('personal', doc, rev));
  return [...facility, ...personal];
}

/** A ref naming a collection `entry` can currently see. */
function refIsCurrent(entry, ref) {
  if (ref.startsWith('facility:')) return facilityDocs.some((d) => `facility:${d.id}` === ref);
  return ref.startsWith('personal:') && entry.personal.has(ref.slice('personal:'.length));
}

/**
 * Apply one state op to `entry.state`; returns null on success or an error
 * code. Every op is idempotent, as canopy's apply_op.
 */
function applyStateOp(entry, op) {
  const state = entry.state;
  if (op.op === 'tick' || op.op === 'untick') {
    const into = op.op === 'tick' ? 'ticked' : 'unticked';
    const from = op.op === 'tick' ? 'unticked' : 'ticked';
    if (!state[into].includes(op.ref)) {
      if (state[into].length >= MAX_REFS) {
        state[into] = state[into].filter((ref) => refIsCurrent(entry, ref));
        if (state[into].length >= MAX_REFS) return 'selection_full';
      }
      state[into].push(op.ref);
    }
    state[from] = state[from].filter((ref) => ref !== op.ref);
    return null;
  }
  if (op.op === 'recent-clear') {
    state.recent = [];
    return null;
  }
  if (op.op === 'recent-many') {
    const keys = new Set(op.members.map(memberKeyOf));
    const others = state.recent.filter((m) => !keys.has(memberKeyOf(m)));
    state.recent = [...op.members, ...others].slice(0, MAX_RECENT);
    return null;
  }
  const key = memberKeyOf(op.member);
  if (op.op === 'recent-remove') {
    state.recent = state.recent.filter((m) => memberKeyOf(m) !== key);
    return null;
  }
  if (op.op === 'pin') {
    if (state.pinned.some((m) => memberKeyOf(m) === key)) return null;
    if (state.pinned.length >= MAX_PINNED) return 'pinned_full';
    state.pinned.push(op.member);
    return null;
  }
  if (op.op === 'unpin') {
    state.pinned = state.pinned.filter((m) => memberKeyOf(m) !== key);
    return null;
  }
  state.recent = [op.member, ...state.recent.filter((m) => memberKeyOf(m) !== key)].slice(
    0,
    MAX_RECENT
  );
  return null;
}

/**
 * One state op from a parsed body (its shape read from OP_FIELDS), or
 * {invalid: detail} when it breaks one; detail undefined = the unknown-op copy.
 */
function parseStateOp(body) {
  if (!isPlainObject(body)) return { invalid: 'an op must be an object' };
  if (typeof body.op !== 'string' || !Object.hasOwn(OP_FIELDS, body.op)) {
    return { invalid: undefined };
  }
  const name = body.op;
  const field = OP_FIELDS[name];
  const expected = field === null ? ['op'] : ['op', field].sort();
  if (Object.keys(body).sort().join(',') !== expected.join(',')) {
    return { invalid: `a ${name} op is exactly ${field === null ? '{op}' : `{op, ${field}}`}` };
  }
  if (field === null) return { op: name };
  if (field === 'ref') {
    const match = typeof body.ref === 'string' && /^(facility|personal):(.*)$/.exec(body.ref);
    return match && COLLECTION_ID.test(match[2])
      ? { op: name, ref: body.ref }
      : { invalid: `invalid ref: ${JSON.stringify(body.ref)}` };
  }
  if (field === 'members') {
    if (!Array.isArray(body.members)) return { invalid: 'members must be an array' };
    if (body.members.length > MAX_RECENT) {
      return {
        invalid: `members holds ${body.members.length}, at most ${MAX_RECENT} (MAX_RECENT)`,
      };
    }
    const members = [];
    const keys = new Set();
    for (const [index, raw] of body.members.entries()) {
      const member = checkStateMember(raw);
      if (member === null) return { invalid: `members[${index}] breaks the member rules` };
      const key = memberKeyOf(member);
      if (!keys.has(key)) {
        keys.add(key);
        members.push(member);
      }
    }
    return { op: name, members };
  }
  const member = checkStateMember(body.member);
  return member === null ? { invalid: 'member breaks the member rules' } : { op: name, member };
}

/** A personal collection body's first broken rule, or null (a light cut of canopy's checks). */
function collectionProblem(body, id) {
  if (!isPlainObject(body)) return 'a collection must be an object';
  if (Object.hasOwn(body, 'id') && body.id !== id) return `id '${body.id}' is not '${id}'`;
  if (typeof body.name !== 'string' || body.name.trim() === '') return 'name must be text';
  if (!Array.isArray(body.members)) return 'members must be a list';
  return null;
}

/** POST /__collections-reset?mode=off|on|default: re-seed `user`'s collections. */
function resetCollections(req, res, url, user) {
  if (req.method !== 'POST') return send(res, 405, 'POST only', 'text/plain; charset=utf-8');
  const mode = url.searchParams.get('mode') ?? 'on';
  if (!COLLECTION_MODES.has(mode)) return send(res, 400, 'bad mode', 'text/plain; charset=utf-8');
  // 'default' serves every spec that never opted in: it keeps today's tree.
  if (user === 'default' && mode !== 'off') {
    return send(res, 400, "the 'default' user stays off", 'text/plain; charset=utf-8');
  }
  collectionUsers.set(user, seededUser(mode));
  return send(res, 200, JSON.stringify({ user, mode }), TYPES['.json']);
}

async function handleCollections(req, res, rest, user) {
  const json = (status, body, headers = {}) => {
    res.writeHead(status, {
      'Content-Type': TYPES['.json'],
      'Cache-Control': 'no-cache',
      ...headers,
    });
    res.end(
      body === undefined
        ? ''
        : typeof body === 'string' || Buffer.isBuffer(body)
          ? body
          : JSON.stringify(body)
    );
  };
  // The byte-copied body when it says the same thing; else {code, detail}.
  const error = (status, code, detail, headers) => {
    const copy = errorBodies.get(code);
    const verbatim = copy && (detail === undefined || JSON.parse(copy).detail === detail);
    return json(status, verbatim ? copy : { code, detail: detail ?? code }, headers);
  };
  const methods =
    rest === null ? 'GET, HEAD' : rest === 'state' ? 'GET, HEAD, POST' : 'GET, HEAD, PUT, DELETE';
  const method = req.method === 'HEAD' ? 'GET' : req.method;
  if (!methods.split(', ').includes(req.method ?? '')) {
    return error(405, 'method_not_allowed', `allowed: ${methods}`, { Allow: methods });
  }
  const entry = userEntry(user);
  if (method !== 'GET') {
    const site = req.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin' && site !== 'none') {
      return error(403, 'cross_site');
    }
  }
  const isJson = () => String(req.headers['content-type'] ?? '').startsWith('application/json');
  // ETag = the quoted sha256 hex of the body; a bodiless 304 on a match (weak or *).
  const conditional = (body) => {
    const text = JSON.stringify(body);
    const etag = `"${sha256(text)}"`;
    const candidates = String(req.headers['if-none-match'] ?? '')
      .split(',')
      .map((part) => part.trim().replace(/^W\//, ''));
    if (candidates.includes(etag) || candidates.includes('*')) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' });
      return res.end();
    }
    return json(200, text, { ETag: etag });
  };
  if (rest === null) return conditional({ collections: collectionList(entry) });
  if (rest === 'state') {
    if (method === 'GET') return conditional(entry.state);
    if (!isJson()) return error(415, 'unsupported_media_type');
    const bytes = await readBytes(req);
    if (bytes.length > MAX_POST_BODY_BYTES) {
      return error(413, 'too_large', `the body exceeds ${MAX_POST_BODY_BYTES} bytes`);
    }
    let body;
    try {
      body = JSON.parse(bytes.toString('utf8'));
    } catch {
      return error(400, 'invalid_json');
    }
    const [cap, capName] =
      isPlainObject(body) && body.op === 'recent-many'
        ? [MAX_RECENT_MANY_OP_BYTES, 'MAX_RECENT_MANY_OP_BYTES']
        : [MAX_STATE_OP_BYTES, 'MAX_STATE_OP_BYTES'];
    const size = Buffer.byteLength(JSON.stringify(body));
    if (size > cap) {
      return error(413, 'too_large', `the op is ${size} bytes, at most ${cap} (${capName})`);
    }
    const op = parseStateOp(body);
    if ('invalid' in op) return error(400, 'invalid_op', op.invalid);
    const failed = applyStateOp(entry, op);
    if (failed === 'pinned_full') return error(409, 'pinned_full');
    if (failed === 'selection_full') {
      const list = op.op === 'tick' ? 'ticked' : 'unticked';
      return error(409, 'selection_full', `${list} holds ${MAX_REFS} refs (MAX_REFS)`);
    }
    return json(200, entry.state);
  }
  let id;
  try {
    id = decodeURIComponent(rest);
  } catch {
    id = rest;
  }
  if (!COLLECTION_ID.test(id)) return error(400, 'invalid_id', `invalid collection id: '${id}'`);
  const header = req.headers['if-match'];
  const ifMatch = header === undefined ? null : parseIfMatch(String(header));
  const stored = entry.personal.get(id);
  if (method === 'GET') {
    return stored
      ? json(200, listed('personal', stored.doc, stored.rev))
      : error(404, 'not_found', `no personal collection '${id}'`);
  }
  if (method === 'DELETE') {
    if (!stored) return error(404, 'not_found', `no personal collection '${id}'`);
    if (ifMatch !== null && !revMatches(stored.rev, ifMatch)) {
      return error(412, 'stale', `collection '${id}' has changed`);
    }
    entry.personal.delete(id);
    const ref = `personal:${id}`;
    entry.state.ticked = entry.state.ticked.filter((r) => r !== ref);
    entry.state.unticked = entry.state.unticked.filter((r) => r !== ref);
    return json(204);
  }
  // A PUT says what it expects: create (If-None-Match: *) or replace the rev it saw (If-Match).
  const createOnly = ifMatch === null && String(req.headers['if-none-match'] ?? '').trim() === '*';
  if (ifMatch === null && !createOnly) return error(428, 'precondition_required');
  if (!isJson()) return error(415, 'unsupported_media_type');
  const bytes = await readBytes(req);
  if (bytes.length > MAX_PUT_BODY_BYTES) return error(413, 'too_large');
  let body;
  try {
    body = JSON.parse(bytes.toString('utf8'));
  } catch {
    return error(400, 'invalid_json');
  }
  if (isPlainObject(body)) {
    // An echoed listed doc: its listed keys are dropped, never validated or stored.
    body = Object.fromEntries(Object.entries(body).filter(([key]) => !LISTED_KEYS.includes(key)));
    if (Object.hasOwn(body, 'default')) return error(400, 'invalid_collection');
  }
  const problem = collectionProblem(body, id);
  if (problem !== null) return error(400, 'invalid_collection', problem);
  if (createOnly && stored) return error(412, 'exists', `collection '${id}' exists`);
  if (ifMatch !== null) {
    if (!stored) return error(412, 'gone', `collection '${id}' is gone`);
    if (!revMatches(stored.rev, ifMatch)) {
      return error(412, 'stale', `collection '${id}' has changed`);
    }
  }
  const doc = { ...body, id, updated: new Date().toISOString() };
  const rev = freshRev(doc);
  entry.personal.set(id, { doc, rev });
  return json(stored ? 200 : 201, listed('personal', doc, rev));
}

async function handleViews(req, res, rest) {
  const json = (status, body) =>
    send(res, status, body === undefined ? '' : JSON.stringify(body), TYPES['.json']);
  if (rest === '') {
    if (req.method !== 'GET')
      return json(405, { code: 'method_not_allowed', detail: 'allowed: GET, HEAD' });
    const list = [...views.values()].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    );
    return json(200, { views: list });
  }
  const id = decodeURIComponent(rest);
  if (!VIEW_ID.test(id)) return json(400, { code: 'invalid_id', detail: 'invalid view id' });
  if (req.method === 'GET')
    return views.has(id)
      ? json(200, views.get(id))
      : json(404, { code: 'not_found', detail: `no view '${id}'` });
  if (req.method === 'DELETE') {
    if (!views.delete(id)) return json(404, { code: 'not_found', detail: `no view '${id}'` });
    return send(res, 204, '', TYPES['.json']);
  }
  if (req.method !== 'PUT')
    return json(405, { code: 'method_not_allowed', detail: 'allowed: GET, HEAD, PUT, DELETE' });
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) {
    return json(415, {
      code: 'unsupported_media_type',
      detail: 'Content-Type must be application/json',
    });
  }
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return json(400, { code: 'invalid_json', detail: 'the body is not valid JSON' });
  }
  if (
    typeof body !== 'object' ||
    body === null ||
    Array.isArray(body) ||
    Object.keys(body).some((key) => !VIEW_KEYS.has(key)) ||
    typeof body.name !== 'string' ||
    body.name.trim() === '' ||
    typeof body.query !== 'string'
  ) {
    return json(400, { code: 'invalid_view', detail: 'expected {name, query, kind?}' });
  }
  if (body.kind !== undefined && (typeof body.kind !== 'string' || !VIEW_KIND.test(body.kind))) {
    return json(400, { code: 'invalid_view', detail: 'invalid kind' });
  }
  const kind = body.kind ?? 'trace';
  const existing = views.get(id);
  if (existing && existing.kind !== kind) {
    return json(409, { code: 'kind_conflict', detail: `view '${id}' is a ${existing.kind} view` });
  }
  const created = existing === undefined;
  const view = {
    id,
    name: body.name.trim(),
    kind,
    query: body.query,
    updated: new Date().toISOString(),
  };
  views.set(id, view);
  return json(created ? 201 : 200, view);
}

/**
 * The stub page's on-request canopy:trace-open (a tool frame asking the
 * workspace to open a tool): a script asset, not inline, so the stub keeps
 * running under production's script-src 'self'. Same origin and target as
 * stub.js's own posts.
 */
const TRACE_OPEN_HOOK = `window.__postTraceOpen = function (tool, query) {
  window.parent.postMessage(
    { type: 'canopy:trace-open', tool: tool, query: query },
    window.location.origin
  );
};
`;

/** Probe id -> number of Mole archiver requests seen. */
const moleCounts = new Map();
const PROBE_ID = /^[A-Za-z0-9_-]{1,64}$/;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

/** index.html with exactly one <base href="<prefix>/">, first in <head> (static.inject_base). */
export function injectBase(indexHtml, basePrefix) {
  const tag = `<base href="${basePrefix}/">`;
  const stripped = indexHtml.replace(/<base\b[^>]*>/gi, '');
  const head = /<head\b[^>]*>/i.exec(stripped);
  if (head === null) return tag + stripped;
  const end = head.index + head[0].length;
  return stripped.slice(0, end) + tag + stripped.slice(end);
}

/** A regular file under `root` for a URL-relative path, or null (no traversal). */
function fileUnder(root, relpath) {
  let decoded;
  try {
    decoded = decodeURIComponent(relpath);
  } catch {
    return null;
  }
  const target = resolve(root, decoded);
  if (target !== root && !target.startsWith(root + sep)) return null;
  try {
    return statSync(target).isFile() ? target : null;
  } catch {
    return null;
  }
}

function send(res, status, body, type, cache = 'no-cache') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': cache });
  res.end(body);
}

function sendFile(res, path, cache) {
  send(res, 200, readFileSync(path), TYPES[extname(path)] ?? 'application/octet-stream', cache);
}

function notFound(res) {
  send(res, 404, 'not found', 'text/plain; charset=utf-8');
}

/** The probe id of a request, 'default' when absent; null when malformed. */
function probeOf(url) {
  const probe = url.searchParams.get('probe') ?? 'default';
  return PROBE_ID.test(probe) ? probe : null;
}

/** The top page for __host.html: tabs stored first, then the viewer iframed. */
function hostPage(probe) {
  // The workspace keeps its tabs under a key scoped to the mount path
  // (src/storageScope.ts), `/` at the origin root.
  const tabsKey = `canopy-viewer:tabs:${prefix || '/'}`;
  const tabs = JSON.stringify({
    keys: ['@trace'],
    active: '@trace',
    instances: { '@trace': { query: `pv=PROBE:${probe}&range=-1h` } },
  });
  // `probe` matches PROBE_ID, so it is inert inside both the script and HTML.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<link rel="icon" href="data:,">
<title>Trace host ${probe}</title>
<style>body{margin:0}#viewer{width:1200px;height:800px;border:0;display:block}#toggle-trace{position:fixed;right:0;bottom:0}</style>
</head>
<body>
<button id="toggle-trace" type="button">toggle trace</button>
<script>
sessionStorage.setItem(${JSON.stringify(tabsKey)}, ${JSON.stringify(tabs)});
const frame = document.createElement('iframe');
frame.id = 'viewer';
frame.title = 'viewer';
frame.src = ${JSON.stringify(`${prefix}/embed/@trace`)};
document.body.prepend(frame);
window.__setTraceHidden = (hidden) => {
  frame.style.display = hidden ? 'none' : 'block';
  document.body.dataset.hidden = hidden ? 'true' : 'false';
};
document.getElementById('toggle-trace').addEventListener('click', () =>
  window.__setTraceHidden(frame.style.display !== 'none')
);
</script>
</body>
</html>
`;
}

// --- Workspace -----------------------------------------------------------------

/** e2e user -> its hub; absent = the opt-in off. */
const workspaceHubs = new Map();
const WORKSPACE_MODES = new Set(['on', 'off']);
const SSE_PING_MS = 15_000;
const WORKSPACE_TICK_MS = 100;
const MAX_ENQUEUE_BODY_BYTES = 256 * 1024;

// Deadlines, expiry and window_gone are applied lazily by the hub; the tick
// lets a stream receive a batch queued behind one that lapsed.
setInterval(() => {
  for (const hub of workspaceHubs.values()) hub.tick();
}, WORKSPACE_TICK_MS).unref();

/** The document's collections.shown and sidebar, from the user's collections store. */
function workspaceContext(user) {
  const entry = collectionUsers.get(user);
  if (entry === undefined || entry.mode === 'off') return {};
  const ticked = new Set(entry.state.ticked);
  const unticked = new Set(entry.state.unticked);
  const shown = collectionList(entry)
    .filter((c) => (c.default === true || ticked.has(c.ref)) && !unticked.has(c.ref))
    .map((c) => c.ref);
  // Sidebar members in open / open_tool argument form: a screen member's ref, never a name.
  const argForm = ({ screen, macros, tool, query }) =>
    screen !== undefined
      ? { ref: screen, ...(macros ? { macros } : {}) }
      : { tool, ...(query !== undefined ? { query } : {}) };
  return {
    collections: { shown },
    sidebar: { pinned: entry.state.pinned.map(argForm), recent: entry.state.recent.map(argForm) },
  };
}

/** POST /__workspace-reset?mode=on|off: a fresh hub (on) or none (off) for `user`. */
function resetWorkspace(req, res, url, user) {
  if (req.method !== 'POST') return send(res, 405, 'POST only', 'text/plain; charset=utf-8');
  const mode = url.searchParams.get('mode') ?? 'on';
  if (!WORKSPACE_MODES.has(mode)) return send(res, 400, 'bad mode', 'text/plain; charset=utf-8');
  if (user === 'default' && mode !== 'off') {
    return send(res, 400, "the 'default' user stays off", 'text/plain; charset=utf-8');
  }
  workspaceHubs.get(user)?.close();
  if (mode === 'off') {
    workspaceHubs.delete(user);
    return send(res, 200, JSON.stringify({ user, mode, epoch: null }), TYPES['.json']);
  }
  const hub = new WorkspaceHub({ context: () => workspaceContext(user) });
  workspaceHubs.set(user, hub);
  return send(res, 200, JSON.stringify({ user, mode, epoch: hub.epoch }), TYPES['.json']);
}

/** POST /__workspace-enqueue: set_workspace, then wait up to wait_s for the batch. */
async function enqueueWorkspace(req, res, hub) {
  if (req.method !== 'POST') return send(res, 405, 'POST only', 'text/plain; charset=utf-8');
  const bytes = await readBytes(req);
  if (bytes.length > MAX_ENQUEUE_BODY_BYTES) return send(res, 413, 'too large', 'text/plain');
  let call;
  try {
    call = JSON.parse(bytes.toString('utf8'));
  } catch {
    return send(res, 400, 'body is not JSON', 'text/plain; charset=utf-8');
  }
  if (!isPlainObject(call)) return send(res, 400, 'body is not an object', 'text/plain');
  const waitS = Math.min(Math.max(Number(call.wait_s ?? 0) || 0, 0), 10);
  let answer = hub.setWorkspace(call);
  const until = Date.now() + waitS * 1000;
  while (answer.batch.status === 'pending' && Date.now() < until) {
    await new Promise((wake) => setTimeout(wake, 50));
    answer = hub.setWorkspace({ commands: call.commands, batch_id: answer.batch.id });
  }
  return send(res, 200, JSON.stringify(answer), TYPES['.json']);
}

/** <prefix>/workspace[/...]: the hub's HTTP surface, an SSE stream for events. */
async function handleWorkspace(req, res, url, rest, hub) {
  const bytes = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBytes(req);
  const queued = [];
  let live = false;
  const sink = {
    send(event) {
      if (live) res.write(sseFrame(event));
      else queued.push(event);
    },
    end() {
      if (live) res.end();
      else queued.push(null);
    },
  };
  const answer = routeWorkspace(hub ?? null, {
    method: req.method,
    path: `${rest}${url.search}`,
    headers: req.headers,
    body: bytes,
    sink,
  });
  if (answer.stream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    live = true;
    for (const event of queued) {
      if (event === null) return res.end();
      res.write(sseFrame(event));
    }
    const ping = setInterval(() => res.write(': ping\n\n'), SSE_PING_MS);
    res.on('close', () => {
      clearInterval(ping);
      hub.disconnect(answer.stream);
    });
    return;
  }
  if (answer.body === undefined) {
    res.writeHead(answer.status, { 'Cache-Control': 'no-cache' });
    return res.end();
  }
  return send(res, answer.status, JSON.stringify(answer.body), TYPES['.json']);
}

function handle(req, res) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const { pathname } = url;
  if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) return notFound(res);
  const path = pathname.slice(prefix.length) || '/';

  if (path === '/' || path.startsWith('/s/') || path.startsWith('/embed/')) {
    const page = join(dist, 'index.html');
    let html;
    try {
      html = readFileSync(page, 'utf8');
    } catch {
      return send(res, 503, `viewer not built: ${page} missing`, 'text/plain; charset=utf-8');
    }
    return send(res, 200, injectBase(html, prefix), TYPES['.html']);
  }
  if (path.startsWith('/assets/')) {
    const target = fileUnder(join(dist, 'assets'), path.slice('/assets/'.length));
    return target ? sendFile(res, target, 'public, max-age=31536000, immutable') : notFound(res);
  }
  if (
    path === '/config.json' ||
    path === '/collections' ||
    path === '/collections-state' ||
    path.startsWith('/collections/') ||
    path === '/__collections-reset'
  ) {
    const user = e2eUserOf(req);
    if (user === null) return send(res, 400, 'bad e2e user', 'text/plain; charset=utf-8');
    if (path === '/config.json') return send(res, 200, configFor(user), TYPES['.json']);
    if (path === '/__collections-reset') return resetCollections(req, res, url, user);
    const rest =
      path === '/collections'
        ? null
        : path === '/collections-state'
          ? 'state'
          : path.slice('/collections/'.length);
    void handleCollections(req, res, rest, user);
    return;
  }
  if (
    path === '/workspace' ||
    path.startsWith('/workspace/') ||
    path === '/__workspace' ||
    path === '/__workspace-reset' ||
    path === '/__workspace-enqueue'
  ) {
    const user = e2eUserOf(req);
    if (user === null) return send(res, 400, 'bad e2e user', 'text/plain; charset=utf-8');
    if (path === '/__workspace-reset') return resetWorkspace(req, res, url, user);
    const hub = workspaceHubs.get(user);
    if (path === '/__workspace' || path === '/__workspace-enqueue') {
      if (hub === undefined) return notFound(res);
      if (path === '/__workspace-enqueue') {
        void enqueueWorkspace(req, res, hub);
        return;
      }
      if (req.method !== 'GET') return send(res, 405, 'GET only', 'text/plain; charset=utf-8');
      return send(res, 200, JSON.stringify(hub.getWorkspace()), TYPES['.json']);
    }
    void handleWorkspace(req, res, url, path.slice('/workspace'.length).replace(/^\//, ''), hub);
    return;
  }
  if (path.startsWith('/drafts/')) {
    const target = fileUnder(drafts, path.slice('/drafts/'.length));
    return target ? sendFile(res, target, 'no-cache') : notFound(res);
  }
  if (path === '/health') return send(res, 200, '{"status":"ok"}', TYPES['.json']);
  if (path === '/views' || path.startsWith('/views/')) {
    void handleViews(req, res, path.slice('/views'.length).replace(/^\//, ''));
    return;
  }
  if (path === '/trace/' || path === '/trace/correlation.html' || path === '/trace/waveform.html') {
    const html = readFileSync(join(traceStub, 'index.html'), 'utf8');
    return send(res, 200, injectBase(html, `${prefix}/trace`), TYPES['.html']);
  }
  if (path === '/trace/assets/trace-open.js') {
    return send(res, 200, TRACE_OPEN_HOOK, TYPES['.js']);
  }
  if (path.startsWith('/trace/assets/')) {
    const target = fileUnder(join(traceStub, 'assets'), path.slice('/trace/assets/'.length));
    return target ? sendFile(res, target, 'no-cache') : notFound(res);
  }
  if (path === '/mole/v1/archivers') {
    const probe = probeOf(url);
    if (probe === null) return send(res, 400, 'bad probe', 'text/plain; charset=utf-8');
    moleCounts.set(probe, (moleCounts.get(probe) ?? 0) + 1);
    return send(res, 200, '{"archivers":[]}', TYPES['.json']);
  }
  if (path === '/__mole-count') {
    const probe = probeOf(url);
    if (probe === null) return send(res, 400, 'bad probe', 'text/plain; charset=utf-8');
    const body = JSON.stringify({ probe, count: moleCounts.get(probe) ?? 0 });
    return send(res, 200, body, TYPES['.json']);
  }
  if (path === '/__host.html') {
    const probe = probeOf(url);
    if (probe === null) return send(res, 400, 'bad probe', 'text/plain; charset=utf-8');
    return send(res, 200, hostPage(probe), TYPES['.html']);
  }
  return notFound(res);
}

createServer(handle).listen(port, '127.0.0.1', () => {
  console.log(`viewer e2e server: http://127.0.0.1:${port}${prefix}/ (dist ${dist})`);
});
