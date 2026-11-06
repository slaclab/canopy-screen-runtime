// The write gate a composition root provides for machine writes.
//
// Only the viewer provides it (per screen, adapting the SDK's `submit()`).
// With no provider — the builder, mock and fixture modes, any generic host —
// `useGatedWrite` writes straight through the PV handle, as widgets always did,
// and `useWritesState` reads live.

import { createContext, useCallback, useContext, useSyncExternalStore } from 'react';
import { WRITES_LIVE } from './types.js';
import type { WriteGateService, WritesState } from './types.js';

export const WriteGate = createContext<WriteGateService | null>(null);

/** The provided write gate, or null when none is provided. */
export function useWriteGate(): WriteGateService | null {
  return useContext(WriteGate);
}

const NO_SUBSCRIPTION = () => {};

/** The provided gate's writes state; live with no provider or no statement. */
export function useWritesState(): WritesState {
  const gate = useWriteGate();
  const subscribe = useCallback(
    (listener: () => void) => gate?.subscribeWrites?.(listener) ?? NO_SUBSCRIPTION,
    [gate]
  );
  const snapshot = useCallback((): WritesState => gate?.writes?.() ?? WRITES_LIVE, [gate]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
