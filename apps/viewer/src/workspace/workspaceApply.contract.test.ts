// The apply loop (workspaceApply.ts) against the shared command and rejection
// vectors (e2e/fixtures/workspace/, a byte copy of canopy's), on a window
// model driven by the real tabs reducer, and its timing rules: busy waits,
// the deadline, the one manifest refetch, the guard's arming and the single
// result POST. A vector this file cannot replay is a failing test, never a skip.

import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManifestScreen } from '../api.js';
import { createWriteGuard, GUARD_MS } from '../writeGate/guard.js';
import type { WriteGuard } from '../writeGate/guard.js';
import type { ZoomState } from '../ZoomContext.js';
import { memberKey, planOpenMany } from './collections.js';
import type { Member } from './collections.js';
import { mapCollection } from './dock/collectionLayout.js';
import { findTile, tileOf, isTile, keysOf } from '@slaclab/canopy-dock-engine';
import type { CollectionLayout, Layout, Tile } from '@slaclab/canopy-dock-engine';
import { reopenClosed, stepTabs, tabsReducer } from './tabs.js';
import type {
  ClosedAction,
  ClosedBy,
  OpenSetAs,
  TabsAction,
  TabsState,
  ToolInstance,
} from './tabs.js';
import { isToolKey } from './tools.js';
import {
  applyBatch,
  BUSY_MARGIN_MS,
  createBatchApplier,
  HIGHLIGHT_MS,
  highlightTouched,
  refusalReason,
  ScreenReadiness,
  TOUCHED_ATTR,
  type ApplyPort,
  type Touch,
} from './workspaceApply.js';
import type { BatchEvent, BatchResult } from './workspaceSync.js';

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
const NOW_MS = new Date('2026-10-18T12:00').getTime();

/**
 * The holder behind a context: its state's layout (keys in the layout's tree
 * order), the tile showing its active key focused, and its flat closed groups
 * as engine `tabs` records of a tile that is gone (so they reopen as tabs of the focused tile).
 */
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
  const closedStack: ClosedAction[] = (closed as Obj[]).map((group) => ({
    id: group.id,
    kind: 'tabs',
    closedBy: group.by,
    panels: {},
    records: (group.tabs as string[]).map((key, index) => ({
      kind: 'tab',
      key,
      tile: 't-gone',
      index,
      showing: index === 0,
    })),
  }));
  const layout = (state.layout ?? null) as Layout | null;
  return {
    keys: keysOf(layout),
    active: state.active,
    layout,
    focusedTile: state.active === null ? null : (tileOf(layout, state.active)?.tile ?? null),
    instances,
    toolMru: [...state.toolMru],
    history,
    closedStack,
  };
}

/** Every tile of `layout` as an equal column of one row (the page's resetTiles). */
function resetTiles(layout: Layout | null): Layout | null {
  const tiles: Tile[] = [];
  const visit = (node: Layout) => {
    if (isTile(node)) tiles.push({ tile: node.tile, tabs: node.tabs, showing: node.showing });
    else node.items.forEach(visit);
  };
  if (layout !== null) visit(layout);
  if (tiles.length < 2) return null;
  return { split: 'row', items: tiles.map((t) => ({ ...t, size: 1 / tiles.length })) };
}

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

function caseContext(kase: Obj): Obj {
  return { ...CONTEXT, ...(kase.context ?? {}) };
}

/** The category/id a tab key's zoom is stored under. */
function screenOf(key: string): string {
  const cut = key.indexOf('?');
  return cut === -1 ? key : key.slice(0, cut);
}

interface Model {
  port: ApplyPort;
  tabs(): TabsState;
  posts: BatchResult[];
  dispatched: TabsAction[];
  closes: { keys: readonly string[]; closedBy: ClosedBy; id: string }[];
  undoOffers: string[];
  highlights: Touch[][];
  guard: WriteGuard;
  paint(): void;
  /** Bumped by the test: an operator change. */
  operatorChange(): void;
  setMounted(keys: string[]): void;
  /** Called after each command's dispatch (setApplying(false)). */
  afterCommand: (index: number) => void;
  setBusy(busy: boolean): void;
  screens: ManifestScreen[];
  readyOf: Map<string, Promise<unknown>>;
  refetches: number;
}

