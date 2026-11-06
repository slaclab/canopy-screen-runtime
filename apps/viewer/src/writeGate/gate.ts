// The viewer's write gate: one per open screen, over the hare base only.
//
// It adapts the SDK's `submit()` to the widgets' `WriteGateService`.
//
// A run that sends nothing ends in one of these refusals, named by the toast
// it shows (the SDK's clientOutcome texts):
//
//   "target changed"   clientOutcome('target-changed'): "the control target or its write
//                      state changed; nothing written". The socket closed, the
//                      binding changed, or no heartbeat came in time.
//   "writes changed"   clientOutcome('write-state-changed', label): "the write state of
//                      <label> changed; nothing written". The live socket's
//                      statement says `off`, `locked`, `held` or a word this
//                      client does not know, or it changed under an open
//                      dialog.
//   "coalesced"        WRITE_OUTCOME_COALESCED_TOAST: a newer value replaced the write.
//
// The gate's rules:
//
//   writes()      inert while the live socket's statement is neither `on` nor
//                 `asked` (its reason, else a sentence naming the label; at
//                 `held`, a watchdog's hold on the session, the reason is the
//                 hold's), and while no heartbeat is seen on an open socket
//                 once the page has seen a statement ("Reconnecting to
//                 <label>"). A null statement on a live socket is a legacy
//                 frame: live. Before any statement the page is live, and
//                 run() answers "target changed" as below.
//   run(writes)   refused while writes() is inert: nothing sent, no dialog, one
//                 toast ("writes changed" for a statement, "target changed" for
//                 a closed socket). A run queued behind an open dialog is
//                 re-checked when its turn comes. Otherwise at most one
//                 confirmation dialog (iff confirmWrites, and always under
//                 `asked`), opened only with a seen heartbeat and the link up
//                 (else "target changed"); the binding and statement are
//                 captured when it opens. While it is open, nothing is sent
//                 if: the binding changes on a live socket ("target changed"
//                 at once); a live frame for its binding says a word other
//                 than the one it opened under (`off`, `locked`, `held`, a word
//                 this client does not know, `asked` -> `on` and `on` ->
//                 `asked` alike: "writes changed" at once); the socket closes,
//                 or a live frame says `applying` (either cause). The last two close it
//                 at once and the run answers "target changed" with no toast of
//                 its own: the toast waits for the next socket's first
//                 heartbeat, "writes changed" when it carries the same binding
//                 and a different write state than the dialog opened under,
//                 else "target changed". It is "target changed" too when that
//                 heartbeat is later than FIRST_HEARTBEAT_BOUND_MS after the
//                 next socket opens or CLOSE_TOAST_BOUND_MS after the close.
//                 Runs queued behind a dialog closed this way share its toast:
//                 one for them all. confirm() re-checks all of this, the write
//                 statement included. Then the writes in order, each with the
//                 screen's origin, the captured binding and, after a confirmed
//                 dialog, `confirmed: true` (the `tail` and a momentary release
//                 included), continuing only
//                 after `confirmed`, `mismatch` or `unconfirmed` (a release
//                 write: also after `unknown`), and never after a coalesced
//                 result (it counts as not written). A `tail` is sent after the
//                 listed writes under the same rule. One summary toast, which
//                 leaves on its own (WRITTEN_TOAST_MS for "written", TOAST_MS
//                 otherwise), stays while held (hovered or focused), and is one
//                 of at most TOAST_CAP: a newer one drops the oldest.
//   dialogs       one slot per gate: further runs queue FIFO, never stacked.
//   serialising   multi-write runs (more than one write, or a tail) run one
//                 at a time per screen; a single write goes straight to the
//                 SDK, whose per-PV slot coalesces it.
//   input guard   a run that starts while the window's guard is armed
//                 (guard.ts) sends nothing and opens no dialog; it shows the
//                 notice GUARD_NOTICE and resolves 'declined'. Only the start
//                 is checked: a run already started completes.
//   busy          an open or queued dialog, or a multi-write run (a held
//                 momentary press included) from its start to its end; the
//                 transitions are reported to the window's guard.
//   dispose()     drops queued runs and an open dialog (resolved 'declined',
//                 nothing sent, nothing shown); runs already sending finish
//                 without a toast.
//
// Local channels (loc://, formula://) never reach a gate: the widgets' hook and
// dispatchActions keep them on the instance router.

