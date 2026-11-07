// The workspace under /x/y/embed/ (see server.mjs): the screen tree on the
// left, the tab strip and the docked tiles on the right (the focused screen's
// tile bar holds the screen header), the URL naming the active tab, the tabs kept in sessionStorage, and the Trace tab: a stub app under
// /x/y/trace/ (fixtures/trace-stub) that polls the Mole archiver list under
// its own probe id, which the server counts per probe.
//
// Every spec that mounts Trace seeds the tabs record (TABS) with its own probe
// before the page loads, in the top window only and only while the key is
// absent (so a reload keeps what the workspace wrote). Probe ids are unique
// per run, so parallel workers and retries never share a counter.

import { expect, test, type APIRequestContext, type Frame, type Page } from '@playwright/test';
import { dockLayout, dragTo, dragToEdge, tileBar, tilesOf } from './dockHelpers';

const PREFIX = '/x/y/';
// The workspace keeps its tabs under a key scoped to the mount path
// (src/storageScope.ts); under /x/y that is `canopy-viewer:tabs:/x/y`.
const TABS = 'canopy-viewer:tabs:/x/y';
const TRACE_PATH = '/x/y/trace/';

test.describe.configure({ timeout: 10_000 });

/**
 * The stored tabs: per-instance state lives in `instances` (the data
 * browser's first instance is `@trace`).
 */
interface StoredTabs {
  keys: string[];
  active: string | null;
  instances?: Record<string, { query: string | null; view?: string }>;
  toolMru?: string[];
}

interface StubState {
  probe: string;
  visible: boolean;
  polls: number;
  received: unknown[];
}

