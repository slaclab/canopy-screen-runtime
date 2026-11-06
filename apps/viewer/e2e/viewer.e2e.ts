// The built viewer mounted under /x/y/ (see server.mjs): every route loads
// the same bundle, stays on its own origin, and the embed route speaks the
// iframe-host contract (canopy:theme). The root and
// /embed/ are the workspace (screen tree, tabs, docked tiles); its own specs are in
// workspace.e2e.ts.

import { expect, test, type Page } from '@playwright/test';
import {
  dragTo,
  dragToEdge,
  overlayItem,
  seedTabs,
  storedZoom,
  stripTab,
  tileBar,
} from './dockHelpers';

const PREFIX = '/x/y/';
const SCREEN = 'drafts/e2e-panel';
const WORKSPACE_ROOTS = [`${PREFIX}embed/`, PREFIX];
const ROUTES = [`${PREFIX}embed/${SCREEN}`, `${PREFIX}s/${SCREEN}`, ...WORKSPACE_ROOTS];

interface Traffic {
  requests: string[];
  failures: string[];
}

/** Record every request and every >=400 response or failed request of `page`. */
function watch(page: Page): Traffic {
  const traffic: Traffic = { requests: [], failures: [] };
  page.on('request', (request) => traffic.requests.push(request.url()));
  page.on('response', (response) => {
    if (response.status() >= 400) traffic.failures.push(`${response.status()} ${response.url()}`);
  });
  page.on('requestfailed', (request) =>
    traffic.failures.push(`failed ${request.url()} (${request.failure()?.errorText ?? '?'})`)
  );
  return traffic;
}

/** Wait for the page to settle: the rendered screen, or the workspace's screen tree. */
async function loaded(page: Page, route: string) {
  if (WORKSPACE_ROOTS.includes(route)) {
    // The root redirects to the workspace, whose tree lists the screens (the
    // URL itself is checked by workspace.e2e.ts: here a tab restored from an
    // earlier route in the same session may already be active).
    await expect(page).toHaveURL(new RegExp(`${PREFIX}embed/`));
    await expect(
      page.getByRole('navigation', { name: 'Screens' }).getByText('E2E Panel', { exact: true })
    ).toBeVisible();
  } else {
    await expect(page.locator('.viewer-canvas [data-testid="screen-root"]')).toBeVisible();
  }
  await page.waitForLoadState('networkidle');
}

test.describe('viewer under a path prefix', () => {
  for (const route of ROUTES) {
    const tag = route.includes('/embed/') ? ' @embed' : '';
    test(`deep-loads ${route} with no 404s and no off-origin requests${tag}`, async ({
      page,
      baseURL,
    }) => {
      const traffic = watch(page);
      await page.goto(route);
      await loaded(page, route);

      expect(traffic.failures).toEqual([]);
      const origin = new URL(baseURL!).origin;
      const offOrigin = traffic.requests.filter((url) => new URL(url).origin !== origin);
      expect(offOrigin).toEqual([]);
      // Every same-origin request stays under the mount prefix.
      const outside = traffic.requests.filter((url) => !new URL(url).pathname.startsWith(PREFIX));
      expect(outside).toEqual([]);
    });
  }

  test('every route loads the identical bundle URL', async ({ page, baseURL }) => {
    const bundles: string[] = [];
    for (const route of ROUTES) {
      await page.goto(route);
      await loaded(page, route);
      const src = await page
        .locator('script[type="module"][src]')
        .first()
        .evaluate((el) => (el as HTMLScriptElement).src);
      bundles.push(src);
    }
    expect(bundles[0]).toMatch(new RegExp(`^${new URL(baseURL!).origin}/x/y/assets/[^/]+\\.js$`));
    expect(new Set(bundles).size).toBe(1);
  });

  test('config.json is fetched same-origin under the prefix and answers 200', async ({
    page,
    baseURL,
  }) => {
    const configResponse = page.waitForResponse((r) => r.url().endsWith('/config.json'));
    await page.goto(`${PREFIX}s/${SCREEN}`);
    const response = await configResponse;
    expect(response.url()).toBe(`${new URL(baseURL!).origin}/x/y/config.json`);
    expect(response.request().method()).toBe('GET');
    expect(response.status()).toBe(200);
  });

  test('publishes window.__canopy.pvStatus = mock', async ({ page }) => {
    await page.goto(`${PREFIX}s/${SCREEN}`);
    await loaded(page, `${PREFIX}s/${SCREEN}`);
    expect(await page.evaluate(() => window.__canopy?.pvStatus)).toBe('mock');
  });
});

