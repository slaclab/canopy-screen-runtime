// The machine toasts' emitter, driven through a real backend badge store the
// way services.ts feeds it (status, then each heartbeat's statement). The
// shared heartbeat vectors' `sequences` pin the toast texts and counts; the
// rest pins the rules the vectors cannot show (the 10-s limiter inside its
// window, the gates' "writes changed" report, the list's own leave clock).

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import { clientOutcome } from '@slaclab/canopy-client';
import type { HareReachable, HareWrites } from '@slaclab/canopy-client';
import { createBackendBadgeStore } from '../backendBadge.js';
import type { BackendBadgeStore } from '../backendBadge.js';
import { TOAST_MS } from './gate.js';
import { createGateRegistry, createMachineToasts, REACH_LIMIT_MS } from './machineToasts.js';
import type { GateToastSource, MachineGateRegistry, MachineToaster } from './machineToasts.js';

type Heartbeat = Parameters<BackendBadgeStore['setBackend']>[0];

interface VectorFrame {
  timestamp: number;
  backend: string;
  label: string | null;
  notice: null;
  binding: string | null;
  reachable?: HareReachable | null;
  writes?: HareWrites | null;
}
interface Vectors {
  legacy_frame: { frame: VectorFrame };
  sequences: {
    id: string;
    toast_count: number;
    steps: { event: 'frame' | 'close'; frame?: VectorFrame; expected: { toasts: string[] } }[];
  }[];
}
const VECTORS: Vectors = JSON.parse(
  readFileSync(
    createRequire(import.meta.url).resolve('../../e2e/fixtures/contracts/heartbeat_vectors.json'),
    'utf8'
  )
) as Vectors;

const OFF_REASON = 'writes are off for Simulator; turn them back on from the control-target chip';
const YES: HareReachable = { state: 'yes', since: null, reason: null };
const NO: HareReachable = { state: 'no', since: 1760700060, reason: null };
const UNKNOWN: HareReachable = { state: 'unknown', since: null, reason: null };
const ON: HareWrites = { state: 'on', reason: null, cause: null };
const OFF: HareWrites = { state: 'off', reason: OFF_REASON, cause: 'narrowing' };
const APPLYING: HareWrites = {
  state: 'applying',
  reason: 'applying the new write state',
  cause: 'applying',
};

function beat(fields: Partial<Heartbeat> = {}): Heartbeat {
  return {
    name: 'example',
    label: 'Simulator',
    notice: null,
    binding: 'sim@3',
    reachable: YES,
    writes: ON,
    ...fields,
  } as Heartbeat;
}

/** A page: its store and emitter, with the socket verbs services.ts calls. */
function page(gates?: MachineGateRegistry) {
  const store = createBackendBadgeStore({
    backend: { name: 'example', label: 'Simulator', notice: null },
    binding: 'sim@3',
  });
  const toaster: MachineToaster = createMachineToasts(store, { gates });
  toaster.activate();
  const frame = (fields: Partial<Heartbeat> = {}) => {
    store.setStatus('connected');
    store.setBackend(beat(fields), null);
    // Let a writes toast decide (it waits one task).
    vi.advanceTimersByTime(0);
  };
  const close = () => store.setStatus('disconnected');
  const texts = () => toaster.getSnapshot().toasts.map((t) => t.text);
  // Every toast ever shown, in order (the list itself lets them leave).
  const shown: string[] = [];
  let seen = 0;
  toaster.subscribe(() => {
    for (const t of toaster.getSnapshot().toasts) {
      if (t.id > seen) {
        seen = t.id;
        shown.push(t.text);
      }
    }
  });
  return { store, toaster, frame, close, texts, shown };
}

let disposers: (() => void)[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  disposers = [];
});
afterEach(() => {
  for (const d of disposers) d();
  vi.useRealTimers();
});

function track<T extends { toaster: MachineToaster }>(p: T): T {
  disposers.push(() => p.toaster.dispose());
  return p;
}

