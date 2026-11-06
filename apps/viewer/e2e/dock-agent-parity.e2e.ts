// The agent's path through the dock gives the person's result (the agent
// drives the same dock, with the same drop rules and layout schema). For every
// drop type (centre, tab bar, edge, border, outer) and every source (a tab, a
// tile, a new item), and for close tab, close tile, the group closes (close
// all, close others, close to the right) and reopen, one page plays the person
// (a real drag, a click on a ×, a menu item, Ctrl/Cmd+Shift+T) and a fresh page
// from the same seeded start plays the agent (one `set_workspace` batch); the
// two layouts must agree in shape and sizes, and the agent's `get_workspace`
// must read back exactly the window's own layout. Then: a layout-less set of
// three opens as tabs, side by side and in a given layout, one call each; two
// tabs in one tile read back; a collection with tabs per tile opens as saved;
// a tile command without `base` is refused whole.
//
// The spec runs on one of two hubs, chosen by the environment:
//
//   stand-in  (no CANOPY_SRC)  e2e/server.mjs's workspace hub (workspaceHub.mjs),
//                              the agent's calls through its __workspace-enqueue
//                              and __workspace routes, one hub per test (the
//                              collections fixture's e2e user), the viewer under
//                              /x/y, screens from the e2e drafts.
//   live      (CANOPY_SRC set) a real canopy_mcp from that checkout
//                              (liveCanopy.ts, CANOPY_WORKSPACE=1), the agent's
//                              calls as MCP tool calls (mcpCall.ts), the viewer
//                              at the root mount, screens from canopy's fixture
//                              library. One canopy_mcp is one operator, so the
//                              tests run serially on one instance.
//
// With REQUIRE_CANOPY_LIVE=1 the live hub is required: a missing or incomplete
// checkout fails every test, so a gate that requires the live run cannot pass
// by falling back to the stand-in or by skipping.

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { expect, test as collectionsTest } from './collectionsFixture';
import {
  centrePoint,
  closeTileTab,
  dockRoot,
  dragTo,
  dropPreview,
  edgePoint,
  layoutShape,
  settled,
  tileRect,
  tilesOf,
  unreachable,
  type DragFrom,
  type Layout,
  type LayoutTile,
  type Preview,
  type Rect,
} from './dockHelpers';
import { missingCanopy, startLiveCanopy, type LiveCanopy } from './liveCanopy';
import { McpClient } from './mcpCall';

const HERE = dirname(fileURLToPath(import.meta.url));
const COLLECTION_FIXTURES = join(HERE, 'fixtures', 'collections');
/** A collection with tabs per tile (a byte copy of canopy's own fixture). */
const TABBED_FILE = join(COLLECTION_FIXTURES, 'valid', 'personal', 'tabbed.json');

const CANOPY_SRC = process.env.CANOPY_SRC;
const REQUIRE_CANOPY_LIVE = process.env.REQUIRE_CANOPY_LIVE === '1';
const LIVE = CANOPY_SRC !== undefined || REQUIRE_CANOPY_LIVE;
const MISSING = LIVE ? missingCanopy(CANOPY_SRC) : null;

/** The viewer's mount under each hub (storageScope.ts and dock/storage.ts scope keys to it). */
const MOUNT = LIVE ? '' : '/x/y';
const TABS_KEY = `canopy-viewer:tabs:${MOUNT || '/'}`;
const DOCK_KEY = `canopy-workspace-dock:${MOUNT || '/'}`;

/** Four screens and a fifth: the stand-in's drafts, or canopy's fixture library. */
const [A, B, C, D, E] = LIVE
  ? [
      'library/linac/LinacView',
      'library/xfer/TransferView',
      'library/sr/overview',
      'library/s3-promo/promotion',
      'library/common/KnobPanel',
    ]
  : [
      'drafts/e2e-panel',
      'drafts/label-fit',
      'drafts/wide-panel',
      'drafts/plot-panel',
      'drafts/write-button',
    ];

// --- The agent's two tools ----------------------------------------------------

interface WorkspaceDoc {
  protocol: number;
  epoch: string;
  activeWindow: string | null;
  connected: boolean;
  shown: boolean;
  seq: number;
  state: {
    tabs: { key: string }[];
    active: string | null;
    layout: Layout | null;
  } | null;
}

