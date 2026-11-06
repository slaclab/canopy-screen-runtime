// Saved data browser views in a browser: save the data browser's view from
// its tile bar, find it under Tools -> Data Browser, reopen it into Trace
// from a screen tab, and delete it. The e2e server keeps views in memory with
// canopy_mcp's contract; every spec uses its own names, because the specs run
// in parallel against one server.

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { tileBar } from './dockHelpers';

const PREFIX = '/x/y/';
// The workspace keeps its tabs under a key scoped to the mount path
// (src/storageScope.ts); under /x/y that is `canopy-viewer:tabs:/x/y`.
const TABS = 'canopy-viewer:tabs:/x/y';

const tree = (page: Page) => page.getByRole('navigation', { name: 'Screens' });
const traceIframe = (page: Page) => page.locator('iframe.workspace-trace');
const viewItem = (page: Page, name: string) =>
  tree(page).getByRole('treeitem', { name, exact: true });
/** Save view sits in the data browser's own tile bar, the status beside it. */
const saveView = (page: Page) => tileBar(page, '@trace').getByRole('button', { name: 'Save view' });

async function seedTraceTab(page: Page, query: string) {
  await page.addInitScript(
    ([key, value]) => {
      if (window === window.top && sessionStorage.getItem(key) === null) {
        sessionStorage.setItem(key, value);
      }
    },
    [
      TABS,
      JSON.stringify({ keys: ['@trace'], active: '@trace', instances: { '@trace': { query } } }),
    ] as const
  );
}

test.describe('saved data browser views', () => {
  test('save from the tile bar, reopen from the tree, delete @trace', async ({ page }, info) => {
    const name = `E2E view ${info.workerIndex}-${Date.now()}`;
    await seedTraceTab(page, 'pv=E2E:SAVED&range=-6h');
    await page.goto(`${PREFIX}embed/@trace`);
    await expect(traceIframe(page)).toBeVisible();

    // Save the data browser's current view: the bar's button is the only one.
    await expect(page.getByRole('button', { name: 'Save view' })).toHaveCount(1);
    await saveView(page).click();
    await page.getByLabel('Name').fill(name);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(tileBar(page, '@trace').getByTestId('save-view-status')).toContainText(name);
    await expect(viewItem(page, name)).toBeVisible();
    await expect(viewItem(page, name)).toHaveAttribute('aria-selected', 'true');

    // From a screen tab, the view reopens the data browser with its query.
    await page.goto(`${PREFIX}embed/drafts/e2e-panel`);
    await expect(page.getByRole('button', { name: 'Save view' })).toHaveCount(0);
    await viewItem(page, name).locator(':scope > .nav-tree__row').click();
    await expect(page).toHaveURL(new RegExp(`${PREFIX}embed/@trace$`));
    const src = new URL((await traceIframe(page).getAttribute('src')) ?? '', page.url());
    expect(src.searchParams.getAll('pv')).toEqual(['E2E:SAVED']);
    expect(src.searchParams.get('range')).toBe('-6h');

    // Delete it from its menu, after the confirmation.
    await viewItem(page, name).locator(':scope > .nav-tree__row').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Delete view…' }).click();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(viewItem(page, name)).toHaveCount(0);
    const listed = await page.evaluate(async (prefix) => {
      const response = await fetch(`${prefix}views`);
      return ((await response.json()) as { views: { name: string }[] }).views.map((v) => v.name);
    }, PREFIX);
    expect(listed).not.toContain(name);
  });

  test('a view keeps the axis settings Trace reported @trace', async ({ page }, info) => {
    // Not "e2e", "data", "browser" or "trace": other specs search the tree for those.
    const name = `Axes kept ${info.workerIndex}-${Date.now()}`;
    await seedTraceTab(page, 'pv=E2E:AXES:A&range=-1h');
    await page.goto(`${PREFIX}embed/@trace`);
    await expect(traceIframe(page)).toBeVisible();

    // Trace reports the operator's second, logarithmic axis.
    const plot = '{"v":1,"axes":[{},{"name":"I","logScale":true}],"traces":[{},{"axis":1}]}';
    const query = `pv=E2E:AXES:A&pv=E2E:AXES:B&range=-1h&plot=${encodeURIComponent(plot)}`;
    const frame = page.frames().find((f) => f.url().includes('/trace/'));
    if (!frame) throw new Error('no Trace frame');
    await frame.evaluate(
      (q) => (window as unknown as { __postQuery: (q: string) => void }).__postQuery(q),
      query
    );
    await expect
      .poll(() =>
        page.evaluate(
          (key) => JSON.parse(sessionStorage.getItem(key) ?? '{}').instances?.['@trace']?.query,
          TABS
        )
      )
      .toBe(query);

    await saveView(page).click();
    await expect(page.getByText('the axis settings')).toBeVisible();
    await page.getByLabel('Name').fill(name);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(viewItem(page, name)).toBeVisible();

    // Reopened from a screen tab, Trace's frame gets the settings back.
    await page.goto(`${PREFIX}embed/drafts/e2e-panel`);
    await viewItem(page, name).locator(':scope > .nav-tree__row').click();
    await expect(page).toHaveURL(new RegExp(`${PREFIX}embed/@trace$`));
    const src = new URL((await traceIframe(page).getAttribute('src')) ?? '', page.url());
    expect(src.searchParams.getAll('pv')).toEqual(['E2E:AXES:A', 'E2E:AXES:B']);
    expect(src.searchParams.get('plot')).toBe(plot);

    // Leave the shared server as it was.
    await page.evaluate(
      async ([prefix, id]) => {
        await fetch(`${prefix}views/${id}`, { method: 'DELETE' });
      },
      [PREFIX, name.toLowerCase().replace(/[^a-z0-9]+/g, '-')] as const
    );
  });

  test('an empty data browser has nothing to save @trace', async ({ page }) => {
    await seedTraceTab(page, '');
    await page.goto(`${PREFIX}embed/@trace`);
    await expect(saveView(page)).toBeDisabled();
  });
});
