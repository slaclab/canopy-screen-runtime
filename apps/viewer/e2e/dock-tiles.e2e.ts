// The dock of tiles with tabs, end to end against the built viewer: its drop
// rules and its layout.
//
// Every spec starts from a seeded workspace: the open tabs in sessionStorage and
// a version 1 stored dock (storage.ts StoredDock) in localStorage, written once
// before the app runs (dockHelpers seedDock). The usual start is tiles
// A | B | C at 50/30/20 % and a closed item D, opened only by a
// drag from the screen browser. Drags are real HTML5 drags dispatched in the
// page (dockHelpers holdDrag); the layout is read from the dock root's
// `data-layout`, the highlight from the DropPreview rect, a tile's rect from its
// dockview group.
//
// Pinned here:
//   four layout tasks from 50/30/20 (a bottom row, a tab, a half, a 2x2
//   grid); every drop type (centre, tab bar, edge, the split line
//   between two tiles, the dock-edge strip) for every source (tab, tile grip,
//   sidebar row), plus drops on a tab bar, on the toolbar beside the tabs, on
//   the top strip just below a top-row header and on the tile edge past it; a sash resize followed by an edge split; a tile
//   too narrow to halve; the highlight equals the result (+-2 px) when the
//   dragged item's tile stays, and lies inside it when that tile leaves and
//   gives its space away; one drop placeholder, none left behind; a tab
//   dropped between two tabs; a sidebar drag of a sole
//   tab over its own tile paints nothing and changes nothing; a sidebar click
//   and a quick-open land as the showing tab of the focused tile with every
//   tile rect unchanged; input after a drag and after a tab switch; a reload
//   keeps tiles, tabs, showing tab and sizes (also after a resize); a dockview
//   grid under another version opens as the default; close and reopen of a tab, a tile and a group;
//   the split-from neighbour.

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  PREFIX,
  centrePoint,
  closeTileTab,
  dockLayout,
  dockRoot,
  dragTo,
  dropPreview,
  edgePoint,
  holdDrag,
  layoutKeys,
  layoutShape,
  releaseDrag,
  seedDock,
  settled,
  tileRect,
  tileRectOf,
  tileTab,
  tilesOf,
  unreachable,
  type DragFrom,
  type Layout,
  type Preview,
  type Rect,
} from './dockHelpers';

test.describe.configure({ timeout: 45_000 });

const A = 'drafts/e2e-panel';
const B = 'drafts/label-fit';
const C = 'drafts/wide-panel';
const D = 'drafts/plot-panel';

/** The four-task start: A | B | C at 50/30/20 %. */
const ABC: Layout = {
  split: 'row',
  items: [
    { tile: 't1', tabs: [A], showing: A, size: 0.5 },
    { tile: 't2', tabs: [B], showing: B, size: 0.3 },
    { tile: 't3', tabs: [C], showing: C, size: 0.2 },
  ],
};

/** Opens the workspace on `layout` with `keys` open, `active` focused. */
async function open(page: Page, layout: Layout, keys: string[], active: string): Promise<void> {
  await page.setViewportSize({ width: 1400, height: 900 });
  await seedDock(page, { keys, active }, layout);
  await page.goto(`${PREFIX}/embed/${active}`);
  await expect(dockRoot(page)).toBeVisible();
  await expect
    .poll(async () => tilesOf(await dockLayout(page)).length)
    .toBe(tilesOf(layout).length);
  await settledTiles(page);
}

/**
 * Drags the sash at the right of the tile showing `key` so that boundary lands
 * at `x` (a real pointer drag: dockview's sashes take mouse events).
 */
async function dragSash(page: Page, key: string, x: number): Promise<void> {
  const r = (await settledTiles(page))[key]!;
  const from = r.x + r.width;
  const y = r.y + r.height / 2;
  await page.mouse.move(from, y);
  await page.mouse.down();
  await page.mouse.move((from + x) / 2, y, { steps: 3 });
  await page.mouse.move(x, y, { steps: 3 });
  await page.mouse.up();
  await settledTiles(page);
}

