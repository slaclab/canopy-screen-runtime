// Multi-instance tool tabs in a browser, against the e2e server's
// stub pages (the correlation tool is the Trace stub served at
// trace/correlation.html): two correlation instances side by side survive a
// reload, '+' opens a blank instance, a Trace view saved before views had a
// kind still opens in the data browser, and a saved correlation view reopens
// in a correlation tab. The waveform tool (the same stub at
// trace/waveform.html) opens from the tree, saves and reopens a view, and
// answers a frame's canopy:trace-open (posted through the stub's
// __postTraceOpen): a new @waveform instance, at the cap a load into the most
// recently used one, and with Waveform unconfigured a notice. Specs run in
// parallel against one in-memory server, so every view name and probe is
// unique.

import { expect, test } from '@playwright/test';
import type { Frame, Page } from '@playwright/test';
import { tileBar } from './dockHelpers';

const PREFIX = '/x/y/';
// The workspace keeps its tabs under a key scoped to the mount path
// (src/storageScope.ts); under /x/y that is `canopy-viewer:tabs:/x/y`.
const TABS = 'canopy-viewer:tabs:/x/y';

test.describe.configure({ timeout: 15_000 });

const tree = (page: Page) => page.getByRole('navigation', { name: 'Screens' });
const toolFrame = (page: Page, key: string) => page.locator(`iframe[data-tab-key="${key}"]`);
const viewItem = (page: Page, name: string) =>
  tree(page).getByRole('treeitem', { name, exact: true });

async function contentFrame(page: Page, key: string): Promise<Frame> {
  const handle = await toolFrame(page, key).elementHandle();
  const frame = await handle?.contentFrame();
  if (!frame) throw new Error(`no frame for ${key}`);
  await frame.waitForFunction(() => '__postQuery' in window);
  return frame;
}

async function postQuery(page: Page, key: string, query: string) {
  const frame = await contentFrame(page, key);
  await frame.evaluate(
    (q) => (window as unknown as { __postQuery: (q: string) => void }).__postQuery(q),
    query
  );
}

async function postTraceOpen(page: Page, key: string, tool: string, query: string) {
  const frame = await contentFrame(page, key);
  await frame.waitForFunction(() => '__postTraceOpen' in window);
  await frame.evaluate(
    ([t, q]) =>
      (window as unknown as { __postTraceOpen: (t: string, q: string) => void }).__postTraceOpen(
        t,
        q
      ),
    [tool, query] as const
  );
}

function srcOf(page: Page, key: string): Promise<URL> {
  return toolFrame(page, key)
    .getAttribute('src')
    .then((src) => new URL(src ?? '', page.url()));
}

const plus = (page: Page, label: string) =>
  tree(page).getByRole('button', { name: `New ${label} tab` });

/** The tree's entry for tool `key` (its row, not its saved views). */
const toolRow = (page: Page, key: string) =>
  tree(page).locator(`[data-screen-key="${key}"] > .nav-tree__row`);

/** The workspace's notice (the dock has its own live region, also a status). */
const notice = (page: Page) => page.locator('.workspace__notice[role="status"]');

/** The key of the focused tab, from the URL. */
const activeKey = (page: Page) => new URL(page.url()).pathname.slice(`${PREFIX}embed/`.length);

const stored = (page: Page) =>
  page.evaluate((key) => JSON.parse(sessionStorage.getItem(key) ?? 'null'), TABS);

test('two correlation instances side by side survive a reload', async ({ page }, info) => {
  const tag = `${info.workerIndex}-${Date.now()}`;
  await page.goto(`${PREFIX}embed/drafts/e2e-panel`);
  await plus(page, 'Correlation').click();
  await plus(page, 'Correlation').click();
  await expect(page).toHaveURL(new RegExp(`${PREFIX}embed/@correlation/2$`));
  await expect(page.getByRole('tab')).toHaveCount(3);

  // '+' is blank: nothing but the embed parameters.
  const blank = await srcOf(page, '@correlation/2');
  expect(blank.pathname).toBe(`${PREFIX}trace/correlation.html`);
  expect([...blank.searchParams.keys()].sort()).toEqual(['embedded', 'theme']);

  await postQuery(page, '@correlation', `x=PROBE:one-${tag}&y=B`);
  await postQuery(page, '@correlation/2', `x=PROBE:two-${tag}&y=C&y=D`);
  await expect
    .poll(async () => (await stored(page))?.instances?.['@correlation/2']?.query)
    .toBe(`x=PROBE:two-${tag}&y=C&y=D`);

  await page.reload();
  await expect(page.getByRole('tab')).toHaveCount(3);
  await expect(page).toHaveURL(new RegExp(`${PREFIX}embed/@correlation/2$`));
  expect((await srcOf(page, '@correlation')).searchParams.get('x')).toBe(`PROBE:one-${tag}`);
  expect((await srcOf(page, '@correlation/2')).searchParams.getAll('y')).toEqual(['C', 'D']);
  // Each stub page runs its own instance (its probe comes from its own x=).
  const second = await contentFrame(page, '@correlation/2');
  await expect(second.locator('#probe')).toHaveText(`two-${tag}`);
  // Only the active instance is shown; the other stays mounted behind it.
  await expect(toolFrame(page, '@correlation/2')).toBeVisible();
  await expect(toolFrame(page, '@correlation')).toBeHidden();
});

