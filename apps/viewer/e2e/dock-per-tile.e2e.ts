// Acceptance for per-tile instances (every docked screen holds its own zoom,
// actions, action host and print mark) and for the tile keyboard, one test
// per clause:
//
// - shortcuts: with two screen tiles, the save shortcut downloads the
//   focused tile's screen and nothing else, and the print shortcut prints
//   exactly one screen, the focused tile's.
// - zoom: a zoom in one tile leaves the other tile's scale unchanged, in
//   both directions, with the press landing on an unfocused tile's bar.
// - Save view: clicked in the bar of a tool tile narrower than 320 px, it
//   opens that tool's dialog centred in the viewport, outside the dock, with
//   both dialog buttons hit-testable; the button stays reachable in that bar
//   while the outcome of a save is shown beside it.
// - keyboard: Enter on a bar goes into its tile and focuses it, an
//   unhandled Escape returns to the bar, and a button of an unfocused tile
//   activated from the keyboard (a bar action, a bar zoom control, a button of
//   the screen itself) acts on that tile and leaves the other alone.
//
// Tiles are made with dockHelpers' synthetic drag; the sash is dragged with
// the real pointer; every click and key press is a real one, on a control the
// test has not prepared in any way.

import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import {
  PREFIX,
  TABS_KEY,
  dockLayout,
  dragTo,
  edgePoint,
  layoutKeys,
  overlayItem,
  seedTabs,
  showingKeys,
  storedZoom,
  stripTab,
  tileBar,
  tileContentRect,
  tileTab,
  type DragFrom,
  type DropEdge,
  type Rect,
} from './dockHelpers';

test.describe.configure({ timeout: 30_000 });

const PANEL = 'drafts/e2e-panel';
const WIDE = 'drafts/wide-panel';
const ACTIONS = 'drafts/actions-panel';
const MACRO = 'drafts/macro-panel?DEVICE=E2E3';
const TRACE = '@trace';

const tree = (page: Page) => page.getByRole('navigation', { name: 'Screens' });
const screenRoots = (page: Page) => page.locator('.viewer-canvas [data-testid="screen-root"]');
const tileRoot = (page: Page, key: string) =>
  overlayItem(page, key).locator('[data-testid="screen-root"]');
/**
 * `key`'s bar action `id`. A bar too narrow for its actions (two tiles side by
 * side at the 1280 px default) moves them into its "More controls" menu,
 * portalled to the body; that menu is opened from the keyboard, so no press
 * moves the tile focus, and the action is looked up in the menu that bar's
 * trigger controls, never in another tile's.
 */
async function barAction(page: Page, key: string, id: string): Promise<Locator> {
  const inline = tileBar(page, key).locator(`[data-screen-action="${id}"]`);
  const more = tileBar(page, key).getByRole('button', { name: 'More controls' });
  await expect(inline.or(more).first()).toBeVisible();
  if ((await more.count()) === 0) return inline;
  if ((await more.getAttribute('aria-expanded')) !== 'true') {
    await more.focus();
    await page.keyboard.press('Enter');
    await expect(more).toHaveAttribute('aria-expanded', 'true');
  }
  const menu = page.locator(`[id="${await more.getAttribute('aria-controls')}"]`);
  await expect(menu).toBeVisible();
  return menu.locator(`[data-screen-action="${id}"]`);
}
/**
 * A zoom control of `key`'s tile bar: inline when the bar shows the zoom group, else in the
 * menu its compact "NN % ▾" button controls (portalled to the body), opened from the keyboard
 * so no press moves the tile focus.
 */
async function barZoom(page: Page, key: string, name: string): Promise<Locator> {
  const inline = tileBar(page, key).getByRole('button', { name, exact: true });
  const compact = tileBar(page, key).locator('.screen-header__zoom-menu');
  await expect(inline.or(compact).first()).toBeVisible();
  if ((await compact.count()) === 0) return inline;
  if ((await compact.getAttribute('aria-expanded')) !== 'true') {
    await compact.focus();
    await page.keyboard.press('Enter');
    await expect(compact).toHaveAttribute('aria-expanded', 'true');
  }
  const menu = page.locator(`[id="${await compact.getAttribute('aria-controls')}"]`);
  await expect(menu).toBeVisible();
  return menu.getByRole('button', { name, exact: true });
}
const barPercent = (page: Page, key: string) => tileBar(page, key).getByTestId('zoom-percent');
const saveViewButton = (page: Page, key: string) =>
  tileBar(page, key).getByRole('button', { name: 'Save view' });

