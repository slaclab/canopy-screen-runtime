// TargetBadge: the workspace tab-strip row's note on which control target the
// page's data connection serves, and what that target's live socket says
// about it, read from the backend badge store.
//
// Rows, first match wins (one row decides the badge). Rows 2-7 are the
// connection health (deriveConnectionHealth, connectionHealth.ts) in its own
// words; the badge only adds the label, the tone and the writes suffix:
//   1. mock, fixture or chrome off  -> none (no store, or the page has no strip)
//   2. disconnected                 -> "Disconnected" (error)
//   3. no-data-connection           -> "No data connection" (error)
//   4. label null                   -> none
//   5. not-answering                -> "<label> · not answering" (error), plus
//      one space and the writes suffix of row 8 or 9 whenever writes is not
//      `on`; the `since` phrase is the title
//   6. fallback                     -> "<label> · fallback (no target record)"
//      (warning)
//   7. unservable                   -> "<label> · cannot be served" (error)
//   8. writes `off`                 -> "<label> · writes off" (warning);
//      writes `held` (a watchdog's hold on the session) -> "<label> · writes
//      held" (warning); writes `locked`, or a word this page does not know,
//      -> "<label> · writes locked" (muted)
//   9. writes `applying`            -> cause `switching`: "<label> · switching
//      target…", any other cause: "<label> · writes on · applying…" (muted)
//  10. the label (normal); writes `on` and `asked` (a person confirms each
//      write in the screen's dialog) add nothing
//
// A null statement (a frame without the fields) adds nothing, so such a frame
// renders as rows 1-4, 6, 7 and 10 alone. A reachable state other than `yes`
// or `no` makes no claim; its reason, when given, is the title. Every
// duration is the heartbeat's own `timestamp − since`, never the page clock.
//
// The badge span is the chrome's one live region for the machine statement;
// the title adds no second one. The paint is the `.target-badge` rule in
// workspace.css, which the page imports.

import type { HareWrites } from '@slaclab/canopy-client';
import type { BackendBadgeState } from '../backendBadge.js';
import { useBackendBadge } from '../services.js';
import { CONNECTION_HEALTH_LABELS, deriveConnectionHealth } from './connectionHealth.js';
import type { UnhealthyConnection } from './connectionHealth.js';

export type TargetBadgeTone = 'normal' | 'warning' | 'error' | 'muted';

export interface TargetBadgeView {
  text: string;
  tone: TargetBadgeTone;
  /** The hover: the `since` phrase or an `unknown` reason; absent for none. */
  title?: string;
}

/** A health label as the fragment after "<label> · ": its first letter lower-cased. */
function fragment(health: UnhealthyConnection): string {
  const text = CONNECTION_HEALTH_LABELS[health];
  return text.charAt(0).toLowerCase() + text.slice(1);
}

export const BADGE_DISCONNECTED = CONNECTION_HEALTH_LABELS.disconnected;
export const BADGE_NO_DATA = CONNECTION_HEALTH_LABELS['no-data-connection'];
export const BADGE_NOT_ANSWERING = fragment('not-answering');
export const WRITES_SUFFIX = {
  off: '· writes off',
  held: '· writes held',
  locked: '· writes locked',
  switching: '· switching target…',
  applying: '· writes on · applying…',
} as const;

interface WritesRow {
  suffix: string;
  tone: TargetBadgeTone;
}

function writesRow(writes: HareWrites | null): WritesRow | null {
  if (writes === null || writes.state === 'on' || writes.state === 'asked') return null;
  if (writes.state === 'off') return { suffix: WRITES_SUFFIX.off, tone: 'warning' };
  if (writes.state === 'held') return { suffix: WRITES_SUFFIX.held, tone: 'warning' };
  if (writes.state === 'applying') {
    const suffix = writes.cause === 'switching' ? WRITES_SUFFIX.switching : WRITES_SUFFIX.applying;
    return { suffix, tone: 'muted' };
  }
  return { suffix: WRITES_SUFFIX.locked, tone: 'muted' };
}

/**
 * `not answering since HH:MM (N min)`: HH:MM is `since` as 24-hour time in
 * `timeZone` (the page's zone when omitted), seconds dropped; N is the whole
 * minutes of `timestamp − since`.
 */
export function sinceText(since: number, timestamp: number, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone,
  }).formatToParts(new Date(since * 1000));
  const part = (type: 'hour' | 'minute') =>
    (parts.find((p) => p.type === type)?.value ?? '0').padStart(2, '0');
  const minutes = Math.max(0, Math.floor((timestamp - since) / 60));
  return `${BADGE_NOT_ANSWERING} since ${part('hour')}:${part('minute')} (${minutes} min)`;
}

function badgeTitle(state: BackendBadgeState, timeZone?: string): string | null {
  const reachable = state.reachable;
  if (reachable === null || reachable.state === 'yes') return null;
  if (reachable.state === 'no') {
    if (reachable.since === null || state.timestamp === null) return null;
    return sinceText(reachable.since, state.timestamp, timeZone);
  }
  return reachable.reason;
}

function withTitle(view: TargetBadgeView, title: string | null): TargetBadgeView {
  return title === null ? view : { ...view, title };
}

/**
 * The badge a snapshot shows, or null for none. `chrome` false is row 1.
 * `timeZone` sets the zone of the `since` phrase (the page's zone when omitted).
 */
export function targetBadgeView(
  state: BackendBadgeState | null,
  chrome = true,
  timeZone?: string
): TargetBadgeView | null {
  if (state === null || !chrome) return null;
  const health = deriveConnectionHealth(state);
  if (health === 'disconnected') return { text: BADGE_DISCONNECTED, tone: 'error' };
  if (health === 'no-data-connection') return { text: BADGE_NO_DATA, tone: 'error' };
  const label = state.label;
  if (label === null) return null;
  const title = badgeTitle(state, timeZone);
  const writes = writesRow(state.writes);
  if (health === 'not-answering') {
    const text = `${label} · ${BADGE_NOT_ANSWERING}`;
    return withTitle({ text: writes ? `${text} ${writes.suffix}` : text, tone: 'error' }, title);
  }
  if (health === 'fallback') {
    return withTitle({ text: `${label} · ${fragment(health)}`, tone: 'warning' }, title);
  }
  if (health === 'unservable') {
    return withTitle({ text: `${label} · ${fragment(health)}`, tone: 'error' }, title);
  }
  if (writes) return withTitle({ text: `${label} ${writes.suffix}`, tone: writes.tone }, title);
  return withTitle({ text: label, tone: 'normal' }, title);
}

export interface TargetBadgeProps {
  /** False when the page renders without chrome; the badge is then never drawn. */
  chrome?: boolean;
}

export function TargetBadge({ chrome = true }: TargetBadgeProps) {
  const view = targetBadgeView(useBackendBadge(), chrome);
  if (view === null) return null;
  return (
    <span
      className={`target-badge target-badge--${view.tone}`}
      data-tone={view.tone}
      role="status"
      aria-label={`Data connection: ${view.text}`}
      title={view.title}
    >
      {view.text}
    </span>
  );
}
