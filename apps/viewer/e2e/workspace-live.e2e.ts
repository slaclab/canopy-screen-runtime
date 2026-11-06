// The agent's workspace end to end: a real canopy_mcp from a canopy checkout
// ($CANOPY_SRC, liveCanopy.ts) with the workspace on (CANOPY_WORKSPACE=1),
// this package's built viewer, and the agent's side played by an MCP client
// (mcpCall.ts) calling `get_workspace` / `set_workspace` exactly as an agent
// does. Nothing here reaches the window except through those two tools.
//
// Windows are either the workspace page itself or a stand-in host page
// (fixtures/workspace-host/host.html: the workspace in an iframe beside a
// host textarea) served from the viewer's own origin. Write tests run in hare
// mode against the mocked PV socket and write route of hostFixture.ts, as
// dock-write-safety.e2e.ts does.
//
// One canopy_mcp is one operator, so the tests run serially on one instance;
// each opens its own windows and closes them at its end.
//
// Latencies (enqueue -> applied: a set_workspace call's round trip for a
// batch that ends `done` with every command applied; change -> visible: an operator gesture until
// get_workspace shows it) are reported as p50/p95, never gated: a line on
// stdout and e2e/.results/workspace-live-latency.json.
//
// Skipped without CANOPY_SRC, unless REQUIRE_CANOPY_LIVE=1: then a missing or
// incomplete checkout fails every test, so a gate that requires the live run
// cannot pass by skipping it.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type FrameLocator, type Locator, type Page } from '@playwright/test';
import { WRITABLE_PV, installHareMock, installPvWriteRoute } from './hostFixture';
import { missingCanopy, startLiveCanopy, type LiveCanopy } from './liveCanopy';
import { McpClient } from './mcpCall';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOST_PAGE = readFileSync(join(HERE, 'fixtures', 'workspace-host', 'host.html'), 'utf8');
const WRITE_BUTTON_DRAFT = join(HERE, 'fixtures', 'drafts', 'write-button.screen.json');
const LATENCY_FILE = resolve(HERE, '.results', 'workspace-live-latency.json');

const CANOPY_SRC = process.env.CANOPY_SRC;
const REQUIRE_CANOPY_LIVE = process.env.REQUIRE_CANOPY_LIVE === '1';
const MISSING = missingCanopy(CANOPY_SRC);
/** sessionStorage key of the open tabs at the root mount (src/storageScope.ts). */
const TABS_KEY = 'canopy-viewer:tabs:/';
/** The write gate's input-guard notice (src/writeGate/guard.ts). */
const GUARD_NOTICE = 'screen just changed, nothing sent';

const LINAC = 'library/linac/LinacView';
const XFER = 'library/xfer/TransferView';
const OVERVIEW = 'library/sr/overview';
const WRITE_BUTTON = 'drafts/write-button';
const BPMS = 'pv=SR01C:BPM1:X&pv=SR01C:BPM2:X&pv=SR01C:BPM3:X&range=-1h';

// --- Types of the tools' answers (only what the spec reads) ------------------

interface Tab {
  key: string;
  kind: 'screen' | 'tool';
  canBack?: boolean;
  canForward?: boolean;
}

/** The layout, dock form: tiles with tabs (state.layout and the dock root's data-layout). */
interface LayoutTile {
  tile: string;
  tabs: string[];
  showing: string;
  size?: number;
}
interface LayoutSplit {
  split: 'row' | 'column';
  items: Layout[];
  size?: number;
}
type Layout = LayoutTile | LayoutSplit;

interface WorkspaceDoc {
  protocol: number;
  epoch: string;
  activeWindow: string | null;
  connected: boolean;
  shown: boolean;
  seq: number;
  state: {
    tabs: Tab[];
    active: string | null;
    layout: Layout | null;
    zoom: Record<string, unknown>;
    instances: Record<string, { tool: string; query: string | null }>;
  } | null;
  results: { id: string; status: string }[];
}

interface CommandResult {
  id: string;
  cmd?: string;
  status: string;
  changed?: boolean;
  reason?: string;
  after?: string;
  key?: string;
  group?: string;
  previous_query?: string | null;
  [extra: string]: unknown;
}

