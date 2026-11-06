// planOpenMany: Open all as a pure plan — the tab key of every member,
// what already shows it reused, skips at the cap and when unresolved, waiting
// for the first manifest, and the keys left alone on a second Open all. The
// plan's state is a preview; the holder's one `openSet` commits it.
import { describe, expect, it } from 'vitest';
import type { ManifestScreen } from '../api.js';
import {
  CODE_SCREEN,
  NOT_IN_LIBRARY,
  atCapReason,
  memberKey,
  planOpenMany,
  skipNotice,
  toolUnavailable,
} from './collections.js';
import type { Member, OpenManyContext } from './collections.js';
import { EMPTY_TABS, stepTabs, tabsReducer } from './tabs.js';
import type { TabsState } from './tabs.js';
import { keysOf } from '@slaclab/canopy-dock-engine';

function entry(category: string, id: string, kind = 'ir'): ManifestScreen {
  return { id, kind, title: id, category, path: `screens/${category}/${id}.screen.json` };
}

const SCREENS: ManifestScreen[] = [
  entry('library', 'sr/overview'),
  entry('library', 's3-promo/promotion'),
  entry('examples', 'legacy', 'code'),
];

function context(extra: Partial<OpenManyContext> = {}): OpenManyContext {
  return { screens: SCREENS, tools: ['trace'], ...extra };
}

/** One screen open, in the only tile. */
const ONE_SCREEN: TabsState = tabsReducer(EMPTY_TABS, {
  type: 'open',
  key: 'library/sr/overview',
  mode: 'append',
});

const SR: Member = { screen: 'library/sr/overview' };
const PROMO: Member = { screen: 'library/s3-promo/promotion' };
const ORBIT: Member = { tool: 'trace', query: 'pv=SR:A', name: 'Orbit' };
const BARE: Member = { tool: 'trace' };

/** The state with `n` blank trace instances open (the first docked and active). */
function traces(n: number): TabsState {
  let s: TabsState = EMPTY_TABS;
  for (let i = 0; i < n; i += 1) s = tabsReducer(s, { type: 'newInstance', tool: 'trace' });
  return s;
}

describe('planOpenMany: no layout', () => {
  it('plans a 3-member Open all from a state with one docked screen', () => {
    const plan = planOpenMany(ONE_SCREEN, [PROMO, ORBIT, SR], context());
    expect(plan.pending).toBe(false);
    expect(plan.skipped).toEqual([]);
    // The open screen is focused, not duplicated; the rest append in order.
    expect(plan.state.keys).toEqual([
      'library/sr/overview',
      'library/s3-promo/promotion',
      '@trace',
    ]);
    expect([...plan.keyOf]).toEqual([
      [memberKey(PROMO), 'library/s3-promo/promotion'],
      [memberKey(ORBIT), '@trace'],
      [memberKey(SR), 'library/sr/overview'],
    ]);
    // Every tool instance it lands on records the member.
    expect(plan.state.instances['@trace']).toMatchObject({
      query: 'pv=SR:A',
      from: memberKey(ORBIT),
    });
    // The input state is untouched (pure).
    expect(ONE_SCREEN.keys).toEqual(['library/sr/overview']);
  });

  it("commits through the holder's openSet: the planned keys, side by side", () => {
    const plan = planOpenMany(ONE_SCREEN, [PROMO, ORBIT], context());
    const members = [...plan.keyOf.values()];
    const step = stepTabs(ONE_SCREEN, {
      type: 'openSet',
      members,
      as: 'side',
      instances: { '@trace': plan.state.instances['@trace']! },
    });
    expect(step.refusal).toBeUndefined();
    expect(step.state.keys).toEqual(plan.state.keys);
    // One tile each, the focused one first.
    expect(keysOf(step.state.layout).length).toBe(3);
    expect(step.state.layout).toMatchObject({ split: 'row' });
    expect(step.state.instances['@trace']).toMatchObject({
      query: 'pv=SR:A',
      from: memberKey(ORBIT),
      title: 'Orbit',
    });
  });

  it("never commits: the input state is not the plan's", () => {
    const plan = planOpenMany(ONE_SCREEN, [PROMO], context());
    expect(plan.state).not.toBe(ONE_SCREEN);
    expect(ONE_SCREEN.keys).toEqual(['library/sr/overview']);
  });

  it('focuses a tool instance already showing the member, never a second one', () => {
    const start = tabsReducer(EMPTY_TABS, { type: 'openMember', member: ORBIT });
    const plan = planOpenMany(start, [ORBIT], context());
    expect(plan.state.keys).toEqual(['@trace']);
    expect(plan.keyOf.get(memberKey(ORBIT))).toBe('@trace');
  });

  it('opens a bare tool member as a new default instance when none shows it', () => {
    const start = tabsReducer(EMPTY_TABS, { type: 'newInstance', tool: 'trace', query: 'pv=X' });
    const plan = planOpenMany(start, [BARE], context());
    expect(plan.state.keys).toEqual(['@trace', '@trace/2']);
    expect(plan.state.instances['@trace/2']).toEqual({ query: null, from: memberKey(BARE) });
  });

  it('skips unresolved members with their reasons and summarises them in one notice', () => {
    const plan = planOpenMany(
      EMPTY_TABS,
      [{ screen: 'library/gone' }, { screen: 'examples/legacy' }, { tool: 'waveform' }, PROMO],
      context()
    );
    expect(plan.state.keys).toEqual(['library/s3-promo/promotion']);
    expect(plan.skipped.map((s) => s.reason)).toEqual([
      NOT_IN_LIBRARY,
      CODE_SCREEN,
      toolUnavailable('waveform'),
    ]);
    expect(skipNotice(plan.skipped)).toBe(
      `Skipped 3 members: library/gone (${NOT_IN_LIBRARY}); examples/legacy (${CODE_SCREEN}); ` +
        `Waveform (${toolUnavailable('waveform')})`
    );
    expect(skipNotice([])).toBeNull();
  });
});