/** A window: the real reducer, a model dock and zoom, the real input guard. */
function model(context: Obj, overrides: Partial<ApplyPort> = {}): Model {
  let tabs = tabsOf(context);
  let minted = 1;
  let operatorChanges = 0;
  let commandIndex = -1;
  let busy = context.busy === true;
  const busyListeners = new Set<(busy: boolean) => void>();
  const zoom = new Map<string, ZoomState>();
  for (const [screen, entry] of Object.entries<Obj>(context.state.zoom ?? {})) {
    zoom.set(
      screen,
      entry.mode === 'manual'
        ? { mode: 'manual', scale: entry.percent / 100 }
        : { mode: 'fit', scale: 1 }
    );
  }
  const queued: Array<() => void> = [];
  const guard = createWriteGuard({ nextPaint: (cb) => queued.push(cb) });
  let mounted: string[] = [];
  const m: Model = {
    posts: [],
    dispatched: [],
    closes: [],
    undoOffers: [],
    highlights: [],
    guard,
    tabs: () => tabs,
    paint: () => {
      for (const cb of queued.splice(0)) cb();
    },
    operatorChange: () => {
      operatorChanges += 1;
    },
    setMounted: (keys) => {
      mounted = keys;
    },
    afterCommand: () => {},
    setBusy: (next) => {
      if (next === busy) return;
      busy = next;
      for (const l of [...busyListeners]) l(next);
    },
    screens: screensOf(context.manifest),
    readyOf: new Map(),
    refetches: 0,
    port: undefined as unknown as ApplyPort,
  };
  const dispatch = (action: TabsAction) => {
    m.dispatched.push(action);
    tabs = tabsReducer(tabs, action);
  };
  const mint = () => {
    minted += 1;
    return `g-${minted}`;
  };
  const collections = (context.collections as Obj[]).map((entry) => ({
    ref: entry.ref as string,
    members: entry.members as Member[],
    layout: entry.layout as CollectionLayout<number> | null,
  }));
  m.port = {
    tabs: () => tabs,
    dispatch,
    closeTabs: (keys, make, closedBy) => {
      const closing = tabs.keys.filter((k) => keys.includes(k));
      if (closing.length === 0) return null;
      const id = mint();
      dispatch(make({ id, closedBy }));
      m.closes.push({ keys: closing, closedBy, id });
      m.undoOffers.push(id);
      return id;
    },
    reopenGroup: (id) => {
      const { entry } = reopenClosed(tabs, id);
      if (entry === undefined) return null;
      dispatch({ type: 'reopenClosed', id: entry.id });
      return entry;
    },
    resetLayout: (closedBy) => {
      const layout = resetTiles(tabs.layout);
      if (layout === null) return null;
      const id = mint();
      dispatch({ type: 'replaceLayout', layout, closed: { id, closedBy } });
      m.undoOffers.push(id);
      return id;
    },
    zoomOf: (key) => zoom.get(screenOf(key)) ?? { mode: 'fit', scale: 1 },
    setZoom: (key, state) => {
      if (state.mode === 'fit') zoom.delete(screenOf(key));
      else zoom.set(screenOf(key), state);
    },
    reportedScale: () => undefined,
    // useCollections' Open all, as the page runs it for the agent.
    openAll: async (source, options) => {
      const collection =
        typeof source === 'string'
          ? collections.find((entry) => entry.ref === source)
          : { ref: 'agent:open_set', members: [...source], layout: null };
      if (collection === undefined) return null;
      const layout = options.layout ?? collection.layout;
      const as: OpenSetAs = options.as ?? (layout !== null ? 'layout' : 'side');
      if (as === 'layout' && layout === null) {
        return { keys: [], changed: false, group: null, refusal: 'no_layout' };
      }
      const plan = planOpenMany(tabs, collection.members, {
        screens: m.screens,
        tools: context.tools,
      });
      const keyOfIndex = (index: number) => {
        const member = collection.members[index];
        return member === undefined ? undefined : plan.keyOf.get(memberKey(member));
      };
      const keys = [
        ...new Set(
          collection.members
            .map((member) => plan.keyOf.get(memberKey(member)))
            .filter((key): key is string => key !== undefined)
        ),
      ];
      const instances: Record<string, ToolInstance> = {};
      for (const key of keys) {
        const planned = plan.state.instances[key];
        if (planned === undefined || !isToolKey(key)) continue;
        const seed: ToolInstance = { ...planned };
        delete seed.epoch;
        instances[key] = seed;
      }
      const group = `g-${minted + 1}`;
      const keyed = as === 'layout' ? (mapCollection(layout!, keyOfIndex) ?? undefined) : undefined;
      const action: TabsAction = {
        type: 'openSet',
        members: keys,
        as,
        ...(keyed !== undefined ? { collection: keyed } : {}),
        caller: 'agent',
        instances,
        closed: { id: group, closedBy: options.closedBy },
      };
      const step = stepTabs(tabs, action);
      if (step.refusal !== undefined) {
        return { keys: [], changed: false, group: null, refusal: step.refusal };
      }
      const before = tabs;
      dispatch(action);
      const replaced = tabs.closedStack?.at(-1)?.id === group;
      if (replaced) {
        minted += 1;
        m.undoOffers.push(group);
      }
      return {
        keys: keys.filter((key) => tabs.keys.includes(key)),
        changed:
          JSON.stringify([tabs.layout, tabs.focusedTile]) !==
          JSON.stringify([before.layout, before.focusedTile]),
        group: replaced ? group : null,
      };
    },
    toolQuery: () => undefined,
    settled: () => Promise.resolve(),
    precheckInputs: () => ({
      screens: m.screens,
      tools: context.tools,
      collections,
    }),
    refetch: async () => {
      m.refetches += 1;
    },
    seq: () => context.seq,
    operatorChanges: () => operatorChanges,
    setApplying: (applying) => {
      if (applying) commandIndex += 1;
      else m.afterCommand(commandIndex);
    },
    mounted: () => mounted,
    screenReady: (key) => m.readyOf.get(key) ?? Promise.resolve(),
    isBusy: () => busy,
    onBusyChange: (listener) => {
      busyListeners.add(listener);
      return () => busyListeners.delete(listener);
    },
    arm: () => guard.arm(),
    highlight: (touched) => {
      m.highlights.push([...touched]);
    },
    post: async (result) => {
      m.posts.push(result);
      return 204;
    },
    now: () => Date.now(),
    ...overrides,
  };
  return m;
}

