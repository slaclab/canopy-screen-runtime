// The dock inside a host page: the viewer framed by a same-origin page this
// spec serves through a route (e2e/server.mjs stays untouched), with the open
// tabs and the tile layout seeded in storage by that page before it creates
// the frame.
//
// Embed-host tier (`@embed-host`, the stand-in host of hostFixture.ts on the
// shell's synthetic sheet). The nested-bar rule: under a host's own tile bar
// the viewer's bars keep their look, the inner x says what it does ("Close
// tab", and it does close the tab), and the accent hairline shows only while
// two or more tiles are open and the frame holds focus. One tile (the same
// embedded in a host and standalone): its tabs sit in the strip row, there is
// no tile bar and so no hairline. Two tiles: a bar each, exactly one hairline,
// and none once focus moves to an input of the host page.
// A tab drag that leaves the frame paints nothing in the host page.

import { expect, test, type FrameLocator, type Locator, type Page } from '@playwright/test';
import { installHost } from './hostFixture';
import { hostFixture } from './hostProbes';
import { layoutShape, storedDock, type Layout } from './dockHelpers';

const PREFIX = '/x/y';
const HOST_PAGE = `${PREFIX}/__dock-host.html`;

/** The tabs key under the e2e server: scoped to the mount (src/storageScope.ts). */
const TABS_KEY = `canopy-viewer:tabs:${PREFIX}`;
/** The layout key under the e2e server (basename /x/y, no storage scope). */
const DOCK_KEY = `canopy-workspace-dock:${PREFIX}`;
/** What every viewer tab or tile drag carries (dock/tabAdapter.tsx DOCK_SOURCE_MIME). */
const DOCK_MIME = 'application/x-canopy-dock-source';
/** A tile-bar tab's x tooltip (dock/TileBar.tsx TILE_TAB_CLOSE_TITLE). */
const CLOSE_TAB_TITLE = 'Close tab';

const FIRST = 'drafts/host-probe';
const SECOND = 'drafts/e2e-panel';

const TILE_BAR = '[data-testid="tile-bar"]';
const HAIRLINE = '.canopy-tile-bar--focused';
const DOCK_OVERLAY = '.canopy-dock-overlay';
/** Every element a dockview drop highlight is painted with. */
const DROP_PAINT = [
  '.dv-drop-target-dropzone',
  '.dv-drop-target-selection',
  '.dv-drop-target-anchor',
].join(', ');

/** A dark theme id of the synthetic host sheet. */
const SYNTHETIC_THEME = Object.keys(hostFixture.themes).find(
  (id) => hostFixture.themes[id]!.mode === 'dark'
)!;

/** `keys` as one tile, the first showing. */
const oneTile = (keys: string[]): Layout => ({ tile: 't1', tabs: keys, showing: keys[0]! });

/** `keys` as equal columns of one row, one tile each. */
const columns = (keys: string[]): Layout => ({
  split: 'row',
  items: keys.map((key, i) => ({ tile: `t${i + 1}`, tabs: [key], showing: key })),
});

/** The host page's first script: the stored tabs and the stored (version 1) dock. */
function seedScript(keys: string[], layout: Layout): string {
  const tabs = JSON.stringify({ keys, active: keys[0] });
  return [
    `sessionStorage.setItem(${JSON.stringify(TABS_KEY)}, ${JSON.stringify(tabs)});`,
    `localStorage.setItem(${JSON.stringify(DOCK_KEY)}, ${JSON.stringify(JSON.stringify(storedDock(layout)))});`,
  ].join('\n');
}

/**
 * What the host document saw, recorded by the host page itself: every drag
 * event it received (capture phase), the most drop-highlight elements painted
 * in it at once, and every DOM
 * mutation under its <body>.
 */
const RECORDER = `
window.__hostDrag = { events: [], painted: 0, mutations: 0 };
for (const type of ['dragenter', 'dragover', 'dragleave', 'drop']) {
  document.addEventListener(type, (e) => {
    window.__hostDrag.events.push({
      type,
      types: Array.from(e.dataTransfer ? e.dataTransfer.types : []),
    });
  }, true);
}
new MutationObserver((records) => {
  window.__hostDrag.mutations += records.length;
}).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
(function sample() {
  let painted = 0;
  for (const el of document.querySelectorAll(${JSON.stringify(DROP_PAINT)})) {
    const style = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    if (style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0) painted += 1;
  }
  window.__hostDrag.painted = Math.max(window.__hostDrag.painted, painted);
  requestAnimationFrame(sample);
})();
`;

