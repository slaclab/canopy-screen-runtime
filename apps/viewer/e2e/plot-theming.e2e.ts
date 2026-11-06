// An x-y plot whose series colours are roles follows a theme flip, and keeps
// its colour when hovered. The fixture (plot-theming) has one line curve and
// one scatter curve, each coloured by a role that exists only in the served
// scheme, fed by loc:// locals so every curve has a fixed point. A role
// resolves to `var(--cr-<i>, …)`, so the ECharts SVG paths carry that string
// and their computed stroke/fill follows the screen root's data-theme.
//
// - A flip, posted as a `canopy:theme` message on /embed, changes the
//   computed stroke of the line and the fill of both symbols to the served
//   scheme's value for the new mode.
// - A hover puts the series in ECharts' emphasis state. ECharts' default
//   emphasis lifts the normal colour, which fails on a var() string, so XYPlot
//   pins the emphasis colour to the series colour. Here the hovered polyline
//   keeps a role-coloured stroke and the hovered symbol a role-coloured fill.
//
// That a flip renders the plot zero times is not visible from a production
// bundle; packages/runtime/src/render/plotFlip.renderCount.test.tsx proves it.
//
// In mock mode every PV is a scalar, so a curve is a single point: the line's
// polyline is a one-point path, still stroked, and drawn under its symbol.

import { expect, test, type ElementHandle, type Locator, type Page } from '@playwright/test';
import { canopyDefaultFlat, parseFlatScheme } from '@slaclab/canopy-screen-ir';
import type { FlatScheme } from '@slaclab/canopy-screen-ir';

const PREFIX = '/x/y/';
const SCREEN = `${PREFIX}embed/drafts/plot-theming`;
const LINE_ROLE = 'SYN_Accent_A';
const SCATTER_ROLE = 'SYN_Accent_B';

type Mode = 'light' | 'dark';

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

function roleIndex(scheme: FlatScheme, role: string): number {
  const i = scheme.roles.indexOf(role);
  expect(i, `role ${role} in the served scheme`).toBeGreaterThanOrEqual(0);
  return i;
}

function roleColour(scheme: FlatScheme, role: string, mode: Mode): string {
  const i = roleIndex(scheme, role);
  return rgb((mode === 'light' ? scheme.light : scheme.dark)[i]!);
}

const screenRoot = (page: Page) => page.locator('[data-testid="screen-root"]');

/** The series paths of one role: the polyline is stroked, the symbol filled. */
function series(page: Page, scheme: FlatScheme, role: string) {
  const ref = `var(--cr-${roleIndex(scheme, role)},`;
  const svg = screenRoot(page).locator('svg');
  return {
    polyline: svg.locator(`path[stroke^="${ref}"]`),
    symbol: svg.locator(`path[fill^="${ref}"]`),
  };
}

/** A Locator, or an ElementHandle pinned before a hover changes the attributes. */
type Target = Locator | ElementHandle<Node>;

const computed = (el: Target, prop: 'stroke' | 'fill') =>
  el.evaluate((e, p) => getComputedStyle(e as Element).getPropertyValue(p), prop);

/** The symbol's scale from its transform matrix; ECharts enlarges it on emphasis. */
const symbolScale = (symbol: Target) =>
  symbol.evaluate((e) => {
    const m = /^matrix\(([^,]+),/.exec((e as Element).getAttribute('transform') ?? '');
    return m ? Number(m[1]) : NaN;
  });

async function flip(page: Page, mode: Mode) {
  await page.evaluate((theme) => window.postMessage({ type: 'canopy:theme', theme }, '*'), mode);
  await expect(screenRoot(page)).toHaveAttribute('data-theme', mode);
}

/** Move the mouse onto a symbol's centre: ECharts hit-tests on the container. */
async function hover(page: Page, symbol: Locator) {
  const box = await symbol.boundingBox();
  expect(box, 'symbol has a box').not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
}

async function open(page: Page): Promise<FlatScheme> {
  const scheme = await servedScheme(page);
  for (const role of [LINE_ROLE, SCATTER_ROLE]) {
    expect(roleColour(scheme, role, 'light')).not.toBe(roleColour(scheme, role, 'dark'));
  }
  await page.goto(SCREEN);
  await expect(screenRoot(page)).toBeVisible();
  // /embed without ?theme= is dark.
  await expect(screenRoot(page)).toHaveAttribute('data-theme', 'dark');
  const line = series(page, scheme, LINE_ROLE);
  const scatter = series(page, scheme, SCATTER_ROLE);
  await expect(line.polyline).toHaveCount(1);
  await expect(line.symbol).toHaveCount(1);
  await expect(scatter.symbol).toHaveCount(1);
  return scheme;
}

test.describe('x-y plot theming', () => {
  test('a theme flip changes the computed series colours', async ({ page }) => {
    const scheme = await open(page);
    const line = series(page, scheme, LINE_ROLE);
    const scatter = series(page, scheme, SCATTER_ROLE);

    for (const mode of ['dark', 'light', 'dark'] as const) {
      if (mode !== (await screenRoot(page).getAttribute('data-theme'))) await flip(page, mode);
      await expect
        .poll(() => computed(line.polyline, 'stroke'), { message: `line stroke, ${mode}` })
        .toBe(roleColour(scheme, LINE_ROLE, mode));
      await expect
        .poll(() => computed(line.symbol, 'fill'), { message: `line symbol fill, ${mode}` })
        .toBe(roleColour(scheme, LINE_ROLE, mode));
      await expect
        .poll(() => computed(scatter.symbol, 'fill'), { message: `scatter fill, ${mode}` })
        .toBe(roleColour(scheme, SCATTER_ROLE, mode));
    }
  });

  for (const mode of ['dark', 'light'] as const) {
    test(`a hovered series keeps its role colour (${mode})`, async ({ page }) => {
      const scheme = await open(page);
      if (mode !== 'dark') await flip(page, mode);

      for (const [role, target] of [
        [LINE_ROLE, series(page, scheme, LINE_ROLE)],
        [SCATTER_ROLE, series(page, scheme, SCATTER_ROLE)],
      ] as const) {
        const colour = roleColour(scheme, role, mode);
        await expect.poll(() => computed(target.symbol, 'fill')).toBe(colour);
        // Pin the elements: a lost emphasis colour rewrites the very attribute
        // the locators select on.
        const symbol = await target.symbol.elementHandle();
        const polyline = role === LINE_ROLE ? await target.polyline.elementHandle() : null;
        const normalScale = await symbolScale(symbol!);
        expect(normalScale).toBeGreaterThan(0);

        await hover(page, target.symbol);
        // The series is in emphasis: ECharts scales the hovered symbol up.
        await expect.poll(() => symbolScale(symbol!)).toBeGreaterThan(normalScale);

        const fill = await computed(symbol!, 'fill');
        expect(fill, `${role} hovered symbol fill`).not.toBe('none');
        expect(fill, `${role} hovered symbol fill`).toBe(colour);
        if (polyline) {
          const stroke = await computed(polyline, 'stroke');
          expect(stroke, 'hovered polyline stroke').not.toBe('none');
          expect(stroke, 'hovered polyline stroke').toBe(colour);
        }

        // Leave the plot so the next series starts from its normal state.
        await page.mouse.move(0, 0);
        await expect.poll(() => symbolScale(symbol!)).toBe(normalScale);
      }
    });
  }
});
