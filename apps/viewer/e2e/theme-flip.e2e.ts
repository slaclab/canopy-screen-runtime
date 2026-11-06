// A theme flip on a large screen recolours it without re-rendering it. The
// workspace under /embed keeps KEEP_MOUNTED screen tabs mounted; the active one
// is the synthetic large screen (fixtures/synthetic-large.mjs: 428 nodes, 92
// embeds, 108 rules). Twenty `canopy:theme` messages alternate the
// mode, and each flip is timed inside the page, from the post to the moment a
// role-coloured node's computed colour changes, so no Playwright round-trip is
// in the number.
//
// Always asserted: every flip changes that colour, to the served scheme's
// value for the new mode; every mounted screen root follows the mode and
// carries the served scheme's hash, not the bundled canopy-default's. The
// timed node's role exists only in the served scheme, so a fallback to the
// bundled default would show as its fallback colour instead.
//
// With THEME_FLIP_TIMING=1 the spec also asserts a median flip of at most
// 50 ms and writes a JSON report to THEME_FLIP_OUT (default e2e/.results/flip/).
// Timing is only meaningful on an otherwise idle browser, so it is opt-in and
// run with --workers=1; the full parallel suite checks behaviour only.
//
// The @embed-host variant runs the same workspace inside the stand-in host
// (hostFixture.ts, the shell's synthetic host sheet) and flips between two
// concrete host theme ids of different modes; after every flip the anchor
// names the new id and its --canopy-accent is that theme's host value. It
// writes its own report, theme-flip-embed-host.json, under the same switch.
//
// The docked variants run both again with two tiles side by side: the
// synthetic screen and the data browser (the Trace stand-in of
// fixtures/trace-stub), restored from a stored layout. The dock has one theme
// for every colour scheme, so a flip must leave the dock itself alone: the
// element carrying the dock's theme class is the same node with the same
// classes, no built-in dockview theme class appears, the layout JSON and the
// docked keys are unchanged and the data browser's frame is not reloaded. What
// a flip does change is the contract values the dock reads: after every flip
// both tile bars paint the new --canopy-bg-panel, and the data browser is told
// the new mode and theme id. Their reports are theme-flip-docked.json and
// theme-flip-docked-embed-host.json.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Frame, type Page } from '@playwright/test';
import { canopyDefaultFlat, parseFlatScheme } from '@slaclab/canopy-screen-ir';
import type { FlatScheme } from '@slaclab/canopy-screen-ir';
import { dockedKeys, dockLayout, tileBar } from './dockHelpers';
import { installHost } from './hostFixture';
import { hostFixture } from './hostProbes';

const PREFIX = '/x/y/';
// The workspace keeps its tabs under a key scoped to the mount path
// (src/storageScope.ts); under /x/y that is `canopy-viewer:tabs:/x/y`.
const TABS = 'canopy-viewer:tabs:/x/y';
const SYNTHETIC = 'drafts/synthetic-large';
const SCREEN_FILE = `${PREFIX}drafts/synthetic-large/main.screen.json`;
/** Kept-mounted companions, activated before the synthetic screen. */
const OTHERS = ['drafts/e2e-panel', 'drafts/s-theme'];
const PROBE_ROLE = 'SYN_Probe';
const FLIPS = 20;
const MEDIAN_BUDGET_MS = 50;
const TIMING = process.env.THEME_FLIP_TIMING === '1';
const OUT_DIR = resolve(
  process.env.THEME_FLIP_OUT ?? join(dirname(fileURLToPath(import.meta.url)), '.results', 'flip')
);

type Mode = 'light' | 'dark';

interface IrNode {
  type: string;
  rules?: unknown[];
  children?: IrNode[];
}

/** The scheme config.json serves; this spec needs one, not the default. */
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

function roleColour(scheme: FlatScheme, role: string, mode: Mode): string {
  const i = scheme.roles.indexOf(role);
  expect(i, `role ${role} in the served scheme`).toBeGreaterThanOrEqual(0);
  return rgb((mode === 'light' ? scheme.light : scheme.dark)[i]!);
}

