// The machine toasts of one page: a visual note when the page's control
// target stops or starts answering, or when its writes are turned on or off.
// The badge (TargetBadge) is the page's one live region and always says the
// current state; these toasts only mark a change, and are never announced.
//
// The emitter reads the page's backend badge store (backendBadge.ts) and
// keeps a page-lifetime memory for the current binding: the last definite
// reachability (`yes` / `no`) and the last definite write state (`on`,
// `off`, `locked`, `held`; `asked` reads `on`, since writes stay available,
// and a word this client does not know reads `locked`).
//
//   definite only   a toast marks a change between two definite states of
//                   the same binding. `unknown`, `applying`, a frame with no
//                   claim and a socket gap neither toast nor change the
//                   memory, so a gap followed by the same state is silent and
//                   a successor whose first heartbeat differs toasts once.
//   first frame     the first definite state of a binding (the page's first
//                   heartbeat, or the first after a binding change) is stored
//                   without a toast.
//   binding         a heartbeat for another binding resets the memory
//                   silently, and with it the reachability limiter.
//   limiter         reachability toasts pass a trailing limiter of
//                   REACH_LIMIT_MS: the first change toasts at once and opens
//                   the window; changes inside it are only recorded; at its
//                   end the then-current state toasts if it differs from the
//                   last one toasted (and opens a new window).
//   writes          `on` reads "Writes are on for <label>"; `off` / `locked` /
//                   `held` the statement's reason with its first letter
//                   upper-cased, or "Writes are off|locked|held for <label>"
//                   when it has none.
//                   The toast waits one task: when a screen's write gate
//                   reports the same change (its "writes changed" toast, a dialog that
//                   the change closed), the machine toast is dropped.
//
// It reads the store between activate() and dispose().
// The list is the page's own, outside the gates' TOAST_CAP: each toast
// leaves after TOAST_MS unless held (hovered or focused), or when closed.

import { clientOutcome } from '@slaclab/canopy-client';
import type { HareReachable, HareWrites } from '@slaclab/canopy-client';
import type { BackendBadgeState } from '../backendBadge.js';
import { TOAST_MS } from './gate.js';

/** The trailing window of the reachability toasts. */
export const REACH_LIMIT_MS = 10000;
/** How far back a gate's "writes changed" toast still covers a machine writes toast. */
export const GATE_REPORT_WINDOW_MS = 1000;

export type MachineToastKind = 'error' | 'success' | 'warning';

export interface MachineToast {
  readonly id: number;
  readonly kind: MachineToastKind;
  /** The machine label, shown above the text (null when the target has none). */
  readonly title: string | null;
  readonly text: string;
}

export interface MachineToastsState {
  readonly toasts: readonly MachineToast[];
}

/** What the emitter reads: the page's backend badge store. */
export interface MachineStatementSource {
  subscribe(listener: () => void): () => void;
  getSnapshot(): BackendBadgeState;
}

/** The part of a screen's write gate the emitter watches. */
export interface GateToastSource {
  subscribe(listener: () => void): () => void;
  getSnapshot(): {
    readonly toasts: readonly {
      readonly id: number;
      readonly outcome: string;
      readonly text: string;
    }[];
  };
}

/** The write gates of one page, so the emitter can see a change they reported. */
export interface MachineGateRegistry {
  /** Watch `gate` until the returned function is called. */
  add(gate: GateToastSource): () => void;
  /**
   * Whether a gate showed a `target_changed` toast starting with `text` at or
   * after `since` (epoch ms); each matching report is used up.
   */
  takeReport(text: string, since: number): boolean;
}

export function createGateRegistry(now: () => number = Date.now): MachineGateRegistry {
  let reports: { at: number; text: string }[] = [];
  return {
    add(gate) {
      let seen = gate.getSnapshot().toasts.reduce((max, t) => Math.max(max, t.id), 0);
      const off = gate.subscribe(() => {
        for (const t of gate.getSnapshot().toasts) {
          if (t.id <= seen) continue;
          seen = t.id;
          if (t.outcome === 'target_changed') reports.push({ at: now(), text: t.text });
        }
        const horizon = now() - GATE_REPORT_WINDOW_MS;
        reports = reports.filter((r) => r.at >= horizon);
      });
      return off;
    },
    takeReport(text, since) {
      const hit = reports.some((r) => r.at >= since && r.text.startsWith(text));
      if (hit) reports = reports.filter((r) => !(r.at >= since && r.text.startsWith(text)));
      return hit;
    },
  };
}

export interface MachineToaster {
  subscribe(listener: () => void): () => void;
  getSnapshot(): MachineToastsState;
  dismiss(id: number): void;
  /** Keep toast `id` until released (pointer over it, or focus inside). */
  hold(id: number): void;
  /** Let a held toast leave after its full time again. */
  release(id: number): void;
  /** Start (or restart after a dispose) reading the store; the memory is kept. */
  activate(): void;
  /** Stop reading the store and drop every toast clock. */
  dispose(): void;
}

type Reach = 'yes' | 'no';
type Writes = 'on' | 'off' | 'locked' | 'held';

function definiteReach(r: HareReachable | null): Reach | null {
  const word = r?.state;
  return word === 'yes' ? 'yes' : word === 'no' ? 'no' : null;
}

function definiteWrites(w: HareWrites | null): Writes | null {
  if (w === null || w.state === 'applying') return null;
  if (w.state === 'on' || w.state === 'asked') return 'on';
  if (w.state === 'off') return 'off';
  if (w.state === 'held') return 'held';
  return 'locked';
}

