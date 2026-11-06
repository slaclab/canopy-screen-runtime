// The dock drop zones with the real pointer: Chromium's own HTML5 drag, raised by
// Playwright's mouse (down, moves, up), never a synthetic event. Pinned here:
//
// - in a two-tile and a three-tile layout, a drop on each edge of a tile and on its
//   centre lands exactly where the highlight was (within 2 px), the source a tab
//   out of a multi-tab tile, so its own tile stays;
// - an edge band is 31 % of the tile's content deep (at least 80 px): a point just
//   inside it is the edge, one just past it the centre;
// - the 48 px dock-edge strips (the dock's bottom, and just under a top-row header)
//   paint and land a new full-width tile of a third of the dock; the header above
//   the top strip still adds a tab, and 1 px past the strip is the tile's edge;
// - a whole tile dropped on its neighbour's edge lands holding the highlight (its
//   own space goes to that neighbour first);
// - the toolbar beside a tile's tabs adds a tab;
// - a drag that leaves the dock (into the sidebar) leaves no highlight behind.
//
// The highlight is read once it has stopped gliding between zones (0.25 s).

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  PREFIX,
  dockLayout,
  dockRoot,
  dropPreview,
  layoutShape,
  seedDock,
  tileRect,
  tileRectOf,
  tilesOf,
} from './dockHelpers.js';
import type { Layout, Point, Preview, Rect, Side } from './dockHelpers.js';

const A = 'drafts/e2e-panel';
const B = 'drafts/label-fit';
const C = 'drafts/wide-panel';
const X = 'drafts/plot-panel';

/** A | B, X a second tab of A's tile. */
const TWO: Layout = {
  split: 'row',
  items: [
    { tile: 't1', tabs: [A, X], showing: A, size: 0.5 },
    { tile: 't2', tabs: [B], showing: B, size: 0.5 },
  ],
};

/** A | (B over C), X a second tab of A's tile. */
const THREE: Layout = {
  split: 'row',
  items: [
    { tile: 't1', tabs: [A, X], showing: A, size: 0.5 },
    {
      split: 'column',
      size: 0.5,
      items: [
        { tile: 't2', tabs: [B], showing: B, size: 0.5 },
        { tile: 't3', tabs: [C], showing: C, size: 0.5 },
      ],
    },
  ],
};

async function open(page: Page, layout: Layout): Promise<void> {
  await page.setViewportSize({ width: 1400, height: 900 });
  const keys = tilesOf(layout).flatMap((t) => t.tabs);
  await seedDock(page, { keys, active: A }, layout);
  await page.goto(`${PREFIX}/embed/${A}`);
  await expect(dockRoot(page)).toBeVisible();
  await expect
    .poll(async () => tilesOf(await dockLayout(page)).length)
    .toBe(tilesOf(layout).length);
  await expect.poll(() => tileRect(page, 't2')).not.toBeNull();
}

/** The centre of `key`'s tab in its tile bar. */
async function tabCentre(page: Page, key: string): Promise<Point> {
  const box = (await page.locator(`.canopy-tile-bar__tab[data-tab-key="${key}"]`).boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** The painted highlight once it holds still (it glides between zones). */
async function restingPreview(page: Page): Promise<Preview | null> {
  let last = JSON.stringify(await dropPreview(page));
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(100);
    const now = JSON.stringify(await dropPreview(page));
    if (now === last) return JSON.parse(now) as Preview | null;
    last = now;
  }
  throw new Error('the highlight never held still');
}

/** Presses at `from`, moves the real pointer to `to` and holds there; returns the highlight. */
async function hold(page: Page, from: Point, to: Point): Promise<Preview | null> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 20, from.y + 30, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 12 });
  return restingPreview(page);
}

/**
 * Moves the held pointer to `to`, then 1 px along x: Chromium dispatches a drag move's
 * dragover only with the next input event, so the nudge makes `to` (not the step before it)
 * the point the dock last saw. Keep `to` clear of a vertical zone boundary by 1 px.
 */
async function moveHeld(page: Page, to: Point): Promise<Preview | null> {
  await page.mouse.move(to.x, to.y, { steps: 3 });
  await page.mouse.move(to.x + 1, to.y);
  return restingPreview(page);
}