function shape(node: IrNode): { nodes: number; embeds: number; rules: number } {
  const out = {
    nodes: 1,
    embeds: node.type === 'embedded-display' ? 1 : 0,
    rules: node.rules?.length ?? 0,
  };
  for (const child of node.children ?? []) {
    const c = shape(child);
    out.nodes += c.nodes;
    out.embeds += c.embeds;
    out.rules += c.rules;
  }
  return out;
}

/** Seed the stored tabs before the app runs: top window only, key absent. */
async function seedTabs(page: Page, keys: string[], active: string) {
  await page.addInitScript(
    ([key, value]) => {
      if (window === window.top && sessionStorage.getItem(key) === null) {
        sessionStorage.setItem(key, value);
      }
    },
    [TABS, JSON.stringify({ keys, active })] as const
  );
}

const tab = (page: Page, key: string) => page.locator(`[role="tab"][data-tab-key="${key}"]`);
const mounted = (page: Page) => page.locator('.workspace__screen');
const activeRoot = (page: Page) =>
  page.locator('.workspace__screen[data-active="true"] [data-testid="screen-root"]');

/** data-theme and data-scheme of every mounted screen root. */
function mountedRoots(page: Page) {
  return page.locator('.workspace__screen [data-testid="screen-root"]').evaluateAll((els) =>
    els.map((el) => ({
      theme: el.getAttribute('data-theme'),
      scheme: el.getAttribute('data-scheme'),
    }))
  );
}

/**
 * Post one theme message (a mode or a host theme id) and time, in the page,
 * until the probe's computed colour changes: checked on every data-theme
 * mutation and every frame.
 */
function timeFlip(page: Page, mode: string): Promise<{ ms: number; colour: string }> {
  return page.evaluate(
    (mode) =>
      new Promise<{ ms: number; colour: string }>((done, fail) => {
        const el = (window as unknown as { __flipProbe: Element }).__flipProbe;
        const before = getComputedStyle(el).color;
        let settled = false;
        const finish = (result: { ms: number; colour: string } | Error) => {
          settled = true;
          observer.disconnect();
          if (result instanceof Error) fail(result);
          else done(result);
        };
        const check = () => {
          if (settled) return;
          const colour = getComputedStyle(el).color;
          if (colour !== before) finish({ ms: performance.now() - t0, colour });
        };
        const observer = new MutationObserver(check);
        observer.observe(document.documentElement, {
          subtree: true,
          attributes: true,
          attributeFilter: ['data-theme'],
        });
        const frame = () => {
          check();
          if (settled) return;
          if (performance.now() - t0 > 5_000) finish(new Error(`no colour change to ${mode}`));
          else requestAnimationFrame(frame);
        };
        const t0 = performance.now();
        window.postMessage({ type: 'canopy:theme', theme: mode }, '*');
        requestAnimationFrame(frame);
      }),
    mode
  );
}

/** Two frames, so one flip's paint is not counted against the next. */
const settle = (page: Page) =>
  page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
  );

/** --canopy-accent as a computed colour, resolved inside the host anchor. */
function anchorAccent(page: Page): Promise<string> {
  return page.locator('.viewer-embed[data-canopy-host-root]').evaluate((anchor) => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--canopy-accent)';
    anchor.appendChild(probe);
    const colour = getComputedStyle(probe).color;
    probe.remove();
    return colour;
  });
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** The data browser's tab key. */
const TRACE = '@trace';
/** The layout key under the e2e server (basename /x/y, no storage scope). */
const DOCK_KEY = 'canopy-workspace-dock:/x/y';
/** The class of the dock's one theme (createDock.ts CANOPY_DOCK_THEME). */
const DOCK_THEME = '.canopy-dock';

/** The stored layout (storage.ts StoredDock, version 1): the screen left, the data browser right. */
function storedDock(query: string): string {
  const layout = {
    split: 'row',
    items: [
      { tile: 't1', tabs: [SYNTHETIC], showing: SYNTHETIC },
      { tile: 't2', tabs: [TRACE], showing: TRACE },
    ],
  };
  const panels = {
    [SYNTHETIC]: { kind: 'screen' },
    [TRACE]: { kind: 'tool', query },
  };
  return JSON.stringify({ version: 1, layout, panels });
}