/** A probe id unique to this run. */
function probe(name: string): string {
  return `${name}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function traceQuery(id: string): string {
  return `pv=PROBE:${id}&range=-1h`;
}

/** Seed the stored tabs before the app runs: top window only, key absent. */
async function seedTabs(page: Page, tabs: StoredTabs) {
  await page.addInitScript(
    ([key, value]) => {
      if (window === window.top && sessionStorage.getItem(key) === null) {
        sessionStorage.setItem(key, value);
      }
    },
    [TABS, JSON.stringify(tabs)] as const
  );
}

function storedTabs(page: Page): Promise<StoredTabs | null> {
  return page.evaluate((key) => {
    const raw = sessionStorage.getItem(key);
    return raw === null ? null : (JSON.parse(raw) as StoredTabs);
  }, TABS);
}

async function moleCount(request: APIRequestContext, id: string): Promise<number> {
  const response = await request.get(`${PREFIX}__mole-count?probe=${id}`);
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { count: number }).count;
}

/** Count document requests for the Trace stub's index. */
function countTraceIndex(page: Page): { count: number } {
  const counter = { count: 0 };
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === TRACE_PATH) counter.count += 1;
  });
  return counter;
}

function traceFrame(page: Page): Frame {
  const frame = page.frames().find((f) => {
    try {
      return new URL(f.url()).pathname === TRACE_PATH;
    } catch {
      return false;
    }
  });
  if (!frame) throw new Error('no Trace frame');
  return frame;
}

function stubState(page: Page): Promise<StubState> {
  return traceFrame(page).evaluate(
    () => (window as unknown as { __traceStub: StubState }).__traceStub
  );
}

const tree = (page: Page) => page.getByRole('navigation', { name: 'Screens' });
const leaf = (page: Page, key: string) => page.locator(`[data-screen-key="${key}"]`);
/** Top-level folders of the fixture tree (drafts' `embedded` holds only sub-screens, hidden). */
const TOP_FOLDERS = ['lines', 'ops'];
const tabs = (page: Page) => page.getByRole('tablist', { name: 'Open tabs' }).getByRole('tab');
const tab = (page: Page, key: string) => page.locator(`[role="tab"][data-tab-key="${key}"]`);
/** The screen header, wherever it renders; there is at most one. */
const titleBar = (page: Page) => page.getByTestId('screen-header');
/** The screen header in the tile bar of `key` (the focused screen's tile). */
const headerIn = (page: Page, key: string) => tileBar(page, key).getByTestId('screen-header');
/** The shown screen; hidden workspace tabs stay mounted (visibility: hidden). */
const screenRoot = (page: Page) =>
  page.locator('.viewer-canvas [data-testid="screen-root"]').locator('visible=true');
const traceIframe = (page: Page) => page.locator('iframe.workspace-trace');

async function tabKeys(page: Page): Promise<string[]> {
  return tabs(page).evaluateAll((els) => els.map((el) => el.getAttribute('data-tab-key') ?? ''));
}

/**
 * Open the workspace on a bare /embed/ and wait for the tree. Unless the spec
 * seeded its own, the session starts with an empty stored set (an operator
 * who closed every tab), so the data browser does not open by default.
 */
async function openWorkspace(page: Page) {
  await seedTabs(page, { keys: [], active: null });
  await page.goto(`${PREFIX}embed/`);
  await expect(leaf(page, 'drafts/e2e-panel')).toBeVisible();
}

test.describe('workspace tree', () => {
  test('groups by category, flattens drafts, nests ids by / and drops @-categories @embed', async ({
    page,
  }) => {
    const warnings: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'warning') warnings.push(m.text());
    });
    await openWorkspace(page);

    const folders = tree(page).locator('li.screen-tree__folder > .nav-tree__row .nav-tree__label');
    // Categories sorted, each nested folder under its category; the drafts
    // category has no node, its folders sit at All screens' top level beside them.
    const top = await tree(page)
      .locator('li.screen-tree__screens > [role="group"] > li.screen-tree__folder')
      .evaluateAll((els) =>
        els.map((el) => el.querySelector(':scope > .nav-tree__row .nav-tree__label')?.textContent)
      );
    expect(top).toEqual(TOP_FOLDERS);
    await expect(tree(page).getByRole('treeitem', { name: 'drafts', exact: true })).toHaveCount(0);
    await expect(folders.filter({ hasText: /^line-a$/ })).toHaveCount(1);
    const lines = tree(page).locator('li.screen-tree__folder', { hasText: 'Alpha A' }).first();
    await expect(lines.getByText('Alpha B', { exact: true })).toBeVisible();
    await expect(lines.getByText('Beta C', { exact: true })).toBeVisible();
    await expect(leaf(page, 'lines/line-a/a')).toBeVisible();
    await expect(leaf(page, 'lines/line-b/c')).toBeVisible();
    await expect(leaf(page, 'ops/ops-panel')).toBeVisible();

    // The internal category is dropped, with one warning.
    await expect(tree(page).getByText('Internal Screen')).toHaveCount(0);
    await expect(tree(page).getByText('@internal')).toHaveCount(0);
    await page.waitForTimeout(1_500); // across at least one manifest poll
    expect(
      warnings.filter((w) => w.includes('dropping internal categories @internal'))
    ).toHaveLength(1);

    // A non-ir entry is a disabled leaf that opens nothing.
    const legacy = tree(page).getByRole('treeitem', { name: 'Legacy Wrapper', exact: true });
    await expect(legacy).toHaveAttribute('aria-disabled', 'true');
    await legacy.click({ force: true });
    await expect(page.getByTestId('workspace-empty')).toBeVisible();
    await expect(tabs(page)).toHaveCount(0);
  });

  test('the whole folder row toggles, the keyboard walks the tree, and closed folders are remembered @embed', async ({
    page,
  }) => {
    await openWorkspace(page);
    const lines = tree(page).getByRole('treeitem', { name: 'lines', exact: true });
    await expect(lines).toHaveAttribute('aria-expanded', 'true');
    // A click on the label (not just the chevron) closes the folder.
    await lines.locator(':scope > .nav-tree__row .nav-tree__label').click();
    await expect(lines).toHaveAttribute('aria-expanded', 'false');
    await expect(leaf(page, 'lines/line-a/a')).toHaveCount(0);

    // Keyboard: Right opens, Right again enters, Down moves, Enter opens.
    await lines.focus();
    await page.keyboard.press('ArrowRight');
    await expect(lines).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('ArrowRight');
    await expect(tree(page).getByRole('treeitem', { name: 'line-a', exact: true })).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect(leaf(page, 'lines/line-a/a')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(screenRoot(page)).toHaveAttribute('data-screen-id', 'line-a/a');
    await expect(leaf(page, 'lines/line-a/a')).toHaveAttribute('aria-selected', 'true');

    // Close `ops`, reload: it stays closed.
    const ops = tree(page).getByRole('treeitem', { name: 'ops', exact: true });
    await ops.locator(':scope > .nav-tree__row').click();
    await expect(ops).toHaveAttribute('aria-expanded', 'false');
    await page.reload();
    await expect(tree(page).getByRole('treeitem', { name: 'ops', exact: true })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
    await expect(lines).toHaveAttribute('aria-expanded', 'true');
  });

  test('search filters by title and id, case-insensitively @embed', async ({ page }) => {
    await openWorkspace(page);
    const search = page.getByRole('searchbox', { name: 'Search screens' });

    await search.fill('alpha');
    await expect(tree(page).getByText('Alpha A', { exact: true })).toBeVisible();
    await expect(tree(page).getByText('Alpha B', { exact: true })).toBeVisible();
    await expect(tree(page).getByText('E2E Panel', { exact: true })).toHaveCount(0);
    await expect(tree(page).getByText('Beta C', { exact: true })).toHaveCount(0);

    // An id match: no word of the title "<img src=x onerror=alert(1)>" starts with "xss".
    await search.fill('XSS');
    await expect(
      tree(page).getByText('<img src=x onerror=alert(1)>', { exact: true })
    ).toBeVisible();
    await expect(tree(page).getByText('Wide Panel', { exact: true })).toHaveCount(0);
    // Words of title and id match by prefix, in any case and order.
    await search.fill('FIT lab');
    await expect(tree(page).getByText('Label Fit', { exact: true })).toBeVisible();
    await expect(tree(page).getByText('Wide Panel', { exact: true })).toHaveCount(0);

    await search.fill('no-such-screen');
    await expect(tree(page).getByText(/^No matches — try/)).toBeVisible();
    await expect(tree(page).locator('.screen-tree__empty-action')).toHaveText(/^Quick open \(/);

    await search.fill('');
    await expect(tree(page).getByText('E2E Panel', { exact: true })).toBeVisible();
  });

  test('sub-screens show behind the remembered toggle and open in a tab @embed', async ({
    page,
  }) => {
    await openWorkspace(page);
    await expect(tree(page).getByText('Sub Screen')).toHaveCount(0);
    await tree(page).getByText('Show sub-screens (1)').click();
    await expect(leaf(page, 'drafts/embedded/_sub')).toBeVisible();

    await page.reload();
    await expect(leaf(page, 'drafts/embedded/_sub')).toBeVisible();
    await leaf(page, 'drafts/embedded/_sub').click();
    await expect(page).toHaveURL(new RegExp(`${PREFIX}embed/drafts/embedded/_sub$`));
    await expect(tab(page, 'drafts/embedded/_sub')).toHaveAttribute('title', 'Sub Screen');
  });
});

test.describe('workspace splitter', () => {
  // The pane splitter (usePaneSplitter.ts): the record is per base path.
  const SPLIT_KEY = 'canopy-workspace-sidebar:/x/y';
  const splitter = (page: Page) => page.getByRole('separator', { name: 'Resize screen browser' });
  const sidebarWidth = (page: Page) =>
    page.locator('.workspace__sidebar').evaluate((el) => el.getBoundingClientRect().width);
  const storedSplit = (page: Page) =>
    page.evaluate((key) => {
      const raw = localStorage.getItem(key);
      return raw === null ? null : (JSON.parse(raw) as { size: number; collapsed: boolean });
    }, SPLIT_KEY);

  test('drag, nudge, collapse and restore; persisted per base path @embed', async ({ page }) => {
    await openWorkspace(page);
    const handle = splitter(page);
    await expect(handle).toHaveAttribute('aria-orientation', 'vertical');
    expect(await sidebarWidth(page)).toBe(256);
    // Flush panes: the 5 px track sits between the tree and the content.
    const box = (await handle.boundingBox())!;
    expect(box.width).toBe(5);
    const mainLeft = await page
      .locator('.workspace__main')
      .evaluate((el) => el.getBoundingClientRect().left);
    expect(mainLeft).toBe(box.x + box.width);

    await page.mouse.move(box.x + 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 52, box.y + box.height / 2, { steps: 5 });
    await page.mouse.move(box.x + 102, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();
    await expect.poll(() => sidebarWidth(page)).toBe(356);
    expect(await storedSplit(page)).toEqual({ size: 356, collapsed: false });

    await handle.focus();
    await page.keyboard.press('ArrowLeft');
    await expect.poll(() => sidebarWidth(page)).toBe(340);

    await handle.dblclick();
    await expect.poll(() => sidebarWidth(page)).toBe(0);
    await expect(leaf(page, 'drafts/e2e-panel')).toBeHidden();
    expect(await storedSplit(page)).toEqual({ size: 340, collapsed: true });

    await page.reload();
    await expect(splitter(page)).toBeVisible();
    await expect.poll(() => sidebarWidth(page)).toBe(0);
    await splitter(page).dblclick();
    await expect.poll(() => sidebarWidth(page)).toBe(340);
    await expect(leaf(page, 'drafts/e2e-panel')).toBeVisible();
    // Only this base path's record exists.
    const keys = await page.evaluate(() =>
      Object.keys(localStorage).filter((k) => k.startsWith('canopy-workspace-sidebar:'))
    );
    expect(keys).toEqual([SPLIT_KEY]);
  });

  test('the drag clamps to 180-560 px @embed', async ({ page }) => {
    await openWorkspace(page);
    const box = (await splitter(page).boundingBox())!;
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + 2, y);
    await page.mouse.down();
    await page.mouse.move(box.x + 900, y, { steps: 5 });
    await page.mouse.up();
    await expect.poll(() => sidebarWidth(page)).toBe(560);
    const wide = (await splitter(page).boundingBox())!;
    await page.mouse.move(wide.x + 2, y);
    await page.mouse.down();
    await page.mouse.move(2, y, { steps: 5 });
    await page.mouse.up();
    await expect.poll(() => sidebarWidth(page)).toBe(180);
  });
});

test.describe('workspace tabs', () => {
  test('left-click replaces the active tab @embed', async ({ page }) => {
    await openWorkspace(page);
    await leaf(page, 'drafts/e2e-panel').click();
    await expect(page).toHaveURL(new RegExp(`${PREFIX}embed/drafts/e2e-panel$`));
    await expect(screenRoot(page)).toHaveAttribute('data-screen-id', 'e2e-panel');

    await leaf(page, 'drafts/label-fit').click();
    await expect(page).toHaveURL(new RegExp(`${PREFIX}embed/drafts/label-fit$`));
    await expect(screenRoot(page)).toHaveAttribute('data-screen-id', 'label-fit');
    expect(await tabKeys(page)).toEqual(['drafts/label-fit']);
    await expect(headerIn(page, 'drafts/label-fit')).toContainText('Label Fit');
  });

  test('Open in new tab appends and focuses; an open key is focused @embed', async ({ page }) => {
    await openWorkspace(page);
    await leaf(page, 'drafts/e2e-panel').click();
    await expect(screenRoot(page)).toHaveAttribute('data-screen-id', 'e2e-panel');

    await leaf(page, 'drafts/wide-panel').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Open in new tab' }).click();
    await expect(page).toHaveURL(new RegExp(`${PREFIX}embed/drafts/wide-panel$`));
    await expect(screenRoot(page)).toHaveAttribute('data-screen-id', 'wide-panel');
    expect(await tabKeys(page)).toEqual(['drafts/e2e-panel', 'drafts/wide-panel']);
    await expect(tab(page, 'drafts/wide-panel')).toHaveAttribute('aria-selected', 'true');
    // The screen shown before stays mounted, hidden: two on the page, one seen.
    await expect(page.locator('[data-testid="screen-root"]')).toHaveCount(2);
    await expect(screenRoot(page)).toHaveCount(1);

    // Opening a key that is already open focuses it.
    await leaf(page, 'drafts/e2e-panel').click();
    await expect(tab(page, 'drafts/e2e-panel')).toHaveAttribute('aria-selected', 'true');
    expect(await tabKeys(page)).toEqual(['drafts/e2e-panel', 'drafts/wide-panel']);

    await tab(page, 'drafts/wide-panel').click();
    await expect(page).toHaveURL(new RegExp(`${PREFIX}embed/drafts/wide-panel$`));
  });

  test('a single click replaces; ⌘/Ctrl-, Shift- and middle-click append @embed', async ({
    page,
  }) => {
    await openWorkspace(page);
    await leaf(page, 'drafts/e2e-panel').click();
    await expect(screenRoot(page)).toHaveAttribute('data-screen-id', 'e2e-panel');
    await leaf(page, 'drafts/label-fit').click();
    await expect(screenRoot(page)).toHaveAttribute('data-screen-id', 'label-fit');
    expect(await tabKeys(page)).toEqual(['drafts/label-fit']);

    await leaf(page, 'drafts/wide-panel').click({ modifiers: ['ControlOrMeta'] });
    await expect.poll(() => tabKeys(page)).toEqual(['drafts/label-fit', 'drafts/wide-panel']);
    await expect(tab(page, 'drafts/wide-panel')).toHaveAttribute('aria-selected', 'true');

    await leaf(page, 'drafts/plot-panel').click({ modifiers: ['Shift'] });
    await expect
      .poll(() => tabKeys(page))
      .toEqual(['drafts/label-fit', 'drafts/wide-panel', 'drafts/plot-panel']);

    await leaf(page, 'drafts/e2e-panel').click({ button: 'middle' });
    await expect
      .poll(() => tabKeys(page))
      .toEqual(['drafts/label-fit', 'drafts/wide-panel', 'drafts/plot-panel', 'drafts/e2e-panel']);

    // A plain click on a closed screen replaces only the active tab, in place.
    await page.getByRole('button', { name: 'Close Label Fit' }).click();
    await expect
      .poll(() => tabKeys(page))
      .toEqual(['drafts/wide-panel', 'drafts/plot-panel', 'drafts/e2e-panel']);
    await tab(page, 'drafts/wide-panel').click();
    await expect(tab(page, 'drafts/wide-panel')).toHaveAttribute('aria-selected', 'true');
    await leaf(page, 'drafts/label-fit').click();
    await expect
      .poll(() => tabKeys(page))
      .toEqual(['drafts/label-fit', 'drafts/plot-panel', 'drafts/e2e-panel']);
    await expect(tab(page, 'drafts/label-fit')).toHaveAttribute('aria-selected', 'true');
  });

  test('◀ restores the screen a click replaced, ▶ goes forward again @embed', async ({ page }) => {
    await openWorkspace(page);
    await leaf(page, 'drafts/e2e-panel').click();
    await expect(screenRoot(page)).toHaveAttribute('data-screen-id', 'e2e-panel');
    await expect(
      headerIn(page, 'drafts/e2e-panel').getByRole('button', { name: 'Back' })
    ).toBeDisabled();

    await leaf(page, 'drafts/label-fit').click();
    await expect(screenRoot(page)).toHaveAttribute('data-screen-id', 'label-fit');
    const back = headerIn(page, 'drafts/label-fit').getByRole('button', { name: 'Back' });
    await expect(back).toBeEnabled();
    await back.click();
    await expect(screenRoot(page)).toHaveAttribute('data-screen-id', 'e2e-panel');
    expect(await tabKeys(page)).toEqual(['drafts/e2e-panel']);
    await expect(page).toHaveURL(new RegExp(`${PREFIX}embed/drafts/e2e-panel$`));

    const forward = headerIn(page, 'drafts/e2e-panel').getByRole('button', { name: 'Forward' });
    await expect(forward).toBeEnabled();
    await forward.click();
    await expect(screenRoot(page)).toHaveAttribute('data-screen-id', 'label-fit');
    expect(await tabKeys(page)).toEqual(['drafts/label-fit']);
  });

  test('⌘⇧T brings back the last closed tab @embed', async ({ page }) => {
    await seedTabs(page, {
      keys: ['drafts/e2e-panel', 'drafts/label-fit'],
      active: 'drafts/label-fit',
    });
    await page.goto(`${PREFIX}embed/`);
    await expect(tab(page, 'drafts/label-fit')).toHaveAttribute('aria-selected', 'true');

    // The tab menu no longer carries it: reopen is ⌘⇧T (and the Window menu's Recently closed).
    await tab(page, 'drafts/e2e-panel').click({ button: 'right' });
    await expect(page.getByRole('menuitem', { name: 'Reopen closed tab' })).toHaveCount(0);
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'Close Label Fit' }).click();
    await expect.poll(() => tabKeys(page)).toEqual(['drafts/e2e-panel']);

    await page.keyboard.press('ControlOrMeta+Shift+T');
    await expect.poll(() => tabKeys(page)).toEqual(['drafts/e2e-panel', 'drafts/label-fit']);
    await expect(tab(page, 'drafts/label-fit')).toHaveAttribute('aria-selected', 'true');
    await expect(screenRoot(page)).toHaveAttribute('data-screen-id', 'label-fit');
  });

  test('middle-click and the close button close tabs; the last leaves the empty state @embed', async ({
    page,
  }) => {
    await seedTabs(page, {
      keys: ['drafts/e2e-panel', 'drafts/label-fit', 'drafts/wide-panel'],
      active: 'drafts/label-fit',
    });
    await page.goto(`${PREFIX}embed/`);
    await expect(screenRoot(page)).toHaveAttribute('data-screen-id', 'label-fit');

    // Middle-click an inactive tab: it closes, the active one stays.
    await tab(page, 'drafts/wide-panel').click({ button: 'middle' });
    await expect(tabs(page)).toHaveCount(2);
    await expect(tab(page, 'drafts/label-fit')).toHaveAttribute('aria-selected', 'true');

    // Closing the active (rightmost) tab focuses its left neighbour.
    await page.getByRole('button', { name: 'Close Label Fit' }).click();
    await expect(tabs(page)).toHaveCount(1);
    await expect(page).toHaveURL(new RegExp(`${PREFIX}embed/drafts/e2e-panel$`));
    await expect(screenRoot(page)).toHaveAttribute('data-screen-id', 'e2e-panel');

    await tab(page, 'drafts/e2e-panel').click({ button: 'middle' });
    await expect(tabs(page)).toHaveCount(0);
    await expect(page.getByTestId('workspace-empty')).toContainText('No tab open.');
    await expect(page).toHaveURL(new RegExp(`${PREFIX}embed/$`));
    // No tab, no tile: the empty state replaces every bar and the header.
    await expect(page.getByTestId('tile-bar')).toHaveCount(0);
    await expect(titleBar(page)).toHaveCount(0);
    await expect(page.getByTestId('zoom-percent')).toHaveCount(0);
    expect(await storedTabs(page)).toMatchObject({ keys: [], active: null });
  });

  test('the strip scrolls horizontally and keeps the active tab in view @embed', async ({
    page,
  }) => {
    const keys = Array.from({ length: 14 }, (_, i) => `drafts/macro-panel?DEVICE=D${i}`);
    await seedTabs(page, { keys, active: keys[keys.length - 1]! });
    await page.goto(`${PREFIX}embed/`);
    await expect(tabs(page)).toHaveCount(14);
    const strip = page.getByRole('tablist', { name: 'Open tabs' });
    await expect.poll(() => strip.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);

    const inView = async (key: string) => {
      const s = (await strip.boundingBox())!;
      const t = (await tab(page, key).boundingBox())!;
      return t.x >= s.x - 1 && t.x + t.width <= s.x + s.width + 1;
    };
    await expect.poll(() => inView(keys[13]!)).toBe(true);
    expect(await inView(keys[0]!)).toBe(false);

    // Focusing the first tab (a deep link to an open key) scrolls it into view.
    await page.goto(`${PREFIX}embed/drafts/macro-panel?DEVICE=D0`);
    await expect(tab(page, keys[0]!)).toHaveAttribute('aria-selected', 'true');
    await expect.poll(() => inView(keys[0]!)).toBe(true);
    await expect(tabs(page)).toHaveCount(14);
  });

  test('a tab missing from the manifest shows tab-missing with Close tab @embed', async ({
    page,
  }) => {
    await seedTabs(page, {
      keys: ['drafts/e2e-panel', 'drafts/gone-away'],
      active: 'drafts/gone-away',
    });
    await page.goto(`${PREFIX}embed/`);
    const missing = page.getByTestId('tab-missing');
    await expect(missing).toBeVisible();
    await expect(missing).toContainText("Screen 'drafts/gone-away' is not in the manifest");
    await expect(page.locator('[data-testid="screen-root"]')).toHaveCount(0);

    await missing.getByRole('button', { name: 'Close tab' }).click();
    await expect(missing).toHaveCount(0);
    expect(await tabKeys(page)).toEqual(['drafts/e2e-panel']);
    await expect(screenRoot(page)).toHaveAttribute('data-screen-id', 'e2e-panel');
  });

  test('a deep link appends to the restored tabs, never replaces @embed', async ({ page }) => {
    await page.goto(`${PREFIX}embed/drafts/e2e-panel`);
    await expect(screenRoot(page)).toHaveAttribute('data-screen-id', 'e2e-panel');

    await page.goto(`${PREFIX}embed/drafts/label-fit`);
    await expect(screenRoot(page)).toHaveAttribute('data-screen-id', 'label-fit');
    expect(await tabKeys(page)).toEqual(['drafts/e2e-panel', 'drafts/label-fit']);

    // A deep link to an open key focuses it.
    await page.goto(`${PREFIX}embed/drafts/e2e-panel`);
    await expect(tab(page, 'drafts/e2e-panel')).toHaveAttribute('aria-selected', 'true');
    expect(await tabKeys(page)).toEqual(['drafts/e2e-panel', 'drafts/label-fit']);

    // A bare /embed/ focuses the stored active tab.
    await leaf(page, 'drafts/label-fit').click();
    await expect(page).toHaveURL(new RegExp(`${PREFIX}embed/drafts/label-fit$`));
    await page.goto(`${PREFIX}embed/`);
    await expect(page).toHaveURL(new RegExp(`${PREFIX}embed/drafts/label-fit$`));
    await expect(screenRoot(page)).toHaveAttribute('data-screen-id', 'label-fit');
  });

  test('macro variants are separate tabs keyed by their canonical query @embed', async ({
    page,
  }) => {
    await page.goto(`${PREFIX}embed/drafts/macro-panel?DEVICE=A`);
    await expect(screenRoot(page)).toHaveAttribute('data-screen-id', 'macro-panel');
    await page.goto(`${PREFIX}embed/drafts/macro-panel?DEVICE=B&theme=dark`);
    await expect(tab(page, 'drafts/macro-panel?DEVICE=B')).toHaveAttribute('aria-selected', 'true');
    expect(await tabKeys(page)).toEqual([
      'drafts/macro-panel?DEVICE=A',
      'drafts/macro-panel?DEVICE=B',
    ]);
    await expect(
      headerIn(page, 'drafts/macro-panel?DEVICE=B').locator('.screen-header__detail')
    ).toContainText('drafts/macro-panel?DEVICE=B');
    // The URL names the canonical key; reserved parameters are dropped.
    await expect(page).toHaveURL(new RegExp(`${PREFIX}embed/drafts/macro-panel\\?DEVICE=B$`));

    // The same macros in another order focus the open tab.
    await page.goto(`${PREFIX}embed/drafts/macro-panel?theme=light&DEVICE=A`);
    await expect(tab(page, 'drafts/macro-panel?DEVICE=A')).toHaveAttribute('aria-selected', 'true');
    await expect(tabs(page)).toHaveCount(2);
  });

  test('open_display tab targets append and replace targets swap in place @embed', async ({
    page,
  }) => {
    const popups: string[] = [];
    page.on('popup', (p) => popups.push(p.url()));
    await page.goto(`${PREFIX}embed/drafts/actions-panel`);
    await expect(screenRoot(page)).toHaveAttribute('data-screen-id', 'actions-panel');

    await page.getByRole('button', { name: 'Open E2E Panel in tab' }).click();
    await expect(page).toHaveURL(new RegExp(`${PREFIX}embed/drafts/e2e-panel$`));
    expect(await tabKeys(page)).toEqual(['drafts/actions-panel', 'drafts/e2e-panel']);

    await tab(page, 'drafts/actions-panel').click();
    await page.getByRole('button', { name: 'Open Macro Panel in tab' }).click();
    await expect(tab(page, 'drafts/macro-panel?DEVICE=E2E2')).toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(await tabKeys(page)).toEqual([
      'drafts/actions-panel',
      'drafts/e2e-panel',
      'drafts/macro-panel?DEVICE=E2E2',
    ]);

    await tab(page, 'drafts/actions-panel').click();
    await page.getByRole('button', { name: 'Open Macro Panel', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${PREFIX}embed/drafts/macro-panel\\?DEVICE=E2E3$`));
    expect(await tabKeys(page)).toEqual([
      'drafts/macro-panel?DEVICE=E2E3',
      'drafts/e2e-panel',
      'drafts/macro-panel?DEVICE=E2E2',
    ]);
    expect(popups).toEqual([]);
  });

  test('tab changes rewrite the URL without adding history entries @embed', async ({ page }) => {
    await openWorkspace(page);
    const before = await page.evaluate(() => history.length);

    await leaf(page, 'drafts/e2e-panel').click();
    await expect(page).toHaveURL(new RegExp(`${PREFIX}embed/drafts/e2e-panel$`));
    await leaf(page, 'drafts/label-fit').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Open in new tab' }).click();
    await expect(page).toHaveURL(new RegExp(`${PREFIX}embed/drafts/label-fit$`));
    await tab(page, 'drafts/e2e-panel').click();
    await expect(page).toHaveURL(new RegExp(`${PREFIX}embed/drafts/e2e-panel$`));
    await page.getByRole('button', { name: 'Close E2E Panel' }).click();
    await expect(page).toHaveURL(new RegExp(`${PREFIX}embed/drafts/label-fit$`));

    expect(await page.evaluate(() => history.length)).toBe(before);
  });

  test('screen titles render as text in the tree, the tab and the tile bar @embed', async ({
    page,
  }) => {
    const dialogs: string[] = [];
    page.on('dialog', (d) => {
      dialogs.push(d.message());
      void d.dismiss();
    });
    const title = '<img src=x onerror=alert(1)>';
    await page.goto(`${PREFIX}embed/drafts/xss-title`);
    await expect(screenRoot(page)).toHaveAttribute('data-screen-id', 'xss-title');

    // The row's DOM id is `screen-tree-` + its node id, `screens:<member key>`.
    const nodeId = encodeURIComponent('screens:screen:drafts/xss-title');
    const label = page.locator(`[id="screen-tree-${nodeId}__label"]`);
    await expect(label).toBeVisible();
    await expect(label).toHaveText(title);
    await expect(tab(page, 'drafts/xss-title')).toHaveAttribute('title', title);
    await expect(tab(page, 'drafts/xss-title').locator('.tab-strip__title')).toHaveText(title);
    await expect(
      headerIn(page, 'drafts/xss-title').getByTestId('screen-header-title')
    ).toContainText(title);
    await expect(page.locator('img[src="x"]')).toHaveCount(0);
    expect(dialogs).toEqual([]);
  });

  test('the manifest is refetched on window focus @embed', async ({ page }) => {
    // Hidden, the workspace stops its 1 s poll, so only focus can refetch.
    await page.addInitScript(() => {
      Object.defineProperty(document, 'visibilityState', { get: () => 'hidden' });
    });
    let extra = false;
    await page.route('**/x/y/drafts/manifest.json', async (route) => {
      const response = await route.fetch();
      const manifest = (await response.json()) as { screens: Record<string, unknown>[] };
      if (extra) {
        manifest.screens.push({
          id: 'focus-added',
          kind: 'ir',
          title: 'Focus Added',
          category: 'drafts',
          path: 'e2e-panel.screen.json',
          schemaVersion: '1.0',
        });
      }
      await route.fulfill({ response, json: manifest });
    });
    await openWorkspace(page);
    extra = true;
    await page.waitForTimeout(1_500);
    await expect(tree(page).getByText('Focus Added')).toHaveCount(0);

    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(leaf(page, 'drafts/focus-added')).toBeVisible();
  });
});

