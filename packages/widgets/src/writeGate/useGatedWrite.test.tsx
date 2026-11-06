// useGatedWrite: pass-through with no provider or for a local channel, one gate
// run per action otherwise, the reset key, the momentary press/release, and the
// writes state (disabled/reason) a machine write reads from the gate.
import type React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { WriteGate, useWritesState } from './WriteGate.js';
import { useGatedWrite } from './useGatedWrite.js';
import type { WritableHandle } from './useGatedWrite.js';
import type {
  WriteGateService,
  WriteOutcome,
  WriteOutcomeKind,
  WriteRequest,
  WriteRunResult,
  WriteValue,
  WritesState,
} from './types.js';

afterEach(cleanup);

/** jsdom has no PointerEvent: a plain event carrying a pointerId. */
function firePointer(target: EventTarget, type: string, pointerId: number) {
  const e = new Event(type, { bubbles: true });
  Object.defineProperty(e, 'pointerId', { value: pointerId });
  target.dispatchEvent(e);
}

function outcome(kind: WriteOutcomeKind): WriteOutcome {
  return { outcome: kind, code: null, status: null, detail: kind, coalesced: false };
}

interface Run {
  writes: WriteRequest[];
  tail?: Promise<readonly WriteRequest[]>;
  tailWrites?: readonly WriteRequest[];
}

/** A gate that records each run and answers every write with `answer`. */
function fakeGate(answer: WriteOutcomeKind | 'declined' | 'reject', confirm = false) {
  const runs: Run[] = [];
  const gate: WriteGateService = {
    confirmWrites: () => confirm,
    run: async (writes, options) => {
      const run: Run = { writes: [...writes], tail: options?.tail };
      runs.push(run);
      if (answer === 'reject') throw new Error('boom');
      if (answer === 'declined') return 'declined';
      const all = [...writes];
      if (options?.tail) {
        run.tailWrites = await options.tail;
        all.push(...run.tailWrites);
      }
      return all.map(() => outcome(answer));
    },
  };
  return { gate, runs };
}

function handle(address: string) {
  const puts: WriteValue[] = [];
  const h: WritableHandle = { address, put: (v) => void puts.push(v) };
  return { h, puts };
}

function withGate(gate: WriteGateService | null) {
  return ({ children }: { children: React.ReactNode }) => (
    <WriteGate.Provider value={gate}>{children}</WriteGate.Provider>
  );
}

describe('useGatedWrite.write', () => {
  it('passes straight through the handle with no provider', async () => {
    const { h, puts } = handle('SIM:X');
    const { result } = renderHook(() => useGatedWrite(h));
    let r: unknown;
    await act(async () => {
      r = await result.current.write(3);
    });
    expect(r).toBe('passthrough');
    expect(puts).toEqual([3]);
    expect(result.current.resetKey).toBe(0);
  });

  it.each(['loc://tv', 'formula://lab/x'])(
    'passes a local channel %s through even with a provider',
    async (address) => {
      const { gate, runs } = fakeGate('confirmed');
      const { h, puts } = handle(address);
      const { result } = renderHook(() => useGatedWrite(h), { wrapper: withGate(gate) });
      await act(async () => {
        await result.current.write(1);
      });
      expect(puts).toEqual([1]);
      expect(runs).toHaveLength(0);
    }
  );

  it('gates an upper-case LOC:// name: the scheme match is case-sensitive', async () => {
    const { gate, runs } = fakeGate('confirmed');
    const { h, puts } = handle('LOC://upper');
    const { result } = renderHook(() => useGatedWrite(h), { wrapper: withGate(gate) });
    await act(async () => {
      await result.current.write(1);
    });
    expect(puts).toEqual([]);
    expect(runs).toHaveLength(1);
  });

  it('sends a machine write as one gate run, never through the handle', async () => {
    const { gate, runs } = fakeGate('confirmed');
    const { h, puts } = handle('SIM:X');
    const { result } = renderHook(() => useGatedWrite(h), { wrapper: withGate(gate) });
    let r: unknown;
    await act(async () => {
      r = await result.current.write('ON');
    });
    expect(puts).toEqual([]);
    expect(runs.map((x) => x.writes)).toEqual([[{ pv: 'SIM:X', value: 'ON' }]]);
    expect(r).toEqual([outcome('confirmed')]);
    expect(result.current.resetKey).toBe(0);
  });

  it('writes nothing for an empty address', async () => {
    const { gate, runs } = fakeGate('confirmed');
    const { h, puts } = handle('');
    const { result } = renderHook(() => useGatedWrite(h), { wrapper: withGate(gate) });
    let r: unknown;
    await act(async () => {
      r = await result.current.write(1);
    });
    expect(r).toBe('skipped');
    expect(puts).toEqual([]);
    expect(runs).toHaveLength(0);
  });

  it.each([
    'declined',
    'mismatch',
    'unconfirmed',
    'unknown',
    'refused',
    'target_changed',
    'switch_in_progress',
    'reject',
  ] as const)('steps the reset key on %s', async (answer) => {
    const { gate } = fakeGate(answer);
    const { h } = handle('SIM:X');
    const { result } = renderHook(() => useGatedWrite(h), { wrapper: withGate(gate) });
    await act(async () => {
      await result.current.write(1);
    });
    expect(result.current.resetKey).toBe(1);
    await act(async () => {
      await result.current.write(2);
    });
    expect(result.current.resetKey).toBe(2);
  });

  it('steps the reset key when a run sends nothing', async () => {
    const gate: WriteGateService = { confirmWrites: () => false, run: async () => [] };
    const { h } = handle('SIM:X');
    const { result } = renderHook(() => useGatedWrite(h), { wrapper: withGate(gate) });
    await act(async () => {
      await result.current.write(1);
    });
    expect(result.current.resetKey).toBe(1);
  });

  it('steps when any write of a run is not confirmed', async () => {
    const mixed: WriteRunResult = [outcome('confirmed'), outcome('mismatch')];
    const gate: WriteGateService = { confirmWrites: () => false, run: async () => mixed };
    const { h } = handle('SIM:X');
    const { result } = renderHook(() => useGatedWrite(h), { wrapper: withGate(gate) });
    await act(async () => {
      await result.current.write(1);
    });
    expect(result.current.resetKey).toBe(1);
  });
});