/** Seeds the two open tabs and their side-by-side layout before the app runs: top window only, once. */
async function seedDocked(page: Page, query: string) {
  const tabs = { keys: [SYNTHETIC, TRACE], active: SYNTHETIC, instances: { [TRACE]: { query } } };
  await page.addInitScript(
    ([tabsKey, tabsValue, dockKey, dockValue]) => {
      if (window === window.top && sessionStorage.getItem(tabsKey) === null) {
        sessionStorage.setItem(tabsKey, tabsValue);
        localStorage.setItem(dockKey, dockValue);
      }
    },
    [TABS, JSON.stringify(tabs), DOCK_KEY, storedDock(query)] as const
  );
}

/** A contract custom property as a computed colour, resolved inside the embed root. */
function contractColour(page: Page, name: string): Promise<string> {
  return page.locator('.viewer-embed').evaluate((anchor, name) => {
    const probe = document.createElement('span');
    probe.style.color = `var(${name})`;
    anchor.appendChild(probe);
    const colour = getComputedStyle(probe).color;
    probe.remove();
    return colour;
  }, name);
}

const barBackground = (page: Page, key: string) =>
  tileBar(page, key).evaluate((bar) => getComputedStyle(bar).backgroundColor);

interface DockWatch {
  el: Element;
  className: string;
  classChanges: number;
}

/** Remembers the element carrying the dock's theme class and counts every change of its classes. */
function watchDockTheme(page: Page): Promise<void> {
  return page.evaluate((selector) => {
    const found = document.querySelectorAll(selector);
    if (found.length !== 1) throw new Error(`${found.length} elements match ${selector}`);
    const watch = { el: found[0]!, className: found[0]!.className, classChanges: 0 };
    new MutationObserver((records) => {
      watch.classChanges += records.length;
    }).observe(watch.el, { attributes: true, attributeFilter: ['class'] });
    (window as unknown as { __dockWatch: DockWatch }).__dockWatch = watch;
  }, DOCK_THEME);
}

/** What became of the dock's theme element since watchDockTheme. */
function dockTheme(page: Page) {
  return page.evaluate((selector) => {
    const watch = (window as unknown as { __dockWatch: DockWatch }).__dockWatch;
    const found = document.querySelectorAll(selector);
    return {
      count: found.length,
      sameNode: found[0] === watch.el,
      sameClasses: watch.el.className === watch.className,
      classChanges: watch.classChanges,
      builtinThemes: document.querySelectorAll('[class*="dockview-theme-"]').length,
    };
  }, DOCK_THEME);
}

const UNTOUCHED = {
  count: 1,
  sameNode: true,
  sameClasses: true,
  classChanges: 0,
  builtinThemes: 0,
};

interface TraceStub {
  received: { type?: string; mode?: string; theme?: string }[];
}

/** The last theme message the data browser's page received from the viewer. */
function lastTraceTheme(frame: Frame) {
  return frame.evaluate(() => {
    const stub = (window as unknown as { __traceStub: TraceStub }).__traceStub;
    const last = stub.received.filter((m) => m.type === 'canopy:trace-theme').at(-1);
    return last ? { mode: last.mode, theme: last.theme } : null;
  });
}

/** One target of a docked flip: the theme string posted and the mode it resolves to. */
interface FlipTarget {
  theme: string;
  mode: Mode;
}

/**
 * The docked run, from a loaded page: the synthetic screen and the data
 * browser side by side, FLIPS flips alternating between `targets`, starting
 * from targets[0]. `afterFlip` adds the caller's own per-flip checks. Returns
 * the per-flip times.
 */