interface HostDrag {
  events: { type: string; types: string[] }[];
  painted: number;
  mutations: number;
}

const hostDrag = (page: Page): Promise<HostDrag> =>
  page.evaluate(() => (window as unknown as { __hostDrag: HostDrag }).__hostDrag);

/** Forgets what the host document saw so far (after the frame has loaded, or between drags). */
const resetHostDrag = (page: Page): Promise<void> =>
  page.evaluate(() => {
    const seen = (window as unknown as { __hostDrag: HostDrag }).__hostDrag;
    seen.events.length = 0;
    seen.painted = 0;
    seen.mutations = 0;
  });

/**
 * A plain host page: an input of its own, then the framed viewer, seeded with
 * `keys` laid out as `layout`. With `embedded` (the default) the frame carries
 * `embedded=true` and the viewer is embedded in a host (src/workspace/host/hostEmbed.ts);
 * a frame without it is a standalone viewer that happens to be framed.
 */
function plainHostPage(keys: string[], layout: Layout, theme: string, embedded = true): string {
  const flag = embedded ? 'embedded=true&' : '';
  const src = `${PREFIX}/embed/?${flag}theme=${theme}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<link rel="icon" href="data:,">
<title>Dock host</title>
<style>body{margin:0}#host-input{display:block;height:24px;box-sizing:border-box}#viewer{width:1200px;height:700px;border:0;display:block}</style>
</head>
<body>
<input id="host-input" aria-label="Host input">
<script>
${seedScript(keys, layout)}
const frame = document.createElement('iframe');
frame.id = 'viewer';
frame.title = 'viewer';
frame.src = ${JSON.stringify(src)};
document.body.append(frame);
${RECORDER}
</script>
</body>
</html>`;
}

/** Routes the host page itself. Register after installHost, before page.goto. */
async function routeHostPage(page: Page, html: string): Promise<void> {
  await page.route(`**${HOST_PAGE}`, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: html })
  );
}

const viewer = (page: Page): FrameLocator => page.frameLocator('#viewer');
const dock = (frame: FrameLocator): Locator => frame.getByTestId('workspace-dock');
const bar = (frame: FrameLocator, key: string): Locator =>
  frame.locator(`${TILE_BAR}[data-panel-key="${key}"]`);
const stripTab = (frame: FrameLocator, key: string): Locator =>
  frame.locator(`.tab-strip [role="tab"][data-tab-key="${key}"]`);
/** The tile-bar tab of `key` (two or more tiles). */
const tileTab = (frame: FrameLocator, key: string): Locator =>
  frame.locator(`.canopy-tile-bar__tab[data-tab-key="${key}"]`);
/**
 * A point on the uncovered left end of `key`'s tile-bar tab, 6 px in: the
 * tab's centre lies under the showing screen's header in a narrow tile (see
 * `grip`), where a press would drag the header's link instead. In the
 * nested-docks page a tile is about 265 px wide and only the tab's first
 * letter is left uncovered.
 */
async function tileTabStart(frame: FrameLocator, key: string): Promise<{ x: number; y: number }> {
  const box = await tileTab(frame, key).boundingBox();
  if (!box) throw new Error(`tileTabStart: no tab for ${key}`);
  return { x: box.x + Math.min(6, box.width / 2), y: box.y + box.height / 2 };
}
/**
 * The grip of the tile showing `key`. A press on it focuses that tile. The
 * specs click the grip, not the tab: in the 1200 px frame each tile is about
 * 470 px wide and the showing screen's header (the right header actions,
 * about 410 px) covers the bar's tabs (reported as a viewer layout defect).
 */
const grip = (frame: FrameLocator, key: string): Locator =>
  bar(frame, key).locator('.canopy-tile-bar__grip');

/**
 * The viewer's dock as its root's test surface reads it: the showing keys,
 * the holder's layout and dockview's live layout JSON.
 */
