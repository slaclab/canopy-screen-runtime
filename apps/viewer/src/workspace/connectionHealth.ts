// connectionHealth: CANOPY's own data-connection health as one of the five
// states the shell's control-target chip cannot see, or `healthy`.
//
// It reads the backend badge snapshot; TargetBadge builds its rows 2-7 on
// it. First match wins:
//   2. link down and a label was ever seen        -> disconnected
//   3. config.json backend null, no heartbeat yet -> no-data-connection
//   4. label null                                 -> healthy (nothing to say)
//   5. reachable `no`                             -> not-answering
//   6. notice `fallback`                          -> fallback
//   7. notice `unservable`                        -> unservable
// Row 1 (no store: mock or fixture) is healthy. The writes rows (8, 9) are not
// health states: the shell chip shows writes, so this never reports them.
//
// Embedded, the host subtitle leads with the label (`<state> · <rest>`) so
// the host's end-ellipsis never hides it; standalone, TargetBadge words its
// rows with the same labels. The label carries no target name and no writes
// word.

import type { BackendBadgeState } from '../backendBadge.js';

export type ConnectionHealth =
  | 'healthy'
  | 'disconnected'
  | 'no-data-connection'
  | 'not-answering'
  | 'fallback'
  | 'unservable';

export type UnhealthyConnection = Exclude<ConnectionHealth, 'healthy'>;

/** The five states in words: the host subtitle's lead and the badge's fragment. */
export const CONNECTION_HEALTH_LABELS: Readonly<Record<UnhealthyConnection, string>> =
  Object.freeze({
    disconnected: 'Disconnected',
    'no-data-connection': 'No data connection',
    'not-answering': 'Not answering',
    fallback: 'Fallback (no target record)',
    unservable: 'Cannot be served',
  });

/** The health a badge snapshot shows; null (no store) is healthy. */
export function deriveConnectionHealth(state: BackendBadgeState | null): ConnectionHealth {
  if (state === null) return 'healthy';
  if (state.link === 'down' && state.labelSeen) return 'disconnected';
  if (state.configBackendNull && !state.heartbeat) return 'no-data-connection';
  if (state.label === null) return 'healthy';
  if (state.reachable?.state === 'no') return 'not-answering';
  if (state.notice === 'fallback') return 'fallback';
  if (state.notice === 'unservable') return 'unservable';
  return 'healthy';
}

/** The subtitle's state fragment, or null when healthy. */
export function healthLabel(state: ConnectionHealth): string | null {
  return state === 'healthy' ? null : CONNECTION_HEALTH_LABELS[state];
}
