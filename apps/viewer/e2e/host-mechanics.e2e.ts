// The mechanics of the host stylesheet hook in the viewer, on chromium and
// firefox (playwright.config.ts adds this spec to the firefox project). The
// viewer runs in the stand-in host of hostFixture.ts against the shell's
// synthetic host sheet (host.css: three fake themes, probe-a-dark,
// probe-b-dark and probe-light, plus a host's color-scheme rules).
//
// What is asserted, and why it matters:
//
//   * every marked host sheet had rules before the first module ran (the
//     fixture's module marker), so the first paint already has host
//     colours and the fallback's "settled when the entry runs" premise holds;
//   * the viewer's own contract sheet (html[data-canopy-host] ...) is loaded
//     and the document is marked;
//   * exactly 0 / 1 / 1 / 1 `canopy:` warnings for standalone / a 404 sheet /
//     an empty sheet / a sheet declaring contract 2, the marker dropped in the
//     two dead-sheet cases (on chromium a 404 leaves a non-null sheet with no
//     rules; asserted so an engine change is noticed);
//   * html color-scheme follows the mode of a dark and a light id;
//   * the anchor's data-theme follows same-mode and cross-mode flips, on
//     /embed and on /s/;
//   * the Trace iframe src carries the concrete id and one embedded=true, also
//     when the ?theme= input tries to inject its own query pairs, and a later
//     flip reaches the Trace frame as canopy:trace-theme {mode, theme};
//   * the ScreenTree menu renders inside the anchor and takes host values;
//   * the write dialog is visible, its decline button differs from its
//     container and the confirm label lies inside its button;
//   * every footer button of the Save-collection dialog lies inside the
//     dialog box, in its Save and its Replace state;
//   * standalone (nothing installed, ?theme=light) every viewer probe row
//     holds its standalone branch; the dock rows read two seeded tiles (and a
//     held tab drag) in the tiles-with-tabs model, every other row reads the
//     one tile.

import { expect, test, type Frame, type Page } from '@playwright/test';
import { E2E_USER_COOKIE, e2eUser } from './collectionsFixture';
import {
  edgePoint,
  holdDrag,
  releaseDrag,
  seedDock,
  tileContentRect,
  type Layout,
} from './dockHelpers';
import { installHareMock, installHost, type HostScenario } from './hostFixture';
import {
  checkRow,
  hostFixture,
  hostProbes,
  pageFor,
  readHostValues,
  runSetups,
  viewerRows,
  type ProbeRow,
} from './hostProbes';

const PREFIX = '/x/y';
const TABS = 'canopy-viewer:tabs:/x/y';
const TRACE_PATH = '/x/y/trace/';
const ANCHOR = '[data-canopy-host-root]';
const DARK = 'probe-a-dark';
const DARK_B = 'probe-b-dark';
const LIGHT = 'probe-light';
// The dock rows: the setups that split the dock and hold a tab drag, and the
// elements that show the state they produced.
const SECOND_TILE = 'dock-second-tile';
const HOLD_DRAG = 'hold-tab-drag';
const TILE_BAR = '[data-testid="tile-bar"]';
const DOCK_OVERLAY = '.canopy-dock-overlay';

const goto = (page: Page) => (path: string) => page.goto(`${PREFIX}${path}`);

// --- the dock rows, in the tiles-with-tabs model ----------------------------------------
//
// The shell's probe table still describes the dock before tiles with tabs: a bar on every
// docked panel from the first tile on, a bar title of its own (`tile-bar-title`), dockview's
// drop target as the highlight, and setups (`dock-second-tile`, `hold-tab-drag`) that drive
// the strip's old "Open in a new tile" item and `data-docked`. The viewer has none of these
// any more: bars come from two tiles on, each lists its tile's tabs, and the drop
// preview is the viewer's own. Until the table follows (an SDK change), the viewer reads
// each dock row in the model it has, against the row's own expectations: two tiles seeded
// with the probe screen focused on the right, the other tile's first tab hidden (so the
// first bar, its first × and its first title are an unfocused bar's), the bar's tab title for
// the title, and a held tab drag's split preview for the highlight.