import { WRITE_OUTCOME_COALESCED_TOAST, clientOutcome } from '@slaclab/canopy-client';
import type {
  HareHeartbeatState,
  HareWrites,
  PVWriteOrigin,
  SubmitOptions,
  WriteOutcome as SdkWriteOutcome,
} from '@slaclab/canopy-client';
import type {
  WriteGateService,
  WriteOutcome,
  WriteOutcomeKind,
  WriteRequest,
  WriteRunOptions,
  WriteRunResult,
  WriteValue,
} from '@slaclab/canopy-screen-widgets';
import { GUARD_NOTICE, windowGuard } from './guard.js';
import type { WriteGuard } from './guard.js';

/** The gate's writes state (the widgets' `WritesState`). */
type WritesState = ReturnType<NonNullable<WriteGateService['writes']>>;

/** The write statement as the page knows it. */
export interface WritesStatement {
  /** The current socket's statement; null before one, on a legacy frame, or after a close. */
  readonly writes: HareWrites | null;
  /** Whether this page has seen a statement on any socket. */
  readonly seen: boolean;
}

/** What a gate needs from the page's Hare connection and config. */
export interface WriteBackend {
  /** The current socket's heartbeat state (`HarePVService.heartbeat()`). */
  heartbeat(): HareHeartbeatState;
  /** True while the Hare socket is connected. */
  linkUp(): boolean;
  /** `HarePVService.submit()`: never rejects. */
  submit(pv: string, value: WriteValue, options: SubmitOptions): Promise<SdkWriteOutcome>;
  /** Heartbeat changes: first heartbeat, binding change, socket close. Returns an unsubscribe. */
  onHeartbeat(listener: (state: HareHeartbeatState) => void): () => void;
  /** The live confirmWrites value (pending or failed re-reads read true). */
  confirmWrites(): boolean;
  /** The machine the writes go to, for the dialog (DATA's label), or null. */
  machineLabel(): string | null;
  /** The write statement; a backend without it makes none (every socket reads legacy). */
  writes?(): WritesStatement;
  /** Statement changes (a new statement, a close clearing it). Returns an unsubscribe. */
  onWrites?(listener: () => void): () => void;
}

/** The open confirmation dialog. */
export interface WriteDialogState {
  readonly id: number;
  readonly writes: readonly WriteRequest[];
  readonly machine: string | null;
}

/**
 * One summary toast. `outcome` is 'confirmed' for "written", 'coalesced' for a
 * coalesce stop, 'guarded' for a run the input guard refused.
 */
export interface WriteToastState {
  readonly id: number;
  readonly outcome: WriteOutcomeKind | 'coalesced' | 'guarded';
  readonly text: string;
}

/** How long a "written" toast stays, and how long any other does, unless held. */
export const WRITTEN_TOAST_MS = 6000;
export const TOAST_MS = 8000;
/** Toasts shown at once; a new one past this drops the oldest. */
export const TOAST_CAP = 3;
/** The broker's heartbeat interval (canopy's hare `heartbeat_interval_s`). */
export const HEARTBEAT_INTERVAL_MS = 5000;
/** How long after the next socket opens its first heartbeat may still choose a closed dialog's toast. */
export const FIRST_HEARTBEAT_BOUND_MS = HEARTBEAT_INTERVAL_MS + 1000;
/** How long after the close a closed dialog's toast may wait at all. */
export const CLOSE_TOAST_BOUND_MS = 30000;

export interface WriteGateState {
  readonly dialog: WriteDialogState | null;
  readonly toasts: readonly WriteToastState[];
}

/** A screen's gate: the widgets' service plus the state its dialog and toasts render. */
export interface ScreenWriteGate extends WriteGateService {
  writes(): WritesState;
  subscribeWrites(listener: () => void): () => void;
  subscribe(listener: () => void): () => void;
  getSnapshot(): WriteGateState;
  /** An open or queued dialog, or a multi-write run in flight. */
  isBusy(): boolean;
  /** Answer the open dialog `id` (a stale id is ignored). */
  confirm(id: number): void;
  decline(id: number): void;
  dismissToast(id: number): void;
  /** Keep toast `id` until released: the pointer is over it, or it has focus. */
  holdToast(id: number): void;
  /** Let a held toast leave after its full time again. */
  releaseToast(id: number): void;
  /** The origin later writes carry (the screen and its revision). */
  setOrigin(origin: PVWriteOrigin): void;
  /** (Re)activate after a dispose (React effects may run twice). */
  activate(): void;
  /** Drop queued runs and the open dialog; no further toasts. */
  dispose(): void;
}

