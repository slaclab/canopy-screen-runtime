// Every widget write goes through this hook — the one place in this package
// that calls a PV handle's put (a static test holds that).
//
// With a provided WriteGate, a machine write becomes one gate run per user
// action. A local channel (loc://, formula://) and every write with no provider
// pass straight through the handle, exactly as before the gate existed.
//
// `disabled` and `reason` carry the gate's writes state for a machine write
// (a local channel or no provider is never disabled). A disabled write still
// goes to the gate, whose refusal sends nothing.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useWriteGate, useWritesState } from './WriteGate.js';
import { WRITES_LIVE, allConfirmed } from './types.js';
import type {
  WriteGateService,
  WriteRequest,
  WriteRunOptions,
  WriteRunResult,
  WriteValue,
} from './types.js';

/** The part of a PV handle a write needs. */
export interface WritableHandle {
  readonly address: string;
  put(value: WriteValue): void;
}

/**
 * `'passthrough'`: written straight through the handle. `'skipped'`: nothing
 * written (no address, or a press while a hold is already in progress).
 * Otherwise the gate run's result.
 */
export type GatedWriteResult = 'passthrough' | 'skipped' | WriteRunResult;

export interface GatedWrite {
  /**
   * Steps whenever a gated run ends with anything but every write confirmed
   * (declined, refused, stopped, ...). Widgets that keep their own selection
   * state key on it, so a value that was not written is not left on screen.
   */
  resetKey: number;
  /** One write as one run; `entered` is the text `value` was parsed from, for the dialog. */
  write(value: WriteValue, options?: { entered?: string }): Promise<GatedWriteResult>;
  /**
   * A momentary press at pointerdown. With confirmation on, `[press, release]`
   * is one run (both shown in the dialog, sent as a pulse). With it off, the
   * press runs now and the release is appended when the pointer comes up — a
   * window-level pointerup/pointercancel for `pointerId`, a document-level
   * lostpointercapture — or when the widget unmounts.
   */
  press(press: WriteValue, release: WriteValue, pointerId?: number): Promise<GatedWriteResult>;
  /** True while the machine does not accept this write: the widget renders inert. */
  disabled: boolean;
  /** Why it is disabled (its description and hover); null while not disabled. */
  reason: string | null;
}

/**
 * Channels that never reach the gate: they keep their per-instance router path.
 * Case-sensitive, as the runtime and its PV routers match them: `LOC://x` is a
 * machine channel and goes through the gate.
 */
const LOCAL_SCHEME = /^(loc|formula):\/\//;

/** The gate a write to `address` goes through, or null to write straight through. */
function gateFor(gate: WriteGateService | null, address: string): WriteGateService | null {
  return gate === null || LOCAL_SCHEME.test(address) ? null : gate;
}

async function runGate(
  gate: WriteGateService,
  writes: readonly WriteRequest[],
  options?: WriteRunOptions
): Promise<WriteRunResult> {
  try {
    return await gate.run(writes, options);
  } catch {
    // The contract says run() never rejects; if it does, nothing is known to
    // be written, which is not all-confirmed.
    return [];
  }
}

export function useGatedWrite(handle: WritableHandle): GatedWrite {
  const gate = useWriteGate();
  const statement = useWritesState();
  const writes = gateFor(gate, handle.address) === null ? WRITES_LIVE : statement;
  const [resetKey, setResetKey] = useState(0);

  // The gate and handle of the latest commit, read by the stable callbacks.
  const latest = useRef({ gate, handle });
  useLayoutEffect(() => {
    latest.current = { gate, handle };
  });

  const mounted = useRef(false);
  // Ends the hold in progress (appends or writes its release), or null.
  const endHold = useRef<(() => void) | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      endHold.current?.();
    };
  }, []);

  const settle = useCallback((result: WriteRunResult) => {
    if (!allConfirmed(result) && mounted.current) setResetKey((k) => k + 1);
  }, []);

  const write = useCallback(
    async (value: WriteValue, options?: { entered?: string }): Promise<GatedWriteResult> => {
      const { gate, handle: h } = latest.current;
      if (!h.address) return 'skipped';
      const g = gateFor(gate, h.address);
      if (g === null) {
        h.put(value);
        return 'passthrough';
      }
      const entered = options?.entered;
      const result = await runGate(g, [
        entered === undefined ? { pv: h.address, value } : { pv: h.address, value, entered },
      ]);
      settle(result);
      return result;
    },
    [settle]
  );

  const press = useCallback(
    async (
      pressValue: WriteValue,
      releaseValue: WriteValue,
      pointerId?: number
    ): Promise<GatedWriteResult> => {
      if (endHold.current) return 'skipped'; // one run per click
      const { gate, handle: h } = latest.current;
      const pv = h.address;
      if (!pv) return 'skipped';
      const g = gateFor(gate, pv);
      const releaseWrite: WriteRequest = { pv, value: releaseValue, release: true };

      if (g !== null && g.confirmWrites()) {
        const result = await runGate(g, [{ pv, value: pressValue }, releaseWrite]);
        settle(result);
        return result;
      }

      // A hold: the release follows the pointer coming up (or unmount).
      const appended: { release?: () => void } = {};
      const tail =
        g === null
          ? null
          : new Promise<readonly WriteRequest[]>((resolve) => {
              appended.release = () => resolve([releaseWrite]);
            });

      const onPointerEnd = (e: Event) => {
        const id = (e as PointerEvent).pointerId;
        if (pointerId !== undefined && id !== undefined && id !== pointerId) return;
        end();
      };
      const end = () => {
        if (endHold.current !== end) return;
        endHold.current = null;
        window.removeEventListener('pointerup', onPointerEnd);
        window.removeEventListener('pointercancel', onPointerEnd);
        document.removeEventListener('lostpointercapture', onPointerEnd);
        if (tail === null) h.put(releaseValue);
        else appended.release?.();
      };
      endHold.current = end;
      window.addEventListener('pointerup', onPointerEnd);
      window.addEventListener('pointercancel', onPointerEnd);
      document.addEventListener('lostpointercapture', onPointerEnd);

      if (g === null || tail === null) {
        h.put(pressValue);
        return 'passthrough';
      }
      const result = await runGate(g, [{ pv, value: pressValue }], { tail });
      settle(result);
      return result;
    },
    [settle]
  );

  const { disabled, reason } = writes;
  return useMemo(
    () => ({ resetKey, write, press, disabled, reason }),
    [resetKey, write, press, disabled, reason]
  );
}