/** Lays the row of tiles showing `keys` out at `percent` of the dock's width, by sash drags. */
async function setRowShares(page: Page, keys: string[], percent: number[]): Promise<void> {
  const dock = (await dockRoot(page).boundingBox())!;
  let sum = 0;
  for (let i = 0; i < keys.length - 1; i += 1) {
    sum += percent[i]!;
    await dragSash(page, keys[i]!, dock.x + (dock.width * sum) / 100);
  }
}

/** Opens the four-task start; the stored 50/30/20 is what renders (pinned below). */
async function openABC(page: Page): Promise<void> {
  await open(page, ABC, [A, B, C], A);
  expectShares(await shares(page, [A, B, C], 'width'), [50, 30, 20], 1, 'stored 50/30/20');
}

/** Every tile's rect, keyed by the tile's showing key, once they hold still. */
async function settledTiles(page: Page): Promise<Record<string, Rect>> {
  return settled(page, async () => {
    const layout = await dockLayout(page);
    const out: Record<string, Rect> = {};
    for (const t of tilesOf(layout)) {
      const r = await tileRect(page, t.tile);
      if (r) out[t.showing] = r;
    }
    return out;
  });
}

/** The current layout's shape once the drop has landed. */
async function shapeIs(page: Page, shape: string): Promise<void> {
  await expect.poll(async () => layoutShape(await dockLayout(page))).toBe(shape);
  await expect(page.locator('.canopy-dock-overlay')).not.toHaveAttribute('data-dragging', 'true');
}

/** Widths (or heights) of the tiles holding `keys`, as percentages of their sum. */
async function shares(page: Page, keys: string[], axis: 'width' | 'height'): Promise<number[]> {
  const tiles = await settledTiles(page);
  const sizes = keys.map((k) => tiles[k]![axis]);
  const sum = sizes.reduce((a, b) => a + b, 0);
  return sizes.map((s) => (100 * s) / sum);
}

function expectShares(actual: number[], expected: number[], tolerance: number, what: string) {
  for (const [i, e] of expected.entries()) {
    expect(
      Math.abs(actual[i]! - e),
      `${what}: ${actual.map((n) => n.toFixed(1))}`
    ).toBeLessThanOrEqual(tolerance);
  }
}