/** The probe page's screen: the focused tile's showing tab. */
const PROBE_KEY = 'drafts/host-probe';
/** The tab held in `hold-tab-drag`: the left tile's hidden tab. */
const DRAGGED_KEY = 'drafts/e2e-panel';
const DOCK_TILES: Layout = {
  split: 'row',
  items: [
    {
      tile: 't1',
      tabs: [DRAGGED_KEY, 'drafts/wide-panel'],
      showing: 'drafts/wide-panel',
      size: 0.5,
    },
    { tile: 't2', tabs: [PROBE_KEY], showing: PROBE_KEY, size: 0.5 },
  ],
};
/** Old dock selectors and the elements that hold their place now. */
const DOCK_SELECTORS: Record<string, string> = {
  '[data-testid=tile-bar-title]': '.canopy-tile-bar__title',
  '.dv-drop-target-anchor':
    '.canopy-dock-drop-preview__rect--split .canopy-dock-drop-preview__placeholder',
};
const DOCK_SETUPS: readonly string[] = [SECOND_TILE, HOLD_DRAG];

/** True for a probe row of the dock (its bars or its drop highlight). */
function isDockRow(row: ProbeRow): boolean {
  return (
    row.selector.startsWith('.canopy-tile-bar') ||
    row.selector in DOCK_SELECTORS ||
    (row.setup as string[]).some((s) => DOCK_SETUPS.includes(s))
  );
}

/** The row as the viewer reads it: a dock row's selector and setups in today's model. */
function viewerRow(row: ProbeRow): ProbeRow {
  if (!isDockRow(row)) return row;
  return {
    ...row,
    selector: DOCK_SELECTORS[row.selector] ?? row.selector,
    setup: row.setup.filter((s) => !DOCK_SETUPS.includes(s)),
  };
}

/** Px inside the probe tile's bottom edge: its edge zone, clear of the dock's outer band. */
const EDGE_INSET = 64;

/** Holds a tile-bar tab drag over the probe tile's bottom edge, its split preview painted. */
async function holdDockDrag(page: Page): Promise<void> {
  const rect = await tileContentRect(page, PROBE_KEY);
  expect(rect, 'the probe tile is placed').not.toBeNull();
  const held = await holdDrag(
    page,
    { from: 'tab', key: DRAGGED_KEY },
    edgePoint(rect!, 'bottom', EDGE_INSET)
  );
  expect(held.preview?.kind, 'the held drag paints a split preview').toBe('split');
}

/** The first viewer row with this setup (the probe table owns the selectors). */
function rowWith(setup: string): ProbeRow {
  const row = viewerRows.find((r) => (r.setup as string[]).includes(setup));
  if (!row) throw new Error(`no viewer row with setup ${setup}`);
  return row;
}

/** Collects every `canopy:` console warning, from before the page loads. */
function canopyWarnings(page: Page): string[] {
  const warnings: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'warning' && m.text().startsWith('canopy:')) warnings.push(m.text());
  });
  return warnings;
}

/** Opens the default probe page and waits until the app has rendered its anchor. */
async function openProbePage(page: Page, theme: string) {
  await goto(page)(pageFor(hostProbes, { app: 'viewer' }, theme));
  await expect(page.locator(ANCHOR)).toBeAttached();
  await expect(page.locator('[data-testid=screen-root]').first()).toBeAttached();
}

const postTheme = (page: Page, theme: string) =>
  page.evaluate((theme) => window.postMessage({ type: 'canopy:theme', theme }, '*'), theme);

/** Resolves once every running animation and transition (Carbon's hover fades) has ended. */
const settled = (page: Page) =>
  page.evaluate(() =>
    Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined)))
  );

const htmlAttr = (page: Page, name: string) =>
  page.evaluate((name) => document.documentElement.getAttribute(name), name);

