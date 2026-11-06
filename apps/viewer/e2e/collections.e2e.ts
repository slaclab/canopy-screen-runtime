// Collections in the workspace under /x/y/embed/ (see server.mjs): the
// Collections popover in the sidebar header, the collection, Pinned and Recent
// branches of the Browse tree, Open all and its layout, the `_canopyOpen` deep
// link, and the quick-open palette.
//
// Every test runs as its own e2e user (collectionsFixture.ts), whose store is
// reset before the test: the facility collections Control assistant,
// Diagnostics, Injector and Storage ring (no `default` unless the describe
// picks mode 'default', which keeps Control assistant's), the personal seed,
// and an empty state. The seeded screen members are library screens the e2e
// manifest does not list, so a test that opens members PUTs a collection of
// its own whose screens the manifest serves (fixtures/drafts/manifest.json).
//
// The state the server holds (ticked, unticked, pinned, recent) is read through
// the context's request client, which shares the page's user cookie.

import type { APIRequestContext, Frame, Locator, Page } from '@playwright/test';
import { expect, test, PREFIX } from './collectionsFixture';
import { dockedKeys, dockLayout, layoutKeys, layoutShape, seedTabs, stripTab } from './dockHelpers';

test.describe.configure({ timeout: 20_000 });

const TRACE_PATH = '/x/y/trace/';
const DOCK_KEY = 'canopy-workspace-dock:/x/y';
const SHOW_SUB_SCREENS = 'canopy-viewer:show-sub-screens';
const TREE_COLLAPSED = 'canopy-viewer:tree-collapsed';

interface Member {
  screen?: string;
  tool?: string;
  name?: string;
  query?: string;
  slot?: string;
}

interface CollectionsState {
  ticked: string[];
  unticked: string[];
  pinned: Member[];
  recent: Member[];
}

async function collectionsState(api: APIRequestContext): Promise<CollectionsState> {
  const response = await api.get(`${PREFIX}collections-state`);
  expect(response.ok()).toBe(true);
  return (await response.json()) as CollectionsState;
}

/** PUTs a personal collection for this test's user; its ref. */
async function putCollection(
  api: APIRequestContext,
  id: string,
  body: { name: string; members: Member[]; layout?: unknown; description?: string }
): Promise<string> {
  // Create only: the store refuses a PUT that states no precondition (428).
  const response = await api.put(`${PREFIX}collections/${id}`, {
    data: body,
    headers: { 'If-None-Match': '*' },
  });
  expect(response.status(), await response.text()).toBe(201);
  return `personal:${id}`;
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
const palette = (page: Page) => page.getByRole('dialog', { name: 'Quick open' });
const paletteInput = (page: Page) => page.getByRole('combobox', { name: 'Quick open' });
const paletteButton = (page: Page) => page.getByRole('button', { name: /^Quick open \(/ });
const treeSearch = (page: Page) => page.locator('#screen-tree-search');

/** The top-level branch labels of the Browse tree, in order. */
async function topBranches(page: Page): Promise<string[]> {
  return page
    .locator('[role="tree"] > [role="treeitem"] > .nav-tree__row .nav-tree__label')
    .allTextContents();
}

/** The strip's tab keys, in order. */
async function tabKeys(page: Page): Promise<string[]> {
  // Every open key the dock holds, tile by tile (one tile: the strip's order).
  return layoutKeys(await dockLayout(page));
}

/** The stored dock layout (the record's `grid` is dockview's toJSON), or null when none is stored. */
function storedGrid(page: Page): Promise<unknown> {
  return page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    return raw === null ? null : ((JSON.parse(raw) as { layout?: unknown }).layout ?? null);
  }, DOCK_KEY);
}

/** Waits until the stored layout is the live one (the debounced write landed); returns it. */
async function settledStore(page: Page): Promise<unknown> {
  await expect
    .poll(
      async () => {
        const stored = await storedGrid(page);
        // Through JSON, as the app stores it: toJSON() carries undefined members.
        const live: unknown = JSON.parse(JSON.stringify(await dockLayout(page)));
        return stored !== null && JSON.stringify(stored) === JSON.stringify(live);
      },
      { message: 'the stored layout settles on the live one' }
    )
    .toBe(true);
  return storedGrid(page);
}

/** Opens the workspace with no stored tabs (no first-visit data browser) and waits for the tree. */
async function openWorkspace(page: Page, query = ''): Promise<void> {
  await seedTabs(page, { keys: [], active: null });
  await page.goto(`${PREFIX}embed/${query}`);
  await expect(tree(page)).toBeVisible();
  await expect(allScreens(page)).toBeVisible();
}

