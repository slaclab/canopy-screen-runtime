// Fixture mode: `?_canopyPv=fixture&_canopyFixture=<key>` renders a screen
// from a recorded snapshot. Plain PVs, rule ladders, formula-arm rules and
// formula:// channels all come from the snapshot, evaluated in the page, and the
// page opens no WebSocket and talks to neither Hare nor the Formula Engine.
//
// server.mjs does not serve `__fixture/`: the synthetic snapshot is fulfilled
// with page.route, as the rendering harness does with a recorded one.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

const PREFIX = '/x/y/';
const KEY = 'synthetic';
const SNAPSHOT = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'fixtures/fixture-mode/synthetic.snapshot.json'),
    'utf8'
  )
) as unknown;
const QUERY = `?_canopyPv=fixture&_canopyFixture=${KEY}`;
const ROUTES = [
  `${PREFIX}s/drafts/fixture-mode${QUERY}`,
  `${PREFIX}embed/drafts/fixture-mode${QUERY}`,
];

interface Traffic {
  requests: string[];
  failures: string[];
  websockets: string[];
  fixtureFetches: number;
}

/** Record all traffic, and serve the synthetic snapshot at `__fixture/<KEY>.json`. */
async function fixturePage(page: Page): Promise<Traffic> {
  const traffic: Traffic = { requests: [], failures: [], websockets: [], fixtureFetches: 0 };
  page.on('request', (request) => traffic.requests.push(request.url()));
  page.on('response', (response) => {
    if (response.status() >= 400) traffic.failures.push(`${response.status()} ${response.url()}`);
  });
  page.on('requestfailed', (request) =>
    traffic.failures.push(`failed ${request.url()} (${request.failure()?.errorText ?? '?'})`)
  );
  page.on('websocket', (ws) => traffic.websockets.push(ws.url()));
  await page.route(`**${PREFIX}__fixture/${KEY}.json`, (route) => {
    traffic.fixtureFetches += 1;
    return route.fulfill({ json: SNAPSHOT });
  });
  return traffic;
}

for (const route of ROUTES) {
  test.describe(`fixture mode at ${route.split('?')[0]}`, () => {
    test('renders every channel from the snapshot', async ({ page }) => {
      const traffic = await fixturePage(page);
      await page.goto(route);
      const canvas = page.locator('.viewer-canvas [data-testid="screen-root"]');
      await expect(canvas).toBeVisible();

      // Plain PVs: an enum as its stored index, SEVR feeding the alarm tag,
      // a recorded-disconnected PV as '---'.
      await expect(canvas.getByText('2', { exact: true })).toBeVisible();
      await expect(canvas.getByText('42', { exact: true })).toBeVisible();
      await expect(canvas.getByText('MAJOR', { exact: true })).toBeVisible();
      await expect(canvas.getByText('---', { exact: true })).toBeVisible();
      // formula:// channel: {MEM_MAX} / {MEM_FREE} * 100 over the snapshot.
      await expect(canvas.getByText('400', { exact: true })).toBeVisible();
      // Rule ladder (LEVEL 3 -> the '> 2' arm) and a formula-arm rule (3 + 4 > 5).
      await expect(canvas.getByText('LADDER-MID', { exact: true })).toBeVisible();
      await expect(canvas.getByText('wide', { exact: true })).toBeVisible();
      await expect(canvas.getByText('LADDER-DEFAULT')).toHaveCount(0);
      await expect(canvas.getByText('ARM-DEFAULT')).toHaveCount(0);

      expect(await page.evaluate(() => window.__canopy?.pvStatus)).toBe('connected');
      await page.waitForLoadState('networkidle');
      expect(traffic.fixtureFetches).toBeGreaterThanOrEqual(1);
      expect(traffic.failures).toEqual([]);
    });

    test('makes no WebSocket, Hare or Formula Engine request', async ({ page }) => {
      const traffic = await fixturePage(page);
      await page.goto(route);
      await expect(page.locator('.viewer-canvas [data-testid="screen-root"]')).toBeVisible();
      await expect(page.getByText('wide', { exact: true })).toBeVisible();
      await page.waitForLoadState('networkidle');

      expect(traffic.websockets).toEqual([]);
      const live = traffic.requests.filter((url) => {
        const { protocol, pathname } = new URL(url);
        return protocol.startsWith('ws') || /\/(hare|formula-engine)(\/|$)/.test(pathname);
      });
      expect(live).toEqual([]);
    });
  });
}

test('without the fixture params the same screen stays on mock PVs', async ({ page }) => {
  const traffic = await fixturePage(page);
  await page.goto(`${PREFIX}s/drafts/fixture-mode`);
  await expect(page.locator('.viewer-canvas [data-testid="screen-root"]')).toBeVisible();
  await page.waitForLoadState('networkidle');
  expect(await page.evaluate(() => window.__canopy?.pvStatus)).toBe('mock');
  expect(traffic.fixtureFetches).toBe(0);
});
