// Replays the shared rejection and query vectors (e2e/fixtures/workspace/, a byte
// copy of canopy's tests/canopy_mcp/fixtures/workspace/) against the viewer's
// precheck. Every rejection vector and every query vector runs; a vector this
// file cannot replay is a failing test, never a skip.

import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ManifestScreen } from '../api.js';
import type { Member } from './collections.js';
import { EMPTY_TABS, fromLayout } from './tabs.js';
import type { ClosedAction, Layout, TabsState } from './tabs.js';
import { distinctValues, isAgentQuery, toolSpec } from './tools.js';
import {
  instanceShowing,
  MAX_OPEN_TABS,
  type PrecheckContext,
  precheckBatch,
  precheckCommand,
  rejectedFrom,
  type WorkspaceCommand,
} from './workspacePrecheck.js';

const ROOT = dirname(
  createRequire(import.meta.url).resolve('../../e2e/fixtures/workspace/context.json')
);

/* eslint-disable @typescript-eslint/no-explicit-any */
type Obj = Record<string, any>;

function load(rel: string): Obj {
  return JSON.parse(readFileSync(join(ROOT, rel), 'utf8')) as Obj;
}

function files(dir: string): string[] {
  return readdirSync(join(ROOT, dir))
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => `${dir}/${name}`);
}

const CONTEXT = load('context.json').context as Obj;
/** Now for the vectors: after every custom window they name. */
const NOW_MS = new Date('2026-10-18T12:00').getTime();

/** A vector context's reported state and closed list as the window's TabsState. */
function tabsOf(context: Obj): TabsState {
  const { state, closed } = context;
  const history: TabsState['history'] = {};
  for (const tab of state.tabs) {
    if (tab.canBack || tab.canForward) {
      history[tab.key] = {
        back: tab.canBack ? ['library/x/behind'] : [],
        forward: tab.canForward ? ['library/x/ahead'] : [],
      };
    }
  }
  const instances: TabsState['instances'] = {};
  for (const [key, instance] of Object.entries<Obj>(state.instances)) {
    instances[key] = { query: instance.query, view: null };
  }
  // A closed group of tabs is one engine `tabs` record, each tab where it was.
  const closedStack: ClosedAction[] = (closed as Obj[]).map((group) => ({
    id: group.id,
    kind: 'tabs',
    closedBy: group.by,
    panels: {},
    records: (group.tabs as string[]).map((key, index) => ({
      kind: 'tab' as const,
      key,
      tile: 't1',
      index,
      showing: false,
    })),
  }));
  // The holder: the reported layout, focus on the active tab's tile.
  const layout = (state.layout ?? null) as Layout | null;
  const holder: TabsState =
    layout === null
      ? { ...EMPTY_TABS, keys: state.tabs.map((tab: Obj) => tab.key), active: state.active }
      : fromLayout(layout, tileOf(layout, state.active));
  return {
    ...holder,
    instances,
    toolMru: [...state.toolMru],
    history,
    closedStack,
  };
}

/** The id of the tile of `layout` holding `key`, or null. */
function tileOf(layout: Layout, key: string | null): string | null {
  if ('tabs' in layout) return key !== null && layout.tabs.includes(key) ? layout.tile : null;
  for (const item of layout.items) {
    const id = tileOf(item, key);
    if (id !== null) return id;
  }
  return null;
}

/** The manifest's refs ('<category>/<id>') as the viewer's manifest screens. */
function screensOf(refs: string[]): ManifestScreen[] {
  return refs.map((ref) => {
    const slash = ref.indexOf('/');
    return {
      category: ref.slice(0, slash),
      id: ref.slice(slash + 1),
      kind: 'ir',
      title: ref,
      path: `${ref}.screen.json`,
    };
  });
}

function precheckContext(context: Obj): PrecheckContext {
  return {
    tabs: tabsOf(context),
    layout: context.state.layout,
    screens: screensOf(context.manifest),
    tools: context.tools,
    collections: (context.collections as Obj[]).map((entry) => ({
      ref: entry.ref,
      members: entry.members as Member[],
    })),
    busy: context.busy,
    nowMs: NOW_MS,
  };
}

/** The case's context: context.json's with each key the case names replaced whole. */
function caseContext(kase: Obj): Obj {
  return { ...CONTEXT, ...(kase.context ?? {}) };
}

