// The viewer's write gate over a fake Hare backend: the dialog rule, the
// binding capture and cancellation, the stop rule, serialisation, the dialog
// queue, dispose, the one summary toast per run, and the writes state with its
// one refusal (statement neither `on` nor `asked`, or a closed socket after a
// statement), the dialog every run opens under `asked` and the `confirmed`
// its writes then carry.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WRITE_OUTCOME_COALESCED_TOAST } from '@slaclab/canopy-client';
import type {
  HareHeartbeatState,
  HareWrites,
  SubmitOptions,
  WriteOutcome,
  WriteOutcomeKind,
} from '@slaclab/canopy-client';
import type { WriteRequest } from '@slaclab/canopy-screen-widgets';
import { createWriteGate, summarize } from './gate.js';
import type { WriteBackend } from './gate.js';
import { GUARD_MS, GUARD_NOTICE, createWriteGuard } from './guard.js';

const TARGET_CHANGED = 'the control target or its write state changed; nothing written';
const WRITES_CHANGED_SIM = 'the write state of Simulator changed; nothing written';

function outcome(kind: WriteOutcomeKind, detail: string = kind, coalesced = false): WriteOutcome {
  return { outcome: kind, code: null, status: null, detail, coalesced };
}

interface Sent {
  pv: string;
  value: unknown;
  options: SubmitOptions;
  resolve(o: WriteOutcome): void;
}

