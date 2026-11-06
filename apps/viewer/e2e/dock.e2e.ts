// Acceptance for the dock mechanic in the model of tiles with tabs, one test per criterion, each asserting what its criterion
// states:
//
// - tiles: three tabs of one tile, two edge drops, three tiles big enough to use;
//   a drag of a tab from one tile to another is a move (one tab, one content
//   element, never remounted).
// - self-drops (a sole tab or a whole tile onto its own centre, edge, bar
//   or the split line beside it) paint no highlight and leave the layout JSON identical; a
//   Shift+drag floats no tile; a centre drop from another tile adds a tab.
// - closing: a tile's last tab × closes the tab and the tile, the way back
//   (Cmd/Ctrl+Shift+T) restores it, focus-only clicks, a tab × shows its
//   neighbour, the bar's width under hover, focus through the data-browser
//   frame, the plot target after closing a focused data browser, and the
//   keyboard path.
// - the drag shield (every overlay element `pointer-events: none` while a
//   tab drag is live, the placeholder under the pointer), edge drops over the
//   data browser and over a screen, and the drop highlight itself.
//
// Drags go through dockHelpers' synthetic sequence (dragstart, repeated
// dragover, drop/dragleave, dragend); a Shift+drag uses the real pointer. The
// showing keys and the layout JSON come only from the dock root's test surface.

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  PREFIX,
  TABS_KEY,
  centrePoint,
  dockLayout,
  dockRoot,
  dropPreview,
  edgePoint,
  holdDrag,
  layoutKeys,
  layoutShape,
  moveHeldDrag,
  overlayItem,
  releaseDrag,
  seedDock,
  seedTabs,
  settled,
  showingKeys,
  stripTab,
  tileBar,
  tileContentRect,
  tileOf,
  tileRect,
  tileRectOf,
  tileTab,
  tileTabBar,
  tilesOf,
  type DragFrom,
  type DropEdge,
  type Layout,
  type Point,
  type Preview,
  type Rect,
  closeTileTab,
} from './dockHelpers';
import { WRITABLE_PV, installHareMock, installPvWriteRoute } from './hostFixture';

test.describe.configure({ timeout: 30_000 });

const PANEL = 'drafts/e2e-panel';
const LABELS = 'drafts/label-fit';
const WIDE = 'drafts/wide-panel';
const PLOT = 'drafts/plot-panel';
const BUTTON = 'drafts/write-button';
const TRACE = '@trace';
const TRACE2 = '@trace/2';
const TRACE3 = '@trace/3';
const CORRELATION = '@correlation';

const tree = (page: Page) => page.getByRole('navigation', { name: 'Screens' });
const overlay = (page: Page) => page.locator('.canopy-dock-overlay');

/** Rect equality to within `eps` px. */
function expectSameRect(actual: Rect | null, expected: Rect | null, what: string, eps = 1.5): void {
  expect(actual, `${what}: actual rect`).not.toBeNull();
  expect(expected, `${what}: expected rect`).not.toBeNull();
  for (const side of ['x', 'y', 'width', 'height'] as const) {
    expect(
      Math.abs(actual![side] - expected![side]),
      `${what}: ${side} ${actual![side]} vs ${expected![side]}`
    ).toBeLessThanOrEqual(eps);
  }
}

/** `inner` lies within `outer`, to a pixel. */
function inside(inner: Rect | null, outer: Rect | null): boolean {
  if (!inner || !outer) return false;
  return (
    inner.x >= outer.x - 1 &&
    inner.y >= outer.y - 1 &&
    inner.x + inner.width <= outer.x + outer.width + 1 &&
    inner.y + inner.height <= outer.y + outer.height + 1
  );
}

/** The overlay element's viewport rect. */
async function overlayRect(page: Page, key: string): Promise<Rect | null> {
  return overlayItem(page, key).boundingBox();
}

/** The open keys in strip order (one tile only: with two or more there is no strip). */
async function stripKeys(page: Page): Promise<string[]> {
  return page
    .locator('.tab-strip [role="tab"]')
    .evaluateAll((tabs) => tabs.map((t) => t.getAttribute('data-tab-key') ?? ''));
}

/** The stored tabs record, as the reducer persists it. */
async function storedTabs(
  page: Page
): Promise<{ keys: string[]; active: string | null; toolMru: string[] }> {
  return page.evaluate((k) => {
    const raw = JSON.parse(sessionStorage.getItem(k) ?? 'null') ?? {};
    return { keys: raw.keys ?? [], active: raw.active ?? null, toolMru: raw.toolMru ?? [] };
  }, TABS_KEY);
}

/** The focused tab: the stored active key. */
async function activeKey(page: Page): Promise<string | null> {
  return (await storedTabs(page)).active;
}

/** The stored toolMru (newest first). */
async function storedToolMru(page: Page): Promise<string[]> {
  return (await storedTabs(page)).toolMru;
}

/** Waits until the tiles show exactly `keys` (any order), each placed over its tile. */
async function expectShowing(page: Page, keys: string[]): Promise<void> {
  await expect.poll(async () => [...(await showingKeys(page))].sort()).toEqual([...keys].sort());
  for (const key of keys) {
    await expect(overlayItem(page, key)).toHaveAttribute('data-placed', 'true');
  }
}

/** Waits until the layout's shape is `shape` and no drag is live. */
async function shapeIs(page: Page, shape: string): Promise<void> {
  await expect.poll(async () => layoutShape(await dockLayout(page))).toBe(shape);
  await expect(overlay(page)).not.toHaveAttribute('data-dragging', 'true');
}