/**
 * Waits until the tiles show exactly `showing` (one tile each, in layout
 * order), each placed over its tile, and the layout holds exactly `open` (every
 * open tab is a tab of some tile; default: the showing ones).
 */
async function expectDocked(
  page: Page,
  showing: string[],
  open: string[] = showing
): Promise<void> {
  await expect.poll(() => showingKeys(page)).toEqual(showing);
  await expect
    .poll(async () => layoutKeys(await dockLayout(page)).sort())
    .toEqual([...open].sort());
  for (const key of showing) {
    await expect(overlayItem(page, key)).toHaveAttribute('data-placed', 'true');
  }
}

/** Opens a page seeded with `keys`: one tile holding them all, `active` showing. */
async function openSeeded(page: Page, keys: string[], active: string): Promise<void> {
  await seedTabs(page, { keys, active });
  await page.goto(`${PREFIX}/embed/${active}`);
  await expectDocked(page, [active], keys);
}

/** `key`'s tab: the strip's with one tile, its tile bar's with two or more. */
async function tabOf(page: Page, key: string): Promise<Locator> {
  return (await stripTab(page, key).count()) > 0 ? stripTab(page, key) : tileTab(page, key);
}

/** Waits two animation frames. */
async function frames(page: Page): Promise<void> {
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  );
}

/** `key`'s tile content rect once it holds still across two animation frames. */
async function settledRect(page: Page, key: string): Promise<Rect> {
  let last: Rect | null = null;
  await expect
    .poll(
      async () => {
        await frames(page);
        const now = await tileContentRect(page, key);
        const still = now !== null && JSON.stringify(now) === JSON.stringify(last);
        last = now;
        return still;
      },
      { message: `${key}'s tile settles` }
    )
    .toBe(true);
  return last!;
}

/**
 * Drops `key`'s tab (its strip tab with one tile, its tile-bar tab otherwise)
 * 30 px inside `edge` of the content of the tile showing `target`: a split of
 * that tile, `key` alone in the new half.
 */
async function dropAtEdge(page: Page, key: string, target: string, edge: DropEdge): Promise<void> {
  const rect = await settledRect(page, target);
  const src: DragFrom =
    (await stripTab(page, key).count()) > 0 ? { from: 'strip', key } : { from: 'tab', key };
  await dragTo(page, src, edgePoint(rect, edge, 64), 'split');
  await expect(page.locator('.canopy-dock-overlay')).not.toHaveAttribute('data-dragging', 'true');
}

/** Two tiles side by side: `left` as loaded, `right` dropped on its right edge (and focused). */
async function twoTiles(page: Page, left: string, right: string): Promise<void> {
  // One tile holding both, `left` showing; `right`'s strip tab dragged out to its right edge.
  await openSeeded(page, [left, right], left);
  await dropAtEdge(page, right, left, 'right');
  await expectDocked(page, [left, right]);
  await expectFocused(page, right);
}

/**
 * `key`'s tile is the focused one: its tab is the selected one of its bar, its
 * overlay is marked, and no other overlay is.
 */
async function expectFocused(page: Page, key: string): Promise<void> {
  await expect(await tabOf(page, key)).toHaveAttribute('aria-selected', 'true');
  await expect(overlayItem(page, key)).toHaveAttribute('data-focused', 'true');
  await expect(page.locator('.canopy-dock-overlay__item[data-focused="true"]')).toHaveCount(1);
}

/**
 * Focuses `key`'s tile the way an operator does, a click on its tab in its
 * tile's bar, on a visible part of it: in a narrow tile the tab is squeezed and
 * the bar's right actions overlap the rest of its box.
 */
