// The window's input guard: pending arms, the countdown from the next paint
// or from a screen's readiness, drop, overlapping arms, and the window busy
// aggregate over the gates' reports.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GUARD_MS, armAgentGuard, createWriteGuard, windowGuard } from './guard.js';

/** A paint the test triggers by hand. */
function manualPaint() {
  const queued: Array<() => void> = [];
  return {
    nextPaint: (cb: () => void) => {
      queued.push(cb);
    },
    paint() {
      for (const cb of queued.splice(0)) cb();
    },
    pending: () => queued.length,
  };
}

const flushPromises = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('guard arms', () => {
  it('is unarmed until arm(), then armed at once while pending, however long', () => {
    const p = manualPaint();
    const guard = createWriteGuard({ nextPaint: p.nextPaint });
    expect(guard.isArmed()).toBe(false);
    guard.arm();
    expect(guard.isArmed()).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(guard.isArmed()).toBe(true);
  });

  it('startAfterPaint: the 750 ms run from the next paint, not from the call', () => {
    const p = manualPaint();
    const guard = createWriteGuard({ nextPaint: p.nextPaint });
    const arm = guard.arm();
    arm.startAfterPaint();
    vi.advanceTimersByTime(5_000);
    expect(guard.isArmed()).toBe(true);
    p.paint();
    vi.advanceTimersByTime(GUARD_MS - 1);
    expect(guard.isArmed()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(guard.isArmed()).toBe(false);
  });

  it('startWhen: the countdown waits for readiness, then the next paint', async () => {
    const p = manualPaint();
    const guard = createWriteGuard({ nextPaint: p.nextPaint });
    let ready!: () => void;
    const arm = guard.arm();
    arm.startWhen(new Promise<void>((r) => (ready = r)));
    p.paint();
    vi.advanceTimersByTime(5_000);
    expect(guard.isArmed()).toBe(true);
    expect(p.pending()).toBe(0);
    ready();
    await flushPromises();
    vi.advanceTimersByTime(5_000);
    expect(guard.isArmed()).toBe(true);
    p.paint();
    vi.advanceTimersByTime(GUARD_MS - 1);
    expect(guard.isArmed()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(guard.isArmed()).toBe(false);
  });

  it('startWhen: a failed readiness (embeds failed) starts the countdown too', async () => {
    const p = manualPaint();
    const guard = createWriteGuard({ nextPaint: p.nextPaint });
    guard.arm().startWhen(Promise.reject(new Error('embed failed')));
    await flushPromises();
    p.paint();
    vi.advanceTimersByTime(GUARD_MS);
    expect(guard.isArmed()).toBe(false);
  });

  it('drop disarms at once, pending or counting', () => {
    const p = manualPaint();
    const guard = createWriteGuard({ nextPaint: p.nextPaint });
    guard.arm().drop();
    expect(guard.isArmed()).toBe(false);
    const counting = guard.arm();
    counting.startAfterPaint();
    p.paint();
    vi.advanceTimersByTime(100);
    counting.drop();
    expect(guard.isArmed()).toBe(false);
  });

  it('each method acts once: a second start does not restart, nothing acts after drop', () => {
    const p = manualPaint();
    const guard = createWriteGuard({ nextPaint: p.nextPaint });
    const arm = guard.arm();
    arm.startAfterPaint();
    p.paint();
    vi.advanceTimersByTime(500);
    arm.startAfterPaint();
    arm.startWhen(Promise.resolve());
    p.paint();
    vi.advanceTimersByTime(GUARD_MS - 500);
    expect(guard.isArmed()).toBe(false);

    const dropped = guard.arm();
    dropped.drop();
    dropped.startAfterPaint();
    p.paint();
    expect(guard.isArmed()).toBe(false);
  });

  it('overlapping arms: guarded until the last one expires, a pending one holds it', () => {
    const p = manualPaint();
    const guard = createWriteGuard({ nextPaint: p.nextPaint });
    const a = guard.arm();
    a.startAfterPaint();
    p.paint();
    vi.advanceTimersByTime(500);
    const b = guard.arm();
    vi.advanceTimersByTime(GUARD_MS);
    expect(guard.isArmed()).toBe(true); // a expired, b pending
    b.startAfterPaint();
    p.paint();
    vi.advanceTimersByTime(GUARD_MS - 1);
    expect(guard.isArmed()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(guard.isArmed()).toBe(false);
  });

  it('the default next paint is an animation frame (or a timer)', () => {
    const guard = createWriteGuard();
    guard.arm().startAfterPaint();
    vi.advanceTimersByTime(GUARD_MS - 1);
    expect(guard.isArmed()).toBe(true);
    vi.advanceTimersByTime(100);
    expect(guard.isArmed()).toBe(false);
  });

  it('armAgentGuard arms the window guard', () => {
    const arm = armAgentGuard();
    expect(windowGuard.isArmed()).toBe(true);
    arm.drop();
    expect(windowGuard.isArmed()).toBe(false);
  });
});

describe('window busy', () => {
  it('is busy while any gate reports busy; listeners hear transitions only', () => {
    const guard = createWriteGuard();
    const heard: boolean[] = [];
    const off = guard.onBusyChange((b) => heard.push(b));
    const g1 = {};
    const g2 = {};
    expect(guard.isOperatorBusy()).toBe(false);
    guard.reportBusy(g1, true);
    guard.reportBusy(g2, true);
    guard.reportBusy(g1, true);
    expect(guard.isOperatorBusy()).toBe(true);
    guard.reportBusy(g1, false);
    expect(guard.isOperatorBusy()).toBe(true);
    guard.reportBusy(g2, false);
    expect(guard.isOperatorBusy()).toBe(false);
    guard.reportBusy(g2, false);
    expect(heard).toEqual([true, false]);
    off();
    guard.reportBusy(g1, true);
    expect(heard).toEqual([true, false]);
  });
});