/** A Hare stand-in: heartbeat, link, confirmWrites and each submit under test control. */
function fakeBackend(init: { confirm?: boolean; seen?: boolean; binding?: string | null } = {}) {
  const st = {
    confirm: init.confirm ?? true,
    hb: { seen: init.seen ?? true, binding: init.binding ?? 'va@1' } as HareHeartbeatState,
    link: true,
    label: 'VA' as string | null,
    /** The current socket's write statement, and whether the page has seen one. */
    writes: null as HareWrites | null,
    seen: false,
    /** Answer each submit at once with the next of these, else leave it pending. */
    answers: [] as WriteOutcome[],
  };
  const sent: Sent[] = [];
  const listeners = new Set<(s: HareHeartbeatState) => void>();
  const writeListeners = new Set<() => void>();
  const backend: WriteBackend = {
    heartbeat: () => ({ ...st.hb }),
    linkUp: () => st.link,
    submit: (pv, value, options) =>
      new Promise<WriteOutcome>((resolve) => {
        sent.push({ pv, value, options, resolve });
        const next = st.answers.shift();
        if (next) resolve(next);
      }),
    onHeartbeat(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    confirmWrites: () => st.confirm,
    machineLabel: () => st.label,
    writes: () => ({ writes: st.writes, seen: st.seen }),
    onWrites(l) {
      writeListeners.add(l);
      return () => writeListeners.delete(l);
    },
  };
  const beat = (hb: HareHeartbeatState) => {
    st.hb = hb;
    for (const l of [...listeners]) l({ ...hb });
  };
  /** A new statement on the current socket, as the badge store announces it. */
  const state = (writes: HareWrites | null) => {
    st.writes = writes;
    if (writes !== null) st.seen = true;
    for (const l of [...writeListeners]) l();
  };
  /** The socket closes: the store clears the statement, then the heartbeat is forgotten. */
  const close = () => {
    st.link = false;
    st.writes = null;
    for (const l of [...writeListeners]) l();
    beat({ seen: false, binding: null });
  };
  return { backend, st, sent, beat, listeners, writeListeners, state, close };
}

const ORIGIN = { screen: 'sr/overview', rev: 'r7' };
const tick = () => new Promise((r) => setTimeout(r, 0));
const w = (pv: string, value: number | string, release?: boolean): WriteRequest =>
  release ? { pv, value, release } : { pv, value };

describe('gate.run — the dialog', () => {
  it('opens one dialog listing the writes before any write, then sends them in order', async () => {
    const f = fakeBackend();
    f.st.answers = [outcome('confirmed'), outcome('confirmed')];
    const gate = createWriteGate(f.backend, ORIGIN);
    const p = gate.run([w('A', 1), w('B', 'on')]);
    await tick();
    const dialog = gate.getSnapshot().dialog!;
    expect(dialog.writes).toEqual([w('A', 1), w('B', 'on')]);
    expect(dialog.machine).toBe('VA');
    expect(f.sent).toEqual([]);
    gate.confirm(dialog.id);
    const result = await p;
    expect(result).toEqual([outcome('confirmed'), outcome('confirmed')]);
    expect(f.sent.map((s) => [s.pv, s.value, s.options])).toEqual([
      ['A', 1, { origin: ORIGIN, binding: 'va@1', confirmed: true }],
      ['B', 'on', { origin: ORIGIN, binding: 'va@1', confirmed: true }],
    ]);
    expect(gate.getSnapshot().dialog).toBeNull();
    expect(gate.getSnapshot().toasts.map((t) => [t.outcome, t.text])).toEqual([
      ['confirmed', 'written'],
    ]);
  });

  it('decline sends nothing and shows nothing', async () => {
    const f = fakeBackend();
    const gate = createWriteGate(f.backend, ORIGIN);
    const p = gate.run([w('A', 1)]);
    await tick();
    gate.decline(gate.getSnapshot().dialog!.id);
    expect(await p).toBe('declined');
    expect(f.sent).toEqual([]);
    expect(gate.getSnapshot()).toEqual({ dialog: null, toasts: [] });
  });

  it('opens no dialog without a heartbeat or with the link down: "target changed", nothing sent', async () => {
    for (const setup of [
      (f: ReturnType<typeof fakeBackend>) => (f.st.hb = { seen: false, binding: null }),
      (f: ReturnType<typeof fakeBackend>) => (f.st.link = false),
    ]) {
      const f = fakeBackend();
      setup(f);
      const gate = createWriteGate(f.backend, ORIGIN);
      const result = await gate.run([w('A', 1)]);
      expect(result).toEqual([outcome('target_changed', TARGET_CHANGED)]);
      expect(f.sent).toEqual([]);
      expect(gate.getSnapshot().dialog).toBeNull();
      expect(gate.getSnapshot().toasts.map((t) => [t.outcome, t.text])).toEqual([
        ['target_changed', TARGET_CHANGED],
      ]);
    }
  });

  it('a multi-write click with no heartbeat says "(0 of n written)"', async () => {
    const f = fakeBackend({ seen: false });
    const gate = createWriteGate(f.backend, ORIGIN);
    await gate.run([w('A', 1), w('B', 2)]);
    expect(gate.getSnapshot().toasts[0].text).toBe(`${TARGET_CHANGED} (0 of 2 written)`);
  });

  it('opens the dialog on a null-binding heartbeat and sends no binding', async () => {
    const f = fakeBackend({ binding: null });
    f.st.hb = { seen: true, binding: null };
    f.st.answers = [outcome('confirmed')];
    const gate = createWriteGate(f.backend, ORIGIN);
    const p = gate.run([w('A', 1)]);
    await tick();
    gate.confirm(gate.getSnapshot().dialog!.id);
    await p;
    expect(f.sent[0].options.binding).toBeNull();
  });

  it('a binding change while the dialog is open cancels it: "target changed", nothing sent', async () => {
    const f = fakeBackend();
    const gate = createWriteGate(f.backend, ORIGIN);
    const p = gate.run([w('A', 1)]);
    await tick();
    const id = gate.getSnapshot().dialog!.id;
    f.beat({ seen: true, binding: 'va@2' });
    expect(gate.getSnapshot().dialog).toBeNull();
    expect(await p).toEqual([outcome('target_changed', TARGET_CHANGED)]);
    gate.confirm(id); // a late click on the closed dialog does nothing
    expect(f.sent).toEqual([]);
    expect(gate.getSnapshot().toasts.map((t) => t.outcome)).toEqual(['target_changed']);
  });

  it('link loss while the dialog is open cancels it', async () => {
    const f = fakeBackend();
    const gate = createWriteGate(f.backend, ORIGIN);
    const p = gate.run([w('A', 1)]);
    await tick();
    f.st.link = false;
    f.beat({ seen: false, binding: null });
    expect(await p).toEqual([outcome('target_changed', TARGET_CHANGED)]);
    expect(f.sent).toEqual([]);
  });

  it('a confirm after an unannounced binding change is "target changed" too', async () => {
    const f = fakeBackend();
    const gate = createWriteGate(f.backend, ORIGIN);
    const p = gate.run([w('A', 1)]);
    await tick();
    f.st.hb = { seen: true, binding: 'other@3' };
    gate.confirm(gate.getSnapshot().dialog!.id);
    expect(await p).toEqual([outcome('target_changed', TARGET_CHANGED)]);
    expect(f.sent).toEqual([]);
  });

  it('sends the binding captured when the dialog opened, and no confirmed key without a dialog', async () => {
    const f = fakeBackend({ confirm: false });
    f.st.answers = [outcome('confirmed')];
    const gate = createWriteGate(f.backend, ORIGIN);
    await gate.run([w('A', 1)]);
    expect(f.sent[0].options).toEqual({ origin: ORIGIN, binding: 'va@1' });
  });

  it('opens no dialog with confirmWrites off, read at each run', async () => {
    const f = fakeBackend({ confirm: false });
    f.st.answers = [outcome('confirmed'), outcome('confirmed')];
    const gate = createWriteGate(f.backend, ORIGIN);
    await gate.run([w('A', 1)]);
    expect(f.sent).toHaveLength(1);
    expect(gate.confirmWrites()).toBe(false);
    f.st.confirm = true;
    expect(gate.confirmWrites()).toBe(true);
    void gate.run([w('B', 1)]);
    await tick();
    expect(gate.getSnapshot().dialog).not.toBeNull();
    expect(f.sent).toHaveLength(1);
  });
});

describe('gate.run — one dialog slot', () => {
  it('queues further runs FIFO and never stacks dialogs', async () => {
    const f = fakeBackend();
    f.st.answers = [outcome('confirmed'), outcome('confirmed')];
    const gate = createWriteGate(f.backend, ORIGIN);
    const seen: string[][] = [];
    let lastId = 0;
    gate.subscribe(() => {
      const d = gate.getSnapshot().dialog;
      if (d && d.id !== lastId) {
        lastId = d.id;
        seen.push(d.writes.map((x) => x.pv));
      }
    });
    const p1 = gate.run([w('A', 1)]);
    const p2 = gate.run([w('B', 2)]);
    const p3 = gate.run([w('C', 3)]);
    await tick();
    expect(seen).toEqual([['A']]);
    gate.confirm(gate.getSnapshot().dialog!.id);
    await p1;
    expect(seen).toEqual([['A'], ['B']]);
    gate.decline(gate.getSnapshot().dialog!.id);
    expect(await p2).toBe('declined');
    expect(seen).toEqual([['A'], ['B'], ['C']]);
    gate.confirm(gate.getSnapshot().dialog!.id);
    await p3;
    expect(f.sent.map((s) => s.pv)).toEqual(['A', 'C']);
  });

  it('drops queued runs and the open dialog on dispose: nothing sent, nothing shown', async () => {
    const f = fakeBackend();
    const gate = createWriteGate(f.backend, ORIGIN);
    const p1 = gate.run([w('A', 1)]);
    const p2 = gate.run([w('B', 2)]);
    await tick();
    gate.dispose();
    expect(await p1).toBe('declined');
    expect(await p2).toBe('declined');
    expect(f.sent).toEqual([]);
    expect(gate.getSnapshot()).toEqual({ dialog: null, toasts: [] });
    expect(f.listeners.size).toBe(0);
    expect(await gate.run([w('C', 3)])).toBe('declined');
  });

  it('works again after activate() (an effect run twice)', async () => {
    const f = fakeBackend({ confirm: false });
    f.st.answers = [outcome('confirmed')];
    const gate = createWriteGate(f.backend, ORIGIN);
    gate.dispose();
    gate.activate();
    expect(await gate.run([w('A', 1)])).toEqual([outcome('confirmed')]);
  });

  it('a run already sending finishes after dispose, without a toast', async () => {
    const f = fakeBackend({ confirm: false });
    const gate = createWriteGate(f.backend, ORIGIN);
    const p = gate.run([w('A', 1)]);
    await tick();
    gate.dispose();
    f.sent[0].resolve(outcome('confirmed'));
    expect(await p).toEqual([outcome('confirmed')]);
    expect(gate.getSnapshot().toasts).toEqual([]);
  });
});

describe('gate.run — the stop rule', () => {
  it('stops after a refused write: the rest is not sent; "(k of n written)"', async () => {
    const f = fakeBackend({ confirm: false });
    f.st.answers = [
      outcome('confirmed'),
      outcome('refused', 'the write was refused; nothing written'),
    ];
    const gate = createWriteGate(f.backend, ORIGIN);
    const result = await gate.run([w('A', 1), w('B', 2), w('C', 3)]);
    expect(f.sent.map((s) => s.pv)).toEqual(['A', 'B']);
    expect(result).toHaveLength(2);
    expect(gate.getSnapshot().toasts.map((t) => [t.outcome, t.text])).toEqual([
      ['refused', 'the write was refused; nothing written (1 of 3 written)'],
    ]);
  });

  it('continues after mismatch and unconfirmed; toasts the first non-confirmed detail', async () => {
    const f = fakeBackend({ confirm: false });
    f.st.answers = [
      outcome('mismatch', 'written; the channel holds 4'),
      outcome('unconfirmed', 'written; the value could not be verified'),
      outcome('confirmed'),
    ];
    const gate = createWriteGate(f.backend, ORIGIN);
    await gate.run([w('A', 1), w('B', 2), w('C', 3)]);
    expect(f.sent.map((s) => s.pv)).toEqual(['A', 'B', 'C']);
    expect(gate.getSnapshot().toasts.map((t) => [t.outcome, t.text])).toEqual([
      ['mismatch', 'written; the channel holds 4 (3 of 3 written)'],
    ]);
  });

  it('stops after unknown, except before a release write', async () => {
    const f = fakeBackend({ confirm: false });
    f.st.answers = [outcome('unknown')];
    const gate = createWriteGate(f.backend, ORIGIN);
    await gate.run([w('A', 1), w('B', 2)]);
    expect(f.sent.map((s) => s.pv)).toEqual(['A']);

    const g = fakeBackend({ confirm: false });
    g.st.answers = [outcome('unknown'), outcome('confirmed')];
    const gate2 = createWriteGate(g.backend, ORIGIN);
    await gate2.run([w('P', 1), w('P', 0, true)]);
    expect(g.sent.map((s) => [s.pv, s.value])).toEqual([
      ['P', 1],
      ['P', 0],
    ]);
  });

  it('never sends a release after a refused press', async () => {
    const f = fakeBackend({ confirm: false });
    f.st.answers = [outcome('refused')];
    const gate = createWriteGate(f.backend, ORIGIN);
    await gate.run([w('P', 1), w('P', 0, true)]);
    expect(f.sent.map((s) => s.value)).toEqual([1]);
  });

  it('a coalesced write inside a run counts as not written and stops it', async () => {
    const f = fakeBackend({ confirm: false });
    f.st.answers = [outcome('confirmed'), outcome('confirmed', 'written', true)];
    const gate = createWriteGate(f.backend, ORIGIN);
    const result = await gate.run([w('A', 1), w('B', 2), w('C', 3)]);
    expect(f.sent.map((s) => s.pv)).toEqual(['A', 'B']);
    expect(result).toHaveLength(2);
    expect(gate.getSnapshot().toasts.map((t) => [t.outcome, t.text])).toEqual([
      ['coalesced', `${WRITE_OUTCOME_COALESCED_TOAST} (1 of 3 written)`],
    ]);
  });

  it('shows no toast for a coalesced single write', async () => {
    const f = fakeBackend({ confirm: false });
    f.st.answers = [outcome('confirmed', 'written', true)];
    const gate = createWriteGate(f.backend, ORIGIN);
    const result = await gate.run([w('A', 1)]);
    expect(result).toEqual([outcome('confirmed', 'written', true)]);
    expect(gate.getSnapshot().toasts).toEqual([]);
  });

  it('a single non-confirmed write toasts its detail with no count', async () => {
    const f = fakeBackend({ confirm: false });
    f.st.answers = [outcome('switch_in_progress', 'a switch is in progress; nothing written')];
    const gate = createWriteGate(f.backend, ORIGIN);
    await gate.run([w('A', 1)]);
    expect(gate.getSnapshot().toasts.map((t) => t.text)).toEqual([
      'a switch is in progress; nothing written',
    ]);
  });
});

describe('gate.run — tail writes (momentary, confirmation off)', () => {
  it('sends the tail after the listed writes resolve, as one run and one toast', async () => {
    const f = fakeBackend({ confirm: false });
    f.st.answers = [outcome('confirmed'), outcome('confirmed')];
    const gate = createWriteGate(f.backend, ORIGIN);
    let release!: (w: readonly WriteRequest[]) => void;
    const tail = new Promise<readonly WriteRequest[]>((r) => (release = r));
    const p = gate.run([w('P', 1)], { tail });
    await tick();
    expect(f.sent.map((s) => s.value)).toEqual([1]);
    release([w('P', 0, true)]);
    expect(await p).toHaveLength(2);
    expect(f.sent.map((s) => s.value)).toEqual([1, 0]);
    expect(gate.getSnapshot().toasts.map((t) => t.text)).toEqual(['written']);
  });

  it('does not wait for the tail after a refused press', async () => {
    const f = fakeBackend({ confirm: false });
    f.st.answers = [outcome('refused', 'no')];
    const gate = createWriteGate(f.backend, ORIGIN);
    const never = new Promise<readonly WriteRequest[]>(() => {});
    expect(await gate.run([w('P', 1)], { tail: never })).toEqual([outcome('refused', 'no')]);
    expect(gate.getSnapshot().toasts.map((t) => t.text)).toEqual(['no']);
  });

  it('sends the release after an unknown press', async () => {
    const f = fakeBackend({ confirm: false });
    f.st.answers = [outcome('unknown'), outcome('confirmed')];
    const gate = createWriteGate(f.backend, ORIGIN);
    await gate.run([w('P', 1)], { tail: Promise.resolve([w('P', 0, true)]) });
    expect(f.sent.map((s) => s.value)).toEqual([1, 0]);
  });
});

describe('gate.run — serialisation per screen', () => {
  it('runs multi-write runs one at a time', async () => {
    const f = fakeBackend({ confirm: false });
    const gate = createWriteGate(f.backend, ORIGIN);
    const p1 = gate.run([w('A', 1), w('B', 2)]);
    const p2 = gate.run([w('C', 3), w('D', 4)]);
    await tick();
    expect(f.sent.map((s) => s.pv)).toEqual(['A']);
    f.sent[0].resolve(outcome('confirmed'));
    await tick();
    expect(f.sent.map((s) => s.pv)).toEqual(['A', 'B']);
    f.sent[1].resolve(outcome('confirmed'));
    await p1;
    await tick();
    expect(f.sent.map((s) => s.pv)).toEqual(['A', 'B', 'C']);
    f.sent[2].resolve(outcome('confirmed'));
    await tick();
    f.sent[3].resolve(outcome('confirmed'));
    await p2;
  });

  it('leaves single writes to the SDK (its per-PV slot coalesces them)', async () => {
    const f = fakeBackend({ confirm: false });
    const gate = createWriteGate(f.backend, ORIGIN);
    void gate.run([w('S', 1)]);
    void gate.run([w('S', 2)]);
    void gate.run([w('S', 3)]);
    await tick();
    expect(f.sent.map((s) => s.value)).toEqual([1, 2, 3]);
  });
});

describe('gate.run — never rejects', () => {
  it('resolves unknown when the backend throws', async () => {
    const f = fakeBackend({ confirm: false });
    f.backend.submit = () => Promise.reject(new Error('boom'));
    const gate = createWriteGate(f.backend, ORIGIN);
    const result = await gate.run([w('A', 1)]);
    expect(result).not.toBe('declined');
    expect((result as WriteOutcome[])[0].outcome).toBe('unknown');
  });

  it('an empty run sends nothing and shows nothing', async () => {
    const f = fakeBackend();
    const gate = createWriteGate(f.backend, ORIGIN);
    expect(await gate.run([])).toEqual([]);
    expect(gate.getSnapshot()).toEqual({ dialog: null, toasts: [] });
  });

  it('carries the latest origin', async () => {
    const f = fakeBackend({ confirm: false });
    f.st.answers = [outcome('confirmed')];
    const gate = createWriteGate(f.backend, ORIGIN);
    gate.setOrigin({ screen: 'sr/overview', rev: 'r8' });
    await gate.run([w('A', 1)]);
    expect(f.sent[0].options.origin).toEqual({ screen: 'sr/overview', rev: 'r8' });
  });
});

describe('summarize', () => {
  it('says "written" only when every write of the run was confirmed', () => {
    expect(summarize([outcome('confirmed')], 1)).toEqual({ outcome: 'confirmed', text: 'written' });
    expect(summarize([outcome('confirmed'), outcome('confirmed')], 2)?.text).toBe('written');
    expect(summarize([outcome('confirmed')], 2)?.text).not.toBe('written');
  });

  it('dismisses toasts by id', () => {
    const f = fakeBackend({ confirm: false, seen: false });
    const gate = createWriteGate(f.backend, ORIGIN);
    return gate.run([w('A', 1)]).then(() => {
      const id = gate.getSnapshot().toasts[0].id;
      gate.dismissToast(id);
      expect(gate.getSnapshot().toasts).toEqual([]);
    });
  });
});

describe('gate toasts — leaving, holding, stacking', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** One refused single write, answered at once: one error toast, no timers of its own. */
  async function refuse(
    f: ReturnType<typeof fakeBackend>,
    gate: ReturnType<typeof createWriteGate>,
    text: string
  ) {
    f.st.answers.push(outcome('refused', text));
    await gate.run([w('A', 1)]);
  }

  it('an error toast leaves after 8 s, a "written" one after 6 s', async () => {
    const f = fakeBackend({ confirm: false });
    const gate = createWriteGate(f.backend, ORIGIN);
    await refuse(f, gate, 'no');
    expect(gate.getSnapshot().toasts.map((t) => t.text)).toEqual(['no']);
    vi.advanceTimersByTime(7999);
    expect(gate.getSnapshot().toasts).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(gate.getSnapshot().toasts).toEqual([]);

    f.st.answers.push(outcome('confirmed'));
    await gate.run([w('A', 2)]);
    expect(gate.getSnapshot().toasts.map((t) => t.text)).toEqual(['written']);
    vi.advanceTimersByTime(5999);
    expect(gate.getSnapshot().toasts).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(gate.getSnapshot().toasts).toEqual([]);
  });

  it('holding a toast stops its clock; releasing restarts it in full', async () => {
    const f = fakeBackend({ confirm: false });
    const gate = createWriteGate(f.backend, ORIGIN);
    await refuse(f, gate, 'no');
    const id = gate.getSnapshot().toasts[0].id;
    vi.advanceTimersByTime(5000);
    gate.holdToast(id);
    vi.advanceTimersByTime(60000);
    expect(gate.getSnapshot().toasts).toHaveLength(1);
    gate.releaseToast(id);
    vi.advanceTimersByTime(7999);
    expect(gate.getSnapshot().toasts).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(gate.getSnapshot().toasts).toEqual([]);
  });

  it('holding or releasing an unknown id does nothing', async () => {
    const f = fakeBackend({ confirm: false });
    const gate = createWriteGate(f.backend, ORIGIN);
    await refuse(f, gate, 'no');
    gate.holdToast(999);
    gate.releaseToast(999);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('a fourth toast drops the oldest, and its clock', async () => {
    const f = fakeBackend({ confirm: false });
    const gate = createWriteGate(f.backend, ORIGIN);
    for (const text of ['one', 'two', 'three', 'four']) await refuse(f, gate, text);
    expect(gate.getSnapshot().toasts.map((t) => t.text)).toEqual(['two', 'three', 'four']);
    expect(vi.getTimerCount()).toBe(3);
  });

  it('dismissing and disposing clear the clocks', async () => {
    const f = fakeBackend({ confirm: false });
    const gate = createWriteGate(f.backend, ORIGIN);
    await refuse(f, gate, 'one');
    await refuse(f, gate, 'two');
    gate.dismissToast(gate.getSnapshot().toasts[0].id);
    expect(vi.getTimerCount()).toBe(1);
    gate.dispose();
    expect(vi.getTimerCount()).toBe(0);
    expect(gate.getSnapshot()).toEqual({ dialog: null, toasts: [] });
  });
});

describe('gate.run — the input guard', () => {
  /** A guard whose next paint is immediate. */
  const newGuard = () => createWriteGuard({ nextPaint: (cb) => cb() });

  it('an armed guard refuses a new run: nothing sent, no dialog, the notice', async () => {
    for (const confirm of [true, false]) {
      const f = fakeBackend({ confirm });
      const guard = newGuard();
      const gate = createWriteGate(f.backend, ORIGIN, guard);
      guard.arm();
      expect(await gate.run([w('A', 1)])).toBe('declined');
      await tick();
      expect(f.sent).toEqual([]);
      expect(gate.getSnapshot().dialog).toBeNull();
      expect(gate.getSnapshot().toasts.map((t) => [t.outcome, t.text])).toEqual([
        ['guarded', GUARD_NOTICE],
      ]);
      expect(gate.isBusy()).toBe(false);
    }
  });

  it('refuses a held momentary press that starts while armed, and never waits for its tail', async () => {
    const f = fakeBackend({ confirm: false });
    const guard = newGuard();
    const gate = createWriteGate(f.backend, ORIGIN, guard);
    guard.arm();
    const never = new Promise<readonly WriteRequest[]>(() => {});
    expect(await gate.run([w('P', 1)], { tail: never })).toBe('declined');
    expect(f.sent).toEqual([]);
    expect(gate.isBusy()).toBe(false);
  });

  it('a held momentary press started before the arm still sends its release', async () => {
    const f = fakeBackend({ confirm: false });
    f.st.answers = [outcome('confirmed'), outcome('confirmed')];
    const guard = newGuard();
    const gate = createWriteGate(f.backend, ORIGIN, guard);
    let release!: (w: readonly WriteRequest[]) => void;
    const tail = new Promise<readonly WriteRequest[]>((r) => (release = r));
    const p = gate.run([w('P', 1)], { tail });
    await tick();
    guard.arm();
    release([w('P', 0, true)]);
    expect(await p).toHaveLength(2);
    expect(f.sent.map((s) => s.value)).toEqual([1, 0]);
    expect(gate.getSnapshot().toasts.map((t) => t.text)).toEqual(['written']);
  });

  it('a dialog opened before the arm still sends on confirm', async () => {
    const f = fakeBackend();
    f.st.answers = [outcome('confirmed')];
    const guard = newGuard();
    const gate = createWriteGate(f.backend, ORIGIN, guard);
    const p = gate.run([w('A', 1)]);
    await tick();
    guard.arm();
    gate.confirm(gate.getSnapshot().dialog!.id);
    expect(await p).toEqual([outcome('confirmed')]);
    expect(f.sent.map((s) => s.pv)).toEqual(['A']);
  });

  it('disarms 750 ms after the next paint: a run then sends', async () => {
    vi.useFakeTimers();
    try {
      const f = fakeBackend({ confirm: false });
      f.st.answers = [outcome('confirmed'), outcome('confirmed')];
      const guard = newGuard();
      const gate = createWriteGate(f.backend, ORIGIN, guard);
      guard.arm().startAfterPaint();
      vi.advanceTimersByTime(GUARD_MS - 1);
      expect(await gate.run([w('A', 1)])).toBe('declined');
      vi.advanceTimersByTime(1);
      expect(await gate.run([w('A', 2)])).toEqual([outcome('confirmed')]);
      expect(f.sent.map((s) => s.value)).toEqual([2]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a dropped arm refuses nothing afterwards', async () => {
    const f = fakeBackend({ confirm: false });
    f.st.answers = [outcome('confirmed')];
    const guard = newGuard();
    const gate = createWriteGate(f.backend, ORIGIN, guard);
    guard.arm().drop();
    expect(await gate.run([w('A', 1)])).toEqual([outcome('confirmed')]);
  });

  it('every gate of the window shares the guard', async () => {
    const guard = newGuard();
    const f1 = fakeBackend({ confirm: false });
    const f2 = fakeBackend({ confirm: false });
    const g1 = createWriteGate(f1.backend, ORIGIN, guard);
    const g2 = createWriteGate(f2.backend, { screen: 'sr/rf', rev: null }, guard);
    const arm = guard.arm();
    expect(await g1.run([w('A', 1)])).toBe('declined');
    expect(await g2.run([w('B', 1)])).toBe('declined');
    arm.drop();
    expect(f1.sent).toEqual([]);
    expect(f2.sent).toEqual([]);
  });

  it('does not touch confirmWrites: read once per started run, never by a refused one', async () => {
    const f = fakeBackend({ confirm: false });
    f.st.answers = [outcome('confirmed')];
    const reads = vi.spyOn(f.backend, 'confirmWrites');
    const guard = newGuard();
    const gate = createWriteGate(f.backend, ORIGIN, guard);
    const arm = guard.arm();
    await gate.run([w('A', 1)]);
    expect(reads).not.toHaveBeenCalled();
    arm.drop();
    await gate.run([w('A', 1)]);
    expect(reads).toHaveBeenCalledTimes(1);
  });
});

describe('gate busy (window isOperatorBusy)', () => {
  it('is busy while a momentary press is held, until its release resolves', async () => {
    const f = fakeBackend({ confirm: false });
    const guard = createWriteGuard();
    const heard: boolean[] = [];
    guard.onBusyChange((b) => heard.push(b));
    const gate = createWriteGate(f.backend, ORIGIN, guard);
    let release!: (w: readonly WriteRequest[]) => void;
    const tail = new Promise<readonly WriteRequest[]>((r) => (release = r));
    const p = gate.run([w('P', 1)], { tail });
    expect(gate.isBusy()).toBe(true);
    expect(guard.isOperatorBusy()).toBe(true);
    await tick();
    f.sent[0].resolve(outcome('confirmed'));
    await tick();
    expect(guard.isOperatorBusy()).toBe(true);
    release([w('P', 0, true)]);
    await tick();
    expect(guard.isOperatorBusy()).toBe(true); // the release is in flight
    f.sent[1].resolve(outcome('confirmed'));
    await p;
    expect(gate.isBusy()).toBe(false);
    expect(guard.isOperatorBusy()).toBe(false);
    expect(heard).toEqual([true, false]);
  });

  it('is busy while a dialog is open or queued, not while its single write sends', async () => {
    const f = fakeBackend();
    const guard = createWriteGuard();
    const gate = createWriteGate(f.backend, ORIGIN, guard);
    const p1 = gate.run([w('A', 1)]);
    const p2 = gate.run([w('B', 2)]);
    await tick();
    expect(guard.isOperatorBusy()).toBe(true);
    gate.confirm(gate.getSnapshot().dialog!.id);
    await tick();
    expect(guard.isOperatorBusy()).toBe(true); // B's dialog is open
    gate.decline(gate.getSnapshot().dialog!.id);
    expect(await p2).toBe('declined');
    expect(f.sent.map((s) => s.pv)).toEqual(['A']); // A still sending
    expect(guard.isOperatorBusy()).toBe(false);
    f.sent[0].resolve(outcome('confirmed'));
    await p1;
    expect(guard.isOperatorBusy()).toBe(false);
  });

  it('a confirmed multi-write run stays busy from its dialog through its writes, without a gap', async () => {
    const f = fakeBackend();
    const guard = createWriteGuard();
    const heard: boolean[] = [];
    guard.onBusyChange((b) => heard.push(b));
    const gate = createWriteGate(f.backend, ORIGIN, guard);
    const p = gate.run([w('P', 1), w('P', 0, true)]);
    await tick();
    gate.confirm(gate.getSnapshot().dialog!.id);
    await tick();
    expect(guard.isOperatorBusy()).toBe(true);
    f.sent[0].resolve(outcome('confirmed'));
    await tick();
    f.sent[1].resolve(outcome('confirmed'));
    await p;
    expect(guard.isOperatorBusy()).toBe(false);
    expect(heard).toEqual([true, false]);
  });

  it('a single write with confirmation off is never busy', async () => {
    const f = fakeBackend({ confirm: false });
    const guard = createWriteGuard();
    const heard: boolean[] = [];
    guard.onBusyChange((b) => heard.push(b));
    const gate = createWriteGate(f.backend, ORIGIN, guard);
    const p = gate.run([w('A', 1)]);
    await tick();
    expect(guard.isOperatorBusy()).toBe(false);
    f.sent[0].resolve(outcome('confirmed'));
    await p;
    expect(heard).toEqual([]);
  });

  it('dispose drops the dialog and its busy', async () => {
    const f = fakeBackend();
    const guard = createWriteGuard();
    const gate = createWriteGate(f.backend, ORIGIN, guard);
    const p = gate.run([w('A', 1), w('B', 2)]);
    await tick();
    expect(guard.isOperatorBusy()).toBe(true);
    gate.dispose();
    expect(await p).toBe('declined');
    expect(guard.isOperatorBusy()).toBe(false);
  });

  it('a backend fault ends the busy too', async () => {
    const f = fakeBackend({ confirm: false });
    f.backend.submit = () => Promise.reject(new Error('boom'));
    const guard = createWriteGuard();
    const gate = createWriteGate(f.backend, ORIGIN, guard);
    await gate.run([w('A', 1), w('B', 2)]);
    expect(guard.isOperatorBusy()).toBe(false);
  });
});

const ws = (state: string, reason: string | null = null): HareWrites => ({
  state,
  reason,
  cause: null,
});

describe('gate.writes — the state widgets read', () => {
  it('is live on a legacy socket and on a statement of on', () => {
    const f = fakeBackend();
    const gate = createWriteGate(f.backend, ORIGIN);
    expect(gate.writes()).toEqual({ disabled: false, reason: null });
    f.state(ws('on'));
    expect(gate.writes()).toEqual({ disabled: false, reason: null });
  });

  it('is live with a backend that makes no statement', () => {
    const f = fakeBackend();
    delete f.backend.writes;
    delete f.backend.onWrites;
    const gate = createWriteGate(f.backend, ORIGIN);
    expect(gate.writes()).toEqual({ disabled: false, reason: null });
  });

  it('uses the reason verbatim, else a sentence naming the label', () => {
    const f = fakeBackend();
    f.st.label = 'Simulator';
    const gate = createWriteGate(f.backend, ORIGIN);
    const cases: [HareWrites, string][] = [
      [ws('off', 'narrowed by the operator'), 'narrowed by the operator'],
      [ws('off'), 'Writes are off for Simulator'],
      [ws('locked'), 'Writes are locked for Simulator'],
      [ws('applying'), 'Applying the new write state for Simulator'],
      [ws('frozen'), 'Writes are locked for Simulator'],
    ];
    for (const [writes, reason] of cases) {
      f.state(writes);
      expect(gate.writes()).toEqual({ disabled: true, reason });
    }
    f.st.label = null;
    f.state(ws('off'));
    expect(gate.writes().reason).toBe('Writes are off for this target');
  });

  it('returns the same object while nothing changed', () => {
    const f = fakeBackend();
    const gate = createWriteGate(f.backend, ORIGIN);
    f.state(ws('off'));
    const a = gate.writes();
    f.state(ws('off'));
    expect(gate.writes()).toBe(a);
    f.state(ws('on'));
    const b = gate.writes();
    expect(gate.writes()).toBe(b);
  });

  it('reads "Reconnecting" after a close once a statement was seen, live again after the next first heartbeat', () => {
    const f = fakeBackend({ binding: 'sim@3' });
    f.st.label = 'Simulator';
    const gate = createWriteGate(f.backend, ORIGIN);
    f.state(ws('on'));
    f.close();
    expect(gate.writes()).toEqual({ disabled: true, reason: 'Reconnecting to Simulator' });
    // The new socket: link up and the statement announced before its heartbeat is noted.
    f.st.link = true;
    f.state(ws('on'));
    expect(gate.writes().disabled).toBe(true);
    f.beat({ seen: true, binding: 'sim@3' });
    expect(gate.writes()).toEqual({ disabled: false, reason: null });
  });

  it('is live after a close on a page that never saw a statement', () => {
    const f = fakeBackend();
    const gate = createWriteGate(f.backend, ORIGIN);
    f.close();
    expect(gate.writes()).toEqual({ disabled: false, reason: null });
  });

  it('notifies subscribers on statement and heartbeat changes, and unsubscribes', () => {
    const f = fakeBackend();
    const gate = createWriteGate(f.backend, ORIGIN);
    const calls = vi.fn();
    const off = gate.subscribeWrites(calls);
    f.state(ws('off'));
    expect(calls).toHaveBeenCalledTimes(1);
    f.beat({ seen: true, binding: 'va@1' });
    expect(calls).toHaveBeenCalledTimes(2);
    off();
    expect(f.writeListeners.size).toBe(0);
    expect(f.listeners.size).toBe(0);
    f.state(ws('on'));
    expect(calls).toHaveBeenCalledTimes(2);
  });
});

describe('gate.run — the writes refusal', () => {
  it.each(['off', 'locked', 'applying', 'held', 'frozen'])(
    'under writes: %s sends nothing and opens no dialog, with one "writes changed" toast',
    async (word) => {
      for (const confirm of [true, false]) {
        const f = fakeBackend({ confirm });
        f.st.label = 'Simulator';
        f.state(ws(word));
        const gate = createWriteGate(f.backend, ORIGIN);
        const p = gate.run([w('A', 1)]);
        await tick();
        expect(gate.getSnapshot().dialog).toBeNull();
        expect(await p).toEqual([outcome('target_changed', WRITES_CHANGED_SIM)]);
        expect(f.sent).toEqual([]);
        expect(gate.getSnapshot().toasts.map((t) => t.text)).toEqual([WRITES_CHANGED_SIM]);
      }
    }
  );

  it('refuses a run after a close once a statement was seen: "target changed"', async () => {
    const f = fakeBackend();
    f.state(ws('on'));
    f.close();
    const gate = createWriteGate(f.backend, ORIGIN);
    expect(await gate.run([w('A', 1)])).toEqual([outcome('target_changed', TARGET_CHANGED)]);
    expect(f.sent).toEqual([]);
    expect(gate.getSnapshot().dialog).toBeNull();
  });

  it('a legacy (null) statement on a live socket opens the dialog and sends as before', async () => {
    const f = fakeBackend();
    f.st.answers = [outcome('confirmed')];
    f.state(null);
    const gate = createWriteGate(f.backend, ORIGIN);
    const p = gate.run([w('A', 1)]);
    await tick();
    gate.confirm(gate.getSnapshot().dialog!.id);
    expect(await p).toEqual([outcome('confirmed')]);
    expect(f.sent.map((s) => [s.pv, s.value])).toEqual([['A', 1]]);
  });

  it('a statement of on runs as before', async () => {
    const f = fakeBackend({ confirm: false });
    f.st.answers = [outcome('confirmed')];
    f.state(ws('on'));
    const gate = createWriteGate(f.backend, ORIGIN);
    expect(await gate.run([w('A', 1)])).toEqual([outcome('confirmed')]);
    expect(f.sent).toHaveLength(1);
  });

  it('a run queued behind an open dialog is refused when its turn comes after a flip', async () => {
    const f = fakeBackend();
    f.st.label = 'Simulator';
    f.state(ws('on'));
    const gate = createWriteGate(f.backend, ORIGIN);
    const first = gate.run([w('A', 1)]);
    const second = gate.run([w('B', 2)]);
    await tick();
    const id = gate.getSnapshot().dialog!.id;
    f.state(ws('off'));
    gate.decline(id);
    expect(await first).toBe('declined');
    expect(await second).toEqual([outcome('target_changed', WRITES_CHANGED_SIM)]);
    expect(gate.getSnapshot().dialog).toBeNull();
    expect(f.sent).toEqual([]);
  });
});

// `asked`: live, and every run asks first, whatever confirmWrites says; the
// writes of a confirmed run carry `confirmed: true`. `held`: inert with the
// hold's reason. A word change under an open dialog closes it, `asked` <-> `on`
// included.
describe('gate.run — asked and held', () => {
  const asked = () => ws('asked');
  const held = (reason: string | null = 'writes are held while a watchdog flag is open') =>
    ws('held', reason);

  it('under asked a run opens the dialog with confirmWrites off; confirm sends every write with confirmed: true', async () => {
    const f = fakeBackend({ confirm: false });
    f.st.answers = [outcome('confirmed'), outcome('confirmed')];
    f.state(asked());
    const gate = createWriteGate(f.backend, ORIGIN);
    expect(gate.writes()).toEqual({ disabled: false, reason: null });
    expect(gate.confirmWrites()).toBe(true);
    const p = gate.run([w('A', 1), w('B', 2)]);
    await tick();
    const dialog = gate.getSnapshot().dialog!;
    expect(dialog.writes).toEqual([w('A', 1), w('B', 2)]);
    expect(f.sent).toEqual([]);
    gate.confirm(dialog.id);
    expect(await p).toEqual([outcome('confirmed'), outcome('confirmed')]);
    expect(f.sent.map((s) => [s.pv, s.options])).toEqual([
      ['A', { origin: ORIGIN, binding: 'va@1', confirmed: true }],
      ['B', { origin: ORIGIN, binding: 'va@1', confirmed: true }],
    ]);
  });

  it('under asked the momentary release and the tail carry confirmed: true too', async () => {
    const f = fakeBackend({ confirm: false });
    f.st.answers = [outcome('confirmed'), outcome('confirmed')];
    f.state(asked());
    const gate = createWriteGate(f.backend, ORIGIN);
    const p = gate.run([w('P', 1)], { tail: Promise.resolve([w('P', 0, true)]) });
    await tick();
    gate.confirm(gate.getSnapshot().dialog!.id);
    expect(await p).toEqual([outcome('confirmed'), outcome('confirmed')]);
    expect(f.sent.map((s) => [s.pv, s.value, s.options.confirmed])).toEqual([
      ['P', 1, true],
      ['P', 0, true],
    ]);
  });

  it('under asked decline sends nothing', async () => {
    const f = fakeBackend({ confirm: false });
    f.state(asked());
    const gate = createWriteGate(f.backend, ORIGIN);
    const p = gate.run([w('A', 1)]);
    await tick();
    gate.decline(gate.getSnapshot().dialog!.id);
    expect(await p).toBe('declined');
    expect(f.sent).toEqual([]);
    expect(gate.getSnapshot().toasts).toEqual([]);
  });

  it('confirmWrites() reads the page under on and true under asked, at each run', async () => {
    const f = fakeBackend({ confirm: false });
    f.state(ws('on'));
    const gate = createWriteGate(f.backend, ORIGIN);
    expect(gate.confirmWrites()).toBe(false);
    f.state(asked());
    expect(gate.confirmWrites()).toBe(true);
    f.state(ws('on'));
    expect(gate.confirmWrites()).toBe(false);
  });

  it.each([
    ['asked', 'held', held()],
    ['asked', 'on', ws('on')],
    ['on', 'asked', ws('asked')],
  ])(
    '%s -> %s while the dialog is open closes it: "writes changed", nothing sent',
    async (from, _to, next) => {
      const f = fakeBackend({ confirm: true });
      f.st.label = 'Simulator';
      f.state(ws(from));
      const gate = createWriteGate(f.backend, ORIGIN);
      const p = gate.run([w('A', 1)]);
      await tick();
      expect(gate.getSnapshot().dialog).not.toBeNull();
      f.state(next);
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
      expect(gate.getSnapshot().dialog).toBeNull();
      expect(await p).toEqual([outcome('target_changed', WRITES_CHANGED_SIM)]);
      expect(f.sent).toEqual([]);
      expect(gate.getSnapshot().toasts.map((t) => t.text)).toEqual([WRITES_CHANGED_SIM]);
    }
  );

  it('confirm() under asked re-checks the statement: held unannounced is "writes changed"', async () => {
    const f = fakeBackend({ confirm: false });
    f.st.label = 'Simulator';
    f.state(asked());
    const gate = createWriteGate(f.backend, ORIGIN);
    const p = gate.run([w('A', 1)]);
    await tick();
    const id = gate.getSnapshot().dialog!.id;
    f.st.writes = held();
    gate.confirm(id);
    expect(await p).toEqual([outcome('target_changed', WRITES_CHANGED_SIM)]);
    expect(f.sent).toEqual([]);
  });

  it('held is inert with the hold\'s reason, else "Writes are held for <label>"', () => {
    const f = fakeBackend();
    f.st.label = 'Simulator';
    const gate = createWriteGate(f.backend, ORIGIN);
    f.state(held());
    expect(gate.writes()).toEqual({
      disabled: true,
      reason: 'writes are held while a watchdog flag is open',
    });
    f.state(held(null));
    expect(gate.writes()).toEqual({ disabled: true, reason: 'Writes are held for Simulator' });
  });
});

// The SDK's heartbeat vectors, replayed in the SDK's event order: a frame
// announces its statement (store) before its heartbeat is noted; a close
// clears the statement, then forgets the heartbeat.
interface VectorFrame {
  label: string | null;
  binding: string | null;
  writes?: HareWrites | null;
}
interface VectorExpected {
  inert: boolean;
  hover: string | null;
}
interface Vectors {
  writes_frames: { case: string; frame: VectorFrame; expected: VectorExpected }[];
  sequences: {
    id: string;
    steps: { event: 'frame' | 'close'; frame?: VectorFrame; expected: VectorExpected }[];
  }[];
}
const VECTORS: Vectors = JSON.parse(
  readFileSync(
    createRequire(import.meta.url).resolve('../../e2e/fixtures/contracts/heartbeat_vectors.json'),
    'utf8'
  )
) as Vectors;

function replayFrame(f: ReturnType<typeof fakeBackend>, frame: VectorFrame): void {
  f.st.link = true;
  f.st.label = frame.label;
  f.state(frame.writes ?? null);
  if (!f.st.hb.seen || f.st.hb.binding !== frame.binding) {
    f.beat({ seen: true, binding: frame.binding });
  }
}

/** The gate's state as the vectors' inert/hover (a live widget has no hover). */
function asVector(gate: ReturnType<typeof createWriteGate>): VectorExpected {
  const s = gate.writes();
  return { inert: s.disabled, hover: s.reason };
}

describe('gate.writes — heartbeat vectors', () => {
  it.each(VECTORS.writes_frames.map((v) => [v.case, v] as const))('writes_frames %s', (_, v) => {
    const f = fakeBackend({ seen: false });
    const gate = createWriteGate(f.backend, ORIGIN);
    replayFrame(f, v.frame);
    expect(asVector(gate)).toEqual({ inert: v.expected.inert, hover: v.expected.hover });
  });

  it.each(VECTORS.sequences.map((v) => [v.id, v] as const))('sequence %s', (_, v) => {
    const f = fakeBackend({ seen: false });
    const gate = createWriteGate(f.backend, ORIGIN);
    v.steps.forEach((step, i) => {
      if (step.event === 'close') f.close();
      else replayFrame(f, step.frame!);
      expect({ step: i, ...asVector(gate) }).toEqual({
        step: i,
        inert: step.expected.inert,
        hover: step.expected.hover,
      });
    });
  });
});

// An open dialog against the write statement ("writes changed"): a live `off`,
// `locked` or unknown word closes it with "writes changed"; a socket close or a live
// `applying` frame closes it at once with its toast chosen on the next
// socket's first heartbeat ("writes changed" for the same binding under another write
// state, else "target changed"), or "target changed" once a bound passes.
describe('gate.run — an open dialog and the write statement', () => {
  const flush = async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  };
  const texts = (gate: ReturnType<typeof createWriteGate>) =>
    gate.getSnapshot().toasts.map((t) => t.text);
  const TARGET_CHANGED_OUT = [outcome('target_changed', TARGET_CHANGED)];
  const WRITES_CHANGED_OUT = [outcome('target_changed', WRITES_CHANGED_SIM)];

  /** A Simulator page on sim@3 whose statement is `on`. */
  function simulator() {
    const f = fakeBackend({ binding: 'sim@3' });
    f.st.label = 'Simulator';
    f.state(ws('on'));
    return f;
  }

  /** The next socket opens, then its first frame: the statement, then the heartbeat. */
  function nextSocket(
    f: ReturnType<typeof fakeBackend>,
    binding: string,
    writes: HareWrites | null
  ) {
    f.st.link = true;
    for (const l of [...f.writeListeners]) l();
    f.state(writes);
    f.beat({ seen: true, binding });
  }

  it.each(['off', 'locked', 'frozen'])(
    'a live frame saying %s closes it: one "writes changed" toast, nothing sent',
    async (word) => {
      const f = simulator();
      const gate = createWriteGate(f.backend, ORIGIN);
      const p = gate.run([w('A', 1)]);
      expect(gate.getSnapshot().dialog).not.toBeNull();
      f.state(ws(word));
      await flush();
      expect(gate.getSnapshot().dialog).toBeNull();
      expect(await p).toEqual(WRITES_CHANGED_OUT);
      expect(f.sent).toEqual([]);
      expect(texts(gate)).toEqual([WRITES_CHANGED_SIM]);
    }
  );

  it('a frame that changes the binding and says off is a binding change: "target changed", no "writes changed"', async () => {
    const f = simulator();
    const gate = createWriteGate(f.backend, ORIGIN);
    const p = gate.run([w('A', 1)]);
    f.state(ws('off'));
    f.beat({ seen: true, binding: 'bts@4' });
    await flush();
    expect(await p).toEqual(TARGET_CHANGED_OUT);
    expect(texts(gate)).toEqual([TARGET_CHANGED]);
  });

  it('a live frame saying on, or a legacy one, leaves it open', async () => {
    const f = simulator();
    const gate = createWriteGate(f.backend, ORIGIN);
    void gate.run([w('A', 1)]);
    f.state(ws('on', 'still on'));
    f.state(null);
    await flush();
    expect(gate.getSnapshot().dialog).not.toBeNull();
    expect(texts(gate)).toEqual([]);
  });

  it('a socket close closes it at once; same binding and writes changed on the next socket: "writes changed"', async () => {
    const f = simulator();
    const gate = createWriteGate(f.backend, ORIGIN);
    const p = gate.run([w('A', 1)]);
    f.close();
    expect(gate.getSnapshot().dialog).toBeNull();
    expect(await p).toEqual(TARGET_CHANGED_OUT);
    expect(texts(gate)).toEqual([]);
    nextSocket(f, 'sim@3', ws('off'));
    expect(texts(gate)).toEqual([WRITES_CHANGED_SIM]);
    expect(f.sent).toEqual([]);
  });

  it('same binding and the same writes on the next socket: "target changed"', async () => {
    const f = simulator();
    const gate = createWriteGate(f.backend, ORIGIN);
    const p = gate.run([w('A', 1)]);
    f.close();
    expect(await p).toEqual(TARGET_CHANGED_OUT);
    nextSocket(f, 'sim@3', ws('on'));
    expect(texts(gate)).toEqual([TARGET_CHANGED]);
  });

  it('another binding on the next socket: "target changed" even when its writes differ', async () => {
    const f = simulator();
    const gate = createWriteGate(f.backend, ORIGIN);
    void gate.run([w('A', 1)]);
    f.close();
    nextSocket(f, 'bts@4', ws('off'));
    expect(texts(gate)).toEqual([TARGET_CHANGED]);
  });

  it('a legacy dialog closed by a close, next socket legacy on the same binding: "target changed"', async () => {
    const f = fakeBackend({ binding: 'sim@3' });
    const gate = createWriteGate(f.backend, ORIGIN);
    const p = gate.run([w('A', 1)]);
    f.st.link = false;
    f.beat({ seen: false, binding: null });
    expect(await p).toEqual(TARGET_CHANGED_OUT);
    expect(texts(gate)).toEqual([]);
    nextSocket(f, 'sim@3', null);
    expect(texts(gate)).toEqual([TARGET_CHANGED]);
  });

  it('runs queued behind a dialog a close closed share its one toast', async () => {
    const f = simulator();
    const gate = createWriteGate(f.backend, ORIGIN);
    const p1 = gate.run([w('A', 1)]);
    const p2 = gate.run([w('B', 2)]);
    const p3 = gate.run([w('C', 3)]);
    f.close();
    expect(await p1).toEqual(TARGET_CHANGED_OUT);
    expect(await p2).toEqual(TARGET_CHANGED_OUT);
    expect(await p3).toEqual(TARGET_CHANGED_OUT);
    expect(gate.getSnapshot().dialog).toBeNull();
    expect(texts(gate)).toEqual([]);
    nextSocket(f, 'sim@3', ws('off'));
    expect(texts(gate)).toEqual([WRITES_CHANGED_SIM]);
    expect(f.sent).toEqual([]);
  });

  it('a target switch: applying (switching) closes it, close, another binding: one "target changed"', async () => {
    const f = simulator();
    const gate = createWriteGate(f.backend, ORIGIN);
    const p1 = gate.run([w('A', 1)]);
    const p2 = gate.run([w('B', 2)]);
    f.state({ state: 'applying', reason: 'the control target is changing', cause: 'switching' });
    await flush();
    expect(gate.getSnapshot().dialog).toBeNull();
    expect(await p1).toEqual(TARGET_CHANGED_OUT);
    expect(await p2).toEqual(TARGET_CHANGED_OUT);
    expect(texts(gate)).toEqual([]);
    f.close();
    nextSocket(f, 'bts@4', ws('on'));
    expect(texts(gate)).toEqual([TARGET_CHANGED]);
  });

  it('applying (applying), next socket same binding and on: one "target changed", no "writes changed"', async () => {
    const f = simulator();
    const gate = createWriteGate(f.backend, ORIGIN);
    const p = gate.run([w('A', 1)]);
    f.state({ state: 'applying', reason: 'applying the new write state', cause: 'applying' });
    await flush();
    expect(await p).toEqual(TARGET_CHANGED_OUT);
    f.close();
    nextSocket(f, 'sim@3', ws('on'));
    expect(texts(gate)).toEqual([TARGET_CHANGED]);
  });

  it('applying, next socket same binding and off: "writes changed"', async () => {
    const f = simulator();
    const gate = createWriteGate(f.backend, ORIGIN);
    void gate.run([w('A', 1)]);
    f.state(ws('applying'));
    await flush();
    f.close();
    nextSocket(f, 'sim@3', ws('off'));
    expect(texts(gate)).toEqual([WRITES_CHANGED_SIM]);
  });

  it('confirm() re-checks the statement: off unannounced is "writes changed", applying waits; nothing sent', async () => {
    const f = simulator();
    const gate = createWriteGate(f.backend, ORIGIN);
    const p = gate.run([w('A', 1)]);
    f.st.writes = ws('off');
    gate.confirm(gate.getSnapshot().dialog!.id);
    expect(await p).toEqual(WRITES_CHANGED_OUT);
    expect(texts(gate)).toEqual([WRITES_CHANGED_SIM]);

    const g = simulator();
    const gate2 = createWriteGate(g.backend, ORIGIN);
    const q = gate2.run([w('A', 1)]);
    g.st.writes = ws('applying');
    gate2.confirm(gate2.getSnapshot().dialog!.id);
    expect(await q).toEqual(TARGET_CHANGED_OUT);
    expect(texts(gate2)).toEqual([]);
    expect([...f.sent, ...g.sent]).toEqual([]);
  });

  it('dispose while a toast waits: no toast, every listener gone', async () => {
    const f = simulator();
    const gate = createWriteGate(f.backend, ORIGIN);
    void gate.run([w('A', 1)]);
    f.close();
    gate.dispose();
    expect(f.listeners.size).toBe(0);
    expect(f.writeListeners.size).toBe(0);
    nextSocket(f, 'sim@3', ws('off'));
    expect(gate.getSnapshot().toasts).toEqual([]);
  });

  it('a row 3a refusal shows its toast; a later flip to off adds no gate toast', async () => {
    const f = fakeBackend({ confirm: false, binding: 'sim@3' });
    f.st.label = 'Simulator';
    f.state(ws('on'));
    const row3a = 'the write state of this target changed; nothing written';
    f.st.answers = [
      {
        outcome: 'refused',
        code: 'pv_write_refused',
        status: 403,
        detail: row3a,
        coalesced: false,
      },
    ];
    const gate = createWriteGate(f.backend, ORIGIN);
    await gate.run([w('A', 1)]);
    f.state(ws('off'));
    await flush();
    expect(texts(gate)).toEqual([row3a]);
  });

  describe('the bounds', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('a first heartbeat later than interval + 1 s after the next socket opens: "target changed" at the bound', async () => {
      const f = simulator();
      const gate = createWriteGate(f.backend, ORIGIN);
      void gate.run([w('A', 1)]);
      f.close();
      vi.advanceTimersByTime(250);
      f.st.link = true;
      for (const l of [...f.writeListeners]) l();
      vi.advanceTimersByTime(5999);
      expect(texts(gate)).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(texts(gate)).toEqual([TARGET_CHANGED]);
      f.state(ws('off'));
      f.beat({ seen: true, binding: 'sim@3' });
      expect(texts(gate)).toEqual([TARGET_CHANGED]);
    });

    it('a first heartbeat inside the bound still chooses', async () => {
      const f = simulator();
      const gate = createWriteGate(f.backend, ORIGIN);
      void gate.run([w('A', 1)]);
      f.close();
      f.st.link = true;
      for (const l of [...f.writeListeners]) l();
      vi.advanceTimersByTime(5999);
      f.state(ws('off'));
      f.beat({ seen: true, binding: 'sim@3' });
      expect(texts(gate)).toEqual([WRITES_CHANGED_SIM]);
      expect(vi.getTimerCount()).toBe(1); // the toast's own leave-clock only
    });

    it('no next socket within 30 s of the close: "target changed" at 30 s', async () => {
      const f = simulator();
      const gate = createWriteGate(f.backend, ORIGIN);
      void gate.run([w('A', 1), w('B', 2)]);
      f.close();
      vi.advanceTimersByTime(29999);
      expect(texts(gate)).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(texts(gate)).toEqual([`${TARGET_CHANGED} (0 of 2 written)`]);
    });
  });
});
