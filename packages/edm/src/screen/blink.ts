// EDM's colour blink: one flag for the whole application, toggled every
// `blinkms` of colors.list (clamped to 250..2000 ms, default 500); every
// blinking colour shows its first triplet, then its second. The harness can
// hold the phase still (screenshots must not depend on timing): set
// `globalThis.__canopyEdmBlinkPhase = 0 | 1` before the page loads, or call
// freezeEdmBlink().

import { useEffect, useState } from 'react';

type Phase = 0 | 1;

let frozen: Phase | null = null;
const listeners = new Set<() => void>();

function globalPhase(): Phase | null {
  const g = (globalThis as { __canopyEdmBlinkPhase?: unknown }).__canopyEdmBlinkPhase;
  return g === 0 || g === 1 ? g : null;
}

/** Hold every blinking colour at one phase (null: blink again). */
export function freezeEdmBlink(phase: Phase | null): void {
  frozen = phase;
  for (const l of listeners) l();
}

export function blinkInterval(ms: number): number {
  return Math.min(2000, Math.max(250, ms || 500));
}

/** The current blink phase; ticks only while `active`. */
export function useBlinkPhase(ms: number, active: boolean): Phase {
  const [phase, setPhase] = useState<Phase>(0);
  const [, setVersion] = useState(0);
  useEffect(() => {
    const l = () => setVersion((v) => v + 1);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  const hold = frozen ?? globalPhase();
  useEffect(() => {
    if (!active || hold !== null) return;
    const t = setInterval(() => setPhase((p) => (p ? 0 : 1)), blinkInterval(ms));
    return () => clearInterval(t);
  }, [ms, active, hold]);
  return hold ?? phase;
}
