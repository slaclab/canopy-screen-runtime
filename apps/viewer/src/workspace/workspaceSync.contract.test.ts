// Drives the real window sync (workspaceSync.ts) against the stub hub
// (e2e/workspaceHub.mjs) through a fetch and event-stream adapter wired to its
// routeWorkspace, with fake timers driving both the client's clock and the
// hub's. Each scenario below is the window-side half of the fixture scenario
// of the same name (e2e/fixtures/workspace/scenarios/): the windows decide by
// themselves when to claim, report and reconnect, and the hub must end up
// where the fixture says.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceAdvertisement } from '../config.js';
import { parseWorkspace, WORKSPACE_PROTOCOL } from '../config.js';
import { renderHook } from '@testing-library/react';
import { useWorkspaceSync } from './useWorkspaceSync.js';
import type { WorkspaceState } from './workspaceState.js';
import {
  BACKOFF_MS,
  createWorkspaceSync,
  REPORT_MAX_WAIT_MS,
  REPORT_QUIET_MS,
  type BatchEvent,
  type EventStream,
  type SyncDocument,
  type SyncWindow,
  type WorkspaceSync,
} from './workspaceSync.js';

const require = createRequire(import.meta.url);
const ROOT = dirname(require.resolve('../../e2e/fixtures/workspace/state.sample.json'));
const STUB_HUB = pathToFileURL(require.resolve('../../e2e/workspaceHub.mjs')).href;

type Answer = { status: number; body?: unknown; stream?: unknown };
type Sink = { send(event: { event: string; data?: unknown }): void; end(): void };
interface Hub {
  getWorkspace(): Record<string, unknown> & { results: Record<string, unknown>[] };
  setWorkspace(args: { commands: unknown[]; batch_id?: string }): {
    batch: { id: string | null; status: string; reason?: string; results: unknown[] };
  };
  disconnect(stream: unknown): void;
  close(): void;
}
interface StubModule {
  WorkspaceHub: new (options: { epoch?: string; now?: () => number }) => Hub;
  routeWorkspace(
    hub: Hub | null,
    request: {
      method: string;
      path: string;
      headers: Record<string, string>;
      body?: string;
      sink?: Sink;
    }
  ): Answer;
  emptyState(): WorkspaceState;
  ADVERTISEMENT: { path: string; protocol: number };
}

let stub: StubModule;
const SAMPLE = (
  JSON.parse(readFileSync(join(ROOT, 'state.sample.json'), 'utf8')) as { state: WorkspaceState }
).state;

beforeAll(async () => {
  stub = (await import(/* @vite-ignore */ STUB_HUB)) as StubModule;
});

const BASE = 'http://front.test/app/';

// --- canopy_mcp: the hub behind its HTTP surface ----------------------------------

interface Call {
  method: string;
  path: string;
  status: number | 'down';
  body?: Record<string, unknown>;
  window?: string;
}

class Front {
  hub: Hub;
  down = false;
  advertised = true;
  epochN = 1;
  calls: Call[] = [];
  configReads = 0;

  constructor() {
    this.hub = this.mint();
  }

  mint(): Hub {
    return new stub.WorkspaceHub({ epoch: `e${this.epochN}`, now: () => Date.now() });
  }

  /** canopy_mcp restarts: a fresh hub, every old stream ended. */
  restart(): void {
    const old = this.hub;
    this.epochN += 1;
    this.hub = this.mint();
    old.close();
  }

  route(method: string, path: string, body?: string, sink?: Sink): Answer {
    return stub.routeWorkspace(this.hub, {
      method,
      path,
      headers: { 'sec-fetch-site': 'same-origin' },
      body,
      sink,
    });
  }