async function viewerDock(
  frame: FrameLocator
): Promise<{ showing: string; layout: string; live: string }> {
  return dock(frame).evaluate((root) => {
    const read = (root as HTMLElement & { canopyDockLayout?: () => unknown }).canopyDockLayout;
    if (typeof read !== 'function') throw new Error('no canopyDockLayout on the dock');
    return {
      showing: root.getAttribute('data-showing') ?? '',
      layout: root.getAttribute('data-layout') ?? '',
      live: JSON.stringify(read.call(root)),
    };
  });
}

/** The viewer's layout shape (dockHelpers layoutShape over `data-layout`). */
async function viewerShape(frame: FrameLocator): Promise<string> {
  const raw = await dock(frame).getAttribute('data-layout');
  return layoutShape(JSON.parse(raw ?? 'null') as Layout | null);
}

/** The centre of a locator's box, in top-page coordinates. */
async function centre(target: Locator): Promise<{ x: number; y: number }> {
  const box = await target.boundingBox();
  if (!box) throw new Error('centre: the element has no box');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * A native drag, held: the mouse goes down on `source` (its centre, or
 * `from`), leaves it (which starts
 * the browser's drag) and travels to `to` in small steps, then nudges there so
 * the element under it keeps receiving dragover. The caller releases with
 * page.mouse.up().
 */
async function holdNativeDrag(
  page: Page,
  source: Locator,
  to: { x: number; y: number },
  from?: { x: number; y: number }
): Promise<void> {
  from ??= await centre(source);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 12, from.y + 6, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 25 });
  await page.mouse.move(to.x + 1, to.y + 1, { steps: 2 });
  await page.mouse.move(to.x, to.y, { steps: 2 });
}