async function dockedFlips(
  page: Page,
  scheme: FlatScheme,
  probeId: string,
  targets: [FlipTarget, FlipTarget],
  afterFlip: (target: FlipTarget, n: number) => Promise<void>
): Promise<number[]> {
  // Both tiles came back from the stored layout, the screen focused.
  await expect.poll(() => dockedKeys(page)).toEqual([SYNTHETIC, TRACE]);
  await expect(page.locator('[data-testid="tile-bar"]')).toHaveCount(2);
  await expect(activeRoot(page)).toHaveAttribute('data-screen-id', 'synthetic-large');
  await expect(activeRoot(page)).toHaveAttribute('data-theme', targets[0].mode);
  const traceFrame = page.locator(`iframe[data-tab-key="${TRACE}"]`);
  await expect(traceFrame).toBeVisible();
  await expect(page.frameLocator(`iframe[data-tab-key="${TRACE}"]`).locator('#probe')).toHaveText(
    probeId
  );
  const frame = (await (await traceFrame.elementHandle())!.contentFrame())!;
  await frame.evaluate(() => {
    (window as unknown as { __marker: string }).__marker = 'loaded-once';
  });

  const probe = activeRoot(page).getByText('FLIP-PROBE', { exact: true });
  await expect(probe).toHaveCSS('color', roleColour(scheme, PROBE_ROLE, targets[0].mode));
  await probe.evaluate((el) => {
    (window as unknown as { __flipProbe: Element }).__flipProbe = el;
  });

  await watchDockTheme(page);
  const layout = JSON.stringify(await dockLayout(page));
  const panelColours = new Set([await contractColour(page, '--canopy-bg-panel')]);

  const samples: number[] = [];
  let target = targets[0];
  for (let i = 0; i < FLIPS; i++) {
    target = target === targets[0] ? targets[1] : targets[0];
    const step = `flip ${i + 1} to ${target.theme}`;
    const { ms, colour } = await timeFlip(page, target.theme);
    expect(colour, step).toBe(roleColour(scheme, PROBE_ROLE, target.mode));
    samples.push(ms);

    // The contract value changed, and both tile bars paint it.
    const panel = await contractColour(page, '--canopy-bg-panel');
    panelColours.add(panel);
    expect(await barBackground(page, SYNTHETIC), `screen tile bar after ${step}`).toBe(panel);
    expect(await barBackground(page, TRACE), `data browser tile bar after ${step}`).toBe(panel);
    // The data browser was told.
    await expect
      .poll(() => lastTraceTheme(frame), { message: `data browser theme after ${step}` })
      .toEqual({ mode: target.mode, theme: target.theme });
    await afterFlip(target, i + 1);
    await settle(page);
  }
  expect(panelColours.size, 'the two themes paint different panel backgrounds').toBe(2);

  // The dock itself was never touched: same theme element and classes, same
  // layout, same tiles, and the data browser's page is the one loaded at first.
  expect(await dockTheme(page)).toEqual(UNTOUCHED);
  expect(JSON.stringify(await dockLayout(page))).toBe(layout);
  expect(await dockedKeys(page)).toEqual([SYNTHETIC, TRACE]);
  await expect(page.locator('[data-testid="tile-bar"]')).toHaveCount(2);
  expect(await frame.evaluate(() => (window as unknown as { __marker?: string }).__marker)).toBe(
    'loaded-once'
  );
  for (const root of await mountedRoots(page)) {
    expect(root).toEqual({ theme: target.mode, scheme: scheme.meta.flatHash });
  }
  return samples;
}