  rel(url: string): string {
    const u = new URL(url);
    const prefix = new URL(`${stub.ADVERTISEMENT.path}/`, BASE).pathname;
    expect(u.pathname.startsWith(prefix), `${url} is under the advertised path`).toBe(true);
    return u.pathname.slice(prefix.length) + u.search;
  }

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    await Promise.resolve();
    if (url === new URL('config.json', BASE).toString()) {
      this.configReads += 1;
      if (this.down) throw new TypeError('Failed to fetch');
      const config: Record<string, unknown> = { pvMode: 'mock' };
      if (this.advertised) config.workspace = stub.ADVERTISEMENT;
      return response(200, config);
    }
    const method = init?.method ?? 'GET';
    const path = this.rel(url);
    const text = typeof init?.body === 'string' ? init.body : undefined;
    const body = text === undefined ? undefined : (JSON.parse(text) as Record<string, unknown>);
    const who =
      (body?.windowId as string | undefined) ??
      new URL(url).searchParams.get('window') ??
      /active\/([^/]+)\/result/.exec(path)?.[1];
    if (this.down) {
      this.calls.push({ method, path, status: 'down', body, window: who ?? undefined });
      throw new TypeError('Failed to fetch');
    }
    const answer = this.route(method, path, text);
    this.calls.push({ method, path, status: answer.status, body, window: who ?? undefined });
    return response(answer.status, answer.body);
  };

  /** Workspace calls (config.json excluded) by one window. */
  by(windowId: string): Call[] {
    return this.calls.filter((c) => c.window === windowId);
  }

  doc(): ReturnType<Hub['getWorkspace']> {
    return this.hub.getWorkspace();
  }

  advertisement = async (): Promise<WorkspaceAdvertisement> => {
    try {
      const raw = (await (await this.fetch(new URL('config.json', BASE))).json()) as Record<
        string,
        unknown
      >;
      const workspace = parseWorkspace(raw.workspace);
      return workspace ? { status: 'advertised', workspace } : { status: 'absent' };
    } catch {
      return { status: 'unreachable' };
    }
  };
}

function response(status: number, body?: unknown): Response {
  const text = body === undefined ? '' : JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => JSON.parse(text),
    text: async () => text,
  } as unknown as Response;
}

/** The browser's EventSource over the hub's events route. */
class FakeStream implements EventStream {
  onerror: ((event: Event) => void) | null = null;
  readyState = 0;
  closed = false;
  /** Events the window never hears (a lost `inactive`). */
  deaf = false;
  /** An end the window has not seen yet (deaf). */
  held = false;
  hubStream: unknown = null;
  status: number | null = null;
  private listeners = new Map<string, ((event: MessageEvent) => void)[]>();

  readonly url: string;
  readonly front: Front;

  constructor(url: string, front: Front) {
    this.url = url;
    this.front = front;
    queueMicrotask(() => this.open());
  }

  private open(): void {
    if (this.closed) return;
    const path = this.front.rel(this.url);
    const who = new URL(this.url).searchParams.get('window') ?? undefined;
    if (this.front.down) {
      this.front.calls.push({ method: 'GET', path, status: 'down', window: who });
      this.fail(2);
      return;
    }
    const answer = this.front.route('GET', path, undefined, {
      send: (event) => {
        if (this.closed || this.deaf) return;
        const data = { data: JSON.stringify(event.data ?? {}) } as MessageEvent;
        for (const listener of this.listeners.get(event.event) ?? []) listener(data);
      },
      end: () => {
        if (this.deaf) this.held = true;
        else this.fail(0);
      },
    });
    this.front.calls.push({ method: 'GET', path, status: answer.status, window: who });
    this.status = answer.status;
    if (answer.status !== 200) {
      this.fail(2);
      return;
    }
    this.readyState = 1;
    this.hubStream = answer.stream;
  }

  private fail(readyState: number): void {
    if (this.closed) return;
    this.readyState = readyState;
    this.onerror?.(new Event('error'));
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 2;
    if (this.hubStream) this.front.hub.disconnect(this.hubStream);
  }