describe('machine toasts — writes', () => {
  it('on → off → on: two writes toasts, none on the first heartbeat', () => {
    const p = track(page());
    p.frame({ writes: ON });
    expect(p.texts()).toEqual([]);
    p.frame({ writes: OFF });
    p.frame({ writes: ON });
    expect(p.texts()).toEqual([
      'Writes are off for Simulator; turn them back on from the control-target chip',
      'Writes are on for Simulator',
    ]);
    const [off, on] = p.toaster.getSnapshot().toasts;
    expect(off).toMatchObject({ kind: 'warning', title: 'Simulator' });
    expect(on).toMatchObject({ kind: 'success', title: 'Simulator' });
  });

  it("off → applying → close → on: one toast, on the successor's `on`", () => {
    const p = track(page());
    p.frame({ writes: OFF });
    p.frame({ writes: APPLYING });
    expect(p.texts()).toEqual([]);
    p.close();
    expect(p.texts()).toEqual([]);
    p.frame({ writes: ON });
    expect(p.texts()).toEqual(['Writes are on for Simulator']);
  });

  it("a null reason reads Requirement 7's sentence; an unknown word reads locked", () => {
    const p = track(page());
    p.frame({ writes: ON });
    p.frame({ writes: { state: 'off', reason: null, cause: null } });
    p.frame({ writes: ON });
    p.frame({ writes: { state: 'frozen', reason: null, cause: null } });
    p.frame({ writes: ON });
    p.frame({ writes: { state: 'locked', reason: 'locked by the operator', cause: null } });
    expect(p.texts()).toEqual([
      'Writes are off for Simulator',
      'Writes are on for Simulator',
      'Writes are locked for Simulator',
      'Writes are on for Simulator',
      'Locked by the operator',
    ]);
  });

  it('asked reads as on: on → asked → on is silent, off → asked is "Writes are on"', () => {
    const p = track(page());
    const ASKED: HareWrites = { state: 'asked', reason: null, cause: 'asked' };
    p.frame({ writes: ON });
    p.frame({ writes: ASKED });
    p.frame({ writes: ON });
    expect(p.texts()).toEqual([]);
    p.frame({ writes: OFF });
    p.frame({ writes: ASKED });
    expect(p.texts()).toEqual([
      OFF_REASON[0].toUpperCase() + OFF_REASON.slice(1),
      'Writes are on for Simulator',
    ]);
  });

  it('held toasts the hold\'s reason, else "Writes are held for <label>"', () => {
    const p = track(page());
    p.frame({ writes: ON });
    p.frame({
      writes: { state: 'held', reason: 'writes are held: a flag is open', cause: 'session_held' },
    });
    p.frame({ writes: ON });
    p.frame({ writes: { state: 'held', reason: null, cause: 'session_held' } });
    expect(p.texts()).toEqual([
      'Writes are held: a flag is open',
      'Writes are on for Simulator',
      'Writes are held for Simulator',
    ]);
    expect(p.toaster.getSnapshot().toasts[0]).toMatchObject({ kind: 'warning' });
  });

  it('a change of reason under the same state does not toast', () => {
    const p = track(page());
    p.frame({ writes: OFF });
    p.frame({ writes: { ...OFF, reason: 'another reason' } });
    expect(p.texts()).toEqual([]);
  });

  it('a gap followed by the same state is silent; a different one toasts once', () => {
    const p = track(page());
    p.frame({ writes: ON });
    p.close();
    p.frame({ writes: ON });
    expect(p.texts()).toEqual([]);
    p.close();
    p.frame({ writes: OFF });
    p.frame({ writes: OFF });
    expect(p.texts()).toEqual([
      'Writes are off for Simulator; turn them back on from the control-target chip',
    ]);
  });
});