interface SetResult extends WorkspaceDoc {
  batch: { id: string; status: string; reason?: string; results: CommandResult[] };
}

type Command = { cmd: string; args?: Record<string, unknown> };

// --- Shared state -------------------------------------------------------------

let live: LiveCanopy | undefined;
let mcp: McpClient;
const latency = { enqueueToApplied: [] as number[], changeToVisible: [] as number[] };

const url = (path: string) => `${live!.origin}/${path}`;

function ws(): Promise<WorkspaceDoc> {
  return mcp.call<WorkspaceDoc>('get_workspace');
}

/** set_workspace; a `done` batch's round trip is one enqueue -> applied sample. */
async function send(
  commands: Command[],
  options: { base?: unknown; batch_id?: string; wait_s?: number } = {}
): Promise<SetResult> {
  const started = performance.now();
  const result = await mcp.call<SetResult>('set_workspace', {
    commands: commands.map((c) => ({ cmd: c.cmd, args: c.args ?? {} })),
    ...options,
  });
  const { status, results } = result.batch;
  if (status === 'done' && results.every((r) => r.status === 'applied')) {
    latency.enqueueToApplied.push(performance.now() - started);
  }
  return result;
}

/** Expects a `done` batch whose every command is applied; returns its results. */
async function sendApplied(commands: Command[]): Promise<CommandResult[]> {
  const { batch } = await send(commands);
  expect(batch, JSON.stringify(batch)).toMatchObject({ status: 'done' });
  expect(
    batch.results.map((r) => r.status),
    JSON.stringify(batch.results)
  ).toEqual(commands.map(() => 'applied'));
  return batch.results;
}

/** Polls get_workspace until `pred` holds; resolves with that document. */
async function waitWs(
  pred: (doc: WorkspaceDoc) => boolean,
  message: string,
  timeout = 10_000
): Promise<WorkspaceDoc> {
  let last: WorkspaceDoc | null = null;
  await expect
    .poll(
      async () => {
        last = await ws();
        return pred(last);
      },
      { message, timeout, intervals: [25] }
    )
    .toBe(true);
  return last!;
}

const tabKeysOf = (doc: WorkspaceDoc): string[] => doc.state?.tabs.map((t) => t.key) ?? [];

/** The tiles of `layout`, in layout order. */
function tilesOf(layout: Layout | null | undefined): LayoutTile[] {
  if (!layout) return [];
  if ('tile' in layout) return [layout];
  return layout.items.flatMap(tilesOf);
}

/** The layout's tiles as `[tabs, showing]`, tile ids left out (they are the window's to mint). */
const tileTabsOf = (layout: Layout | null | undefined): [string[], string][] =>
  tilesOf(layout).map((t) => [t.tabs, t.showing]);

/** The id of the tile holding `key` in `layout`. */
function tileIdOf(layout: Layout | null | undefined, key: string): string {
  const tile = tilesOf(layout).find((t) => t.tabs.includes(key));
  if (!tile) throw new Error(`no tile holds ${key} in ${JSON.stringify(layout)}`);
  return tile.tile;
}

function percentile(samples: number[], p: number): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return Math.round(sorted[Math.max(0, index)]);
}

// --- Windows ------------------------------------------------------------------

/** Seeds the page's stored tabs before it loads, only while the key is absent. */
async function seedTabs(page: Page, keys: string[], active: string | null): Promise<void> {
  await page.addInitScript(
    ([key, value]) => {
      if (window === window.top && sessionStorage.getItem(key) === null) {
        sessionStorage.setItem(key, value);
      }
    },
    [TABS_KEY, JSON.stringify({ keys, active })] as const
  );
}

/** Serves the host page at `<origin>/host-<name>.html` for this page. */
async function routeHost(page: Page, name: string): Promise<string> {
  const path = `host-${name}.html`;
  await page.route(url(path), (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: HOST_PAGE })
  );
  return url(path);
}

const tabsIn = (root: Page | FrameLocator): Locator =>
  root.getByRole('tablist', { name: 'Open tabs' }).getByRole('tab');