async function focusTile(page: Page, key: string): Promise<void> {
  const tab = await tabOf(page, key);
  const visibleX = () =>
    tab.evaluate((el) => {
      const r = el.getBoundingClientRect();
      for (let dx = 2; dx < r.width - 1; dx += 2) {
        const at = document.elementFromPoint(r.left + dx, r.top + r.height / 2);
        if (at !== null && el.contains(at)) return dx;
      }
      return null;
    });
  await expect
    .poll(visibleX, { message: `some part of ${key}'s tab is a pointer target` })
    .not.toBeNull();
  const x = await visibleX();
  const box = (await tab.boundingBox())!;
  await tab.click({ position: { x: x!, y: box.height / 2 } });
  await expectFocused(page, key);
}

/** The tab bar (the tablist, the tile's one tab stop) of the tile showing `key`. */
const tabBarOf = (page: Page, key: string) =>
  page.locator(`[data-testid="tile-bar"][data-panel-key="${key}"]`);

/** The viewport rect of `key`'s whole tile (bar and content). */
async function tileRect(page: Page, key: string): Promise<Rect | null> {
  return page.evaluate((k) => {
    const group = document
      .querySelector(`[data-testid="tile-bar"][data-panel-key="${CSS.escape(k)}"]`)
      ?.closest('.dv-groupview');
    if (!group) return null;
    const r = group.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }, key);
}

/** The visible sashes' viewport rects. */
async function sashRects(page: Page): Promise<Rect[]> {
  return page.locator('.dv-sash').evaluateAll((sashes) =>
    sashes
      .filter((s) => {
        const r = s.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(s).visibility !== 'hidden';
      })
      .map((s) => {
        const r = s.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      })
  );
}

/**
 * Replaces window.print with a recorder (headless printing opens nothing): each
 * call notes which tiles carry the print mark at that moment.
 */
async function stubPrint(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __printTiles: string[][] };
    w.__printTiles = [];
    window.print = () => {
      w.__printTiles.push(
        [...document.querySelectorAll('.canopy-dock-overlay__item[data-printing="true"]')].map(
          (item) => item.getAttribute('data-tab-key') ?? ''
        )
      );
    };
  });
}

/** One entry per window.print call: the keys of the tiles marked for printing during it. */
const printedTiles = (page: Page) =>
  page.evaluate(() => (window as unknown as { __printTiles: string[][] }).__printTiles);

/** The scale a tile's screen is drawn at: its bar's percent, its root's width, its transform. */
async function scaleOf(page: Page, key: string) {
  return {
    percent: await barPercent(page, key).textContent(),
    width: Math.round((await tileRoot(page, key).boundingBox())!.width),
    transform: await overlayItem(page, key)
      .locator('.viewer-zoom__scaled')
      .evaluate((el) => (el as HTMLElement).style.transform),
    // Remembered per screen (src/ZoomContext.tsx ZoomStore).
    stored: await storedZoom(page, key),
  };
}

/**
 * `control` can be reached with the pointer: it lies wholly inside `key`'s
 * tile and `elementFromPoint` at its centre is the control itself.
 */
async function expectReachableInTile(
  page: Page,
  control: Locator,
  key: string,
  what: string
): Promise<void> {
  const tile = (await tileRect(page, key))!;
  const probe = await control.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return {
      box: { x: r.x, y: r.y, width: r.width, height: r.height },
      hit: hit !== null && el.contains(hit),
    };
  });
  expect(probe.box.width, `${what}: has a width`).toBeGreaterThan(0);
  expect(probe.box.x, `${what}: left edge inside the tile`).toBeGreaterThanOrEqual(tile.x - 0.5);
  expect(probe.box.x + probe.box.width, `${what}: right edge inside the tile`).toBeLessThanOrEqual(
    tile.x + tile.width + 0.5
  );
  expect(probe.hit, `${what}: elementFromPoint at its centre is the control`).toBe(true);
}