interface CommandResult {
  id: string;
  status: string;
  changed?: boolean;
  reason?: string;
  key?: string;
  keys?: string[];
  group?: string;
}

interface SetResult extends WorkspaceDoc {
  batch: { id: string | null; status: string; reason?: string; results: CommandResult[] };
}

type Command = { cmd: string; args?: Record<string, unknown> };
type Base = { window: string | null; seq: number };

/** One hub as the agent sees it: get_workspace and set_workspace. */
interface Agent {
  ws(): Promise<WorkspaceDoc>;
  send(commands: Command[], base?: Base): Promise<SetResult>;
}

const wire = (commands: Command[]) => commands.map((c) => ({ cmd: c.cmd, args: c.args ?? {} }));

/** The stand-in hub of this test's e2e user, through server.mjs's agent routes. */
function standInAgent(api: APIRequestContext): Agent {
  return {
    async ws() {
      const response = await api.get(`${MOUNT}/__workspace`);
      expect(response.ok(), `GET __workspace: ${response.status()}`).toBe(true);
      return (await response.json()) as WorkspaceDoc;
    },
    async send(commands, base) {
      // The agent waits for its batch by asking again with the batch id (and
      // the same call: commands and base), as set_workspace's wait does.
      const call = { commands: wire(commands), ...(base ? { base } : {}) };
      const post = async (body: object): Promise<SetResult> => {
        const response = await api.post(`${MOUNT}/__workspace-enqueue`, { data: body });
        expect(response.ok(), `POST __workspace-enqueue: ${response.status()}`).toBe(true);
        return (await response.json()) as SetResult;
      };
      let answer = await post(call);
      const until = Date.now() + 10_000;
      while (answer.batch.status === 'pending' && answer.batch.id !== null && Date.now() < until) {
        await new Promise((wake) => setTimeout(wake, 50));
        answer = await post({ ...call, batch_id: answer.batch.id });
      }
      return answer;
    },
  };
}

/** The live canopy_mcp, through its MCP tools. */
function liveAgent(mcp: McpClient): Agent {
  return {
    ws: () => mcp.call<WorkspaceDoc>('get_workspace'),
    send: (commands, base) =>
      mcp.call<SetResult>('set_workspace', {
        commands: wire(commands),
        ...(base ? { base } : {}),
      }),
  };
}

let live: LiveCanopy | undefined;
let mcp: McpClient | undefined;

const test = collectionsTest.extend<{ agent: Agent; site: string }>({
  site: async ({ baseURL }, provide) => {
    await provide(LIVE ? live!.origin : `${baseURL}${MOUNT}`);
  },
  agent: async ({ collectionsApi }, provide) => {
    if (LIVE) {
      await provide(liveAgent(mcp!));
      return;
    }
    const reset = await collectionsApi.post(`${MOUNT}/__workspace-reset?mode=on`);
    expect(reset.ok(), `workspace reset: ${reset.status()}`).toBe(true);
    await provide(standInAgent(collectionsApi));
  },
});

// --- Windows -------------------------------------------------------------------

/** The version 1 stored dock (dock/storage.ts StoredDock) for `layout`. */
function storedDock(layout: Layout | null): object {
  const keys = tilesOf(layout).flatMap((t) => t.tabs);
  return {
    version: 1,
    layout,
    panels: Object.fromEntries(
      keys.map((k) => [k, { kind: k.startsWith('@') ? 'tool' : 'screen' }])
    ),
  };
}

/** A start: the open tabs, the focused one, and the stored layout. */
interface Start {
  keys: string[];
  active: string;
  layout: Layout | null;
}

/** Seeds `start` before the app runs: top window only, once per page. */
async function seed(page: Page, start: Start): Promise<void> {
  await page.addInitScript(
    ([tabsKey, tabsValue, dockKey, dockValue]) => {
      if (window !== window.top || sessionStorage.getItem(tabsKey) !== null) return;
      sessionStorage.setItem(tabsKey, tabsValue);
      localStorage.setItem(dockKey, dockValue);
    },
    [
      TABS_KEY,
      JSON.stringify({ keys: start.keys, active: start.active }),
      DOCK_KEY,
      JSON.stringify(storedDock(start.layout)),
    ] as const
  );
}

