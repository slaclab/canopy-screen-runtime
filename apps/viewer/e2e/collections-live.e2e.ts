// Collections against a real canopy_mcp (liveCanopy.ts): the smoke that the
// stubbed collections.e2e.ts cannot give, run on the server from a canopy
// checkout ($CANOPY_SRC) with canopy's own facility fixtures (Control
// assistant default:true, Diagnostics, Injector, Storage ring), its fixture
// library, an empty personal store and the e2e Trace stub.
//
// One canopy_mcp is one user, so the tests run serially on one instance and
// state carries from test to test: the popover lists the facility collections
// (Control assistant ticked by its default), ticking Injector shows its branch,
// Open all Injector opens its members (no saved layout: side by side, a tile
// each), a pin survives a reload, and Save writes a personal file the server
// then lists.
//
// The library screens are literal `{}` documents: tabs are asserted by key,
// never by content.
//
// Skipped without CANOPY_SRC, unless REQUIRE_CANOPY_LIVE=1: then a missing or
// incomplete checkout fails every test, so a gate that requires the live run
// cannot pass by skipping it.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { dockLayout, layoutShape, tilesOf } from './dockHelpers';
import { jsonFiles, missingCanopy, startLiveCanopy, type LiveCanopy } from './liveCanopy';

const CANOPY_SRC = process.env.CANOPY_SRC;
const REQUIRE_CANOPY_LIVE = process.env.REQUIRE_CANOPY_LIVE === '1';
const MISSING = missingCanopy(CANOPY_SRC);
/** sessionStorage key of the open tabs at the root mount (src/storageScope.ts). */
const TABS_KEY = 'canopy-viewer:tabs:/';

const FACILITY = ['Control assistant', 'Diagnostics', 'Injector', 'Storage ring'];
const INJECTOR_SCREENS = ['library/linac/LinacView', 'library/xfer/TransferView'];
const PIN_KEY = 'library/sr/overview';
const SAVED_NAME = 'Live smoke';

interface Collection {
  id: string;
  name: string;
  source: string;
  ref: string;
  members: Record<string, unknown>[];
  layout?: unknown;
  refused?: string;
}

interface CollectionsState {
  ticked: string[];
  unticked: string[];
  pinned: { screen?: string; tool?: string }[];
  recent: unknown[];
}

let live: LiveCanopy | undefined;

const url = (path: string) => `${live!.origin}/${path}`;

async function collections(api: APIRequestContext): Promise<Collection[]> {
  const response = await api.get(url('collections'));
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { collections: Collection[] }).collections;
}

async function collectionsState(api: APIRequestContext): Promise<CollectionsState> {
  const response = await api.get(url('collections-state'));
  expect(response.ok()).toBe(true);
  return (await response.json()) as CollectionsState;
}

const tree = (page: Page) => page.getByRole('navigation', { name: 'Screens' });
const branch = (page: Page, kind: string) => page.locator(`li[data-branch="${kind}"]`);
const collectionBranch = (page: Page, ref: string) =>
  page.locator(`li[data-branch="collection"][data-collection-ref="${ref}"]`);
const allScreens = (page: Page) => branch(page, 'screens');
const leaf = (page: Page, key: string) =>
  page.locator(`li[data-group="screens"][data-screen-key="${key}"]`);
const trigger = (page: Page) => page.getByTestId('collections-popover-trigger');
const popover = (page: Page) => page.getByRole('group', { name: 'Collections' });

/** Every open key, tile by tile (the dock root's `data-layout`). */
async function tabKeys(page: Page): Promise<string[]> {
  return tilesOf(await dockLayout(page)).flatMap((t) => t.tabs);
}

/** Opens the workspace with no stored tabs (no first-visit data browser) and waits for the tree. */
async function openWorkspace(page: Page): Promise<void> {
  await page.addInitScript(
    ([key, value]) => {
      if (window === window.top && sessionStorage.getItem(key) === null) {
        sessionStorage.setItem(key, value);
      }
    },
    [TABS_KEY, JSON.stringify({ keys: [], active: null })] as const
  );
  await page.goto(url('embed/'));
  await expect(tree(page)).toBeVisible();
  await expect(allScreens(page)).toBeVisible();
}

async function openPopover(page: Page): Promise<void> {
  await trigger(page).click();
  await expect(trigger(page)).toHaveAttribute('aria-expanded', 'true');
  await expect(popover(page).getByRole('checkbox').first()).toBeVisible();
}