test.describe('embed route', () => {
  test('a canopy:theme message flips html[data-theme] and the canvas background', async ({
    page,
  }) => {
    await page.goto(`${PREFIX}embed/${SCREEN}`);
    const canvas = page.locator('.viewer-canvas');
    await expect(canvas.locator('[data-testid="screen-root"]')).toBeVisible();
    const html = page.locator('html');
    await expect(html).toHaveAttribute('data-theme', 'dark');
    await expect(canvas).toHaveCSS('background-color', 'rgb(22, 22, 22)');

    // At top level window.parent === window, so a self-post comes from the "host".
    await page.evaluate(() => window.postMessage({ type: 'canopy:theme', theme: 'light' }, '*'));
    await expect(html).toHaveAttribute('data-theme', 'light');
    await expect(canvas).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  });
});

test.describe('static label fit', () => {
  test('small labels fit, an over-long one clips centred, an alpha colour stays transparent', async ({
    page,
  }) => {
    await page.goto(`${PREFIX}embed/drafts/label-fit`);
    await expect(page.locator('.viewer-canvas [data-testid="screen-root"]')).toBeVisible();
    await page.evaluate(() => document.fonts.ready.then(() => undefined));

    const metrics = (text: string) =>
      page.getByText(text, { exact: true }).evaluate((el) => {
        const style = getComputedStyle(el);
        const parent = el.parentElement!;
        return {
          text: el.textContent,
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
          textOverflow: style.textOverflow,
          justifyContent: getComputedStyle(parent).justifyContent,
          parentBackground: getComputedStyle(parent).backgroundColor,
        };
      });

    for (const text of ['BC1', 'BPM1']) {
      const m = await metrics(text);
      expect(m.text).toBe(text);
      expect(m.scrollWidth, text).toBeLessThanOrEqual(m.clientWidth);
    }

    const long = await metrics('BR1 TV1');
    expect(long.text).toBe('BR1 TV1');
    expect(long.textOverflow).toBe('clip');
    expect(long.scrollWidth).toBeGreaterThan(long.clientWidth);
    expect(long.justifyContent).toBe('center');

    const alpha = await metrics('ALPHA');
    expect(alpha.parentBackground).toMatch(/^rgba\(\d+, \d+, \d+, 0\)$/);
  });
});

