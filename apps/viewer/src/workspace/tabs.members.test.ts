// Collection members in the tab model: an instance's `from`
// provenance and its lifecycle, the "instance shows member" predicate, the
// row rules of `openMember`, the `openSet` commit of an Open all, and `from` surviving a
// reload (sessionStorage) and a new-session reopen (the dock store).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memberKey, planOpenMany, type Member, type MemberKey } from './collections.js';
import {
  EMPTY_TABS,
  fromLayout,
  instanceShowsMember,
  loadTabs,
  memberInstance,
  readTabs,
  screenMemberTabKey,
  tabsReducer,
  writeTabs,
  type TabsAction,
  type TabsState,
} from './tabs.js';
import { MAX_TOOL_INSTANCES } from './tools.js';
import { writeDock } from './dock/storage.js';
import { dockValue, planDockLoad } from './dock/useDockPersistence.js';

function run(state: TabsState, ...actions: TabsAction[]): TabsState {
  return actions.reduce(tabsReducer, state);
}

/** Open `keys` as the tabs of one tile showing `active` (@slaclab/canopy-dock-engine); [] is an empty dock. */
function tabs(keys: string[], active: string | null = keys[0] ?? null): TabsState {
  const showing = active ?? keys[0];
  return fromLayout(showing === undefined ? null : { tile: 't1', tabs: keys, showing }, 't1');
}

const QA = 'pv=SR:A';
const QB = 'pv=SR:B';
const TA: Member = { tool: 'trace', query: QA, name: 'Orbit A' };
const KA = memberKey(TA);
const KB = memberKey({ tool: 'trace', query: QB });
const BARE = memberKey({ tool: 'trace' });

const member = (m: Member, newTab = false): TabsAction => ({
  type: 'openMember',
  member: m,
  newTab,
});

/** The state with `n` trace instances open (the first active), all blank. */
function traces(n: number): TabsState {
  let s: TabsState = EMPTY_TABS;
  for (let i = 0; i < n; i += 1) s = run(s, { type: 'newInstance', tool: 'trace' });
  return s;
}

describe('instance shows member (predicate)', () => {
  const base = (instance: TabsState['instances'][string]): TabsState => ({
    ...tabs(['@trace']),
    instances: { '@trace': instance },
  });

  it('an explicit from matches its own key only', () => {
    const s = base({ query: QB, from: KA });
    expect(instanceShowsMember(s, '@trace', KA)).toBe(true);
    // from wins over the query: the query's own member is not shown.
    expect(instanceShowsMember(s, '@trace', KB)).toBe(false);
  });

  it('without from the query decides', () => {
    const s = base({ query: QA });
    expect(instanceShowsMember(s, '@trace', KA)).toBe(true);
    expect(instanceShowsMember(s, '@trace', KB)).toBe(false);
    expect(instanceShowsMember(s, '@trace', BARE)).toBe(false);
  });

  it('a null query (config default) is the bare member; a blank one is tool:<id>?', () => {
    expect(instanceShowsMember(base({ query: null }), '@trace', BARE)).toBe(true);
    expect(instanceShowsMember(tabs(['@trace']), '@trace', BARE), 'no instance state').toBe(true);
    const blank = base({ query: '' });
    expect(instanceShowsMember(blank, '@trace', BARE)).toBe(false);
    expect(instanceShowsMember(blank, '@trace', memberKey({ tool: 'trace', query: '' }))).toBe(
      true
    );
  });

  it('the member of another tool, a closed instance and a screen key never match', () => {
    const s = base({ query: QA });
    expect(instanceShowsMember(s, '@trace', memberKey({ tool: 'correlation', query: QA }))).toBe(
      false
    );
    expect(instanceShowsMember(s, '@trace/2', KA)).toBe(false);
    expect(instanceShowsMember(tabs(['a/1']), 'a/1', memberKey({ screen: 'a/1' }))).toBe(false);
  });

  it('memberInstance picks the most recently used showing instance', () => {
    const s: TabsState = {
      ...tabs(['@trace', '@trace/2', '@trace/3']),
      instances: {
        '@trace': { query: QA },
        '@trace/2': { query: QB },
        '@trace/3': { query: QB, from: KA },
      },
      toolMru: ['@trace/3', '@trace'],
    };
    expect(memberInstance(s, 'trace', KA)).toBe('@trace/3');
    expect(memberInstance(s, 'trace', KB)).toBe('@trace/2');
    expect(memberInstance(s, 'trace', BARE)).toBeNull();
  });
});