describe('useGatedWrite.press — confirmation on', () => {
  it('runs [press, release] once at pointerdown as a pulse', async () => {
    const { gate, runs } = fakeGate('confirmed', true);
    const { h, puts } = handle('SIM:BTN');
    const { result } = renderHook(() => useGatedWrite(h), { wrapper: withGate(gate) });
    await act(async () => {
      await result.current.press(1, 0, 7);
    });
    expect(runs).toHaveLength(1);
    expect(runs[0].writes).toEqual([
      { pv: 'SIM:BTN', value: 1 },
      { pv: 'SIM:BTN', value: 0, release: true },
    ]);
    expect(runs[0].tail).toBeUndefined();
    firePointer(window, 'pointerup', 7);
    expect(runs).toHaveLength(1);
    expect(puts).toEqual([]);
  });
});

describe('useGatedWrite.press — confirmation off', () => {
  async function pressHeld(pointerId?: number) {
    const { gate, runs } = fakeGate('confirmed', false);
    const { h, puts } = handle('SIM:BTN');
    const hook = renderHook(() => useGatedWrite(h), { wrapper: withGate(gate) });
    let settled = false;
    let p!: Promise<unknown>;
    act(() => {
      p = hook.result.current.press(1, 0, pointerId).then((r) => {
        settled = true;
        return r;
      });
    });
    await act(async () => {
      await Promise.resolve();
    });
    return { runs, puts, hook, p, isSettled: () => settled };
  }

  it('runs the press at pointerdown and appends the release at window pointerup', async () => {
    const { runs, puts, p, isSettled } = await pressHeld(3);
    expect(runs).toHaveLength(1);
    expect(runs[0].writes).toEqual([{ pv: 'SIM:BTN', value: 1 }]);
    expect(runs[0].tail).toBeDefined();
    expect(isSettled()).toBe(false);
    await act(async () => {
      firePointer(window, 'pointerup', 3);
      await p;
    });
    expect(runs[0].tailWrites).toEqual([{ pv: 'SIM:BTN', value: 0, release: true }]);
    expect(runs).toHaveLength(1); // one run per click
    expect(puts).toEqual([]);
  });

  it('ignores the pointerup of another pointer', async () => {
    const { runs, p, isSettled } = await pressHeld(3);
    await act(async () => {
      firePointer(window, 'pointerup', 4);
      await Promise.resolve();
    });
    expect(isSettled()).toBe(false);
    await act(async () => {
      firePointer(window, 'pointerup', 3);
      await p;
    });
    expect(runs[0].tailWrites).toHaveLength(1);
  });

  it('appends the release on window pointercancel', async () => {
    const { runs, p } = await pressHeld(3);
    await act(async () => {
      firePointer(window, 'pointercancel', 3);
      await p;
    });
    expect(runs[0].tailWrites).toEqual([{ pv: 'SIM:BTN', value: 0, release: true }]);
  });

  it('appends the release on document lostpointercapture', async () => {
    const { runs, p } = await pressHeld(3);
    await act(async () => {
      firePointer(document, 'lostpointercapture', 3);
      await p;
    });
    expect(runs[0].tailWrites).toEqual([{ pv: 'SIM:BTN', value: 0, release: true }]);
  });

  it('appends the release when the widget unmounts mid-hold', async () => {
    const { runs, hook, p } = await pressHeld(3);
    await act(async () => {
      hook.unmount();
      await p;
    });
    expect(runs[0].tailWrites).toEqual([{ pv: 'SIM:BTN', value: 0, release: true }]);
  });

  it('appends the release exactly once', async () => {
    const { runs, hook, p } = await pressHeld(3);
    await act(async () => {
      firePointer(window, 'pointerup', 3);
      firePointer(window, 'pointercancel', 3);
      hook.unmount();
      await p;
    });
    expect(runs).toHaveLength(1);
    expect(runs[0].tailWrites).toHaveLength(1);
  });

  it('starts no second run while a hold is in progress', async () => {
    const { runs, hook, p } = await pressHeld(3);
    let second: unknown;
    await act(async () => {
      second = await hook.result.current.press(1, 0, 5);
    });
    expect(second).toBe('skipped');
    expect(runs).toHaveLength(1);
    await act(async () => {
      firePointer(window, 'pointerup', 3);
      await p;
    });
  });
});