function capitalised(text: string): string {
  return text.length === 0 ? text : text[0].toUpperCase() + text.slice(1);
}

/** The text of a writes toast for the definite state `word` of `w`. */
export function writesToastText(word: Writes, w: HareWrites, label: string | null): string {
  const target = label ?? 'this target';
  if (word === 'on') return `Writes are on for ${target}`;
  if (w.reason != null && w.reason !== '') return capitalised(w.reason);
  return `Writes are ${word} for ${target}`;
}

/** The text of a reachability toast. */
export function reachToastText(reach: Reach, label: string | null): string {
  const target = label ?? 'This target';
  return reach === 'no' ? `${target} stopped answering` : `${target} is answering again`;
}

interface Memory {
  binding: string | null;
  reach: Reach | null;
  writes: Writes | null;
  /** The reachability last toasted (or first stored), the limiter's reference. */
  toastedReach: Reach | null;
}

const EMPTY: MachineToastsState = Object.freeze({ toasts: Object.freeze([]) });

export function createMachineToasts(
  source: MachineStatementSource,
  options: { gates?: MachineGateRegistry | null; now?: () => number } = {}
): MachineToaster {
  const now = options.now ?? Date.now;
  const gates = options.gates ?? null;
  let state: MachineToastsState = EMPTY;
  const listeners = new Set<() => void>();
  let nextId = 1;
  let memory: Memory | null = null;
  let limiter: ReturnType<typeof setTimeout> | null = null;
  const pending = new Set<ReturnType<typeof setTimeout>>();
  const leave = new Map<number, ReturnType<typeof setTimeout>>();
  let active = false;
  let unsubscribe: (() => void) | null = null;

  function setState(next: MachineToastsState): void {
    state = next;
    for (const l of [...listeners]) l();
  }

  function clearLeave(id: number): void {
    const t = leave.get(id);
    if (t !== undefined) clearTimeout(t);
    leave.delete(id);
  }

  function remove(id: number): void {
    clearLeave(id);
    if (!state.toasts.some((t) => t.id === id)) return;
    setState(Object.freeze({ toasts: Object.freeze(state.toasts.filter((t) => t.id !== id)) }));
  }

  function schedule(id: number): void {
    clearLeave(id);
    leave.set(
      id,
      setTimeout(() => remove(id), TOAST_MS)
    );
  }

  function show(kind: MachineToastKind, title: string | null, text: string): void {
    if (!active) return;
    const toast: MachineToast = Object.freeze({ id: nextId++, kind, title, text });
    setState(Object.freeze({ toasts: Object.freeze([...state.toasts, toast]) }));
    schedule(toast.id);
  }

  function toastReach(reach: Reach): void {
    if (memory === null) return;
    memory.toastedReach = reach;
    const label = source.getSnapshot().label;
    show(reach === 'no' ? 'error' : 'success', label, reachToastText(reach, label));
    limiter = setTimeout(endWindow, REACH_LIMIT_MS);
  }

  function endWindow(): void {
    limiter = null;
    if (memory !== null && memory.reach !== null && memory.reach !== memory.toastedReach) {
      toastReach(memory.reach);
    }
  }

  function stopLimiter(): void {
    if (limiter !== null) clearTimeout(limiter);
    limiter = null;
  }

  function toastWrites(
    word: Writes,
    w: HareWrites,
    label: string | null,
    binding: string | null
  ): void {
    const text = writesToastText(word, w, label);
    const since = now() - GATE_REPORT_WINDOW_MS;
    // A gate's "writes changed" toast for this change lands a few microtasks (or, for
    // a deferred dialog, one listener) away from this frame: decide a task later.
    const timer = setTimeout(() => {
      pending.delete(timer);
      if (memory === null || memory.binding !== binding) return;
      if (gates?.takeReport(clientOutcome('write-state-changed', label).detail, since)) return;
      show(word === 'on' ? 'success' : 'warning', label, text);
    }, 0);
    pending.add(timer);
  }

  function observe(): void {
    const s = source.getSnapshot();
    // A gap (or no heartbeat yet) says nothing; the memory stays.
    if (s.link !== 'up' || !s.heartbeat) return;
    if (memory === null || memory.binding !== s.binding) {
      stopLimiter();
      const reach = definiteReach(s.reachable);
      memory = { binding: s.binding, reach, writes: definiteWrites(s.writes), toastedReach: reach };
      return;
    }
    const reach = definiteReach(s.reachable);
    if (reach !== null) {
      if (memory.reach === null) {
        memory.reach = reach;
        memory.toastedReach = reach;
      } else if (reach !== memory.reach) {
        memory.reach = reach;
        if (limiter === null) toastReach(reach);
      }
    }
    const word = definiteWrites(s.writes);
    if (word !== null && s.writes !== null) {
      const before = memory.writes;
      memory.writes = word;
      if (before !== null && before !== word) toastWrites(word, s.writes, s.label, s.binding);
    }
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => state,
    dismiss: remove,
    hold: clearLeave,
    release(id) {
      if (state.toasts.some((t) => t.id === id)) schedule(id);
    },
    activate() {
      if (active) return;
      active = true;
      unsubscribe = source.subscribe(observe);
      observe();
    },
    dispose() {
      active = false;
      unsubscribe?.();
      unsubscribe = null;
      stopLimiter();
      for (const t of pending) clearTimeout(t);
      pending.clear();
      for (const id of [...leave.keys()]) clearLeave(id);
    },
  };
}