/** A data browser probe id unique to this run (the server is shared by parallel workers). */
function probeId(name: string): string {
  return `${name}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

test.describe('theme flip on a large screen', () => {
  test.describe.configure({ timeout: 60_000 });

  test(`${FLIPS} flips recolour the kept-mounted workspace from the served scheme @embed`, async ({
    page,
  }) => {
    const warnings: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'warning') warnings.push(m.text());
    });

    // The fixture is the shape the timing claims.
    const scheme = await servedScheme(page);
    const file = await page.request.get(SCREEN_FILE);
    expect(file.ok()).toBe(true);
    const counts = shape(((await file.json()) as { root: IrNode }).root);
    expect(counts).toEqual({ nodes: 428, embeds: 92, rules: 108 });

    // The served scheme is a superset of canopy-default with different values.
    expect(scheme.meta.flatHash).not.toBe(canopyDefaultFlat.meta.flatHash);
    canopyDefaultFlat.roles.forEach((role, i) => {
      const j = scheme.roles.indexOf(role);
      expect(j, `canopy-default role ${role} in the served scheme`).toBeGreaterThanOrEqual(0);
      expect(scheme.light[j]).not.toBe(canopyDefaultFlat.light[i]);
      expect(scheme.dark[j]).not.toBe(canopyDefaultFlat.dark[i]);
    });
    expect(roleColour(scheme, PROBE_ROLE, 'light')).not.toBe(
      roleColour(scheme, PROBE_ROLE, 'dark')
    );

    // Three screen tabs, each shown once, ending on the synthetic screen.
    await seedTabs(page, [...OTHERS, SYNTHETIC], OTHERS[0]!);
    await page.goto(`${PREFIX}embed/`);
    for (const key of [...OTHERS, SYNTHETIC]) {
      await tab(page, key).click();
      await expect(tab(page, key)).toHaveAttribute('aria-selected', 'true');
      await expect(activeRoot(page)).toBeVisible();
    }
    await expect(mounted(page)).toHaveCount(3);
    await expect(activeRoot(page)).toHaveAttribute('data-screen-id', 'synthetic-large');
    await expect(activeRoot(page)).toHaveAttribute('data-theme', 'dark');

    // The probe resolves from the served scheme, in every mounted root.
    const probe = activeRoot(page).getByText('FLIP-PROBE', { exact: true });
    await expect(probe).toHaveCSS('color', roleColour(scheme, PROBE_ROLE, 'dark'));
    for (const root of await mountedRoots(page)) {
      expect(root).toEqual({ theme: 'dark', scheme: scheme.meta.flatHash });
    }
    await probe.evaluate((el) => {
      (window as unknown as { __flipProbe: Element }).__flipProbe = el;
    });

    const samples: number[] = [];
    let mode: Mode = 'dark';
    for (let i = 0; i < FLIPS; i++) {
      mode = mode === 'dark' ? 'light' : 'dark';
      const { ms, colour } = await timeFlip(page, mode);
      expect(colour, `flip ${i + 1} to ${mode}`).toBe(roleColour(scheme, PROBE_ROLE, mode));
      samples.push(ms);
      await settle(page);
    }

    // Every kept tab followed, and the workspace never left the served scheme.
    await expect(mounted(page)).toHaveCount(3);
    for (const root of await mountedRoots(page)) {
      expect(root).toEqual({ theme: mode, scheme: scheme.meta.flatHash });
    }
    expect(warnings.filter((w) => w.includes('colorScheme'))).toEqual([]);

    if (!TIMING) return;
    const report = {
      flips: FLIPS,
      samplesMs: samples.map((ms) => Math.round(ms * 100) / 100),
      medianMs: Math.round(median(samples) * 100) / 100,
      maxMs: Math.round(Math.max(...samples) * 100) / 100,
      budgetMs: MEDIAN_BUDGET_MS,
      screen: { ...counts, keptMounted: 3 },
      scheme: { id: scheme.meta.id, flatHash: scheme.meta.flatHash, roles: scheme.roles.length },
      browser: page.context().browser()?.version() ?? null,
      at: new Date().toISOString(),
    };
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(join(OUT_DIR, 'theme-flip.json'), `${JSON.stringify(report, null, 2)}\n`);
    expect(report.medianMs, `median of ${FLIPS} flips`).toBeLessThanOrEqual(MEDIAN_BUDGET_MS);
  });
  test(`${FLIPS} flips between two host theme ids recolour the hosted workspace @embed-host`, async ({
    page,
  }) => {
    const warnings: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'warning') warnings.push(m.text());
    });
    const ids = Object.keys(hostFixture.themes);
    const dark = ids.find((id) => hostFixture.themes[id]!.mode === 'dark')!;
    const light = ids.find((id) => hostFixture.themes[id]!.mode === 'light')!;
    const modeOf = (id: string): Mode => hostFixture.themes[id]!.mode;
    const accentOf = (id: string) => rgb(hostFixture.themes[id]!.values['accent']!);
    expect(accentOf(dark)).not.toBe(accentOf(light));

    const scheme = await servedScheme(page);
    const file = await page.request.get(SCREEN_FILE);
    expect(file.ok()).toBe(true);
    const counts = shape(((await file.json()) as { root: IrNode }).root);

    await installHost(page, { sheets: 'synthetic' });
    await seedTabs(page, [...OTHERS, SYNTHETIC], OTHERS[0]!);
    await page.goto(`${PREFIX}embed/?embedded=true&theme=${dark}`);
    await expect(page.locator('html')).toHaveAttribute('data-canopy-host', '');
    for (const key of [...OTHERS, SYNTHETIC]) {
      await tab(page, key).click();
      await expect(tab(page, key)).toHaveAttribute('aria-selected', 'true');
      await expect(activeRoot(page)).toBeVisible();
    }
    await expect(mounted(page)).toHaveCount(3);
    await expect(activeRoot(page)).toHaveAttribute('data-screen-id', 'synthetic-large');
    await expect(activeRoot(page)).toHaveAttribute('data-theme', 'dark');

    const anchor = page.locator('.viewer-embed[data-canopy-host-root]');
    await expect(anchor).toHaveAttribute('data-theme', dark);
    expect(await anchorAccent(page)).toBe(accentOf(dark));

    const probe = activeRoot(page).getByText('FLIP-PROBE', { exact: true });
    await expect(probe).toHaveCSS('color', roleColour(scheme, PROBE_ROLE, 'dark'));
    await probe.evaluate((el) => {
      (window as unknown as { __flipProbe: Element }).__flipProbe = el;
    });

    const samples: number[] = [];
    let id = dark;
    for (let i = 0; i < FLIPS; i++) {
      id = id === dark ? light : dark;
      const { ms, colour } = await timeFlip(page, id);
      expect(colour, `flip ${i + 1} to ${id}`).toBe(roleColour(scheme, PROBE_ROLE, modeOf(id)));
      samples.push(ms);
      await expect(anchor).toHaveAttribute('data-theme', id);
      expect(await anchorAccent(page), `--canopy-accent after flip ${i + 1} to ${id}`).toBe(
        accentOf(id)
      );
      await settle(page);
    }

    await expect(mounted(page)).toHaveCount(3);
    for (const root of await mountedRoots(page)) {
      expect(root).toEqual({ theme: modeOf(id), scheme: scheme.meta.flatHash });
    }
    expect(warnings.filter((w) => w.includes('colorScheme') || w.startsWith('canopy:'))).toEqual(
      []
    );

    if (!TIMING) return;
    const report = {
      flips: FLIPS,
      ids: [dark, light],
      samplesMs: samples.map((ms) => Math.round(ms * 100) / 100),
      medianMs: Math.round(median(samples) * 100) / 100,
      maxMs: Math.round(Math.max(...samples) * 100) / 100,
      budgetMs: MEDIAN_BUDGET_MS,
      screen: { ...counts, keptMounted: 3 },
      scheme: { id: scheme.meta.id, flatHash: scheme.meta.flatHash, roles: scheme.roles.length },
      browser: page.context().browser()?.version() ?? null,
      at: new Date().toISOString(),
    };
    // Written before the budget is judged, so a slow run still leaves its report.
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(
      join(OUT_DIR, 'theme-flip-embed-host.json'),
      `${JSON.stringify(report, null, 2)}\n`
    );
    expect(report.medianMs, `median of ${FLIPS} flips`).toBeLessThanOrEqual(MEDIAN_BUDGET_MS);
  });

  /** Under the timing switch: writes the docked report, then judges the budget. */
  function judgeDocked(
    name: string,
    page: Page,
    samples: number[],
    counts: ReturnType<typeof shape>,
    scheme: FlatScheme,
    ids?: string[]
  ) {
    if (!TIMING) return;
    const report = {
      flips: FLIPS,
      ...(ids ? { ids } : {}),
      samplesMs: samples.map((ms) => Math.round(ms * 100) / 100),
      medianMs: Math.round(median(samples) * 100) / 100,
      maxMs: Math.round(Math.max(...samples) * 100) / 100,
      budgetMs: MEDIAN_BUDGET_MS,
      screen: { ...counts, keptMounted: 1 },
      docked: [SYNTHETIC, TRACE],
      scheme: { id: scheme.meta.id, flatHash: scheme.meta.flatHash, roles: scheme.roles.length },
      browser: page.context().browser()?.version() ?? null,
      at: new Date().toISOString(),
    };
    // Written before the budget is judged, so a slow run still leaves its report.
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(join(OUT_DIR, name), `${JSON.stringify(report, null, 2)}\n`);
    expect(report.medianMs, `median of ${FLIPS} flips`).toBeLessThanOrEqual(MEDIAN_BUDGET_MS);
  }

  test(`${FLIPS} flips recolour a screen docked beside the data browser and leave the dock alone @embed`, async ({
    page,
  }) => {
    const warnings: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'warning') warnings.push(m.text());
    });
    const scheme = await servedScheme(page);
    const file = await page.request.get(SCREEN_FILE);
    expect(file.ok()).toBe(true);
    const counts = shape(((await file.json()) as { root: IrNode }).root);
    expect(counts).toEqual({ nodes: 428, embeds: 92, rules: 108 });

    const id = probeId('flip-docked');
    await seedDocked(page, `pv=PROBE:${id}&range=-1h`);
    await page.goto(`${PREFIX}embed/`);

    const samples = await dockedFlips(
      page,
      scheme,
      id,
      [
        { theme: 'dark', mode: 'dark' },
        { theme: 'light', mode: 'light' },
      ],
      async () => {}
    );
    expect(warnings.filter((w) => w.includes('colorScheme') || w.startsWith('Workspace:'))).toEqual(
      []
    );
    judgeDocked('theme-flip-docked.json', page, samples, counts, scheme);
  });

  test(`${FLIPS} flips between two host theme ids recolour the hosted docked workspace and leave the dock alone @embed-host`, async ({
    page,
  }) => {
    const warnings: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'warning') warnings.push(m.text());
    });
    const ids = Object.keys(hostFixture.themes);
    const dark = ids.find((id) => hostFixture.themes[id]!.mode === 'dark')!;
    const light = ids.find((id) => hostFixture.themes[id]!.mode === 'light')!;
    const accentOf = (id: string) => rgb(hostFixture.themes[id]!.values['accent']!);
    expect(accentOf(dark)).not.toBe(accentOf(light));

    const scheme = await servedScheme(page);
    const file = await page.request.get(SCREEN_FILE);
    expect(file.ok()).toBe(true);
    const counts = shape(((await file.json()) as { root: IrNode }).root);

    const id = probeId('flip-docked-host');
    await installHost(page, { sheets: 'synthetic' });
    await seedDocked(page, `pv=PROBE:${id}&range=-1h`);
    await page.goto(`${PREFIX}embed/?embedded=true&theme=${dark}`);
    await expect(page.locator('html')).toHaveAttribute('data-canopy-host', '');
    const anchor = page.locator('.viewer-embed[data-canopy-host-root]');
    await expect(anchor).toHaveAttribute('data-theme', dark);
    expect(await anchorAccent(page)).toBe(accentOf(dark));

    const samples = await dockedFlips(
      page,
      scheme,
      id,
      [
        { theme: dark, mode: hostFixture.themes[dark]!.mode },
        { theme: light, mode: hostFixture.themes[light]!.mode },
      ],
      async (target, n) => {
        await expect(anchor).toHaveAttribute('data-theme', target.theme);
        expect(await anchorAccent(page), `--canopy-accent after flip ${n} to ${target.theme}`).toBe(
          accentOf(target.theme)
        );
      }
    );
    expect(
      warnings.filter(
        (w) => w.includes('colorScheme') || w.startsWith('canopy:') || w.startsWith('Workspace:')
      )
    ).toEqual([]);
    judgeDocked('theme-flip-docked-embed-host.json', page, samples, counts, scheme, [dark, light]);
  });
});