const tabIn = (root: Page | FrameLocator, key: string): Locator =>
  root.locator(`.tab-strip [role="tab"][data-tab-key="${key}"]`);

async function tabKeysIn(root: Page | FrameLocator): Promise<string[]> {
  return tabsIn(root).evaluateAll((els) => els.map((el) => el.getAttribute('data-tab-key') ?? ''));
}

/** The window's own layout: its dock root's `data-layout`. */
async function layoutIn(root: Page | FrameLocator): Promise<Layout | null> {
  const raw = await root.getByTestId('workspace-dock').getAttribute('data-layout');
  return raw === null ? null : (JSON.parse(raw) as Layout | null);
}

/** Every key the window's layout holds, tile by tile, bar order within a tile. */
async function layoutKeysIn(root: Page | FrameLocator): Promise<string[]> {
  return tilesOf(await layoutIn(root)).flatMap((t) => t.tabs);
}

/** The workspace's screen tree, which is on screen once the workspace is up. */
const treeIn = (root: Page | FrameLocator): Locator =>
  root.getByRole('navigation', { name: 'Screens' });

/**
 * Opens a host page with the workspace seeded with `keys` and waits until it
 * holds the slot. Resolves with its frame and its windowId.
 */
async function openHost(
  page: Page,
  name: string,
  keys: string[],
  active: string | null = keys[0] ?? null
): Promise<{ frame: FrameLocator; windowId: string }> {
  await seedTabs(page, keys, active);
  const before = (await ws()).activeWindow;
  await page.goto(await routeHost(page, name));
  const frame = page.frameLocator('[data-testid="host-frame"]');
  await expect(treeIn(frame)).toBeVisible();
  await expect.poll(() => tabKeysIn(frame)).toEqual(keys);
  // A gesture inside the frame claims the slot whether or not the load did.
  await frame.getByRole('searchbox', { name: 'Search screens' }).click();
  const doc = await waitWs(
    (d) =>
      d.activeWindow !== null &&
      d.activeWindow !== before &&
      d.connected &&
      d.shown &&
      JSON.stringify(tabKeysOf(d)) === JSON.stringify(keys),
    `host ${name} holds the slot`
  );
  return { frame, windowId: doc.activeWindow! };
}

/** Opens the workspace page itself, seeded with `keys`; waits until it holds the slot. */
async function openWorkspace(
  page: Page,
  keys: string[],
  active: string | null = keys[0] ?? null
): Promise<string> {
  await seedTabs(page, keys, active);
  const before = (await ws()).activeWindow;
  await page.goto(url('embed/'));
  await expect(treeIn(page)).toBeVisible();
  await expect.poll(() => tabKeysIn(page)).toEqual(keys);
  await page.getByRole('searchbox', { name: 'Search screens' }).click();
  const doc = await waitWs(
    (d) => d.activeWindow !== null && d.activeWindow !== before && d.connected && d.shown,
    'the workspace holds the slot'
  );
  return doc.activeWindow!;
}

// --- The spec -----------------------------------------------------------------

