// Clickable screen areas and Fit. A node with click actions shows a pointer
// cursor; hovering it draws an accent fill and outline and its hoverLabel; a
// click opens its target. Its resting outline (`outlineColor`) is tinted by a
// rule from live data, here served by fixture mode (one snapshot per alarm
// level). Fit fills a large tile: the screen magnifies above 100%.

import { expect, test, type Page } from '@playwright/test';
import { canopyDefaultFlat, parseFlatScheme } from '@slaclab/canopy-screen-ir';
import type { FlatScheme } from '@slaclab/canopy-screen-ir';

const PREFIX = '/x/y/';
const SCREEN = 'drafts/hover-panel';
const AREA = '[data-node-id="section-area"]';
const LABEL = 'Open E2E Panel →';

/** Serve fixture key `alarm<level>` with the section's alarm PV at `level`. */
async function serveAlarm(page: Page, level: number): Promise<string> {
  const key = `alarm${level}`;
  await page.route(`**${PREFIX}__fixture/${key}.json`, (route) =>
    route.fulfill({ json: { timestamp: 1700000000, pvs: { 'HOV:SEC:ALARM': level } } })
  );
  return `?_canopyPv=fixture&_canopyFixture=${key}`;
}

/** The scheme the viewer renders with: config.colorScheme, else the default. */
async function servedScheme(page: Page): Promise<FlatScheme> {
  const response = await page.request.get(`${PREFIX}config.json`);
  expect(response.ok()).toBe(true);
  const config = (await response.json()) as { colorScheme?: unknown };
  if (config.colorScheme === undefined || config.colorScheme === null) return canopyDefaultFlat;
  const parsed = parseFlatScheme(config.colorScheme);
  if ('error' in parsed) throw new Error(`served colorScheme is invalid: ${parsed.error}`);
  return parsed;
}

/** A role's light-theme colour in the computed-style form, 'rgb(r, g, b)'. */
function roleRgb(scheme: FlatScheme, role: string): string {
  const i = scheme.roles.indexOf(role);
  expect(i, `role ${role} in the scheme`).toBeGreaterThanOrEqual(0);
  const hex = scheme.light[i]!;
  const n = (at: number) => parseInt(hex.slice(at, at + 2), 16);
  return `rgb(${n(1)}, ${n(3)}, ${n(5)})`;
}

const outlineColor = (page: Page) =>
  page.locator(AREA).evaluate((el) => getComputedStyle(el).outlineColor);

test.describe('clickable areas', () => {
  test('hover highlights the area and shows its label; a click opens the target', async ({
    page,
  }) => {
    await page.goto(`${PREFIX}s/${SCREEN}${await serveAlarm(page, 0)}`);
    const area = page.locator(AREA);
    await expect(area).toBeVisible();
    expect(await area.evaluate((el) => getComputedStyle(el).cursor)).toBe('pointer');
    await expect(page.getByText(LABEL)).toHaveCount(0);
    await expect(area.locator('[data-canopy-hover]')).toHaveCount(0);

    await area.hover();
    await expect(page.getByText(LABEL)).toBeVisible();
    const layer = area.locator('[data-canopy-hover]');
    await expect(layer).toBeVisible();
    // The label sits in the area's bottom-left corner, inside the box.
    const areaBox = (await area.boundingBox())!;
    const labelBox = (await page.getByText(LABEL).boundingBox())!;
    expect(labelBox.x).toBeGreaterThan(areaBox.x);
    expect(labelBox.x - areaBox.x).toBeLessThan(20);
    expect(labelBox.y + labelBox.height).toBeLessThan(areaBox.y + areaBox.height);
    expect(areaBox.y + areaBox.height - (labelBox.y + labelBox.height)).toBeLessThan(20);
    expect(await page.getByText(LABEL).evaluate((el) => getComputedStyle(el).pointerEvents)).toBe(
      'none'
    );
    // The accent is the scheme's ActiveText role.
    const accent = await layer.evaluate((el) => getComputedStyle(el).outlineColor);
    expect(accent).toBe(roleRgb(await servedScheme(page), 'ActiveText'));

    await page.mouse.move(2, 2);
    await expect(page.getByText(LABEL)).toHaveCount(0);

    await area.click();
    await expect(page.locator('[data-testid="screen-root"]')).toHaveAttribute(
      'data-screen-id',
      'e2e-panel'
    );
  });

  for (const [level, role] of [
    [0, 'OK'],
    [1, 'MINOR'],
    [2, 'MAJOR'],
  ] as const) {
    test(`the resting outline follows the alarm PV (level ${level}: ${role})`, async ({ page }) => {
      await page.goto(`${PREFIX}s/${SCREEN}${await serveAlarm(page, level)}`);
      await expect(page.locator(AREA)).toBeVisible();
      const expected = roleRgb(await servedScheme(page), role);
      await expect.poll(() => outlineColor(page)).toBe(expected);
      expect(await page.locator(AREA).evaluate((el) => getComputedStyle(el).outlineWidth)).toBe(
        '3px'
      );
    });
  }
});

test('a text label renders at its authored font size when the text fits its box', async ({
  page,
}) => {
  await page.goto(`${PREFIX}s/${SCREEN}${await serveAlarm(page, 0)}`);
  const label = page.locator('[data-node-id="section-label"]').getByText('Section');
  await expect(label).toBeVisible();
  // 'Section' at 18 px fits a 200 x 26 box: no shrink.
  await expect.poll(() => label.evaluate((el) => getComputedStyle(el).fontSize)).toBe('18px');
});

test.describe('Fit fills the tile', () => {
  test.use({ viewport: { width: 2400, height: 1300 } });

  test('a 400 x 200 screen magnifies above 100% at a 2400 x 1300 viewport', async ({ page }) => {
    await page.goto(`${PREFIX}embed/${SCREEN}${await serveAlarm(page, 0)}`);
    await expect(page.getByRole('button', { name: 'Fit' })).toHaveAttribute('aria-pressed', 'true');
    const percent = page.getByTestId('zoom-percent');
    await expect
      .poll(async () => parseInt((await percent.textContent()) ?? '0', 10))
      .toBeGreaterThan(100);
    const root = page.locator('[data-testid="screen-root"]');
    const box = (await root.boundingBox())!;
    // The width is the tighter axis: the screen spans the area less the padding.
    expect(box.width).toBeGreaterThan(2000);
    expect(box.width / box.height).toBeCloseTo(2, 1);

    // Hit-testing follows the transform: the magnified area still opens on click.
    await page.locator(AREA).hover();
    await expect(page.getByText(LABEL)).toBeVisible();

    // 100% is still the authored size.
    await page.getByRole('button', { name: 'Actual size' }).click();
    await expect(percent).toHaveText('100%');
    await expect.poll(async () => Math.round((await root.boundingBox())!.width)).toBe(400);
  });
});