describe('from lifecycle', () => {
  it('is set on member open, kept across setQuery and setView, cleared by a load', () => {
    let s = run(EMPTY_TABS, member(TA));
    expect(s.active).toBe('@trace');
    expect(s.instances['@trace']).toMatchObject({ query: QA, from: KA, view: null });

    s = run(s, { type: 'setQuery', key: '@trace', query: QB });
    expect(s.instances['@trace']!.from).toBe(KA);
    // Still showing the member it was opened from, not the one its query names.
    expect(instanceShowsMember(s, '@trace', KA)).toBe(true);
    expect(instanceShowsMember(s, '@trace', KB)).toBe(false);

    s = run(s, { type: 'setView', key: '@trace', view: 'v1' });
    expect(s.instances['@trace']!.from).toBe(KA);

    s = run(s, { type: 'load', key: '@trace', query: QB, view: null });
    expect(s.instances['@trace']!.from).toBeUndefined();
    expect(instanceShowsMember(s, '@trace', KB)).toBe(true);
  });

  it('openView into the instance is a load from elsewhere', () => {
    let s = run(traces(MAX_TOOL_INSTANCES), member(TA));
    const key = s.active!;
    expect(s.instances[key]!.from).toBe(KA);
    s = run(s, { type: 'openView', tool: 'trace', query: QB, view: 'v' });
    expect(s.active).toBe(key);
    expect(s.instances[key]!.from).toBeUndefined();
  });
});