async function openPopover(page: Page): Promise<void> {
  await trigger(page).click();
  await expect(trigger(page)).toHaveAttribute('aria-expanded', 'true');
  await expect(popover(page).getByRole('checkbox').first()).toBeVisible();
}

/** Ticks or unticks `name` in the popover, which stays open. */
async function setTicked(page: Page, name: string, ticked: boolean): Promise<void> {
  const box = popover(page).getByRole('checkbox', { name, exact: true });
  // Carbon's input is visually hidden behind its label: click the label.
  await popover(page).locator('label', { hasText: name }).first().click();
  if (ticked) await expect(box).toBeChecked();
  else await expect(box).not.toBeChecked();
}

/** Clicks the chevron of `item`'s own row. */
async function toggleBranch(item: Locator): Promise<void> {
  await item.locator(':scope > .nav-tree__row [data-testid="nav-tree-chevron"]').click();
}

function traceFrame(page: Page): Frame | undefined {
  return page.frames().find((f) => {
    try {
      return new URL(f.url()).pathname === TRACE_PATH;
    } catch {
      return false;
    }
  });
}

test.describe('collections popover', () => {
  test('keyboard: focus enters on open, Tab walks the row, Esc returns to the trigger', async ({
    page,
  }) => {
    await openWorkspace(page);
    await openPopover(page);
    const first = popover(page).locator('li.collections-popover__row').first();
    await expect(first).toHaveAttribute('data-collection-ref', 'facility:control-assistant');
    await expect(first.getByRole('checkbox', { name: 'Control assistant' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Open all Control assistant' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(popover(page).getByRole('checkbox', { name: 'Diagnostics' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(trigger(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(trigger(page)).toBeFocused();
    await expect(popover(page).getByRole('checkbox')).toHaveCount(0);
  });

  test('tick and untick from the keyboard show and hide the branch and reach the store', async ({
    page,
    collectionsApi,
  }) => {
    await openWorkspace(page);
    await expect(collectionBranch(page, 'facility:control-assistant')).toHaveCount(0);
    await openPopover(page);
    const box = popover(page).getByRole('checkbox', { name: 'Control assistant' });
    await expect(box).toBeFocused();

    await page.keyboard.press('Space');
    await expect(box).toBeChecked();
    await expect(collectionBranch(page, 'facility:control-assistant')).toBeVisible();
    await expect
      .poll(async () => (await collectionsState(collectionsApi)).ticked)
      .toContain('facility:control-assistant');

    await page.keyboard.press('Space');
    await expect(box).not.toBeChecked();
    await expect(collectionBranch(page, 'facility:control-assistant')).toHaveCount(0);
    await expect
      .poll(async () => (await collectionsState(collectionsApi)).ticked)
      .not.toContain('facility:control-assistant');

    // The popover is never persisted: it starts closed after a reload.
    await page.reload();
    await expect(allScreens(page)).toBeVisible();
    await expect(trigger(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(collectionBranch(page, 'facility:control-assistant')).toHaveCount(0);
  });
});

test.describe('All screens collapse rule', () => {
  // All screens is expanded unless the operator collapses it; showing a
  // collection never collapses it, and a search always shows it.
  test('stays expanded when collections are shown; a manual collapse holds across selection changes and is forgotten on reload', async ({
    page,
  }) => {
    await openWorkspace(page);
    await expect(allScreens(page)).toHaveAttribute('aria-expanded', 'true');
    await expect(leaf(page, 'drafts/e2e-panel')).toBeVisible();

    await openPopover(page);
    await setTicked(page, 'Injector', true);
    await expect(collectionBranch(page, 'facility:injector')).toBeVisible();
    await expect(allScreens(page)).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Escape');

    // A manual collapse holds through a refetch and a selection change...
    await toggleBranch(allScreens(page));
    await expect(allScreens(page)).toHaveAttribute('aria-expanded', 'false');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(allScreens(page)).toHaveAttribute('aria-expanded', 'false');
    await openPopover(page);
    await setTicked(page, 'Diagnostics', true);
    await expect(allScreens(page)).toHaveAttribute('aria-expanded', 'false');
    await page.keyboard.press('Escape');

    // ...a search shows it while the query stands...
    await treeSearch(page).fill('e2e');
    await expect(allScreens(page)).toHaveAttribute('aria-expanded', 'true');
    await treeSearch(page).fill('');
    await expect(allScreens(page)).toHaveAttribute('aria-expanded', 'false');

    // ...and it is never stored: forgotten on reload.
    await page.reload();
    await expect(collectionBranch(page, 'facility:injector')).toBeVisible();
    await expect(allScreens(page)).toHaveAttribute('aria-expanded', 'true');
  });

  test.describe('with a facility default', () => {
    test.use({ collectionsMode: 'default' });

    test('the default collection is shown and All screens starts expanded', async ({ page }) => {
      await openWorkspace(page);
      await expect(collectionBranch(page, 'facility:control-assistant')).toBeVisible();
      await expect(allScreens(page)).toHaveAttribute('aria-expanded', 'true');
      await openPopover(page);
      await expect(
        popover(page).getByRole('checkbox', { name: 'Control assistant' })
      ).toBeChecked();
    });
  });
});

test.describe('Pinned', () => {
  test('Pinned is always first; pinning with nothing ticked replaces its placeholder', async ({
    page,
    collectionsApi,
  }) => {
    await openWorkspace(page);
    // Pinned always renders, with an inert placeholder while empty.
    await expect.poll(() => topBranches(page)).toEqual(['Pinned', 'Tools', 'All screens']);
    await expect(branch(page, 'pinned')).toContainText('Pin a screen with ☆');
    const row = leaf(page, 'drafts/e2e-panel');
    await row.locator(':scope > .nav-tree__row').hover();
    await row.locator(':scope > .nav-tree__row').getByRole('button', { name: 'Pin' }).click();

    await expect(branch(page, 'pinned')).toBeVisible();
    await expect.poll(() => topBranches(page)).toEqual(['Pinned', 'Tools', 'All screens']);
    await expect(
      branch(page, 'pinned').locator('li[data-member-key="screen:drafts/e2e-panel"]')
    ).toBeVisible();
    await expect(branch(page, 'pinned')).not.toContainText('Pin a screen with ☆');
    await expect
      .poll(async () => (await collectionsState(collectionsApi)).pinned)
      .toEqual([{ screen: 'drafts/e2e-panel' }]);
    expect((await collectionsState(collectionsApi)).ticked).toEqual([]);

    // The pin is the store's, so it survives a reload.
    await page.reload();
    await expect(branch(page, 'pinned')).toBeVisible();
  });
});

test.describe('Open all', () => {
  // The layout's collection form: tiles list member indexes, no tile ids.
  const LAYOUT = {
    split: 'row',
    items: [{ tabs: [0] }, { split: 'column', items: [{ tabs: [1] }, { tabs: [2] }] }],
  };
  const MEMBERS: Member[] = [
    { screen: 'drafts/e2e-panel' },
    { screen: 'drafts/plot-panel' },
    { tool: 'trace', name: 'E2E trace', query: 'pv=PROBE:open-all&range=-1h' },
  ];

  test('is idempotent across a reload, persists its layout and lands in Recent', async ({
    page,
    collectionsApi,
  }) => {
    await putCollection(collectionsApi, 'e2e-open', {
      name: 'E2E open',
      members: MEMBERS,
      layout: LAYOUT,
    });
    await openWorkspace(page);
    await openPopover(page);
    await page.getByRole('button', { name: 'Open all E2E open' }).click();
    // Open all closes the popover.
    await expect(trigger(page)).toHaveAttribute('aria-expanded', 'false');

    await expect.poll(() => tabKeys(page)).toHaveLength(3);
    const keys = await tabKeys(page);
    expect(keys).toEqual(expect.arrayContaining(['drafts/e2e-panel', 'drafts/plot-panel']));
    expect(keys.filter((k) => k.startsWith('@trace'))).toHaveLength(1);
    // The collection's layout, member by member: A | (B over C), every member showing.
    expect(layoutShape(await dockLayout(page))).toBe(
      `row[${keys[0]},column[${keys[1]},${keys[2]}]]`
    );
    expect((await dockedKeys(page)).sort()).toEqual([...keys].sort());
    const stored = await settledStore(page);

    // Reload: the layout comes back from the store.
    await page.reload();
    await expect(page.locator('[data-testid="tile-bar"]')).toHaveCount(3);
    await expect.poll(() => tabKeys(page)).toEqual(keys);
    await expect
      .poll(async () => JSON.parse(JSON.stringify(await dockLayout(page))) as unknown)
      .toEqual(stored);

    // Open all again changes no key: no duplicate tab, no second Trace instance.
    await openPopover(page);
    await page.getByRole('button', { name: 'Open all E2E open' }).click();
    // A negative window: the keys stay exactly these on every sample for 1.5 s,
    // so a duplicate tab or a second Trace that arrives late is still seen.
    for (let i = 0; i < 15; i += 1) {
      expect(await tabKeys(page), `tab keys, sample ${i}`).toEqual(keys);
      expect((await dockedKeys(page)).sort(), `docked keys, sample ${i}`).toEqual([...keys].sort());
      await page.waitForTimeout(100);
    }
    expect(await settledStore(page)).toEqual(stored);

    // Recent is history, so Open all's members land in it, each once.
    const recent = (await collectionsState(collectionsApi)).recent;
    expect(recent).toHaveLength(3);
    expect(recent).toEqual(
      expect.arrayContaining([
        { screen: 'drafts/e2e-panel' },
        { screen: 'drafts/plot-panel' },
        { tool: 'trace', name: 'E2E trace', query: 'pv=PROBE:open-all&range=-1h' },
      ])
    );
    await expect(branch(page, 'recent')).toBeVisible();
  });
});

test.describe('_canopyOpen deep link', () => {
  test('opens the collection once per load and leaves the URL; a closed member stays closed', async ({
    page,
    collectionsApi,
  }) => {
    const ref = await putCollection(collectionsApi, 'e2e-deep', {
      name: 'E2E deep',
      members: [{ screen: 'drafts/e2e-panel' }, { screen: 'lines/line-a/a' }],
    });
    // No seeded tabs: the deep link alone must suppress the first-visit data browser.
    await page.goto(`${PREFIX}embed/?_canopyOpen=${encodeURIComponent(ref)}`);
    await expect(tree(page)).toBeVisible();
    await expect.poll(() => tabKeys(page)).toEqual(['drafts/e2e-panel', 'lines/line-a/a']);
    await expect.poll(() => new URL(page.url()).searchParams.has('_canopyOpen')).toBe(false);

    await page.getByRole('button', { name: /^Close (tab: )?Alpha A$/ }).dispatchEvent('click');
    await expect.poll(() => tabKeys(page)).toEqual(['drafts/e2e-panel']);

    // A refetch on window focus does not run the deep link again.
    const refetch = page.waitForResponse(
      (r) => new URL(r.url()).pathname === `${PREFIX}collections`
    );
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await refetch;
    expect(await tabKeys(page)).toEqual(['drafts/e2e-panel']);

    await page.reload();
    await expect(stripTab(page, 'drafts/e2e-panel')).toBeVisible();
    expect(new URL(page.url()).searchParams.has('_canopyOpen')).toBe(false);
    await expect(tree(page)).toBeVisible();
    expect(await tabKeys(page)).toEqual(['drafts/e2e-panel']);
    // What the deep link opened is history, once (not again on reload).
    expect((await collectionsState(collectionsApi)).recent).toEqual(
      expect.arrayContaining([{ screen: 'drafts/e2e-panel' }, { screen: 'lines/line-a/a' }])
    );
    expect((await collectionsState(collectionsApi)).recent).toHaveLength(2);
  });
});

test.describe('quick open', () => {
  test('finds a named collection member of an unticked collection that the tree search does not', async ({
    page,
  }) => {
    await openWorkspace(page);
    await paletteButton(page).click();
    await expect(palette(page)).toBeVisible();
    await expect(paletteInput(page)).toBeFocused();
    await paletteInput(page).fill('Gun high');
    const member = palette(page).locator('[role="option"][data-kind="member"]', {
      hasText: 'Gun high voltage and heater',
    });
    await expect(member).toHaveCount(1);
    await expect(member).toContainText('Injector');
    await page.keyboard.press('Escape');
    await expect(palette(page)).toHaveCount(0);
    await expect(paletteButton(page)).toBeFocused();

    // Injector is not ticked, so the tree shows none of its members.
    await treeSearch(page).fill('Gun high');
    await expect(tree(page).getByText(/^No matches — try/)).toBeVisible();
    await expect(tree(page).locator('.screen-tree__empty-action')).toHaveText(/^Quick open \(/);
    await expect(
      tree(page).getByRole('treeitem', { name: 'Gun high voltage and heater' })
    ).toHaveCount(0);
  });

  test('lists no fragments while sub-screens are hidden', async ({ page }) => {
    await openWorkspace(page);
    await page.keyboard.press('ControlOrMeta+k');
    await expect(paletteInput(page)).toBeFocused();
    await paletteInput(page).fill('Panel');
    await expect(palette(page).getByRole('option', { name: /E2E Panel/ })).toHaveCount(1);
    await paletteInput(page).fill('Sub');
    await expect(palette(page).getByRole('option', { name: /Sub Screen/ })).toHaveCount(0);
    await paletteInput(page).fill('embedded/_sub');
    await expect(palette(page).getByRole('option')).toHaveCount(0);
    await expect(palette(page).getByText('No matches')).toBeVisible();
  });

  test('a canopy:quick-open posted from the Trace frame opens the palette', async ({ page }) => {
    await seedTabs(page, { keys: ['@trace'], active: '@trace' });
    await page.goto(`${PREFIX}embed/`);
    await expect(tree(page)).toBeVisible();
    await expect.poll(() => traceFrame(page) !== undefined).toBe(true);
    const frame = traceFrame(page)!;
    await frame.waitForLoadState();
    await frame.evaluate(() =>
      window.parent.postMessage({ type: 'canopy:quick-open' }, window.location.origin)
    );
    await expect(palette(page)).toBeVisible();
    await expect(paletteInput(page)).toBeFocused();
    // Opened from a tool frame, Esc hands focus to the tree search.
    await page.keyboard.press('Escape');
    await expect(palette(page)).toHaveCount(0);
    await expect(treeSearch(page)).toBeFocused();
  });
});

test.describe('browser keys', () => {
  test('are scoped to the mount, and an unscoped key is never read', async ({ page }) => {
    await page.addInitScript(
      ([sub, collapsed]) => {
        if (window !== window.top) return;
        localStorage.setItem(sub, '1');
        localStorage.setItem(collapsed, JSON.stringify(['branch:screens', 'folder:lines']));
      },
      [SHOW_SUB_SCREENS, TREE_COLLAPSED] as const
    );
    await openWorkspace(page);
    const read = (key: string) => page.evaluate((k) => localStorage.getItem(k), key);

    // The unscoped values are not read: sub-screens stay hidden, All screens open.
    const toggle = tree(page).getByRole('checkbox', { name: /^Show sub-screens/ });
    await expect(toggle).not.toBeChecked();
    await expect(allScreens(page)).toHaveAttribute('aria-expanded', 'true');
    expect(await read(`${SHOW_SUB_SCREENS}:/x/y`)).toBeNull();

    await tree(page)
      .locator('label', { hasText: /^Show sub-screens/ })
      .click();
    await expect(toggle).toBeChecked();
    await expect.poll(() => read(`${SHOW_SUB_SCREENS}:/x/y`)).toBe('1');

    const lines = allScreens(page).locator('li[role="treeitem"]', {
      has: page.locator(':scope > .nav-tree__row .nav-tree__label', { hasText: /^lines$/ }),
    });
    await expect(lines).toHaveAttribute('aria-expanded', 'true');
    await toggleBranch(lines);
    await expect(lines).toHaveAttribute('aria-expanded', 'false');
    await expect.poll(() => read(`${TREE_COLLAPSED}:/x/y`)).not.toBeNull();
    // ...nor written.
    expect(await read(SHOW_SUB_SCREENS)).toBe('1');
  });
});

// --- panel-browser-fixes: the user-facing criteria ---------------------------

/** Every listed collection (facility first, then personal), as GET /collections lists it. */
async function listed(
  api: APIRequestContext
): Promise<{ id: string; ref: string; name: string; rev: string; source: string }[]> {
  const response = await api.get(`${PREFIX}collections`);
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { collections: never[] }).collections;
}

/** The refs of the listed personal collections. */
async function personalRefs(api: APIRequestContext): Promise<string[]> {
  return (await listed(api)).filter((c) => c.source === 'personal').map((c) => c.ref);
}

const saveDialog = (page: Page) => page.locator('.cds--modal.is-visible');
const saveButton = (page: Page, name: string) =>
  saveDialog(page).locator('.cds--modal-footer').getByRole('button', { name, exact: true });
const toast = (page: Page) => page.getByTestId('canopy-toast');

/** Opens the Save dialog from the popover footer. */
async function openSaveDialog(page: Page): Promise<void> {
  await openPopover(page);
  await popover(page).getByRole('button', { name: 'Save open tabs as collection…' }).click();
  await expect(saveDialog(page)).toBeVisible();
  await expect(saveDialog(page)).toContainText('Save open tabs as collection');
}

/** Opens the workspace with `keys` open (the first active), and waits for the tree. */
async function openWithTabs(page: Page, keys: string[]): Promise<void> {
  await seedTabs(page, { keys, active: keys[0] ?? null });
  await page.goto(`${PREFIX}embed/`);
  await expect(tree(page)).toBeVisible();
  await expect(allScreens(page)).toBeVisible();
  for (const key of keys) await expect(stripTab(page, key)).toBeVisible();
}

test.describe('tree filter', () => {
  test('finds the Trace member of a ticked collection by its name', async ({ page }) => {
    await openWorkspace(page);
    await openPopover(page);
    await setTicked(page, 'Injector', true);
    await page.keyboard.press('Escape');
    const injector = collectionBranch(page, 'facility:injector');
    await expect(injector).toBeVisible();

    await treeSearch(page).fill('gun');
    const trace = injector.locator('li[data-member-key^="tool:trace"]');
    await expect(trace).toHaveCount(1);
    await expect(trace).toBeVisible();
    await expect(trace).toContainText('Gun high voltage and heater');
    // Its screen members do not match and drop out.
    await expect(injector.locator('li[data-member-key^="screen:"]')).toHaveCount(0);
    await expect(tree(page).getByText(/^No matches — try/)).toHaveCount(0);

    await treeSearch(page).fill('');
    await expect(injector.locator('li[data-member-key^="screen:"]').first()).toBeVisible();
  });
});

test.describe('narrow sidebar', () => {
  test('at the 180 px minimum every Open all of the popover lies in the viewport, unclipped', async ({
    page,
    collectionsApi,
  }) => {
    await openWorkspace(page);
    const splitter = page.getByRole('separator', { name: 'Resize screen browser' });
    await splitter.focus();
    await page.keyboard.press('Home');
    await expect
      .poll(() =>
        page.locator('aside.workspace__sidebar').evaluate((el) => el.getBoundingClientRect().width)
      )
      .toBeCloseTo(180, 0);

    await openPopover(page);
    const openAll = popover(page).getByRole('button', { name: /^Open all / });
    const expected = (await listed(collectionsApi)).length;
    await expect(openAll).toHaveCount(expected);
    expect(expected).toBeGreaterThan(0);
    for (let i = 0; i < expected; i += 1) {
      const button = openAll.nth(i);
      await button.scrollIntoViewIfNeeded();
      await expect(button).toBeVisible();
      const where = await button.evaluate((el) => {
        const box = el.getBoundingClientRect();
        const x = box.left + box.width / 2;
        const y = box.top + box.height / 2;
        const top = document.elementFromPoint(x, y);
        return {
          inViewport:
            box.width > 0 &&
            box.left >= 0 &&
            box.top >= 0 &&
            box.right <= window.innerWidth &&
            box.bottom <= window.innerHeight,
          // Nothing (the sidebar's clip, another row) covers its centre.
          onTop: top !== null && (top === el || el.contains(top)),
        };
      });
      expect(where, (await button.getAttribute('aria-label')) ?? undefined).toEqual({
        inViewport: true,
        onTop: true,
      });
    }
  });
});

test.describe('delete with Undo', () => {
  test('Delete removes at once; Undo restores the collection and ticks it again', async ({
    page,
    collectionsApi,
  }) => {
    await openWorkspace(page);
    await openPopover(page);
    await setTicked(page, 'Ring grid', true);
    await expect
      .poll(async () => (await collectionsState(collectionsApi)).ticked)
      .toContain('personal:grid');

    await popover(page).getByRole('button', { name: 'Actions for Ring grid' }).click();
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    // No confirm dialog: gone at once, with an Undo toast.
    await expect(toast(page)).toContainText('Deleted “Ring grid”');
    await expect.poll(() => personalRefs(collectionsApi)).not.toContain('personal:grid');
    expect((await collectionsState(collectionsApi)).ticked).not.toContain('personal:grid');

    await toast(page).getByRole('button', { name: 'Undo' }).click();
    await expect.poll(() => personalRefs(collectionsApi)).toContain('personal:grid');
    await expect
      .poll(async () => (await collectionsState(collectionsApi)).ticked)
      .toContain('personal:grid');
    const restored = (await listed(collectionsApi)).find((c) => c.ref === 'personal:grid');
    expect(restored?.name).toBe('Ring grid');

    if ((await trigger(page).getAttribute('aria-expanded')) !== 'true') await openPopover(page);
    await expect(popover(page).getByRole('checkbox', { name: 'Ring grid' })).toBeChecked();
  });
});

test.describe('save', () => {
  test('two saves under one name keep both, with no console error', async ({
    page,
    collectionsApi,
  }) => {
    const errors: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    page.on('pageerror', (e) => errors.push(e.message));
    await openWithTabs(page, ['drafts/e2e-panel', 'drafts/label-fit']);
    const before = await personalRefs(collectionsApi);

    for (let round = 1; round <= 2; round += 1) {
      await openSaveDialog(page);
      await page.locator('#save-collection-name').fill('Twins');
      await saveButton(page, 'Save').click();
      await expect(saveDialog(page)).toHaveCount(0);
      await expect(toast(page)).toContainText('Saved “Twins”');
      await expect
        .poll(async () => (await listed(collectionsApi)).filter((c) => c.name === 'Twins'))
        .toHaveLength(round);
    }

    const twins = (await listed(collectionsApi)).filter((c) => c.name === 'Twins');
    expect(new Set(twins.map((c) => c.ref)).size).toBe(2);
    expect(await personalRefs(collectionsApi)).toEqual(
      expect.arrayContaining([...before, ...twins.map((c) => c.ref)])
    );
    expect(errors).toEqual([]);
  });

  test('a Replace of a collection another console changed offers Save as new or Cancel', async ({
    page,
    collectionsApi,
  }) => {
    await openWithTabs(page, ['drafts/e2e-panel']);
    await openSaveDialog(page);
    await page.locator('#save-collection-target').selectOption('grid');
    await expect(page.locator('#save-collection-name')).toHaveValue('Ring grid');
    await expect(saveButton(page, 'Replace')).toBeEnabled();

    // Console B replaces the version this dialog saw.
    const seen = await collectionsApi.get(`${PREFIX}collections/grid`);
    expect(seen.ok()).toBe(true);
    const doc = (await seen.json()) as { rev: string; name: string };
    const other = await collectionsApi.put(`${PREFIX}collections/grid`, {
      data: { ...doc, name: 'Ring grid (B)' },
      headers: { 'If-Match': doc.rev },
    });
    expect(other.status(), await other.text()).toBe(200);

    await saveButton(page, 'Replace').click();
    const conflict = saveDialog(page).getByTestId('save-collection-conflict');
    await expect(conflict).toContainText('Not saved');
    await expect(conflict).toContainText(
      '“Ring grid” changed on another console. Save as new or cancel.'
    );
    await expect(saveButton(page, 'Save as new')).toBeVisible();
    await expect(saveButton(page, 'Cancel')).toBeVisible();
    await expect(saveButton(page, 'Replace')).toHaveCount(0);
    // Console B's version stands.
    expect((await listed(collectionsApi)).find((c) => c.ref === 'personal:grid')?.name).toBe(
      'Ring grid (B)'
    );

    const before = await personalRefs(collectionsApi);
    await saveButton(page, 'Save as new').click();
    await expect(saveDialog(page)).toHaveCount(0);
    await expect
      .poll(async () => (await personalRefs(collectionsApi)).length)
      .toBe(before.length + 1);
    expect((await listed(collectionsApi)).find((c) => c.ref === 'personal:grid')?.name).toBe(
      'Ring grid (B)'
    );
  });

  test('a Replace of a collection another console deleted offers Save as new or Cancel', async ({
    page,
    collectionsApi,
  }) => {
    await openWithTabs(page, ['drafts/e2e-panel']);
    await openSaveDialog(page);
    await page.locator('#save-collection-target').selectOption('grid');
    await expect(saveButton(page, 'Replace')).toBeEnabled();

    // Console B deletes it.
    const gone = await collectionsApi.delete(`${PREFIX}collections/grid`);
    expect(gone.status(), await gone.text()).toBe(204);

    await saveButton(page, 'Replace').click();
    const conflict = saveDialog(page).getByTestId('save-collection-conflict');
    await expect(conflict).toContainText(
      '“Ring grid” was deleted on another console. Save as new or cancel.'
    );
    await expect(saveButton(page, 'Save as new')).toBeVisible();
    await expect(saveButton(page, 'Cancel')).toBeVisible();
    // The write was refused: nothing came back under that id.
    expect(await personalRefs(collectionsApi)).not.toContain('personal:grid');

    const before = await personalRefs(collectionsApi);
    await saveButton(page, 'Cancel').click();
    await expect(saveDialog(page)).toHaveCount(0);
    expect(await personalRefs(collectionsApi)).toEqual(before);
  });
});

test.describe('Recent', () => {
  test('Clear recent from the Recent heading menu empties it', async ({ page, collectionsApi }) => {
    for (const screen of ['drafts/e2e-panel', 'drafts/label-fit']) {
      const posted = await collectionsApi.post(`${PREFIX}collections-state`, {
        data: { op: 'recent', member: { screen } },
      });
      expect(posted.ok(), await posted.text()).toBe(true);
    }
    await openWorkspace(page);
    const recent = branch(page, 'recent');
    await expect(recent).toBeVisible();
    await expect(recent.locator('li[data-member-key^="screen:"]')).toHaveCount(2);

    await recent.locator(':scope > .nav-tree__row').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Clear recent' }).click();
    await expect(recent).toHaveCount(0);
    await expect.poll(async () => (await collectionsState(collectionsApi)).recent).toEqual([]);

    await page.reload();
    await expect(allScreens(page)).toBeVisible();
    await expect(branch(page, 'recent')).toHaveCount(0);
  });
});

test.describe('long description', () => {
  test('a 2 KB description stays clamped to two lines, the full text in its title', async ({
    page,
    collectionsApi,
  }) => {
    const description = 'A long collection description that wraps. '.repeat(64).slice(0, 2048);
    expect(description.length).toBe(2048);
    await putCollection(collectionsApi, 'e2e-long', {
      name: 'E2E long',
      description,
      members: [{ screen: 'drafts/e2e-panel' }],
    });
    await openWorkspace(page);
    await openPopover(page);
    const text = popover(page).locator(
      'li[data-collection-ref="personal:e2e-long"] .collections-popover__description'
    );
    await text.scrollIntoViewIfNeeded();
    await expect(text).toBeVisible();
    await expect(text).toHaveAttribute('title', description);
    const box = await text.evaluate((el) => {
      const style = getComputedStyle(el);
      const line = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2;
      return { client: el.clientHeight, scroll: el.scrollHeight, line };
    });
    expect(box.client).toBeGreaterThan(0);
    expect(box.client).toBeLessThanOrEqual(Math.ceil(2 * box.line) + 1);
    expect(box.scroll).toBeGreaterThan(box.client);
  });
});

test.describe('collections popover row', () => {
  test('a 120-character name ellipsises and leaves the "· N · <when>" suffix intact', async ({
    page,
    collectionsApi,
  }) => {
    // 120 characters is the server's name cap.
    const name = `Long ${'n'.repeat(110)} name`;
    expect(name).toHaveLength(120);
    await putCollection(collectionsApi, 'e2e-long-name', {
      name,
      members: [{ screen: 'drafts/e2e-panel' }],
    });
    await openWorkspace(page);
    await openPopover(page);

    const row = popover(page).locator('li.collections-popover__row', {
      has: page.getByRole('checkbox', { name, exact: true }),
    });
    const suffix = row.locator('.collections-popover__suffix');
    await expect(suffix).toBeVisible();
    await expect(suffix).toHaveText(/^· 1( · |$)/);

    const geometry = await row.evaluate((li) => {
      const cell = li.querySelector<HTMLElement>('.collections-popover__name')!;
      const tail = li.querySelector<HTMLElement>('.collections-popover__suffix')!;
      return {
        textOverflow: getComputedStyle(cell).textOverflow,
        truncated: cell.scrollWidth > cell.clientWidth,
        nameRight: cell.getBoundingClientRect().right,
        suffixLeft: tail.getBoundingClientRect().left,
        suffixRight: tail.getBoundingClientRect().right,
        suffixClipped: tail.scrollWidth > tail.clientWidth,
        rowRight: li.getBoundingClientRect().right,
      };
    });
    expect(geometry.textOverflow).toBe('ellipsis');
    expect(geometry.truncated).toBe(true);
    // The name stops before the suffix starts; the suffix is whole and inside the row.
    expect(geometry.nameRight).toBeLessThanOrEqual(geometry.suffixLeft);
    expect(geometry.suffixClipped).toBe(false);
    expect(geometry.suffixRight).toBeLessThanOrEqual(geometry.rowRight);
    // The full name stays the text, the checkbox's accessible name and the row's title.
    await expect(row.locator('.collections-popover__name')).toHaveText(name);
    await expect(row.locator('.collections-popover__label')).toHaveAttribute(
      'title',
      new RegExp(`^${name} · `)
    );
  });
});

test.describe('focus exit', () => {
  test('Shift+Tab from Collections posts canopy-host-focus-exit backward to the embedding page', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      if (window !== window.top) return;
      const exits: unknown[] = [];
      (window as unknown as { __exits: unknown[] }).__exits = exits;
      window.addEventListener('message', (e: MessageEvent) => {
        const data = e.data as { type?: unknown } | null;
        if (data && data.type === 'canopy-host-focus-exit') exits.push(data);
      });
    });
    const id = `focus-exit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    await page.goto(`${PREFIX}__host.html?probe=${id}`);
    const viewer = page.frameLocator('#viewer');
    const collections = viewer.getByTestId('collections-popover-trigger');
    await expect(collections).toBeVisible();
    await collections.focus();
    await expect(collections).toBeFocused();

    await page.keyboard.press('Shift+Tab');
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __exits: unknown[] }).__exits))
      .toEqual([{ type: 'canopy-host-focus-exit', direction: 'backward' }]);
  });
});
