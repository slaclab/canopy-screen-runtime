// Smoke test for the Trace stub and the hooks e2e/server.mjs adds for the
// workspace specs: the stub loads directly under <prefix>/trace/, announces
// itself with canopy:trace-ready, and polls the Mole archiver list under its
// own probe id, which the server counts per probe.

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const PREFIX = '/x/y/';

/** A probe id unique to this run, so retries and parallel workers never share a counter. */
function probe(name: string): string {
  return `${name}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function moleCount(request: APIRequestContext, id: string): Promise<number> {
  const response = await request.get(`${PREFIX}__mole-count?probe=${id}`);
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { probe: string; count: number };
  expect(body.probe).toBe(id);
  return body.count;
}

/** Record every message the page receives, from before the stub's script runs. */
async function captureMessages(page: Page) {
  await page.addInitScript(() => {
    const store: unknown[] = [];
    (window as unknown as { __messages: unknown[] }).__messages = store;
    window.addEventListener('message', (event) => store.push(event.data));
  });
}

test.describe('Trace stub', () => {
  test('loads under the prefix with its base injected and posts ready', async ({ page }) => {
    const failures: string[] = [];
    page.on('response', (r) => {
      if (r.status() >= 400) failures.push(`${r.status()} ${r.url()}`);
    });
    await captureMessages(page);
    const id = probe('a');
    await page.goto(`${PREFIX}trace/?pv=PROBE:${id}&range=-1h`);

    await expect(page.locator('#probe')).toHaveText(id);
    await expect(page.locator('base')).toHaveCount(1);
    await expect(page.locator('base')).toHaveAttribute('href', '/x/y/trace/');
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __messages: unknown[] }).__messages))
      .toContainEqual({ type: 'canopy:trace-ready' });
    await expect(page.locator('body')).toHaveAttribute('data-visible', 'true');
    expect(failures).toEqual([]);
  });

  test('probes a and b count independently', async ({ page, browser, request }) => {
    const a = probe('a');
    const b = probe('b');
    expect(await moleCount(request, a)).toBe(0);
    expect(await moleCount(request, b)).toBe(0);

    await page.goto(`${PREFIX}trace/?pv=PROBE:${a}&range=-1h`);
    await expect.poll(() => moleCount(request, a), { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
    expect(await moleCount(request, b)).toBe(0);

    const other = await browser.newPage();
    try {
      await other.goto(`${PREFIX}trace/?range=-1h&pv=X:Y,PROBE:${b}`);
      await expect.poll(() => moleCount(request, b), { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
    } finally {
      await other.close();
    }
    const before = await moleCount(request, a);
    await expect.poll(() => moleCount(request, a), { timeout: 10_000 }).toBeGreaterThan(before);
  });

  test('a hidden stub stops polling and a visible one resumes', async ({ page, request }) => {
    const id = probe('vis');
    await page.goto(`${PREFIX}trace/?pv=PROBE:${id}`);
    await expect.poll(() => moleCount(request, id), { timeout: 10_000 }).toBeGreaterThanOrEqual(1);

    // At top level the stub's parent is itself, so a self-posted message passes its origin check.
    await page.evaluate(() =>
      window.postMessage({ type: 'canopy:trace-visibility', visible: false }, location.origin)
    );
    await expect(page.locator('body')).toHaveAttribute('data-visible', 'false');
    await page.waitForTimeout(300); // let a poll already in flight land
    const paused = await moleCount(request, id);
    await page.waitForTimeout(2_500);
    expect(await moleCount(request, id)).toBe(paused);

    await page.evaluate(() =>
      window.postMessage({ type: 'canopy:trace-visibility', visible: true }, location.origin)
    );
    await expect(page.locator('body')).toHaveAttribute('data-visible', 'true');
    await expect.poll(() => moleCount(request, id), { timeout: 10_000 }).toBeGreaterThan(paused);
  });

  test('__postQuery posts canopy:trace-query', async ({ page }) => {
    await captureMessages(page);
    await page.goto(`${PREFIX}trace/?pv=PROBE:${probe('q')}`);
    await page.evaluate(() =>
      (window as unknown as { __postQuery: (q: string) => void }).__postQuery('pv=X&range=-2h')
    );
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __messages: unknown[] }).__messages))
      .toContainEqual({ type: 'canopy:trace-query', query: 'pv=X&range=-2h' });
  });

  // The 'default' counter is shared by every probe-less page, so no spec reads it.
  test('without a probe pv the stub uses the default probe', async ({ page }) => {
    await page.goto(`${PREFIX}trace/?range=-1h`);
    await expect(page.locator('#probe')).toHaveText('default');
    await page.goto(`${PREFIX}trace/?pv=PROBE:bad%20id`);
    await expect(page.locator('#probe')).toHaveText('default');
  });

  test('bare /trace and unknown /trace paths are 404', async ({ request }) => {
    expect((await request.get(`${PREFIX}trace`)).status()).toBe(404);
    expect((await request.get(`${PREFIX}trace/index.html`)).status()).toBe(404);
    expect((await request.get(`${PREFIX}trace/assets/missing.js`)).status()).toBe(404);
  });

  test('__host.html stores the @trace tab and iframes the embed route', async ({ request }) => {
    const ok = await request.get(`${PREFIX}__host.html?probe=h1`);
    expect(ok.status()).toBe(200);
    const html = await ok.text();
    expect(html).toContain('"canopy-viewer:tabs:/x/y"');
    expect(html).toContain('pv=PROBE:h1&range=-1h');
    expect(html).toContain('"/x/y/embed/@trace"');
    expect(html).toContain('width:1200px;height:800px');
    expect((await request.get(`${PREFIX}__host.html?probe=%3Cscript%3E`)).status()).toBe(400);
  });

  test('__host.html runs the stub inside the workspace and pauses it when hidden', async ({
    page,
    request,
  }) => {
    const id = probe('host');
    await page.goto(`${PREFIX}__host.html?probe=${id}`);
    const trace = page.frameLocator('#viewer').frameLocator('iframe.workspace-trace');
    await expect(trace.locator('#probe')).toHaveText(id);
    await expect.poll(() => moleCount(request, id), { timeout: 10_000 }).toBeGreaterThanOrEqual(2);

    await page.locator('#toggle-trace').click();
    await expect(trace.locator('body')).toHaveAttribute('data-visible', 'false');
    await page.waitForTimeout(300);
    const paused = await moleCount(request, id);
    await page.waitForTimeout(2_500);
    expect(await moleCount(request, id)).toBe(paused);

    await page.locator('#toggle-trace').click();
    await expect(trace.locator('body')).toHaveAttribute('data-visible', 'true');
    await expect.poll(() => moleCount(request, id), { timeout: 10_000 }).toBeGreaterThan(paused);
  });
});
