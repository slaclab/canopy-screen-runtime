// Acceptance for write safety and printing in a split layout (runs A, B and
// C, and the print clause), one test per run:
//
// - Run A: the write-button tile focused, narrower than 320 px and
//   shorter than 260 px, a sash crossing the viewport centre. The Write button
//   opens the confirmation dialog centred in and fully inside the viewport;
//   `elementFromPoint` at the centre of both dialog buttons is that button (and
//   at the viewport centre, over the sash, is the dialog); Cancel declines:
//   no toast and zero PV write requests.
// - Run B: two screens docked, the write-button tile unfocused. One click
//   on the button opens the dialog and makes that tile active; the same
//   geometry checks; Write sends exactly one PV write request and shows a toast
//   at the viewport's bottom-left, outside the tile rect, naming its screen.
// - Run C: a persistent (failed) toast from one tile and a later toast
//   from a second tile are both visible, do not intersect, each names its
//   screen, and closing one leaves the other.
// - print clause: two screens docked, the focused one in a tile narrower
//   than its print width; under print media exactly one docked screen is
//   visible and its root is at least its authored size times the print scale.
//
// Every gesture is a real pointer or keyboard action; no synthetic click, no
// force-click, no pre-focus. A failure here is a product defect to report,
// never an assertion to loosen.

import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import {
  PREFIX,
  dockLayout,
  dragTo,
  edgePoint,
  layoutKeys,
  overlayItem,
  seedTabs,
  showingKeys,
  stripTab,
  tileContentRect,
  tileTab,
  type DragFrom,
  type DropEdge,
  type Rect,
} from './dockHelpers';
import { WRITABLE_PV, installHareMock, installPvWriteRoute } from './hostFixture';

test.describe.configure({ timeout: 30_000 });

const PANEL = 'drafts/e2e-panel';
const LABELS = 'drafts/label-fit';
const WIDE = 'drafts/wide-panel';
const BUTTON = 'drafts/write-button';
const PROBE = 'drafts/write-probe';
/** The authored size of the wide-panel fixture. */
const WIDE_SIZE = { width: 2400, height: 800 };

// --- Local helpers (as in dock.e2e.ts) ---------------------------------------

/** The key of the focused tile (the one overlay item marked focused). */
async function activeKey(page: Page): Promise<string | null> {
  const focused = page.locator('.canopy-dock-overlay__item[data-focused="true"]');
  await expect(focused).toHaveCount(1);
  return focused.getAttribute('data-tab-key');
}

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

/**
 * `key`'s tile is the focused one: its tab is the selected one of its bar, its
 * overlay is marked, and no other overlay is.
 */
async function expectFocused(page: Page, key: string): Promise<void> {
  await expect(await tabOf(page, key)).toHaveAttribute('aria-selected', 'true');
  await expect(overlayItem(page, key)).toHaveAttribute('data-focused', 'true');
  expect(await activeKey(page)).toBe(key);
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

/** Drags the sash at `from` with the real pointer to `to`. */
async function dragSash(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number }
): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 10 });
  await page.mouse.up();
  await frames(page);
}

/** Whether two rects overlap by more than a pixel's rounding. */
function intersects(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.width - 1 &&
    b.x < a.x + a.width - 1 &&
    a.y < b.y + b.height - 1 &&
    b.y < a.y + a.height - 1
  );
}

/**
 * The dialog geometry: the dialog box is centred in and fully inside the
 * viewport, `elementFromPoint` at the centre of each dialog button is that
 * button, and at the viewport centre it is the dialog.
 */
