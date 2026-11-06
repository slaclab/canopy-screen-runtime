// /s/ takes the embed's theme input. With a dark shell theme stored by the
// host origin (localStorage canopy.theme, html[data-theme=dark]), a deep
// link with ?theme=light is light from its first paint, and a colour role on
// the screen resolves to the scheme's LIGHT value: the screen root's own
// data-theme, not html's, selects the `--cr-<i>` block (the real cascade).
// Without ?theme= the page is light too, today's look.
//
// The expected colour comes from the served config's colorScheme when it has
// one, else from the default scheme, so a config change cannot break this.

import { expect, test, type Page } from '@playwright/test';
import { canopyDefaultFlat, parseFlatScheme } from '@slaclab/canopy-screen-ir';
import type { FlatScheme } from '@slaclab/canopy-screen-ir';

const PREFIX = '/x/y/';
const SCREEN = `${PREFIX}s/drafts/s-theme`;
const ROLE = 'MAJOR';

/** The scheme the viewer renders with: config.colorScheme, else the default. */
async function servedScheme(page: Page): Promise<FlatScheme> {
  const response = await page.request.get(`${PREFIX}config.json`);
  expect(response.ok()).toBe(true);
  const config = (await response.json()) as { colorScheme?: unknown };
  if (config.colorScheme === undefined || config.colorScheme === null) return canopyDefaultFlat;
  const parsed = parseFlatScheme(config.colorScheme);
  if ('error' in parsed) throw new Error(`served colorScheme is invalid: ${parsed.error}`);
  return parsed;
}

/** '#da1e28' -> 'rgb(218, 30, 40)', the computed-style form. */
function rgb(hex: string): string {
  const n = (i: number) => parseInt(hex.slice(i, i + 2), 16);
  return `rgb(${n(1)}, ${n(3)}, ${n(5)})`;
}

function roleColour(scheme: FlatScheme, mode: 'light' | 'dark'): string {
  const i = scheme.roles.indexOf(ROLE);
  expect(i, `role ${ROLE} in the scheme`).toBeGreaterThanOrEqual(0);
  return rgb((mode === 'light' ? scheme.light : scheme.dark)[i]!);
}

/**
 * A dark shell theme, as a host origin leaves it, and a recorder of every
 * data-theme the screen root shows, from the moment it is attached.
 */
async function darkShell(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('canopy.theme', 'dark');
    // The parser replaces the init-time <html>; mark the parsed one, which
    // happens before the viewer's (deferred, module) scripts run.
    document.addEventListener('readystatechange', () => {
      if (document.readyState === 'interactive') document.documentElement.dataset.theme = 'dark';
    });
    const seen: string[] = [];
    (window as unknown as { __rootThemes: string[] }).__rootThemes = seen;
    new MutationObserver(() => {
      const root = document.querySelector<HTMLElement>('[data-testid="screen-root"]');
      const theme = root?.dataset.theme;
      if (theme !== undefined && seen[seen.length - 1] !== theme) seen.push(theme);
    }).observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-theme'],
    });
  });
}

const rootThemes = (page: Page) =>
  page.evaluate(() => (window as unknown as { __rootThemes: string[] }).__rootThemes);

test.describe('/s/ theme input', () => {
  test('?theme=light is light on first paint under a dark shell theme', async ({ page }) => {
    const scheme = await servedScheme(page);
    expect(roleColour(scheme, 'light')).not.toBe(roleColour(scheme, 'dark'));
    await darkShell(page);
    await page.goto(`${SCREEN}?theme=light`);

    const root = page.locator('.viewer-canvas [data-testid="screen-root"]');
    await expect(root).toBeVisible();
    await expect(root).toHaveAttribute('data-theme', 'light');
    // The host hook sets html[data-theme] to the page's own mode on /s/ too
    // (light|dark there), so html follows the input and not the stored shell.
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    // The root was never dark, not even for one frame.
    expect(await rootThemes(page)).toEqual(['light']);
    // Carbon follows the same input.
    await expect(page.locator('.viewer-embed.cds--white')).toHaveCount(1);

    const label = root.getByText('ROLE-MAJOR', { exact: true });
    await expect(label).toBeVisible();
    await expect(label).toHaveCSS('color', roleColour(scheme, 'light'));
  });

  test("without ?theme= the page is light (today's look)", async ({ page }) => {
    const scheme = await servedScheme(page);
    await darkShell(page);
    await page.goto(SCREEN);
    const root = page.locator('.viewer-canvas [data-testid="screen-root"]');
    await expect(root).toHaveAttribute('data-theme', 'light');
    await expect(root.getByText('ROLE-MAJOR', { exact: true })).toHaveCSS(
      'color',
      roleColour(scheme, 'light')
    );
  });

  test("?theme=dark resolves the role to the scheme's dark value", async ({ page }) => {
    const scheme = await servedScheme(page);
    await page.goto(`${SCREEN}?theme=dark`);
    const root = page.locator('.viewer-canvas [data-testid="screen-root"]');
    await expect(root).toHaveAttribute('data-theme', 'dark');
    await expect(root.getByText('ROLE-MAJOR', { exact: true })).toHaveCSS(
      'color',
      roleColour(scheme, 'dark')
    );
  });
});