  /** A deaf stream's held end reaches the window now. */
  release(): void {
    this.deaf = false;
    if (this.held) this.fail(0);
  }

  /** The connection drops under the window. */
  drop(): void {
    if (this.hubStream) this.front.hub.disconnect(this.hubStream);
    this.hubStream = null;
    this.fail(0);
  }
}

// --- a browser window -------------------------------------------------------------

class FakeDocument extends EventTarget implements SyncDocument {
  visibilityState: DocumentVisibilityState = 'visible';
  focused = false;
  defaultView: unknown = null;
  hasFocus(): boolean {
    return this.focused;
  }
}

class FakeWindow extends EventTarget implements SyncWindow {
  innerWidth = 1280;
  innerHeight = 800;
  top: unknown = this;
  readonly document = new FakeDocument();
  constructor() {
    super();
    this.document.defaultView = this;
  }
}

interface Viewer {
  name: string;
  id: string;
  win: FakeWindow;
  doc: FakeDocument;
  sync: WorkspaceSync;
  streams: FakeStream[];
  batches: BatchEvent[];
  state: WorkspaceState;
  stream(): FakeStream | undefined;
  /** An operator gesture inside the window. */
  click(): void;
}

function viewer(
  front: Front,
  name: string,
  { focused = false, state = SAMPLE, win = new FakeWindow() } = {}
): Viewer {
  const streams: FakeStream[] = [];
  const batches: BatchEvent[] = [];
  win.document.focused = focused;
  const v: Viewer = {
    name,
    id: `w-${name}`,
    win,
    doc: win.document,
    streams,
    batches,
    state,
    sync: undefined as unknown as WorkspaceSync,
    stream: () => streams.at(-1),
    click: () => v.doc.dispatchEvent(new Event('pointerdown')),
  };
  v.sync = createWorkspaceSync({
    workspace: { path: stub.ADVERTISEMENT.path, protocol: WORKSPACE_PROTOCOL },
    getState: () => v.state,
    baseURI: BASE,
    fetch: front.fetch,
    openStream: (url) => {
      const s = new FakeStream(url, front);
      streams.push(s);
      return s;
    },
    win,
    doc: win.document,
    reread: front.advertisement,
    randomId: () => v.id,
    onBatch: (batch) => batches.push(batch),
  });
  return v;
}

