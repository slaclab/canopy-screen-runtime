// What the backoff retries when more than one request has failed or been asked
// for while canopy_mcp is failing: claim > reclaim > report, never downgraded. The
// window here talks to a scripted fetch and a fake event stream (not the stub
// hub), so each scenario controls exactly which request fails and when.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceState } from './workspaceState.js';
import {
  BACKOFF_MS,
  createWorkspaceSync,
  mergePending,
  type EventStream,
  type Pending,
  type SyncDocument,
  type SyncWindow,
  type WorkspaceSync,
} from './workspaceSync.js';

describe('mergePending: claim > reclaim > report', () => {
  const cases: [Pending | null, Pending, Pending][] = [
    [null, 'report', 'report'],
    [null, 'reclaim', 'reclaim'],
    [null, 'claim', 'claim'],
    ['report', 'report', 'report'],
    ['report', 'reclaim', 'reclaim'],
    ['report', 'claim', 'claim'],
    ['reclaim', 'report', 'reclaim'],
    ['reclaim', 'reclaim', 'reclaim'],
    ['reclaim', 'claim', 'claim'],
    ['claim', 'report', 'claim'],
    ['claim', 'reclaim', 'claim'],
    ['claim', 'claim', 'claim'],
  ];
  it.each(cases)('pending %s + %s -> %s', (pending, what, expected) => {
    expect(mergePending(pending, what)).toBe(expected);
  });
});

// --- a scripted canopy_mcp --------------------------------------------------------

class FakeStream implements EventStream {
  onerror: ((event: Event) => void) | null = null;
  closed = false;
  private listeners = new Map<string, ((event: MessageEvent) => void)[]>();
  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  emit(type: string, data: unknown = {}): void {
    for (const l of this.listeners.get(type) ?? []) {
      l(new MessageEvent(type, { data: JSON.stringify(data) }));
    }
  }
  error(): void {
    this.onerror?.(new Event('error'));
  }
  close(): void {
    this.closed = true;
  }
}

interface Call {
  method: string;
  path: string;
}

const BASE = 'http://front.test/app/';
const EMPTY = {} as WorkspaceState;

function harness() {
  const calls: Call[] = [];
  const streams: FakeStream[] = [];
  /** Whether canopy_mcp answers: false makes every workspace request a network failure. */
  const front = { up: true };
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    await Promise.resolve();
    const u = new URL(String(input));
    const path = u.pathname.replace(/^\/app\/api\/workspace\//, '') + u.search;
    calls.push({ method: init?.method ?? 'GET', path });
    if (!front.up) throw new TypeError('Failed to fetch');
    return new Response('{}', { status: 200 });
  });
  const win = Object.assign(new EventTarget(), {
    innerWidth: 800,
    innerHeight: 600,
    top: null,
  }) as unknown as SyncWindow;
  const docTarget = new EventTarget();
  const doc = Object.assign(docTarget, {
    visibilityState: 'visible' as DocumentVisibilityState,
    defaultView: win,
    hasFocus: () => true,
  }) as unknown as SyncDocument;
  const sync: WorkspaceSync = createWorkspaceSync({
    workspace: { path: 'api/workspace', protocol: 1 } as never,
    getState: () => EMPTY,
    baseURI: BASE,
    fetch: fetch as unknown as typeof globalThis.fetch,
    openStream: () => {
      const s = new FakeStream();
      streams.push(s);
      return s;
    },
    win,
    doc,
    reread: async () => ({ status: 'advertised', workspace: { path: 'api/workspace' } }) as never,
    randomId: () => 'w1',
  });
  const stream = () => streams[streams.length - 1];
  const keydown = () => docTarget.dispatchEvent(new Event('keydown'));
  const since = (n: number) => calls.slice(n);
  return { sync, calls, streams, stream, front, keydown, since };
}