describe('planOpenMany: the cap', () => {
  it('skips a tool member at MAX_TOOL_INSTANCES, never loading into the MRU instance', () => {
    const full = traces(10);
    const plan = planOpenMany(full, [ORBIT, PROMO], context());
    expect(plan.skipped).toEqual([{ member: ORBIT, reason: atCapReason('trace') }]);
    expect(plan.state.keys).toEqual([...full.keys, 'library/s3-promo/promotion']);
    for (const key of full.keys) expect(plan.state.instances[key]).toEqual(full.instances[key]);
    expect(skipNotice(plan.skipped)).toBe('Skipped 1 member: Orbit (At most 10 Data Browser tabs)');
  });

  it('counts the instances the same plan opened earlier', () => {
    const members: Member[] = Array.from({ length: 3 }, (_, i) => ({
      tool: 'trace',
      query: `pv=Q${i}`,
    }));
    const plan = planOpenMany(traces(8), members, context());
    expect(plan.state.keys.filter((k) => k.startsWith('@trace'))).toHaveLength(10);
    expect(plan.skipped).toEqual([{ member: members[2], reason: atCapReason('trace') }]);
  });
});

describe('planOpenMany: pending', () => {
  it('waits for the first manifest: nothing planned, the input state returned', () => {
    const plan = planOpenMany(ONE_SCREEN, [ORBIT, PROMO], context({ screens: null }));
    expect(plan.pending).toBe(true);
    expect(plan.state).toBe(ONE_SCREEN);
    expect(plan.keyOf.size).toBe(0);
    expect(plan.skipped).toEqual([]);
  });

  it('is not pending without a screen member', () => {
    const plan = planOpenMany(EMPTY_TABS, [ORBIT], context({ screens: null }));
    expect(plan.pending).toBe(false);
    expect(plan.state.keys).toEqual(['@trace']);
  });
});

describe('planOpenMany: double Open all', () => {
  it('leaves the keys and the member mapping unchanged', () => {
    const members = [PROMO, ORBIT, BARE, SR];
    const once = planOpenMany(ONE_SCREEN, members, context());
    const committed = tabsReducer(ONE_SCREEN, {
      type: 'openSet',
      members: [...once.keyOf.values()],
      as: 'tabs',
      instances: once.state.instances,
    });
    const twice = planOpenMany(committed, members, context());
    expect(new Set(twice.state.keys)).toEqual(new Set(committed.keys));
    expect([...twice.keyOf]).toEqual([...once.keyOf]);
  });
});