describe('openMember row rules', () => {
  it('a screen member replaces the active screen; newTab appends', () => {
    const s = tabs(['a/1', 'b/2'], 'a/1');
    const replaced = run(s, member({ screen: 'c/3', macros: { P: 'x' } }));
    expect(replaced.keys).toEqual(['c/3?P=x', 'b/2']);
    expect(replaced.active).toBe('c/3?P=x');
    const appended = run(s, member({ screen: 'c/3' }, true));
    expect(appended.keys).toEqual(['a/1', 'b/2', 'c/3']);
    expect(appended.active).toBe('c/3');
    // An open screen is focused, whichever way.
    expect(run(s, member({ screen: 'b/2' })).active).toBe('b/2');
  });

  it('a screen reference that names no screen changes nothing', () => {
    const s = tabs(['a/1']);
    for (const screen of ['nocat', '/x', 'cat/', '@drafts/x']) {
      expect(run(s, member({ screen })), screen).toBe(s);
    }
  });

  it('screenMemberTabKey drops reserved macros and sorts the rest', () => {
    expect(screenMemberTabKey({ screen: 'gtb/view', macros: { b: '2', a: '1', theme: 'x' } })).toBe(
      'gtb/view?a=1&b=2'
    );
    expect(screenMemberTabKey({ screen: 'gtb/view' })).toBe('gtb/view');
  });

  it('a bare tool member is openTool: the MRU instance, its from untouched', () => {
    const s: TabsState = {
      ...tabs(['a/1', '@trace', '@trace/2'], 'a/1'),
      instances: { '@trace/2': { query: QB, from: KB } },
      toolMru: ['@trace/2', '@trace'],
    };
    const next = run(s, member({ tool: 'trace' }));
    expect(next.active).toBe('@trace/2');
    expect(next.instances['@trace/2']!.from).toBe(KB);
  });

  it('a bare tool member with none open opens instance 1 and records from', () => {
    const next = run(tabs(['a/1']), member({ tool: 'trace' }));
    expect(next.keys).toEqual(['@trace']);
    expect(next.active).toBe('@trace');
    expect(next.instances['@trace']!.from).toBe(BARE);
  });

  it('a bare tool member with newTab is a new instance with from', () => {
    const next = run(traces(1), member({ tool: 'trace' }, true));
    expect(next.keys).toEqual(['@trace', '@trace/2']);
    expect(next.active).toBe('@trace/2');
    expect(next.instances['@trace/2']).toMatchObject({ query: '', from: BARE });
    const full = traces(MAX_TOOL_INSTANCES);
    expect(run(full, member({ tool: 'trace' }, true)), 'refused at the cap').toBe(full);
  });

  it('a queried member focuses the instance showing it', () => {
    const s: TabsState = {
      ...tabs(['@trace', '@trace/2'], '@trace'),
      instances: { '@trace': { query: '' }, '@trace/2': { query: QA } },
    };
    const next = run(s, member(TA));
    expect(next.keys).toEqual(s.keys);
    expect(next.active).toBe('@trace/2');
    expect(next.instances['@trace/2']!.epoch, 'not reloaded').toBeUndefined();
    expect(next.instances['@trace/2']!.from).toBe(KA);
  });

  it('else opens a new instance with its query', () => {
    const next = run(traces(1), member(TA));
    expect(next.keys).toEqual(['@trace', '@trace/2']);
    expect(next.active).toBe('@trace/2');
    expect(next.instances['@trace/2']).toMatchObject({ query: QA, from: KA, epoch: 1 });
  });

  it('else at the cap loads into the MRU instance', () => {
    const full = traces(MAX_TOOL_INSTANCES);
    const mru = full.toolMru[0]!;
    const next = run(full, member(TA));
    expect(next.keys).toEqual(full.keys);
    expect(next.active).toBe(mru);
    expect(next.instances[mru]).toMatchObject({ query: QA, from: KA });
  });

  it('newTab always opens a new instance, at the cap the MRU instance', () => {
    const s = run(EMPTY_TABS, member(TA));
    const again = run(s, member(TA, true));
    expect(again.keys).toEqual(['@trace', '@trace/2']);
    expect(again.instances['@trace/2']).toMatchObject({ query: QA, from: KA });
    const full = traces(MAX_TOOL_INSTANCES);
    const mru = full.toolMru[0]!;
    const capped = run(full, member(TA, true));
    expect(capped.keys).toEqual(full.keys);
    expect(capped.instances[mru]).toMatchObject({ query: QA, from: KA });
  });

  it('an unregistered tool changes nothing', () => {
    const s = tabs(['a/1']);
    expect(run(s, member({ tool: 'nope', query: QA }))).toBe(s);
    expect(run(s, member({ tool: 'nope' }))).toBe(s);
  });
});

describe('openSet (Open all)', () => {
  it('commits the planned members as one new tile beside the focused one, seeding instances', () => {
    const next = run(tabs(['z/9']), {
      type: 'openSet',
      members: ['a/1', '@trace/2'],
      as: 'tabs',
      instances: { '@trace/2': { query: QA, from: KA } },
    });
    expect(next.keys).toEqual(['z/9', 'a/1', '@trace/2']);
    // `tabs` is one new tile holding the set, split off the focused tile.
    expect(next.layout).toMatchObject({
      split: 'row',
      items: [{ tile: 't1', tabs: ['z/9'] }, { tabs: ['a/1', '@trace/2'] }],
    });
    expect(next.instances['@trace/2']).toMatchObject({ query: QA, from: KA });
  });

  it('opening a set that is open already adds no tab', () => {
    const s = run(EMPTY_TABS, member(TA));
    const next = run(s, { type: 'openSet', members: ['@trace'], as: 'tabs' });
    expect(next.keys).toEqual(s.keys);
    expect(next.layout).toEqual(s.layout);
  });
});

// --- persistence ------------------------------------------------------------

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key: string) => (data.has(key) ? (data.get(key) as string) : null),
    key: (index: number) => [...data.keys()][index] ?? null,
    removeItem: (key: string) => {
      data.delete(key);
    },
    setItem: (key: string, value: string) => {
      data.set(key, String(value));
    },
  };
}