test('a Trace view saved without a kind opens in the data browser', async ({ page }, info) => {
  const name = `Legacy view ${info.workerIndex}-${Date.now()}`;
  await page.goto(`${PREFIX}embed/drafts/e2e-panel`);
  await page.evaluate(
    async ([prefix, viewName]) => {
      const id = viewName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      await fetch(`${prefix}views/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: viewName, query: 'pv=E2E:LEGACY&range=-2h' }),
      });
    },
    [PREFIX, name] as const
  );
  await page.reload();
  const browser = tree(page).locator('[data-screen-key="@trace"]');
  await expect(browser.getByRole('treeitem', { name, exact: true })).toBeVisible();
  await viewItem(page, name).locator(':scope > .nav-tree__row').click();
  await expect(page).toHaveURL(new RegExp(`${PREFIX}embed/@trace(/\\d+)?$`));
  const key = new URL(page.url()).pathname.slice(`${PREFIX}embed/`.length);
  const src = await srcOf(page, key);
  expect(src.pathname).toBe(`${PREFIX}trace/`);
  expect(src.searchParams.getAll('pv')).toEqual(['E2E:LEGACY']);
});

test('a saved correlation view reopens in a correlation tab', async ({ page }, info) => {
  const name = `Corr view ${info.workerIndex}-${Date.now()}`;
  const query = `x=PROBE:saved-${info.workerIndex}&y=E2E:Y1&y=E2E:Y2`;
  await page.goto(`${PREFIX}embed/drafts/e2e-panel`);
  await plus(page, 'Correlation').click();
  await expect(page).toHaveURL(/\/embed\/@correlation(\/\d+)?$/);
  const key = new URL(page.url()).pathname.slice(`${PREFIX}embed/`.length);
  await postQuery(page, key, query);
  await expect.poll(async () => (await stored(page))?.instances?.[key]?.query).toBe(query);

  // Save view sits in the instance's own tile bar.
  await tileBar(page, key).getByRole('button', { name: 'Save view' }).click();
  await expect(page.getByText('Save Correlation view')).toBeVisible();
  await expect(
    page.getByText('2 Y PVs, listed for everyone under Tools → Correlation.')
  ).toBeVisible();
  await page.getByLabel('Name').fill(name);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(tileBar(page, key).getByTestId('save-view-status')).toContainText(name);
  const corr = tree(page).locator('[data-screen-key="@correlation"]');
  await expect(corr.getByRole('treeitem', { name, exact: true })).toBeVisible();

  // Close the tab, then reopen the view from the tree.
  await page
    .getByRole('tab', { name })
    .getByRole('button', { name: `Close ${name}` })
    .click();
  await expect(toolFrame(page, key)).toHaveCount(0);
  await viewItem(page, name).locator(':scope > .nav-tree__row').click();
  await expect(page).toHaveURL(/\/embed\/@correlation(\/\d+)?$/);
  const reopened = new URL(page.url()).pathname.slice(`${PREFIX}embed/`.length);
  const src = await srcOf(page, reopened);
  expect(src.pathname).toBe(`${PREFIX}trace/correlation.html`);
  expect(src.searchParams.getAll('y')).toEqual(['E2E:Y1', 'E2E:Y2']);
  await expect(page.getByRole('tab', { name })).toBeVisible();
});

test('the Waveform Plot entry opens a waveform tab', async ({ page }) => {
  await page.goto(`${PREFIX}embed/drafts/e2e-panel`);
  await expect(toolRow(page, '@waveform')).toHaveText('Waveform Plot');
  await toolRow(page, '@waveform').click();
  await expect(page).toHaveURL(new RegExp(`${PREFIX}embed/@waveform$`));
  const src = await srcOf(page, '@waveform');
  expect(src.pathname).toBe(`${PREFIX}trace/waveform.html`);
  expect([...src.searchParams.keys()].sort()).toEqual(['embedded', 'theme']);
  await expect(toolFrame(page, '@waveform')).toBeVisible();
});

test('a saved waveform view survives a reload and reopens', async ({ page }, info) => {
  const tag = `${info.workerIndex}-${Date.now()}`;
  const name = `Wave view ${tag}`;
  const query = `pv=PROBE:wave-${tag}`;
  await page.goto(`${PREFIX}embed/drafts/e2e-panel`);
  await plus(page, 'Waveform').click();
  await expect(page).toHaveURL(/\/embed\/@waveform(\/\d+)?$/);
  const key = activeKey(page);
  await postQuery(page, key, query);
  await expect.poll(async () => (await stored(page))?.instances?.[key]?.query).toBe(query);

  await tileBar(page, key).getByRole('button', { name: 'Save view' }).click();
  await expect(page.getByText('Save Waveform view')).toBeVisible();
  await expect(page.getByText('1 PV, listed for everyone under Tools → Waveform.')).toBeVisible();
  await page.getByLabel('Name').fill(name);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(tileBar(page, key).getByTestId('save-view-status')).toContainText(name);

  await page.reload();
  const wave = tree(page).locator('[data-screen-key="@waveform"]');
  await expect(wave.getByRole('treeitem', { name, exact: true })).toBeVisible();
  expect((await srcOf(page, key)).searchParams.getAll('pv')).toEqual([`PROBE:wave-${tag}`]);

  // Close the tab, then reopen the view from the tree.
  await page
    .getByRole('tab', { name })
    .getByRole('button', { name: `Close ${name}` })
    .click();
  await expect(toolFrame(page, key)).toHaveCount(0);
  await viewItem(page, name).locator(':scope > .nav-tree__row').click();
  await expect(page).toHaveURL(/\/embed\/@waveform(\/\d+)?$/);
  const src = await srcOf(page, activeKey(page));
  expect(src.pathname).toBe(`${PREFIX}trace/waveform.html`);
  expect(src.searchParams.getAll('pv')).toEqual([`PROBE:wave-${tag}`]);
  const frame = await contentFrame(page, activeKey(page));
  await expect(frame.locator('#probe')).toHaveText(`wave-${tag}`);
});

test('canopy:trace-open from a tool frame opens a waveform tab', async ({ page }, info) => {
  const pv = `PROBE:open-${info.workerIndex}-${Date.now()}`;
  await page.goto(`${PREFIX}embed/drafts/e2e-panel`);
  await toolRow(page, '@trace').click();
  await expect(page).toHaveURL(new RegExp(`${PREFIX}embed/@trace$`));
  await expect(toolFrame(page, '@waveform')).toHaveCount(0);

  await postTraceOpen(page, '@trace', 'waveform', `pv=${encodeURIComponent(pv)}`);
  await expect(toolFrame(page, '@waveform')).toHaveCount(1);
  await expect(page).toHaveURL(new RegExp(`${PREFIX}embed/@waveform$`));
  const src = await srcOf(page, '@waveform');
  expect(src.pathname).toBe(`${PREFIX}trace/waveform.html`);
  expect(src.searchParams.getAll('pv')).toEqual([pv]);
  // The data browser that asked is untouched.
  expect((await srcOf(page, '@trace')).pathname).toBe(`${PREFIX}trace/`);
});

test('canopy:trace-open at the instance cap loads into the most recent waveform tab', async ({
  page,
}, info) => {
  test.setTimeout(45_000);
  const pv = `PROBE:cap-${info.workerIndex}-${Date.now()}`;
  await page.goto(`${PREFIX}embed/drafts/e2e-panel`);
  for (let n = 1; n <= 10; n++) {
    await plus(page, 'Waveform').click();
    await expect(toolFrame(page, n === 1 ? '@waveform' : `@waveform/${n}`)).toHaveCount(1);
  }
  await expect(plus(page, 'Waveform')).toBeDisabled();

  // Focus instance 3 so the most recently used is not simply the newest,
  // then ask from the data browser.
  await page
    .getByRole('tab')
    .filter({ has: page.getByRole('button', { name: 'Close Waveform 3', exact: true }) })
    .click();
  await expect(page).toHaveURL(new RegExp(`${PREFIX}embed/@waveform/3$`));
  await toolRow(page, '@trace').click();
  await expect(page).toHaveURL(new RegExp(`${PREFIX}embed/@trace$`));

  await postTraceOpen(page, '@trace', 'waveform', `pv=${encodeURIComponent(pv)}`);
  await expect(notice(page)).toContainText('At most 10 Waveform tabs; loaded into Waveform 3');
  await expect
    .poll(async () => (await stored(page))?.instances?.['@waveform/3']?.query)
    .toBe(`pv=${encodeURIComponent(pv)}`);
  await expect
    .poll(async () => (await srcOf(page, '@waveform/3')).searchParams.getAll('pv'))
    .toEqual([pv]);
  // No eleventh instance.
  await expect(page.locator('iframe[data-tab-key^="@waveform"]')).toHaveCount(10);
});

test('canopy:trace-open for an unconfigured Waveform shows a notice', async ({ page }) => {
  await page.route(`**${PREFIX}config.json`, async (route) => {
    const response = await route.fetch();
    const config = (await response.json()) as Record<string, unknown>;
    delete config.waveform;
    await route.fulfill({ response, json: config });
  });
  await page.goto(`${PREFIX}embed/drafts/e2e-panel`);
  await toolRow(page, '@trace').click();
  await expect(page).toHaveURL(new RegExp(`${PREFIX}embed/@trace$`));
  await expect(toolRow(page, '@waveform')).toHaveCount(0);

  await postTraceOpen(page, '@trace', 'waveform', 'pv=E2E:WAVE');
  await expect(notice(page)).toContainText('Waveform is not available here');
  await expect(page.locator('iframe[data-tab-key^="@waveform"]')).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`${PREFIX}embed/@trace$`));
});