describe('machine toasts — reachability', () => {
  it('no: one error toast; gap, unknown, yes: exactly one recovery toast', () => {
    const p = track(page());
    p.frame({ reachable: YES });
    p.frame({ reachable: NO });
    expect(p.texts()).toEqual(['Simulator stopped answering']);
    expect(p.toaster.getSnapshot().toasts[0].kind).toBe('error');
    vi.advanceTimersByTime(60000);
    p.close();
    p.frame({ reachable: UNKNOWN });
    expect(p.shown).toEqual(['Simulator stopped answering']);
    vi.advanceTimersByTime(60000);
    p.frame({ reachable: YES });
    expect(p.shown).toEqual(['Simulator stopped answering', 'Simulator is answering again']);
    expect(p.toaster.getSnapshot().toasts.at(-1)?.kind).toBe('success');
  });

  it('no/yes/no within 10 s: the last toast shown is "stopped answering"', () => {
    const p = track(page());
    p.frame({ reachable: YES });
    p.frame({ reachable: NO });
    vi.advanceTimersByTime(3000);
    p.frame({ reachable: YES });
    vi.advanceTimersByTime(3000);
    p.frame({ reachable: NO });
    vi.advanceTimersByTime(REACH_LIMIT_MS * 3);
    expect(p.shown).toEqual(['Simulator stopped answering']);
  });

  it('a change inside the window toasts at its end when it still differs', () => {
    const p = track(page());
    p.frame({ reachable: YES });
    p.frame({ reachable: NO });
    vi.advanceTimersByTime(2000);
    p.frame({ reachable: YES });
    expect(p.shown).toEqual(['Simulator stopped answering']);
    vi.advanceTimersByTime(REACH_LIMIT_MS - 2001);
    expect(p.shown).toEqual(['Simulator stopped answering']);
    vi.advanceTimersByTime(1);
    expect(p.shown).toEqual(['Simulator stopped answering', 'Simulator is answering again']);
  });

  it('a page that loads on `no` shows no toast', () => {
    const p = track(page());
    p.frame({ reachable: NO });
    p.frame({ reachable: NO });
    expect(p.texts()).toEqual([]);
  });

  it('a binding change resets the memory silently', () => {
    const p = track(page());
    p.frame({ reachable: YES, writes: ON });
    p.close();
    p.frame({ binding: 'bts@4', label: 'BTS', reachable: NO, writes: OFF });
    expect(p.texts()).toEqual([]);
    // The new binding's own changes toast.
    p.frame({ binding: 'bts@4', label: 'BTS', reachable: NO, writes: ON });
    expect(p.texts()).toEqual(['Writes are on for BTS']);
  });

  it('a first definite state after `unknown` is stored without a toast', () => {
    const p = track(page());
    p.frame({ reachable: UNKNOWN });
    p.frame({ reachable: NO });
    expect(p.texts()).toEqual([]);
  });
});

describe('machine toasts — heartbeat vectors', () => {
  it.each(VECTORS.sequences.map((v) => [v.id, v] as const))('sequence %s', (_, v) => {
    const p = track(page());
    const want: string[] = [];
    for (const step of v.steps) {
      const before = p.shown.length;
      if (step.event === 'close') p.close();
      else {
        const f = step.frame!;
        p.frame({
          name: f.backend,
          label: f.label,
          binding: f.binding,
          reachable: f.reachable ?? null,
          writes: f.writes ?? null,
        });
      }
      expect(p.shown.slice(before)).toEqual(step.expected.toasts);
      want.push(...step.expected.toasts);
      // Steps are further apart than the limiter.
      vi.advanceTimersByTime(60000);
    }
    expect(p.shown).toEqual(want);
    expect(p.shown.length).toBe(v.toast_count);
  });

  it('recorded legacy frames raise no machine toast', () => {
    const p = track(page());
    const f = VECTORS.legacy_frame.frame;
    for (let i = 0; i < 3; i++) {
      p.frame({ label: f.label, binding: f.binding, reachable: null, writes: null });
      p.close();
    }
    p.frame({ label: f.label, binding: f.binding, reachable: null, writes: null });
    expect(p.texts()).toEqual([]);
  });
});