/**
 * The apply loop's precheck walk: the batch check, then each command in turn. A
 * command that passes stands in as applied (its own change moves both the
 * window's seq and the seq the loop expects); `operatorChangeAfter` moves the
 * window's seq alone.
 */
function replay(kase: Obj): Obj[] {
  const context = caseContext(kase);
  const commands = kase.batch.commands as WorkspaceCommand[];
  const base = precheckContext(context);
  let seq: number = context.seq;
  let expectedSeq = seq;
  const stale = precheckBatch(kase.batch.base, seq);
  if (stale) return rejectedFrom(commands, 0, stale);
  const results: Obj[] = [];
  for (const [index, command] of commands.entries()) {
    const reason = precheckCommand(command, { ...base, seq, expectedSeq });
    if (reason) return [...results, ...rejectedFrom(commands, index, reason)];
    results.push({ id: command.id, status: 'applied' });
    seq += 1;
    expectedSeq += 1;
    if (kase.operatorChangeAfter === command.id) seq += 1;
  }
  return results;
}

/** The posted results the precheck decides: an applied entry's extras are the apply loop's. */
function decided(results: Obj[]): Obj[] {
  return results.map((result) =>
    result.status === 'applied' ? { id: result.id, status: 'applied' } : result
  );
}

const REJECTION_FILES = files('rejections');

describe('workspacePrecheck rejection vectors', () => {
  it('covers every rejection reason', () => {
    expect(REJECTION_FILES.map((file) => file.slice('rejections/'.length, -5))).toEqual([
      'instance_cap',
      'invalid_args',
      'no_history',
      'not_zoomable',
      'nothing_to_reopen',
      'operator_busy',
      'stale_state',
      'tab_limit',
      'unknown_target',
    ]);
  });

  for (const file of REJECTION_FILES) {
    describe(file, () => {
      for (const kase of load(file).cases as Obj[]) {
        it(kase.name, () => {
          expect(replay(kase)).toEqual(decided(kase.results));
        });
      }
    });
  }
});

describe('workspacePrecheck query vectors', () => {
  for (const file of files('queries')) {
    const tool = file.slice('queries/'.length, -5);
    describe(file, () => {
      for (const kase of load(file).cases as Obj[]) {
        it(`${kase.name} -> ${kase.verdict}`, () => {
          const bytes = new TextEncoder().encode(kase.query).length;
          if (kase.verdict === 'invalid_command') {
            // The hub's only query bound: the batch never reaches the window.
            expect(bytes).toBeGreaterThan(4096);
            return;
          }
          expect(bytes).toBeLessThanOrEqual(4096);
          const ctx = precheckContext(CONTEXT);
          const command = { id: 'c-e1-1', cmd: 'open_tool', args: { tool, query: kase.query } };
          const expected = kase.verdict === 'accepted' ? null : 'invalid_args';
          expect(precheckCommand(command, ctx)).toBe(expected);
          // set_query into an open instance of the tool reads the same grammar.
          const key = `@${tool}`;
          const withInstance: PrecheckContext = {
            ...ctx,
            tabs: {
              ...ctx.tabs,
              keys: ctx.tabs.keys.includes(key) ? ctx.tabs.keys : [...ctx.tabs.keys, key],
              instances: { ...ctx.tabs.instances, [key]: { query: '', view: null } },
            },
          };
          const setQuery = { id: 'c-e1-1', cmd: 'set_query', args: { key, query: kase.query } };
          expect(precheckCommand(setQuery, withInstance)).toBe(expected);
        });
      }
    });
  }
});