/** Outcomes after which the next write of a run is sent. */
const CONTINUES: ReadonlySet<WriteOutcomeKind> = new Set(['confirmed', 'mismatch', 'unconfirmed']);

/** Whether `next` is sent after `prev` resolved. */
function continuesAfter(prev: WriteOutcome, next: WriteRequest): boolean {
  if (prev.coalesced) return false;
  if (CONTINUES.has(prev.outcome)) return true;
  return next.release === true && prev.outcome === 'unknown';
}

/** A write that counts as written: k of "(k of n written)". */
function counted(o: WriteOutcome): boolean {
  return !o.coalesced && CONTINUES.has(o.outcome);
}

function localOutcome(o: SdkWriteOutcome): WriteOutcome {
  return {
    outcome: o.outcome,
    code: o.code,
    status: o.status,
    detail: o.detail,
    coalesced: o.coalesced,
  };
}

/**
 * The one summary toast of a run of `n` writes that resolved `outcomes`, or
 * null when none is shown: a single coalesced write (the value that replaced
 * it has its own toast). "written" only when all n were confirmed; otherwise
 * the first non-confirmed write's detail (the "coalesced" text for a
 * coalesced one), with "(k of n written)" when n > 1.
 */
export function summarize(
  outcomes: readonly WriteOutcome[],
  n: number
): Omit<WriteToastState, 'id'> | null {
  if (n === 1 && outcomes.length === 1 && outcomes[0].coalesced) return null;
  const first = outcomes.find((o) => o.coalesced || o.outcome !== 'confirmed');
  if (first === undefined && outcomes.length === n && n > 0) {
    return { outcome: 'confirmed', text: 'written' };
  }
  // Fewer outcomes than writes with none failing cannot happen (a run only
  // stops on a failing outcome); read it as nothing written.
  const stop = first ?? localOutcome(clientOutcome('target-changed'));
  const base: Omit<WriteToastState, 'id'> = stop.coalesced
    ? { outcome: 'coalesced', text: WRITE_OUTCOME_COALESCED_TOAST }
    : { outcome: stop.outcome, text: stop.detail };
  if (n <= 1) return base;
  const k = outcomes.filter(counted).length;
  return { ...base, text: `${base.text} (${k} of ${n} written)` };
}

type DialogAnswer =
  | { kind: 'confirmed'; binding: string | null }
  | { kind: 'declined' }
  | { kind: 'dropped' }
  | { kind: 'target_changed' }
  | { kind: 'inert'; outcome: WriteOutcome }
  /** Closed by a socket close or an `applying` frame: "target changed", the toast deferred. */
  | { kind: 'closed' };

interface QueuedDialog {
  writes: readonly WriteRequest[];
  resolve(answer: DialogAnswer): void;
}

interface OpenDialog extends QueuedDialog {
  id: number;
  binding: string | null;
  /** The write state it opened under (a legacy null reads `on`). */
  said: string;
}

/** The one toast of the dialogs a close (or `applying` frame) closed, until it is chosen. */
interface Deferral {
  readonly binding: string | null;
  readonly said: string;
  readonly n: number;
  /** The socket the dialog opened on has closed. */
  closed: boolean;
  /** The next socket is up (its first heartbeat not yet seen). */
  opened: boolean;
  readonly timers: ReturnType<typeof setTimeout>[];
  readonly off: (() => void)[];
}

/** A statement's write state word; a legacy (null) statement is `on`. */
function stateWord(writes: HareWrites | null | undefined): string {
  return writes?.state ?? 'on';
}

/** The words under which writes are accepted: `asked` asks first. */
const LIVE_WORDS: ReadonlySet<string> = new Set(['on', 'asked']);

const EMPTY: WriteGateState = Object.freeze({ dialog: null, toasts: Object.freeze([]) });

const LIVE: WritesState = Object.freeze({ disabled: false, reason: null });

/** The hover of an inert statement: its reason, else a sentence naming the target. */
function statementReason(writes: HareWrites, label: string | null): string {
  if (writes.reason != null) return writes.reason;
  const target = label ?? 'this target';
  if (writes.state === 'off') return `Writes are off for ${target}`;
  if (writes.state === 'held') return `Writes are held for ${target}`;
  if (writes.state === 'applying') return `Applying the new write state for ${target}`;
  // `locked`, and any word this client does not know.
  return `Writes are locked for ${target}`;
}

