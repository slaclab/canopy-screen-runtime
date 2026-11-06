// The screen header in a narrow tile: no control covers another or leaves the
// bar. ◀ ▶ never shrink, the title ellipsises, and a bar too narrow for its
// controls moves the actions, then the zoom group too, into one "More
// controls" menu. Probed the way the deploy defect was found: elementFromPoint at the
// centre of each control must hit that control (or the menu's trigger).

import { expect, test, type Locator, type Page } from '@playwright/test';
import { seedTabs, tileBar } from './dockHelpers';

const PREFIX = '/x/y/';

test.describe.configure({ timeout: 20_000 });
test.use({ viewport: { width: 1400, height: 850 } });

const leaf = (page: Page, key: string) => page.locator(`[data-screen-key="${key}"]`);
const header = (page: Page) => tileBar(page, 'drafts/label-fit').getByTestId('screen-header');
const screenRoot = (page: Page) =>
  page.locator('.viewer-canvas [data-testid="screen-root"]').locator('visible=true');

/** Open e2e-panel, then replace it with label-fit, so ◀ is enabled. */
async function openWithHistory(page: Page) {
  await seedTabs(page, { keys: [], active: null });
  await page.goto(`${PREFIX}embed/`);
  await leaf(page, 'drafts/e2e-panel').click();
  await expect(screenRoot(page)).toHaveAttribute('data-screen-id', 'e2e-panel');
  await leaf(page, 'drafts/label-fit').click();
  await expect(screenRoot(page)).toHaveAttribute('data-screen-id', 'label-fit');
  await expect(header(page).getByRole('button', { name: 'Back' })).toBeEnabled();
}

/**
 * Resize the viewport until the screen header is `width` px wide (±1). The
 * sidebar does not keep a fixed width near the bottom end, so this steps.
 */
async function headerWidth(page: Page, width: number) {
  for (let i = 0; i < 12; i += 1) {
    // The dock lays its tiles out a frame or two after the resize.
    await page.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
    );
    const box = (await header(page).boundingBox())!;
    const diff = width - box.width;
    if (Math.abs(diff) <= 1) return;
    const viewport = page.viewportSize()!;
    await page.setViewportSize({
      width: Math.max(200, Math.round(viewport.width + diff)),
      height: viewport.height,
    });
  }
  expect(Math.abs((await header(page).boundingBox())!.width - width)).toBeLessThanOrEqual(1);
}

/** Whether elementFromPoint at the centre of `control` lands inside it. */
async function hitsItself(control: Locator): Promise<boolean> {
  return control.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return hit !== null && el.contains(hit);
  });
}

/** Every visible control of the bar, inside the bar and clear of each other. */
async function assertNoOverlap(page: Page) {
  const bar = (await header(page).boundingBox())!;
  const boxes = await header(page)
    .locator('button, .screen-header__percent')
    .evaluateAll((els) =>
      els
        .map((el) => {
          const r = el.getBoundingClientRect();
          return {
            name: el.getAttribute('aria-label') ?? el.textContent ?? '',
            left: r.left,
            right: r.right,
            top: r.top,
            bottom: r.bottom,
          };
        })
        .filter((r) => r.right > r.left)
    );
  for (const b of boxes) {
    expect(b.left, `${b.name} inside the bar`).toBeGreaterThanOrEqual(bar.x - 0.5);
    expect(b.right, `${b.name} inside the bar`).toBeLessThanOrEqual(bar.x + bar.width + 0.5);
  }
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i];
      const b = boxes[j];
      const overlap = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      expect(overlap, `${a.name} and ${b.name} do not overlap`).toBeLessThanOrEqual(0.5);
    }
  }
}

test.describe('screen header in a narrow tile', () => {
  test('a 375 px header keeps ◀, ▶, zoom, Print and Copy link each reachable @embed', async ({
    page,
  }) => {
    await openWithHistory(page);
    await headerWidth(page, 375);
    const bar = header(page);

    for (const name of ['Back', 'Forward']) {
      const button = bar.getByRole('button', { name });
      await expect(button).toBeVisible();
      expect(await hitsItself(button), `${name} hit at its centre`).toBe(true);
    }
    // Zoom, Print and Copy link: each its own control, or the overflow menu's trigger.
    const more = bar.getByRole('button', { name: 'More controls' });
    const inBar = {
      zoom: bar.getByRole('button', { name: 'Zoom out' }),
      print: bar.locator('[data-screen-action="print"]'),
      'copy link': bar.locator('[data-screen-action="copy-link"]'),
    };
    for (const [name, control] of Object.entries(inBar)) {
      const target = (await control.count()) > 0 ? control : more;
      await expect(target, name).toBeVisible();
      expect(await hitsItself(target), `${name} hit at its centre`).toBe(true);
    }
    await assertNoOverlap(page);

    // At this width they live in the menu, which escapes the clipping tile bar.
    await expect(more).toBeVisible();
    await more.click();
    const menu = page.getByRole('group', { name: 'Screen controls' });
    await expect(menu).toBeVisible();
    for (const control of [
      menu.getByRole('button', { name: 'Zoom out' }),
      menu.getByRole('button', { name: 'Zoom in' }),
      menu.locator('[data-screen-action="print"]'),
      menu.locator('[data-screen-action="copy-link"]'),
    ]) {
      expect(await hitsItself(control)).toBe(true);
    }
    const box = (await menu.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);

    // A zoom step from the menu zooms; ◀ in the bar still navigates back.
    const percent = menu.getByTestId('zoom-percent');
    const before = await percent.textContent();
    await menu.getByRole('button', { name: 'Zoom in' }).click();
    await expect(percent).not.toHaveText(before ?? '');
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await bar.getByRole('button', { name: 'Back' }).click();
    await expect(screenRoot(page)).toHaveAttribute('data-screen-id', 'e2e-panel');
  });

  test('no control overlaps another or leaves the bar at any width @embed', async ({ page }) => {
    await openWithHistory(page);
    for (const width of [320, 375, 475, 560, 680, 800, 1000]) {
      await headerWidth(page, width);
      await assertNoOverlap(page);
      for (const name of ['Back', 'Forward']) {
        expect(
          await hitsItself(header(page).getByRole('button', { name })),
          `${name} @${width}`
        ).toBe(true);
      }
    }
    // Wide again, every control is back in the bar.
    await expect(header(page).getByRole('group', { name: 'Zoom' })).toBeVisible();
    await expect(header(page).locator('[data-screen-action="print"]')).toBeVisible();
    await expect(header(page).getByRole('button', { name: 'More controls' })).toHaveCount(0);

    // A split-tile width: the actions go into the menu first, the zoom group stays.
    await headerWidth(page, 560);
    await expect(header(page).getByRole('group', { name: 'Zoom' })).toBeVisible();
    await expect(header(page).locator('[data-screen-action]')).toHaveCount(0);
    await expect(header(page).getByRole('button', { name: 'More controls' })).toBeVisible();
    await assertNoOverlap(page);
  });
});