/** Let every in-flight request and stream open settle. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await vi.advanceTimersByTimeAsync(0);
}

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await settle();
}

const FOCUS_TRACE = [{ cmd: 'focus', args: { key: '@trace' } }];

let front: Front;
let live: Viewer[] = [];

function open(name: string, options?: Parameters<typeof viewer>[2]): Viewer {
  const v = viewer(front, name, options);
  live.push(v);
  return v;
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  });
  vi.setSystemTime(0);
  front = new Front();
  live = [];
});

afterEach(() => {
  for (const v of live) v.sync.stop();
  vi.useRealTimers();
});

// --- the four gate scenarios ----------------------------------------------------------

describe('workspaceSync: active-switch', () => {
  it('the last-focused window holds the slot; the previous one goes quiet', async () => {
    const a = open('A', { focused: true });
    a.sync.start();
    await settle();
    expect(a.sync.isActive()).toBe(true);
    expect(front.by(a.id)[0]).toMatchObject({ method: 'POST', path: 'claim', status: 200 });
    expect(front.doc()).toMatchObject({ activeWindow: 'w-A', connected: true, shown: true });
    expect(a.stream()?.readyState).toBe(1);

    // B starts unfocused: it claims nothing until the operator acts in it.
    const b = open('B', { state: stub.emptyState() });
    b.sync.start();
    await settle();
    expect(front.by(b.id)).toEqual([]);
    a.doc.focused = false;
    b.doc.focused = true;
    b.click();
    await settle();
    expect(b.sync.isActive()).toBe(true);
    expect(front.doc()).toMatchObject({ activeWindow: 'w-B', connected: true });

    // A got `inactive`: it closes its stream and never reports again.
    expect(a.sync.isActive()).toBe(false);
    expect(a.stream()?.closed).toBe(true);
    const aCalls = front.by(a.id).length;
    a.sync.changed();
    await advance(REPORT_MAX_WAIT_MS * 2);
    expect(front.by(a.id).length).toBe(aCalls);

    // B, believing itself active, does not claim again on its own gestures.
    b.click();
    b.win.dispatchEvent(new Event('focus'));
    await settle();
    expect(front.by(b.id).filter((c) => c.path.startsWith('claim'))).toHaveLength(1);

    // The agent's batch reaches B; B posts its result and reports.
    const queued = front.hub.setWorkspace({
      commands: [{ cmd: 'open_tool', args: { tool: 'trace' } }],
    });
    expect(queued.batch).toMatchObject({ id: 'b-e1-1', status: 'pending' });
    expect(b.batches).toHaveLength(1);
    expect(b.batches[0]).toMatchObject({ batch: 'b-e1-1', window: 'w-B' });
    expect(a.batches).toEqual([]);
    const status = await b.sync.postResult({
      batch: 'b-e1-1',
      results: [{ id: 'c-e1-1', status: 'applied', changed: true, key: '@trace' }],
    });
    expect(status).toBe(204);
    await b.sync.reportNow();
    expect(front.doc()).toMatchObject({
      activeWindow: 'w-B',
      pending: [],
      results: [{ id: 'c-e1-1', status: 'applied', window: 'w-B' }],
    });

    // A gesture in A switches the slot back.
    b.doc.focused = false;
    a.doc.focused = true;
    a.click();
    await settle();
    expect(a.sync.isActive()).toBe(true);
    expect(b.sync.isActive()).toBe(false);
    expect(front.doc()).toMatchObject({ activeWindow: 'w-A', connected: true });
  });
});

describe('workspaceSync: reconnect-reclaim', () => {
  it('re-claims with if_vacant after a canopy_mcp restart, without a gesture', async () => {
    const a = open('A', { focused: true });
    a.sync.start();
    await settle();
    expect(front.doc()).toMatchObject({ epoch: 'e1', activeWindow: 'w-A', connected: true });
    a.doc.focused = false;

    front.restart();
    await settle();
    const reclaim = front.by(a.id).at(-2);
    expect(reclaim).toMatchObject({ method: 'POST', path: 'claim?if_vacant=1', status: 200 });
    expect(front.by(a.id).at(-1)).toMatchObject({ method: 'GET', status: 200 });
    expect(a.sync.isActive()).toBe(true);
    expect(front.doc()).toMatchObject({
      epoch: 'e2',
      activeWindow: 'w-A',
      connected: true,
      seq: a.sync.seq(),
    });
  });

  it('re-claims its own slot after its connection drops', async () => {
    const a = open('A', { focused: true });
    a.sync.start();
    await settle();
    a.stream()?.drop();
    await settle();
    expect(front.by(a.id).filter((c) => c.path === 'claim?if_vacant=1')).toHaveLength(1);
    expect(a.sync.isActive()).toBe(true);
    expect(front.doc()).toMatchObject({ activeWindow: 'w-A', connected: true });
  });

  it('never takes the slot back from a connected window', async () => {
    const a = open('A', { focused: true });
    a.sync.start();
    await settle();
    // A misses its `inactive` (the event is lost with its connection).
    a.stream()!.deaf = true;
    const b = open('B', { state: stub.emptyState() });
    b.sync.start();
    b.doc.focused = true;
    b.click();
    await settle();
    expect(front.doc()).toMatchObject({ activeWindow: 'w-B', connected: true });
    a.stream()!.release();
    await settle();
    const reclaims = front.by(a.id).filter((c) => c.path === 'claim?if_vacant=1');
    expect(reclaims).toEqual([expect.objectContaining({ status: 409 })]);
    expect(a.sync.isActive()).toBe(false);
    expect(front.doc()).toMatchObject({ activeWindow: 'w-B', connected: true });

    // Once it knows it lost, a stream error alone never claims again.
    const count = front.by(a.id).length;
    await advance(60_000);
    expect(front.by(a.id).length).toBe(count);
  });

  it('other windows reconnect passively: a window that never held the slot stays quiet', async () => {
    const a = open('A', { focused: true });
    const b = open('B');
    a.sync.start();
    b.sync.start();
    await settle();
    front.restart();
    await settle();
    expect(front.by(b.id)).toEqual([]);
    expect(front.doc()).toMatchObject({ activeWindow: 'w-A' });
  });
});

describe('workspaceSync: hidden-window', () => {
  it('a hidden host tile claims as shown:false and reports at once when it is shown', async () => {
    const a = open('A', { focused: true });
    a.win.innerWidth = 0;
    a.win.innerHeight = 0;
    a.sync.start();
    await settle();
    expect(front.by(a.id)[0].body).toMatchObject({ shown: false });
    expect(front.doc()).toMatchObject({ activeWindow: 'w-A', shown: false });
    expect(front.hub.setWorkspace({ commands: FOCUS_TRACE }).batch).toMatchObject({
      id: null,
      status: 'refused',
      reason: 'window_hidden',
    });

    // The tile is shown: an immediate report, no throttle wait.
    a.win.innerWidth = 640;
    a.win.innerHeight = 480;
    a.win.dispatchEvent(new Event('resize'));
    await settle();
    expect(front.by(a.id).at(-1)).toMatchObject({
      method: 'PUT',
      path: 'active',
      status: 204,
      body: { shown: true },
    });
    expect(front.doc()).toMatchObject({ shown: true });
    expect(front.hub.setWorkspace({ commands: FOCUS_TRACE }).batch).toMatchObject({
      id: 'b-e1-1',
      status: 'pending',
    });
    expect(a.batches).toEqual([expect.objectContaining({ batch: 'b-e1-1', window: 'w-A' })]);

    // Hidden again (the document goes to the background): reported at once.
    a.doc.visibilityState = 'hidden';
    a.doc.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(front.doc()).toMatchObject({ shown: false });
  });

  it('no window at all: refused no_window, and nothing is claimed for an unfocused page', async () => {
    const a = open('A');
    a.sync.start();
    await settle();
    expect(front.calls).toEqual([]);
    expect(front.hub.setWorkspace({ commands: FOCUS_TRACE }).batch).toMatchObject({
      status: 'refused',
      reason: 'no_window',
    });
  });
});

describe('workspaceSync: window-gone', () => {
  it("the window's own stream replacement is not going away", async () => {
    const a = open('A', { focused: true });
    a.sync.start();
    await settle();
    front.hub.setWorkspace({ commands: FOCUS_TRACE });
    expect(a.batches).toHaveLength(1);
    a.stream()?.drop();
    await settle();
    await advance(5_000);
    expect(
      front.hub.setWorkspace({ commands: FOCUS_TRACE, batch_id: 'b-e1-1' }).batch
    ).toMatchObject({
      status: 'pending',
    });
    expect(front.doc()).toMatchObject({ activeWindow: 'w-A', connected: true });
  });

  it('a window that leaves says goodbye: its batch is window_gone 3 s later', async () => {
    const a = open('A', { focused: true });
    a.sync.start();
    await settle();
    front.hub.setWorkspace({ commands: FOCUS_TRACE });
    a.sync.stop();
    await settle();
    expect(front.by(a.id).at(-1)).toMatchObject({
      method: 'DELETE',
      path: 'active?window=w-A',
      status: 204,
    });
    expect(front.doc()).toMatchObject({ activeWindow: 'w-A', connected: false });
    await advance(2_999);
    expect(
      front.hub.setWorkspace({ commands: FOCUS_TRACE, batch_id: 'b-e1-1' }).batch
    ).toMatchObject({
      status: 'pending',
    });
    await advance(1);
    expect(
      front.hub.setWorkspace({ commands: FOCUS_TRACE, batch_id: 'b-e1-1' }).batch
    ).toMatchObject({
      status: 'done',
      results: [{ id: 'c-e1-1', status: 'window_gone' }],
    });
    // Stopped: no further request, whatever happens.
    const count = front.calls.length;
    a.click();
    a.win.dispatchEvent(new Event('focus'));
    await advance(60_000);
    expect(front.calls.length).toBe(count);
  });

  it("another window's claim makes the bound window's batches window_gone at once", async () => {
    const a = open('A', { focused: true });
    a.sync.start();
    await settle();
    front.hub.setWorkspace({
      commands: [{ cmd: 'focus', args: { key: 'library/gtb/GTLView?SR=1' } }],
    });
    front.hub.setWorkspace({ commands: [{ cmd: 'focus', args: { key: 'library/bts/BTSView' } }] });
    expect(a.batches.map((b) => b.batch)).toEqual(['b-e1-1']);
    const b = open('B', { state: stub.emptyState() });
    b.sync.start();
    b.doc.focused = true;
    b.click();
    await settle();
    expect(a.sync.isActive()).toBe(false);
    expect(front.doc()).toMatchObject({ activeWindow: 'w-B', pending: [] });
    expect(front.doc().results.map((r) => r.status)).toEqual(['window_gone', 'window_gone']);
    // A, inactive, cannot post a result for the gone batch's window.
    expect(await a.sync.postResult({ batch: 'b-e1-1', results: [] })).toBe(409);
  });
});

// --- claim, report and liveness mechanics ----------------------------------------------

describe('workspaceSync: claim triggers', () => {
  it('claims on load only when the top-level context has focus', async () => {
    const top = new FakeWindow();
    top.document.focused = true;
    const frame = new FakeWindow();
    frame.top = top;
    const a = open('A', { win: frame });
    a.sync.start();
    await settle();
    expect(a.sync.isActive()).toBe(true);
  });

  it("claims on the top window's focus until pagehide", async () => {
    const top = new FakeWindow();
    const frame = new FakeWindow();
    frame.top = top;
    const a = open('A', { win: frame });
    a.sync.start();
    await settle();
    expect(front.calls).toEqual([]);
    top.dispatchEvent(new Event('focus'));
    await settle();
    expect(a.sync.isActive()).toBe(true);

    // Lose the slot, then leave the page: the top window's focus does not claim.
    const b = open('B');
    b.sync.start();
    b.click();
    await settle();
    expect(a.sync.isActive()).toBe(false);
    frame.dispatchEvent(new Event('pagehide'));
    const count = front.by(a.id).length;
    top.dispatchEvent(new Event('focus'));
    await settle();
    expect(front.by(a.id).length).toBe(count);
  });

  it('a cross-origin top is left alone', async () => {
    const frame = new FakeWindow();
    Object.defineProperty(frame, 'top', {
      get() {
        throw new DOMException('Blocked a frame', 'SecurityError');
      },
    });
    const a = open('A', { win: frame, focused: true });
    a.sync.start();
    await settle();
    expect(a.sync.isActive()).toBe(true);
  });

  it('claims on keydown, focus, and becoming visible while focused', async () => {
    for (const fire of [
      (v: Viewer) => v.doc.dispatchEvent(new Event('keydown')),
      (v: Viewer) => v.win.dispatchEvent(new Event('focus')),
      (v: Viewer) => {
        v.doc.focused = true;
        v.doc.dispatchEvent(new Event('visibilitychange'));
      },
    ]) {
      front = new Front();
      const v = viewer(front, 'A');
      live.push(v);
      v.sync.start();
      await settle();
      expect(front.calls).toEqual([]);
      fire(v);
      await settle();
      expect(v.sync.isActive()).toBe(true);
      v.sync.stop();
    }
  });

  it('becoming visible without focus claims nothing', async () => {
    const a = open('A');
    a.doc.visibilityState = 'hidden';
    a.sync.start();
    a.doc.visibilityState = 'visible';
    a.doc.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(front.calls).toEqual([]);
  });
});

describe('workspaceSync: reporter', () => {
  it('throttles changes: trailing edge after quiet, never later than the max wait', async () => {
    const a = open('A', { focused: true });
    a.sync.start();
    await settle();
    const puts = () => front.by(a.id).filter((c) => c.method === 'PUT');

    a.sync.changed();
    await advance(REPORT_QUIET_MS - 1);
    expect(puts()).toHaveLength(0);
    await advance(1);
    expect(puts()).toHaveLength(1);

    // A stream of changes 50 ms apart is flushed at the max wait.
    for (let t = 0; t < REPORT_MAX_WAIT_MS; t += 50) {
      a.sync.changed();
      await advance(50);
    }
    expect(puts()).toHaveLength(2);
  });

  it('seq is monotonic across claim, report and result', async () => {
    const a = open('A', { focused: true });
    a.sync.start();
    await settle();
    front.hub.setWorkspace({ commands: FOCUS_TRACE });
    a.sync.changed();
    await advance(REPORT_MAX_WAIT_MS);
    await a.sync.postResult({
      batch: 'b-e1-1',
      results: [{ id: 'c-e1-1', status: 'applied', changed: false }],
    });
    await a.sync.reportNow();
    const seqs = front
      .by(a.id)
      .flatMap((c) => (typeof c.body?.seq === 'number' ? [c.body.seq] : []));
    expect(seqs.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < seqs.length; i += 1) expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    expect(front.doc()).toMatchObject({ seq: seqs.at(-1) });
  });

  it('report bodies carry only the hub fields', async () => {
    const a = open('A', { focused: true });
    a.sync.start();
    await settle();
    await a.sync.reportNow();
    const put = front.by(a.id).find((c) => c.method === 'PUT');
    expect(Object.keys(put!.body!).sort()).toEqual(['seq', 'shown', 'state', 'windowId']);
    expect(put!.status).toBe(204);
  });

  it('an inactive window never reports, and a 409 not_active makes it inactive', async () => {
    const a = open('A');
    a.sync.start();
    a.sync.changed();
    await a.sync.reportNow();
    await advance(1_000);
    expect(front.calls).toEqual([]);

    a.doc.focused = true;
    a.click();
    await settle();
    // Another window claims while A's `inactive` is lost and its stream stays up.
    a.stream()!.deaf = true;
    front.route(
      'POST',
      'claim',
      JSON.stringify({ windowId: 'w-X', seq: 1, shown: true, state: stub.emptyState() })
    );
    await a.sync.reportNow();
    expect(front.by(a.id).at(-1)).toMatchObject({ method: 'PUT', status: 409 });
    expect(a.sync.isActive()).toBe(false);
  });
});

describe('workspaceSync: canopy_mcp down', () => {
  it('backs off: at most one config read and six workspace requests per 60 s', async () => {
    const a = open('A', { focused: true });
    a.sync.start();
    await settle();
    front.calls = [];
    front.configReads = 0;
    front.down = true;
    front.restart();
    // The operator keeps clicking while canopy_mcp is down.
    const clicker = setInterval(() => a.click(), 500);
    await advance(60_000);
    expect(front.calls.length).toBeGreaterThan(1);
    expect(front.calls.length).toBeLessThanOrEqual(6);
    expect(front.configReads).toBeLessThanOrEqual(1);
    front.calls = [];
    front.configReads = 0;
    await advance(60_000);
    expect(front.calls.length).toBeLessThanOrEqual(6);
    expect(front.configReads).toBeLessThanOrEqual(1);
    clearInterval(clicker);

    // canopy_mcp comes back: the next retry takes the slot again.
    front.down = false;
    await advance(BACKOFF_MS.at(-1)!);
    expect(a.sync.isActive()).toBe(true);
    expect(front.doc()).toMatchObject({ activeWindow: 'w-A', connected: true });
  });

  it('a 5xx backs off like a network failure', async () => {
    let fail = 3;
    const real = front.fetch;
    front.fetch = async (input, init) => {
      if (String(input).includes('/workspace/claim') && fail > 0) {
        fail -= 1;
        front.calls.push({ method: 'POST', path: 'claim', status: 503, window: 'w-A' });
        return response(503, { code: 'unavailable', detail: 'unavailable' });
      }
      return real(input, init);
    };
    const v = open('A', { focused: true });
    v.sync.start();
    await settle();
    expect(v.sync.isActive()).toBe(false);
    await advance(BACKOFF_MS[0] + BACKOFF_MS[1] + BACKOFF_MS[2]);
    expect(v.sync.isActive()).toBe(true);
  });

  it('a re-read that finds no advertisement stops every workspace request', async () => {
    const a = open('A', { focused: true });
    a.sync.start();
    await settle();
    front.calls = [];
    front.advertised = false;
    front.restart();
    // The restarted canopy_mcp serves no hub.
    front.hub = null as unknown as Hub;
    await advance(120_000);
    expect(a.sync.isStopped()).toBe(true);
    expect(front.calls.length).toBeLessThanOrEqual(1);
    const count = front.calls.length;
    a.click();
    await advance(60_000);
    expect(front.calls.length).toBe(count);
  });
});

describe('workspaceSync: advertisement', () => {
  it('keeps a known protocol major with a non-empty path', () => {
    expect(parseWorkspace({ path: 'workspace', protocol: 1 })).toEqual({
      path: 'workspace',
      protocol: 1,
    });
    expect(parseWorkspace(stub.ADVERTISEMENT)).toEqual(stub.ADVERTISEMENT);
  });

  it('drops an absent, malformed, or unknown-major advertisement', () => {
    for (const raw of [
      undefined,
      null,
      'workspace',
      { path: 'workspace' },
      { path: '', protocol: 1 },
      { path: 7, protocol: 1 },
      { path: 'workspace', protocol: 2 },
      { path: 'workspace', protocol: '1' },
      { path: 'workspace', protocol: 1.5 },
    ]) {
      expect(parseWorkspace(raw)).toBeUndefined();
    }
  });
});

describe('workspaceSync: mount (useWorkspaceSync)', () => {
  it('mounts nothing and makes no request without an advertisement or without chrome', async () => {
    vi.useRealTimers();
    const fetchSpy = vi.fn();
    const streamSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    vi.stubGlobal('EventSource', streamSpy);
    try {
      const getState = () => stub.emptyState();
      const ad = { path: 'workspace', protocol: WORKSPACE_PROTOCOL } as const;
      const off = renderHook(() =>
        useWorkspaceSync({ enabled: true, workspace: undefined, getState })
      );
      const chromeOff = renderHook(() =>
        useWorkspaceSync({ enabled: false, workspace: ad, getState })
      );
      expect(off.result.current.current).toBeNull();
      expect(chromeOff.result.current.current).toBeNull();
      const on = renderHook(() => useWorkspaceSync({ enabled: true, workspace: ad, getState }));
      expect(on.result.current.current).not.toBeNull();
      on.unmount();
      expect(on.result.current.current).toBeNull();
      off.unmount();
      chromeOff.unmount();
      expect(streamSpy).not.toHaveBeenCalled();
      const calls = fetchSpy.mock.calls.map(([url]) => String(url));
      expect(calls.filter((url) => !url.includes('/workspace/'))).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