/** A screen gate's toast list, enough for the registry. */
function fakeGate() {
  let toasts: { id: number; outcome: string; text: string }[] = [];
  const listeners = new Set<() => void>();
  let id = 1;
  const gate: GateToastSource = {
    subscribe(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    getSnapshot: () => ({ toasts }),
  };
  const toast = (outcome: string, text: string) => {
    toasts = [...toasts, { id: id++, outcome, text }];
    for (const l of [...listeners]) l();
  };
  return { gate, toast };
}

describe('machine toasts — a change a gate already reported', () => {
  const WRITES_CHANGED = clientOutcome('write-state-changed', 'Simulator').detail;

  it('drops the writes toast when a gate shows "writes changed" for it (a few microtasks later)', async () => {
    const gates = createGateRegistry();
    const g = fakeGate();
    disposers.push(gates.add(g.gate));
    const p = track(page(gates));
    p.frame({ writes: ON });
    p.store.setBackend(beat({ writes: OFF }), null);
    await Promise.resolve();
    await Promise.resolve();
    g.toast('target_changed', WRITES_CHANGED);
    vi.advanceTimersByTime(0);
    expect(p.texts()).toEqual([]);
    // The memory still moved: the next change toasts.
    p.frame({ writes: ON });
    expect(p.texts()).toEqual(['Writes are on for Simulator']);
  });

  it('drops it when the gate reported first (a deferred dialog on the next socket)', () => {
    const gates = createGateRegistry();
    const g = fakeGate();
    disposers.push(gates.add(g.gate));
    const p = track(page(gates));
    p.frame({ writes: ON });
    p.close();
    g.toast('target_changed', `${WRITES_CHANGED} (0 of 2 written)`);
    p.frame({ writes: OFF });
    expect(p.texts()).toEqual([]);
  });

  it('keeps it for another gate toast, or a report long before', () => {
    const gates = createGateRegistry();
    const g = fakeGate();
    disposers.push(gates.add(g.gate));
    const p = track(page(gates));
    p.frame({ writes: ON });
    g.toast('target_changed', WRITES_CHANGED);
    vi.advanceTimersByTime(5000);
    g.toast('declined', 'not written');
    p.frame({ writes: OFF });
    expect(p.texts()).toEqual([
      'Writes are off for Simulator; turn them back on from the control-target chip',
    ]);
  });

  it('a gate removed from the registry no longer reports', () => {
    const gates = createGateRegistry();
    const g = fakeGate();
    const off = gates.add(g.gate);
    const p = track(page(gates));
    p.frame({ writes: ON });
    off();
    p.store.setBackend(beat({ writes: OFF }), null);
    g.toast('target_changed', WRITES_CHANGED);
    vi.advanceTimersByTime(0);
    expect(p.texts().length).toBe(1);
  });
});

describe('machine toasts — the list', () => {
  it("keeps its own list past the gates' cap; each toast leaves after TOAST_MS", () => {
    const p = track(page());
    p.frame({ writes: ON });
    for (const w of [OFF, ON, OFF, ON]) p.frame({ writes: w });
    expect(p.texts().length).toBe(4);
    vi.advanceTimersByTime(TOAST_MS);
    expect(p.texts()).toEqual([]);
  });

  it('a held toast stays until released, then its full time; dismiss removes it', () => {
    const p = track(page());
    p.frame({ writes: ON });
    p.frame({ writes: OFF });
    p.frame({ writes: ON });
    const [a, b] = p.toaster.getSnapshot().toasts;
    p.toaster.hold(a.id);
    vi.advanceTimersByTime(TOAST_MS * 2);
    expect(p.toaster.getSnapshot().toasts.map((t) => t.id)).toEqual([a.id]);
    p.toaster.release(a.id);
    vi.advanceTimersByTime(TOAST_MS - 1);
    expect(p.texts().length).toBe(1);
    vi.advanceTimersByTime(1);
    expect(p.texts()).toEqual([]);
    expect(b).toBeDefined();
    p.frame({ writes: OFF });
    p.toaster.dismiss(p.toaster.getSnapshot().toasts[0].id);
    expect(p.texts()).toEqual([]);
  });

  it('dispose stops every toast and timer', () => {
    const p = page();
    p.frame({ reachable: YES, writes: ON });
    p.store.setBackend(beat({ writes: OFF }), null);
    p.toaster.dispose();
    vi.advanceTimersByTime(0);
    p.frame({ reachable: NO });
    expect(p.texts()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