test.describe('workspace data browser default', () => {
  test('a first visit lands on the data browser under a Tools header @trace', async ({ page }) => {
    await page.goto(`${PREFIX}embed/`);
    await expect(page).toHaveURL(new RegExp(`${PREFIX}embed/@trace$`));
    expect(await tabKeys(page)).toEqual(['@trace']);
    await expect(tab(page, '@trace')).toHaveAttribute('aria-selected', 'true');
    await expect(tab(page, '@trace')).toContainText('Data Browser');
    // The data browser shows Trace's own header in place of the screen header:
    // its one tile's chrome (the strip row) carries no screen actions.
    await expect(tileBar(page, '@trace')).toBeVisible();
    await expect(tileBar(page, '@trace').locator('[data-screen-action]')).toHaveCount(0);
    await expect(titleBar(page)).toHaveCount(0);
    await expect(traceIframe(page)).toHaveAttribute('data-visible', 'true');

    // The top-level branches (no collections served): Tools, then All screens.
    const branches = tree(page).locator(
      '[role="tree"] > [role="treeitem"] > .nav-tree__row .nav-tree__label'
    );
    await expect(branches).toHaveText(['Tools', 'All screens']);
    await expect(leaf(page, '@trace')).toContainText('Data Browser (Trace)');
    await expect(leaf(page, '@trace')).toHaveAttribute('aria-selected', 'true');
  });

  test('closing every tab stays closed across a reload @trace', async ({ page }) => {
    await page.goto(`${PREFIX}embed/`);
    await expect(tab(page, '@trace')).toBeVisible();
    await tab(page, '@trace').getByRole('button', { name: 'Close Data Browser' }).click();
    await expect(page.getByTestId('workspace-empty')).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`${PREFIX}embed/$`));
    await page.reload();
    await expect(leaf(page, 'drafts/e2e-panel')).toBeVisible();
    await expect(page.getByTestId('workspace-empty')).toBeVisible();
    await expect(tabs(page)).toHaveCount(0);
  });

  test('a first visit to a screen URL opens only that screen @trace', async ({ page }) => {
    await page.goto(`${PREFIX}embed/drafts/e2e-panel`);
    await expect(screenRoot(page)).toBeVisible();
    expect(await tabKeys(page)).toEqual(['drafts/e2e-panel']);
    await expect(traceIframe(page)).toHaveCount(0);
  });

  test('the search keeps the data browser on data, browser or trace @trace', async ({ page }) => {
    await openWorkspace(page);
    const search = page.getByRole('searchbox');
    for (const q of ['data', 'Browser', 'trace']) {
      await search.fill(q);
      await expect(leaf(page, '@trace')).toBeVisible();
    }
    await search.fill('e2e');
    await expect(leaf(page, '@trace')).toHaveCount(0);
    await expect(tree(page).getByRole('treeitem', { name: 'Tools', exact: true })).toHaveCount(0);
  });
});