/** The window's own layout: its dock root's `data-layout`. */
async function layoutOf(page: Page): Promise<Layout | null> {
  const raw = await dockRoot(page).getAttribute('data-layout');
  if (raw === null) throw new Error('the dock root has no data-layout');
  return JSON.parse(raw) as Layout | null;
}

/** Opens a page on `start` and waits until its dock shows the start's tiles. */
async function openOn(page: Page, site: string, start: Start): Promise<void> {
  await page.setViewportSize({ width: 1400, height: 900 });
  await seed(page, start);
  await page.goto(`${site}/embed/${start.active}`);
  await expect(dockRoot(page)).toBeVisible();
  await expect.poll(async () => layoutShape(await layoutOf(page))).toBe(layoutShape(start.layout));
  await settledRects(page);
}

/** Every tile's rect, keyed by tile id, once they hold still. */
async function settledRects(page: Page): Promise<Record<string, Rect>> {
  return settled(page, async () => {
    const out: Record<string, Rect> = {};
    for (const t of tilesOf(await layoutOf(page))) {
      const r = await tileRect(page, t.tile);
      if (r) out[t.tile] = r;
    }
    return out;
  });
}

/** The rect of the tile showing `key`. */
async function rectOf(page: Page, key: string): Promise<Rect> {
  const layout = await layoutOf(page);
  const tile = tilesOf(layout).find((t) => t.tabs.includes(key));
  if (!tile) throw new Error(`no tile holds ${key} in ${JSON.stringify(layout)}`);
  return (await settledRects(page))[tile.tile]!;
}

/** The id of the tile holding `key` in `layout`. */
function tileIdOf(layout: Layout | null | undefined, key: string): string {
  const tile = tilesOf(layout ?? null).find((t) => t.tabs.includes(key));
  if (!tile) throw new Error(`no tile holds ${key} in ${JSON.stringify(layout)}`);
  return tile.tile;
}

/**
 * Polls get_workspace until `pred` holds; resolves with that document.
 */
async function waitWs(
  agent: Agent,
  pred: (doc: WorkspaceDoc) => boolean,
  message: string,
  timeout = 10_000
): Promise<WorkspaceDoc> {
  let last: WorkspaceDoc | null = null;
  await expect
    .poll(
      async () => {
        last = await agent.ws();
        return pred(last);
      },
      { message, timeout, intervals: [50] }
    )
    .toBe(true);
  return last!;
}

/**
 * Opens a page on `start` as the agent's window: a gesture claims the slot, and
 * the hub then reports this window, connected and shown, with the start's tabs.
 */
async function openAgentWindow(
  page: Page,
  site: string,
  agent: Agent,
  start: Start
): Promise<WorkspaceDoc> {
  const before = (await agent.ws()).activeWindow;
  await openOn(page, site, start);
  await page.getByRole('searchbox', { name: 'Search screens' }).click();
  const doc = await waitWs(
    agent,
    (d) =>
      d.activeWindow !== null &&
      d.activeWindow !== before &&
      d.connected &&
      d.shown &&
      layoutShape(d.state?.layout ?? null) === layoutShape(start.layout),
    'the agent window holds the slot and reports its start'
  );
  return doc;
}

const baseOf = (doc: WorkspaceDoc): Base => ({ window: doc.activeWindow, seq: doc.seq });

/**
 * Sends `commands` in one batch and expects it `done` with every command
 * applied and changed; then waits until get_workspace reports the window's
 * own layout, and returns that layout.
 */
async function agentApplies(
  page: Page,
  agent: Agent,
  commands: Command[],
  base?: Base
): Promise<{ layout: Layout | null; results: CommandResult[] }> {
  const { batch } = await agent.send(commands, base);
  expect(batch, JSON.stringify(batch)).toMatchObject({ status: 'done' });
  expect(
    batch.results.map((r) => [r.status, r.changed]),
    JSON.stringify(batch.results)
  ).toEqual(commands.map(() => ['applied', true]));
  const layout = await readBack(page, agent);
  return { layout, results: batch.results };
}