/** The content of tile `tile` (its rect below the header row). */
async function contentOf(page: Page, tile: string): Promise<Rect> {
  const rect = (await tileRect(page, tile))!;
  const header = (await page
    .locator(
      `.dv-groupview:has([data-testid="tile-bar"][data-tile="${tile}"]) .dv-tabs-and-actions-container`
    )
    .boundingBox())!;
  const top = header.y + header.height;
  return { x: rect.x, y: top, width: rect.width, height: rect.y + rect.height - top };
}

/** A point `depth` (a share of the content) inside `side` of `content`, centred along it. */
function inEdge(content: Rect, side: Side, depth = 0.2): Point {
  const cx = content.x + content.width / 2;
  const cy = content.y + content.height / 2;
  switch (side) {
    case 'left':
      return { x: content.x + content.width * depth, y: cy };
    case 'right':
      return { x: content.x + content.width * (1 - depth), y: cy };
    case 'top':
      return { x: cx, y: content.y + content.height * depth };
    case 'bottom':
      return { x: cx, y: content.y + content.height * (1 - depth) };
  }
}

function expectSameRect(actual: Rect | null, expected: Rect | null, what: string, eps = 2): void {
  expect(actual, `${what}: actual`).not.toBeNull();
  expect(expected, `${what}: expected`).not.toBeNull();
  for (const k of ['x', 'y', 'width', 'height'] as const)
    expect(
      Math.abs(actual![k] - expected![k]),
      `${what}: ${k} ${actual![k]} vs ${expected![k]}`
    ).toBeLessThanOrEqual(eps);
}

function contains(outer: Rect, inner: Rect, eps = 2): boolean {
  return (
    inner.x >= outer.x - eps &&
    inner.y >= outer.y - eps &&
    inner.x + inner.width <= outer.x + outer.width + eps &&
    inner.y + inner.height <= outer.y + outer.height + eps
  );
}

const SHAPES: Record<'two' | 'three', Record<Side | 'centre', string>> = {
  two: {
    left: `row[${A},${X},${B}]`,
    right: `row[${A},${B},${X}]`,
    top: `row[${A},column[${X},${B}]]`,
    bottom: `row[${A},column[${B},${X}]]`,
    centre: `row[${A},${B}|${X}*]`,
  },
  three: {
    left: `row[${A},column[row[${X},${B}],${C}]]`,
    right: `row[${A},column[row[${B},${X}],${C}]]`,
    top: `row[${A},column[${X},${B},${C}]]`,
    bottom: `row[${A},column[${B},${X},${C}]]`,
    centre: `row[${A},column[${B}|${X}*,${C}]]`,
  },
};

for (const [name, layout] of [
  ['two', TWO],
  ['three', THREE],
] as const) {
  test.describe(`a ${name}-tile layout, the real pointer`, () => {
    for (const zone of ['bottom', 'top', 'left', 'right', 'centre'] as const) {
      test(`a tab dropped on ${zone === 'centre' ? 'the centre' : `the ${zone} edge`} of B lands where the highlight was`, async ({
        page,
      }) => {
        await open(page, layout);
        const content = await contentOf(page, 't2');
        const tile = (await tileRect(page, 't2'))!;
        const to =
          zone === 'centre'
            ? { x: content.x + content.width / 2, y: content.y + content.height / 2 }
            : inEdge(content, zone);
        const lit = await hold(page, await tabCentre(page, X), to);
        expect(lit?.kind, 'highlight kind').toBe(zone === 'centre' ? 'tab' : 'split');
        expect(contains(tile, lit!.rect), 'the highlight sits on the hovered tile').toBe(true);
        await page.mouse.up();
        await expect.poll(async () => layoutShape(await dockLayout(page))).toBe(SHAPES[name][zone]);
        await expect.poll(() => dropPreview(page), 'no highlight left behind').toBeNull();
        await page.waitForTimeout(300);
        expectSameRect(lit!.rect, await tileRectOf(page, X), `${zone}: landed vs highlighted`);
      });
    }
  });
}