/** `key`'s content rect once it holds still across two animation frames. */
async function settledRect(page: Page, key: string): Promise<Rect> {
  await expect
    .poll(() => tileContentRect(page, key), { message: `${key} is placed` })
    .not.toBeNull();
  const r = await settled(page, () => tileContentRect(page, key));
  expect(r, `${key} is placed`).not.toBeNull();
  return r!;
}

/** A drag of `key`'s tab: its strip tab with one tile, its tile-bar tab with more. */
async function tabSource(page: Page, key: string): Promise<DragFrom> {
  return (await stripTab(page, key).count()) > 0 ? { from: 'strip', key } : { from: 'tab', key };
}

/**
 * Clicks `key`'s tile-bar tab near its left end: in a narrow tile the showing
 * screen's header controls squeeze the tab list, so the tab's centre can sit
 * under them while its start stays visible.
 */
async function clickTab(page: Page, key: string): Promise<void> {
  await tileTab(page, key).click({ position: { x: 8, y: 12 } });
}

/** `key`'s whole tile rect (bar and content) once it holds still. */
async function tileBox(page: Page, key: string): Promise<Rect> {
  await settledRect(page, key);
  const r = await settled(page, () => tileRectOf(page, key));
  expect(r, `${key}'s tile`).not.toBeNull();
  return r!;
}

/** The tile id holding `key` now. */
async function tileIdOf(page: Page, key: string): Promise<string> {
  const t = tileOf(await dockLayout(page), key);
  if (!t) throw new Error(`no tile holds ${key}`);
  return t.tile;
}

/** `r`, a rect in the dock at `from`, mapped to the same share of the dock at `to`. */
function inDock(r: Rect, from: Rect, to: Rect): Rect {
  const sx = to.width / from.width;
  const sy = to.height / from.height;
  return {
    x: to.x + (r.x - from.x) * sx,
    y: to.y + (r.y - from.y) * sy,
    width: r.width * sx,
    height: r.height * sy,
  };
}

/** A point in the empty part of tile `tile`'s bar, right of its last tab. */
async function barEnd(page: Page, tile: string): Promise<Point> {
  const bar = (await tileTabBar(page, tile).boundingBox())!;
  const last = await tileTabBar(page, tile).locator('.canopy-tile-bar__tab').last().boundingBox();
  const x = last ? Math.min(last.x + last.width + 20, bar.x + bar.width - 4) : bar.x + 30;
  return { x, y: bar.y + bar.height / 2 };
}

/**
 * Drags `key` (its tab, or with `from: 'tree'` its sidebar row) to `edge` of the
 * tile showing `target`, 30 px inside its content, and drops it there. Asserts
 * the split highlight, painted inside the target's tile, and that it outlines
 * the tile `key` lands in (within 2 px); with `leaves` (`key`'s own tile empties
 * and gives its space to the target first) the landed tile holds the highlight.
 */
async function dropAtEdge(
  page: Page,
  key: string,
  target: string,
  edge: DropEdge,
  from: 'tab' | 'tree' = 'tab',
  { leaves = false }: { leaves?: boolean } = {}
): Promise<Preview> {
  const rect = await settledRect(page, target);
  const targetTile = await tileRectOf(page, target);
  const src: DragFrom = from === 'tree' ? { from: 'tree', key } : await tabSource(page, key);
  const dockBefore = (await dockRoot(page).boundingBox())!;
  const held = await holdDrag(page, src, edgePoint(rect, edge, 64), { budgetMs: 2000 });
  expect(held.preview?.kind, `${edge} split highlight on ${target} for ${key}`).toBe('split');
  expect(
    inside(held.preview!.rect, targetTile),
    `highlight inside ${target}'s tile: ${JSON.stringify([held.preview!.rect, targetTile])}`
  ).toBe(true);
  await releaseDrag(page, 'drop');
  await expect(overlay(page)).not.toHaveAttribute('data-dragging', 'true');
  await expect.poll(async () => (await showingKeys(page)).includes(key)).toBe(true);
  await settledRect(page, key);
  // The highlight outlines the result as a share of the dock. A drop from one
  // tile to two removes the strip row, so the dock itself grows upward by that
  // row (80 px at this viewport) between the highlight and the result: compare
  // in dock-relative shares there, scaled back to pixels of the dock after.
  const dockAfter = (await dockRoot(page).boundingBox())!;
  const lit = inDock(held.preview!.rect, dockBefore, dockAfter);
  const landed = await tileRectOf(page, key);
  if (leaves)
    expect(
      inside(lit, landed),
      `highlight inside the result: ${JSON.stringify([lit, landed])}`
    ).toBe(true);
  else expectSameRect(lit, landed, 'highlight vs result', 2);
  expect(await dropPreview(page), 'no highlight left behind').toBeNull();
  return held.preview!;
}

/** Opens a page seeded with `keys` as the tabs of one tile, `active` showing. */
async function openSeeded(page: Page, keys: string[], active: string): Promise<void> {
  await seedTabs(page, { keys, active });
  await page.goto(`${PREFIX}/embed/${active}`);
  await expectShowing(page, [active]);
  await expect.poll(async () => tilesOf(await dockLayout(page)).length).toBe(1);
  expect([...layoutKeys(await dockLayout(page))].sort()).toEqual([...keys].sort());
}

/** Opens a page on a stored `layout`, `active` focused. */
async function openLayout(page: Page, layout: Layout, active: string): Promise<void> {
  const keys = layoutKeys(layout);
  await seedDock(page, { keys, active }, layout);
  await page.goto(`${PREFIX}/embed/${active}`);
  await expect
    .poll(async () => tilesOf(await dockLayout(page)).length)
    .toBe(tilesOf(layout).length);
  await expectShowing(
    page,
    tilesOf(layout).map((t) => t.showing)
  );
}