test.describe('workspace routes', () => {
  test('the root redirects to /embed/ keeping its query @embed', async ({ page }) => {
    await page.goto(`${PREFIX}?theme=light`);
    await expect(page).toHaveURL(new RegExp(`${PREFIX}embed/`));
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(page.getByTestId('workspace')).toBeVisible();
    // A first visit lands on the data browser.
    await expect(tab(page, '@trace')).toHaveAttribute('aria-selected', 'true');
  });

  test('/embed/<category> alone redirects to /embed/ @embed', async ({ page }) => {
    await seedTabs(page, { keys: [], active: null });
    await page.goto(`${PREFIX}embed/lines`);
    await expect(page).toHaveURL(new RegExp(`${PREFIX}embed/$`));
    await expect(leaf(page, 'lines/line-a/a')).toBeVisible();
    await expect(tabs(page)).toHaveCount(0);
  });

  test('a pop-out has its own tabs, the data browser by default, and is dark @embed', async ({
    page,
    context,
  }) => {
    await page.goto(`${PREFIX}embed/drafts/e2e-panel?theme=light`);
    await expect(screenRoot(page)).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

    const popout = await context.newPage();
    try {
      await popout.goto(`${PREFIX}embed/`);
      await expect(popout.getByRole('tab')).toHaveCount(1);
      await expect(popout.locator('[role="tab"][data-tab-key="@trace"]')).toHaveAttribute(
        'aria-selected',
        'true'
      );
      await expect(popout.locator('html')).toHaveAttribute('data-theme', 'dark');
    } finally {
      await popout.close();
    }
    expect(await tabKeys(page)).toEqual(['drafts/e2e-panel']);
  });

  test('_canopyChrome=0 renders only the screen and stores nothing @embed', async ({ page }) => {
    await page.goto(`${PREFIX}embed/drafts/e2e-panel?_canopyChrome=0`);
    await expect(screenRoot(page)).toHaveAttribute('data-screen-id', 'e2e-panel');
    await expect(page.getByTestId('workspace')).toHaveClass(/workspace--bare/);
    await expect(page.getByRole('navigation', { name: 'Screens' })).toHaveCount(0);
    await expect(page.getByRole('separator')).toHaveCount(0);
    await expect(page.getByRole('tablist')).toHaveCount(0);
    await expect(titleBar(page)).toHaveCount(0);
    expect(await storedTabs(page)).toBeNull();
    await expect(page).toHaveURL(new RegExp(`${PREFIX}embed/drafts/e2e-panel\\?_canopyChrome=0$`));
  });
});

