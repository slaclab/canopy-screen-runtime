// The screen header in a real browser: the Trace-style 48 px header row with
// the SCREEN label, the zoom group and the screen actions; what each action
// produces (a JSON download, a PNG that includes canvas and SVG content, a
// print of the screen alone, a copied link, a reload); and the ⌘/Ctrl
// shortcuts.

import { readFile } from 'node:fs/promises';
import { expect, test, type Download, type Page } from '@playwright/test';
import { overlayItem, seedDock, tileBar, tileTab, type Layout } from './dockHelpers';

const PREFIX = '/x/y/';
const PANEL = `${PREFIX}embed/drafts/e2e-panel`;
const WIDE = `${PREFIX}embed/drafts/wide-panel`;
// The workspace keeps its tabs under a key scoped to the mount path
// (src/storageScope.ts); under /x/y that is `canopy-viewer:tabs:/x/y`.
const TABS = 'canopy-viewer:tabs:/x/y';

test.describe.configure({ timeout: 15_000 });
test.use({ viewport: { width: 1400, height: 850 } });

const header = (page: Page) => page.getByTestId('screen-header');
const root = (page: Page) => page.locator('.viewer-canvas [data-testid="screen-root"]');
const action = (page: Page, id: string) => header(page).locator(`[data-screen-action="${id}"]`);

/** Start without stored tabs, so the data browser does not open by default. */
async function noStoredTabs(page: Page) {
  await page.addInitScript((key) => {
    if (sessionStorage.getItem(key) === null) {
      sessionStorage.setItem(key, JSON.stringify({ keys: [], active: null }));
    }
  }, TABS);
}

/** Replace window.print with a counter (headless printing opens nothing). */
async function stubPrint(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __prints: number; __printScale: string[] };
    w.__prints = 0;
    w.__printScale = [];
    window.print = () => {
      w.__prints += 1;
      w.__printScale.push(
        getComputedStyle(document.documentElement).getPropertyValue('--canopy-print-scale')
      );
    };
  });
}

const prints = (page: Page) =>
  page.evaluate(() => (window as unknown as { __prints: number }).__prints);

async function open(page: Page, url: string) {
  await noStoredTabs(page);
  await page.goto(url);
  await expect(root(page)).toBeVisible();
}

async function bytes(download: Download): Promise<Buffer> {
  return readFile((await download.path())!);
}