test.describe('host stylesheet mechanics', () => {
  test.describe.configure({ timeout: 30_000 });

  test('every host sheet is usable before the first module runs', async ({ page }) => {
    await installHost(page, { sheets: 'synthetic' });
    await openProbePage(page, DARK);

    expect(
      await page.evaluate(
        () =>
          (window as unknown as { __hostSheetLoadedAtModule?: unknown }).__hostSheetLoadedAtModule
      )
    ).toBe(true);
    const order = await page.evaluate(() => {
      const scripts = [...document.scripts];
      const marker = scripts.findIndex((s) =>
        (s.textContent ?? '').includes('__hostSheetLoadedAtModule')
      );
      const head = [...document.head.children];
      const markerEl = scripts[marker];
      const links = [...document.querySelectorAll('link[data-canopy-host-sheet]')];
      return {
        markerIsLast: marker >= 0 && marker === scripts.length - 1,
        links: links.length,
        linksBefore:
          markerEl !== undefined &&
          links.every((l) => head.indexOf(l) >= 0 && head.indexOf(l) < head.indexOf(markerEl)),
      };
    });
    expect(order).toEqual({ markerIsLast: true, links: 3, linksBefore: true });
  });

  test('the contract sheet is loaded and the document is marked', async ({ page }) => {
    await installHost(page, { sheets: 'synthetic' });
    await openProbePage(page, DARK);

    expect(await htmlAttr(page, 'data-canopy-host')).toBe('');
    const contract = await page.evaluate(() => {
      const walk = (rules: CSSRuleList): boolean =>
        [...rules].some(
          (r) =>
            (r instanceof CSSStyleRule && r.selectorText.startsWith('html[data-canopy-host]')) ||
            ('cssRules' in r && walk((r as CSSGroupingRule).cssRules))
        );
      return [...document.styleSheets].some((s) => {
        try {
          return walk(s.cssRules);
        } catch {
          return false;
        }
      });
    });
    expect(contract, 'a stylesheet with an html[data-canopy-host] rule').toBe(true);
  });

  test('standalone logs no canopy warning', async ({ page }) => {
    const warnings = canopyWarnings(page);
    await openProbePage(page, 'light');
    expect(await htmlAttr(page, 'data-canopy-host')).toBeNull();
    await page.waitForTimeout(250);
    expect(warnings).toEqual([]);
  });

  test('a healthy host sheet logs no canopy warning', async ({ page }) => {
    const warnings = canopyWarnings(page);
    await installHost(page, { sheets: 'synthetic' });
    await openProbePage(page, DARK);
    await page.waitForTimeout(250);
    expect(warnings).toEqual([]);
  });

  const scenarios: { scenario: HostScenario; cleared: boolean; text: RegExp }[] = [
    { scenario: '404', cleared: true, text: /^canopy: host stylesheet did not load/ },
    { scenario: 'empty-200', cleared: true, text: /^canopy: host stylesheet did not load/ },
    { scenario: 'wrong-major', cleared: false, text: /contract version 2; expected 1\.x/ },
  ];
  for (const { scenario, cleared, text } of scenarios) {
    test(`a ${scenario} host sheet logs exactly one canopy warning`, async ({
      page,
      browserName,
    }) => {
      const warnings = canopyWarnings(page);
      await installHost(page, { sheets: 'synthetic', scenario });
      await openProbePage(page, DARK);
      await page.waitForTimeout(250);

      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(text);
      expect(await htmlAttr(page, 'data-canopy-host')).toBe(cleared ? null : '');

      if (scenario === '404' && browserName === 'chromium') {
        // Chromium keeps a sheet object for a failed load; the fallback reads
        // "no rules" as dead. An engine that starts nulling it shows here.
        const sheet = await page.evaluate(() => {
          const link = document.querySelector<HTMLLinkElement>(
            'link[data-canopy-host-sheet][href$="/design-system/css/canopy-host.css"]'
          );
          return link?.sheet ? { present: true, rules: link.sheet.cssRules.length } : null;
        });
        expect(sheet).toEqual({ present: true, rules: 0 });
      }
    });
  }

  for (const theme of [DARK, LIGHT]) {
    test(`html color-scheme follows the mode of ${theme}`, async ({ page }) => {
      const mode = hostFixture.themes[theme]!.mode;
      await installHost(page, { sheets: 'synthetic' });
      await openProbePage(page, theme);
      await expect(page.locator('html')).toHaveAttribute('data-theme', mode);
      expect(
        await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)
      ).toBe(mode);
    });
  }

  test('the /embed anchor follows a same-mode and a cross-mode flip', async ({ page }) => {
    await installHost(page, { sheets: 'synthetic' });
    await openProbePage(page, DARK);
    const anchor = page.locator(`.viewer-embed${ANCHOR}`);
    await expect(anchor).toHaveAttribute('data-theme', DARK);
    expect(await readHostValues(page, ['accent'])).toEqual({
      accent: hostFixture.themes[DARK]!.values['accent'],
    });

    await postTheme(page, DARK_B);
    await expect(anchor).toHaveAttribute('data-theme', DARK_B);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    expect(await readHostValues(page, ['accent'])).toEqual({
      accent: hostFixture.themes[DARK_B]!.values['accent'],
    });

    await postTheme(page, LIGHT);
    await expect(anchor).toHaveAttribute('data-theme', LIGHT);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe(
      'light'
    );
  });

  test('/s/ shows host values and follows a cross-mode flip', async ({ page }) => {
    await installHost(page, { sheets: 'synthetic' });
    await goto(page)(`/s/drafts/host-probe?embedded=true&theme=${LIGHT}`);
    const anchor = page.locator(`.viewer-embed${ANCHOR}`);
    await expect(anchor).toHaveAttribute('data-theme', LIGHT);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

    // A label of the probe screen paints the host's text-secondary.
    const label = viewerRows.find((r) => r.selector.includes('carbon-pv-display__label'));
    if (!label) throw new Error('no pv-display label row');
    await expect(page.locator(label.selector).first()).toBeVisible();
    await checkRow(page, label, { hosted: true, hostValues: hostFixture.themes[LIGHT]!.values });

    await postTheme(page, DARK_B);
    await expect(anchor).toHaveAttribute('data-theme', DARK_B);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await checkRow(page, label, { hosted: true, hostValues: hostFixture.themes[DARK_B]!.values });
  });

  test('the ScreenTree menu renders inside the anchor and takes host values', async ({ page }) => {
    const row = rowWith('open-screen-tree-menu');
    await installHost(page, { sheets: 'synthetic' });
    await openProbePage(page, DARK);
    await runSetups(page, row, { theme: DARK, goto: goto(page) });

    const menu = page.locator(row.selector).first();
    await expect(menu).toBeVisible();
    expect(await menu.evaluate((el, anchor) => el.closest(anchor) !== null, ANCHOR)).toBe(true);
    await settled(page);
    await checkRow(page, row, { hosted: true, hostValues: hostFixture.themes[DARK]!.values });
  });

  test('the write dialog is visible, its decline differs from its container, its confirm label fits', async ({
    page,
  }) => {
    const row = rowWith('open-write-dialog');
    await installHost(page, { sheets: 'synthetic', hare: true });
    await goto(page)(pageFor(hostProbes, row, DARK));
    await runSetups(page, row, { theme: DARK, goto: goto(page) });

    await expect(page.locator('[data-testid=canopy-write-dialog]')).toBeVisible();
    await settled(page);
    const decline = await page
      .locator('[data-testid=canopy-write-decline]')
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    const container = await page
      .locator('.cds--modal-container')
      .first()
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(decline, 'decline button against the modal container').not.toBe(container);

    const fit = await page.locator('[data-testid=canopy-write-confirm]').evaluate((button) => {
      const range = document.createRange();
      range.selectNodeContents(button);
      const label = range.getBoundingClientRect();
      const box = button.getBoundingClientRect();
      const eps = 0.5;
      return {
        label: label.width > 0 && label.height > 0,
        inside:
          label.left >= box.left - eps &&
          label.right <= box.right + eps &&
          label.top >= box.top - eps &&
          label.bottom <= box.bottom + eps,
      };
    });
    expect(fit).toEqual({ label: true, inside: true });
  });
});