/**
 * The Save view dialog's geometry: its box is centred in and fully inside the
 * viewport, `elementFromPoint` at the centre of Cancel and of Save is that
 * button, the viewport centre hits the dialog, and the dialog is no descendant
 * of the dock, a tile bar or the overlay.
 */
async function expectSaveDialogSafe(page: Page, heading: string): Promise<void> {
  const dialog = page.getByRole('dialog').filter({ hasText: heading });
  await expect(dialog).toBeVisible();
  const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true });
  const save = dialog.getByRole('button', { name: 'Save', exact: true });
  await expect(cancel).toBeVisible();
  await expect(save).toBeVisible();
  // The modal eases in; measure once its box holds still.
  let last = '';
  await expect
    .poll(
      async () => {
        await frames(page);
        const now = JSON.stringify(await dialog.boundingBox());
        const still = now === last;
        last = now;
        return still;
      },
      { message: 'the dialog settles' }
    )
    .toBe(true);

  const geometry = await dialog.evaluate((el) => {
    const box = el.matches('.cds--modal-container')
      ? el
      : el.querySelector('.cds--modal-container');
    if (!box) throw new Error('no dialog box');
    const r = box.getBoundingClientRect();
    const centreHit = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
    return {
      box: { x: r.x, y: r.y, width: r.width, height: r.height },
      viewport: { width: innerWidth, height: innerHeight },
      centreInDialog: centreHit !== null && box.contains(centreHit),
      inDock:
        el.closest(
          '[data-testid="workspace-dock"], [data-testid="tile-bar"], .canopy-dock-overlay'
        ) !== null,
    };
  });
  const { box, viewport } = geometry;
  expect(box.width, 'dialog has a width').toBeGreaterThan(0);
  expect(box.height, 'dialog has a height').toBeGreaterThan(0);
  expect(
    Math.abs(box.x + box.width / 2 - viewport.width / 2),
    'dialog centred horizontally'
  ).toBeLessThan(2);
  expect(
    Math.abs(box.y + box.height / 2 - viewport.height / 2),
    'dialog centred vertically'
  ).toBeLessThan(2);
  expect(box.x, 'dialog left inside the viewport').toBeGreaterThanOrEqual(0);
  expect(box.y, 'dialog top inside the viewport').toBeGreaterThanOrEqual(0);
  expect(box.x + box.width, 'dialog right inside the viewport').toBeLessThanOrEqual(viewport.width);
  expect(box.y + box.height, 'dialog bottom inside the viewport').toBeLessThanOrEqual(
    viewport.height
  );
  for (const [name, button] of [
    ['Cancel', cancel],
    ['Save', save],
  ] as const) {
    const hit = await button.evaluate((el) => {
      const b = el.getBoundingClientRect();
      const at = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
      return at !== null && el.contains(at);
    });
    expect(hit, `elementFromPoint at the centre of ${name} is that button`).toBe(true);
  }
  expect(geometry.centreInDialog, 'the viewport centre hits the dialog').toBe(true);
  expect(geometry.inDock, 'the dialog renders outside the dock').toBe(false);
}