async function settle(ms = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

describe('backoff precedence through the window sync', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Start, claim (200), and open the stream: the window holds the slot. */
  async function activeWindow() {
    const h = harness();
    h.sync.start();
    await settle();
    expect(h.calls).toEqual([{ method: 'POST', path: 'claim' }]);
    expect(h.sync.isActive()).toBe(true);
    expect(h.streams).toHaveLength(1);
    return h;
  }

  /** A report fails: the backoff starts with a pending report. */
  async function failReport(h: ReturnType<typeof harness>) {
    h.front.up = false;
    await h.sync.reportNow();
    await settle();
    expect(h.calls.at(-1)).toEqual({ method: 'PUT', path: 'active' });
    h.front.up = true;
  }

  it('a failed report, then a stream error: the retry re-claims with if_vacant (canopy_mcp restart)', async () => {
    const h = await activeWindow();
    await failReport(h);
    const mark = h.calls.length;
    // canopy_mcp restarts: the stream errors while the report is backing off.
    h.stream().error();
    expect(h.sync.isActive()).toBe(false);
    await settle();
    expect(h.since(mark), 'nothing is sent while backing off').toEqual([]);
    await settle(BACKOFF_MS[0]);
    const after = h.since(mark).filter((c) => !c.path.startsWith('config.json'));
    expect(after).toEqual([{ method: 'POST', path: 'claim?if_vacant=1' }]);
    expect(h.sync.isActive()).toBe(true);
    expect(h.streams).toHaveLength(2);
    h.sync.stop();
  });

  it('a failed report, then losing the slot and a gesture: the retry claims', async () => {
    const h = await activeWindow();
    await failReport(h);
    h.stream().emit('inactive');
    expect(h.sync.isActive()).toBe(false);
    const mark = h.calls.length;
    h.keydown();
    await settle(BACKOFF_MS[0]);
    expect(h.since(mark).filter((c) => !c.path.startsWith('config.json'))).toEqual([
      { method: 'POST', path: 'claim' },
    ]);
    h.sync.stop();
  });

  it('a pending reclaim is upgraded to a claim by a gesture', async () => {
    const h = await activeWindow();
    await failReport(h);
    h.stream().error(); // pending reclaim
    const mark = h.calls.length;
    h.keydown(); // upgrades to claim
    await settle(BACKOFF_MS[0]);
    expect(h.since(mark).filter((c) => !c.path.startsWith('config.json'))).toEqual([
      { method: 'POST', path: 'claim' },
    ]);
    h.sync.stop();
  });

  it('a pending reclaim is not downgraded by a failed result', async () => {
    const h = await activeWindow();
    await failReport(h);
    h.stream().error(); // pending reclaim
    h.front.up = false;
    expect(await h.sync.postResult({ batch: 'b1', results: [] })).toBe(0);
    h.front.up = true;
    const mark = h.calls.length;
    await settle(BACKOFF_MS[0]);
    expect(h.since(mark).filter((c) => !c.path.startsWith('config.json'))).toEqual([
      { method: 'POST', path: 'claim?if_vacant=1' },
    ]);
    h.sync.stop();
  });

  it('a pending claim is not downgraded by a failed result', async () => {
    const h = harness();
    h.front.up = false;
    h.sync.start(); // the claim fails: pending claim
    await settle();
    expect(h.calls).toEqual([{ method: 'POST', path: 'claim' }]);
    expect(await h.sync.postResult({ batch: 'b1', results: [] })).toBe(0);
    h.front.up = true;
    const mark = h.calls.length;
    await settle(BACKOFF_MS[1]);
    expect(h.since(mark).filter((c) => !c.path.startsWith('config.json'))).toEqual([
      { method: 'POST', path: 'claim' },
    ]);
    expect(h.sync.isActive()).toBe(true);
    h.sync.stop();
  });

  it('a pending reclaim is not downgraded by a report while backing off', async () => {
    const h = await activeWindow();
    h.front.up = false;
    h.stream().error(); // re-claim with if_vacant fails: pending reclaim
    await settle();
    expect(h.calls.at(-1)).toEqual({ method: 'POST', path: 'claim?if_vacant=1' });
    h.front.up = true;
    h.sync.changed(); // inactive: no report is queued
    await settle(REPORT_SLACK);
    const mark = h.calls.length;
    await settle(BACKOFF_MS[0]);
    expect(h.since(mark).filter((c) => !c.path.startsWith('config.json'))).toEqual([
      { method: 'POST', path: 'claim?if_vacant=1' },
    ]);
    h.sync.stop();
  });
});

const REPORT_SLACK = 300;