test.describe('workspace Trace tab', () => {
  test('the stub loads under the prefix, once, with only /x/y/ requests @trace', async ({
    page,
    baseURL,
    request,
  }) => {
    const id = probe('prefix');
    const urls: string[] = [];
    page.on('request', (r) => urls.push(r.url()));
    const failures: string[] = [];
    page.on('response', (r) => {
      if (r.status() >= 400) failures.push(`${r.status()} ${r.url()}`);
    });
    const index = countTraceIndex(page);
    await seedTabs(page, {
      keys: [],
      active: null,
      instances: { '@trace': { query: traceQuery(id) } },
    });
    await openWorkspace(page);
    // The row itself: the entry's treeitem also holds its saved views, which
    // other specs create on the shared server, so the item's centre may be one.
    await leaf(page, '@trace').locator(':scope > .nav-tree__row').click();

    await expect(page).toHaveURL(new RegExp(`${PREFIX}embed/@trace$`));
    await expect(page.frameLocator('iframe.workspace-trace').locator('#probe')).toHaveText(id);
    await expect.poll(() => moleCount(request, id)).toBeGreaterThanOrEqual(1);
    await expect(traceIframe(page)).toHaveCount(1);
    await expect(traceIframe(page)).toHaveAttribute('data-visible', 'true');
    expect(new URL((await traceIframe(page).getAttribute('src'))!, baseURL).pathname).toBe(
      TRACE_PATH
    );
    await expect(tileBar(page, '@trace')).toBeVisible();
    await expect(tileBar(page, '@trace').locator('[data-screen-action]')).toHaveCount(0);
    await expect(titleBar(page)).toHaveCount(0);

    const origin = new URL(baseURL!).origin;
    expect(urls.filter((u) => new URL(u).origin !== origin)).toEqual([]);
    expect(urls.filter((u) => !new URL(u).pathname.startsWith(PREFIX))).toEqual([]);
    expect(failures).toEqual([]);
    expect(index.count).toBe(1);
    expect(page.frames().filter((f) => f.url().includes(TRACE_PATH))).toHaveLength(1);
  });

  test('@trace restores its query; the URL theme reaches Trace @trace', async ({ page }) => {
    const id = probe('rules');
    await seedTabs(page, {
      keys: [],
      active: null,
      instances: { '@trace': { query: traceQuery(id) } },
    });
    await page.goto(`${PREFIX}embed/@trace?theme=light`);
    await expect(traceIframe(page)).toHaveCount(1);
    const src = (await traceIframe(page).getAttribute('src'))!;
    expect(src).toContain(`pv=PROBE:${id}`);
    expect(src).toContain('theme=light');
    expect(src).toContain('embedded=true');
    await expect(page.frameLocator('iframe.workspace-trace').locator('#probe')).toHaveText(id);
    expect(await tabKeys(page)).toEqual(['@trace']);
    expect((await storedTabs(page))?.instances?.['@trace']?.query).toBe(traceQuery(id));
  });

  test('reload restores tabs with Trace active; a theme change never reloads its src @trace', async ({
    page,
  }) => {
    const id = probe('reload');
    await seedTabs(page, {
      keys: ['drafts/e2e-panel', '@trace'],
      active: '@trace',
      instances: { '@trace': { query: traceQuery(id) } },
    });
    const index = countTraceIndex(page);
    await page.goto(`${PREFIX}embed/`);
    await expect(page).toHaveURL(new RegExp(`${PREFIX}embed/@trace$`));
    const trace = page.frameLocator('iframe.workspace-trace');
    await expect(trace.locator('#probe')).toHaveText(id);
    const src = await traceIframe(page).getAttribute('src');
    expect(src).toContain('theme=dark');
    await traceFrame(page).evaluate(() => {
      (window as unknown as { __marker: string }).__marker = 'first-load';
    });

    await page.evaluate(() => window.postMessage({ type: 'canopy:theme', theme: 'light' }, '*'));
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect
      .poll(async () => (await stubState(page)).received)
      .toContainEqual({ type: 'canopy:trace-theme', mode: 'light', theme: 'light' });
    expect(await traceIframe(page).getAttribute('src')).toBe(src);
    expect(
      await traceFrame(page).evaluate(() => (window as unknown as { __marker?: string }).__marker)
    ).toBe('first-load');
    expect(index.count).toBe(1);

    await page.reload();
    await expect(page).toHaveURL(new RegExp(`${PREFIX}embed/@trace$`));
    expect(await tabKeys(page)).toEqual(['drafts/e2e-panel', '@trace']);
    await expect(tab(page, '@trace')).toHaveAttribute('aria-selected', 'true');
    await expect(trace.locator('#probe')).toHaveText(id);
    expect(index.count).toBe(2);
  });

  test('Trace stays mounted across a screen tab and back @trace', async ({ page }) => {
    const id = probe('roundtrip');
    await seedTabs(page, {
      keys: ['@trace'],
      active: '@trace',
      instances: { '@trace': { query: traceQuery(id) } },
    });
    const index = countTraceIndex(page);
    await page.goto(`${PREFIX}embed/@trace`);
    const trace = page.frameLocator('iframe.workspace-trace');
    await expect(trace.locator('#probe')).toHaveText(id);
    const src = await traceIframe(page).getAttribute('src');
    await traceFrame(page).evaluate(() => {
      (window as unknown as { __marker: string }).__marker = 'kept';
    });

    // Trace active: a left-click appends rather than replacing Trace.
    await leaf(page, 'drafts/e2e-panel').click();
    await expect(screenRoot(page)).toHaveAttribute('data-screen-id', 'e2e-panel');
    expect(await tabKeys(page)).toEqual(['@trace', 'drafts/e2e-panel']);
    await expect(traceIframe(page)).toHaveAttribute('data-visible', 'false');
    await expect(traceIframe(page)).toHaveCSS('visibility', 'hidden');
    await expect(trace.locator('body')).toHaveAttribute('data-visible', 'false');

    await tab(page, '@trace').click();
    await expect(page).toHaveURL(new RegExp(`${PREFIX}embed/@trace$`));
    await expect(traceIframe(page)).toHaveAttribute('data-visible', 'true');
    await expect(trace.locator('body')).toHaveAttribute('data-visible', 'true');
    expect(await traceIframe(page).getAttribute('src')).toBe(src);
    expect(
      await traceFrame(page).evaluate(() => (window as unknown as { __marker?: string }).__marker)
    ).toBe('kept');
    expect(index.count).toBe(1);
  });

  test('a query Trace posts persists across a reload; one from another source is ignored @trace', async ({
    page,
  }) => {
    const id = probe('query');
    const next = probe('next');
    await seedTabs(page, {
      keys: ['@trace'],
      active: '@trace',
      instances: { '@trace': { query: traceQuery(id) } },
    });
    await page.goto(`${PREFIX}embed/@trace`);
    const trace = page.frameLocator('iframe.workspace-trace');
    await expect(trace.locator('#probe')).toHaveText(id);
    const src = await traceIframe(page).getAttribute('src');

    // From the top window, not the Trace frame: ignored.
    await page.evaluate(() =>
      window.postMessage({ type: 'canopy:trace-query', query: 'pv=PROBE:evil&range=-1h' }, '*')
    );
    // From Trace itself: stored, while the mounted src stays as it was.
    const posted = `pv=PROBE:${next}&range=-2h`;
    await traceFrame(page).evaluate(
      (q) => (window as unknown as { __postQuery: (q: string) => void }).__postQuery(q),
      posted
    );
    await expect
      .poll(async () => (await storedTabs(page))?.instances?.['@trace']?.query)
      .toBe(posted);
    expect(await traceIframe(page).getAttribute('src')).toBe(src);

    await page.reload();
    await expect(trace.locator('#probe')).toHaveText(next);
    const reloaded = (await traceIframe(page).getAttribute('src'))!;
    expect(reloaded).toContain(posted);
    expect(reloaded).not.toContain('evil');
  });
});

