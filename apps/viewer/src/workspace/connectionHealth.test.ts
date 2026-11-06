// connectionHealth: the five unhealthy states derived from the same badge
// snapshot TargetBadge renders, and the one label each shows in the host
// subtitle. The derivation is cross-checked against targetBadgeView so the
// two can never disagree on which row decides.

import { describe, expect, it } from 'vitest';
import type { HareReachable, HareWrites } from '@slaclab/canopy-client';
import type { BackendBadgeState } from '../backendBadge.js';
import {
  CONNECTION_HEALTH_LABELS,
  deriveConnectionHealth,
  healthLabel,
  type ConnectionHealth,
} from './connectionHealth.js';
import { BADGE_DISCONNECTED, BADGE_NO_DATA, targetBadgeView } from './TargetBadge.js';

const HEALTHY: BackendBadgeState = Object.freeze({
  label: 'Simulator',
  notice: null,
  binding: 'va@3',
  link: 'up',
  labelSeen: true,
  configBackendNull: false,
  heartbeat: true,
  lastBinding: 'va@3',
  reachable: null,
  writes: null,
  timestamp: 1_700_000_000,
});

function badge(over: Partial<BackendBadgeState>): BackendBadgeState {
  return { ...HEALTHY, ...over };
}

const REACH_NO: HareReachable = { state: 'no', since: 1_699_999_000, reason: null };
const REACH_YES: HareReachable = { state: 'yes', since: null, reason: null };
const REACH_UNKNOWN: HareReachable = { state: 'unknown', since: null, reason: 'probing' };
const WRITES_OFF: HareWrites = { state: 'off', reason: null, cause: null };
const WRITES_LOCKED: HareWrites = { state: 'locked', reason: null, cause: null };
const WRITES_APPLYING: HareWrites = { state: 'applying', reason: null, cause: 'switching' };

interface Case {
  name: string;
  state: BackendBadgeState | null;
  expected: ConnectionHealth;
}

const CASES: Case[] = [
  // Healthy: no store, label null, the label alone, and every writes word.
  { name: 'no store (mock or fixture)', state: null, expected: 'healthy' },
  {
    name: 'boot, nothing seen yet',
    state: badge({ link: 'boot', label: null, labelSeen: false, heartbeat: false }),
    expected: 'healthy',
  },
  { name: 'label alone', state: HEALTHY, expected: 'healthy' },
  { name: 'label null after a heartbeat', state: badge({ label: null }), expected: 'healthy' },
  { name: 'reachable yes', state: badge({ reachable: REACH_YES }), expected: 'healthy' },
  {
    name: 'reachable unknown makes no claim',
    state: badge({ reachable: REACH_UNKNOWN }),
    expected: 'healthy',
  },
  {
    name: 'writes off is the shell chip’s',
    state: badge({ writes: WRITES_OFF }),
    expected: 'healthy',
  },
  {
    name: 'writes locked is the shell chip’s',
    state: badge({ writes: WRITES_LOCKED }),
    expected: 'healthy',
  },
  {
    name: 'writes applying is the shell chip’s',
    state: badge({ writes: WRITES_APPLYING }),
    expected: 'healthy',
  },
  {
    name: 'link down but no label ever seen',
    state: badge({ link: 'down', labelSeen: false, label: null }),
    expected: 'healthy',
  },

  // Row 2: link down and a label ever seen.
  { name: 'disconnected', state: badge({ link: 'down' }), expected: 'disconnected' },
  {
    name: 'disconnected beats every later row',
    state: badge({
      link: 'down',
      configBackendNull: true,
      heartbeat: false,
      reachable: REACH_NO,
      notice: 'unservable',
    }),
    expected: 'disconnected',
  },
  // Row 3: config.json backend null and no heartbeat yet.
  {
    name: 'no data connection',
    state: badge({ configBackendNull: true, heartbeat: false, label: null, labelSeen: false }),
    expected: 'no-data-connection',
  },
  {
    name: 'config null cleared by a heartbeat',
    state: badge({ configBackendNull: true, heartbeat: true }),
    expected: 'healthy',
  },
  // Row 5: reachable no (label present).
  { name: 'not answering', state: badge({ reachable: REACH_NO }), expected: 'not-answering' },
  {
    name: 'not answering drops the writes suffix',
    state: badge({ reachable: REACH_NO, writes: WRITES_OFF }),
    expected: 'not-answering',
  },
  {
    name: 'not answering beats a notice',
    state: badge({ reachable: REACH_NO, notice: 'fallback' }),
    expected: 'not-answering',
  },
  {
    name: 'reachable no without a label shows nothing',
    state: badge({ label: null, reachable: REACH_NO }),
    expected: 'healthy',
  },
  // Rows 6 and 7: the notices.
  { name: 'fallback', state: badge({ notice: 'fallback' }), expected: 'fallback' },
  {
    name: 'fallback with writes off',
    state: badge({ notice: 'fallback', writes: WRITES_OFF }),
    expected: 'fallback',
  },
  { name: 'unservable', state: badge({ notice: 'unservable' }), expected: 'unservable' },
];