test.describe('the workspace on a live canopy_mcp', () => {
  test.describe.configure({ mode: 'serial', timeout: 60_000 });

  test.beforeAll(async () => {
    if (MISSING !== null) return;
    test.setTimeout(90_000);
    live = await startLiveCanopy(CANOPY_SRC!, {
      env: { CANOPY_WORKSPACE: '1' },
      drafts: [WRITE_BUTTON_DRAFT],
    });
    mcp = new McpClient(live.origin);
    await mcp.connect();
  });

  test.afterAll(async () => {
    await live?.stop();
    live = undefined;
    if (MISSING !== null) return;
    const report = {
      enqueueToApplied: {
        n: latency.enqueueToApplied.length,
        p50: percentile(latency.enqueueToApplied, 50),
        p95: percentile(latency.enqueueToApplied, 95),
      },
      changeToVisible: {
        n: latency.changeToVisible.length,
        p50: percentile(latency.changeToVisible, 50),
        p95: percentile(latency.changeToVisible, 95),
      },
    };
    mkdirSync(dirname(LATENCY_FILE), { recursive: true });
    writeFileSync(LATENCY_FILE, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`workspace-live latency (ms): ${JSON.stringify(report)}`);
  });

  test.beforeEach(() => {
    if (MISSING === null) return;
    if (REQUIRE_CANOPY_LIVE) throw new Error(`REQUIRE_CANOPY_LIVE=1 but ${MISSING}`);
    test.skip(true, MISSING);
  });

  test('both tools are offered; with no window a batch is refused no_window', async () => {
    const tools = await mcp.tools();
    expect(tools).toEqual(expect.arrayContaining(['get_workspace', 'set_workspace']));
    const doc = await ws();
    expect(doc.protocol).toBe(1);
    expect(doc.activeWindow).toBeNull();
    const { batch } = await send([{ cmd: 'open', args: { ref: LINAC } }]);
    expect(batch).toMatchObject({ status: 'refused', reason: 'no_window' });
  });

  test('the acceptance batch: Trace on three BPMs, two screens side by side as tiles, both fit; close_tab XFER, Undo; close_tile, reopen', async ({
    page,
  }) => {
    const { frame } = await openHost(page, 'solo', []);
    // Trace opens first as the one tile; open_set as side splits the focused
    // tile into a row of halves-and-more: Trace | LINAC | XFER, a tile each.
    const results = await sendApplied([
      { cmd: 'open_tool', args: { tool: 'trace', query: BPMS } },
      { cmd: 'open_set', args: { members: [{ ref: LINAC }, { ref: XFER }], as: 'side' } },
      { cmd: 'zoom', args: { key: LINAC, step: 'fit' } },
      { cmd: 'zoom', args: { key: XFER, step: 'fit' } },
    ]);
    // A screen opens at fit, so the zooms are applied no-ops (changed:false).
    expect(results.map((r) => r.changed)).toEqual([true, true, false, false]);
    const trace = results[0].key as string;
    expect(trace).toMatch(/^@trace/);
    expect(results[1].keys).toEqual([LINAC, XFER]);
    // The touched element highlights.
    await expect(frame.locator('[data-agent-touched]').first()).toBeAttached();

    const doc = await waitWs(
      (d) => d.state?.instances[trace]?.query === BPMS && tilesOf(d.state?.layout).length === 3,
      'the document shows the Trace query and three tiles'
    );
    expect(tabKeysOf(doc)).toEqual(expect.arrayContaining([trace, LINAC, XFER]));
    expect(tabKeysOf(doc)).toHaveLength(3);
    // The layout: a row of three tiles, one tab each, each showing its tab, sizes summing to 1.
    const layout = doc.state!.layout as LayoutSplit;
    expect(layout.split).toBe('row');
    expect(tileTabsOf(layout)).toEqual([
      [[trace], trace],
      [[LINAC], LINAC],
      [[XFER], XFER],
    ]);
    const sizes = layout.items.map((item) => item.size ?? 0);
    expect(sizes.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 2);
    for (const size of sizes) expect(size).toBeGreaterThan(0);
    // The window's own dock says the same, tile ids included.
    expect(await layoutIn(frame)).toEqual(layout);
    // Two or more tiles: each tile has its own tab bar and there is no strip.
    await expect(frame.locator('[data-testid="tile-bar"]')).toHaveCount(3);
    await expect(tabsIn(frame)).toHaveCount(0);
    expect(doc.state!.zoom[LINAC]).toEqual({ mode: 'fit' });
    expect(doc.state!.zoom[XFER]).toEqual({ mode: 'fit' });

    // Closing the last tab of a tile removes the tile; Undo brings it back.
    const [closed] = await sendApplied([{ cmd: 'close_tab', args: { key: XFER } }]);
    expect(closed).toMatchObject({ changed: true });
    expect(typeof closed.group).toBe('string');
    const twoTiles = await waitWs(
      (d) => tilesOf(d.state?.layout).length === 2,
      'the closed tab took its tile with it'
    );
    expect(tileTabsOf(twoTiles.state!.layout)).toEqual([
      [[trace], trace],
      [[LINAC], LINAC],
    ]);
    await expect.poll(() => layoutKeysIn(frame)).toEqual([trace, LINAC]);
    await frame.getByRole('button', { name: 'Undo' }).click();
    await expect
      .poll(() => layoutKeysIn(frame))
      .toEqual(expect.arrayContaining([trace, LINAC, XFER]));
    const undone = await waitWs((d) => tabKeysOf(d).includes(XFER), 'Undo shows in the document');
    expect(tilesOf(undone.state!.layout).find((t) => t.tabs.includes(XFER))?.showing).toBe(XFER);

    // close_tile names a tile id from state.layout, so it needs base; reopen brings it back.
    const before = await ws();
    const linacTile = tileIdOf(before.state!.layout, LINAC);
    const { batch } = await send([{ cmd: 'close_tile', args: { tile: linacTile } }], {
      base: { window: before.activeWindow, seq: before.seq },
    });
    expect(batch, JSON.stringify(batch)).toMatchObject({ status: 'done' });
    expect(batch.results[0]).toMatchObject({ status: 'applied', changed: true });
    const noLinac = await waitWs(
      (d) => !tabKeysOf(d).includes(LINAC),
      'the tile and its tab closed'
    );
    expect(tilesOf(noLinac.state!.layout).some((t) => t.tile === linacTile)).toBe(false);
    await sendApplied([{ cmd: 'reopen' }]);
    await expect.poll(() => layoutKeysIn(frame)).toContain(LINAC);
    await waitWs((d) => tabKeysOf(d).includes(LINAC), 'reopen shows in the document');
  });

  test('an operator change is visible in get_workspace within 1 s', async ({ page }) => {
    await openWorkspace(page, [LINAC, XFER], LINAC);
    for (let i = 0; i < 6; i++) {
      const key = i % 2 === 0 ? XFER : LINAC;
      await tabIn(page, key).click();
      const clicked = performance.now();
      await waitWs((d) => d.state?.active === key, `${key} active in the document`, 5_000);
      const elapsed = performance.now() - clicked;
      latency.changeToVisible.push(elapsed);
      expect(elapsed, `change -> visible for ${key}`).toBeLessThanOrEqual(1_000);
    }
  });

  test('two host pages: a focus switch moves activeWindow, an open changes only B, reloading A leaves B active', async ({
    page,
  }) => {
    const a = await openHost(page, 'a', [LINAC]);
    const pageB = await page.context().newPage();
    try {
      const b = await openHost(pageB, 'b', [XFER]);
      expect(b.windowId).not.toBe(a.windowId);

      // Back to A by a gesture in A, then to B by focusing B's host textarea.
      await page.bringToFront();
      await a.frame.getByRole('searchbox', { name: 'Search screens' }).click();
      await waitWs((d) => d.activeWindow === a.windowId, 'A holds the slot again');
      await pageB.bringToFront();
      await pageB.getByTestId('host-notes').click();
      await pageB.keyboard.type('note');
      await waitWs(
        (d) => d.activeWindow === b.windowId,
        'B holds the slot after its host gains focus'
      );

      const [opened] = await sendApplied([{ cmd: 'open', args: { ref: OVERVIEW } }]);
      expect(opened).toMatchObject({ key: OVERVIEW, changed: true });
      await expect.poll(() => tabKeysIn(b.frame)).toEqual([XFER, OVERVIEW]);
      expect(await tabKeysIn(a.frame)).toEqual([LINAC]);

      // Reloading A while B is focused leaves B active. Headless Chromium
      // reports every page as focused (document.hasFocus() is true in each), so
      // A's reload stands in for a background window: from here on A's
      // documents answer hasFocus() as a window without the OS focus does.
      await page.addInitScript(() => {
        Document.prototype.hasFocus = () => false;
      });
      await page.reload();
      await expect.poll(() => tabKeysIn(a.frame)).toEqual([LINAC]);
      await page.waitForTimeout(1_500);
      const doc = await ws();
      expect(doc.activeWindow).toBe(b.windowId);
      expect(tabKeysOf(doc)).toEqual([XFER, OVERVIEW]);
    } finally {
      await pageB.close();
    }
  });

  test('open_tool and set_query; over-cap PVs are invalid_args; the eleventh Trace is instance_cap', async ({
    page,
  }) => {
    await openWorkspace(page, [LINAC]);
    const first = 'pv=SR01C:BPM1:X&range=-1h';
    const [opened] = await sendApplied([
      { cmd: 'open_tool', args: { tool: 'trace', query: first } },
    ]);
    const key = opened.key as string;
    expect(key).toMatch(/^@trace/);
    // The same query again focuses that instance: no new tab.
    const [again] = await sendApplied([
      { cmd: 'open_tool', args: { tool: 'trace', query: first } },
    ]);
    expect(again.key).toBe(key);

    const [moved] = await sendApplied([{ cmd: 'set_query', args: { key, query: BPMS } }]);
    expect(moved).toMatchObject({ changed: true, previous_query: first });
    await waitWs((d) => d.state?.instances[key]?.query === BPMS, 'the new query in the document');

    const thirteen = Array.from({ length: 13 }, (_, i) => `pv=SR01C:BPM${i + 1}:X`).join('&');
    const overCap = await send([
      { cmd: 'set_query', args: { key, query: `${thirteen}&range=-1h` } },
      { cmd: 'focus', args: { key: LINAC } },
    ]);
    expect(overCap.batch.status).toBe('done');
    expect(overCap.batch.results[0]).toMatchObject({ status: 'rejected', reason: 'invalid_args' });
    expect(overCap.batch.results[1]).toMatchObject({
      status: 'skipped',
      after: overCap.batch.results[0].id,
    });
    expect((await ws()).state?.instances[key]?.query).toBe(BPMS);

    // Nine more distinct queries make ten instances; the next is refused at the cap.
    const nine = Array.from({ length: 9 }, (_, i) => ({
      cmd: 'open_tool',
      args: { tool: 'trace', query: `pv=SR02C:BPM${i + 1}:Y&range=-1h` },
    }));
    await sendApplied(nine);
    const capped = await send([
      { cmd: 'open_tool', args: { tool: 'trace', query: 'pv=SR03C:BPM1:Y&range=-1h' } },
    ]);
    expect(capped.batch.results[0]).toMatchObject({ status: 'rejected', reason: 'instance_cap' });
    const doc = await ws();
    expect(doc.state!.tabs.filter((t) => t.kind === 'tool')).toHaveLength(10);
  });

  test("the operator reopens the agent's close from Recently closed after closing something else", async ({
    page,
  }) => {
    await openWorkspace(page, [LINAC, XFER, OVERVIEW], LINAC);
    await sendApplied([{ cmd: 'close_tab', args: { key: XFER } }]);
    await expect.poll(() => tabKeysIn(page)).toEqual([LINAC, OVERVIEW]);

    // The operator closes another tab after the agent's close.
    await tabIn(page, OVERVIEW).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Close', exact: true }).click();
    await expect.poll(() => tabKeysIn(page)).toEqual([LINAC]);

    // Recently closed is a window-wide action: it lives in the window menu.
    // A real pointer opens the menu, its submenu and the item: each sits in the viewport.
    await page.getByRole('button', { name: 'Window menu' }).click();
    await expect(page.getByRole('menu').first()).toBeInViewport({ ratio: 1 });
    const recent = page.getByRole('menuitem', { name: 'Recently closed' });
    await expect(recent).toBeInViewport({ ratio: 1 });
    await recent.click();
    const items = page.getByRole('menuitem', { name: / · (agent|you)$/ });
    await expect(items).toHaveCount(2);
    const agentItem = page.getByRole('menuitem', { name: / · agent$/ });
    await expect(agentItem).toBeInViewport({ ratio: 1 });
    await agentItem.click();
    await expect.poll(() => tabKeysIn(page)).toEqual([LINAC, XFER]);
    await waitWs(
      (d) => JSON.stringify(tabKeysOf(d)) === JSON.stringify([LINAC, XFER]),
      "the agent's group is back, the operator's close stands"
    );
  });

  test('a write click on a screen the agent just opened sends nothing; later it writes', async ({
    page,
  }) => {
    await installHareMock(page);
    const writes = await installPvWriteRoute(page);
    await openWorkspace(page, []);

    const button = page.getByRole('button', { name: 'Write', exact: true });
    // The click is in flight before the batch: it lands as soon as the button can take it.
    const clicking = button.click();
    const [opened] = await sendApplied([{ cmd: 'open', args: { ref: WRITE_BUTTON } }]);
    expect(opened).toMatchObject({ key: WRITE_BUTTON, changed: true });
    await clicking;
    await expect(
      page.getByTestId('canopy-write-toast').filter({ hasText: GUARD_NOTICE })
    ).toBeVisible();
    await expect(page.getByTestId('canopy-write-dialog')).toHaveCount(0);
    expect(writes.count).toBe(0);

    // Past the guard the same click asks (confirmWrites) and writes once.
    await page.waitForTimeout(1_000);
    await button.click();
    await page.getByTestId('canopy-write-confirm').click();
    await expect.poll(() => writes.count).toBe(1);
    expect(writes.writes[0].pv).toBe(WRITABLE_PV);
  });

  test('a collapsed host frame is refused window_hidden; no open window is refused no_window', async ({
    page,
  }) => {
    const { windowId } = await openHost(page, 'hidden', [LINAC]);
    await page.getByTestId('host-collapse').click();
    await waitWs((d) => d.activeWindow === windowId && !d.shown, 'the window reports not shown');
    const hidden = await send([{ cmd: 'open', args: { ref: XFER } }]);
    expect(hidden.batch).toMatchObject({ status: 'refused', reason: 'window_hidden' });

    await page.getByTestId('host-show').click();
    await waitWs((d) => d.activeWindow === windowId && d.shown, 'the window reports shown');
    await sendApplied([{ cmd: 'focus', args: { key: LINAC } }]);

    // Closed: within 3 s of its stream ending a batch still binds to the
    // window (it may be reconnecting) and resolves window_gone; after that
    // nothing is connected and a batch is refused no_window.
    await page.close();
    await waitWs((d) => !d.connected, 'the closed window is no longer connected');
    const gap = await send([{ cmd: 'open', args: { ref: XFER } }]);
    expect(gap.batch.status).toBe('done');
    expect(gap.batch.results.map((r) => r.status)).toEqual(['window_gone']);
    const none = await send([{ cmd: 'open', args: { ref: XFER } }]);
    expect(none.batch).toMatchObject({ status: 'refused', reason: 'no_window' });
  });

  // Chromium keeps a display:none iframe's last innerWidth/innerHeight and
  // fires no resize, so the frame still reads as shown and a batch is
  // delivered to a panel nobody sees. Fails until the viewer detects it.
  test.fail('a display:none host frame is refused window_hidden', async ({ page }) => {
    const { windowId } = await openHost(page, 'display-none', [LINAC]);
    await page.getByTestId('host-hide').click();
    await waitWs(
      (d) => d.activeWindow === windowId && !d.shown,
      'the window reports not shown',
      3_000
    );
  });

  test('a FRONT restart: the same window holds the slot again within 2 s', async ({ page }) => {
    const windowId = await openWorkspace(page, [LINAC]);
    const { epoch } = await ws();
    const down = performance.now();
    await live!.restart();
    const up = performance.now();
    console.log(`workspace-live restart: FRONT down for ${Math.round(up - down)} ms`);
    const doc = await waitWs(
      (d) => d.activeWindow === windowId && d.connected,
      'the window re-claims after the restart',
      10_000
    );
    const elapsed = performance.now() - up;
    console.log(`workspace-live restart -> re-claimed: ${Math.round(elapsed)} ms`);
    expect(doc.epoch).not.toBe(epoch);
    expect(elapsed, 'restart -> same window active').toBeLessThanOrEqual(2_000);
    await sendApplied([{ cmd: 'open', args: { ref: XFER } }]);
    await expect.poll(() => tabKeysIn(page)).toEqual([LINAC, XFER]);
  });
});