async function expectDialogSafe(page: Page): Promise<void> {
  const geometry = await page.evaluate(() => {
    const dialog = document.querySelector('[data-testid="canopy-write-dialog"]');
    const box = dialog?.querySelector('.cds--modal-container');
    if (!dialog || !box) throw new Error('no write dialog box');
    const r = box.getBoundingClientRect();
    const hits = (['canopy-write-decline', 'canopy-write-confirm'] as const).map((id) => {
      const button = dialog.querySelector(`[data-testid="${id}"]`);
      if (!button) return { id, hit: false };
      const b = button.getBoundingClientRect();
      const hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
      return { id, hit: hit !== null && button.contains(hit) };
    });
    const centreHit = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
    return {
      box: { x: r.x, y: r.y, width: r.width, height: r.height },
      viewport: { width: innerWidth, height: innerHeight },
      hits,
      centreInDialog: centreHit !== null && box.contains(centreHit),
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
  for (const { id, hit } of geometry.hits) {
    expect(hit, `elementFromPoint at the centre of ${id} is that button`).toBe(true);
  }
  expect(geometry.centreInDialog, 'the viewport centre hits the dialog').toBe(true);
}

/** The toast group of the screen titled `title` in the shared column. */
function toastGroup(page: Page, title: string): Locator {
  return page
    .getByTestId('canopy-write-toast-column')
    .locator(`.canopy-write-toasts__screen[data-screen-title="${title}"]`);
}

/** The visible toast box of the screen titled `title`. */
function toastBox(page: Page, title: string): Locator {
  return toastGroup(page, title).locator('.cds--toast-notification');
}

/** Asserts a toast of the screen titled `title` is visible, names it and has `outcome`. */
async function expectNamedToast(
  page: Page,
  title: string,
  outcome: string | RegExp
): Promise<void> {
  const group = toastGroup(page, title);
  await expect(toastBox(page, title)).toBeVisible();
  await expect(group.getByTestId('canopy-write-toast-screen')).toHaveText(title);
  await expect(group.getByTestId('canopy-write-toast')).toHaveAttribute('data-outcome', outcome);
}

async function rectOf(locator: Locator): Promise<Rect> {
  const box = await locator.boundingBox();
  expect(box, 'element has a box').not.toBeNull();
  return box!;
}

// --- Specs -------------------------------------------------------------------

test.describe('dock write safety and print', () => {
  test('Run A: a small focused tile under a centre sash; the dialog is safe; Cancel writes nothing', async ({
    page,
  }) => {
    await installHareMock(page);
    const writes = await installPvWriteRoute(page);
    await openSeeded(page, [PANEL, LABELS, BUTTON, WIDE], PANEL);

    // Three columns PANEL | LABELS | BUTTON, then WIDE under BUTTON: each
    // dragged out of the first tile, which keeps the tabs not yet moved.
    const all = [PANEL, LABELS, BUTTON, WIDE];
    await dropAtEdge(page, LABELS, PANEL, 'right');
    await expectDocked(page, [PANEL, LABELS], all);
    await dropAtEdge(page, BUTTON, LABELS, 'right');
    await expectDocked(page, [PANEL, LABELS, BUTTON], all);
    await dropAtEdge(page, WIDE, BUTTON, 'bottom');
    await expectDocked(page, all);

    const viewport = page.viewportSize()!;
    const centre = { x: viewport.width / 2, y: viewport.height / 2 };

    // Move the vertical sash nearest the centre onto it.
    {
      const verticals = (await sashRects(page)).filter((s) => s.width < s.height);
      expect(verticals.length, 'vertical sashes').toBeGreaterThan(0);
      verticals.sort(
        (a, b) => Math.abs(a.x + a.width / 2 - centre.x) - Math.abs(b.x + b.width / 2 - centre.x)
      );
      const s = verticals[0];
      const y = s.y + s.height / 4; // clear of the horizontal sash at mid-height
      await dragSash(page, { x: s.x + s.width / 2, y }, { x: centre.x, y });
    }

    // Narrow BUTTON's column: the vertical sash on its left goes right.
    {
      const tile = (await tileRect(page, BUTTON))!;
      const left = (await sashRects(page)).filter(
        (s) => s.width < s.height && Math.abs(s.x + s.width / 2 - tile.x) < 8
      );
      expect(left.length, 'the sash left of the write-button tile').toBe(1);
      const s = left[0];
      const y = s.y + s.height / 4; // clear of the horizontal sash at mid-height
      await dragSash(page, { x: s.x + s.width / 2, y }, { x: tile.x + tile.width - 260, y });
    }

    // Shrink BUTTON's tile in height: the horizontal sash between it and WIDE goes up.
    {
      const tile = (await tileRect(page, BUTTON))!;
      const horizontals = (await sashRects(page)).filter(
        (s) =>
          s.width > s.height &&
          s.x < tile.x + tile.width / 2 &&
          s.x + s.width > tile.x + tile.width / 2 &&
          Math.abs(s.y + s.height / 2 - (tile.y + tile.height)) < 8
      );
      expect(horizontals.length, 'the sash under the write-button tile').toBe(1);
      const s = horizontals[0];
      const x = tile.x + tile.width / 2;
      // Pressed where the sash is the hit target: the lower tile's header
      // chrome covers the sash's lower half.
      const grab = await page.evaluate(
        ([px, top, height]) => {
          for (let y = top; y < top + height; y += 1) {
            if (document.elementFromPoint(px, y)?.classList.contains('dv-sash')) return y;
          }
          return null;
        },
        [x, s.y, s.height] as const
      );
      expect(grab, 'some row of the sash under the write-button tile is grabbable').not.toBeNull();
      await dragSash(page, { x, y: grab! }, { x, y: tile.y + 200 });
    }
    await settledRect(page, BUTTON);

    // Focus the write-button tile with a click on its tab.
    await focusTile(page, BUTTON);

    // The geometry the run requires.
    const tile = (await tileRect(page, BUTTON))!;
    expect(tile.width, 'write-button tile narrower than 320 px').toBeLessThan(320);
    expect(tile.height, 'write-button tile shorter than 260 px').toBeLessThan(260);
    const crossing = (await sashRects(page)).filter(
      (s) =>
        s.x <= centre.x &&
        centre.x <= s.x + s.width &&
        s.y <= centre.y &&
        centre.y <= s.y + s.height
    );
    expect(crossing.length, 'a sash crosses the viewport centre').toBeGreaterThan(0);

    // The write button opens the dialog; it is centred, inside and hit-testable.
    const write = overlayItem(page, BUTTON).getByRole('button', { name: 'Write' });
    await expect(write).toBeVisible();
    await write.click();
    const dialog = page.getByTestId('canopy-write-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(WRITABLE_PV);
    await expectDialogSafe(page);

    // Cancel declines: no toast, no PV write.
    await page.getByTestId('canopy-write-decline').click();
    await expect(dialog).toBeHidden();
    await page.waitForTimeout(500);
    await expect(page.getByTestId('canopy-write-toast')).toHaveCount(0);
    expect(writes.count, 'PV write requests after Cancel').toBe(0);
  });

  test('Run B: one click in an unfocused tile focuses it and opens the dialog; Write is one request and a named toast', async ({
    page,
  }) => {
    await installHareMock(page);
    const writes = await installPvWriteRoute(page);
    await openSeeded(page, [PANEL, BUTTON], PANEL);
    // BUTTON on the right, so the viewport's bottom-left is not inside its tile.
    await dropAtEdge(page, BUTTON, PANEL, 'right');
    await expectDocked(page, [PANEL, BUTTON]);
    await focusTile(page, PANEL);
    await expect(overlayItem(page, BUTTON)).not.toHaveAttribute('data-focused', 'true');

    // One click: the dialog opens and the tile becomes active.
    const write = overlayItem(page, BUTTON).getByRole('button', { name: 'Write' });
    await expect(write).toBeVisible();
    await write.click();
    const dialog = page.getByTestId('canopy-write-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(WRITABLE_PV);
    await expectFocused(page, BUTTON);
    expect(writes.count, 'no write before the confirm').toBe(0);
    await expectDialogSafe(page);

    // Write: exactly one request, a toast at the viewport's bottom-left outside the tile.
    await page.getByTestId('canopy-write-confirm').click();
    await expect(dialog).toBeHidden();
    await expect.poll(() => writes.count).toBe(1);
    expect(writes.writes[0]).toMatchObject({ pv: WRITABLE_PV, body: { value: 1 } });
    await expectNamedToast(page, 'Write Button', 'confirmed');

    const toast = await rectOf(toastBox(page, 'Write Button'));
    const viewport = page.viewportSize()!;
    expect(toast.x, 'toast left inside the viewport').toBeGreaterThanOrEqual(0);
    expect(toast.y + toast.height, 'toast bottom inside the viewport').toBeLessThanOrEqual(
      viewport.height
    );
    expect(toast.x, 'toast at the left edge').toBeLessThan(40);
    expect(viewport.height - (toast.y + toast.height), 'toast at the bottom edge').toBeLessThan(40);
    expect(toast.x + toast.width / 2, 'toast in the left half').toBeLessThan(viewport.width / 2);
    expect(toast.y + toast.height / 2, 'toast in the bottom half').toBeGreaterThan(
      viewport.height / 2
    );
    const tile = (await tileRect(page, BUTTON))!;
    expect(intersects(toast, tile), 'toast outside the write-button tile').toBe(false);
    expect(
      await overlayItem(page, BUTTON).locator('[data-testid="canopy-write-toast"]').count(),
      'toast not rendered inside the tile'
    ).toBe(0);

    // Still exactly one request once the toast has shown.
    await page.waitForTimeout(300);
    expect(writes.count, 'PV write requests').toBe(1);
  });

  test('Run C: a persistent toast and a later one from another tile coexist and close independently', async ({
    page,
  }) => {
    await installHareMock(page);
    const writes = await installPvWriteRoute(page);
    // 'unknown' outcome, a persistent toast. Everything else confirms.
    const failed: unknown[] = [];
    await page.route(/\/hare\/v1\/pvs\/[^?#]+/, async (route) => {
      const request = route.request();
      if (request.method() !== 'PUT') return route.fallback();
      let body: unknown;
      try {
        body = request.postDataJSON();
      } catch {
        body = request.postData();
      }
      if (String((body as { value?: unknown } | null)?.value) !== '7') return route.fallback();
      failed.push(body);
      await route.fulfill({ status: 500, contentType: 'text/plain', body: 'boom' });
    });

    await openSeeded(page, [PROBE, BUTTON], PROBE);
    await dropAtEdge(page, BUTTON, PROBE, 'right');
    await expectDocked(page, [PROBE, BUTTON]);

    // Tile 1: type 7 into the probe's input and confirm.
    const input = overlayItem(page, PROBE).locator('.carbon-pv-input input').first();
    await expect(input).toBeEnabled();
    await input.click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('7');
    await page.keyboard.press('Enter');
    const dialog = page.getByTestId('canopy-write-dialog');
    await expect(dialog).toBeVisible();
    await page.getByTestId('canopy-write-confirm').click();
    await expect(dialog).toBeHidden();
    await expect.poll(() => failed.length).toBe(1);
    await expectNamedToast(page, 'Write Probe', /^(?!confirmed$).+/);

    // Tile 2: the write button, confirmed.
    const write = overlayItem(page, BUTTON).getByRole('button', { name: 'Write' });
    await write.click();
    await expect(dialog).toBeVisible();
    await page.getByTestId('canopy-write-confirm').click();
    await expect(dialog).toBeHidden();
    await expect.poll(() => writes.count).toBe(1);
    expect(writes.writes[0]).toMatchObject({ pv: WRITABLE_PV, body: { value: 1 } });
    await expectNamedToast(page, 'Write Button', 'confirmed');

    // Both visible, not intersecting, each naming its screen.
    await expectNamedToast(page, 'Write Probe', /^(?!confirmed$).+/);
    const probeToast = await rectOf(toastBox(page, 'Write Probe'));
    const buttonToast = await rectOf(toastBox(page, 'Write Button'));
    expect(intersects(probeToast, buttonToast), 'the two toasts do not intersect').toBe(false);

    // Closing the persistent one leaves the other.
    await toastBox(page, 'Write Probe').getByRole('button', { name: 'close notification' }).click();
    await expect(toastBox(page, 'Write Probe')).toHaveCount(0);
    await expect(toastBox(page, 'Write Button')).toBeVisible();
    await expect(
      toastGroup(page, 'Write Button').getByTestId('canopy-write-toast-screen')
    ).toHaveText('Write Button');

    // And closing that one is independent too.
    await toastBox(page, 'Write Button')
      .getByRole('button', { name: 'close notification' })
      .click();
    await expect(toastBox(page, 'Write Button')).toHaveCount(0);
    expect(failed.length, 'failed write requests').toBe(1);
    expect(writes.count, 'confirmed write requests').toBe(1);
  });

  test('print: two screens docked, print media shows exactly the focused one at its authored size times the print scale', async ({
    page,
  }) => {
    await openSeeded(page, [PANEL, WIDE], PANEL);
    await dropAtEdge(page, WIDE, PANEL, 'right');
    await expectDocked(page, [PANEL, WIDE]);
    // The moved key is focused.
    await expectFocused(page, WIDE);

    const tile = await settledRect(page, WIDE);
    const roots = page.locator('.viewer-canvas [data-testid="screen-root"]');
    await expect(roots.filter({ visible: true })).toHaveCount(2);

    await page.emulateMedia({ media: 'print' });
    await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
    const readScale = async () =>
      Number(
        await page.evaluate(() =>
          getComputedStyle(document.documentElement).getPropertyValue('--canopy-print-scale')
        )
      );
    await expect.poll(readScale, { message: 'the print scale is set' }).toBeGreaterThan(0);
    const scale = await readScale();
    expect(scale).toBeLessThanOrEqual(1);
    // The focused tile is narrower than the screen's print width.
    expect(tile.width, 'tile narrower than the print width').toBeLessThan(WIDE_SIZE.width * scale);

    // Exactly one docked screen is visible, the focused one.
    await expect(roots.filter({ visible: true })).toHaveCount(1);
    const visible = overlayItem(page, WIDE).locator('.viewer-canvas [data-testid="screen-root"]');
    await expect(visible).toBeVisible();
    await expect(
      overlayItem(page, PANEL).locator('.viewer-canvas [data-testid="screen-root"]')
    ).toBeHidden();

    // At least its authored size times the print scale.
    const root = await rectOf(visible);
    expect(root.width, 'printed width').toBeGreaterThanOrEqual(WIDE_SIZE.width * scale - 1);
    expect(root.height, 'printed height').toBeGreaterThanOrEqual(WIDE_SIZE.height * scale - 1);

    await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
    await page.emulateMedia({ media: 'screen' });
    await expect(roots.filter({ visible: true })).toHaveCount(2);
  });
});