function batchOf(commands: Obj[], extra: Partial<BatchEvent> = {}): BatchEvent {
  return {
    batch: 'b-e1-1',
    window: 'w-A',
    deadline: new Date(Date.now() + 10_000).toISOString(),
    commands: commands.map((command, i) => ({
      id: command.id ?? `c-e1-${i + 1}`,
      cmd: command.cmd,
      args: command.args ?? {},
    })),
    ...extra,
  };
}

/** Runs `promise` to completion under fake timers. */
async function settle<T>(promise: Promise<T>, ms = 0): Promise<T> {
  await vi.advanceTimersByTimeAsync(ms);
  return promise;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_MS);
});
afterEach(() => {
  vi.useRealTimers();
});

const COMMAND_FILES = files('commands');

describe('workspaceApply command vectors', () => {
  it('covers every verb', () => {
    expect(COMMAND_FILES.map((file) => load(file).verb).sort()).toEqual([
      'back',
      'close_all',
      'close_others',
      'close_right',
      'close_tab',
      'close_tile',
      'drop',
      'focus',
      'forward',
      'open',
      'open_collection',
      'open_set',
      'open_tool',
      'reopen',
      'reset_layout',
      'set_query',
      'zoom',
    ]);
  });

  for (const file of COMMAND_FILES) {
    const vectors = load(file);
    describe(file, () => {
      for (const kase of vectors.cases as Obj[]) {
        it(kase.name, async () => {
          const w = model(caseContext(kase));
          const batch = batchOf([kase.command]);
          const results = await settle(applyBatch(batch, w.port));
          expect(results).toEqual([{ id: 'c-e1-1', ...kase.result }]);
          expect(w.posts).toEqual([{ batch: 'b-e1-1', results }]);
          // A set opened in a layout replaces the dock (the holder's replaceDock):
          // what stays open is exactly its members. The vectors' `after` lists
          // the tabs open before as well, which no dock layout can hold (the
          // hub takes a layout holding exactly the open tabs).
          const replacesDock =
            vectors.destructive === 'with layout' && kase.result.group !== undefined;
          const sorted = (keys: readonly string[]) => [...keys].sort();
          if (replacesDock) {
            expect(sorted(w.tabs().keys)).toEqual(sorted(kase.result.keys));
          } else if (kase.after) {
            // `after.tabs` is in the vectors' flat order; the holder's is its layout's.
            expect(sorted(w.tabs().keys)).toEqual(sorted(kase.after.tabs));
            if ('active' in kase.after) expect(w.tabs().active).toBe(kase.after.active);
          }
          // The window's layout always holds exactly its open tabs.
          expect(sorted(keysOf(w.tabs().layout))).toEqual(sorted(w.tabs().keys));
          const destructive = vectors.destructive === true || replacesDock;
          if (destructive && kase.result.changed) {
            // The undo entry is pushed by the agent, and offered.
            const group = (w.tabs().closedStack ?? []).find((e) => e.id === kase.result.group);
            expect(group?.closedBy).toBe('agent');
            expect(w.undoOffers).toContain(kase.result.group);
          }
          if (!kase.result.changed) expect(w.highlights).toEqual([]);
          if (kase.result.changed && vectors.verb === 'zoom') {
            expect(w.highlights).toEqual([[{ key: kase.command.args.key, part: 'zoom' }]]);
          }
        });
      }
    });
  }
});

describe('workspaceApply rejection vectors', () => {
  for (const file of files('rejections')) {
    describe(file, () => {
      for (const kase of load(file).cases as Obj[]) {
        it(kase.name, async () => {
          const context = caseContext(kase);
          const w = model(context);
          const commands = kase.batch.commands as Obj[];
          const changeAfter = commands.findIndex((c) => c.id === kase.operatorChangeAfter);
          w.afterCommand = (index) => {
            // After the command has committed, before the next one starts.
            if (index === changeAfter) queueMicrotask(w.operatorChange);
          };
          const batch = batchOf(commands, kase.batch.base ? { base: kase.batch.base } : {});
          const results = await settle(applyBatch(batch, w.port), 10_000);
          // Applied entries carry extras the command vectors pin; compare the verdicts.
          const verdicts = (results ?? []).map((r) =>
            r.status === 'applied' ? { id: r.id, status: 'applied', changed: r.changed } : r
          );
          const expected = (kase.results as Obj[]).map((r) =>
            r.status === 'applied' ? { id: r.id, status: 'applied', changed: r.changed ?? true } : r
          );
          expect(verdicts).toEqual(expected);
          expect(w.posts).toHaveLength(1);
        });
      }
    });
  }
});