test.describe('workspace Trace pause', () => {
  test.describe.configure({ retries: 0, timeout: 15_000 });

  /** Hidden: wait for the stub to report it (or 1.5 s), then no poll for 5 s. */
  async function expectPaused(
    page: Page,
    request: APIRequestContext,
    id: string,
    body: ReturnType<Page['frameLocator']>
  ) {
    await expect(body.locator('body'))
      .toHaveAttribute('data-visible', 'false', { timeout: 1_500 })
      .catch(() => undefined);
    await page.waitForTimeout(250); // a poll already in flight lands
    const paused = await moleCount(request, id);
    await page.waitForTimeout(5_000);
    expect(await moleCount(request, id)).toBe(paused);
  }

  test('display:none on the host frame pauses Trace @trace', async ({ page, request }) => {
    const id = probe('none');
    await page.goto(`${PREFIX}__host.html?probe=${id}`);
    const trace = page.frameLocator('#viewer').frameLocator('iframe.workspace-trace');
    await expect(trace.locator('#probe')).toHaveText(id);
    await expect.poll(() => moleCount(request, id), { timeout: 3_000 }).toBeGreaterThanOrEqual(1);

    await page.evaluate(() =>
      (window as unknown as { __setTraceHidden: (h: boolean) => void }).__setTraceHidden(true)
    );
    await expectPaused(page, request, id, trace);
  });

  test('switching to a screen tab pauses Trace @trace', async ({ page, request }) => {
    const id = probe('switch');
    await seedTabs(page, {
      keys: ['@trace'],
      active: '@trace',
      instances: { '@trace': { query: traceQuery(id) } },
    });
    await page.goto(`${PREFIX}embed/@trace`);
    const trace = page.frameLocator('iframe.workspace-trace');
    await expect(trace.locator('#probe')).toHaveText(id);
    await expect.poll(() => moleCount(request, id), { timeout: 3_000 }).toBeGreaterThanOrEqual(1);

    await leaf(page, 'drafts/e2e-panel').click();
    await expect(screenRoot(page)).toHaveAttribute('data-screen-id', 'e2e-panel');
    await expectPaused(page, request, id, trace);
  });

  test('a Trace tile beside a focused screen keeps polling; hidden behind a tab it pauses @trace', async ({
    page,
    request,
  }) => {
    test.setTimeout(25_000);
    const id = probe('beside');
    await seedTabs(page, {
      keys: ['@trace', 'drafts/e2e-panel'],
      active: '@trace',
      instances: { '@trace': { query: traceQuery(id) } },
    });
    await page.goto(`${PREFIX}embed/@trace`);
    const trace = page.frameLocator('iframe.workspace-trace');
    await expect(trace.locator('#probe')).toHaveText(id);
    await expect.poll(() => moleCount(request, id), { timeout: 3_000 }).toBeGreaterThanOrEqual(1);

    // The screen's tab dropped on Trace's right edge: a second tile, two visible frames.
    await dragToEdge(page, 'drafts/e2e-panel', '@trace', 'right');
    await expect.poll(async () => tilesOf(await dockLayout(page)).length).toBe(2);
    await expect(screenRoot(page)).toHaveAttribute('data-screen-id', 'e2e-panel');
    await expect(traceIframe(page)).toBeVisible();
    await expect(traceIframe(page)).toHaveAttribute('data-visible', 'true');
    await expect(trace.locator('body')).toHaveAttribute('data-visible', 'true');
    const before = await moleCount(request, id);
    await expect.poll(() => moleCount(request, id), { timeout: 5_000 }).toBeGreaterThan(before);

    // Trace's tab dropped into the screen's tile and the screen shown there: Trace's
    // tile is gone and Trace is a hidden tab, so its frame is hidden and paused.
    const bar = (await page
      .locator('[data-testid="tile-bar"][data-panel-key="drafts/e2e-panel"]')
      .boundingBox())!;
    await dragTo(
      page,
      { from: 'tab', key: '@trace' },
      { x: bar.x + bar.width - 4, y: bar.y + bar.height / 2 },
      'tab'
    );
    await expect.poll(async () => tilesOf(await dockLayout(page)).length).toBe(1);
    await tab(page, 'drafts/e2e-panel').click();
    await expect(traceIframe(page)).toHaveAttribute('data-visible', 'false');
    await expectPaused(page, request, id, trace);

    // A click on Trace's tab shows it again: it resumes.
    await tab(page, '@trace').click();
    await expect(traceIframe(page)).toHaveAttribute('data-visible', 'true');
    const resumed = await moleCount(request, id);
    await expect.poll(() => moleCount(request, id), { timeout: 5_000 }).toBeGreaterThan(resumed);
  });
});