/**
 * The window's layout once it holds still and get_workspace reports exactly
 * it (tile ids, tabs, showing and sizes): the agent reads back what the window
 * shows.
 */
async function readBack(page: Page, agent: Agent): Promise<Layout | null> {
  await expect(page.locator('.canopy-dock-overlay')).not.toHaveAttribute('data-dragging', 'true');
  await settledRects(page);
  let window: Layout | null = null;
  let reported: Layout | null = null;
  await expect
    .poll(
      async () => {
        window = await layoutOf(page);
        reported = (await agent.ws()).state?.layout ?? null;
        return JSON.stringify(reported) === JSON.stringify(window);
      },
      { message: 'get_workspace reports the window layout', timeout: 10_000, intervals: [50] }
    )
    .toBe(true);
  expect(reported).toEqual(window);
  return window;
}

/** `layout` with tile ids dropped and sizes rounded: shape and sizes, comparable across pages. */
function sized(layout: Layout | null): unknown {
  if (layout === null) return null;
  const size = layout.size === undefined ? {} : { size: Math.round(layout.size * 50) / 50 };
  if ('tile' in layout) return { tabs: layout.tabs, showing: layout.showing, ...size };
  return { split: layout.split, items: layout.items.map(sized), ...size };
}

/** The person's and the agent's layouts agree: same shape, sizes within 0.02. */
function expectSame(agentLayout: Layout | null, personLayout: Layout | null, what: string): void {
  expect(layoutShape(agentLayout), `${what}: shape`).toBe(layoutShape(personLayout));
  const sizes = (l: Layout | null): number[] => {
    if (l === null) return [];
    const own = l.size === undefined ? [] : [l.size];
    return 'tile' in l ? own : [...own, ...l.items.flatMap(sizes)];
  };
  const a = sizes(agentLayout);
  const p = sizes(personLayout);
  expect(a.length, `${what}: sized items ${JSON.stringify(a)} vs ${JSON.stringify(p)}`).toBe(
    p.length
  );
  for (const [i, size] of a.entries()) {
    expect(
      Math.abs(size - p[i]!),
      `${what}: size ${i} ${JSON.stringify(sized(agentLayout))} vs ${JSON.stringify(sized(personLayout))}`
    ).toBeLessThanOrEqual(0.02);
  }
}

/** The person's result once the gesture has landed as `shape`. */
async function personLands(page: Page, shape: string): Promise<Layout | null> {
  await expect.poll(async () => layoutShape(await layoutOf(page))).toBe(shape);
  await expect(page.locator('.canopy-dock-overlay')).not.toHaveAttribute('data-dragging', 'true');
  await settledRects(page);
  return layoutOf(page);
}

/** Runs `person` in a page of its own on `start`; resolves with its result, the page closed. */
async function asPerson<T>(
  page: Page,
  site: string,
  start: Start,
  person: (p: Page) => Promise<T>
): Promise<T> {
  const p = await page.context().newPage();
  try {
    await openOn(p, site, start);
    return await person(p);
  } finally {
    await p.close();
  }
}

/** Makes the screen tree's row for `key` visible, opening its branches. */
async function revealInTree(page: Page, key: string): Promise<void> {
  const row = page.locator(`.screen-tree [data-screen-key="${key}"] > .nav-tree__row`);
  for (let i = 0; i < 4 && !(await row.isVisible()); i += 1) {
    const closed = page.locator('.screen-tree [aria-expanded="false"]');
    const n = await closed.count();
    let opened = false;
    for (let j = 0; j < n; j += 1) {
      const branch = closed.nth(j);
      const text = ((await branch.textContent()) ?? '').trim().toLowerCase();
      const segments = key.toLowerCase().split('/');
      if (segments.some((s) => s.length > 0 && text.startsWith(s))) {
        await branch.click();
        opened = true;
        break;
      }
    }
    if (!opened) break;
  }
  await expect(row, `the screen tree row of ${key}`).toBeVisible();
}