describe('useGatedWrite.press — pass-through', () => {
  it('writes the press now and the release at pointerup, with no provider', () => {
    const { h, puts } = handle('SIM:BTN');
    const { result } = renderHook(() => useGatedWrite(h));
    act(() => {
      void result.current.press(1, 0, 2);
    });
    expect(puts).toEqual([1]);
    firePointer(window, 'pointerup', 2);
    expect(puts).toEqual([1, 0]);
    firePointer(window, 'pointerup', 2);
    expect(puts).toEqual([1, 0]);
  });

  it('writes the release on unmount', () => {
    const { h, puts } = handle('SIM:BTN');
    const { result, unmount } = renderHook(() => useGatedWrite(h));
    act(() => {
      void result.current.press(1, 0, 2);
    });
    unmount();
    expect(puts).toEqual([1, 0]);
  });

  it('passes a loc:// momentary through even with a provider', () => {
    const { gate, runs } = fakeGate('confirmed', true);
    const { h, puts } = handle('loc://m');
    const { result } = renderHook(() => useGatedWrite(h), { wrapper: withGate(gate) });
    act(() => {
      void result.current.press(5, 6, 1);
    });
    firePointer(window, 'pointerup', 1);
    expect(puts).toEqual([5, 6]);
    expect(runs).toHaveLength(0);
  });
});

/** A gate whose writes state the test sets; `set()` notifies subscribers. */
function statedGate(initial: WritesState) {
  const { gate, runs } = fakeGate('confirmed');
  let current = initial;
  const listeners = new Set<() => void>();
  const stated: WriteGateService = {
    ...gate,
    writes: () => current,
    subscribeWrites(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const set = (next: WritesState) => {
    current = next;
    for (const l of [...listeners]) l();
  };
  return { gate: stated, runs, set, listeners };
}

const LOCKED: WritesState = Object.freeze({ disabled: true, reason: 'Interlock tripped' });
const LIVE: WritesState = Object.freeze({ disabled: false, reason: null });

describe('useGatedWrite — writes state', () => {
  it('is not disabled with no provider', () => {
    const { h } = handle('SIM:X');
    const { result } = renderHook(() => useGatedWrite(h));
    expect(result.current.disabled).toBe(false);
    expect(result.current.reason).toBeNull();
  });

  it('is not disabled under a gate that makes no statement', () => {
    const { gate } = fakeGate('confirmed');
    const { h } = handle('SIM:X');
    const { result } = renderHook(() => useGatedWrite(h), { wrapper: withGate(gate) });
    expect(result.current.disabled).toBe(false);
    expect(result.current.reason).toBeNull();
  });

  it('carries an inert gate state for a machine write', () => {
    const { gate } = statedGate(LOCKED);
    const { h } = handle('SIM:X');
    const { result } = renderHook(() => useGatedWrite(h), { wrapper: withGate(gate) });
    expect(result.current.disabled).toBe(true);
    expect(result.current.reason).toBe('Interlock tripped');
  });

  it.each(['loc://a', 'formula://f'])('is never disabled for the local channel %s', (address) => {
    const { gate } = statedGate(LOCKED);
    const { h } = handle(address);
    const { result } = renderHook(() => useGatedWrite(h), { wrapper: withGate(gate) });
    expect(result.current.disabled).toBe(false);
    expect(result.current.reason).toBeNull();
  });

  it('re-renders when the gate notifies a new state, and unsubscribes on unmount', () => {
    const { gate, set, listeners } = statedGate(LIVE);
    const { h } = handle('SIM:X');
    const { result, unmount } = renderHook(() => useGatedWrite(h), { wrapper: withGate(gate) });
    expect(result.current.disabled).toBe(false);
    act(() => set(LOCKED));
    expect(result.current.disabled).toBe(true);
    expect(result.current.reason).toBe('Interlock tripped');
    act(() => set(LIVE));
    expect(result.current.disabled).toBe(false);
    unmount();
    expect(listeners.size).toBe(0);
  });

  it('still hands a disabled write to the gate, never to the handle', async () => {
    const { gate, runs } = statedGate(LOCKED);
    const { h, puts } = handle('SIM:X');
    const { result } = renderHook(() => useGatedWrite(h), { wrapper: withGate(gate) });
    await act(async () => {
      await result.current.write(3);
    });
    expect(runs).toHaveLength(1);
    expect(puts).toEqual([]);
  });
});

describe('useWritesState', () => {
  it('reads live with no provider', () => {
    const { result } = renderHook(() => useWritesState());
    expect(result.current).toEqual({ disabled: false, reason: null });
  });

  it('reads the provided gate state', () => {
    const { gate } = statedGate(LOCKED);
    const { result } = renderHook(() => useWritesState(), { wrapper: withGate(gate) });
    expect(result.current).toBe(LOCKED);
  });
});
