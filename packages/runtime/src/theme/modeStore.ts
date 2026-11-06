// The light/dark mode of rendered screens: one module-level store per bundle.
// Hosts write it (synchronously, so a mode seeded during the first render is
// in place before any layout effect reads it); every top ScreenRenderer root
// reads it imperatively and mirrors it onto its own `data-theme`, so a flip
// re-renders no widget. The initial mode is `light`, today's look.

/** A screen colour mode. */
export type ThemeMode = 'light' | 'dark';

let mode: ThemeMode = 'light';
const listeners = new Set<() => void>();

/** The current mode. */
export function getMode(): ThemeMode {
  return mode;
}

/**
 * Sets the mode and notifies subscribers synchronously. Setting the mode it
 * already has is a no-op.
 */
export function setMode(next: ThemeMode): void {
  if (next === mode) return;
  mode = next;
  for (const listener of [...listeners]) listener();
}

/**
 * Calls `listener` after every mode change; returns the unsubscribe function.
 * The shape `useSyncExternalStore` expects.
 */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
