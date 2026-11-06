// A screen exported by the screen builder renders its colour roles from the
// served scheme. fixtures/drafts/role-screen.screen.json is the builder's
// role-screen export copied byte for byte: a Display_Background canvas, a Text
// label, a pv-label (Read_Background / ActiveText, plus a severity rule whose
// arms are roles), a pv-led (On / Off) and a Grid-outlined rectangle.
//
// The screen opens as a workspace tab under /embed in fixture mode, so the
// snapshot (fixtures/builder-roles.snapshot.json, fulfilled with page.route)
// supplies every PV and rules are evaluated in the page; in mock mode rules
// stay inert. It is loaded once per mode with ?theme=, and every role-coloured
// node, the rule's output and the canvas background must show the e2e config
// scheme's value for that mode. The expected colours come from the served
// scheme, and each one is checked to differ from canopy-default's value and
// from the export's own fallbacks, so neither a bundled-default nor a fallback
// render can pass.
//
// The rule ladder: the export writes its conditions as `pv0 == 2`, not with
// the IR's `{N}` placeholders, so the runtime finds no live input in them and
// folds the ladder once, to its default arm (OK). The snapshot's DEV:SEVR
// cannot move it; the spec pins the arm the folded rule writes.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { canopyDefaultFlat, parseFlatScheme } from '@slaclab/canopy-screen-ir';
import type { FlatScheme } from '@slaclab/canopy-screen-ir';

const PREFIX = '/x/y/';
// The workspace keeps its tabs under a key scoped to the mount path
// (src/storageScope.ts); under /x/y that is `canopy-viewer:tabs:/x/y`.
const TABS = 'canopy-viewer:tabs:/x/y';
const SCREEN = 'drafts/role-screen';
const KEY = 'builder-roles';
const HERE = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT = JSON.parse(
  readFileSync(join(HERE, 'fixtures/builder-roles.snapshot.json'), 'utf8')
) as { pvs: Record<string, unknown> };

type Mode = 'light' | 'dark';
const MODES: Mode[] = ['light', 'dark'];

interface RoleRef {
  $role: string;
  fallback: string;
  fallbackDark: string;
}

interface IrNode {
  id: string;
  type: string;
  props: Record<string, unknown>;
  rules?: Array<{ targetProperty: string; default: unknown; conditions: unknown[] }>;
  children?: IrNode[];
}

const EXPORT = JSON.parse(
  readFileSync(join(HERE, 'fixtures/drafts/role-screen.screen.json'), 'utf8')
) as { id: string; schemaVersion: string; root: IrNode };

function node(id: string): IrNode {
  const found = [EXPORT.root, ...(EXPORT.root.children ?? [])].find((n) => n.id === id);
  if (!found) throw new Error(`role-screen has no node ${id}`);
  return found;
}

function role(value: unknown): RoleRef {
  const ref = value as RoleRef | undefined;
  if (typeof ref?.$role !== 'string') throw new Error(`not a role: ${JSON.stringify(value)}`);
  return ref;
}

// The roles under test, read from the export, so a drift in it fails here.
const CANVAS = role(EXPORT.root.props.backgroundColor);
const LABEL_TEXT = role(node('id0002').props.foregroundColor);
const READBACK = node('id0003');
const READBACK_TEXT = role(READBACK.props.foregroundColor);
const READBACK_BACKGROUND = role(READBACK.props.backgroundColor);
const SEVERITY_RULE = READBACK.rules?.[0];
const RULE_ARM = role(SEVERITY_RULE?.default);
const LED_ON = role(node('id0004').props.onColor);
const RECT_LINE = role(node('id0005').props.lineColor);
const ALL_ROLES = [CANVAS, LABEL_TEXT, READBACK_TEXT, RULE_ARM, LED_ON, RECT_LINE];

/** The scheme config.json serves: the e2e scheme, not canopy-default. */
async function servedScheme(page: Page): Promise<FlatScheme> {
  const response = await page.request.get(`${PREFIX}config.json`);
  expect(response.ok()).toBe(true);
  const config = (await response.json()) as { colorScheme?: unknown };
  expect(config.colorScheme, 'config.json serves a colorScheme').toBeDefined();
  const parsed = parseFlatScheme(config.colorScheme);
  if ('error' in parsed) throw new Error(`served colorScheme is invalid: ${parsed.error}`);
  return parsed;
}

/** '#da1e28' -> 'rgb(218, 30, 40)', the computed-style form. */
function rgb(hex: string): string {
  const n = (i: number) => parseInt(hex.slice(i, i + 2), 16);
  return `rgb(${n(1)}, ${n(3)}, ${n(5)})`;
}

function hexIn(scheme: FlatScheme, name: string, mode: Mode): string {
  const i = scheme.roles.indexOf(name);
  expect(i, `role ${name} in ${scheme.meta.id}`).toBeGreaterThanOrEqual(0);
  return (mode === 'light' ? scheme.light : scheme.dark)[i]!;
}

/**
 * The served value of `ref`'s role in `mode`, as a computed colour. It must
 * differ from canopy-default's value and from the export's fallback for that
 * mode, so the assertion it feeds cannot pass on either.
 */