describe('workspacePrecheck rules beyond the vectors', () => {
  const ctx = precheckContext(CONTEXT);
  const command = (cmd: string, args: Obj = {}): WorkspaceCommand => ({ id: 'c-1', cmd, args });

  /** The default context padded with screen tabs up to `count` open tabs. */
  function withTabs(count: number): PrecheckContext {
    const keys = [...ctx.tabs.keys];
    for (let n = 1; keys.length < count; n += 1) keys.push(`library/common/KnobPanel?N=${n}`);
    return { ...ctx, tabs: { ...ctx.tabs, keys } };
  }

  it('passes every verb on a target that is there', () => {
    const verbs: WorkspaceCommand[] = [
      command('open', { ref: 'library/s3-promo/promotion' }),
      command('open_tool', { tool: 'correlation' }),
      command('focus', { key: '@trace' }),
      command('close_tab', { key: 'library/xfer/TransferView' }),
      command('close_tile', { tile: 't2' }),
      command('close_others', { key: '@trace' }),
      command('close_right', { key: '@trace' }),
      command('close_all'),
      command('reopen'),
      command('reopen', { id: 'g-1' }),
      command('back', { key: 'library/linac/LinacView?SR=1' }),
      command('drop', { source: { tab: '@trace' }, target: { tile: 't1', zone: 'centre' } }),
      command('drop', { source: { tab: '@trace' }, target: { tile: 't1', zone: 'tab', index: 2 } }),
      command('drop', { source: { tile: 't3' }, target: { tile: 't1', edge: 'left' } }),
      command('drop', {
        source: { tab: '@trace' },
        target: { border: { tile: 't2', side: 'top' } },
      }),
      command('drop', { source: { new: { ref: 'drafts/beam-tune' } }, target: { outer: 'right' } }),
      command('drop', { source: { new: { tool: 'waveform' } }, target: { outer: 'bottom' } }),
      command('open_set', {
        members: [{ ref: 'drafts/beam-tune' }, { tool: 'waveform' }],
        as: 'tabs',
      }),
      command('open_set', {
        members: [{ ref: 'drafts/beam-tune' }, { tool: 'waveform' }],
        as: 'layout',
        layout: { split: 'row', items: [{ tabs: [0] }, { tabs: [1] }] },
      }),
      command('open_collection', { ref: 'personal:grid' }),
      command('open_collection', { ref: 'personal:grid', as: 'side' }),
      command('set_query', { key: '@trace', query: 'pv=B&range=-2h' }),
      command('zoom', { key: 'library/xfer/TransferView', percent: 120 }),
      command('reset_layout'),
    ];
    for (const verb of verbs)
      expect([verb.cmd, precheckCommand(verb, ctx)]).toEqual([verb.cmd, null]);
  });

  it('rejects each new verb on a target that is not there', () => {
    const cases: Array<[WorkspaceCommand, string]> = [
      [command('close_tab', { key: '@waveform' }), 'unknown_target'],
      [command('close_tile', { tile: 't9' }), 'unknown_target'],
      [command('drop', { source: { tile: 't9' }, target: { outer: 'left' } }), 'unknown_target'],
      [
        command('drop', {
          source: { tab: '@trace' },
          target: { border: { tile: 't9', side: 'top' } },
        }),
        'unknown_target',
      ],
      [
        command('drop', {
          source: { new: { ref: 'library/linac/Missing' } },
          target: { outer: 'left' },
        }),
        'unknown_target',
      ],
      [
        command('drop', {
          source: { new: { tool: 'trace', query: 'foo=bar' } },
          target: { outer: 'left' },
        }),
        'invalid_args',
      ],
      [
        command('open_set', {
          members: [{ tool: 'trace', query: 'pv=A&range=yesterday' }],
          as: 'tabs',
        }),
        'invalid_args',
      ],
    ];
    for (const [verb, reason] of cases) {
      expect([verb.cmd, precheckCommand(verb, ctx)]).toEqual([verb.cmd, reason]);
    }
  });

  it('without a known layout, every tile id is an unknown target', () => {
    const blind: PrecheckContext = { ...ctx, layout: undefined };
    expect(precheckCommand(command('close_tile', { tile: 't1' }), blind)).toBe('unknown_target');
    const onto = command('drop', {
      source: { tab: '@trace' },
      target: { tile: 't1', zone: 'centre' },
    });
    expect(precheckCommand(onto, blind)).toBe('unknown_target');
  });

  it('chrome-off refuses what needs a second tile as no_dock, and keeps the rest', () => {
    const off: PrecheckContext = { ...ctx, dock: false };
    const members = [{ ref: 'drafts/beam-tune' }, { tool: 'waveform' }];
    const refused = [
      command('drop', { source: { tab: '@trace' }, target: { outer: 'right' } }),
      command('drop', {
        source: { new: { ref: 'drafts/beam-tune' } },
        target: { tile: 't1', zone: 'centre' },
      }),
      command('open_set', { members, as: 'side' }),
      command('open_set', {
        members,
        as: 'layout',
        layout: { split: 'row', items: [{ tabs: [0] }, { tabs: [1] }] },
      }),
      command('open_collection', { ref: 'personal:grid', as: 'side' }),
      command('open_collection', { ref: 'personal:grid', as: 'layout' }),
    ];
    for (const verb of refused) {
      expect([verb.cmd, precheckCommand(verb, off)]).toEqual([verb.cmd, 'no_dock']);
    }
    // Opens become tabs of the one tile.
    const kept = [
      command('open', { ref: 'drafts/beam-tune' }),
      command('open_tool', { tool: 'waveform' }),
      command('open_set', { members, as: 'tabs' }),
      command('open_collection', { ref: 'personal:grid' }),
      command('open_collection', { ref: 'personal:grid', as: 'tabs' }),
      command('close_tab', { key: '@trace' }),
      command('reset_layout'),
    ];
    for (const verb of kept) {
      expect([verb.cmd, precheckCommand(verb, off)]).toEqual([verb.cmd, null]);
    }
    // The window's own reasons still come first; a missing target after no_dock.
    const drop = command('drop', { source: { tab: '@nope' }, target: { outer: 'right' } });
    expect(precheckCommand(drop, { ...off, busy: true })).toBe('operator_busy');
    expect(precheckCommand(drop, off)).toBe('no_dock');
  });

  it('the retired verbs are invalid_args', () => {
    for (const cmd of ['close', 'place', 'remove_tile']) {
      expect([cmd, precheckCommand(command(cmd, { key: '@trace' }), ctx)]).toEqual([
        cmd,
        'invalid_args',
      ]);
    }
  });

  it('rejects an unknown verb as invalid_args', () => {
    expect(precheckCommand(command('explode'), ctx)).toBe('invalid_args');
  });

  it('open of a screen with macros keys it by its canonical macros', () => {
    const at = withTabs(MAX_OPEN_TABS);
    const open = command('open', { ref: 'library/linac/LinacView', macros: { SR: '1' } });
    expect(precheckCommand(open, at)).toBeNull();
    expect(precheckCommand(command('open', { ref: 'library/linac/LinacView' }), at)).toBe(
      'tab_limit'
    );
  });

  it('a manifest screen that is not kind ir is not a target', () => {
    const screens = ctx.screens.map((screen) =>
      screen.id === 's3-promo/promotion' ? { ...screen, kind: 'code' } : screen
    );
    const open = command('open', { ref: 'library/s3-promo/promotion' });
    expect(precheckCommand(open, { ...ctx, screens })).toBe('unknown_target');
  });

  it('tab_limit counts only the tabs a command adds', () => {
    const at = withTabs(MAX_OPEN_TABS);
    expect(precheckCommand(command('open', { ref: 'library/xfer/TransferView' }), at)).toBeNull();
    const reDrop = command('drop', {
      source: { new: { ref: 'library/xfer/TransferView' } },
      target: { outer: 'left' },
    });
    expect(precheckCommand(reDrop, at)).toBeNull();
    const shown = command('open_tool', {
      tool: 'trace',
      query: 'pv=SR:DIAG:DCCT:01:CURRENT:RB&range=-1h',
    });
    expect(precheckCommand(shown, at)).toBeNull();
    expect(
      precheckCommand(command('open', { ref: 'library/s3-promo/promotion' }), withTabs(49))
    ).toBeNull();
  });

  it('reopen of a layout group adds no tab', () => {
    const at = withTabs(MAX_OPEN_TABS);
    const tabs: TabsState = {
      ...at.tabs,
      closedStack: [{ id: 'g-1', kind: 'layout', closedBy: 'agent', panels: {}, layout: null }],
    };
    expect(precheckCommand(command('reopen'), { ...at, tabs })).toBeNull();
  });

  it('open_tool focuses the instance already showing the query, even at the cap', () => {
    const tabs: TabsState = {
      ...ctx.tabs,
      keys: [...ctx.tabs.keys],
      instances: { ...ctx.tabs.instances },
    };
    for (let n = 2; n <= 10; n += 1) {
      tabs.keys.push(`@trace/${n}`);
      tabs.instances[`@trace/${n}`] = { query: `pv=X${n}`, view: null };
    }
    const capped = { ...ctx, tabs };
    expect(
      precheckCommand(command('open_tool', { tool: 'trace', query: 'pv=X7' }), capped)
    ).toBeNull();
    expect(instanceShowing(tabs, 'trace', 'pv=X7')).toBe('@trace/7');
    expect(precheckCommand(command('open_tool', { tool: 'trace', query: 'pv=Y' }), capped)).toBe(
      'instance_cap'
    );
  });

  it('an instance on its default shows the default query', () => {
    const tabs: TabsState = {
      ...ctx.tabs,
      instances: { '@trace': { query: null, view: null } },
    };
    expect(instanceShowing(tabs, 'trace', 'pv=D', 'pv=D')).toBe('@trace');
    expect(instanceShowing(tabs, 'trace', undefined)).toBe('@trace');
    expect(instanceShowing(tabs, 'trace', 'pv=E', 'pv=D')).toBeNull();
  });

  it('back and forward on a tool instance have no history', () => {
    expect(precheckCommand(command('back', { key: '@trace' }), ctx)).toBe('no_history');
  });

  it('reopen of a named group on an empty stack is an unknown target', () => {
    const tabs: TabsState = { ...ctx.tabs, closedStack: [] };
    expect(precheckCommand(command('reopen', { id: 'g-1' }), { ...ctx, tabs })).toBe(
      'unknown_target'
    );
  });

  it('stale_state comes before operator_busy, and both before the target', () => {
    const missing = command('focus', { key: '@nope' });
    expect(precheckCommand(missing, { ...ctx, busy: true, seq: 43, expectedSeq: 42 })).toBe(
      'stale_state'
    );
    expect(precheckCommand(missing, { ...ctx, busy: true, seq: 42, expectedSeq: 42 })).toBe(
      'operator_busy'
    );
  });

  it('precheckBatch: no base, or base.seq equal to the window seq, passes', () => {
    expect(precheckBatch(undefined, 41)).toBeNull();
    expect(precheckBatch(null, 41)).toBeNull();
    expect(precheckBatch({ seq: 41 }, 41)).toBeNull();
    expect(precheckBatch({ seq: 40 }, 41)).toBe('stale_state');
  });

  it('rejectedFrom skips every later command after the rejected one', () => {
    const commands = [
      command('focus'),
      { ...command('close_tab'), id: 'c-2' },
      { ...command('close_all'), id: 'c-3' },
    ];
    expect(rejectedFrom(commands, 1, 'unknown_target')).toEqual([
      { id: 'c-2', status: 'rejected', reason: 'unknown_target' },
      { id: 'c-3', status: 'skipped', after: 'c-2' },
    ]);
    expect(rejectedFrom(commands, 3, 'unknown_target')).toEqual([]);
  });

  it('a custom Trace range without to ends now', () => {
    const future = command('open_tool', {
      tool: 'trace',
      query: 'pv=A&range=custom&from=2026-10-19T10:00',
    });
    expect(precheckCommand(future, ctx)).toBe('invalid_args');
    const equal = command('open_tool', {
      tool: 'trace',
      query: 'pv=A&range=custom&from=2026-09-30T10:00&to=2026-09-30T10:00',
    });
    expect(precheckCommand(equal, ctx)).toBe('invalid_args');
    const impossible = command('open_tool', {
      tool: 'trace',
      query: 'pv=A&range=custom&from=2026-13-45T10:00',
    });
    expect(precheckCommand(impossible, ctx)).toBe('invalid_args');
  });

  it('the tool spec carries each tool PV key and cap', () => {
    expect(
      ['trace', 'correlation', 'waveform'].map((id) => [toolSpec(id)?.pvKey, toolSpec(id)?.maxPvs])
    ).toEqual([
      ['pv', 12],
      ['y', 8],
      ['pv', 8],
    ]);
    expect(distinctValues('pv=A&pv=A&pv=&pv=+&pv=B', 'pv')).toBe(2);
    const twelve = Array.from({ length: 12 }, (_, n) => `pv=P${n}`).join('&');
    expect(isAgentQuery(toolSpec('trace')!, twelve, NOW_MS)).toBe(true);
    expect(isAgentQuery(toolSpec('trace')!, `${twelve}&pv=P12`, NOW_MS)).toBe(false);
    expect(isAgentQuery(toolSpec('trace')!, 42, NOW_MS)).toBe(false);
  });
});