test.describe('screen header', () => {
  for (const theme of ['dark', 'light'] as const) {
    test(`is the Trace-style header row in the ${theme} theme @embed`, async ({ page }) => {
      await open(page, `${PANEL}?theme=${theme}`);
      // The header sits in the screen's own tile bar.
      const bar = tileBar(page, 'drafts/e2e-panel').getByTestId('screen-header');
      const box = (await bar.boundingBox())!;
      expect(box.height).toBe(48);
      // Below the tab strip, so the data browser's own header sits in the same place.
      const strip = (await page.getByRole('tablist', { name: 'Open tabs' }).boundingBox())!;
      expect(box.y).toBeGreaterThanOrEqual(strip.y + strip.height - 1);
      // Dark brand bar (Carbon g100) in both themes, like Trace's.
      const background = await bar
        .locator('header')
        .evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(background).toBe('rgb(22, 22, 22)');
      await expect(bar.locator('.canopy-header__name')).toHaveText('SCREEN');
      await expect(bar.getByTestId('screen-header-title')).toContainText('E2E Panel');
      await expect(bar.locator('.screen-header__detail')).toHaveText('drafts/e2e-panel');
      await expect(bar.getByTestId('zoom-percent')).toBeVisible();
      const ids = await bar
        .locator('[data-screen-action]')
        .evaluateAll((els) => els.map((el) => el.getAttribute('data-screen-action')));
      expect(ids).toEqual([
        'plot-data-browser',
        'reload',
        'download',
        'export-png',
        'print',
        'copy-link',
      ]);
      await expect(action(page, 'download')).toHaveAccessibleName(
        /^Download screen \((⌘|Ctrl\+)S\)$/
      );
      await expect(action(page, 'export-png')).toHaveAccessibleName(/^Export PNG \((⌘|Ctrl\+)I\)$/);
      await expect(action(page, 'print')).toHaveAccessibleName(/^Print \((⌘|Ctrl\+)P\)$/);
    });
  }

  // The header sits in its screen's header chrome: the header row above the
  // content with one tile, the tile's right header actions with two or more
  // Both clip their content: the label is the native title, and
  // hovering renders no tooltip there and leaves that chrome unscrolled.
  test('labels an action with its shortcut in the native title @embed', async ({ page }) => {
    await open(page, PANEL);
    const bar = tileBar(page, 'drafts/e2e-panel').filter({ has: header(page) });
    await expect(bar).toHaveCount(1);
    await expect(action(page, 'print')).toHaveAttribute('title', /^Print \((⌘|Ctrl\+)P\)$/);
    await action(page, 'print').hover();
    await expect(bar.getByRole('tooltip')).toHaveCount(0);
    for (const scroller of [bar, header(page)]) {
      const overflow = await scroller.evaluate((el) => el.scrollWidth - el.clientWidth);
      expect(overflow).toBe(0);
    }
  });

  // A tile's header is equally tall whatever its showing tab puts there: the
  // screen header on a screen, Save view on a tool. So when the tile's
  // showing tab (and with it the header's content) changes, the content below
  // the header does not move, and a click aimed at it lands where the pointer
  // went down. Two tiles, so the tile has its own bar and header.
  test('a tile bar keeps its height when its content changes @embed', async ({ page }) => {
    const SCREEN = 'drafts/e2e-panel';
    const TOOL = '@trace';
    const OTHER = 'drafts/wide-panel';
    const layout: Layout = {
      split: 'row',
      items: [
        { tile: 't1', tabs: [SCREEN, TOOL], showing: SCREEN, size: 0.6 },
        { tile: 't2', tabs: [OTHER], showing: OTHER, size: 0.4 },
      ],
    };
    await seedDock(page, { keys: [SCREEN, TOOL, OTHER], active: SCREEN }, layout);
    await page.goto(PANEL);
    await expect(root(page).first()).toBeVisible();
    // Positions are read against the dock's own top.
    const dock = page.getByTestId('workspace-dock');
    const measure = async (key: string) => {
      const bar = tileBar(page, key);
      const content = overlayItem(page, key);
      await expect(bar).toHaveCount(1);
      await expect(content).toBeVisible();
      const dockBox = (await dock.boundingBox())!;
      const barBox = (await bar.boundingBox())!;
      const contentBox = (await content.boundingBox())!;
      return {
        bar: barBox.height,
        top: contentBox.y - dockBox.y,
        gap: contentBox.y - (barBox.y + barBox.height),
      };
    };

    await expect(tileBar(page, SCREEN).getByTestId('screen-header')).toBeVisible();
    const onScreen = await measure(SCREEN);
    expect(onScreen.bar).toBeGreaterThanOrEqual(48);
    expect(Math.abs(onScreen.gap)).toBeLessThanOrEqual(1);

    // The data browser takes the tile: its header shows its tab and Save view.
    await tileTab(page, TOOL).click({ position: { x: 8, y: 8 } });
    const toolBar = tileBar(page, TOOL);
    await expect(toolBar).toHaveCount(1);
    await expect(toolBar.getByTestId('screen-header')).toHaveCount(0);
    await expect(toolBar.locator('.canopy-tile-bar__tab--showing')).toHaveAttribute(
      'data-tab-key',
      TOOL
    );
    // Tile t1 is the focused one, so the address follows its showing tab: the tool took it.
    await expect(page).toHaveURL(new RegExp(`${PREFIX}embed/@trace(/\\d+)?$`));
    await expect(toolBar.locator('[data-screen-action]')).toHaveCount(0);
    await expect(toolBar.getByRole('button', { name: 'Save view' })).toBeVisible();
    const onTool = await measure(TOOL);
    expect(onTool.bar).toBe(onScreen.bar);
    expect(onTool.top).toBe(onScreen.top);

    // And back: the header returns to a bar of the same height.
    await tileTab(page, SCREEN).click({ position: { x: 8, y: 8 } });
    await expect(tileBar(page, SCREEN).getByTestId('screen-header')).toBeVisible();
    const back = await measure(SCREEN);
    expect(back.bar).toBe(onScreen.bar);
    expect(back.top).toBe(onScreen.top);
  });

  test('the /s/ deep link gets the same actions but plotting @embed', async ({ page }) => {
    await page.goto(`${PREFIX}s/drafts/e2e-panel`);
    await expect(page.locator('[data-testid="screen-root"]')).toBeVisible();
    await expect(header(page).getByRole('link', { name: 'All screens' })).toBeVisible();
    // No data browser beside it, so no "Plot in Data Browser".
    await expect(header(page).locator('[data-screen-action]')).toHaveCount(5);
    await expect(header(page).locator('[data-screen-action="plot-data-browser"]')).toHaveCount(0);
  });

  test('download saves <id>.screen.json exactly as served @embed', async ({ page, request }) => {
    await open(page, PANEL);
    const served = await (await request.get(`${PREFIX}drafts/e2e-panel.screen.json`)).body();
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      action(page, 'download').click(),
    ]);
    expect(download.suggestedFilename()).toBe('e2e-panel.screen.json');
    const saved = await bytes(download);
    expect(saved.equals(served)).toBe(true);
    expect(JSON.parse(saved.toString('utf8'))).toMatchObject({ id: 'e2e-panel' });
  });

  test('export PNG captures the screen at its zoom, canvases and SVG included @embed', async ({
    page,
  }) => {
    await open(page, `${PANEL}?_canopyZoom=100`);
    // A canvas (red) and an inline SVG (blue), as plot widgets draw them.
    await root(page).evaluate((el) => {
      const canvas = document.createElement('canvas');
      canvas.width = 40;
      canvas.height = 40;
      Object.assign(canvas.style, { position: 'absolute', left: '300px', top: '120px' });
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#ff0000';
      ctx.fillRect(0, 0, 40, 40);
      el.appendChild(canvas);
      el.insertAdjacentHTML(
        'beforeend',
        '<svg width="40" height="40" style="position:absolute;left:340px;top:120px">' +
          '<rect width="40" height="40" fill="#0000ff"/></svg>'
      );
    });
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      action(page, 'export-png').click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^e2e-panel-\d{8}-\d{6}\.png$/);
    const png = await bytes(download);
    expect(png.length).toBeGreaterThan(1000);
    expect(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))).toBe(true);

    // Decode it in the page and sample the pixels.
    const probe = await page.evaluate(async (b64) => {
      const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
      const image = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(image.width, image.height);
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(image, 0, 0);
      const ratio = image.width / 400;
      const at = (x: number, y: number) =>
        Array.from(ctx.getImageData(Math.round(x * ratio), Math.round(y * ratio), 1, 1).data);
      return { width: image.width, height: image.height, red: at(320, 140), blue: at(360, 140) };
    }, png.toString('base64'));
    // 400 x 200 at 100%, times the device pixel ratio.
    expect(probe.width / probe.height).toBeCloseTo(2, 2);
    expect(probe.width % 400).toBe(0);
    expect(probe.red.slice(0, 3)).toEqual([255, 0, 0]);
    expect(probe.blue.slice(0, 3)).toEqual([0, 0, 255]);
  });

  test('export PNG follows the zoom @embed', async ({ page }) => {
    await open(page, `${PANEL}?_canopyZoom=50`);
    const ratio = await page.evaluate(() => window.devicePixelRatio);
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      action(page, 'export-png').click(),
    ]);
    const png = await bytes(download);
    // IHDR: width and height, big-endian, at bytes 16 and 20.
    expect(png.readUInt32BE(16)).toBe(200 * ratio);
    expect(png.readUInt32BE(20)).toBe(100 * ratio);
  });

  test('print media shows the screen alone, fitted to the page @embed', async ({ page }) => {
    await stubPrint(page);
    await open(page, WIDE);
    await action(page, 'print').click();
    expect(await prints(page)).toBe(1);
    // 2400 x 800 on a landscape page of ~980 x 718 CSS px: the width binds.
    const scale = Number(
      await page.evaluate(() => (window as unknown as { __printScale: string[] }).__printScale[0])
    );
    expect(2400 * scale).toBeLessThanOrEqual(981);
    expect(2400 * scale).toBeGreaterThan(970);

    await page.emulateMedia({ media: 'print' });
    await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
    for (const chrome of [
      page.getByRole('navigation', { name: 'Screens' }),
      page.getByRole('tablist', { name: 'Open tabs' }),
      header(page),
      page.getByTestId('workspace-splitter'),
    ]) {
      await expect(chrome).toBeHidden();
    }
    await expect(root(page)).toBeVisible();
    const zoom = await page
      .locator('.viewer-canvas')
      .evaluate((el) => Number(getComputedStyle(el).zoom));
    expect(zoom).toBeCloseTo(scale, 3);
    // Authored size, untransformed: the screen is laid out once, at its own size.
    const transform = await page
      .locator('.viewer-zoom__scaled')
      .evaluate((el) => getComputedStyle(el).transform);
    expect(transform).toBe('none');

    await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
    await page.emulateMedia({ media: 'screen' });
    await expect(header(page)).toBeVisible();
  });

  test('copy link copies the URL that reopens the screen with its macros @embed', async ({
    page,
    context,
    baseURL,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
      origin: new URL(baseURL!).origin,
    });
    await open(page, `${PREFIX}embed/drafts/macro-panel?DEVICE=B`);
    await action(page, 'copy-link').click();
    await expect(page.getByTestId('screen-action-status')).toHaveText('Copied');
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toBe(new URL(`${PREFIX}embed/drafts/macro-panel?DEVICE=B`, baseURL).href);

    // The link reopens exactly that screen, macros included, in a fresh session.
    const other = await context.newPage();
    await other.goto(copied);
    await expect(other.locator('[role="tab"][aria-selected="true"]')).toHaveAttribute(
      'data-tab-key',
      'drafts/macro-panel?DEVICE=B'
    );
    await expect(other.locator('.viewer-canvas [data-testid="screen-root"]')).toHaveAttribute(
      'data-screen-id',
      'macro-panel'
    );
    await expect(page.getByTestId('screen-action-status')).toHaveText('');
  });

  test('reload re-fetches the screen and remounts it @embed', async ({ page }) => {
    let fetches = 0;
    page.on('request', (r) => {
      if (new URL(r.url()).pathname.endsWith('/e2e-panel.screen.json')) fetches += 1;
    });
    await open(page, PANEL);
    const before = fetches;
    await root(page).evaluate((el) => el.setAttribute('data-marker', 'old'));
    await action(page, 'reload').click();
    await expect.poll(() => fetches).toBe(before + 1);
    await expect(root(page)).toBeVisible();
    await expect(root(page)).not.toHaveAttribute('data-marker', 'old');
  });

  test('⌘/Ctrl S, I and P run the actions inside the viewer @embed', async ({ page }) => {
    await stubPrint(page);
    await open(page, PANEL);
    await root(page).click({ position: { x: 5, y: 195 } });

    const [json] = await Promise.all([
      page.waitForEvent('download'),
      page.keyboard.press('ControlOrMeta+s'),
    ]);
    expect(json.suggestedFilename()).toBe('e2e-panel.screen.json');

    const [png] = await Promise.all([
      page.waitForEvent('download'),
      page.keyboard.press('ControlOrMeta+i'),
    ]);
    expect(png.suggestedFilename()).toMatch(/^e2e-panel-\d{8}-\d{6}\.png$/);

    await page.keyboard.press('ControlOrMeta+p');
    await expect.poll(() => prints(page)).toBe(1);
  });

  test('shortcuts do nothing without a screen tab @embed', async ({ page }) => {
    await stubPrint(page);
    await noStoredTabs(page);
    await page.goto(`${PREFIX}embed/`);
    await expect(page.getByTestId('workspace-empty')).toBeVisible();
    await expect(page.locator('[data-screen-action]')).toHaveCount(0);
    let downloads = 0;
    page.on('download', () => (downloads += 1));
    const prevented = await page.evaluate(() => {
      const e = new KeyboardEvent('keydown', {
        key: 's',
        code: 'KeyS',
        ctrlKey: true,
        metaKey: true,
        cancelable: true,
        bubbles: true,
      });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    });
    expect(prevented).toBe(false);
    await page.keyboard.press('ControlOrMeta+p');
    expect(await prints(page)).toBe(0);
    expect(downloads).toBe(0);
  });
});