describe('workspaceApply loop', () => {
  it('stops at the first rejection: later commands are never dispatched', async () => {
    const w = model(CONTEXT);
    const results = await settle(
      applyBatch(
        batchOf([
          { cmd: 'focus', args: { key: '@trace' } },
          { cmd: 'focus', args: { key: 'library/nope/missing' } },
          { cmd: 'close_all' },
        ]),
        w.port
      )
    );
    expect(results).toEqual([
      { id: 'c-e1-1', status: 'applied', changed: true },
      { id: 'c-e1-2', status: 'rejected', reason: 'unknown_target' },
      { id: 'c-e1-3', status: 'skipped', after: 'c-e1-2' },
    ]);
    expect(w.tabs().keys).toHaveLength(4);
    expect(w.dispatched).toEqual([{ type: 'focus', key: '@trace' }]);
  });

  it('a stale base rejects the first command and dispatches nothing', async () => {
    const w = model(CONTEXT);
    const results = await settle(
      applyBatch(batchOf([{ cmd: 'close_all' }], { base: { window: 'w-A', seq: 40 } }), w.port)
    );
    expect(results).toEqual([{ id: 'c-e1-1', status: 'rejected', reason: 'stale_state' }]);
    expect(w.dispatched).toEqual([]);
    expect(w.posts).toHaveLength(1);
  });

  it('an operator change between commands fails the next one stale_state', async () => {
    const w = model(CONTEXT);
    w.afterCommand = (index) => {
      if (index === 0) queueMicrotask(w.operatorChange);
    };
    const results = await settle(
      applyBatch(
        batchOf([
          { cmd: 'focus', args: { key: '@trace' } },
          { cmd: 'focus', args: { key: 'library/xfer/TransferView' } },
        ]),
        w.port
      )
    );
    expect(results?.[1]).toEqual({ id: 'c-e1-2', status: 'rejected', reason: 'stale_state' });
  });

  it("the agent's own changes are not operator changes", async () => {
    const w = model(CONTEXT);
    const results = await settle(
      applyBatch(
        batchOf([
          { cmd: 'focus', args: { key: '@trace' } },
          { cmd: 'focus', args: { key: 'library/xfer/TransferView' } },
          { cmd: 'close_tab', args: { key: '@trace' } },
        ]),
        w.port
      )
    );
    expect(results?.map((r) => r.status)).toEqual(['applied', 'applied', 'applied']);
  });

  it('posts exactly one result per batch, after the last command, with every entry', async () => {
    const w = model(CONTEXT);
    let postedAt = -1;
    w.port.post = async (result) => {
      postedAt = w.dispatched.length;
      w.posts.push(result);
      return 204;
    };
    await settle(
      applyBatch(
        batchOf([
          { cmd: 'focus', args: { key: '@trace' } },
          { cmd: 'open', args: { ref: 'library/s3-promo/promotion' } },
          { cmd: 'zoom', args: { key: 'library/xfer/TransferView', step: 'in' } },
        ]),
        w.port
      )
    );
    expect(w.posts).toHaveLength(1);
    expect(w.posts[0]!.results).toHaveLength(3);
    expect(postedAt).toBe(w.dispatched.length);
  });

  describe('expiry', () => {
    it('abandons at the deadline: no further command, no POST', async () => {
      const w = model(CONTEXT);
      // The first command takes past the deadline to commit.
      let first = true;
      w.port.settled = () =>
        first
          ? ((first = false), new Promise<void>((resolve) => setTimeout(resolve, 2_000)))
          : Promise.resolve();
      const run = applyBatch(
        batchOf([{ cmd: 'focus', args: { key: '@trace' } }, { cmd: 'close_all' }], {
          deadline: new Date(NOW_MS + 1_000).toISOString(),
        }),
        w.port
      );
      const results = await settle(run, 3_000);
      expect(results).toBeNull();
      expect(w.posts).toEqual([]);
      expect(w.tabs().keys).toHaveLength(4);
    });

    it('a batch whose deadline already passed is not applied', async () => {
      const w = model(CONTEXT);
      const results = await settle(
        applyBatch(
          batchOf([{ cmd: 'close_all' }], { deadline: new Date(NOW_MS - 1).toISOString() }),
          w.port
        )
      );
      expect(results).toBeNull();
      expect(w.dispatched).toEqual([]);
      expect(w.posts).toEqual([]);
    });

    it('without a deadline the batch closes DELIVERY_MS after it arrived', async () => {
      const w = model(CONTEXT, { isBusy: () => true, onBusyChange: () => () => {} });
      const run = applyBatch(batchOf([{ cmd: 'close_all' }], { deadline: undefined }), w.port);
      await vi.advanceTimersByTimeAsync(10_000 - BUSY_MARGIN_MS - 1);
      expect(w.posts).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(await run).toEqual([{ id: 'c-e1-1', status: 'rejected', reason: 'operator_busy' }]);
    });
  });

  describe('unknown target', () => {
    it('refetches the manifest once and applies a ref that has appeared', async () => {
      const w = model(CONTEXT);
      w.port.refetch = async () => {
        w.refetches += 1;
        w.screens = [...w.screens, ...screensOf(['drafts/new-one'])];
      };
      const results = await settle(
        applyBatch(batchOf([{ cmd: 'open', args: { ref: 'drafts/new-one' } }]), w.port)
      );
      expect(w.refetches).toBe(1);
      expect(results).toEqual([
        { id: 'c-e1-1', status: 'applied', changed: true, key: 'drafts/new-one' },
      ]);
    });

    it('refetches at most once per batch, and rejects when the ref is still missing', async () => {
      const w = model(CONTEXT);
      const results = await settle(
        applyBatch(
          batchOf([
            { cmd: 'open', args: { ref: 'library/s3-promo/promotion' } },
            { cmd: 'open', args: { ref: 'drafts/gone' } },
          ]),
          w.port
        )
      );
      expect(w.refetches).toBe(1);
      expect(results?.[1]).toEqual({ id: 'c-e1-2', status: 'rejected', reason: 'unknown_target' });

      const again = model(CONTEXT);
      await settle(
        applyBatch(
          batchOf([
            { cmd: 'open', args: { ref: 'drafts/gone' } },
            { cmd: 'open', args: { ref: 'drafts/gone-too' } },
          ]),
          again.port
        )
      );
      expect(again.refetches).toBe(1);
    });

    it('a missing tab key is final: no refetch', async () => {
      const w = model(CONTEXT);
      await settle(applyBatch(batchOf([{ cmd: 'focus', args: { key: 'library/x/y' } }]), w.port));
      expect(w.refetches).toBe(0);
    });
  });

  describe('operator busy', () => {
    it('busy at arrival: waits, and applies once the operator is done', async () => {
      const w = model({ ...CONTEXT, busy: true });
      const run = applyBatch(batchOf([{ cmd: 'focus', args: { key: '@trace' } }]), w.port);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(w.dispatched).toEqual([]);
      expect(w.posts).toEqual([]);
      w.setBusy(false);
      expect(await settle(run)).toEqual([{ id: 'c-e1-1', status: 'applied', changed: true }]);
      expect(w.tabs().active).toBe('@trace');
    });

    it('busy past the deadline: operator_busy, posted before the deadline', async () => {
      const w = model({ ...CONTEXT, busy: true });
      const run = applyBatch(
        batchOf([{ cmd: 'focus', args: { key: '@trace' } }, { cmd: 'close_all' }]),
        w.port
      );
      await vi.advanceTimersByTimeAsync(10_000 - BUSY_MARGIN_MS);
      expect(await run).toEqual([
        { id: 'c-e1-1', status: 'rejected', reason: 'operator_busy' },
        { id: 'c-e1-2', status: 'skipped', after: 'c-e1-1' },
      ]);
      expect(Date.now()).toBeLessThan(NOW_MS + 10_000);
      expect(w.posts).toHaveLength(1);
      expect(w.dispatched).toEqual([]);
    });

    it('busy between commands: the next one waits', async () => {
      const w = model(CONTEXT);
      w.afterCommand = (index) => {
        if (index === 0) w.setBusy(true);
      };
      const run = applyBatch(
        batchOf([
          { cmd: 'focus', args: { key: '@trace' } },
          { cmd: 'focus', args: { key: 'library/xfer/TransferView' } },
        ]),
        w.port
      );
      await vi.advanceTimersByTimeAsync(1_000);
      expect(w.dispatched).toHaveLength(1);
      w.setBusy(false);
      const results = await settle(run);
      expect(results?.map((r) => r.status)).toEqual(['applied', 'applied']);
    });
  });

  describe('input guard', () => {
    it('is armed before the command is dispatched', async () => {
      const w = model(CONTEXT);
      const armedAtDispatch: boolean[] = [];
      const dispatch = w.port.dispatch;
      w.port.dispatch = (action) => {
        armedAtDispatch.push(w.guard.isArmed());
        dispatch(action);
      };
      await settle(applyBatch(batchOf([{ cmd: 'focus', args: { key: '@trace' } }]), w.port));
      expect(armedAtDispatch).toEqual([true]);
    });

    it('a change counts GUARD_MS from the next paint', async () => {
      const w = model(CONTEXT);
      await settle(applyBatch(batchOf([{ cmd: 'focus', args: { key: '@trace' } }]), w.port));
      expect(w.guard.isArmed()).toBe(true);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(w.guard.isArmed()).toBe(true);
      w.paint();
      await vi.advanceTimersByTimeAsync(GUARD_MS - 1);
      expect(w.guard.isArmed()).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      expect(w.guard.isArmed()).toBe(false);
    });

    it('a no-op drops the arm at once', async () => {
      const w = model(CONTEXT);
      await settle(
        applyBatch(
          batchOf([{ cmd: 'focus', args: { key: 'library/linac/LinacView?SR=1' } }]),
          w.port
        )
      );
      expect(w.guard.isArmed()).toBe(false);
    });

    it('focus of an evicted tab re-arms at its ready render with embeds settled', async () => {
      const w = model(CONTEXT);
      const evicted = 'library/sr/overview';
      w.setMounted(['library/linac/LinacView?SR=1', 'library/xfer/TransferView']);
      let ready!: () => void;
      w.readyOf.set(evicted, new Promise<void>((resolve) => (ready = resolve)));
      const dispatch = w.port.dispatch;
      w.port.dispatch = (action) => {
        dispatch(action);
        w.setMounted(['library/linac/LinacView?SR=1', 'library/xfer/TransferView', evicted]);
      };
      const results = await settle(
        applyBatch(batchOf([{ cmd: 'focus', args: { key: evicted } }]), w.port)
      );
      expect(results?.[0]).toMatchObject({ status: 'applied', changed: true });
      // Paints before the screen is ready start nothing.
      w.paint();
      await vi.advanceTimersByTimeAsync(GUARD_MS * 4);
      expect(w.guard.isArmed()).toBe(true);
      ready();
      await vi.advanceTimersByTimeAsync(0);
      w.paint();
      await vi.advanceTimersByTimeAsync(GUARD_MS - 1);
      expect(w.guard.isArmed()).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      expect(w.guard.isArmed()).toBe(false);
    });

    it('a screen that never settles starts the countdown at the ready cap', async () => {
      const w = model(CONTEXT);
      const evicted = 'library/sr/overview';
      w.readyOf.set(evicted, new Promise(() => {}));
      const dispatch = w.port.dispatch;
      w.port.dispatch = (action) => {
        dispatch(action);
        w.setMounted([evicted]);
      };
      await settle(applyBatch(batchOf([{ cmd: 'focus', args: { key: evicted } }]), w.port));
      await vi.advanceTimersByTimeAsync(10_000);
      w.paint();
      await vi.advanceTimersByTimeAsync(GUARD_MS);
      expect(w.guard.isArmed()).toBe(false);
    });
  });

  it('highlights what a changed command touched', async () => {
    const w = model(CONTEXT);
    await settle(
      applyBatch(
        batchOf([
          { cmd: 'open', args: { ref: 'library/s3-promo/promotion' } },
          {
            cmd: 'drop',
            args: {
              source: { tab: 'library/sr/overview' },
              target: { tile: 't3', edge: 'bottom' },
            },
          },
          { cmd: 'zoom', args: { key: 'library/xfer/TransferView', step: 'fit' } },
        ]),
        w.port
      )
    );
    expect(w.highlights).toEqual([
      [{ key: 'library/s3-promo/promotion', part: 'tab' }],
      [{ key: 'library/sr/overview', part: 'tab' }],
      [{ key: 'library/xfer/TransferView', part: 'zoom' }],
    ]);
  });

  it('open makes a tab of the focused tile, or the first tile of an empty dock', async () => {
    const w = model(CONTEXT);
    await settle(applyBatch(batchOf([{ cmd: 'open', args: { ref: 'drafts/beam-tune' } }]), w.port));
    expect(w.dispatched).toEqual([{ type: 'open', key: 'drafts/beam-tune', mode: 'append' }]);
    expect(findTile(w.tabs().layout, 't1')?.tabs).toContain('drafts/beam-tune');
    expect(w.tabs().active).toBe('drafts/beam-tune');

    const empty = model({
      ...CONTEXT,
      state: { ...CONTEXT.state, tabs: [], active: null, layout: null },
    });
    await settle(
      applyBatch(batchOf([{ cmd: 'open', args: { ref: 'drafts/beam-tune' } }]), empty.port)
    );
    expect(keysOf(empty.tabs().layout)).toEqual(['drafts/beam-tune']);
  });

  it('set_query loads into the instance (a remount), never setQuery', async () => {
    const w = model(CONTEXT);
    await settle(
      applyBatch(
        batchOf([{ cmd: 'set_query', args: { key: '@trace', query: 'pv=A&range=-4h' } }]),
        w.port
      )
    );
    expect(w.dispatched).toEqual([
      { type: 'load', key: '@trace', query: 'pv=A&range=-4h', view: null },
    ]);
  });

  it('destructive commands close through the close path as the agent', async () => {
    const w = model(CONTEXT);
    await settle(
      applyBatch(
        batchOf([{ cmd: 'close_others', args: { key: 'library/linac/LinacView?SR=1' } }]),
        w.port
      )
    );
    // Within the tab's tile: t1 holds LinacView and overview; the other tiles are kept.
    expect(w.closes).toEqual([{ keys: ['library/sr/overview'], closedBy: 'agent', id: 'g-2' }]);
    expect(w.undoOffers).toEqual(['g-2']);
    expect(w.tabs().closedStack?.at(-1)).toMatchObject({ id: 'g-2', kind: 'tabs' });
  });

  it('open_collection waits for Open all to commit before the next command', async () => {
    const w = model(CONTEXT);
    const openAll = w.port.openAll;
    const order: string[] = [];
    w.port.openAll = (ref, options) =>
      new Promise((resolve) => {
        setTimeout(() => {
          order.push('opened');
          resolve(openAll(ref, options));
        }, 500);
      });
    const dispatch = w.port.dispatch;
    w.port.dispatch = (action) => {
      if (action.type === 'focus') order.push('focus');
      dispatch(action);
    };
    const results = await settle(
      applyBatch(
        batchOf([
          { cmd: 'open_collection', args: { ref: 'facility:injector' } },
          { cmd: 'focus', args: { key: 'library/sr/overview' } },
        ]),
        w.port
      ),
      1_000
    );
    expect(order).toEqual(['opened', 'focus']);
    expect(results?.[0]).toMatchObject({
      status: 'applied',
      keys: ['library/linac/LinacView', 'library/xfer/TransferView', '@trace/2'],
    });
  });

  it('applies delivered batches one at a time, in order', async () => {
    const w = model(CONTEXT);
    w.port.settled = () => new Promise((resolve) => setTimeout(resolve, 100));
    const apply = createBatchApplier(() => w.port);
    const one = apply(batchOf([{ cmd: 'focus', args: { key: '@trace' } }], { batch: 'b-e1-1' }));
    const two = apply(
      batchOf([{ cmd: 'focus', args: { key: 'library/xfer/TransferView' } }], { batch: 'b-e1-2' })
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.all([one, two]);
    expect(w.posts.map((p) => p.batch)).toEqual(['b-e1-1', 'b-e1-2']);
    expect(w.tabs().active).toBe('library/xfer/TransferView');
  });
});

describe('workspaceApply agent ops', () => {
  const LINAC = 'library/linac/LinacView?SR=1';

  it('a new tool dropped with a query opens at its smallest free instance, then loads it', async () => {
    const w = model(CONTEXT);
    const results = await settle(
      applyBatch(
        batchOf([
          {
            cmd: 'drop',
            args: {
              source: { new: { tool: 'trace', query: 'pv=A&range=-4h' } },
              target: { tile: 't2', edge: 'right' },
            },
          },
        ]),
        w.port
      )
    );
    expect(results).toEqual([{ id: 'c-e1-1', status: 'applied', changed: true, key: '@trace/2' }]);
    expect(w.dispatched).toEqual([
      { type: 'drop', source: { new: '@trace/2' }, target: { tile: 't2', edge: 'right' } },
      { type: 'load', key: '@trace/2', query: 'pv=A&range=-4h', view: null },
    ]);
    expect(w.tabs().instances['@trace/2']?.query).toBe('pv=A&range=-4h');
    expect(tileOf(w.tabs().layout, '@trace/2')?.tile).not.toBe('t2');
  });

  it('a new member that is already open drops as that tab', async () => {
    const w = model(CONTEXT);
    const results = await settle(
      applyBatch(
        batchOf([
          {
            cmd: 'drop',
            args: {
              source: { new: { ref: 'library/xfer/TransferView' } },
              target: { tile: 't1', zone: 'centre' },
            },
          },
        ]),
        w.port
      )
    );
    expect(results?.[0]).toMatchObject({ changed: true, key: 'library/xfer/TransferView' });
    expect(w.dispatched[0]).toMatchObject({ source: { tab: 'library/xfer/TransferView' } });
    expect(findTile(w.tabs().layout, 't1')?.tabs).toContain('library/xfer/TransferView');
  });

  it("an agent's drop gives the layout a person's drop of the same case gives", async () => {
    const w = model(CONTEXT);
    const drop: TabsAction = {
      type: 'drop',
      source: { tile: 't3' },
      target: { outer: 'bottom' },
    };
    const person = tabsReducer(w.tabs(), drop);
    await settle(
      applyBatch(
        batchOf([{ cmd: 'drop', args: { source: { tile: 't3' }, target: { outer: 'bottom' } } }]),
        w.port
      )
    );
    expect(w.tabs().layout).toEqual(person.layout);
  });

  it('refuses a drop and a side-by-side set with no_dock in one-tile mode', async () => {
    for (const command of [
      { cmd: 'drop', args: { source: { tab: '@trace' }, target: { outer: 'right' } } },
      { cmd: 'open_set', args: { members: [{ ref: 'drafts/beam-tune' }], as: 'side' } },
    ]) {
      const w = model(CONTEXT);
      const inner = w.port.tabs;
      w.port.tabs = () => ({ ...inner(), oneTile: true });
      const results = await settle(applyBatch(batchOf([command, { cmd: 'close_all' }]), w.port));
      expect(results).toEqual([
        { id: 'c-e1-1', status: 'rejected', reason: 'no_dock' },
        { id: 'c-e1-2', status: 'skipped', after: 'c-e1-1' },
      ]);
      expect(w.dispatched).toEqual([]);
    }
  });

  it("rejects with the holder's refusal when Open all refuses, and stops the batch", async () => {
    const w = model(CONTEXT);
    w.port.openAll = async () => ({
      keys: [],
      changed: false,
      group: null,
      refusal: 'too_many_for_side',
    });
    const results = await settle(
      applyBatch(
        batchOf([
          { cmd: 'open_set', args: { members: [{ ref: 'drafts/beam-tune' }], as: 'side' } },
          { cmd: 'focus', args: { key: '@trace' } },
        ]),
        w.port
      )
    );
    expect(results).toEqual([
      { id: 'c-e1-1', status: 'rejected', reason: 'too_many_for_side' },
      { id: 'c-e1-2', status: 'skipped', after: 'c-e1-1' },
    ]);
    expect(w.guard.isArmed()).toBe(false);
    expect(w.highlights).toEqual([]);
  });

  it('a refusal in words is reported invalid_args; a named one as itself', () => {
    expect(refusalReason('no_layout')).toBe('no_layout');
    expect(refusalReason('a tab is placed twice')).toBe('invalid_args');
  });

  it('open_collection with as layout on a collection without one is refused no_layout', async () => {
    const w = model(CONTEXT);
    const results = await settle(
      applyBatch(
        batchOf([{ cmd: 'open_collection', args: { ref: 'facility:injector', as: 'layout' } }]),
        w.port
      )
    );
    expect(results).toEqual([{ id: 'c-e1-1', status: 'rejected', reason: 'no_layout' }]);
  });

  it('open_set in a layout is one layout group: reopen brings the dock back', async () => {
    const w = model(CONTEXT);
    const before = w.tabs().layout;
    const results = await settle(
      applyBatch(
        batchOf([
          {
            cmd: 'open_set',
            args: {
              members: [{ ref: 'library/s3-promo/promotion' }, { tool: 'correlation' }],
              as: 'layout',
              layout: { split: 'column', items: [{ tabs: [0] }, { tabs: [1] }] },
            },
          },
          { cmd: 'reopen', args: { id: 'g-2' } },
        ]),
        w.port
      )
    );
    expect(results?.[0]).toMatchObject({
      changed: true,
      keys: ['library/s3-promo/promotion', '@correlation'],
      group: 'g-2',
    });
    expect(results?.[1]).toMatchObject({ status: 'applied', changed: true });
    expect(w.tabs().layout).toEqual(before);
  });

  it('close_all closes the dock as one layout group', async () => {
    const w = model(CONTEXT);
    const before = w.tabs().layout;
    await settle(applyBatch(batchOf([{ cmd: 'close_all' }]), w.port));
    expect(w.tabs().layout).toBeNull();
    expect(w.tabs().closedStack?.at(-1)).toMatchObject({ id: 'g-2', kind: 'layout' });
    await settle(applyBatch(batchOf([{ cmd: 'reopen' }]), w.port));
    expect(w.tabs().layout).toEqual(before);
  });

  it("close_right acts within the tab's tile", async () => {
    const w = model(CONTEXT);
    await settle(applyBatch(batchOf([{ cmd: 'close_right', args: { key: LINAC } }]), w.port));
    expect(w.closes).toEqual([{ keys: ['library/sr/overview'], closedBy: 'agent', id: 'g-2' }]);
    expect(w.tabs().keys).toContain('@trace');
  });

  it('close_tile closes the tile as one entry, and reopen puts it back', async () => {
    const w = model(CONTEXT);
    const before = w.tabs().layout;
    const results = await settle(
      applyBatch(batchOf([{ cmd: 'close_tile', args: { tile: 't3' } }, { cmd: 'reopen' }]), w.port)
    );
    expect(results).toEqual([
      { id: 'c-e1-1', status: 'applied', changed: true, group: 'g-2' },
      { id: 'c-e1-2', status: 'applied', changed: true, keys: ['@trace'] },
    ]);
    expect(keysOf(w.tabs().layout).sort()).toEqual(keysOf(before).sort());
  });
});

describe('workspaceApply screen readiness', () => {
  it('settles whether the ready signal came before or after the wait', async () => {
    const readiness = new ScreenReadiness();
    readiness.ready('a/early');
    let early = false;
    void readiness.whenReady('a/early').then(() => (early = true));
    let late = false;
    void readiness.whenReady('a/late').then(() => (late = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(early).toBe(true);
    expect(late).toBe(false);
    readiness.ready('a/late');
    await vi.advanceTimersByTimeAsync(0);
    expect(late).toBe(true);
  });

  it('an unmount forgets: a remount waits for its own ready render', async () => {
    const readiness = new ScreenReadiness();
    readiness.ready('a/b');
    readiness.forget('a/b');
    let ready = false;
    void readiness.whenReady('a/b').then(() => (ready = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(ready).toBe(false);
    readiness.ready('a/b');
    await vi.advanceTimersByTimeAsync(0);
    expect(ready).toBe(true);
  });
});

describe('workspaceApply attribution', () => {
  function dom(): HTMLElement {
    const root = document.createElement('div');
    root.innerHTML = `
      <div class="tab-strip"><button data-tab-key="a/b">a</button><button data-tab-key="c/d">c</button></div>
      <div class="workspace__screen" data-tab-key="a/b"></div>
      <div class="canopy-tile-bar" data-panel-key="a/b"><div class="screen-header__zoom"></div></div>`;
    return root;
  }

  it("marks a tab's strip tab and tile bar for HIGHLIGHT_MS, never the screen itself", async () => {
    const root = dom();
    const marked = highlightTouched(root, [{ key: 'a/b', part: 'tab' }]);
    expect(marked.map((el) => el.className || el.tagName)).toEqual(['BUTTON', 'canopy-tile-bar']);
    expect(root.querySelector('.workspace__screen')!.hasAttribute(TOUCHED_ATTR)).toBe(false);
    await vi.advanceTimersByTimeAsync(HIGHLIGHT_MS - 1);
    expect(marked.every((el) => el.hasAttribute(TOUCHED_ATTR))).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(marked.some((el) => el.hasAttribute(TOUCHED_ATTR))).toBe(false);
  });

  it("marks a tab's own tab in a tile bar", () => {
    const root = document.createElement('div');
    root.innerHTML = `
      <div class="canopy-tile-bar" data-panel-key="a/b">
        <div class="canopy-tile-bar__tab" data-tab-key="a/b"></div>
        <div class="canopy-tile-bar__tab" data-tab-key="c/d"></div>
      </div>`;
    const marked = highlightTouched(root, [{ key: 'c/d', part: 'tab' }]);
    expect(marked).toEqual([root.querySelector('[data-tab-key="c/d"]')]);
  });

  it("marks only a zoom's control", () => {
    const root = dom();
    const marked = highlightTouched(root, [{ key: 'a/b', part: 'zoom' }]);
    expect(marked).toEqual([root.querySelector('.screen-header__zoom')]);
  });

  it('a second highlight restarts the time', async () => {
    const root = dom();
    const [tab] = highlightTouched(root, [{ key: 'c/d', part: 'tab' }]);
    await vi.advanceTimersByTimeAsync(1_000);
    highlightTouched(root, [{ key: 'c/d', part: 'tab' }]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(tab!.hasAttribute(TOUCHED_ATTR)).toBe(true);
    await vi.advanceTimersByTimeAsync(HIGHLIGHT_MS);
    expect(tab!.hasAttribute(TOUCHED_ATTR)).toBe(false);
  });
});