test.describe('the dock inside a host page', () => {
  test.describe.configure({ timeout: 30_000 });

  // Embedded in a host and standalone alike: one tile shows its tabs in the
  // strip row and has no tile bar, so there is no bar to carry a hairline.
  test('one tile shows no tile bar and no inner hairline, and its x closes the tab @embed-host', async ({
    page,
  }) => {
    await installHost(page, { sheets: 'synthetic' });
    await routeHostPage(
      page,
      plainHostPage([FIRST, SECOND], oneTile([FIRST, SECOND]), SYNTHETIC_THEME)
    );
    await page.goto(HOST_PAGE);

    const frame = viewer(page);
    await expect(frame.locator('html')).toHaveAttribute('data-canopy-host', '');
    await expect(stripTab(frame, FIRST)).toBeVisible();
    await expect(stripTab(frame, SECOND)).toBeVisible();
    await expect.poll(() => viewerShape(frame)).toBe(`${FIRST}*|${SECOND}`);
    await expect(frame.locator(TILE_BAR)).toHaveCount(0);

    // The frame holds focus (a click on the focused key's tab changes nothing
    // else), and the one tile is the focused one: still no bar, no line.
    await stripTab(frame, FIRST).click();
    await expect.poll(() => frame.locator('body').evaluate(() => document.hasFocus())).toBe(true);
    await expect(frame.locator(TILE_BAR)).toHaveCount(0);
    await expect(frame.locator(HAIRLINE)).toHaveCount(0);

    // The strip tab's x says it closes, and it closes the tab: no parked tab
    // stays behind, the tile keeps the other one.
    const close = stripTab(frame, FIRST).locator('.tab-strip__close');
    await expect(close).toHaveAttribute('title', 'Close');
    await close.click();
    await expect(stripTab(frame, FIRST)).toHaveCount(0);
    await expect.poll(() => viewerShape(frame)).toBe(SECOND);
    await expect(frame.locator(TILE_BAR)).toHaveCount(0);
  });

  test('two tiles show exactly one inner hairline, and none while the frame lacks focus @embed-host', async ({
    page,
  }) => {
    await installHost(page, { sheets: 'synthetic' });
    await routeHostPage(
      page,
      plainHostPage([FIRST, SECOND], columns([FIRST, SECOND]), SYNTHETIC_THEME)
    );
    await page.goto(HOST_PAGE);

    const frame = viewer(page);
    await expect(frame.locator('html')).toHaveAttribute('data-canopy-host', '');
    await expect(frame.locator(TILE_BAR)).toHaveCount(2);
    const hasFocus = () => frame.locator('body').evaluate(() => document.hasFocus());

    // Two tiles: no strip, a bar each.
    await expect(frame.locator('.tab-strip')).toHaveCount(0);

    // Focus in the frame (a click on the focused key's tab changes nothing
    // else): one line, on the focused tile's bar.
    await grip(frame, FIRST).click();
    await expect.poll(hasFocus).toBe(true);
    await expect(frame.locator(HAIRLINE)).toHaveCount(1);
    await expect(bar(frame, FIRST)).toHaveClass(/canopy-tile-bar--focused/);

    // Focus in the host page: the frame's document lost it, and the line with it.
    await page.locator('#host-input').focus();
    await expect(page.locator('#host-input')).toBeFocused();
    await expect.poll(hasFocus).toBe(false);
    await expect(frame.locator(HAIRLINE)).toHaveCount(0);
    await expect(frame.locator(TILE_BAR)).toHaveCount(2);

    // Back in the frame, on the other tile: one line again, on that tile.
    await grip(frame, SECOND).click();
    await expect.poll(hasFocus).toBe(true);
    await expect(frame.locator(HAIRLINE)).toHaveCount(1);
    await expect(bar(frame, SECOND)).toHaveClass(/canopy-tile-bar--focused/);

    // Both inner x buttons say they close the tab (no "tab stays").
    for (const key of [FIRST, SECOND]) {
      await expect(
        bar(frame, key).getByRole('button', { name: new RegExp(`^${CLOSE_TAB_TITLE}`) })
      ).toHaveAttribute('title', CLOSE_TAB_TITLE);
    }
  });

  test('a tab drag that leaves the frame paints nothing in the host page @embed-host', async ({
    page,
  }) => {
    await installHost(page, { sheets: 'synthetic' });
    await routeHostPage(
      page,
      plainHostPage([FIRST, SECOND], columns([FIRST, SECOND]), SYNTHETIC_THEME)
    );
    await page.setViewportSize({ width: 1500, height: 900 });
    await page.goto(HOST_PAGE);

    const frame = viewer(page);
    await expect(frame.locator(TILE_BAR)).toHaveCount(2);
    await expect(tileTab(frame, FIRST)).toBeVisible();
    // dockview has laid the dock out at the frame's size (it starts at 100 x 100).
    await expect
      .poll(
        async () =>
          (JSON.parse((await viewerDock(frame)).live) as { grid: { width: number } }).grid.width
      )
      .toBeGreaterThan(100);
    const before = await viewerDock(frame);
    const hostChildren = await page.locator('body > *').count();
    await resetHostDrag(page);

    // Out of the frame's right edge (the frame is 1200 px wide), into the host page.
    await holdNativeDrag(
      page,
      tileTab(frame, FIRST),
      { x: 1350, y: 400 },
      await tileTabStart(frame, FIRST)
    );
    // The drag is real: the viewer raised its shield, and the host document
    // receives the viewer's drag once the pointer is outside the frame.
    await expect
      .poll(async () => (await hostDrag(page)).events.filter((e) => e.type === 'dragover').length)
      .toBeGreaterThan(0);
    await expect(frame.locator(DOCK_OVERLAY)).toHaveAttribute('data-dragging', 'true');
    const held = await hostDrag(page);
    expect(held.events.every((e) => e.types.includes(DOCK_MIME))).toBe(true);
    expect(held.painted).toBe(0);
    expect(held.mutations).toBe(0);
    expect(await page.locator('body > *').count()).toBe(hostChildren);

    await page.mouse.up();
    // The source tab got its dragend inside the frame: the shield is down again.
    await expect(frame.locator(`${DOCK_OVERLAY}[data-dragging]`)).toHaveCount(0);
    const after = await hostDrag(page);
    expect(after.painted).toBe(0);
    expect(after.mutations).toBe(0);
    expect(after.events.filter((e) => e.type === 'drop')).toEqual([]);
    expect(await viewerDock(frame)).toEqual(before);
  });
});