/** The bar of tile `tile` and a point in its empty part, right of its last tab. */
async function barEnd(page: Page, tile: string): Promise<{ x: number; y: number }> {
  const bar = await page.locator(`[data-testid="tile-bar"][data-tile="${tile}"]`).boundingBox();
  const tabs = page.locator(`[data-testid="tile-bar"][data-tile="${tile}"] .canopy-tile-bar__tab`);
  const last = await tabs.last().boundingBox();
  expect(bar).not.toBeNull();
  const x = last ? Math.min(last.x + last.width + 20, bar!.x + bar!.width - 4) : bar!.x + 30;
  return { x, y: bar!.y + bar!.height / 2 };
}

/** Reopens the most recent closed group, as a person does. */
const reopenKey = (page: Page) => page.keyboard.press('ControlOrMeta+Shift+T');

/** The strip tab of `key` (one tile: the strip is that tile's bar). */
const stripTab = (page: Page, key: string): Locator =>
  page.locator(`.tab-strip [role="tab"][data-tab-key="${key}"]`);

// --- Starts --------------------------------------------------------------------

/** The four-task start: A | B | C at 50/30/20, A focused, D closed. */
const ABC: Start = {
  keys: [A, B, C],
  active: A,
  layout: {
    split: 'row',
    items: [
      { tile: 't1', tabs: [A], showing: A, size: 0.5 },
      { tile: 't2', tabs: [B], showing: B, size: 0.3 },
      { tile: 't3', tabs: [C], showing: C, size: 0.2 },
    ],
  },
};

/** One tile holding A alone. */
const SOLO: Start = { keys: [A], active: A, layout: { tile: 't1', tabs: [A], showing: A } };

// --- The spec ------------------------------------------------------------------