function expected(scheme: FlatScheme, ref: RoleRef, mode: Mode): string {
  const served = rgb(hexIn(scheme, ref.$role, mode));
  expect(served, `${ref.$role} (${mode}) differs from canopy-default`).not.toBe(
    rgb(hexIn(canopyDefaultFlat, ref.$role, mode))
  );
  const fallback = mode === 'light' ? ref.fallback : ref.fallbackDark;
  expect(served, `${ref.$role} (${mode}) differs from the export's fallback`).not.toBe(
    rgb(fallback)
  );
  return served;
}

/**
 * Serve the snapshot, seed the stored tabs (top window only, key absent) and
 * open the workspace under /embed in fixture mode with ?theme=`mode`.
 */
async function openInWorkspace(page: Page, mode: Mode) {
  const failures: string[] = [];
  page.on('response', (r) => {
    if (r.status() >= 400) failures.push(`${r.status()} ${r.url()}`);
  });
  let fixtureFetches = 0;
  await page.route(`**${PREFIX}__fixture/${KEY}.json`, (route) => {
    fixtureFetches += 1;
    return route.fulfill({ json: SNAPSHOT });
  });
  await page.addInitScript(
    ([key, value]) => {
      if (window === window.top && sessionStorage.getItem(key) === null) {
        sessionStorage.setItem(key, value);
      }
    },
    [TABS, JSON.stringify({ keys: [SCREEN], active: SCREEN })] as const
  );
  await page.goto(`${PREFIX}embed/?theme=${mode}&_canopyPv=fixture&_canopyFixture=${KEY}`);
  return { failures, fixtureFetches: () => fixtureFetches };
}

const activeRoot = (page: Page) =>
  page.locator('.workspace__screen[data-active="true"] [data-testid="screen-root"]');

/** The element a node's widget renders, under its positioned wrapper. */
function widgetAt(root: Locator, geometry: { x: number; y: number }): Locator {
  return root.locator(`div[style*="left: ${geometry.x}px; top: ${geometry.y}px"] > div`);
}

test.describe('builder role export in the viewer', () => {
  test('the export carries the roles under test and the snapshot covers its PVs', () => {
    expect(EXPORT.schemaVersion).toBe('1.1');
    expect(EXPORT.id).toBe('role-screen');
    expect(EXPORT.root.type).toBe('absolute-canvas');
    expect(SEVERITY_RULE?.targetProperty).toBe('backgroundColor');
    expect(RULE_ARM.$role).toBe('OK');
    for (const pv of ['DEV:RB', 'DEV:SEVR', 'DEV:STATE']) {
      expect(SNAPSHOT.pvs).toHaveProperty([pv]);
    }
  });

  test('the served scheme gives every role used a distinct light and dark value', async ({
    page,
  }) => {
    const scheme = await servedScheme(page);
    expect(scheme.meta.flatHash).not.toBe(canopyDefaultFlat.meta.flatHash);
    for (const ref of ALL_ROLES) {
      expect(hexIn(scheme, ref.$role, 'light'), ref.$role).not.toBe(
        hexIn(scheme, ref.$role, 'dark')
      );
    }
  });

  for (const mode of MODES) {
    test(`renders every role from the served scheme in ${mode} @embed`, async ({ page }) => {
      const scheme = await servedScheme(page);
      const traffic = await openInWorkspace(page, mode);

      const root = activeRoot(page);
      await expect(root).toBeVisible();
      await expect(root).toHaveAttribute('data-screen-id', 'role-screen');
      await expect(root).toHaveAttribute('data-theme', mode);
      await expect(root).toHaveAttribute('data-scheme', scheme.meta.flatHash);
      expect(await page.evaluate(() => window.__canopy?.pvStatus)).toBe('connected');

      // Snapshot data reached the widgets.
      const display = root.locator('.carbon-pv-display');
      const value = display.locator('.carbon-pv-display__value');
      await expect(value).toHaveText('12.5');

      // Absolute-canvas background: Display_Background.
      const canvas = root.locator(':scope > div').first();
      await expect(canvas).toHaveCSS('background-color', expected(scheme, CANVAS, mode));

      // Static label: Text.
      await expect(root.getByText('Status', { exact: true })).toHaveCSS(
        'color',
        expected(scheme, LABEL_TEXT, mode)
      );

      // pv-label: ActiveText foreground, and the severity rule's output (its
      // folded arm, OK) in place of the Read_Background prop.
      await expect(value).toHaveCSS('color', expected(scheme, READBACK_TEXT, mode));
      expect(RULE_ARM.$role).not.toBe(READBACK_BACKGROUND.$role);
      await expect(display).toHaveCSS('background-color', expected(scheme, RULE_ARM, mode));

      // pv-led: DEV:STATE = 1 lights it with On.
      await expect(root.locator('.carbon-pv-led')).toHaveCSS(
        'background-color',
        expected(scheme, LED_ON, mode)
      );

      // Rectangle: Grid outline.
      const rect = widgetAt(root, { x: 10, y: 10 });
      await expect(rect).toHaveCount(1);
      await expect(rect).toHaveCSS('border-top-color', expected(scheme, RECT_LINE, mode));

      await page.waitForLoadState('networkidle');
      expect(traffic.fixtureFetches()).toBeGreaterThanOrEqual(1);
      expect(traffic.failures).toEqual([]);
    });
  }
});