test.describe('collections on a live canopy_mcp', () => {
  test.describe.configure({ mode: 'serial', timeout: 30_000 });

  test.beforeAll(async () => {
    if (MISSING !== null) return;
    test.setTimeout(90_000);
    live = await startLiveCanopy(CANOPY_SRC!);
  });

  test.afterAll(async () => {
    await live?.stop();
    live = undefined;
  });

  test.beforeEach(() => {
    if (MISSING === null) return;
    if (REQUIRE_CANOPY_LIVE) throw new Error(`REQUIRE_CANOPY_LIVE=1 but ${MISSING}`);
    test.skip(true, MISSING);
  });

  test('the popover lists the fixture collections, the default one ticked', async ({
    page,
    request,
  }) => {
    const listed = await collections(request);
    expect(listed.map((c) => c.name)).toEqual(FACILITY);
    expect(listed.every((c) => c.source === 'facility')).toBe(true);

    await openWorkspace(page);
    await openPopover(page);
    const boxes = popover(page).getByRole('checkbox');
    await expect(boxes).toHaveCount(FACILITY.length);
    for (const name of FACILITY) {
      await expect(popover(page).getByRole('checkbox', { name, exact: true })).toHaveCount(1);
    }
    await expect(
      popover(page).getByRole('checkbox', { name: 'Control assistant', exact: true })
    ).toBeChecked();
    await expect(
      popover(page).getByRole('checkbox', { name: 'Injector', exact: true })
    ).not.toBeChecked();
    await page.keyboard.press('Escape');
    await expect(collectionBranch(page, 'facility:control-assistant')).toBeVisible();
  });

  test('ticking Injector shows its branch and reaches the server', async ({ page, request }) => {
    await openWorkspace(page);
    await expect(collectionBranch(page, 'facility:injector')).toHaveCount(0);
    await openPopover(page);
    // Carbon's input is visually hidden behind its label: click the label.
    await popover(page).locator('label', { hasText: 'Injector' }).first().click();
    await expect(
      popover(page).getByRole('checkbox', { name: 'Injector', exact: true })
    ).toBeChecked();
    await expect(collectionBranch(page, 'facility:injector')).toBeVisible();
    await expect
      .poll(async () => (await collectionsState(request)).ticked)
      .toContain('facility:injector');

    await page.reload();
    await expect(collectionBranch(page, 'facility:injector')).toBeVisible();
  });

  test('Open all Injector opens its members side by side, a tile each', async ({ page }) => {
    await openWorkspace(page);
    await openPopover(page);
    await page.getByRole('button', { name: 'Open all Injector' }).click();
    await expect(trigger(page)).toHaveAttribute('aria-expanded', 'false');
    await expect.poll(() => tabKeys(page)).toHaveLength(3);
    const layout = await dockLayout(page);
    const keys = await tabKeys(page);
    expect(keys).toEqual(expect.arrayContaining(INJECTOR_SCREENS));
    const trace = keys.filter((k) => k.startsWith('@trace'));
    expect(trace).toHaveLength(1);
    // Injector saves no layout, so Open all opens it side by side: a row of
    // three tiles in member order, one tab each, each showing its tab.
    expect(layoutShape(layout)).toBe(`row[${INJECTOR_SCREENS.join(',')},${trace[0]}]`);
    for (const tile of tilesOf(layout)) {
      expect(tile.tabs).toHaveLength(1);
      expect(tile.showing).toBe(tile.tabs[0]);
    }
    // Three tiles: each has its own tab bar, and there is no strip.
    await expect(page.locator('[data-testid="tile-bar"]')).toHaveCount(3);
    await expect(page.getByRole('tablist', { name: 'Open tabs' })).toHaveCount(0);
  });

  test('a pin is stored by the server and survives a reload', async ({ page, request }) => {
    await openWorkspace(page);
    if ((await allScreens(page).getAttribute('aria-expanded')) !== 'true') {
      await allScreens(page)
        .locator(':scope > .nav-tree__row [data-testid="nav-tree-chevron"]')
        .click();
    }
    const row = leaf(page, PIN_KEY).locator(':scope > .nav-tree__row');
    await row.hover();
    await row.getByRole('button', { name: 'Pin' }).click();
    await expect(branch(page, 'pinned')).toBeVisible();
    await expect
      .poll(async () => (await collectionsState(request)).pinned)
      .toEqual([{ screen: PIN_KEY }]);

    await page.reload();
    await expect(
      branch(page, 'pinned').locator(`li[data-member-key="screen:${PIN_KEY}"]`)
    ).toBeVisible();
  });

  test('Save writes a personal collection file the server lists', async ({ page, request }) => {
    expect(await jsonFiles(live!.collectionsDir)).toEqual([]);
    // The open tabs are the session's: Open all Injector gives this page some to save.
    await openWorkspace(page);
    await openPopover(page);
    await page.getByRole('button', { name: 'Open all Injector' }).click();
    await expect.poll(() => tabKeys(page)).toHaveLength(3);

    await openPopover(page);
    await popover(page).getByRole('button', { name: 'Save open tabs as collection…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Save open tabs as collection' });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Name').fill(SAVED_NAME);
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toBeHidden();

    await expect
      .poll(async () =>
        (await collections(request)).filter((c) => c.source === 'personal').map((c) => c.name)
      )
      .toEqual([SAVED_NAME]);
    const saved = (await collections(request)).find((c) => c.name === SAVED_NAME)!;
    expect(saved.ref).toBe(`personal:${saved.id}`);
    expect(await jsonFiles(live!.collectionsDir)).toEqual([`${saved.id}.json`]);
    expect(existsSync(join(live!.collectionsDir, `${saved.id}.json`))).toBe(true);

    await openPopover(page);
    await expect(
      popover(page).getByRole('checkbox', { name: SAVED_NAME, exact: true })
    ).toHaveCount(1);
  });
});