test.describe('save-collection dialog footer', () => {
  /** Each footer button's box against the dialog box (eps 0.5 px). */
  const footerFits = (page: Page) =>
    page.locator('.cds--modal.is-visible .cds--modal-container').evaluate((dialog) => {
      const box = dialog.getBoundingClientRect();
      const eps = 0.5;
      return Array.from(dialog.querySelectorAll('.cds--modal-footer .cds--btn')).map((el) => {
        const r = el.getBoundingClientRect();
        return {
          label: (el.textContent ?? '').trim(),
          inside:
            r.width > 0 &&
            r.left >= box.left - eps &&
            r.right <= box.right + eps &&
            r.top >= box.top - eps &&
            r.bottom <= box.bottom + eps,
        };
      });
    });

  test('every Save and Replace footer button lies inside the dialog box', async ({
    page,
    context,
    baseURL,
  }, testInfo) => {
    // Collections are on for this test's own e2e user (see collectionsFixture.ts).
    const user = e2eUser(testInfo.testId, testInfo.workerIndex, testInfo.retry);
    await context.addCookies([{ name: E2E_USER_COOKIE, value: user, url: baseURL! }]);
    const reset = await context.request.post(`${PREFIX}/__collections-reset?mode=on`);
    expect(reset.ok(), await reset.text()).toBe(true);

    await installHost(page, { sheets: 'synthetic' });
    await openProbePage(page, DARK);
    await page.getByTestId('collections-popover-trigger').click();
    await page
      .getByRole('group', { name: 'Collections' })
      .getByRole('button', { name: 'Save open tabs as collection…' })
      .click();
    const dialog = page.locator('.cds--modal.is-visible');
    await expect(dialog).toBeVisible();
    await settled(page);
    expect(await footerFits(page)).toEqual([
      { label: 'Cancel', inside: true },
      { label: 'Save', inside: true },
    ]);

    // A personal collection picked as the target: the primary reads Replace.
    await page.locator('#save-collection-target').selectOption('grid');
    await expect(
      dialog.locator('.cds--modal-footer').getByRole('button', { name: 'Replace', exact: true })
    ).toBeVisible();
    await settled(page);
    expect(await footerFits(page)).toEqual([
      { label: 'Cancel', inside: true },
      { label: 'Replace', inside: true },
    ]);
  });
});