test.describe('embed toolbar and zoom', () => {
  const WIDE = `${PREFIX}embed/drafts/wide-panel`;
  const root = (page: Page) => page.locator('.viewer-canvas [data-testid="screen-root"]');
  const percent = (page: Page) => page.getByTestId('zoom-percent');
  /** The page's percentage label as a number. */
  const percentValue = async (page: Page) =>
    Number((await percent(page).textContent())!.replace('%', ''));

  test.use({ viewport: { width: 1200, height: 800 } });

  test('shows the 48 px screen header, without a back link @embed', async ({ page }) => {
    await page.goto(`${PREFIX}embed/${SCREEN}`);
    await expect(root(page)).toBeVisible();
    // The header sits in the focused screen's tile bar.
    const header = tileBar(page, SCREEN).getByTestId('screen-header');
    await expect(header).toBeVisible();
    // The tree replaces the screen list, so there is no back link.
    await expect(page.getByRole('link', { name: 'All screens' })).toHaveCount(0);
    await expect(header).toContainText('E2E Panel');
    const box = await header.boundingBox();
    expect(box!.height).toBe(48);
    await expect(page.locator('header')).toHaveCount(1);
  });

  test('a panel wider than the frame opens fitted, with no scrolling @embed', async ({ page }) => {
    await page.goto(WIDE);
    await expect(root(page)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Fit' })).toHaveAttribute('aria-pressed', 'true');

    const box = (await root(page).boundingBox())!;
    expect(box.width).toBeLessThanOrEqual(1200);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(1200);
    expect(box.y + box.height).toBeLessThanOrEqual(800);
    expect(await percentValue(page)).toBeLessThan(100);
    // The label matches the rendered scale.
    expect(Math.round((box.width / 2400) * 100)).toBe(await percentValue(page));

    const main = page.locator('main');
    const overflow = await main.evaluate((el) => ({
      x: el.scrollWidth > el.clientWidth,
      y: el.scrollHeight > el.clientHeight,
    }));
    expect(overflow).toEqual({ x: false, y: false });
  });

  test('1:1 shows 100% and scrolls horizontally; Fit returns @embed', async ({ page }) => {
    await page.goto(WIDE);
    await expect(root(page)).toBeVisible();
    await page.getByRole('button', { name: 'Actual size' }).click();
    await expect(percent(page)).toHaveText('100%');
    const box = (await root(page).boundingBox())!;
    expect(Math.round(box.width)).toBe(2400);

    const main = page.locator('main');
    expect(await main.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    // Nothing is clipped: the far edge (2400 px + padding) is reachable.
    expect(await main.evaluate((el) => el.scrollWidth)).toBeGreaterThanOrEqual(2400);

    await page.getByRole('button', { name: 'Zoom in' }).click();
    await expect(percent(page)).toHaveText('110%');
    await page.getByRole('button', { name: 'Fit' }).click();
    expect(await percentValue(page)).toBeLessThan(100);
  });

  test('re-fits when the frame is resized @embed', async ({ page }) => {
    await page.goto(WIDE);
    await expect(root(page)).toBeVisible();
    const before = await percentValue(page);
    await page.setViewportSize({ width: 700, height: 800 });
    await expect.poll(() => percentValue(page)).toBeLessThan(before);
    const box = (await root(page).boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(700);
  });

  test('buttons stay clickable on a scaled screen @embed', async ({ page }) => {
    await page.goto(WIDE);
    await expect(root(page)).toBeVisible();
    expect(await percentValue(page)).toBeLessThan(100);
    await page.getByRole('button', { name: 'Open E2E Panel' }).click();
    await expect(page).toHaveURL(new RegExp(`${PREFIX}embed/${SCREEN}$`));
    await expect(root(page)).toHaveAttribute('data-screen-id', 'e2e-panel');
  });

  test('a screen opened in place of another opens at its own zoom @embed', async ({ page }) => {
    await page.goto(WIDE);
    await expect(root(page)).toBeVisible();
    await page.getByRole('button', { name: 'Actual size' }).click();
    await page.getByRole('button', { name: 'Zoom out' }).click();
    await expect(percent(page)).toHaveText('90%');
    // A screen with no remembered zoom opens at Fit, not at the zoom before it.
    await page.locator('[data-screen-key="drafts/e2e-panel"]').click();
    await expect(root(page)).toHaveAttribute('data-screen-id', 'e2e-panel');
    await expect(page.getByRole('button', { name: 'Fit' })).toHaveAttribute('aria-pressed', 'true');
    expect(await storedZoom(page, SCREEN)).toBeNull();
    // The wide panel, opened again, has its own 90%.
    await page.locator('[data-screen-key="drafts/wide-panel"]').click();
    await expect(root(page)).toHaveAttribute('data-screen-id', 'wide-panel');
    await expect(percent(page)).toHaveText('90%');
  });

  // Per tile: every docked screen has its own zoom.
  const WIDE_KEY = 'drafts/wide-panel';
  const tileRoot = (page: Page, key: string) =>
    overlayItem(page, key).locator('[data-testid="screen-root"]');
  const barPercent = (page: Page, key: string) => tileBar(page, key).getByTestId('zoom-percent');
  /**
   * A zoom control of `key`'s tile bar: inline, or in the menu its compact "NN % ▾" button
   * opens when the tile is too narrow for the zoom group.
   */
  async function barZoom(page: Page, key: string, name: string) {
    const inline = tileBar(page, key).getByRole('button', { name, exact: true });
    const compact = tileBar(page, key).locator('.screen-header__zoom-menu');
    await expect(inline.or(compact).first()).toBeVisible();
    if ((await compact.count()) === 0) return inline;
    if ((await compact.getAttribute('aria-expanded')) !== 'true') await compact.click();
    const menu = page.locator(`[id="${await compact.getAttribute('aria-controls')}"]`);
    await expect(menu).toBeVisible();
    return menu.getByRole('button', { name, exact: true });
  }
  /** The two screens side by side: `SCREEN` left, the wide panel right. */
  async function twoTiles(page: Page, query = '') {
    await seedTabs(page, { keys: [SCREEN, WIDE_KEY], active: SCREEN });
    await page.goto(`${PREFIX}embed/${SCREEN}${query}`);
    await expect(tileRoot(page, SCREEN)).toBeVisible();
    await dragToEdge(page, WIDE_KEY, SCREEN, 'right');
    await expect(tileRoot(page, WIDE_KEY)).toBeVisible();
  }
  const width = async (page: Page, key: string) =>
    Math.round((await tileRoot(page, key).boundingBox())!.width);
  /** Focuses `key`'s tile through its bar (a focused screen's bar shows its header instead). */
  async function focusTile(page: Page, key: string) {
    const title = tileBar(page, key).getByTestId('tile-bar-title');
    if ((await title.count()) > 0) await title.click();
    await expect(barPercent(page, key)).toBeVisible();
  }

  test('a zoom in one tile leaves the other tile unchanged @embed', async ({ page }) => {
    await twoTiles(page);
    // The wide panel opens fitted.
    await focusTile(page, WIDE_KEY);
    await expect(await barZoom(page, WIDE_KEY, 'Fit')).toHaveAttribute('aria-pressed', 'true');
    const panelBefore = await width(page, SCREEN);
    await (await barZoom(page, WIDE_KEY, 'Actual size')).click();
    await expect(barPercent(page, WIDE_KEY)).toHaveText('100%');
    await expect.poll(() => width(page, WIDE_KEY)).toBe(2400);
    expect(await width(page, SCREEN)).toBe(panelBefore);

    // The other tile, focused: its own (fit) zoom; zooming it leaves the wide one at 1:1.
    await focusTile(page, SCREEN);
    await expect(await barZoom(page, SCREEN, 'Fit')).toHaveAttribute('aria-pressed', 'true');
    await (await barZoom(page, SCREEN, 'Actual size')).click();
    await (await barZoom(page, SCREEN, 'Zoom out')).click();
    await expect(barPercent(page, SCREEN)).toHaveText('90%');
    expect(await width(page, WIDE_KEY)).toBe(2400);
    expect(await storedZoom(page, SCREEN)).toEqual({ mode: 'manual', scale: 0.9 });
    expect(await storedZoom(page, WIDE_KEY)).toEqual({ mode: 'manual', scale: 1 });

    // Focus back: the wide tile still shows its own 100%.
    await focusTile(page, WIDE_KEY);
    await expect(barPercent(page, WIDE_KEY)).toHaveText('100%');
  });

  test('?_canopyZoom reaches only the URL-named tile @embed', async ({ page }) => {
    await twoTiles(page, '?_canopyZoom=100');
    // The URL-named tile shows the latched 100%, held for this page view only.
    await focusTile(page, SCREEN);
    await expect(await barZoom(page, SCREEN, 'Fit')).toHaveAttribute('aria-pressed', 'false');
    await expect(barPercent(page, SCREEN)).toHaveText('100%');
    expect(await storedZoom(page, SCREEN)).toBeNull();
    // The wide panel uses its own zoom: fit, not the latched 100%.
    await focusTile(page, WIDE_KEY);
    await expect(await barZoom(page, WIDE_KEY, 'Fit')).toHaveAttribute('aria-pressed', 'true');
    // Every screen bar has a percentage now, so read the wide tile's own.
    const widePercent = Number((await barPercent(page, WIDE_KEY).textContent())!.replace('%', ''));
    expect(widePercent).toBeLessThan(100);
    expect(await storedZoom(page, WIDE_KEY)).toBeNull();
  });

  test('a tab hidden behind another keeps its zoom when shown again @embed', async ({ page }) => {
    await page.goto(WIDE);
    await expect(root(page)).toBeVisible();
    await page.getByRole('button', { name: 'Actual size' }).click();
    await expect(percent(page)).toHaveText('100%');
    // Another screen dropped on the strip (the one tile's bar) is a tab that shows in front.
    const strip = (await page.locator('.tab-strip').boundingBox())!;
    await dragTo(
      page,
      { from: 'tree', key: 'drafts/e2e-panel' },
      { x: strip.x + strip.width - 10, y: strip.y + strip.height / 2 },
      'tab'
    );
    await expect(stripTab(page, 'drafts/e2e-panel')).toHaveAttribute('aria-selected', 'true');
    await stripTab(page, WIDE_KEY).click();
    await expect(barPercent(page, WIDE_KEY)).toHaveText('100%');
    await expect.poll(() => width(page, WIDE_KEY)).toBe(2400);
  });
});

test.describe('embed screen tree', () => {
  test('lists screens in embed mode and hides sub-screens until asked @embed', async ({ page }) => {
    await page.goto(`${PREFIX}embed/drafts/wide-panel`);
    await expect(page.locator('.viewer-canvas [data-testid="screen-root"]')).toBeVisible();
    // No back link: the tree beside the screen is the screen list.
    await expect(page.getByRole('link', { name: '← All screens' })).toHaveCount(0);
    const tree = page.getByRole('navigation', { name: 'Screens' });
    await expect(tree.getByText('Wide Panel', { exact: true })).toBeVisible();
    // The only header is the screen header, not the /s/ page's chrome.
    await expect(page.locator('header')).toHaveCount(1);
    await expect(tree.getByText('Sub Screen')).toHaveCount(0);

    await tree.getByText('Show sub-screens (1)').click();
    await expect(tree.getByText('Sub Screen')).toBeVisible();
  });

  test('a tree leaf opens its screen and stays under /embed/ @embed', async ({ page }) => {
    await page.goto(`${PREFIX}embed/`);
    await page
      .getByRole('navigation', { name: 'Screens' })
      .getByText('Label Fit', { exact: true })
      .click();
    await expect(page).toHaveURL(new RegExp(`${PREFIX}embed/drafts/label-fit$`));
    await expect(page.locator('.viewer-canvas [data-testid="screen-root"]')).toBeVisible();
    await expect(page.locator('.workspace__main').getByTestId('screen-header')).toContainText(
      'Label Fit'
    );
  });
});