export function createWriteGate(
  backend: WriteBackend,
  initialOrigin: PVWriteOrigin,
  guard: WriteGuard = windowGuard
): ScreenWriteGate {
  let origin = initialOrigin;
  let state: WriteGateState = EMPTY;
  let active = true;
  let nextId = 1;
  const listeners = new Set<() => void>();
  const queue: QueuedDialog[] = [];
  let open: OpenDialog | null = null;
  let unwatch: (() => void) | null = null;
  let deferred: Deferral | null = null;
  // Tail of the per-screen chain of multi-write runs.
  let serial: Promise<void> = Promise.resolve();
  // One leave-clock per shown toast, by id; cleared on dismiss, hold and dispose.
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  // Runs holding the gate busy: from the start of a run with a dialog (until
  // its answer) or of a multi-write run (until it ends). Counted at the run,
  // not read off the dialog slot, so a confirmed multi-write run stays busy
  // across the step from its dialog to its writes.
  let holds = 0;
  let busy = false;
  const self = {};

  function updateBusy(): void {
    const next = holds > 0 || open !== null || queue.length > 0;
    if (next === busy) return;
    busy = next;
    guard.reportBusy(self, busy);
  }

  function hold(delta: 1 | -1): void {
    holds += delta;
    updateBusy();
  }

  function setState(next: WriteGateState): void {
    state = next;
    for (const l of [...listeners]) l();
  }

  /** A heartbeat seen on an open socket: writes may be offered. */
  function ready(): HareHeartbeatState | null {
    const hb = backend.heartbeat();
    return hb.seen && backend.linkUp() ? hb : null;
  }

  let writesState: WritesState = LIVE;

  /** The current writes state, and the refusal a run gets while it is inert. */
  function statement(): { state: WritesState; refusal: WriteOutcome | null } {
    const said = backend.writes?.() ?? { writes: null, seen: false };
    const label = backend.machineLabel();
    let next: { disabled: boolean; reason: string | null } = LIVE;
    let refusal: WriteOutcome | null = null;
    if (ready() !== null) {
      if (said.writes !== null && !LIVE_WORDS.has(said.writes.state)) {
        next = { disabled: true, reason: statementReason(said.writes, label) };
        refusal = localOutcome(clientOutcome('write-state-changed', label));
      }
    } else if (said.seen) {
      next = { disabled: true, reason: `Reconnecting to ${label ?? 'this target'}` };
      refusal = localOutcome(clientOutcome('target-changed'));
    }
    if (next.disabled !== writesState.disabled || next.reason !== writesState.reason) {
      writesState = next.disabled ? Object.freeze(next) : LIVE;
    }
    return { state: writesState, refusal };
  }

  /** Whether a run opens the dialog: the page's confirmWrites, and always under `asked`. */
  function asks(): boolean {
    return backend.confirmWrites() || stateWord(backend.writes?.().writes) === 'asked';
  }

  /** The one toast and result of a run that sent nothing. */
  function unsent(o: WriteOutcome, n: number): WriteRunResult {
    const outcomes = [o];
    toast(summarize(outcomes, Math.max(n, 1)));
    return outcomes;
  }

  /** Why the open dialog `d` must close now, or null while it may stay open. */
  function verdict(d: OpenDialog): DialogAnswer | null {
    const hb = ready();
    if (hb === null) return { kind: 'closed' };
    if (hb.binding !== d.binding) return { kind: 'target_changed' };
    const word = stateWord(backend.writes?.().writes);
    if (word === d.said) return null;
    if (word === 'applying') return { kind: 'closed' };
    return {
      kind: 'inert',
      outcome: localOutcome(clientOutcome('write-state-changed', backend.machineLabel())),
    };
  }

  /** Show the deferred toast ("writes changed" when `changed`) and stop waiting. */
  function decide(g: Deferral, changed: boolean): void {
    if (deferred !== g) return;
    deferred = null;
    for (const t of g.timers) clearTimeout(t);
    for (const off of g.off) off();
    const o = changed
      ? clientOutcome('write-state-changed', backend.machineLabel())
      : clientOutcome('target-changed');
    toast(summarize([localOutcome(o)], Math.max(g.n, 1)));
  }

  /** Wait for the next socket's first heartbeat to choose `d`'s toast. */
  function defer(d: OpenDialog): void {
    if (deferred !== null) return; // the same close: one toast already waits
    const g: Deferral = {
      binding: d.binding,
      said: d.said,
      n: d.writes.length,
      closed: false,
      opened: false,
      timers: [],
      off: [],
    };
    deferred = g;
    const check = () => {
      if (deferred !== g) return;
      if (!backend.linkUp()) {
        g.closed = true;
        g.opened = false;
        return;
      }
      if (!g.closed) return;
      const hb = backend.heartbeat();
      if (hb.seen) {
        decide(g, hb.binding === g.binding && stateWord(backend.writes?.().writes) !== g.said);
      } else if (!g.opened) {
        g.opened = true;
        g.timers.push(setTimeout(() => decide(g, false), FIRST_HEARTBEAT_BOUND_MS));
      }
    };
    g.timers.push(setTimeout(() => decide(g, false), CLOSE_TOAST_BOUND_MS));
    const offWrites = backend.onWrites?.(check);
    if (offWrites) g.off.push(offWrites);
    g.off.push(backend.onHeartbeat(check));
    check();
  }

  function dropDeferral(): void {
    const g = deferred;
    if (g === null) return;
    deferred = null;
    for (const t of g.timers) clearTimeout(t);
    for (const off of g.off) off();
  }

  function closeDialog(answer: DialogAnswer): void {
    const d = open;
    if (d === null) return;
    open = null;
    unwatch?.();
    unwatch = null;
    if (active) setState({ ...state, dialog: null });
    if (answer.kind === 'closed' && active) {
      defer(d);
      // Runs queued behind it are closed by the same close.
      for (const q of queue.splice(0)) q.resolve({ kind: 'closed' });
    }
    d.resolve(answer);
    pump();
  }

  function pump(): void {
    if (open !== null || !active) return;
    const next = queue.shift();
    if (next === undefined) return;
    const { refusal } = statement();
    if (refusal !== null) {
      next.resolve({ kind: 'inert', outcome: refusal });
      pump();
      return;
    }
    const hb = ready();
    if (hb === null) {
      next.resolve({ kind: 'target_changed' });
      pump();
      return;
    }
    const d: OpenDialog = {
      ...next,
      id: nextId++,
      binding: hb.binding,
      said: stateWord(backend.writes?.().writes),
    };
    open = d;
    const offHeartbeat = backend.onHeartbeat((s) => {
      if (open !== d) return;
      if (!s.seen || !backend.linkUp()) closeDialog({ kind: 'closed' });
      else if (s.binding !== d.binding) closeDialog({ kind: 'target_changed' });
    });
    // A frame announces its statement before its heartbeat is noted: judge a
    // live statement once the same frame's binding is known.
    const offWrites = backend.onWrites?.(() => {
      if (open !== d) return;
      if (!backend.linkUp()) {
        closeDialog({ kind: 'closed' });
        return;
      }
      void Promise.resolve().then(() => {
        if (open !== d) return;
        const v = verdict(d);
        if (v !== null) closeDialog(v);
      });
    });
    unwatch = () => {
      offHeartbeat();
      offWrites?.();
    };
    setState({
      ...state,
      dialog: { id: d.id, writes: d.writes, machine: backend.machineLabel() },
    });
  }

  function askFirst(writes: readonly WriteRequest[]): Promise<DialogAnswer> {
    return new Promise((resolve) => {
      queue.push({ writes, resolve });
      pump();
    });
  }

  function clearToastTimer(id: number): void {
    const timer = timers.get(id);
    if (timer !== undefined) clearTimeout(timer);
    timers.delete(id);
  }

  function removeToast(id: number): void {
    clearToastTimer(id);
    if (!state.toasts.some((t) => t.id === id)) return;
    setState({ ...state, toasts: state.toasts.filter((t) => t.id !== id) });
  }

  function scheduleToast(t: WriteToastState): void {
    clearToastTimer(t.id);
    const ms = t.outcome === 'confirmed' ? WRITTEN_TOAST_MS : TOAST_MS;
    timers.set(
      t.id,
      setTimeout(() => removeToast(t.id), ms)
    );
  }

  function toast(summary: Omit<WriteToastState, 'id'> | null): void {
    if (summary === null || !active) return;
    const next: WriteToastState = { id: nextId++, ...summary };
    const kept = [...state.toasts, next];
    for (const dropped of kept.splice(0, Math.max(0, kept.length - TOAST_CAP))) {
      clearToastTimer(dropped.id);
    }
    setState({ ...state, toasts: kept });
    scheduleToast(next);
  }

  async function send(
    listed: readonly WriteRequest[],
    tail: Promise<readonly WriteRequest[]> | undefined,
    binding: string | null,
    confirmed: boolean
  ): Promise<{ outcomes: WriteOutcome[]; n: number }> {
    const outcomes: WriteOutcome[] = [];
    let n = listed.length;
    let prev: WriteOutcome | null = null;
    const sendOne = async (w: WriteRequest): Promise<boolean> => {
      if (prev !== null && !continuesAfter(prev, w)) return false;
      const options: SubmitOptions = { origin: { ...origin }, binding };
      if (confirmed) options.confirmed = true;
      const o = localOutcome(await backend.submit(w.pv, w.value, options));
      outcomes.push(o);
      prev = o;
      return true;
    };
    for (const w of listed) {
      if (!(await sendOne(w))) return { outcomes, n };
    }
    if (tail !== undefined) {
      // Wait for the tail only when a release could still follow.
      const last: WriteOutcome | null = prev;
      if (last !== null && !continuesAfter(last, { pv: '', value: 0, release: true })) {
        return { outcomes, n };
      }
      let more: readonly WriteRequest[];
      try {
        more = await tail;
      } catch {
        more = [];
      }
      n += more.length;
      for (const w of more) {
        if (!(await sendOne(w))) break;
      }
    }
    return { outcomes, n };
  }

  async function run(
    writes: readonly WriteRequest[],
    options?: WriteRunOptions
  ): Promise<WriteRunResult> {
    const listed = [...writes];
    const tail = options?.tail;
    if (!active) return 'declined';
    if (listed.length === 0 && tail === undefined) return [];
    if (guard.isArmed()) {
      toast({ outcome: 'guarded', text: GUARD_NOTICE });
      return 'declined';
    }
    const { refusal } = statement();
    if (refusal !== null) return unsent(refusal, listed.length);

    const dialog = asks();
    const multi = listed.length > 1 || tail !== undefined;
    let held = dialog || multi;
    if (held) hold(1);
    try {
      let binding: string | null;
      if (dialog) {
        const answer = await askFirst(listed);
        if (!multi) {
          held = false;
          hold(-1);
        }
        if (answer.kind === 'declined' || answer.kind === 'dropped') return 'declined';
        if (answer.kind === 'inert') return unsent(answer.outcome, listed.length);
        if (answer.kind === 'target_changed') {
          return unsent(localOutcome(clientOutcome('target-changed')), listed.length);
        }
        if (answer.kind === 'closed') return [localOutcome(clientOutcome('target-changed'))];
        binding = answer.binding;
      } else {
        const hb = ready();
        if (hb === null)
          return unsent(localOutcome(clientOutcome('target-changed')), listed.length);
        binding = hb.binding;
      }

      let release = () => {};
      if (multi) {
        const previous = serial;
        serial = new Promise<void>((r) => {
          release = r;
        });
        await previous;
      }
      try {
        const { outcomes, n } = await send(listed, tail, binding, dialog);
        toast(summarize(outcomes, n));
        return outcomes;
      } finally {
        release();
      }
    } finally {
      if (held) hold(-1);
    }
  }

  return {
    confirmWrites: asks,
    run: (writes, options) =>
      run(writes, options).catch((): WriteRunResult => {
        // run() never rejects: a fault in the backend is nothing known written.
        return [localOutcome(clientOutcome('client-unknown'))];
      }),
    writes: () => statement().state,
    subscribeWrites(listener) {
      // A heartbeat (first one seen, socket close) moves the state as much as
      // a statement does.
      const offWrites = backend.onWrites?.(listener);
      const offHeartbeat = backend.onHeartbeat(() => listener());
      return () => {
        offWrites?.();
        offHeartbeat();
      };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => state,
    isBusy: () => busy,
    confirm(id) {
      const d = open;
      if (d === null || d.id !== id) return;
      closeDialog(verdict(d) ?? { kind: 'confirmed', binding: d.binding });
    },
    decline(id) {
      if (open !== null && open.id === id) closeDialog({ kind: 'declined' });
    },
    dismissToast(id) {
      removeToast(id);
    },
    holdToast(id) {
      if (state.toasts.some((t) => t.id === id)) clearToastTimer(id);
    },
    releaseToast(id) {
      const held = state.toasts.find((t) => t.id === id);
      if (held !== undefined) scheduleToast(held);
    },
    setOrigin(next) {
      origin = next;
    },
    activate() {
      active = true;
    },
    dispose() {
      active = false;
      for (const q of queue.splice(0)) q.resolve({ kind: 'dropped' });
      closeDialog({ kind: 'dropped' });
      dropDeferral();
      for (const id of [...timers.keys()]) clearToastTimer(id);
      setState(EMPTY);
    },
  };
}