/** Seed the stored tabs before the app runs: top window only, key absent. */
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

/** Record every message each frame receives, from before its scripts run (as stub.e2e.ts). */
async function captureMessages(page: Page) {
  await page.addInitScript(() => {
    const store: unknown[] = [];
    (window as unknown as { __messages: unknown[] }).__messages = store;
    window.addEventListener('message', (event) => store.push(event.data));
  });
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

/** What the Trace stub frame has received: its own log and the captured messages. */
function traceReceived(page: Page) {
  return traceFrame(page).evaluate(() => {
    const w = window as unknown as {
      __traceStub?: { received: unknown[] };
      __messages?: unknown[];
    };
    return { stub: w.__traceStub?.received ?? [], messages: w.__messages ?? [] };
  });
}

function probeId(name: string): string {
  return `${name}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

test.describe('host theme into the Trace tab', () => {
  test.describe.configure({ timeout: 30_000 });

  for (const { label, theme, expected } of [
    { label: 'a concrete id', theme: DARK, expected: DARK },
    // ?theme=probe-a-dark&embedded=false as one value: not an id, so the mode stands in.
    { label: 'an injection input', theme: `${DARK}%26embedded%3Dfalse`, expected: 'dark' },
  ]) {
    test(`the Trace src carries ${label} as theme=${expected} and one embedded=true`, async ({
      page,
    }) => {
      await seedTraceTab(page, `pv=PROBE:${probeId('src')}&range=-1h`);
      await installHost(page, { sheets: 'synthetic' });
      await goto(page)(`/embed/?embedded=true&theme=${theme}`);
      const iframe = page.locator('iframe.workspace-trace');
      await expect(iframe).toBeAttached();
      const src = new URL((await iframe.getAttribute('src'))!);
      expect(src.searchParams.getAll('theme')).toEqual([expected]);
      expect(src.searchParams.getAll('embedded')).toEqual(['true']);
      expect(src.href).not.toContain('embedded=false');
    });
  }

  test('a desy-dark -> retro-dark flip reaches the Trace frame', async ({ page }) => {
    const id = probeId('flip');
    await captureMessages(page);
    await seedTraceTab(page, `pv=PROBE:${id}&range=-1h`);
    await installHost(page, { sheets: 'synthetic' });
    await goto(page)('/embed/?embedded=true&theme=desy-dark');

    const iframe = page.locator('iframe.workspace-trace');
    await expect(page.frameLocator('iframe.workspace-trace').locator('#probe')).toHaveText(id);
    const src = await iframe.getAttribute('src');
    expect(src).toContain('theme=desy-dark');
    await expect
      .poll(async () => (await traceReceived(page)).stub)
      .toContainEqual({ type: 'canopy:trace-theme', mode: 'dark', theme: 'desy-dark' });

    await postTheme(page, 'retro-dark');
    await expect(page.locator(`.viewer-embed${ANCHOR}`)).toHaveAttribute(
      'data-theme',
      'retro-dark'
    );
    const want = { type: 'canopy:trace-theme', mode: 'dark', theme: 'retro-dark' };
    await expect.poll(async () => (await traceReceived(page)).stub).toContainEqual(want);
    expect((await traceReceived(page)).messages).toContainEqual(want);
    // The flip never reloads the frame.
    expect(await iframe.getAttribute('src')).toBe(src);
  });
});

test.describe('standalone: every viewer probe row holds its standalone branch', () => {
  test.describe.configure({ timeout: 30_000 });

  for (const [i, tableRow] of viewerRows.entries()) {
    const setup = tableRow.setup.length > 0 ? ` [${tableRow.setup.join(', ')}]` : '';
    const name = `viewer row ${i}: ${tableRow.selector}${tableRow.pseudo ?? ''}${setup}`;
    test(name, async ({ page }) => {
      const row = viewerRow(tableRow);
      const twoTiles = isDockRow(tableRow);
      const held = (tableRow.setup as string[]).includes(HOLD_DRAG);
      if (row.viewport) await page.setViewportSize(row.viewport);
      if (row.hare) await installHareMock(page);
      if (twoTiles) {
        await page.setViewportSize({ width: 1400, height: 900 });
        await seedDock(
          page,
          { keys: [DRAGGED_KEY, 'drafts/wide-panel', PROBE_KEY], active: PROBE_KEY },
          DOCK_TILES
        );
      }
      // The danger menu-item rows need a saved view; the server answers 200 on a repeat.
      const seeded = await page.request.put(`${PREFIX}/views/host-probe-view`, {
        data: { name: 'Host probe view', query: '', kind: 'trace' },
      });
      expect(seeded.ok()).toBe(true);

      await goto(page)(pageFor(hostProbes, row, 'light'));
      await runSetups(page, row, { theme: 'light', goto: goto(page) });
      const bars = page.locator(TILE_BAR);
      if (twoTiles) await expect(bars).toHaveCount(2);
      if (held) await holdDockDrag(page);
      await expect(page.locator(row.selector).first()).toBeAttached();

      // The dock state a row reads comes from its seed alone: two tiles only for
      // a dock row, so every other row reads the one tile (which has no bar), and
      // a live drag only under hold-tab-drag.
      if (!twoTiles) expect(await bars.count()).toBe(0);
      const overlay = page.locator(DOCK_OVERLAY);
      if (held) await expect(overlay).toHaveAttribute('data-dragging', 'true');
      else await expect(page.locator(`${DOCK_OVERLAY}[data-dragging]`)).toHaveCount(0);

      // A clicking setup (select-first-nav-row) leaves the pointer on the row,
      // which then paints its hover state; only a hover row reads that.
      if (!row.setup.some((s) => s.startsWith('hover'))) await page.mouse.move(0, 0);
      await settled(page);
      const result = await checkRow(page, row, { hosted: false });
      expect(result.gated).toBe(false);
      // Let the drag go without a drop: both tiles stay as they were.
      if (held) {
        await releaseDrag(page, 'cancel');
        await expect(page.locator(`${DOCK_OVERLAY}[data-dragging]`)).toHaveCount(0);
        await expect(bars).toHaveCount(2);
      }
    });
  }
});