test.describe('the agent path gives the person path', () => {
  test.describe.configure(LIVE ? { mode: 'serial', timeout: 90_000 } : { timeout: 45_000 });

  test.beforeAll(async () => {
    if (!LIVE || MISSING !== null) return;
    test.setTimeout(120_000);
    live = await startLiveCanopy(CANOPY_SRC!, { env: { CANOPY_WORKSPACE: '1' } });
    mcp = new McpClient(live.origin);
    await mcp.connect();
  });

  test.afterAll(async () => {
    await live?.stop();
    live = undefined;
  });

  test.beforeEach(() => {
    if (MISSING === null) return;
    if (REQUIRE_CANOPY_LIVE) throw new Error(`REQUIRE_CANOPY_LIVE=1 but ${MISSING}`);
    test.skip(true, MISSING);
  });

  // --- every drop type for every source ---------------------------------------

  /** A source of the four-task start: the person's drag and the agent's `source`. */
  const SOURCES: {
    name: string;
    person: DragFrom;
    agent: (layout: Layout | null) => Record<string, unknown>;
    item: string;
    rest: string[];
  }[] = [
    {
      name: 'a tab',
      person: { from: 'tab', key: C },
      agent: () => ({ tab: C }),
      item: C,
      rest: [B],
    },
    {
      name: 'a tile',
      person: { from: 'grip', tile: 't3' },
      agent: (layout) => ({ tile: tileIdOf(layout, C) }),
      item: C,
      rest: [B],
    },
    {
      name: 'a new item',
      person: { from: 'tree', key: D },
      agent: () => ({ new: { ref: D } }),
      item: D,
      rest: [B, C],
    },
  ];

  /**
   * A drop type on A's tile: the person's point and the agent's `target`. Border and outer
   * targets have no pointer zone, so they are the agent's alone (covered below).
   */
  const TYPES: {
    name: string;
    kind: Preview['kind'];
    at: (page: Page) => Promise<{ x: number; y: number }>;
    agent: (layout: Layout | null) => Record<string, unknown>;
    shape: (item: string, rest: string[]) => string;
  }[] = [
    {
      name: 'centre',
      kind: 'tab',
      at: async (page) => centrePoint(await rectOf(page, A)),
      agent: (layout) => ({ tile: tileIdOf(layout, A), zone: 'centre' }),
      shape: (item, rest) => `row[${A}|${item}*,${rest.join(',')}]`,
    },
    {
      name: 'tab bar',
      kind: 'tab',
      at: (page) => barEnd(page, 't1'),
      agent: (layout) => ({ tile: tileIdOf(layout, A), zone: 'tab', index: 1 }),
      shape: (item, rest) => `row[${A}|${item}*,${rest.join(',')}]`,
    },
    {
      name: 'edge',
      kind: 'split',
      at: async (page) => edgePoint(await rectOf(page, A), 'bottom', 64),
      agent: (layout) => ({ tile: tileIdOf(layout, A), edge: 'bottom' }),
      shape: (item, rest) => `row[column[${A},${item}],${rest.join(',')}]`,
    },
  ];

  for (const source of SOURCES) {
    for (const type of TYPES) {
      test(`drop: ${source.name} on ${type.name}`, async ({ page, site, agent }) => {
        const shape = type.shape(source.item, source.rest);
        const person = await asPerson(page, site, ABC, async (p) => {
          if (source.person.from === 'tree') await revealInTree(p, source.person.key);
          await dragTo(p, source.person, await type.at(p), type.kind);
          const landed = await personLands(p, shape);
          expect(await dropPreview(p), 'no highlight left behind').toBeNull();
          return landed;
        });

        const doc = await openAgentWindow(page, site, agent, ABC);
        const layout = doc.state!.layout;
        const drop = { source: source.agent(layout), target: type.agent(layout) };
        const { layout: after, results } = await agentApplies(
          page,
          agent,
          [{ cmd: 'drop', args: drop }],
          baseOf(doc)
        );
        if (source.person.from === 'tree') expect(results[0]!.key).toBe(D);
        expect(layoutShape(after)).toBe(shape);
        expectSame(after, person, `${source.name} on ${type.name}`);
      });
    }
  }

  // --- close and reopen --------------------------------------------------------

  test('close tab: closes from its tile and reopens into it', async ({ page, site, agent }) => {
    const start: Start = {
      keys: [A, D, B],
      active: D,
      layout: {
        split: 'row',
        items: [
          { tile: 't1', tabs: [A, D], showing: D, size: 0.6 },
          { tile: 't2', tabs: [B], showing: B, size: 0.4 },
        ],
      },
    };
    const person = await asPerson(page, site, start, async (p) => {
      await closeTileTab(p, D);
      const closed = await personLands(p, `row[${A},${B}]`);
      await reopenKey(p);
      const reopened = await personLands(p, `row[${A}|${D}*,${B}]`);
      return { closed, reopened };
    });

    await openAgentWindow(page, site, agent, start);
    const closed = await agentApplies(page, agent, [{ cmd: 'close_tab', args: { key: D } }]);
    expect(typeof closed.results[0]!.group).toBe('string');
    expectSame(closed.layout, person.closed, 'close_tab');
    const reopened = await agentApplies(page, agent, [{ cmd: 'reopen' }]);
    expectSame(reopened.layout, person.reopened, 'reopen after close_tab');
  });

  test('close tile: closes and reopens where it was, at its size', async ({
    page,
    site,
    agent,
  }) => {
    const person = await asPerson(page, site, ABC, async (p) => {
      await closeTileTab(p, B);
      const closed = await personLands(p, `row[${A},${C}]`);
      await reopenKey(p);
      const reopened = await personLands(p, `row[${A},${B},${C}]`);
      return { closed, reopened };
    });

    const doc = await openAgentWindow(page, site, agent, ABC);
    const closed = await agentApplies(
      page,
      agent,
      [{ cmd: 'close_tile', args: { tile: tileIdOf(doc.state!.layout, B) } }],
      baseOf(doc)
    );
    expectSame(closed.layout, person.closed, 'close_tile');
    const reopened = await agentApplies(page, agent, [{ cmd: 'reopen' }]);
    expectSame(reopened.layout, person.reopened, 'reopen after close_tile');
    expectSame(reopened.layout, ABC.layout, 'reopen restores the start');
  });

  test('close all: the group closes and reopens as one', async ({ page, site, agent }) => {
    const person = await asPerson(page, site, ABC, async (p) => {
      await p.getByRole('button', { name: 'Window menu' }).click();
      const closeAll = p.getByRole('menuitem', { name: 'Close all' });
      expect(await unreachable(closeAll), 'Close all').toBe('');
      await closeAll.click();
      await expect.poll(async () => tilesOf(await layoutOf(p)).length).toBe(0);
      const closed = await layoutOf(p);
      await reopenKey(p);
      const reopened = await personLands(p, `row[${A},${B},${C}]`);
      return { closed, reopened };
    });

    await openAgentWindow(page, site, agent, ABC);
    const closed = await agentApplies(page, agent, [{ cmd: 'close_all' }]);
    expect(typeof closed.results[0]!.group).toBe('string');
    expectSame(closed.layout, person.closed, 'close_all');
    const reopened = await agentApplies(page, agent, [{ cmd: 'reopen' }]);
    expectSame(reopened.layout, person.reopened, 'reopen after close_all');
  });

  /** One tile holding A, B and C, B showing: the strip is its bar. */
  const THREE_TABS: Start = {
    keys: [A, B, C],
    active: B,
    layout: { tile: 't1', tabs: [A, B, C], showing: B },
  };

  for (const group of [
    { cmd: 'close_others', item: 'Close others', key: B, shape: B },
    { cmd: 'close_right', item: 'Close to the right', key: A, shape: A },
  ]) {
    test(`${group.cmd}: the group closes within the tile and reopens as one`, async ({
      page,
      site,
      agent,
    }) => {
      const person = await asPerson(page, site, THREE_TABS, async (p) => {
        await stripTab(p, group.key).click({ button: 'right' });
        const item = p.getByRole('menuitem', { name: group.item, exact: true });
        expect(await unreachable(item), group.item).toBe('');
        await item.click();
        const closed = await personLands(p, group.shape);
        await reopenKey(p);
        await expect.poll(async () => tilesOf(await layoutOf(p))[0]?.tabs.length ?? 0).toBe(3);
        const reopened = await layoutOf(p);
        return { closed, reopened };
      });

      await openAgentWindow(page, site, agent, THREE_TABS);
      const closed = await agentApplies(page, agent, [
        { cmd: group.cmd, args: { key: group.key } },
      ]);
      expect(typeof closed.results[0]!.group).toBe('string');
      expectSame(closed.layout, person.closed, group.cmd);
      const reopened = await agentApplies(page, agent, [{ cmd: 'reopen' }]);
      expectSame(reopened.layout, person.reopened, `reopen after ${group.cmd}`);
    });
  }

  // --- a layout-less set of three, one call each -------------------------------

  /** Three members with no layout of their own. */
  const SET = [{ ref: B }, { ref: C }, { ref: D }];

  test('a set of three opens as tabs: one new tile beside the focused one', async ({
    page,
    site,
    agent,
  }) => {
    await openAgentWindow(page, site, agent, SOLO);
    const { layout, results } = await agentApplies(page, agent, [
      { cmd: 'open_set', args: { members: SET, as: 'tabs' } },
    ]);
    expect(results[0]!.keys).toEqual([B, C, D]);
    const tiles = tilesOf(layout);
    expect(tiles.map((t) => t.tabs)).toEqual([[A], [B, C, D]]);
    expect(layoutShape(layout)).toMatch(new RegExp(`^row\\[${escapeRe(A)},`));
  });

  test('a set of three opens side by side: one tile per member in a row', async ({
    page,
    site,
    agent,
  }) => {
    await openAgentWindow(page, site, agent, SOLO);
    const { layout, results } = await agentApplies(page, agent, [
      { cmd: 'open_set', args: { members: SET, as: 'side' } },
    ]);
    expect(results[0]!.keys).toEqual([B, C, D]);
    expect(layoutShape(layout)).toBe(`row[${A},${B},${C},${D}]`);
  });

  test('a set of three opens in a given layout, exactly', async ({ page, site, agent }) => {
    await openAgentWindow(page, site, agent, SOLO);
    const given = {
      split: 'column',
      items: [
        { tabs: [0, 1], showing: 1, size: 2 },
        { tabs: [2], size: 1 },
      ],
    };
    const { layout, results } = await agentApplies(page, agent, [
      { cmd: 'open_set', args: { members: SET, as: 'layout', layout: given } },
    ]);
    expect(results[0]!.keys).toEqual([B, C, D]);
    expect(typeof results[0]!.group).toBe('string');
    expect(layoutShape(layout)).toBe(`column[${B}|${C}*,${D}]`);
    const sizes = (layout as { items: Layout[] }).items.map((i) => i.size ?? 0);
    expect(sizes[0]! / (sizes[0]! + sizes[1]!)).toBeCloseTo(2 / 3, 1);
  });

  // --- read back, collections, refusals ----------------------------------------

  test('two tabs in one tile read back: tabs in bar order, the showing one', async ({
    page,
    site,
    agent,
  }) => {
    const doc = await openAgentWindow(page, site, agent, ABC);
    const { layout } = await agentApplies(
      page,
      agent,
      [
        {
          cmd: 'drop',
          args: {
            source: { tab: C },
            target: { tile: tileIdOf(doc.state!.layout, B), zone: 'tab', index: 0 },
          },
        },
      ],
      baseOf(doc)
    );
    // readBack has pinned get_workspace's layout to the window's own, ids and sizes included.
    const tile = tilesOf(layout).find((t) => t.tabs.includes(C)) as LayoutTile;
    expect(tile.tabs).toEqual([C, B]);
    expect(tile.showing).toBe(C);
    expect(tile.tile).toBe(tileIdOf(doc.state!.layout, B));
    const bar = page.locator(
      `[data-testid="tile-bar"][data-tile="${tile.tile}"] .canopy-tile-bar__tab`
    );
    await expect
      .poll(() => bar.evaluateAll((els) => els.map((el) => el.getAttribute('data-tab-key'))))
      .toEqual([C, B]);
    const reported = (await agent.ws()).state!;
    expect(reported.active).toBe(C);
    expect(reported.tabs.map((t) => t.key).sort()).toEqual([A, B, C].sort());
  });

  test('a collection with tabs per tile opens as saved', async ({
    page,
    site,
    agent,
    collectionsApi,
  }) => {
    // canopy's own collection with tabs per tile (its layout, verbatim) over
    // this hub's screens: its waveform member is served by neither host (the
    // trace stub has no waveform page), so the right tile holds C instead.
    const saved = JSON.parse(await readFile(TABBED_FILE, 'utf8')) as {
      id: string;
      members: ({ screen: string } | { tool: string; query?: string })[];
      layout: unknown;
    };
    const here = {
      ...saved,
      id: 'tabbed-here',
      members: [{ screen: A }, { screen: B }, { screen: C }],
    };
    if (LIVE) {
      await writeFile(
        join(live!.collectionsDir, `${here.id}.json`),
        `${JSON.stringify(here, null, 2)}\n`
      );
    } else {
      const put = await collectionsApi.put(`${MOUNT}/collections/${here.id}`, {
        data: here,
        headers: { 'If-None-Match': '*' },
      });
      expect(put.ok(), `PUT the collection: ${put.status()} ${await put.text()}`).toBe(true);
    }
    const ref = `personal:${here.id}`;
    const [m0, m1, m2] = [A, B, C];
    await openAgentWindow(page, site, agent, SOLO);
    const { layout } = await agentApplies(page, agent, [{ cmd: 'open_collection', args: { ref } }]);
    // Opened as saved: the collection's layout replaces the dock's, the left
    // tile holding two tabs and showing the second.
    expect(layoutShape(layout)).toBe(`row[${m0}|${m1}*,${m2}]`);
  });

  test('a tile command without base is refused whole; nothing changes', async ({
    page,
    site,
    agent,
  }) => {
    const doc = await openAgentWindow(page, site, agent, ABC);
    const before = await layoutOf(page);
    const tB = tileIdOf(doc.state!.layout, B);
    for (const commands of [
      [{ cmd: 'close_tile', args: { tile: tB } }],
      [{ cmd: 'drop', args: { source: { tile: tB }, target: { outer: 'left' } } }],
      [
        { cmd: 'focus', args: { key: C } },
        { cmd: 'drop', args: { source: { tab: A }, target: { tile: tB, zone: 'centre' } } },
      ],
      [
        {
          cmd: 'drop',
          args: { source: { new: { ref: E } }, target: { border: { tile: tB, side: 'left' } } },
        },
      ],
    ]) {
      const { batch } = await agent.send(commands);
      expect(batch, JSON.stringify(commands)).toMatchObject({
        id: null,
        status: 'refused',
        reason: 'invalid_command',
      });
    }
    expect(await readBack(page, agent)).toEqual(before);
    expect((await agent.ws()).state!.active).toBe(A);
  });
});

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