test.describe('dock mechanic', () => {
  test('tiles: three tabs of one tile, two edge drops, three usable tiles; a tab drag between tiles is a move', async ({
    page,
  }) => {
    // A screen, then a data browser and a correlation instance: tabs of its tile.
    await page.goto(`${PREFIX}/embed/${PANEL}`);
    await expectShowing(page, [PANEL]);
    await tree(page).getByRole('button', { name: 'New Data Browser tab' }).click();
    await expect(stripTab(page, TRACE)).toHaveCount(1);
    await tree(page).getByRole('button', { name: 'New Correlation tab' }).click();
    await expect(stripTab(page, CORRELATION)).toHaveCount(1);
    expect(await stripKeys(page)).toEqual([PANEL, TRACE, CORRELATION]);
    // Every tab is in the one tile; the last opened is showing.
    await expectShowing(page, [CORRELATION]);
    {
      const tiles = tilesOf(await dockLayout(page));
      expect(tiles).toHaveLength(1);
      expect(tiles[0]!.tabs).toEqual([PANEL, TRACE, CORRELATION]);
      expect(tiles[0]!.showing).toBe(CORRELATION);
    }

    // The data browser to the correlation tile's right edge, then the screen
    // (a hidden tab of the correlation tile) to the data browser's bottom edge.
    await dropAtEdge(page, TRACE, CORRELATION, 'right');
    await shapeIs(page, `row[${PANEL}|${CORRELATION}*,${TRACE}]`);
    // Two tiles: each has its own bar, and there is no strip.
    await expect(page.locator('.tab-strip [role="tab"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="tile-bar"]')).toHaveCount(2);
    await dropAtEdge(page, PANEL, TRACE, 'bottom');
    await shapeIs(page, `row[${CORRELATION},column[${TRACE},${PANEL}]]`);
    await expectShowing(page, [PANEL, TRACE, CORRELATION]);

    for (const key of [PANEL, TRACE, CORRELATION]) {
      const rect = await settledRect(page, key);
      expect(rect.width, `${key} width`).toBeGreaterThan(200);
      expect(rect.height, `${key} height`).toBeGreaterThan(200);
      await expect(tileTab(page, key)).toHaveCount(1);
    }
    const correlation = await tileBox(page, CORRELATION);
    const trace = await tileBox(page, TRACE);
    const panel = await tileBox(page, PANEL);
    expect(trace.x).toBeGreaterThanOrEqual(correlation.x + correlation.width - 1);
    expect(panel.y).toBeGreaterThanOrEqual(trace.y + trace.height - 1);
    // The screen split the data browser's tile: same column, same width.
    expect(Math.abs(panel.x - trace.x)).toBeLessThan(2);
    expect(Math.abs(panel.width - trace.width)).toBeLessThan(2);

    // Mark the data browser's content element, and count every tab of it from here on.
    await overlayItem(page, TRACE).evaluate((el) => {
      (el as unknown as { __mark: boolean }).__mark = true;
      const w = window as unknown as { __traceTabs: number[] };
      w.__traceTabs = [];
      const count = () =>
        w.__traceTabs.push(document.querySelectorAll('[role="tab"][data-tab-key="@trace"]').length);
      new MutationObserver(count).observe(document.body, { childList: true, subtree: true });
    });

    // The data browser's tab to the correlation tile's left edge: a move.
    const held = await holdDrag(
      page,
      { from: 'tab', key: TRACE },
      edgePoint(correlation, 'left', 64),
      { budgetMs: 2000 }
    );
    expect(held.preview?.kind).toBe('split');
    expect(inside(held.preview!.rect, await tileRectOf(page, CORRELATION))).toBe(true);
    // While held, the tab is still where it was.
    expect(tileOf(await dockLayout(page), TRACE)?.tabs).toEqual([TRACE]);
    await releaseDrag(page, 'drop');
    await shapeIs(page, `row[${TRACE},${CORRELATION},${PANEL}]`);
    await expectShowing(page, [PANEL, TRACE, CORRELATION]);
    {
      const t = await tileBox(page, TRACE);
      const c = await tileBox(page, CORRELATION);
      expect(t.x + t.width).toBeLessThanOrEqual(c.x + 1);
    }
    // Still exactly one data browser tab, tile and content element: the same one.
    await expect(tileTab(page, TRACE)).toHaveCount(1);
    await expect(overlayItem(page, TRACE)).toHaveCount(1);
    await expect(page.locator(`iframe[data-tab-key="${TRACE}"]`)).toHaveCount(1);
    expect(
      await overlayItem(page, TRACE).evaluate(
        (el) => (el as unknown as { __mark?: boolean }).__mark
      )
    ).toBe(true);
    const counts = await page.evaluate(
      () => (window as unknown as { __traceTabs: number[] }).__traceTabs
    );
    expect(counts.filter((n) => n !== 1)).toEqual([]);
  });

  test('self-drops: self-drops paint nothing and leave the layout identical; a Shift+drag floats nothing; a centre drop adds a tab', async ({
    page,
  }) => {
    await openSeeded(page, [PANEL, LABELS, WIDE], PANEL);
    await dropAtEdge(page, LABELS, PANEL, 'right');
    await shapeIs(page, `row[${PANEL}*|${WIDE},${LABELS}]`);
    const labelsTile = await tileIdOf(page, LABELS);
    const panelTile = await tileIdOf(page, PANEL);
    const before = await dockLayout(page);
    const labelsRect = await settledRect(page, LABELS);
    const labelsTileRect = (await tileRect(page, labelsTile))!;

    const selfDrop = async (src: DragFrom, point: Point, what: string) => {
      const held = await holdDrag(page, src, point, { budgetMs: 400 });
      expect(held.preview, `${what}: highlight`).toBeNull();
      expect(await dropPreview(page), `${what}: painted`).toBeNull();
      await releaseDrag(page, 'drop');
      await expect(overlay(page)).not.toHaveAttribute('data-dragging', 'true');
      await page.waitForTimeout(100);
      expect(await dockLayout(page), `${what}: layout`).toEqual(before);
    };

    const sole: DragFrom = { from: 'tab', key: LABELS };
    const grip: DragFrom = { from: 'grip', tile: labelsTile };
    const border = { x: labelsTileRect.x, y: labelsTileRect.y + labelsTileRect.height / 2 };
    // A tile's sole tab onto its own centre, edge, bar and the split line at its side.
    await selfDrop(sole, centrePoint(labelsRect), 'sole tab on its own centre');
    await selfDrop(sole, edgePoint(labelsRect, 'bottom', 64), 'sole tab on its own edge');
    await selfDrop(sole, await barEnd(page, labelsTile), 'sole tab on its own bar');
    await selfDrop(sole, border, 'sole tab on its own border');
    // The whole tile, by its grip, onto the same places.
    await selfDrop(grip, centrePoint(labelsRect), 'tile on its own centre');
    await selfDrop(grip, edgePoint(labelsRect, 'bottom', 64), 'tile on its own edge');
    await selfDrop(grip, await barEnd(page, labelsTile), 'tile on its own bar');
    await selfDrop(grip, border, 'tile on its own border');

    // Shift+drag of a tile bar with the real pointer: no floating tile.
    const from = await barEnd(page, labelsTile);
    const to = centrePoint(await settledRect(page, PANEL));
    await page.keyboard.down('Shift');
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x - 40, from.y + 40, { steps: 5 });
    await page.mouse.move(to.x, to.y, { steps: 10 });
    await page.mouse.up();
    await page.keyboard.up('Shift');
    await expect(overlay(page)).not.toHaveAttribute('data-dragging', 'true');
    await page.waitForTimeout(100);
    expect(await dockLayout(page), 'Shift+drag: layout').toEqual(before);
    await expect(page.locator('.dv-resize-container')).toHaveCount(0);
    expect(await dropPreview(page)).toBeNull();

    // A centre drop from another tile is not a self-drop: WIDE becomes a tab of
    // LABELS's tile and is shown there; no tile changes size.
    const panelTileRect = (await tileRect(page, panelTile))!;
    const held = await holdDrag(page, { from: 'tab', key: WIDE }, centrePoint(labelsRect), {
      budgetMs: 2000,
    });
    expect(held.preview?.kind).toBe('tab');
    await releaseDrag(page, 'drop');
    await shapeIs(page, `row[${PANEL},${LABELS}|${WIDE}*]`);
    expect(await tileIdOf(page, WIDE)).toBe(labelsTile);
    await settledRect(page, WIDE);
    expectSameRect(
      await tileRect(page, labelsTile),
      labelsTileRect,
      'target tile kept its size',
      2
    );
    expectSameRect(await tileRect(page, panelTile), panelTileRect, 'other tile kept its size', 2);
  });

  test('closing: tile ×, way back, focus clicks, tab ×, next focus, plot target, keyboard', async ({
    page,
    browser,
  }) => {
    test.setTimeout(90_000);
    /** A page in a fresh context: its own sessionStorage and localStorage. */
    const freshPage = async () => (await browser.newContext()).newPage();

    // --- Three tiles: PANEL | LABELS over WIDE.
    await openSeeded(page, [PANEL, LABELS, WIDE], PANEL);
    await dropAtEdge(page, LABELS, PANEL, 'right');
    await dropAtEdge(page, WIDE, LABELS, 'bottom');
    await shapeIs(page, `row[${PANEL},column[${LABELS},${WIDE}]]`);
    const panelBefore = await settledRect(page, PANEL);
    const labelsBefore = (await tileRectOf(page, LABELS))!;
    const wideBefore = (await tileRectOf(page, WIDE))!;

    // The × of a tile's last tab closes the tab and removes the tile; WIDE, the
    // one neighbour, takes its room; PANEL keeps its size. No tab stays behind.
    await closeTileTab(page, LABELS);
    await shapeIs(page, `row[${PANEL},${WIDE}]`);
    await expect(tileTab(page, LABELS)).toHaveCount(0);
    await expect(overlayItem(page, LABELS)).toHaveCount(0);
    expect((await storedTabs(page)).keys).not.toContain(LABELS);
    await expectShowing(page, [PANEL, WIDE]);
    expectSameRect(await settledRect(page, PANEL), panelBefore, 'PANEL unchanged', 2);
    {
      const wide = (await tileRectOf(page, WIDE))!;
      expect(Math.abs(wide.y - labelsBefore.y)).toBeLessThanOrEqual(2);
      expect(
        Math.abs(wide.y + wide.height - (wideBefore.y + wideBefore.height))
      ).toBeLessThanOrEqual(2);
    }

    // The way back: Cmd/Ctrl+Shift+T reopens it where it was.
    await page.keyboard.press('ControlOrMeta+Shift+T');
    await shapeIs(page, `row[${PANEL},column[${LABELS},${WIDE}]]`);
    await expectShowing(page, [PANEL, LABELS, WIDE]);

    // Clicking the showing tab of an unfocused tile only focuses that tile.
    const beforeFocus = await dockLayout(page);
    const focused = await activeKey(page);
    const other = focused === PANEL ? WIDE : PANEL;
    const otherRect = await settledRect(page, other);
    await clickTab(page, other);
    await expect.poll(() => activeKey(page)).toBe(other);
    await expect(tileTab(page, other)).toHaveAttribute('aria-selected', 'true');
    await expect(tileTabBar(page, await tileIdOf(page, other))).toHaveClass(
      /canopy-tile-bar--focused/
    );
    expect(await dockLayout(page)).toEqual(beforeFocus);
    expectSameRect(await settledRect(page, other), otherRect, 'focused tile');

    // A tab's × closes the tab for good.
    await closeTileTab(page, other);
    await expect(tileTab(page, other)).toHaveCount(0);
    await expect
      .poll(async () => layoutKeys(await dockLayout(page)).sort())
      .toEqual([PANEL, LABELS, WIDE].filter((k) => k !== other).sort());

    // --- One tile, three tabs: the × on the showing tab shows its right
    // neighbour in that tile; the other tab is still a tab of it. Then a bar
    // action's hover keeps the bar unscrolled.
    const one = await freshPage();
    await openSeeded(one, [PANEL, LABELS, WIDE], LABELS);
    const oneRect = await settledRect(one, LABELS);
    await stripTab(one, LABELS).locator('.tab-strip__close').click();
    await expect(stripTab(one, LABELS)).toHaveCount(0);
    await expectShowing(one, [WIDE]);
    await expect(stripTab(one, WIDE)).toHaveAttribute('aria-selected', 'true');
    expect(tilesOf(await dockLayout(one))).toEqual([
      expect.objectContaining({ tabs: [PANEL, WIDE], showing: WIDE }),
    ]);
    expectSameRect(await settledRect(one, WIDE), oneRect, 'right neighbour tile');

    const action = tileBar(one, WIDE).locator('[data-screen-action]').first();
    await expect(action).toBeVisible();
    await action.hover();
    await expect
      .poll(() =>
        one
          .locator('.tab-strip')
          .first()
          .evaluate((bar) => bar.scrollWidth - bar.clientWidth)
      )
      .toBeLessThanOrEqual(0);
    await one.close();

    // --- A click inside the data browser frame focuses its tile, so a sidebar
    // click on a new screen opens it in the data browser's tile, at its size.
    const frame = await freshPage();
    await openSeeded(frame, [PANEL, TRACE, LABELS], PANEL);
    await dropAtEdge(frame, TRACE, PANEL, 'right');
    await shapeIs(frame, `row[${PANEL}*|${LABELS},${TRACE}]`);
    await clickTab(frame, PANEL);
    await expect.poll(() => activeKey(frame)).toBe(PANEL);
    const traceTile = await tileIdOf(frame, TRACE);
    const traceRect = await settledRect(frame, TRACE);
    const traceTileRect = await tileBox(frame, TRACE);
    await expect(frame.locator(`iframe[data-tab-key="${TRACE}"]`)).toBeVisible();
    const inFrame = centrePoint(traceRect);
    await frame.mouse.click(inFrame.x, inFrame.y);
    await expect.poll(() => activeKey(frame)).toBe(TRACE);
    await tree(frame).locator(`[data-screen-key="${WIDE}"] > .nav-tree__row`).click();
    await expect.poll(async () => tileOf(await dockLayout(frame), WIDE)?.tile).toBe(traceTile);
    await expect.poll(async () => tileOf(await dockLayout(frame), WIDE)?.showing).toBe(WIDE);
    expect(tilesOf(await dockLayout(frame))).toHaveLength(2);
    expectSameRect(await tileBox(frame, WIDE), traceTileRect, 'opened in the data browser tile');
    await frame.close();

    // --- Closing the focused of two data browser tiles focuses another and
    // leaves "Plot in Data Browser" on the instance used before the closed one.
    const plot = await freshPage();
    await openLayout(
      plot,
      {
        split: 'row',
        items: [
          {
            split: 'column',
            items: [
              { tile: 'p', tabs: [PLOT], showing: PLOT },
              { tile: 't1', tabs: [TRACE], showing: TRACE },
            ],
          },
          {
            split: 'column',
            items: [
              { tile: 't2', tabs: [TRACE2], showing: TRACE2 },
              { tile: 't3', tabs: [TRACE3], showing: TRACE3 },
            ],
          },
        ],
      },
      TRACE
    );
    // Operator use: TRACE3, then TRACE, then TRACE2, so TRACE is used more
    // recently than TRACE3.
    for (const key of [TRACE3, TRACE, TRACE2]) {
      await clickTab(plot, key);
      await expect.poll(() => activeKey(plot)).toBe(key);
    }
    {
      const mru = await storedToolMru(plot);
      expect(mru[0]).toBe(TRACE2);
      expect(mru.indexOf(TRACE)).toBeLessThan(mru.indexOf(TRACE3));
    }
    // TRACE2's × closes it and its tile; TRACE3 takes the room and the focus.
    await closeTileTab(plot, TRACE2);
    await shapeIs(plot, `row[column[${PLOT},${TRACE}],${TRACE3}]`);
    await expect(tileTab(plot, TRACE2)).toHaveCount(0);
    await expect.poll(() => activeKey(plot)).toBe(TRACE3);
    // The viewer's own next focus did not promote TRACE3.
    await expect.poll(() => storedToolMru(plot)).toEqual([TRACE, TRACE3]);

    // Plot from the screen: the pick lands in TRACE, not in the focused TRACE3.
    const plotBar = tileBar(plot, PLOT);
    await clickTab(plot, PLOT);
    await expect.poll(() => activeKey(plot)).toBe(PLOT);
    // A narrow bar puts its actions in its "More controls" menu, portalled to the body.
    const more = plotBar.getByRole('button', { name: 'More controls' });
    if ((await more.count()) > 0) {
      await more.click();
      const menu = plot.locator(`[id="${await more.getAttribute('aria-controls')}"]`);
      await menu.locator('[data-screen-action="plot-data-browser"]').click();
    } else {
      await plotBar.locator('[data-screen-action="plot-data-browser"]').click();
    }
    const dialog = plot.getByRole('dialog', { name: 'Plot in Data Browser' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: /^Plot \d+ PVs?$/ }).click();
    await expect(dialog).toHaveCount(0);
    await expect
      .poll(async () => {
        const src = await plot.locator(`iframe[data-tab-key="${TRACE}"]`).getAttribute('src');
        return new URL(src ?? '', plot.url()).searchParams.getAll('pv').length;
      })
      .toBeGreaterThan(0);
    const other3 = await plot.locator(`iframe[data-tab-key="${TRACE3}"]`).getAttribute('src');
    expect(new URL(other3 ?? '', plot.url()).searchParams.getAll('pv')).toEqual([]);
    await plot.close();

    // --- Keyboard: Enter on a bar goes into its tile and focuses it, an
    // unhandled Escape returns to the bar, and a button in an unfocused tile
    // activated from the keyboard acts on that tile.
    const keys = await freshPage();
    await installHareMock(keys);
    const writes = await installPvWriteRoute(keys);
    await openLayout(
      keys,
      {
        split: 'row',
        items: [
          { tile: 'a', tabs: [PANEL], showing: PANEL },
          { tile: 'b', tabs: [BUTTON], showing: BUTTON },
        ],
      },
      PANEL
    );
    await clickTab(keys, PANEL);
    await expect.poll(() => activeKey(keys)).toBe(PANEL);

    await tileTabBar(keys, 'b').focus();
    await keys.keyboard.press('Enter');
    await expect
      .poll(() =>
        overlayItem(keys, BUTTON).evaluate((item) => item.contains(document.activeElement))
      )
      .toBe(true);
    await expect.poll(() => activeKey(keys)).toBe(BUTTON);

    await keys.keyboard.press('Escape');
    await expect(tileTabBar(keys, 'b')).toBeFocused();

    await clickTab(keys, PANEL);
    await expect.poll(() => activeKey(keys)).toBe(PANEL);
    const write = overlayItem(keys, BUTTON).getByRole('button', { name: 'Write' });
    await expect(write).toBeVisible();
    await write.focus();
    await keys.keyboard.press('Enter');
    const writeDialog = keys.getByTestId('canopy-write-dialog');
    await expect(writeDialog).toBeVisible();
    await expect(writeDialog).toContainText(WRITABLE_PV);
    await writeDialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(writeDialog).toBeHidden();
    expect(writes.count).toBe(0);
    await keys.close();
  });

  test('the drag shield, edge drops over the data browser and a screen, the highlight', async ({
    page,
  }) => {
    await openSeeded(page, [PANEL, TRACE, LABELS], TRACE);
    await expect(page.locator(`iframe[data-tab-key="${TRACE}"]`)).toBeVisible();

    // An edge drop over the data browser tile splits it.
    await dropAtEdge(page, PANEL, TRACE, 'right');
    await shapeIs(page, `row[${TRACE}*|${LABELS},${PANEL}]`);
    {
      const trace = await tileBox(page, TRACE);
      const panel = await tileBox(page, PANEL);
      expect(panel.x).toBeGreaterThanOrEqual(trace.x + trace.width - 1);
      expect(Math.abs(panel.y - trace.y)).toBeLessThan(2);
    }

    const itemPointerEvents = () =>
      page
        .locator('.canopy-dock-overlay__item')
        .evaluateAll((items) => items.map((el) => getComputedStyle(el).pointerEvents));
    /** What `elementFromPoint` hits at `p`: TRACE's placeholder (its tile's content), its overlay element, or other. */
    const hitAt = (p: Point) =>
      page.evaluate(
        ({ p, key }) => {
          const hit = document.elementFromPoint(p.x, p.y);
          const content = document
            .querySelector(`[data-testid="tile-bar"][data-panel-key="${CSS.escape(key)}"]`)
            ?.closest('.dv-groupview')
            ?.querySelector('.dv-content-container');
          if (hit && content?.contains(hit)) return 'placeholder';
          const item = hit?.closest('.canopy-dock-overlay__item');
          if (item?.getAttribute('data-tab-key') === key) return 'overlay';
          return hit ? `${hit.tagName}.${hit.className}` : 'nothing';
        },
        { p, key: TRACE }
      );
    const traceCentre = centrePoint(await settledRect(page, TRACE));
    expect(await hitAt(traceCentre)).toBe('overlay');

    // A tab drag (the screen's tile-bar tab) held at the data browser tile's bottom edge.
    const held = await holdDrag(
      page,
      { from: 'tab', key: PANEL },
      edgePoint(await settledRect(page, TRACE), 'bottom', 64)
    );
    expect(held.preview?.kind).toBe('split');
    const during = await itemPointerEvents();
    expect(during.length).toBeGreaterThan(0);
    expect(
      during.every((v) => v === 'none'),
      during.join(',')
    ).toBe(true);
    expect(await hitAt(traceCentre)).toBe('placeholder');

    // The highlight: one, attached, visible, inside the target tile, and on
    // top once a test-only style makes it hit-testable.
    expect(held.preview!.count).toBe(1);
    const highlight = await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('.canopy-dock-drop-preview__rect');
      if (!el) return null;
      return {
        attached: el.isConnected,
        visible: el.checkVisibility({ opacityProperty: true, visibilityProperty: true }),
      };
    });
    expect(highlight).not.toBeNull();
    expect(highlight!.attached).toBe(true);
    expect(highlight!.visible).toBe(true);
    // PANEL leaves TRACE's row, so TRACE first takes its room: the highlight is
    // the lower half of that, inside the dock and below TRACE's top.
    {
      const traceTile = (await tileRectOf(page, TRACE))!;
      expect(inside(held.preview!.rect, await dockRoot(page).boundingBox())).toBe(true);
      expect(held.preview!.rect.x).toBeLessThanOrEqual(traceTile.x + 1);
      expect(held.preview!.rect.y).toBeGreaterThan(traceTile.y + traceTile.height / 3);
    }
    // The drop placeholder: a fifth of the accent as fill and a 2 px solid accent edge.
    const look = await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('.canopy-dock-drop-preview__rect')!;
      const cs = getComputedStyle(el.querySelector('.canopy-dock-drop-preview__placeholder')!);
      const probe = document.createElement('span');
      el.parentElement!.appendChild(probe);
      probe.style.color = 'color-mix(in srgb, var(--canopy-accent) 20%, transparent)';
      const fill = getComputedStyle(probe).color;
      probe.style.color = 'var(--canopy-accent)';
      const accent = getComputedStyle(probe).color;
      probe.remove();
      return {
        kind: el.getAttribute('data-kind'),
        background: cs.backgroundColor,
        border: `${cs.borderTopWidth} ${cs.borderTopStyle} ${cs.borderTopColor}`,
        fill,
        accent,
      };
    });
    expect(look.kind).toBe('split');
    expect(look.background).toBe(look.fill);
    expect(look.border).toBe(`2px solid ${look.accent}`);
    const style = await page.addStyleTag({
      content:
        '.canopy-dock-drop-preview, .canopy-dock-drop-preview__rect { pointer-events: auto !important; }',
    });
    const onTop = await page.evaluate((p) => {
      const rect = document.querySelector('.canopy-dock-drop-preview__rect');
      const hit = document.elementFromPoint(p.x, p.y);
      return !!rect && !!hit && (hit === rect || rect.contains(hit));
    }, centrePoint(held.preview!.rect));
    expect(onTop).toBe(true);
    await style.evaluate((el) => el.remove());

    // The drop moves the screen below the data browser, splitting its tile; PANEL's own
    // tile leaves first and gives its space to TRACE, so the result holds the highlight;
    // the shield comes down.
    await releaseDrag(page, 'drop');
    await shapeIs(page, `column[${TRACE}*|${LABELS},${PANEL}]`);
    await expect
      .poll(async () => {
        const t = await tileRectOf(page, TRACE);
        const p = await tileRectOf(page, PANEL);
        return t !== null && p !== null && p.y >= t.y + t.height - 1 && Math.abs(p.x - t.x) < 2;
      })
      .toBe(true);
    await expectShowing(page, [PANEL, TRACE]);
    expect(inside(held.preview!.rect, await tileRectOf(page, PANEL))).toBe(true);
    expect(await dropPreview(page)).toBeNull();
    const after = await itemPointerEvents();
    const placed = await page
      .locator('.canopy-dock-overlay__item')
      .evaluateAll((items) => items.map((el) => el.getAttribute('data-placed')));
    expect(
      after.every((v, i) => v === (placed[i] === 'true' ? 'auto' : 'none')),
      after.join(',')
    ).toBe(true);
    expect(await hitAt(centrePoint(await settledRect(page, TRACE)))).toBe('overlay');

    // An edge drop over a screen tile splits it.
    await dropAtEdge(page, LABELS, PANEL, 'bottom');
    await shapeIs(page, `column[${TRACE},${PANEL},${LABELS}]`);
    await expectShowing(page, [PANEL, TRACE, LABELS]);
    const top = await tileBox(page, PANEL);
    const bottom = await tileBox(page, LABELS);
    expect(bottom.y).toBeGreaterThanOrEqual(top.y + top.height - 1);
    expect(Math.abs(bottom.x - top.x)).toBeLessThan(2);

    // After a sash drag every overlay element sits on its placeholder's content rect.
    // The sash on the boundary between TRACE and PANEL takes the pointer along
    // its whole length, the centre included (where PANEL's bar shows the
    // screen header).
    const traceTileNow = await tileBox(page, TRACE);
    const sashAt = (x: number) =>
      page.evaluate((p) => !!document.elementFromPoint(p.x, p.y)?.closest('.dv-sash'), {
        x,
        y: traceTileNow.y + traceTileNow.height,
      });
    expect
      .soft(
        await sashAt(traceTileNow.x + traceTileNow.width / 2),
        'the sash is hit at its centre (not the tile bar header below it)'
      )
      .toBe(true);
    // The drag itself starts at the sash's left end, over PANEL's tab list.
    expect(await sashAt(traceTileNow.x + 30)).toBe(true);
    const s = { x: traceTileNow.x + 30, y: traceTileNow.y + traceTileNow.height };
    const vertical = false;
    const rectsBefore = await Promise.all(
      [PANEL, TRACE, LABELS].map((key) => tileContentRect(page, key))
    );
    await page.mouse.move(s.x, s.y);
    await page.mouse.down();
    await page.mouse.move(s.x + (vertical ? -80 : 0), s.y + (vertical ? 0 : -60), { steps: 8 });
    await page.mouse.up();
    const rectsAfter = await Promise.all(
      [PANEL, TRACE, LABELS].map((key) => tileContentRect(page, key))
    );
    expect(rectsAfter, 'the sash drag resized a tile').not.toEqual(rectsBefore);
    for (const key of [PANEL, TRACE, LABELS]) {
      await expect
        .poll(
          async () => {
            const a = await overlayRect(page, key);
            const b = await tileContentRect(page, key);
            if (!a || !b) return false;
            return (['x', 'y', 'width', 'height'] as const).every(
              (k) => Math.abs(a[k] - b[k]) < 1.5
            );
          },
          { message: `${key} overlay on its placeholder` }
        )
        .toBe(true);
    }
  });

  test('a drop on the shared edge of two tiles splits the tile under the pointer', async ({
    page,
  }) => {
    await openSeeded(page, [PANEL, TRACE, LABELS], TRACE);
    await dropAtEdge(page, PANEL, TRACE, 'right');
    await shapeIs(page, `row[${TRACE}*|${LABELS},${PANEL}]`);

    // The sash sits on the shared edge; while a drag is live it is the edge of the tile under it.
    const trace = await tileBox(page, TRACE);
    const onSash = { x: trace.x + trace.width - 1, y: trace.y + trace.height / 2 };
    const held = await holdDrag(page, { from: 'tab', key: LABELS }, onSash, { budgetMs: 2000 });
    expect(held.preview?.kind).toBe('split');
    expect(inside(held.preview!.rect, trace)).toBe(true);
    await releaseDrag(page, 'drop');
    await shapeIs(page, `row[${TRACE},${LABELS},${PANEL}]`);
    expectSameRect(held.preview!.rect, await tileRectOf(page, LABELS), 'highlight vs result', 2);
  });

  test('a drag moved from a tile edge into its centre switches the split highlight to the tab highlight', async ({
    page,
  }) => {
    await openSeeded(page, [PANEL, TRACE, LABELS], TRACE);
    await dropAtEdge(page, PANEL, TRACE, 'right');
    await shapeIs(page, `row[${TRACE}*|${LABELS},${PANEL}]`);
    const before = await dockLayout(page);

    const panel = await settledRect(page, PANEL);
    const held = await holdDrag(page, { from: 'tab', key: LABELS }, edgePoint(panel, 'right', 64), {
      budgetMs: 2000,
    });
    expect(held.preview?.kind).toBe('split');
    const atCentre = await moveHeldDrag(page, centrePoint(panel));
    expect(atCentre?.kind).toBe('tab');
    expect(atCentre?.count).toBe(1);
    expect(inside(atCentre!.rect, await tileRectOf(page, PANEL))).toBe(true);
    // Back at the edge the split shows again.
    expect((await moveHeldDrag(page, edgePoint(panel, 'right', 64)))?.kind).toBe('split');
    await releaseDrag(page, 'cancel');
    await expect(overlay(page)).not.toHaveAttribute('data-dragging', 'true');
    await expect.poll(() => dropPreview(page)).toBeNull();
    expect(await dockLayout(page)).toEqual(before);
  });

  test('a screen dragged from the browser onto a tile right edge opens there, in its own tile', async ({
    page,
  }) => {
    await openSeeded(page, [PANEL], PANEL);
    expect(await stripKeys(page)).toEqual([PANEL]);
    await dropAtEdge(page, LABELS, PANEL, 'right', 'tree');
    // A new tile beside the screen (nothing evicted), focused.
    await shapeIs(page, `row[${PANEL},${LABELS}]`);
    await expectShowing(page, [PANEL, LABELS]);
    expect((await storedTabs(page)).keys).toEqual([PANEL, LABELS]);
    await expect.poll(() => activeKey(page)).toBe(LABELS);
    const panel = await tileBox(page, PANEL);
    const labels = await tileBox(page, LABELS);
    expect(labels.x).toBeGreaterThanOrEqual(panel.x + panel.width - 1);
    expect(Math.abs(labels.y - panel.y)).toBeLessThan(2);
    // The source row is dimmed only while the drag is live.
    await expect(
      tree(page).locator(`[data-screen-key="${LABELS}"] > .nav-tree__row`)
    ).not.toHaveClass(/nav-tree__row--dragging/);
  });

  test('a tool entry dragged from the browser onto a tile bottom edge opens its instance there; dragged again it moves', async ({
    page,
  }) => {
    await openSeeded(page, [PANEL], PANEL);
    await dropAtEdge(page, TRACE, PANEL, 'bottom', 'tree');
    await shapeIs(page, `column[${PANEL},${TRACE}]`);
    expect((await storedTabs(page)).keys).toEqual([PANEL, TRACE]);
    await expect(page.locator(`iframe[data-tab-key="${TRACE}"]`)).toBeVisible();
    {
      const panel = await tileBox(page, PANEL);
      const trace = await tileBox(page, TRACE);
      expect(trace.y).toBeGreaterThanOrEqual(panel.y + panel.height - 1);
      expect(Math.abs(trace.x - panel.x)).toBeLessThan(2);
    }
    // The entry's instance rule is the click's: the open instance moves, no second one opens.
    await dropAtEdge(page, TRACE, PANEL, 'right', 'tree', { leaves: true });
    await shapeIs(page, `row[${PANEL},${TRACE}]`);
    expect((await storedTabs(page)).keys).toEqual([PANEL, TRACE]);
    await expect(page.locator(`iframe[data-tab-key="${TRACE}"]`)).toHaveCount(1);
    {
      const panel = await tileBox(page, PANEL);
      const trace = await tileBox(page, TRACE);
      expect(trace.x).toBeGreaterThanOrEqual(panel.x + panel.width - 1);
      expect(Math.abs(trace.y - panel.y)).toBeLessThan(2);
    }
  });
});
