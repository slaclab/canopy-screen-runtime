// A numeric pv-text-input refuses a draft that is not a number and shows the
// reason under the field, outside the widget's fixed box. On a flat, dense
// screen the message paints over the widget below it, is never wider than its
// field (so never wider than the screen), and sits on the scheme's display
// background, in light and dark.
//
// server.mjs does not serve `__fixture/`: the snapshot is fulfilled with
// page.route, as fixture-mode.e2e.ts does.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { canopyDefaultFlat, parseFlatScheme } from '@slaclab/canopy-screen-ir';
import type { FlatScheme } from '@slaclab/canopy-screen-ir';

const PREFIX = '/x/y/';
const KEY = 'dense';
const SNAPSHOT = JSON.parse(
  readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      'fixtures/numeric-entry-message/dense.snapshot.json'
    ),
    'utf8'
  )
) as unknown;
const ROLE = 'Display_Background';
/** The declared bound is `max-width: 100%`; allow sub-pixel rounding only. */
const TOLERANCE = 0.5;

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

function roleHex(scheme: FlatScheme, mode: 'light' | 'dark'): string {
  const i = scheme.roles.indexOf(ROLE);
  expect(i, `role ${ROLE} in the scheme`).toBeGreaterThanOrEqual(0);
  return (mode === 'light' ? scheme.light : scheme.dark)[i]!;
}

async function box(locator: Locator) {
  const b = await locator.boundingBox();
  expect(b, 'element has a layout box').not.toBeNull();
  return b!;
}

/** Open the dense screen in `mode`, type a non-number into `field`, return its message. */
async function refusedEntry(page: Page, mode: 'light' | 'dark', field: string): Promise<Locator> {
  await page.route(`**${PREFIX}__fixture/${KEY}.json`, (route) =>
    route.fulfill({ json: SNAPSHOT })
  );
  await page.goto(
    `${PREFIX}s/drafts/numeric-entry-message?_canopyPv=fixture&_canopyFixture=${KEY}&theme=${mode}`
  );
  const root = page.locator('.viewer-canvas [data-testid="screen-root"]');
  await expect(root).toHaveAttribute('data-theme', mode);
  // Focus stays in the field, so the draft and its message are kept.
  await page.locator(`[data-node-id="${field}"] input`).fill('abc');
  const message = page.locator(`[data-node-id="${field}"] .cds--form-requirement`);
  await expect(message).toHaveText('Not a number');
  await expect(message).toBeVisible();
  return message;
}

for (const mode of ['light', 'dark'] as const) {
  test.describe(`numeric entry message (${mode})`, () => {
    test('the message paints over the widget below', async ({ page }) => {
      const message = await refusedEntry(page, mode, 'ne-field');
      const m = await box(message);
      const below = await box(page.locator('[data-node-id="ne-below"]'));
      const cx = m.x + m.width / 2;
      const cy = m.y + m.height / 2;
      // Premise: the message's centre lies over the widget below.
      expect(cx).toBeGreaterThan(below.x);
      expect(cx).toBeLessThan(below.x + below.width);
      expect(cy).toBeGreaterThan(below.y);
      expect(cy).toBeLessThan(below.y + below.height);

      const onTop = await message.evaluate(
        (el, [x, y]) => {
          const hit = document.elementFromPoint(x!, y!);
          return hit !== null && (hit === el || el.contains(hit));
        },
        [cx, cy]
      );
      expect(onTop).toBe(true);
    });

    test('the message is no wider than its field', async ({ page }) => {
      const message = await refusedEntry(page, mode, 'ne-edge');
      const m = await box(message);
      const field = await box(page.locator('[data-node-id="ne-edge"]'));
      const screen = await box(page.locator('.viewer-canvas [data-testid="screen-root"]'));
      const boxes = JSON.stringify({ message: m, field, screen });

      expect(m.x, boxes).toBeGreaterThanOrEqual(field.x - TOLERANCE);
      expect(m.x + m.width, boxes).toBeLessThanOrEqual(field.x + field.width + TOLERANCE);
      expect(m.x, boxes).toBeGreaterThanOrEqual(screen.x - TOLERANCE);
      expect(m.x + m.width, boxes).toBeLessThanOrEqual(screen.x + screen.width + TOLERANCE);
    });

    test('the message sits on the display background', async ({ page }) => {
      const scheme = await servedScheme(page);
      // Premise: the two modes paint different display backgrounds.
      expect(roleHex(scheme, 'light')).not.toBe(roleHex(scheme, 'dark'));

      const message = await refusedEntry(page, mode, 'ne-field');
      const expected = rgb(roleHex(scheme, mode));
      await expect(message).toHaveCSS('background-color', expected);
      await expect(page.locator('[data-node-id="ne-root"]')).toHaveCSS(
        'background-color',
        expected
      );
    });
  });
}
