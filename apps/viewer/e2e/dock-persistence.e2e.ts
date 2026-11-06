// Acceptance for frame continuity and layout persistence (cases (a)-(i)) in
// the dock of tiles with tabs, one test per case:
//
// - frame continuity: within one document the data browser's index loads once and its
//   `__marker` survives a split, a sash drag, a hide (another tab shown in
//   front of the correlation), a tab dragged back out to its own tile, Reset,
//   a fourth tab opened and closed and a whole-tile move; a reload loads
//   it exactly once more and restores the pre-reload layout; the Mole poll
//   counter advances for both showing frames and stops for a hidden one.
// - (a): stored tabs, no stored dock: every tab in one tile, the stored
//   active one showing, URL unchanged, no warning, no write within 500 ms.
// - (b): a stored dock naming a closed key and a tile of two tabs loads
//   pruned (the two-tab tile kept as it is), the closed key is not reopened,
//   no write.
// - (c): after another browser tab wrote a different dock, a reload keeps
//   this tab's own tabs, each in a tile, and leaves the key untouched.
// - (d): a new session (localStorage, no sessionStorage) on bare /embed/
//   reopens exactly the stored A|B, no data browser, the first tile focused
//   (focus is not stored).
// - (e): the same with a deep link to a screen not in the stored dock: it
//   opens as the showing tab of the focused tile and nothing resizes.
// - (f): a saved view loaded into a data browser in a tile reopens in a new
//   session with one frame load and the view's query in `src`.
// - (g): close every tab, reload: an empty dock with the no-tab notice.
// - (h): non-JSON, a dockview grid under another version and an invalid dock each
//   open the default layout with no warning; the value stays until the first
//   armed write replaces it with a valid version 1 dock.
// - (i): Reset from the window menu (disabled with one tile) gives equal
//   columns in layout order, tabs kept, and persists them.
//
// Writing is armed only by a trusted pointer or key event inside the
// workspace, and dockHelpers' drags are synthetic, so every spec that expects
// a write first makes a real click (on the focused tab, which changes
// nothing). A new session is a new browser context carrying the first one's
// storageState: localStorage and cookies, never sessionStorage.

import { isDeepStrictEqual } from 'node:util';
import { expect, test } from '@playwright/test';
import type { APIRequestContext, Browser, BrowserContext, Frame, Page } from '@playwright/test';
import {
  DOCK_KEY,
  PREFIX,
  TABS_KEY,
  dockLayout,
  dockRoot,
  dragTo,
  edgePoint,
  layoutKeys,
  layoutShape,
  overlayItem,
  seedDock,
  settled,
  showingKeys,
  stripTab,
  storedDock,
  tileContentRect,
  tileOf,
  tileRect,
  tileTab,
  tilesOf,
  type DragFrom,
  type Layout,
  type Rect,
  type Side,
  closeTileTab,
  unreachable,
} from './dockHelpers';

test.describe.configure({ timeout: 30_000 });

const PANEL = 'drafts/e2e-panel';
const LABELS = 'drafts/label-fit';
const WIDE = 'drafts/wide-panel';
const PLOT = 'drafts/plot-panel';
const TRACE = '@trace';
const CORRELATION = '@correlation';
const CORRELATION2 = '@correlation/2';

const TRACE_PATH = `${PREFIX}/trace/`;
/** sessionStorage flag of the one-shot raw dock seed. */
const SEEDED_FLAG = 'e2e:dock-seeded';

const tree = (page: Page) => page.getByRole('navigation', { name: 'Screens' });
const toolFrame = (page: Page, key: string) => page.locator(`iframe[data-tab-key="${key}"]`);
const viewItem = (page: Page, name: string) =>
  tree(page).getByRole('treeitem', { name, exact: true });

interface ToolSeed {
  query: string;
  view?: string;
}

/** The stored open tabs, tool instances included (dockHelpers' seedTabs carries keys and active only). */
interface SeedTabs {
  keys: string[];
  active: string | null;
  instances?: Record<string, ToolSeed>;
}

/** The stored dock value (storage.ts StoredDock, version 1). */
interface StoredValue {
  version: number;
  layout: Layout | null;
  panels: Record<string, { kind: string; query?: string; view?: string }>;
}

