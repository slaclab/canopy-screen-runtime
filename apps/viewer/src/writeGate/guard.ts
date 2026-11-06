// The window's input guard: one registry that every write gate of the window
// consults, so a widget write cannot start just after the agent changed what
// is on screen.
//
//   arm()         a pending arm: every gate refuses runs that start from now
//                 on. It is later started — its GUARD_MS countdown runs from
//                 the next paint (startAfterPaint) or from the next paint
//                 after a given readiness settles (startWhen: a newly mounted
//                 screen's ready render with its embeds resolved or failed) —
//                 or dropped (the command changed nothing). The window is
//                 guarded while any arm is pending or counting.
//   refusal       a gate checks isArmed() at the start of a run only: a run
//                 that started before the arm completes, including a held
//                 momentary button's release.
//   busy          each gate derives its own busy state (an open or queued
//                 dialog, a multi-write run or a tail in flight) and reports
//                 its transitions here; the window is busy while any gate is.
//
// The guard never sends, changes or confirms a write; confirmWrites is not
// touched by it.

/** How long the window stays guarded once an arm has started. */
export const GUARD_MS = 750;

/** The notice a refused run shows. */
export const GUARD_NOTICE = 'screen just changed, nothing sent';

/** One arm of the guard. Each method acts once: later calls, and any call after drop, do nothing. */
export interface GuardArm {
  /** Run the countdown from the next paint. */
  startAfterPaint(): void;
  /** Run the countdown from the next paint after `ready` settles (resolved or rejected). */
  startWhen(ready: PromiseLike<unknown>): void;
  /** Disarm without a countdown. */
  drop(): void;
}

export interface WriteGuard {
  /** A pending arm: the window is guarded from this call on. */
  arm(): GuardArm;
  /** True while any arm is pending or counting. */
  isArmed(): boolean;
  /** A gate's busy transition; `gate` is any stable identity. */
  reportBusy(gate: object, busy: boolean): void;
  /** True while any gate of the window is busy. */
  isOperatorBusy(): boolean;
  /** Called with the new value on each window busy transition. Returns an unsubscribe. */
  onBusyChange(listener: (busy: boolean) => void): () => void;
}

export interface WriteGuardOptions {
  /** Runs `callback` on the next paint (default: rAF, a timer where there is none). */
  nextPaint?: (callback: () => void) => void;
}

function defaultNextPaint(callback: () => void): void {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(callback);
  else setTimeout(callback, 0);
}

type ArmState = 'pending' | 'waiting' | 'counting' | 'done';

export function createWriteGuard(options: WriteGuardOptions = {}): WriteGuard {
  const nextPaint = options.nextPaint ?? defaultNextPaint;
  // Arms that still guard the window: pending, waiting for readiness or a
  // paint, or counting down.
  const live = new Set<object>();
  const busyGates = new Set<object>();
  const busyListeners = new Set<(busy: boolean) => void>();

  function arm(): GuardArm {
    const token = {};
    let state: ArmState = 'pending';
    live.add(token);
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finish = () => {
      state = 'done';
      if (timer !== null) clearTimeout(timer);
      timer = null;
      live.delete(token);
    };
    const countFromPaint = () => {
      nextPaint(() => {
        if (state !== 'waiting') return;
        state = 'counting';
        timer = setTimeout(finish, GUARD_MS);
      });
    };

    return {
      startAfterPaint() {
        if (state !== 'pending') return;
        state = 'waiting';
        countFromPaint();
      },
      startWhen(ready) {
        if (state !== 'pending') return;
        state = 'waiting';
        const go = () => {
          if (state === 'waiting') countFromPaint();
        };
        Promise.resolve(ready).then(go, go);
      },
      drop() {
        if (state === 'done') return;
        finish();
      },
    };
  }

  function isOperatorBusy(): boolean {
    return busyGates.size > 0;
  }

  return {
    arm,
    isArmed: () => live.size > 0,
    reportBusy(gate, busy) {
      const before = isOperatorBusy();
      if (busy) busyGates.add(gate);
      else busyGates.delete(gate);
      const after = isOperatorBusy();
      if (after !== before) for (const l of [...busyListeners]) l(after);
    },
    isOperatorBusy,
    onBusyChange(listener) {
      busyListeners.add(listener);
      return () => {
        busyListeners.delete(listener);
      };
    },
  };
}

/** The guard of this window, shared by every screen's gate. */
export const windowGuard: WriteGuard = createWriteGuard();

/** Arm the window's guard before an agent command is dispatched. */
export function armAgentGuard(): GuardArm {
  return windowGuard.arm();
}

/** True while any write gate of the window has a dialog open or queued, or a multi-write run in flight. */
export function isOperatorBusy(): boolean {
  return windowGuard.isOperatorBusy();
}

/** Subscribe to the window's busy transitions. Returns an unsubscribe. */
export function onBusyChange(listener: (busy: boolean) => void): () => void {
  return windowGuard.onBusyChange(listener);
}