describe('deriveConnectionHealth', () => {
  it.each(CASES)('$name -> $expected', ({ state, expected }) => {
    expect(deriveConnectionHealth(state)).toBe(expected);
  });

  it('agrees with the badge row that decides the same snapshot', () => {
    for (const { state } of CASES) {
      const health = deriveConnectionHealth(state);
      const view = targetBadgeView(state);
      if (health === 'disconnected') expect(view?.text).toBe(BADGE_DISCONNECTED);
      else if (health === 'no-data-connection') expect(view?.text).toBe(BADGE_NO_DATA);
      else if (health === 'healthy') {
        // Healthy is none, the label alone, or a writes row: never an
        // error badge and never a notice.
        expect(view === null || view.tone !== 'error').toBe(true);
        expect(view?.text ?? '').not.toMatch(/fallback|cannot be served|not answering/);
      } else {
        expect(view).not.toBeNull();
        expect(['error', 'warning']).toContain(view?.tone);
      }
    }
  });

  it('is pure: the snapshot is not mutated', () => {
    const state = Object.freeze(badge({ notice: 'unservable' }));
    expect(deriveConnectionHealth(state)).toBe('unservable');
    expect(deriveConnectionHealth(state)).toBe('unservable');
  });
});

describe('healthLabel', () => {
  it('healthy yields no label', () => {
    expect(healthLabel('healthy')).toBeNull();
  });

  it('the five strings verbatim', () => {
    expect(healthLabel('disconnected')).toBe('Disconnected');
    expect(healthLabel('no-data-connection')).toBe('No data connection');
    expect(healthLabel('not-answering')).toBe('Not answering');
    expect(healthLabel('fallback')).toBe('Fallback (no target record)');
    expect(healthLabel('unservable')).toBe('Cannot be served');
    expect(Object.keys(CONNECTION_HEALTH_LABELS)).toHaveLength(5);
  });

  it('never carries the target label or a writes word', () => {
    const states: ConnectionHealth[] = [
      'disconnected',
      'no-data-connection',
      'not-answering',
      'fallback',
      'unservable',
    ];
    for (const s of states) {
      const text = healthLabel(s) ?? '';
      expect(text).not.toContain('Simulator');
      expect(text).not.toMatch(/writes|switching|applying/);
    }
  });

  it('the longest label leads a short-tab subtitle within 40 characters', () => {
    // Subtitle form: `<state> · <rest>`. The longest label is 27
    // characters, so `<state> · ` leaves 10 for the tab name inside 40. The
    // state still leads, so ellipsis never hides it.
    const longest = Math.max(...Object.values(CONNECTION_HEALTH_LABELS).map((l) => l.length));
    expect(longest).toBe(27);
    expect(`${CONNECTION_HEALTH_LABELS.fallback} · ${'x'.repeat(10)}`.length).toBeLessThanOrEqual(
      40
    );
  });
});