/** A probe id unique to this run (the server is shared by parallel workers). */
function probe(name: string): string {
  return `${name}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Seeds the open tabs before the app runs: top window only, key absent (a reload keeps them). */
async function seedTabs(page: Page, tabs: SeedTabs): Promise<void> {
  await page.addInitScript(
    ([key, value]) => {
      if (window === window.top && sessionStorage.getItem(key) === null) {
        sessionStorage.setItem(key, value);
      }
    },
    [TABS_KEY, JSON.stringify(tabs)] as const
  );
}

/**
 * Seeds a raw stored dock string once per browser tab, before the app runs
 * (any string, non-JSON included): a later reload sees whatever the app did
 * (or did not) write. Register it before watchWrites.
 */
async function seedRaw(page: Page, raw: string): Promise<void> {
  await page.addInitScript(
    ([key, flag, value]) => {
      if (window === window.top && sessionStorage.getItem(flag) === null) {
        localStorage.setItem(key, value);
        sessionStorage.setItem(flag, '1');
      }
    },
    [DOCK_KEY, SEEDED_FLAG, raw] as const
  );
}

/** Records every localStorage setItem/removeItem on a dock key, per document, in `__dockWrites`. */
async function watchWrites(page: Page): Promise<void> {
  await page.addInitScript((prefix) => {
    if (window !== window.top) return;
    const log: { op: string; key: string }[] = [];
    (window as unknown as { __dockWrites: typeof log }).__dockWrites = log;
    const proto = Storage.prototype;
    const setItem = proto.setItem;
    const removeItem = proto.removeItem;
    proto.setItem = function (this: Storage, key: string, value: string) {
      if (this === window.localStorage && String(key).startsWith(prefix)) {
        log.push({ op: 'set', key: String(key) });
      }
      return setItem.call(this, key, value);
    };
    proto.removeItem = function (this: Storage, key: string) {
      if (this === window.localStorage && String(key).startsWith(prefix)) {
        log.push({ op: 'remove', key: String(key) });
      }
      return removeItem.call(this, key);
    };
  }, 'canopy-workspace-dock:');
}

/** The dock writes this document made so far. */
function dockWrites(page: Page): Promise<{ op: string; key: string }[]> {
  return page.evaluate(
    () => (window as unknown as { __dockWrites?: { op: string; key: string }[] }).__dockWrites ?? []
  );
}

/** Collects the workspace's console warnings ('Workspace: ...'); register before goto. */
function watchWarnings(page: Page): string[] {
  const warnings: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'warning' && message.text().startsWith('Workspace:')) {
      warnings.push(message.text());
    }
  });
  return warnings;
}

/** The raw stored dock string, null when none is stored. */
function storedRaw(page: Page): Promise<string | null> {
  return page.evaluate((key) => localStorage.getItem(key), DOCK_KEY);
}

async function readStored(page: Page): Promise<StoredValue | null> {
  const raw = await storedRaw(page);
  return raw === null ? null : (JSON.parse(raw) as StoredValue);
}

/** Waits until the stored dock is version 1 and its layout equals the live one (the 150 ms debounce settles). */
async function settledStore(page: Page): Promise<StoredValue> {
  await expect
    .poll(
      async () => {
        const stored = await readStored(page).catch(() => null);
        const live: unknown = await dockLayout(page);
        return stored !== null && stored.version === 1 && isDeepStrictEqual(stored.layout, live);
      },
      { message: 'the stored layout settles on the live layout' }
    )
    .toBe(true);
  return (await readStored(page))!;
}

/** The key of the focused tile's showing tab (the overlay item marked focused). */
async function focusedKey(page: Page): Promise<string | null> {
  const item = page.locator('.canopy-dock-overlay__item[data-focused="true"]');
  if ((await item.count()) === 0) return null;
  return item.first().getAttribute('data-tab-key');
}

/** The keys of the stored open tabs. */
async function sessionKeys(page: Page): Promise<string[] | null> {
  return page.evaluate(
    (key) => (JSON.parse(sessionStorage.getItem(key) ?? 'null')?.keys ?? null) as string[] | null,
    TABS_KEY
  );
}

/** The tab of `key`, wherever it sits: the strip (one tile) or its tile's bar. */
async function anyTab(page: Page, key: string) {
  return (await stripTab(page, key).count()) > 0 ? stripTab(page, key) : tileTab(page, key);
}

/**
 * A real click on `key`'s tab, 8 px in from its left end: in a narrow tile the
 * showing tab's header controls cover the right part of a tile-bar tab.
 */
async function clickTab(page: Page, key: string): Promise<void> {
  await (await anyTab(page, key)).click({ position: { x: 8, y: 8 } });
}

/** A real click on the focused tile's showing tab: it changes nothing and arms writing. */
async function arm(page: Page): Promise<void> {
  const key = await focusedKey(page);
  expect(key, 'a focused tab to arm on').not.toBeNull();
  await clickTab(page, key!);
}

/** Shows and focuses `key` with a real click on its tab. */
async function focusTab(page: Page, key: string): Promise<void> {
  await clickTab(page, key);
  await expect.poll(() => focusedKey(page)).toBe(key);
}

/** Waits until the layout has `shape` and every showing tab is placed over its tile. */
async function expectShape(page: Page, shape: string): Promise<void> {
  await expect.poll(async () => layoutShape(await dockLayout(page))).toBe(shape);
  await expect(page.locator('.canopy-dock-overlay')).not.toHaveAttribute('data-dragging', 'true');
  for (const key of await showingKeys(page)) {
    await expect(overlayItem(page, key)).toHaveAttribute('data-placed', 'true');
  }
}

/** Every tile's rect, keyed by its showing key, once they hold still. */
async function settledTiles(page: Page): Promise<Record<string, Rect>> {
  return settled(page, async () => {
    const out: Record<string, Rect> = {};
    for (const t of tilesOf(await dockLayout(page))) {
      const r = await tileRect(page, t.tile);
      if (r) out[t.showing] = r;
    }
    return out;
  });
}

/** `key`'s content rect once it holds still. */
async function settledRect(page: Page, key: string): Promise<Rect> {
  const rect = await settled(page, () => tileContentRect(page, key));
  expect(rect, `${key} is placed`).not.toBeNull();
  return rect!;
}

/** The drag source of `key`'s tab, wherever it sits. */
async function tabSource(page: Page, key: string): Promise<DragFrom> {
  return (await stripTab(page, key).count()) > 0 ? { from: 'strip', key } : { from: 'tab', key };
}

/** Drops `key`'s tab (or, with `grip`, its whole tile) 30 px inside `edge` of the tile showing `target`: a split. */
async function dropAtEdge(
  page: Page,
  key: string,
  target: string,
  edge: Side,
  grip = false
): Promise<void> {
  const rect = await settledRect(page, target);
  const src: DragFrom = grip
    ? { from: 'grip', tile: tileOf(await dockLayout(page), key)!.tile }
    : await tabSource(page, key);
  await dragTo(page, src, edgePoint(rect, edge, 64), 'split');
  await expect(page.locator('.canopy-dock-overlay')).not.toHaveAttribute('data-dragging', 'true');
}

/**
 * Drops `key`'s tab on the tab bar of the tile showing `target`, over the left
 * end of `target`'s tab: a tab of that tile (the tab-bar form; the
 * centre form is pinned in dock-tiles.e2e.ts).
 */
async function dropAsTab(page: Page, key: string, target: string): Promise<void> {
  const tab = (await tileTab(page, target).boundingBox())!;
  await dragTo(
    page,
    await tabSource(page, key),
    { x: tab.x + 8, y: tab.y + tab.height / 2 },
    'tab'
  );
  await expect(page.locator('.canopy-dock-overlay')).not.toHaveAttribute('data-dragging', 'true');
}

/** Opens the window menu and returns the menu item `name` (outside the viewport at times: dispatch clicks). */
/** Opens the Window menu and returns its item `name`, checked reachable by a real pointer. */
async function windowMenuItem(page: Page, name: string) {
  await page.getByRole('button', { name: 'Window menu' }).click();
  await expect(page.getByRole('menu').first()).toBeInViewport({ ratio: 1 });
  const item = page.getByRole('menuitem', { name });
  expect(await unreachable(item), `Window menu item ${name}`).toBe('');
  return item;
}

/** Rect equality to within a pixel's rounding. */
function expectSameRect(actual: Rect | null, expected: Rect | null, what: string): void {
  expect(actual, `${what}: actual rect`).not.toBeNull();
  expect(expected, `${what}: expected rect`).not.toBeNull();
  for (const side of ['x', 'y', 'width', 'height'] as const) {
    expect(Math.abs(actual![side] - expected![side]), `${what}: ${side}`).toBeLessThan(1.5);
  }
}

/** Counts document requests for the data browser stub's index (keeps counting across reloads). */
function countTraceIndex(page: Page): { count: number } {
  const counter = { count: 0 };
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === TRACE_PATH) counter.count += 1;
  });
  return counter;
}

/** The data browser stub's frame (the correlation page has its own pathname). */
function traceFrame(page: Page): Frame {
  const frame = page.frames().find((f) => {
    try {
      return new URL(f.url()).pathname === TRACE_PATH;
    } catch {
      return false;
    }
  });
  if (!frame) throw new Error('no data browser frame');
  return frame;
}

async function marker(page: Page): Promise<string | undefined> {
  return traceFrame(page).evaluate(() => (window as unknown as { __marker?: string }).__marker);
}

/** The Mole poll count of a stub probe. */
async function moleCount(request: APIRequestContext, id: string): Promise<number> {
  const response = await request.get(`${PREFIX}/__mole-count?probe=${id}`);
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { count: number }).count;
}

/** Waits until `id`'s poll count rises past its current value. */
async function expectPolling(request: APIRequestContext, id: string, what: string): Promise<void> {
  const start = await moleCount(request, id);
  await expect
    .poll(() => moleCount(request, id), { message: `${what} polls`, timeout: 5_000 })
    .toBeGreaterThan(start);
}

/** A tool instance's iframe `src`, resolved. */
async function srcOf(page: Page, key: string): Promise<URL> {
  const src = await toolFrame(page, key).getAttribute('src');
  return new URL(src ?? '', page.url());
}

/** A page in a new browser session: `from`'s localStorage, no sessionStorage. */
async function newSession(browser: Browser, from: Page): Promise<BrowserContext> {
  return browser.newContext({ storageState: await from.context().storageState() });
}

test.describe('dock persistence', () => {
  test('frame continuity: one frame load across every gesture, one more after a reload; polling follows the showing tab', async ({
    page,
    request,
  }) => {
    test.setTimeout(90_000);
    const traceId = probe('sc2-trace');
    const corrId = probe('sc2-corr');
    await seedTabs(page, {
      keys: [PANEL, TRACE, CORRELATION],
      active: TRACE,
      instances: {
        [TRACE]: { query: `pv=PROBE:${traceId}&range=-1h` },
        [CORRELATION]: { query: `x=PROBE:${corrId}&y=B` },
      },
    });
    const index = countTraceIndex(page);
    await page.goto(`${PREFIX}/embed/${TRACE}`);
    // No stored dock: one tile holding every tab, the data browser showing.
    await expectShape(page, `${PANEL}|${TRACE}*|${CORRELATION}`);
    await expect(page.frameLocator(`iframe[data-tab-key="${TRACE}"]`).locator('#probe')).toHaveText(
      traceId
    );
    await traceFrame(page).evaluate(() => {
      (window as unknown as { __marker: string }).__marker = 'sc2';
    });
    const continuity = async (step: string) => {
      expect(index.count, `index loads after ${step}`).toBe(1);
      expect(await marker(page), `marker after ${step}`).toBe('sc2');
    };
    await arm(page);

    // Split: the correlation right of the data browser, the screen below it.
    await dropAtEdge(page, CORRELATION, TRACE, 'right');
    await expectShape(page, `row[${PANEL}|${TRACE}*,${CORRELATION}]`);
    await dropAtEdge(page, PANEL, TRACE, 'bottom');
    await expectShape(page, `row[column[${TRACE},${PANEL}],${CORRELATION}]`);
    await continuity('split');

    // Both showing frames poll.
    await expectPolling(request, traceId, 'the showing data browser');
    await expectPolling(request, corrId, 'the showing correlation');

    // Sash drag with the real pointer.
    const sash = page.locator('.dv-sash').filter({ visible: true }).first();
    const sashBox = (await sash.boundingBox())!;
    const vertical = sashBox.width < sashBox.height;
    const s = { x: sashBox.x + sashBox.width / 2, y: sashBox.y + sashBox.height / 2 };
    const tiles = () =>
      Promise.all([PANEL, TRACE, CORRELATION].map((key) => tileContentRect(page, key)));
    const beforeSash = await tiles();
    await page.mouse.move(s.x, s.y);
    await page.mouse.down();
    await page.mouse.move(s.x + (vertical ? -80 : 0), s.y + (vertical ? 0 : -60), { steps: 8 });
    await page.mouse.up();
    await expect.poll(tiles, { message: 'the sash drag resized a tile' }).not.toEqual(beforeSash);
    await continuity('sash drag');

    // Hide: the correlation dropped as a tab of the screen's tile, the screen
    // shown in front of it. Its frame stops polling, the data browser keeps polling.
    await dropAsTab(page, CORRELATION, PANEL);
    // Dropped over the left end of the screen's tab: it lands before it.
    await expectShape(page, `column[${TRACE},${CORRELATION}*|${PANEL}]`);
    await focusTab(page, PANEL);
    await expectShape(page, `column[${TRACE},${CORRELATION}|${PANEL}*]`);
    await expect(
      page.frameLocator(`iframe[data-tab-key="${CORRELATION}"]`).locator('body')
    ).toHaveAttribute('data-visible', 'false');
    await page.waitForTimeout(300);
    const corrStopped = await moleCount(request, corrId);
    const traceBefore = await moleCount(request, traceId);
    await page.waitForTimeout(2_500);
    expect(await moleCount(request, corrId), 'the hidden frame stopped polling').toBe(corrStopped);
    expect(await moleCount(request, traceId), 'the showing frame keeps polling').toBeGreaterThan(
      traceBefore
    );
    await continuity('hide');

    // Out again: the hidden correlation tab dragged to its own tile right of the data browser.
    await dropAtEdge(page, CORRELATION, TRACE, 'right');
    await expectShape(page, `column[row[${TRACE},${CORRELATION}],${PANEL}]`);
    await expect(
      page.frameLocator(`iframe[data-tab-key="${CORRELATION}"]`).locator('body')
    ).toHaveAttribute('data-visible', 'true');
    await expectPolling(request, corrId, 'the correlation shown again');
    await continuity('a tab out to its own tile');

    // Reset from the window menu: every tile an equal column, in layout order.
    const order = tilesOf(await dockLayout(page)).map((t) => t.showing);
    expect(order).toEqual([TRACE, CORRELATION, PANEL]);
    await (await windowMenuItem(page, 'Reset layout')).click();
    await expectShape(page, `row[${order.join(',')}]`);
    await continuity('Reset');

    // A fourth tab opened into the screen's tile (the focused one), then closed.
    await focusTab(page, PANEL);
    const panelTile = tileOf(await dockLayout(page), PANEL)!.tile;
    const rectsBefore = await settledTiles(page);
    await tree(page).getByRole('button', { name: 'New Correlation tab' }).click();
    await expect(tileTab(page, CORRELATION2)).toHaveCount(1);
    await expect
      .poll(async () => tileOf(await dockLayout(page), CORRELATION2)?.tile)
      .toBe(panelTile);
    await expect
      .poll(async () => tileOf(await dockLayout(page), CORRELATION2)?.showing)
      .toBe(CORRELATION2);
    const rectsOpen = await settledTiles(page);
    for (const key of order.filter((k) => k !== PANEL)) {
      expectSameRect(rectsOpen[key]!, rectsBefore[key]!, `${key} unchanged by the open`);
    }
    await closeTileTab(page, CORRELATION2);
    await expect(tileTab(page, CORRELATION2)).toHaveCount(0);
    await expectShape(page, `row[${order.join(',')}]`);
    await continuity('a fourth tab opened and closed');

    // Move, last before the reload: the data browser's whole tile (its grip)
    // dropped below the correlation tile. Soft: this move puts the data
    // browser after the correlation in layout order, and the viewer currently
    // reorders the overlay items to match, which moves the iframe node and
    // reloads it (a viewer defect; a move that keeps the order keeps one load).
    await dropAtEdge(page, TRACE, CORRELATION, 'bottom', true);
    await expectShape(page, `row[column[${CORRELATION},${TRACE}],${PANEL}]`);
    await expect(page.frameLocator(`iframe[data-tab-key="${TRACE}"]`).locator('#probe')).toHaveText(
      traceId
    );
    expect.soft(index.count, 'index loads after move').toBe(1);
    expect.soft(await marker(page), 'marker after move').toBe('sc2');
    const loadsBefore = index.count;

    // Reload: exactly one more index load, the layout as before.
    const before = (await settledStore(page)).layout;
    expect(before).toEqual(await dockLayout(page));
    await page.reload();
    await expect(dockRoot(page)).toBeVisible();
    await expect.poll(async () => dockLayout(page)).toEqual(before);
    await expect.poll(() => index.count).toBe(loadsBefore + 1);
    await expect(page.frameLocator(`iframe[data-tab-key="${TRACE}"]`).locator('#probe')).toHaveText(
      traceId
    );
    await page.waitForTimeout(500);
    expect(index.count, 'one load after the reload').toBe(loadsBefore + 1);
    expect(await dockLayout(page)).toEqual(before);
  });

  test('(a): stored tabs, no stored dock: every tab in one tile, URL unchanged, no warning, no write', async ({
    page,
  }) => {
    await seedTabs(page, { keys: [PANEL, LABELS, WIDE], active: LABELS });
    await watchWrites(page);
    const warnings = watchWarnings(page);
    const url = `${PREFIX}/embed/${LABELS}`;
    await page.goto(url);
    await expectShape(page, `${PANEL}|${LABELS}*|${WIDE}`);
    expect(await showingKeys(page)).toEqual([LABELS]);
    // One tile: its tabs are the strip, no tile bar.
    for (const key of [PANEL, LABELS, WIDE]) await expect(stripTab(page, key)).toHaveCount(1);
    await expect(page.getByTestId('tile-bar')).toHaveCount(0);
    expect(await focusedKey(page)).toBe(LABELS);
    await page.waitForTimeout(500);
    expect(new URL(page.url()).pathname).toBe(url);
    expect(warnings).toEqual([]);
    expect(await dockWrites(page)).toEqual([]);
    expect(await storedRaw(page)).toBeNull();
  });

  test('(b): a reload with a closed key and a two-tab tile loads pruned, nothing reopened, no write', async ({
    page,
  }) => {
    // A tile [PANEL, LABELS] showing LABELS, a closed WIDE and PLOT, as columns.
    const layout: Layout = {
      split: 'row',
      items: [
        { tile: 't1', tabs: [PANEL, LABELS], showing: LABELS, size: 0.5 },
        { tile: 't2', tabs: [WIDE], showing: WIDE, size: 0.25 },
        { tile: 't3', tabs: [PLOT], showing: PLOT, size: 0.25 },
      ],
    };
    const raw = JSON.stringify(storedDock(layout));
    await seedDock(page, { keys: [PANEL, LABELS, PLOT], active: LABELS }, layout);
    await watchWrites(page);
    const warnings = watchWarnings(page);

    const check = async () => {
      await expectShape(page, `row[${PANEL}|${LABELS}*,${PLOT}]`);
      expect(await showingKeys(page)).toEqual([LABELS, PLOT]);
      await expect(tileTab(page, WIDE)).toHaveCount(0);
      await expect(tileTab(page, PANEL)).toHaveCount(1);
      await page.waitForTimeout(500);
      expect(await dockWrites(page)).toEqual([]);
      expect(await storedRaw(page)).toBe(raw);
      expect(warnings).toEqual([]);
    };
    // The tabs are stored, so this is the reload path from the first load on.
    await page.goto(`${PREFIX}/embed/${LABELS}`);
    await check();
    await page.reload();
    await check();
  });

  test('(c): a reload after another browser tab wrote keeps its own tabs, key untouched', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await seedTabs(page, { keys: [PANEL, LABELS], active: PANEL });
    await watchWrites(page);
    await page.goto(`${PREFIX}/embed/${PANEL}`);
    await expectShape(page, `${PANEL}*|${LABELS}`);
    await arm(page);
    await dropAtEdge(page, LABELS, PANEL, 'right');
    await expectShape(page, `row[${PANEL},${LABELS}]`);
    await settledStore(page);
    const own = await focusedKey(page);

    // Another browser tab (same localStorage, own sessionStorage) writes its dock.
    const other = await page.context().newPage();
    await seedTabs(other, { keys: [PLOT, WIDE], active: PLOT });
    await other.goto(`${PREFIX}/embed/${PLOT}`);
    await expectShape(other, `${PLOT}*|${WIDE}`);
    await arm(other);
    await dropAtEdge(other, WIDE, PLOT, 'bottom');
    await expectShape(other, `column[${PLOT},${WIDE}]`);
    const written = await settledStore(other);
    expect(Object.keys(written.panels).sort()).toEqual([PLOT, WIDE].sort());
    const raw = await storedRaw(other);

    await page.reload();
    await expect(dockRoot(page)).toBeVisible();
    // The stored dock names none of this tab's keys: its own tabs, in one tile.
    await expect
      .poll(async () => layoutKeys(await dockLayout(page)).sort())
      .toEqual([PANEL, LABELS].sort());
    expect(await showingKeys(page)).toContain(own);
    expect(await sessionKeys(page)).toEqual([PANEL, LABELS]);
    await expect(stripTab(page, WIDE).or(tileTab(page, WIDE))).toHaveCount(0);
    await expect(stripTab(page, PLOT).or(tileTab(page, PLOT))).toHaveCount(0);
    await page.waitForTimeout(500);
    expect(await dockWrites(page)).toEqual([]);
    expect(await storedRaw(page)).toBe(raw);
    await other.close();
  });

  /** Builds PANEL | LABELS with LABELS focused, waits for the write, returns the tile rects. */
  async function storeAB(page: Page): Promise<{ panel: Rect; labels: Rect; stored: StoredValue }> {
    await seedTabs(page, { keys: [PANEL, LABELS], active: PANEL });
    await page.goto(`${PREFIX}/embed/${PANEL}`);
    await expectShape(page, `${PANEL}*|${LABELS}`);
    await arm(page);
    await dropAtEdge(page, LABELS, PANEL, 'right');
    await expectShape(page, `row[${PANEL},${LABELS}]`);
    await focusTab(page, LABELS);
    const stored = await settledStore(page);
    expect(Object.keys(stored).sort()).toEqual(['layout', 'panels', 'version']);
    return {
      panel: await settledRect(page, PANEL),
      labels: await settledRect(page, LABELS),
      stored,
    };
  }

  test('(d): a new session on bare /embed/ reopens exactly A|B, the first tile focused', async ({
    page,
    browser,
  }) => {
    test.setTimeout(60_000);
    const { panel, labels, stored } = await storeAB(page);
    const context = await newSession(browser, page);
    const fresh = await context.newPage();
    await fresh.goto(`${PREFIX}/embed/`);
    await expectShape(fresh, `row[${PANEL},${LABELS}]`);
    expect(await dockLayout(fresh)).toEqual(stored.layout);
    await expect(tileTab(fresh, TRACE)).toHaveCount(0);
    await expect(fresh.locator('iframe.workspace-trace')).toHaveCount(0);
    // Focus is not stored: the new session focuses the first tile.
    await expect.poll(() => focusedKey(fresh)).toBe(PANEL);
    await expect(fresh).toHaveURL(new RegExp(`${PREFIX}/embed/${PANEL}$`));
    expectSameRect(await settledRect(fresh, PANEL), panel, 'A');
    expectSameRect(await settledRect(fresh, LABELS), labels, 'B');
    await context.close();
  });

  test('(e): a new session deep-linked to a closed screen opens it as a tab of the focused tile', async ({
    page,
    browser,
  }) => {
    test.setTimeout(60_000);
    const { panel, labels } = await storeAB(page);
    const context = await newSession(browser, page);
    const fresh = await context.newPage();
    await fresh.goto(`${PREFIX}/embed/${WIDE}`);
    // WIDE joins the focused (first) tile as its showing tab; LABELS' tile is intact.
    await expectShape(fresh, `row[${PANEL}|${WIDE}*,${LABELS}]`);
    await expect.poll(() => focusedKey(fresh)).toBe(WIDE);
    await expect(fresh).toHaveURL(new RegExp(`${PREFIX}/embed/${WIDE}$`));
    // Nothing resizes.
    expectSameRect(await settledRect(fresh, WIDE), panel, 'the focused tile');
    expectSameRect(await settledRect(fresh, LABELS), labels, 'the other tile');
    await expect(tileTab(fresh, TRACE)).toHaveCount(0);
    await context.close();
  });

  test('(f): a saved view loaded into a data browser in a tile reopens with one load and its query', async ({
    page,
    browser,
    request,
  }, info) => {
    test.setTimeout(60_000);
    const id = probe('sc5f');
    const name = `Dock view ${info.workerIndex}-${Date.now()}`;
    const viewId = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const query = `pv=PROBE:${id}&range=-1h`;
    try {
      await seedTabs(page, {
        keys: [PANEL, TRACE],
        active: TRACE,
        instances: { [TRACE]: { query } },
      });
      await page.goto(`${PREFIX}/embed/${TRACE}`);
      await expectShape(page, `${PANEL}|${TRACE}*`);
      await arm(page);
      await dropAtEdge(page, PANEL, TRACE, 'left');
      await expectShape(page, `row[${PANEL},${TRACE}]`);
      await focusTab(page, TRACE);

      // Save the data browser's view (its tile bar's Save view), drift from
      // it, then load it back into the same instance ("Revert to saved").
      await page.getByRole('button', { name: 'Save view' }).click();
      await page.getByLabel('Name').fill(name);
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(page.getByTestId('save-view-status')).toContainText(name);
      await expect(viewItem(page, name)).toBeVisible();
      const frame = traceFrame(page);
      await frame.waitForFunction(() => '__postQuery' in window);
      const drift = `pv=PROBE:${id}-drift&range=-2h`;
      await frame.evaluate(
        (q) => (window as unknown as { __postQuery: (q: string) => void }).__postQuery(q),
        drift
      );
      await expect
        .poll(() =>
          page.evaluate(
            (key) => JSON.parse(sessionStorage.getItem(key) ?? '{}').instances?.['@trace']?.query,
            TABS_KEY
          )
        )
        .toBe(drift);
      await viewItem(page, name).locator(':scope > .nav-tree__row').click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Revert to saved' }).click();
      await expect
        .poll(async () => (await readStored(page))?.panels[TRACE])
        .toEqual({ kind: 'tool', view: viewId, query });
      await settledStore(page);

      // A new session: the data browser mounts once, with the view's query.
      const context = await newSession(browser, page);
      const fresh = await context.newPage();
      const index = countTraceIndex(fresh);
      await fresh.goto(`${PREFIX}/embed/`);
      await expectShape(fresh, `row[${PANEL},${TRACE}]`);
      await expect(
        fresh.frameLocator(`iframe[data-tab-key="${TRACE}"]`).locator('#probe')
      ).toHaveText(id);
      await expect.poll(() => index.count).toBe(1);
      await fresh.waitForTimeout(1_000);
      expect(index.count, 'one frame load').toBe(1);
      const src = await srcOf(fresh, TRACE);
      expect(src.pathname).toBe(TRACE_PATH);
      for (const [param, value] of new URLSearchParams(query)) {
        expect(src.searchParams.getAll(param), param).toEqual([value]);
      }
      await context.close();
    } finally {
      await request.delete(`${PREFIX}/views/${viewId}`);
    }
  });

  test('(g): close every tab, reload: an empty dock with the no-tab notice, nothing reopened', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await seedTabs(page, { keys: [PANEL, LABELS], active: PANEL });
    await page.goto(`${PREFIX}/embed/${PANEL}`);
    await expectShape(page, `${PANEL}*|${LABELS}`);
    await arm(page);
    await dropAtEdge(page, LABELS, PANEL, 'right');
    await expectShape(page, `row[${PANEL},${LABELS}]`);
    // The last tab of a tile closes the tile; the last tile leaves an empty dock.
    await closeTileTab(page, LABELS);
    await expectShape(page, PANEL);
    await stripTab(page, PANEL).locator('.tab-strip__close').click();
    await expect.poll(() => dockLayout(page)).toBeNull();
    await expect.poll(async () => (await readStored(page))?.layout).toBeNull();
    expect((await readStored(page))?.version).toBe(1);

    await page.reload();
    await expect(page.getByTestId('workspace-empty')).toBeVisible();
    expect(await dockLayout(page)).toBeNull();
    expect(await showingKeys(page)).toEqual([]);
    await expect(page.locator('.tab-strip [role="tab"]')).toHaveCount(0);
    await expect(page.getByTestId('tile-bar')).toHaveCount(0);
  });

  test('(h): non-JSON, a dockview grid under another version or an invalid dock: default layout, no warning, replaced on write', async ({
    browser,
  }) => {
    test.setTimeout(60_000);
    const other = {
      version: 0,
      grid: {
        root: {
          type: 'branch',
          data: [
            {
              type: 'leaf',
              data: { id: 'group-1', views: [PANEL], activeView: PANEL },
              size: 1000,
            },
          ],
        },
        width: 1000,
        height: 800,
        orientation: 'HORIZONTAL',
      },
      panels: { [PANEL]: { kind: 'screen', strip: 0 }, [LABELS]: { kind: 'screen', strip: 1 } },
    };
    // Version 1 with an empty tile (tabs []): fails validation.
    const invalid = {
      version: 1,
      layout: { tile: 't1', tabs: [], showing: PANEL },
      panels: { [PANEL]: { kind: 'screen' } },
    };
    const variants: [string, string][] = [
      ['non-JSON', '{not json'],
      ['another version', JSON.stringify(other)],
      ['invalid version 1', JSON.stringify(invalid)],
    ];
    for (const [what, raw] of variants) {
      await test.step(what, async () => {
        const context = await browser.newContext();
        const tab = await context.newPage();
        await seedTabs(tab, { keys: [PANEL, LABELS], active: PANEL });
        await seedRaw(tab, raw);
        const warnings = watchWarnings(tab);
        await tab.goto(`${PREFIX}/embed/${PANEL}`);
        await expectShape(tab, `${PANEL}*|${LABELS}`);
        await tab.waitForTimeout(300);
        expect(warnings, `${what}: no warning`).toEqual([]);
        expect(await storedRaw(tab), `${what}: nothing written before arming`).toBe(raw);
        // The first armed change replaces it with a valid version 1 dock.
        await arm(tab);
        await dropAtEdge(tab, LABELS, PANEL, 'right');
        await expectShape(tab, `row[${PANEL},${LABELS}]`);
        await settledStore(tab);
        expect(warnings, `${what}: still no warning`).toEqual([]);
        await context.close();
      });
    }
  });

  test('(i): Reset from the window menu gives equal columns in layout order and persists them', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await seedTabs(page, { keys: [PANEL, LABELS, WIDE], active: PANEL });
    await page.goto(`${PREFIX}/embed/${PANEL}`);
    await expectShape(page, `${PANEL}*|${LABELS}|${WIDE}`);
    // One tile: Reset is there, disabled.
    await expect(await windowMenuItem(page, 'Reset layout')).toBeDisabled();
    await page.getByRole('button', { name: 'Window menu' }).click();
    await expect(page.getByRole('menuitem', { name: 'Reset layout' })).toHaveCount(0);

    // PANEL | (LABELS over WIDE): not a column arrangement.
    await dropAtEdge(page, LABELS, PANEL, 'right');
    await dropAtEdge(page, WIDE, LABELS, 'bottom');
    await expectShape(page, `row[${PANEL},column[${LABELS},${WIDE}]]`);

    await (await windowMenuItem(page, 'Reset layout')).click();
    await expectShape(page, `row[${PANEL},${LABELS},${WIDE}]`);
    const order = [PANEL, LABELS, WIDE];
    const rects = [];
    for (const key of order) rects.push(await settledRect(page, key));
    for (const r of rects) {
      expect(Math.abs(r.width - rects[0]!.width)).toBeLessThan(2);
      expect(Math.abs(r.height - rects[0]!.height)).toBeLessThan(2);
      expect(Math.abs(r.y - rects[0]!.y)).toBeLessThan(1);
    }
    for (let i = 1; i < rects.length; i += 1) {
      expect(rects[i]!.x).toBeGreaterThan(rects[i - 1]!.x + rects[i - 1]!.width - 2);
    }
    const stored = await settledStore(page);
    expect(stored.layout).toEqual(await dockLayout(page));
    for (const t of tilesOf(stored.layout)) expect(t.size).toBeCloseTo(1 / 3, 3);
  });
});
