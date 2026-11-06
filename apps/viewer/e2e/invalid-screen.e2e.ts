// A loaded document that fails the Screen IR contract renders beneath the
// invalid-screen notice; the notice sits above the zoom scroller, so the
// fitted screen still fits. The document is the existing e2e-panel draft,
// made invalid in transit: no fixture file and no manifest entry.

import { expect, test } from '@playwright/test';

const PREFIX = '/x/y/';

test('an invalid document renders beneath the notice, inside the fit', async ({ page }) => {
  await page.route('**/drafts/e2e-panel.screen.json', async (route) => {
    const response = await route.fetch();
    const doc = (await response.json()) as Record<string, unknown>;
    await route.fulfill({ response, json: { ...doc, notes: 'kept by hand' } });
  });
  await page.goto(`${PREFIX}embed/drafts/e2e-panel`);

  const notice = page.getByTestId('canopy-invalid-screen');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('e2e-panel.screen.json');
  await expect(notice).toContainText('must NOT have additional properties');

  const root = page.locator('.viewer-canvas [data-testid="screen-root"]');
  await expect(root).toBeVisible();
  const [rootBox, mainBox, noticeBox] = await Promise.all([
    root.boundingBox(),
    page.locator('main.viewer-content').boundingBox(),
    notice.boundingBox(),
  ]);
  expect(noticeBox!.y + noticeBox!.height).toBeLessThanOrEqual(mainBox!.y + 1);
  expect(rootBox!.y).toBeGreaterThanOrEqual(mainBox!.y);
  expect(rootBox!.y + rootBox!.height).toBeLessThanOrEqual(mainBox!.y + mainBox!.height + 1);
});