test.describe('the dock zones, the real pointer', () => {
  test('an edge band is 31 % of the content: just inside it is the edge, past it the centre', async ({
    page,
  }) => {
    await open(page, TWO);
    const content = await contentOf(page, 't2');
    const band = content.height * 0.31;
    expect(band).toBeGreaterThan(80);
    const from = await tabCentre(page, X);
    const x = content.x + content.width / 2;
    const inside = await hold(page, from, { x, y: content.y + content.height - band + 4 });
    expect(inside?.kind).toBe('split');
    expect((await moveHeld(page, { x, y: content.y + content.height - band - 4 }))?.kind).toBe(
      'tab'
    );
    await page.mouse.up();
  });

  test('the bottom strip lands a full-width tile of a third of the dock where it was lit', async ({
    page,
  }) => {
    await open(page, TWO);
    const dock = (await dockRoot(page).boundingBox())!;
    const lit = await hold(page, await tabCentre(page, X), {
      x: dock.x + dock.width * 0.75,
      y: dock.y + dock.height - 20,
    });
    expect(lit?.kind).toBe('strip');
    expectSameRect(
      lit!.rect,
      { x: dock.x, y: dock.y + (dock.height * 2) / 3, width: dock.width, height: dock.height / 3 },
      'the strip highlight is the new third'
    );
    await page.mouse.up();
    await expect
      .poll(async () => layoutShape(await dockLayout(page)))
      .toBe(`column[row[${A},${B}],${X}]`);
    await page.waitForTimeout(300);
    expectSameRect(lit!.rect, await tileRectOf(page, X), 'strip: landed vs highlighted');
  });

  test('the top strip sits under the header row: the header adds a tab, past it is the edge', async ({
    page,
  }) => {
    await open(page, TWO);
    const content = await contentOf(page, 't2');
    const x = content.x + content.width / 2;
    const lit = await hold(page, await tabCentre(page, X), { x, y: content.y + 24 });
    expect(lit?.kind).toBe('strip');
    const dock = (await dockRoot(page).boundingBox())!;
    expectSameRect(
      lit!.rect,
      { x: dock.x, y: dock.y, width: dock.width, height: dock.height / 3 },
      'the top strip highlight is the new top third'
    );
    expect((await moveHeld(page, { x, y: content.y - 4 }))?.kind, 'the header row').toBe('tab');
    expect((await moveHeld(page, { x, y: content.y + 49 }))?.kind, '1 px past the strip').toBe(
      'split'
    );
    expect((await moveHeld(page, { x, y: content.y + 24 }))?.kind).toBe('strip');
    await page.mouse.up();
    await expect
      .poll(async () => layoutShape(await dockLayout(page)))
      .toBe(`column[${X},row[${A},${B}]]`);
    await page.waitForTimeout(300);
    expectSameRect(lit!.rect, await tileRectOf(page, X), 'top strip: landed vs highlighted');
  });

  test('a whole tile dropped on its neighbour lands holding the highlight', async ({ page }) => {
    await open(page, TWO);
    const grip = (await page
      .locator('[data-testid="tile-bar"][data-tile="t2"] .canopy-tile-bar__grip')
      .boundingBox())!;
    const content = await contentOf(page, 't1');
    const lit = await hold(
      page,
      { x: grip.x + grip.width / 2, y: grip.y + grip.height / 2 },
      inEdge(content, 'bottom')
    );
    expect(lit?.kind).toBe('split');
    await page.mouse.up();
    await expect
      .poll(async () => layoutShape(await dockLayout(page)))
      .toBe(`column[${A}*|${X},${B}]`);
    await page.waitForTimeout(300);
    const landed = (await tileRectOf(page, B))!;
    expect(contains(landed, lit!.rect), JSON.stringify([landed, lit!.rect])).toBe(true);
  });

  test('the toolbar beside the tabs adds a tab', async ({ page }) => {
    await open(page, TWO);
    const header = (await page
      .locator(
        '.dv-groupview:has([data-testid="tile-bar"][data-tile="t2"]) .dv-tabs-and-actions-container'
      )
      .boundingBox())!;
    const lit = await hold(page, await tabCentre(page, X), {
      x: header.x + header.width - 80,
      y: header.y + header.height / 2,
    });
    expect(lit?.kind).toBe('tab');
    await page.mouse.up();
    await expect.poll(async () => layoutShape(await dockLayout(page))).toBe(`row[${A},${B}|${X}*]`);
  });

  test('a drag that leaves the dock leaves no highlight behind', async ({ page }) => {
    await open(page, TWO);
    const content = await contentOf(page, 't2');
    const lit = await hold(page, await tabCentre(page, X), inEdge(content, 'bottom'));
    expect(lit).not.toBeNull();
    const dock = (await dockRoot(page).boundingBox())!;
    await page.mouse.move(dock.x - 60, dock.y + dock.height / 2, { steps: 8 });
    await expect.poll(() => dropPreview(page)).toBeNull();
    await page.mouse.up();
    expect(layoutShape(await dockLayout(page))).toBe(`row[${A}*|${X},${B}]`);
  });
});