/** Rect equality within the 2 px the highlight may differ from the result. */
function expectRect(actual: Rect | null, expected: Rect | null, what: string, eps = 2): void {
  expect(actual, `${what}: actual`).not.toBeNull();
  expect(expected, `${what}: expected`).not.toBeNull();
  for (const side of ['x', 'y', 'width', 'height'] as const) {
    expect(
      Math.abs(actual![side] - expected![side]),
      `${what}: ${side} ${actual![side]} vs ${expected![side]}`
    ).toBeLessThanOrEqual(eps);
  }
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

/** `inner` lies inside `outer`, within the 2 px the highlight may differ by. */
function expectInside(inner: Rect | null, outer: Rect | null, what: string, eps = 2): void {
  expect(inner, `${what}: inner`).not.toBeNull();
  expect(outer, `${what}: outer`).not.toBeNull();
  const [i, o] = [inner!, outer!];
  expect(i.x, `${what}: left`).toBeGreaterThanOrEqual(o.x - eps);
  expect(i.y, `${what}: top`).toBeGreaterThanOrEqual(o.y - eps);
  expect(i.x + i.width, `${what}: right`).toBeLessThanOrEqual(o.x + o.width + eps);
  expect(i.y + i.height, `${what}: bottom`).toBeLessThanOrEqual(o.y + o.height + eps);
}

/**
 * Drops `src` at `point`, then checks the highlight against the tile holding `holder`: the
 * same rect when the dragged item's tile stays (`exact`), else inside it (a tile that leaves
 * gives its space to a neighbour first, which can be the tile it lands in).
 */
async function dropAndMatch(
  page: Page,
  src: DragFrom,
  point: { x: number; y: number },
  kind: Preview['kind'],
  holder: string,
  shape: string,
  exact = true
): Promise<Preview> {
  const preview = await dragTo(page, src, point, kind);
  await shapeIs(page, shape);
  await settledTiles(page);
  const landed = await tileRectOf(page, holder);
  if (exact) expectRect(preview.rect, landed, `${kind} highlight vs result`);
  else expectInside(preview.rect, landed, `${kind} highlight inside the result`);
  expect(await dropPreview(page), 'no highlight left behind').toBeNull();
  return preview;
}

test.describe('the four tasks from 50/30/20', () => {
  test('the start is A | B | C at 50/30/20', async ({ page }) => {
    await openABC(page);
    expect(layoutShape(await dockLayout(page))).toBe(`row[${A},${B},${C}]`);
    expectShares(await shares(page, [A, B, C], 'width'), [50, 30, 20], 1, 'start');
  });

  test('D becomes a full-width bottom row of a third of the height in one drop', async ({
    page,
  }) => {
    await openABC(page);
    const dock = (await dockRoot(page).boundingBox())!;
    const point = { x: dock.x + dock.width / 4, y: dock.y + dock.height - 4 };
    await dropAndMatch(
      page,
      { from: 'tree', key: D },
      point,
      'strip',
      D,
      `column[row[${A},${B},${C}],${D}]`
    );
    const tiles = await settledTiles(page);
    expect(Math.abs(tiles[D]!.width - dock.width)).toBeLessThanOrEqual(2);
    expect(Math.abs(tiles[D]!.height - dock.height / 3)).toBeLessThanOrEqual(
      dock.height * 0.01 + 2
    );
    expectShares(
      await shares(page, [A, B, C], 'width'),
      [50, 30, 20],
      1,
      'A, B, C after the bottom-row drop'
    );
  });

  test('D becomes a tab of B in one drop; all sizes unchanged', async ({ page }) => {
    await openABC(page);
    const before = await settledTiles(page);
    const preview = await dropAndMatch(
      page,
      { from: 'tree', key: D },
      await barEnd(page, 't2'),
      'tab',
      D,
      `row[${A},${B}|${D}*,${C}]`
    );
    expect(preview.marker, 'a tab drop paints its insertion marker').not.toBeNull();
    const after = await settledTiles(page);
    expectRect(after[A]!, before[A]!, 'A unchanged');
    expectRect(after[D]!, before[B]!, 'B (now showing D) unchanged');
    expectRect(after[C]!, before[C]!, 'C unchanged');
  });

  test("A dropped on B's right, by the B|C line, lands as B's right half", async ({ page }) => {
    await openABC(page);
    const tiles = await settledTiles(page);
    const b = tiles[B]!;
    // A leaves first and gives its space to B; B then halves.
    await dropAndMatch(
      page,
      { from: 'grip', tile: 't1' },
      { x: b.x + b.width - 3, y: b.y + b.height / 2 },
      'split',
      A,
      `row[${B},${A},${C}]`,
      false
    );
    expectShares(await shares(page, [B, A, C], 'width'), [40, 40, 20], 1, 'B, A, C');
  });

  test('a 2x2 grid in two drops', async ({ page }) => {
    await openABC(page);
    let tiles = await settledTiles(page);
    await dropAndMatch(
      page,
      { from: 'tree', key: D },
      edgePoint(tiles[A]!, 'bottom', 64),
      'split',
      D,
      `row[column[${A},${D}],${B},${C}]`
    );
    tiles = await settledTiles(page);
    // C is B's neighbour: its space goes to B before B halves, so C lands wider than lit.
    await dropAndMatch(
      page,
      { from: 'tab', key: C },
      edgePoint(tiles[B]!, 'bottom', 64),
      'split',
      C,
      `row[column[${A},${D}],column[${B},${C}]]`,
      false
    );
  });
});

// --- every drop type for every source -----------------------------------------

/** A drag source of the four-task start: C's tile-bar tab, C's whole tile, or D from the sidebar. */
const SOURCES: { name: string; src: DragFrom; item: string; rest: string[] }[] = [
  { name: 'a tab', src: { from: 'tab', key: C }, item: C, rest: [B] },
  { name: 'a tile grip', src: { from: 'grip', tile: 't3' }, item: C, rest: [B] },
  { name: 'a sidebar row', src: { from: 'tree', key: D }, item: D, rest: [B, C] },
];

/** A drop type on A's tile (or the dock), and the layout it gives for `item` with `rest` after A. */
const TYPES: {
  name: string;
  kind: Preview['kind'];
  at: (page: Page) => Promise<{ x: number; y: number }>;
  shape: (item: string, rest: string[]) => string;
}[] = [
  {
    name: 'centre',
    kind: 'tab',
    at: async (page) => centrePoint((await settledTiles(page))[A]!),
    shape: (item, rest) => `row[${A}|${item}*,${rest.join(',')}]`,
  },
  {
    name: 'tab bar',
    kind: 'tab',
    at: (page) => barEnd(page, 't1'),
    shape: (item, rest) => `row[${A}|${item}*,${rest.join(',')}]`,
  },
  {
    name: 'edge',
    kind: 'split',
    at: async (page) => edgePoint((await settledTiles(page))[A]!, 'bottom', 64),
    shape: (item, rest) => `row[column[${A},${item}],${rest.join(',')}]`,
  },
  {
    // On the A|B sash: B's left edge, so the item lands between A and B.
    name: 'the split line (on the sash)',
    kind: 'split',
    at: async (page) => {
      const a = (await settledTiles(page))[A]!;
      return { x: a.x + a.width, y: a.y + a.height / 2 };
    },
    shape: (item, rest) => `row[${A},${item},${rest.join(',')}]`,
  },
  {
    // The dock-edge strip: a full-height tile of a third of the dock, first in the row.
    name: 'the dock side',
    kind: 'strip',
    at: async (page) => {
      const dock = (await dockRoot(page).boundingBox())!;
      return { x: dock.x + 4, y: dock.y + dock.height / 2 };
    },
    shape: (item, rest) => `row[${item},${A},${rest.join(',')}]`,
  },
];

test.describe('every drop type for every source', () => {
  for (const source of SOURCES) {
    for (const type of TYPES) {
      test(`${source.name} dropped on ${type.name}`, async ({ page }) => {
        await openABC(page);
        const point = await type.at(page);
        await dropAndMatch(
          page,
          source.src,
          point,
          type.kind,
          source.item,
          type.shape(source.item, source.rest),
          // C's tile leaves and gives its space to B, which the split line halves.
          source.item === D || !type.name.startsWith('the split line')
        );
      });
    }
  }

  test('just below a top-row header is the top strip: a full-width tile', async ({ page }) => {
    await openABC(page);
    const header = (await page
      .locator(
        '.dv-groupview:has([data-testid="tile-bar"][data-tile="t2"]) .dv-tabs-and-actions-container'
      )
      .boundingBox())!;
    await dropAndMatch(
      page,
      { from: 'tree', key: D },
      { x: header.x + header.width / 2, y: header.y + header.height + 6 },
      'strip',
      D,
      `column[${D},row[${A},${B},${C}]]`
    );
  });

  test("past the top strip is that tile's top edge", async ({ page }) => {
    await openABC(page);
    const header = (await page
      .locator(
        '.dv-groupview:has([data-testid="tile-bar"][data-tile="t2"]) .dv-tabs-and-actions-container'
      )
      .boundingBox())!;
    await dropAndMatch(
      page,
      { from: 'tree', key: D },
      { x: header.x + header.width / 2, y: header.y + header.height + 64 },
      'split',
      D,
      `row[${A},column[${D},${B}],${C}]`
    );
  });

  test('the toolbar beside the tabs adds a tab: the whole header row is one target', async ({
    page,
  }) => {
    await openABC(page);
    const header = (await page
      .locator(
        '.dv-groupview:has([data-testid="tile-bar"][data-tile="t1"]) .dv-tabs-and-actions-container'
      )
      .boundingBox())!;
    await dropAndMatch(
      page,
      { from: 'tree', key: D },
      { x: header.x + header.width - 60, y: header.y + header.height / 2 },
      'tab',
      D,
      `row[${A}|${D}*,${B},${C}]`
    );
  });

  test('a tab dropped between two tabs lands between them', async ({ page }) => {
    const layout: Layout = {
      split: 'row',
      items: [
        { tile: 't1', tabs: [A, D], showing: A },
        { tile: 't2', tabs: [B], showing: B },
      ],
    };
    await open(page, layout, [A, D, B], A);
    const d = (await page.locator(`.canopy-tile-bar__tab[data-tab-key="${D}"]`).boundingBox())!;
    const preview = await dragTo(
      page,
      { from: 'tab', key: B },
      { x: d.x + 4, y: d.y + d.height / 2 },
      'tab'
    );
    expect(preview.marker, 'the insertion marker').not.toBeNull();
    expect(Math.abs(preview.marker!.x - d.x)).toBeLessThanOrEqual(2);
    await expect.poll(async () => tilesOf(await dockLayout(page))[0]?.tabs).toEqual([A, B, D]);
    expect(tilesOf(await dockLayout(page))).toHaveLength(1);
  });
});

// --- the highlight -------------------------------------------------------------

test.describe('the drop highlight', () => {
  test('one drop placeholder on the hovered tile, and none left behind', async ({ page }) => {
    await openABC(page);
    for (const type of TYPES) {
      const point = await type.at(page);
      const held = await holdDrag(page, { from: 'tree', key: D }, point);
      expect(held.preview?.kind, type.name).toBe(type.kind);
      expect(held.preview?.count, 'one highlight at a time').toBe(1);
      const look = await page.locator('.canopy-dock-drop-preview__placeholder').evaluate((el) => {
        const s = getComputedStyle(el);
        return [s.borderTopLeftRadius, s.borderTopWidth, s.borderTopStyle, s.top, s.left].join(' ');
      });
      expect(look, type.name).toBe('8px 2px solid 4px 4px');
      await releaseDrag(page, 'cancel');
      await expect.poll(() => dropPreview(page), 'cancel leaves nothing').toBeNull();
    }
    // Escape mid-drag clears it too, and the layout is unchanged.
    await holdDrag(page, { from: 'tab', key: C }, centrePoint((await settledTiles(page))[A]!));
    expect(await dropPreview(page)).not.toBeNull();
    await page.keyboard.press('Escape');
    await expect.poll(() => dropPreview(page)).toBeNull();
    await releaseDrag(page, 'cancel');
    expect(layoutShape(await dockLayout(page))).toBe(`row[${A},${B},${C}]`);
  });

  test('a sidebar drag of the sole tab of a tile over that tile paints nothing and changes nothing', async ({
    page,
  }) => {
    await openABC(page);
    const before = await dockLayout(page);
    const held = await holdDrag(
      page,
      { from: 'tree', key: B },
      centrePoint((await settledTiles(page))[B]!)
    );
    expect(held.preview).toBeNull();
    await releaseDrag(page, 'drop');
    await page.waitForTimeout(200);
    expect(await dockLayout(page)).toEqual(before);
    expect(await dropPreview(page)).toBeNull();
  });
});

// --- resize, the 40 px floor, infeasible zones ----------------------------------

test.describe('resize and the 40 px floor', () => {
  test('a sash resize reaches the layout, and an edge split after it halves only B', async ({
    page,
  }) => {
    await openABC(page);
    await setRowShares(page, [A, B, C], [30, 40, 30]);
    await expect
      .poll(async () => {
        const items = ((await dockLayout(page)) as { items: { size?: number }[] }).items;
        return items.map((i) => Math.round((i.size ?? 0) * 100));
      })
      .toEqual([30, 40, 30]);
    const b = (await settledTiles(page))[B]!;
    await dropAndMatch(
      page,
      { from: 'tree', key: D },
      edgePoint(b, 'right', 64),
      'split',
      D,
      `row[${A},${B},${D},${C}]`
    );
    expectShares(await shares(page, [A, B, D, C], 'width'), [30, 20, 20, 30], 1, 'B halved');
  });

  test('a sash cannot make a tile narrower than 40 px', async ({ page }) => {
    await openABC(page);
    const dock = (await dockRoot(page).boundingBox())!;
    await dragSash(page, B, dock.x + dock.width - 2);
    const tiles = await settledTiles(page);
    expect(tiles[C]!.width).toBeGreaterThanOrEqual(39);
  });

  test('a tile too narrow to halve has no side zones: its side adds a tab', async ({ page }) => {
    await openABC(page);
    // B (the middle tile, clear of the dock-edge strips) at about 50 px: halving its width
    // would leave 25 px tiles, so its sides are centre.
    const b0 = (await settledTiles(page))[B]!;
    await dragSash(page, A, b0.x + b0.width - 50);
    const b = (await settledTiles(page))[B]!;
    expect(b.width).toBeLessThan(79);
    const before = await settledTiles(page);
    await dropAndMatch(
      page,
      { from: 'tree', key: D },
      edgePoint(b, 'left', 14),
      'tab',
      D,
      `row[${A},${B}|${D}*,${C}]`
    );
    const after = await settledTiles(page);
    expectRect(after[D]!, before[B]!, 'B keeps its rect');
  });
});

// --- opening into the focused tile ---------------------------------------------

test.describe('opening lands in the focused tile', () => {
  const TWO: Layout = {
    split: 'row',
    items: [
      { tile: 't1', tabs: [A], showing: A },
      { tile: 't2', tabs: [B], showing: B },
    ],
  };
  const tree = (page: Page) => page.getByRole('navigation', { name: 'Screens' });

  test('a sidebar click, new and already open, is the showing tab of the focused tile; no tile moves', async ({
    page,
  }) => {
    await open(page, TWO, [A, B], A);
    const before = Object.values(await settledTiles(page));
    // New: it replaces the focused tile's showing tab (a click opens in place).
    await tree(page).locator(`[data-screen-key="${C}"] > .nav-tree__row`).click();
    await expect.poll(async () => tilesOf(await dockLayout(page))[0]?.showing).toBe(C);
    expect(tilesOf(await dockLayout(page))[1]).toMatchObject({ tabs: [B], showing: B });
    // Already open in the other tile: that tile shows it and takes focus; nothing moves.
    await tree(page).locator(`[data-screen-key="${B}"] > .nav-tree__row`).click();
    await expect(page.locator('[data-testid="tile-bar"][data-tile="t2"]')).toHaveClass(
      /canopy-tile-bar--focused/
    );
    expect(layoutKeys(await dockLayout(page)).filter((k) => k === B)).toHaveLength(1);
    const after = Object.values(await settledTiles(page));
    expect(after).toHaveLength(2);
    for (const [i, r] of after.entries()) expectRect(r, before[i]!, `tile ${i}`);
  });

  test('a quick-open, new and already open, is the showing tab of the focused tile; no tile moves', async ({
    page,
  }) => {
    await open(page, TWO, [A, B], A);
    const before = Object.values(await settledTiles(page));
    const quick = async (title: string) => {
      await page.keyboard.press('ControlOrMeta+k');
      const input = page.getByRole('dialog', { name: 'Quick open' }).getByRole('combobox');
      await input
        .or(page.getByRole('dialog', { name: 'Quick open' }).getByRole('textbox'))
        .first()
        .fill(title);
      await page.keyboard.press('Enter');
      await expect(page.getByRole('dialog', { name: 'Quick open' })).toHaveCount(0);
    };
    await quick('Wide');
    await expect.poll(async () => tilesOf(await dockLayout(page))[0]?.showing).toBe(C);
    expect(tilesOf(await dockLayout(page))[1]).toMatchObject({ tabs: [B], showing: B });
    await quick('Label');
    await expect(page.locator('[data-testid="tile-bar"][data-tile="t2"]')).toHaveClass(
      /canopy-tile-bar--focused/
    );
    expect(layoutKeys(await dockLayout(page)).filter((k) => k === B)).toHaveLength(1);
    const after = Object.values(await settledTiles(page));
    expect(after).toHaveLength(2);
    for (const [i, r] of after.entries()) expectRect(r, before[i]!, `tile ${i}`);
  });
});

// --- input after a drag and after a tab switch -------------------------------------

test.describe('input after a drag and a tab switch', () => {
  const NE = 'drafts/numeric-entry-message';
  const TRACE = '@trace';

  test('keys typed right after a drag, and right after a tab switch, reach the focused item', async ({
    page,
  }) => {
    const layout: Layout = {
      split: 'row',
      items: [
        { tile: 't1', tabs: [NE, A], showing: NE },
        { tile: 't2', tabs: [B], showing: B },
      ],
    };
    await open(page, layout, [NE, A, B], NE);
    const field = page.locator(
      `.canopy-dock-overlay__item[data-tab-key="${NE}"] [data-node-id="ne-field"] input`
    );
    // A drag (A's tab, not showing, from t1 onto t2's bar) that leaves NE
    // showing in t1, then straight to the field: no tab click in between.
    await dragTo(page, { from: 'tab', key: A }, await barEnd(page, 't2'), 'tab');
    await expect
      .poll(async () => tilesOf(await dockLayout(page)).map((t) => [t.tabs, t.showing]))
      .toEqual([
        [[NE], NE],
        [[B, A], A],
      ]);
    await field.click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('12');
    await expect(field).toHaveValue('12');
    // A tab switch: t2 back to B, then t1's NE, then straight to the field.
    await tileTab(page, B).click();
    await tileTab(page, NE).click();
    await field.click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('34');
    await expect(field).toHaveValue('34');
  });

  test('an iframe takes a click right after a tab drag', async ({ page }) => {
    const layout: Layout = {
      split: 'row',
      items: [
        { tile: 't1', tabs: [TRACE], showing: TRACE },
        { tile: 't2', tabs: [A], showing: A },
        { tile: 't3', tabs: [B], showing: B },
      ],
    };
    await open(page, layout, [TRACE, A, B], TRACE);
    const iframe = page.locator(`iframe[data-tab-key="${TRACE}"]`);
    await expect(iframe).toBeVisible();
    const frame = (await iframe.elementHandle())!;
    const content = (await frame.contentFrame())!;
    await content.waitForLoadState();
    await content.evaluate(() => {
      (window as unknown as { __clicks: number }).__clicks = 0;
      document.addEventListener('mousedown', () => {
        (window as unknown as { __clicks: number }).__clicks += 1;
      });
    });
    await dragTo(page, { from: 'tab', key: B }, await barEnd(page, 't2'), 'tab');
    await expect.poll(async () => tilesOf(await dockLayout(page))).toHaveLength(2);
    const box = (await iframe.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect
      .poll(() => content.evaluate(() => (window as unknown as { __clicks: number }).__clicks))
      .toBe(1);
  });
});

// --- reload and stored docks --------------------------------------------------------

test.describe('reload', () => {
  const TABBED: Layout = {
    split: 'row',
    items: [
      { tile: 't1', tabs: [A, D], showing: D, size: 0.6 },
      {
        split: 'column',
        size: 0.4,
        items: [
          { tile: 't2', tabs: [B], showing: B, size: 0.25 },
          { tile: 't3', tabs: [C], showing: C, size: 0.75 },
        ],
      },
    ],
  };

  /** Rendered shares: [left width, top-right height] as percentages. */
  async function rendered(page: Page): Promise<number[]> {
    const t = await settledTiles(page);
    const w = (100 * t[D]!.width) / (t[D]!.width + t[B]!.width);
    const h = (100 * t[B]!.height) / (t[B]!.height + t[C]!.height);
    return [w, h];
  }

  test('a reload keeps tiles, tabs, the showing tab and the sizes', async ({ page }) => {
    await open(page, TABBED, [A, D, B, C], D);
    expect(await dockLayout(page)).toEqual(TABBED);
    expectShares(await rendered(page), [60, 25], 1.5, 'stored sizes rendered on open');
    await page.reload();
    await expect(dockRoot(page)).toBeVisible();
    await expect.poll(() => dockLayout(page)).toEqual(TABBED);
    expectShares(await rendered(page), [60, 25], 1.5, 'stored sizes rendered after reload');
  });

  test('a reload after a sash resize keeps the new sizes', async ({ page }) => {
    await open(page, TABBED, [A, D, B, C], D);
    const dock = (await dockRoot(page).boundingBox())!;
    await dragSash(page, D, dock.x + dock.width * 0.45);
    const before = await rendered(page);
    expect(Math.abs(before[0]! - 45)).toBeLessThanOrEqual(1.5);
    await page.reload();
    await expect(dockRoot(page)).toBeVisible();
    await expect.poll(async () => layoutShape(await dockLayout(page))).toBe(layoutShape(TABBED));
    expectShares(await rendered(page), before, 1.5, 'resized sizes after reload');
  });

  test('a dockview grid under another version opens as the default', async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    const other = {
      version: 0,
      grid: { root: { type: 'branch', data: [] }, orientation: 'HORIZONTAL', width: 0, height: 0 },
      panels: { [A]: { kind: 'screen', strip: true }, [B]: { kind: 'screen', strip: true } },
    };
    await seedDock(page, { keys: [A, B], active: A }, null, other);
    await page.goto(`${PREFIX}/embed/${A}`);
    await expect(dockRoot(page)).toBeVisible();
    await expect.poll(async () => tilesOf(await dockLayout(page)).length).toBe(1);
    const tile = tilesOf(await dockLayout(page))[0]!;
    expect([...tile.tabs].sort()).toEqual([A, B].sort());
    expect(tile.showing).toBe(A);
  });
});

// --- close and reopen -----------------------------------------------------------------

test.describe('close and reopen', () => {
  const reopen = (page: Page) => page.keyboard.press('ControlOrMeta+Shift+T');

  /** Every tile's showing tab is in its bar where a pointer can reach it. */
  async function expectShowingReachable(page: Page): Promise<void> {
    for (const t of tilesOf(await dockLayout(page))) {
      expect(
        await unreachable(tileTab(page, t.showing)),
        `${t.tile}: showing tab ${t.showing}`
      ).toBe('');
    }
  }

  /** Closes `key`'s tab with a real click on its ×, every showing tab reachable first. */
  async function closeTab(page: Page, key: string): Promise<void> {
    await expectShowingReachable(page);
    await closeTileTab(page, key);
  }

  test('a tab closes from its tile and reopens into it', async ({ page }) => {
    const layout: Layout = {
      split: 'row',
      items: [
        { tile: 't1', tabs: [A, D], showing: D },
        { tile: 't2', tabs: [B], showing: B },
      ],
    };
    await open(page, layout, [A, D, B], D);
    await closeTab(page, D);
    await shapeIs(page, `row[${A},${B}]`);
    await reopen(page);
    await expect
      .poll(async () => tilesOf(await dockLayout(page))[0]?.tabs.sort())
      .toEqual([A, D].sort());
    expect(tilesOf(await dockLayout(page))[0]?.showing).toBe(D);
  });

  test('a tile closes with its last tab and reopens where it was', async ({ page }) => {
    await openABC(page);
    const before = await settledTiles(page);
    await closeTab(page, B);
    await shapeIs(page, `row[${A},${C}]`);
    await reopen(page);
    await shapeIs(page, `row[${A},${B},${C}]`);
    const after = await settledTiles(page);
    for (const k of [A, B, C]) expectRect(after[k]!, before[k]!, `${k} back where it was`, 2);
  });

  test('a group (Close all) closes and reopens as one', async ({ page }) => {
    await openABC(page);
    await page.getByRole('button', { name: 'Window menu' }).click();
    const closeAll = page.getByRole('menuitem', { name: 'Close all' });
    await expect(page.getByRole('menu').first()).toBeInViewport({ ratio: 1 });
    expect(await unreachable(closeAll), 'Close all').toBe('');
    await closeAll.click();
    await expect.poll(async () => tilesOf(await dockLayout(page)).length).toBe(0);
    await reopen(page);
    await shapeIs(page, `row[${A},${B},${C}]`);
  });

  test('closing a split gives its room back to the tile it split from', async ({ page }) => {
    await openABC(page);
    const before = await settledTiles(page);
    await dragTo(page, { from: 'tree', key: D }, edgePoint(before[A]!, 'bottom', 64), 'split');
    await shapeIs(page, `row[column[${A},${D}],${B},${C}]`);
    await closeTab(page, D);
    await shapeIs(page, `row[${A},${B},${C}]`);
    const after = await settledTiles(page);
    for (const k of [A, B, C]) expectRect(after[k]!, before[k]!, `${k} back`, 2);
  });

  test('closing a tile in a row gives its room to the neighbour it split from', async ({
    page,
  }) => {
    await openABC(page);
    const before = await settledTiles(page);
    // D split from C (C's left edge): closing D gives the room back to C, not to B.
    await dragTo(page, { from: 'tree', key: D }, edgePoint(before[C]!, 'left', 64), 'split');
    await shapeIs(page, `row[${A},${B},${D},${C}]`);
    await closeTab(page, D);
    await shapeIs(page, `row[${A},${B},${C}]`);
    const after = await settledTiles(page);
    expectRect(after[B]!, before[B]!, 'B unchanged', 2);
    expectRect(after[C]!, before[C]!, 'C back', 2);
  });
});