beforeEach(() => {
  vi.stubGlobal('sessionStorage', memoryStorage());
  vi.stubGlobal('localStorage', memoryStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('from survives a reload', () => {
  it('round-trips through the tabs record', () => {
    const s = run(EMPTY_TABS, member(TA), { type: 'setQuery', key: '@trace', query: QB });
    writeTabs(s, '/m1');
    const back = readTabs('/m1');
    expect(back.instances['@trace']).toEqual({ query: QB, from: KA, title: 'Orbit A' });
    expect(instanceShowsMember(back, '@trace', KA)).toBe(true);
  });

  it('omits from when unset and drops a stored from that is not a member key of the tool', () => {
    writeTabs(run(EMPTY_TABS, { type: 'newInstance', tool: 'trace', query: QA }), '/m2');
    const raw = JSON.parse(sessionStorage.getItem('canopy-viewer:tabs:/m2')!);
    expect(raw.instances['@trace']).toEqual({ query: QA });

    for (const from of [42, '', 'screen:a/1', 'tool:correlation?x', 'tool:tracex', 'trace']) {
      sessionStorage.setItem(
        'canopy-viewer:tabs:/m3',
        JSON.stringify({
          keys: ['@trace'],
          active: '@trace',
          instances: { '@trace': { query: QA, from } },
          toolMru: [],
        })
      );
      expect(readTabs('/m3').instances['@trace'], String(from)).toEqual({ query: QA });
    }
  });
});

describe('from survives a new-session reopen', () => {
  it('dockValue stores from with the live query, and planDockLoad reseeds it', () => {
    let s = run(EMPTY_TABS, member({ screen: 'a/1' }, true), member(TA, true));
    s = run(s, member({ tool: 'trace' }, true), { type: 'setQuery', key: '@trace', query: QB });
    // All three are tabs of the dock (no tab is parked outside a tile).
    expect(s.keys).toEqual(['a/1', '@trace', '@trace/2']);
    expect(s.instances['@trace']!.from).toBe(KA);
    expect(s.instances['@trace/2']).toMatchObject({ query: '', from: BARE });

    const value = dockValue(s);
    expect(value.panels['@trace']).toEqual({ kind: 'tool', query: QB, from: KA, title: 'Orbit A' });
    expect(value.panels['@trace/2']).toEqual({ kind: 'tool', query: '', from: BARE });
    writeDock('/m4', value);

    const loaded = planDockLoad({
      chrome: true,
      basename: '/m4',
      stored: EMPTY_TABS,
      urlKey: null,
      tools: ['trace'],
      newSession: true,
    });
    expect(loaded.warnings).toEqual([]);
    expect(loaded.state.keys).toEqual(['a/1', '@trace', '@trace/2']);
    expect(loaded.state.instances['@trace']).toEqual({ query: QB, from: KA, title: 'Orbit A' });
    expect(loaded.state.instances['@trace/2']).toEqual({ query: '', from: BARE });
    expect(instanceShowsMember(loaded.state, '@trace', KA)).toBe(true);
  });

  it('a member instance on the config default reopens on the default', () => {
    const s: TabsState = {
      ...tabs(['@trace']),
      instances: { '@trace': { query: null, from: BARE as MemberKey } },
    };
    const value = dockValue(s);
    expect(value.panels['@trace']).toEqual({ kind: 'tool', from: BARE });
    writeDock('/m5', value);
    const loaded = planDockLoad({
      chrome: true,
      basename: '/m5',
      stored: EMPTY_TABS,
      urlKey: null,
      tools: ['trace'],
      newSession: true,
    });
    expect(loaded.state.instances['@trace']).toEqual({ query: null, from: BARE });
  });

  it('a stored from of another tool is dropped on reopen', () => {
    writeDock('/m6', {
      version: 1,
      layout: { tile: 't1', tabs: ['@trace'], showing: '@trace' },
      panels: { '@trace': { kind: 'tool', query: QA, from: 'tool:correlation' } },
    });
    const loaded = planDockLoad({
      chrome: true,
      basename: '/m6',
      stored: EMPTY_TABS,
      urlKey: null,
      tools: ['trace'],
      newSession: true,
    });
    expect(loaded.state.instances['@trace']).toEqual({ query: QA });
  });

  it('a non-member tool panel still stores blank', () => {
    const s = run(EMPTY_TABS, { type: 'newInstance', tool: 'trace', query: QA });
    expect(dockValue(s).panels['@trace']).toEqual({ kind: 'tool', query: '' });
  });
});

// --- the member's name is the tab title; a saved member matches its live
// config-default instance -----------------------------------------------------

/** The trace tool's config default in these tests (as WorkspacePage's TRACE config). */
const DEF = 'pv=A&range=-1h';
const DEFAULT_MEMBER: Member = { tool: 'trace', query: DEF, name: 'Default orbit' };
const KDEF = memberKey(DEFAULT_MEMBER);

describe('title lifecycle', () => {
  it('is the member name on open, kept across setQuery and setView, dropped by a load', () => {
    let s = run(EMPTY_TABS, member(TA));
    expect(s.instances['@trace']).toMatchObject({ query: QA, from: KA, title: 'Orbit A' });
    s = run(
      s,
      { type: 'setQuery', key: '@trace', query: QB },
      { type: 'setView', key: '@trace', view: 'v1' }
    );
    expect(s.instances['@trace']!.title).toBe('Orbit A');
    s = run(s, { type: 'load', key: '@trace', query: QB, view: null });
    expect(s.instances['@trace']!.title).toBeUndefined();
  });

  it('follows the member on focus: a renamed member renames, an unnamed one drops it', () => {
    let s = run(EMPTY_TABS, member(TA));
    s = run(s, member({ ...TA, name: 'Orbit A (new)' }));
    expect(s.keys).toEqual(['@trace']);
    expect(s.instances['@trace']!.title).toBe('Orbit A (new)');
    s = run(s, member({ tool: 'trace', query: QA }));
    expect(s.instances['@trace']!.from).toBe(KA);
    expect(s.instances['@trace']!.title).toBeUndefined();
  });

  it('a bare member focusing the MRU instance leaves its title alone', () => {
    let s = run(EMPTY_TABS, member(TA));
    s = run(s, member({ tool: 'trace', name: 'Trace' }));
    expect(s.instances['@trace']).toMatchObject({ from: KA, title: 'Orbit A' });
  });

  it('a bare member opening an instance records its name', () => {
    const s = run(EMPTY_TABS, member({ tool: 'trace', name: 'Trace' }));
    expect(s.instances['@trace']).toMatchObject({ from: BARE, title: 'Trace' });
  });

  it('Open all records each tool member name', () => {
    const plan = planOpenMany(EMPTY_TABS, [TA, { tool: 'trace', query: QB }], {
      screens: [],
      tools: ['trace'],
    });
    expect(plan.state.instances['@trace']).toMatchObject({ from: KA, title: 'Orbit A' });
    expect(plan.state.instances['@trace/2']!.title).toBeUndefined();
  });

  it('survives a close and reopen, a reload and a new-session reopen', () => {
    let s = run(EMPTY_TABS, member(TA));
    s = run(s, { type: 'close', key: '@trace' }, { type: 'reopenClosed' });
    expect(s.instances['@trace']).toMatchObject({ from: KA, title: 'Orbit A' });

    writeTabs(s, '/t1');
    expect(readTabs('/t1').instances['@trace']).toEqual({ query: QA, from: KA, title: 'Orbit A' });

    // A title without a member is not stored (it would name nothing).
    writeTabs({ ...s, instances: { '@trace': { query: QA, title: 'Stray' } } }, '/t2');
    const raw = JSON.parse(sessionStorage.getItem('canopy-viewer:tabs:/t2')!);
    expect(raw.instances['@trace']).toEqual({ query: QA });

    const reopened = loadTabs(EMPTY_TABS, null, {
      tools: ['trace'],
      reopen: {
        panels: [{ key: '@trace', query: QA, from: KA, title: 'Orbit A' }],
        layout: { tile: 't1', tabs: ['@trace'], showing: '@trace' },
      },
    });
    expect(reopened.state.instances['@trace']).toEqual({ query: QA, from: KA, title: 'Orbit A' });
  });
});

describe('a config-default instance shows the member a save stores for it', () => {
  const live = (): TabsState => run(EMPTY_TABS, { type: 'open', key: '@trace', mode: 'append' });

  it('with the default named, a null query shows both the bare and the default member', () => {
    const s = live();
    expect(s.instances['@trace']?.query ?? null).toBeNull();
    expect(instanceShowsMember(s, '@trace', KDEF)).toBe(false);
    expect(instanceShowsMember(s, '@trace', KDEF, DEF)).toBe(true);
    expect(instanceShowsMember(s, '@trace', BARE, DEF)).toBe(true);
    expect(memberInstance(s, 'trace', KDEF, DEF)).toBe('@trace');
    // A blank default keys as the bare member only (a save omits the query).
    expect(instanceShowsMember(s, '@trace', memberKey({ tool: 'trace', query: '' }), '')).toBe(
      false
    );
    // An explicit query, or a from, is never re-read as the default.
    const blank = run(EMPTY_TABS, { type: 'newInstance', tool: 'trace' });
    expect(instanceShowsMember(blank, '@trace', KDEF, DEF)).toBe(false);
    const fromA = { ...s, instances: { '@trace': { query: null, from: KA } } };
    expect(instanceShowsMember(fromA, '@trace', KDEF, DEF)).toBe(false);
  });

  it('a member open with the default focuses the live instance, titled', () => {
    const s = run(live(), { type: 'openMember', member: DEFAULT_MEMBER, defaultQuery: DEF });
    expect(s.keys).toEqual(['@trace']);
    expect(s.instances['@trace']).toMatchObject({
      query: null,
      from: KDEF,
      title: 'Default orbit',
    });
  });

  it('Open all after save focuses, no duplicate (the toolQuery resolver)', () => {
    const before = run(live(), member({ screen: 'a/1' }, true));
    const plan = planOpenMany(before, [{ screen: 'a/1' }, DEFAULT_MEMBER], {
      screens: [{ id: '1', kind: 'ir', title: 'One', category: 'a', path: 'a/1.json' }],
      tools: ['trace'],
      toolQuery: (tool) => (tool === 'trace' ? DEF : undefined),
    });
    expect(plan.skipped).toEqual([]);
    expect(plan.state.keys).toEqual(['@trace', 'a/1']);
    expect(plan.keyOf.get(KDEF)).toBe('@trace');
    expect(plan.state.instances['@trace']).toMatchObject({ from: KDEF, title: 'Default orbit' });
  });

  it('Open all after save focuses, no duplicate (membersSaved records the member)', () => {
    // Save stores the live default instance as DEFAULT_MEMBER (SaveCollection) ...
    let s = live();
    s = run(s, {
      type: 'membersSaved',
      entries: [{ key: '@trace', from: KDEF, title: 'Default orbit' }],
    });
    expect(s.instances['@trace']).toMatchObject({
      query: null,
      from: KDEF,
      title: 'Default orbit',
    });
    // ... so Open all of the saved collection focuses it even without the resolver.
    const plan = planOpenMany(s, [DEFAULT_MEMBER], { screens: [], tools: ['trace'] });
    expect(plan.state.keys).toEqual(['@trace']);
    expect(plan.keyOf.get(KDEF)).toBe('@trace');
  });

  it('membersSaved ignores keys that are not open tool tabs and drops a missing name', () => {
    let s = run(EMPTY_TABS, member(TA), member({ screen: 'a/1' }, true));
    const same = run(s, {
      type: 'membersSaved',
      entries: [
        { key: '@trace/4', from: KDEF },
        { key: 'a/1', from: KDEF },
      ],
    });
    expect(same).toBe(s);
    s = run(s, { type: 'membersSaved', entries: [{ key: '@trace', from: KA }] });
    expect(s.instances['@trace']).toEqual(expect.objectContaining({ from: KA }));
    expect(s.instances['@trace']!.title).toBeUndefined();
  });
});