test.describe('per-tile instances', () => {
  test('the save shortcut downloads the focused tile, the print shortcut prints exactly one', async ({
    page,
  }) => {
    await stubPrint(page);
    const downloads: string[] = [];
    page.on('download', (d) => downloads.push(d.suggestedFilename()));
    await twoTiles(page, PANEL, WIDE);
    await expect(screenRoots(page).filter({ visible: true })).toHaveCount(2);

    // Each screen bar carries its own actions; the shortcut still has one owner.
    await expect(await barAction(page, PANEL, 'download')).toBeVisible();
    await expect(await barAction(page, WIDE, 'download')).toBeVisible();

    // Save: the focused tile's screen, and only that one.
    const [wide] = await Promise.all([
      page.waitForEvent('download'),
      page.keyboard.press('ControlOrMeta+s'),
    ]);
    expect(wide.suggestedFilename()).toBe('wide-panel.screen.json');

    await focusTile(page, PANEL);
    const [panel] = await Promise.all([
      page.waitForEvent('download'),
      page.keyboard.press('ControlOrMeta+s'),
    ]);
    expect(panel.suggestedFilename()).toBe('e2e-panel.screen.json');

    // Focus moved by a click inside the other tile's screen moves the shortcut with it.
    await tileRoot(page, WIDE).click({ position: { x: 5, y: 5 } });
    await expectFocused(page, WIDE);
    const [again] = await Promise.all([
      page.waitForEvent('download'),
      page.keyboard.press('ControlOrMeta+s'),
    ]);
    expect(again.suggestedFilename()).toBe('wide-panel.screen.json');
    // A second listener would have saved the other tile as well.
    await page.waitForTimeout(300);
    expect(downloads, 'one download per shortcut press').toEqual([
      'wide-panel.screen.json',
      'e2e-panel.screen.json',
      'wide-panel.screen.json',
    ]);

    // Print: one print call, for the focused tile.
    await page.keyboard.press('ControlOrMeta+p');
    await expect.poll(() => printedTiles(page)).toEqual([[WIDE]]);
    await page.waitForTimeout(300);
    expect(await printedTiles(page), 'exactly one print per shortcut press').toEqual([[WIDE]]);
    // The mark lasts for the print call only.
    await expect(page.locator('[data-printing]')).toHaveCount(0);

    // And what that print shows is exactly one docked screen, the focused one.
    await page.emulateMedia({ media: 'print' });
    await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
    await expect(screenRoots(page).filter({ visible: true })).toHaveCount(1);
    await expect(screenRoots(page).filter({ visible: true })).toHaveAttribute(
      'data-screen-id',
      'wide-panel'
    );
    await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
    await page.emulateMedia({ media: 'screen' });
    await expect(screenRoots(page).filter({ visible: true })).toHaveCount(2);

    // The other tile focused: its screen is the one printed.
    await focusTile(page, PANEL);
    await page.keyboard.press('ControlOrMeta+p');
    await expect.poll(() => printedTiles(page)).toEqual([[WIDE], [PANEL]]);
    await page.emulateMedia({ media: 'print' });
    await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
    await expect(screenRoots(page).filter({ visible: true })).toHaveCount(1);
    await expect(screenRoots(page).filter({ visible: true })).toHaveAttribute(
      'data-screen-id',
      'e2e-panel'
    );
    await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
    await page.emulateMedia({ media: 'screen' });
    expect(downloads, 'printing downloads nothing').toHaveLength(3);
  });

  test("a zoom in one tile leaves the other tile's scale unchanged", async ({ page }) => {
    await twoTiles(page, PANEL, WIDE);
    // Both bars show their own zoom, focused or not.
    await expect(barPercent(page, PANEL)).toBeVisible();
    await expect(barPercent(page, WIDE)).toBeVisible();
    await expect(await barZoom(page, WIDE, 'Fit')).toHaveAttribute('aria-pressed', 'true');
    await settledRect(page, PANEL);
    await settledRect(page, WIDE);

    // Zoom the focused tile: the unfocused one keeps its scale.
    const panelBefore = await scaleOf(page, PANEL);
    await (await barZoom(page, WIDE, 'Actual size')).click();
    await expect(barPercent(page, WIDE)).toHaveText('100%');
    await expect
      .poll(async () => Math.round((await tileRoot(page, WIDE).boundingBox())!.width))
      .toBe(2400);
    await frames(page);
    expect(await scaleOf(page, PANEL), 'the other tile after a zoom of the wide one').toEqual(
      panelBefore
    );

    // Zoom the unfocused tile from its own bar: the press reaches that tile's
    // zoom, and the wide tile, focused until then, keeps its 100%.
    await expectFocused(page, WIDE);
    const wideBefore = await scaleOf(page, WIDE);
    expect(wideBefore.percent).toBe('100%');
    await (await barZoom(page, PANEL, 'Actual size')).click();
    await expect(barPercent(page, PANEL)).toHaveText('100%');
    await (await barZoom(page, PANEL, 'Zoom out')).click();
    await expect(barPercent(page, PANEL)).toHaveText('90%');
    await expect
      .poll(async () => Math.round((await tileRoot(page, PANEL).boundingBox())!.width))
      .toBe(360);
    await expectFocused(page, PANEL);
    await frames(page);
    expect(await scaleOf(page, WIDE), 'the wide tile after a zoom of the other one').toEqual(
      wideBefore
    );
    expect((await scaleOf(page, PANEL)).stored).toEqual({ mode: 'manual', scale: 0.9 });
    expect(wideBefore.stored).toEqual({ mode: 'manual', scale: 1 });
  });

  test('Save view in a tool tile narrower than 320 px opens a centred, hit-testable dialog', async ({
    page,
  }, info) => {
    // Not "e2e", "data", "browser" or "trace": other specs search the tree for those.
    const name = `Narrow column kept ${info.workerIndex}-${Date.now()}`;
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    // The data browser holds something to save.
    await page.addInitScript(
      ([key, value]) => {
        if (window === window.top && sessionStorage.getItem(key) === null) {
          sessionStorage.setItem(key, value);
        }
      },
      [
        TABS_KEY,
        JSON.stringify({
          keys: [PANEL, TRACE],
          active: PANEL,
          instances: { '@trace': { query: 'pv=E2E:NARROW&range=-1h' } },
        }),
      ] as const
    );
    await page.goto(`${PREFIX}/embed/${PANEL}`);
    await expectDocked(page, [PANEL], [PANEL, TRACE]);
    await dropAtEdge(page, TRACE, PANEL, 'right');
    await expectDocked(page, [PANEL, TRACE]);
    await expect(page.locator(`iframe[data-tab-key="${TRACE}"]`)).toBeVisible();

    // Narrow the data browser's column with its sash, the real pointer.
    {
      const tile = (await tileRect(page, TRACE))!;
      const left = (await sashRects(page)).filter(
        (s) => s.width < s.height && Math.abs(s.x + s.width / 2 - tile.x) < 8
      );
      expect(left.length, 'the sash left of the data browser tile').toBe(1);
      const s = left[0];
      const y = s.y + s.height / 2;
      await page.mouse.move(s.x + s.width / 2, y);
      await page.mouse.down();
      await page.mouse.move(tile.x + tile.width - 260, y, { steps: 10 });
      await page.mouse.up();
      await frames(page);
    }
    await settledRect(page, TRACE);
    const narrow = (await tileRect(page, TRACE))!;
    expect(narrow.width, 'the data browser tile is narrower than 320 px').toBeLessThan(320);
    expect(narrow.width, 'the data browser tile still exists').toBeGreaterThan(0);

    // The screen tile is the focused one: the click below lands on an unfocused bar.
    await focusTile(page, PANEL);
    const button = saveViewButton(page, TRACE);
    await expect(button).toBeEnabled();
    await expectReachableInTile(page, button, TRACE, 'Save view in the narrow bar');
    // The strip carries no Save view: this bar's is the only one.
    await expect(page.getByRole('button', { name: 'Save view' })).toHaveCount(1);

    await button.click();
    await expectSaveDialogSafe(page, 'Save Data Browser view');
    await expectFocused(page, TRACE);
    const dialog = page.getByRole('dialog').filter({ hasText: 'Save Data Browser view' });
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(tree(page).getByRole('treeitem', { name, exact: true })).toHaveCount(0);

    // From the keyboard, on the bar of the again unfocused tile: the same dialog.
    await focusTile(page, PANEL);
    await button.focus();
    await page.keyboard.press('Enter');
    await expectSaveDialogSafe(page, 'Save Data Browser view');
    await expectFocused(page, TRACE);
    await page.getByLabel('Name').fill(name);
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toBeHidden();

    // The outcome shows in that bar, and the button beside it stays reachable.
    await expect(tileBar(page, TRACE).getByTestId('save-view-status')).toContainText(name);
    await expectReachableInTile(page, button, TRACE, 'Save view beside the save outcome');
    await expect(tree(page).getByRole('treeitem', { name, exact: true })).toBeVisible();
    const saved = await page.evaluate(async (prefix) => {
      const response = await fetch(`${prefix}/views`);
      return ((await response.json()) as { views: { name: string; query: string }[] }).views;
    }, PREFIX);
    expect(saved.find((v) => v.name === name)?.query).toBe('pv=E2E:NARROW&range=-1h');
    expect((await tileRect(page, TRACE))!.width, 'the tile is still narrow').toBeLessThan(320);

    // Leave the shared server as it was.
    await page.evaluate(
      async ([prefix, viewId]) => {
        await fetch(`${prefix}/views/${viewId}`, { method: 'DELETE' });
      },
      [PREFIX, id] as const
    );
  });

  test('keyboard: Enter enters a tile, Escape returns, and a button in an unfocused tile acts on that tile', async ({
    page,
  }) => {
    await stubPrint(page);
    const downloads: string[] = [];
    page.on('download', (d) => downloads.push(d.suggestedFilename()));
    await twoTiles(page, ACTIONS, WIDE);

    // Enter on an unfocused tile's bar goes into that tile and focuses it.
    await tabBarOf(page, ACTIONS).focus();
    await page.keyboard.press('Enter');
    await expect
      .poll(() =>
        overlayItem(page, ACTIONS).evaluate((item) => item.contains(document.activeElement))
      )
      .toBe(true);
    await expectFocused(page, ACTIONS);
    // An Escape nothing in the tile handles returns to its bar.
    await page.keyboard.press('Escape');
    await expect(tabBarOf(page, ACTIONS)).toBeFocused();

    // A bar action of the unfocused tile, activated from the keyboard, saves that tile's screen.
    await focusTile(page, WIDE);
    await (await barAction(page, ACTIONS, 'download')).focus();
    const [json] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Enter')]);
    expect(json.suggestedFilename()).toBe('actions-panel.screen.json');
    await expectFocused(page, ACTIONS);

    // Print from the unfocused tile's bar prints that tile, once.
    await focusTile(page, WIDE);
    await (await barAction(page, ACTIONS, 'print')).focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => printedTiles(page)).toEqual([[ACTIONS]]);
    await expectFocused(page, ACTIONS);

    // A zoom control of the unfocused tile's bar zooms that tile and not the other.
    await focusTile(page, WIDE);
    await settledRect(page, WIDE);
    const wideBefore = await scaleOf(page, WIDE);
    await (await barZoom(page, ACTIONS, 'Actual size')).focus();
    await page.keyboard.press('Enter');
    await expect(barPercent(page, ACTIONS)).toHaveText('100%');
    await (await barZoom(page, ACTIONS, 'Zoom out')).focus();
    await page.keyboard.press('Space');
    await expect(barPercent(page, ACTIONS)).toHaveText('90%');
    await frames(page);
    expect(await scaleOf(page, WIDE), 'the other tile keeps its scale').toEqual(wideBefore);

    // A button of the unfocused tile's screen navigates its own tile: that
    // tile's occupant is replaced, the other tile keeps its screen.
    await focusTile(page, WIDE);
    const open = overlayItem(page, ACTIONS).getByRole('button', {
      name: 'Open Macro Panel',
      exact: true,
    });
    await expect(open).toBeVisible();
    await open.focus();
    await page.keyboard.press('Enter');
    await expectDocked(page, [MACRO, WIDE]);
    await expectFocused(page, MACRO);
    await expect(tileRoot(page, MACRO)).toHaveAttribute('data-screen-id', 'macro-panel');
    await expect(tileRoot(page, WIDE)).toHaveAttribute('data-screen-id', 'wide-panel');
    await expect(overlayItem(page, ACTIONS)).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`${PREFIX}/embed/drafts/macro-panel\\?DEVICE=E2E3$`));

    await page.waitForTimeout(300);
    expect(downloads, 'one download, of the tile whose button was activated').toEqual([
      'actions-panel.screen.json',
    ]);
    expect(await printedTiles(page), 'one print, of the tile whose button was activated').toEqual([
      [ACTIONS],
    ]);
  });
});
