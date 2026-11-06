// "Plot in Data Browser" in a browser: the screen header action lists the
// screen's PVs, embedded screens included with their macros expanded, in a
// chooser that preselects the readbacks; Plot opens the data browser with the
// picked PVs. The fixture (plot-panel) has a readback, a setpoint, a loc://
// local and two embedded BPM screens (two readbacks and an LED each).

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const PREFIX = '/x/y/';
const PANEL = `${PREFIX}embed/drafts/plot-panel`;

const action = (page: Page) => page.locator('[data-screen-action="plot-data-browser"]');
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Plot in Data Browser' });
const box = (page: Page, pv: string) => dialog(page).getByLabel(pv, { exact: true });

test.describe('plot in data browser', () => {
  test('lists the screen PVs and plots the pick in the data browser @trace', async ({ page }) => {
    await page.goto(PANEL);
    await expect(page.getByTestId('screen-header-title')).toContainText('Plot Panel');
    await expect(action(page)).toHaveAccessibleName('Plot in Data Browser');
    await action(page).click();
    await expect(dialog(page)).toBeVisible();

    // One group per screen instance, embedded macros expanded; no loc:// local.
    await expect(dialog(page).getByText('Plot Panel (this screen)')).toBeVisible();
    await expect(dialog(page).getByText('BPM=E2E:BPM1')).toBeVisible();
    await expect(dialog(page).getByText('BPM=E2E:BPM2')).toBeVisible();
    await expect(dialog(page).getByText('loc://e2e_local')).toHaveCount(0);

    // The readbacks are preselected; the setpoint and the LEDs are offered.
    for (const pv of ['E2E:PLOT:CURRENT', 'E2E:BPM1:X', 'E2E:BPM1:Y', 'E2E:BPM2:X', 'E2E:BPM2:Y']) {
      await expect(box(page, pv)).toBeChecked();
    }
    for (const pv of ['E2E:PLOT:SETPOINT', 'E2E:BPM1:OK', 'E2E:BPM2:OK']) {
      await expect(box(page, pv)).not.toBeChecked();
    }
    await expect(dialog(page).getByTestId('plot-pvs-count')).toContainText('5 of 12 selected');

    // Narrow the list, change the pick there, then clear the search.
    await dialog(page).getByRole('searchbox').fill('bpm2');
    await expect(box(page, 'E2E:BPM1:X')).toHaveCount(0);
    await box(page, 'E2E:BPM2:Y').uncheck({ force: true });
    await box(page, 'E2E:BPM2:OK').check({ force: true });
    await dialog(page).getByRole('searchbox').fill('');
    await box(page, 'E2E:BPM1:Y').uncheck({ force: true });

    await dialog(page).getByRole('button', { name: 'Plot 4 PVs' }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`${PREFIX}embed/@trace$`));
    const iframe = page.locator('iframe.workspace-trace');
    await expect(iframe).toBeVisible();
    const src = new URL((await iframe.getAttribute('src')) ?? '', page.url());
    // Screen order, whatever order they were ticked in.
    expect(src.searchParams.getAll('pv')).toEqual([
      'E2E:PLOT:CURRENT',
      'E2E:BPM1:X',
      'E2E:BPM2:X',
      'E2E:BPM2:OK',
    ]);
    expect(src.searchParams.get('range')).toBe('-1h');
  });

  test('cancel leaves the screen open @trace', async ({ page }) => {
    await page.goto(PANEL);
    await action(page).click();
    await expect(box(page, 'E2E:PLOT:CURRENT')).toBeChecked();
    await dialog(page).getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`${PANEL}$`));
  });
});
