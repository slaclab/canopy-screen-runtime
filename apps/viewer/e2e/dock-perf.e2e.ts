// A drag sweep over a busy dock adds no long task. The dock is a fixed 2x2
// grid (a row of two columns, two tiles each), every tile showing a screen
// whose XY plot follows mock PVs, so all four plots repaint while the drag
// runs.
//
// The fixture. The four screens are synthetic: `drafts/perf-plot-1..4` are
// added to the served drafts manifest and their screen JSON is fulfilled with
// page.route, so no fixture file exists for them. Each holds one xy-plot with
// four curves on non-loc:// channels, which the e2e config's mock PV mode
// (fixtures/config.json `pvMode: "mock"`) random-walks on a timer. The open
// tabs and the stored version 1 dock (storage.ts StoredDock) are seeded before
// the app runs, top window only, once.
//
// The measurement. A `longtask` PerformanceObserver is installed before the
// app loads. Two 5 s windows are compared, timed inside the page so no
// Playwright round-trip lands in them: 5 s of no drag, then a scripted 5 s
// sweep. The sweep is a real HTML5 drag of the first tile's tab (Playwright's
// mouse never raises HTML5 drag-and-drop, so the gesture is dispatched in the
// page with a real DataTransfer, as dockHelpers.ts does): `dragstart` on the
// tile-bar tab, then, once the overlay's drag shield is up, a `dragover`
// every frame at the next point of a fixed tour of every zone of every tile
// (centre, the four edge bands, the tile bar and its tabs), the borders
// between tiles and the dock's outer band, with a `dragenter` whenever the hit
// element changes; it ends with `dragleave`, Escape and `dragend`, so no drop
// lands and the layout stays as seeded. A long task counts for a window when
// it starts inside it.
//
// Always asserted: the dock holds the 2x2 layout before and after, the sweep
// really was a drag (the shield rose and a drop preview was painted), and the
// sweep visited every zone. The counts are always written to
// e2e/.results/perf/dock-perf.json (DOCK_PERF_OUT overrides the directory).
// Timing is only meaningful on an otherwise idle machine, so the long-task
// assertion (the drag window has no more long tasks over 50 ms than the idle
// window) runs only under PERF_GATE=1, run with --workers=1; hosted CI never
// gates on timing.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

const PREFIX = '/x/y';
/** sessionStorage key of the open tabs, scoped to the mount (src/storageScope.ts). */
const TABS_KEY = `canopy-viewer:tabs:${PREFIX}`;
/** localStorage key of the stored dock under the e2e server (dock/storage.ts dockStorageKey). */
const DOCK_KEY = `canopy-workspace-dock:${PREFIX}`;
const WINDOW_MS = 5000;
/** A long task is one over 50 ms; the gate allows the drag none beyond the idle window's. */
const LONG_TASK_MS = 50;
const PERF_GATE = process.env.PERF_GATE === '1';
const OUT_DIR = resolve(
  process.env.DOCK_PERF_OUT ?? join(dirname(fileURLToPath(import.meta.url)), '.results', 'perf')
);

const IDS = ['perf-plot-1', 'perf-plot-2', 'perf-plot-3', 'perf-plot-4'];
const KEYS = IDS.map((id) => `drafts/${id}`);
const TILES = ['t1', 't2', 't3', 't4'];

/** The fixed 2x2 grid: a row of two columns, each column two tiles, one screen per tile. */
const LAYOUT = {
  split: 'row',
  items: [
    {
      split: 'column',
      items: [
        { tile: TILES[0], tabs: [KEYS[0]], showing: KEYS[0] },
        { tile: TILES[1], tabs: [KEYS[1]], showing: KEYS[1] },
      ],
    },
    {
      split: 'column',
      items: [
        { tile: TILES[2], tabs: [KEYS[2]], showing: KEYS[2] },
        { tile: TILES[3], tabs: [KEYS[3]], showing: KEYS[3] },
      ],
    },
  ],
};

/** One synthetic screen: a full-size XY plot of four mock-PV curves. */
function plotScreen(id: string, n: number): object {
  const curves = [1, 2, 3, 4].map((c) => ({
    x_channel: null,
    y_channel: `E2E:PERF:P${n}:Y${c}`,
    name: `Y${c}`,
    symbol: 'circle',
    symbolSize: 8,
    traceType: 'line',
    lineWidth: 2,
    lineStyle: 1,
    yAxisName: 'y0',
  }));
  return {
    schemaVersion: '1.0',
    kind: 'screen',
    id,
    metadata: {
      title: `Perf Plot ${n}`,
      source: { type: 'screen-builder', savedAt: '2026-10-01T00:00:00Z' },
      size: { width: 600, height: 360 },
    },
    macros: [],
    root: {
      id: 'w-root',
      type: 'absolute-canvas',
      props: { width: 600, height: 360 },
      geometry: { x: 0, y: 0, width: 600, height: 360 },
      children: [
        {
          id: 'w-plot',
          type: 'xy-plot',
          geometry: { x: 0, y: 0, width: 600, height: 360 },
          props: { title: `Perf ${n}`, curves },
        },
      ],
    },
  };
}

/** Serves the four synthetic screens and lists them in the drafts manifest. */
async function serveFixture(page: Page): Promise<void> {
  await page.route(`**${PREFIX}/drafts/manifest.json`, async (route) => {
    const response = await route.fetch();
    const manifest = (await response.json()) as { screens?: unknown[] } & Record<string, unknown>;
    const entries = IDS.map((id, i) => ({
      id,
      kind: 'ir',
      title: `Perf Plot ${i + 1}`,
      category: 'drafts',
      path: `${id}.screen.json`,
      schemaVersion: '1.0',
    }));
    const list = Array.isArray(manifest.screens) ? manifest.screens : [];
    await route.fulfill({ response, json: { ...manifest, screens: [...list, ...entries] } });
  });
  for (const [i, id] of IDS.entries()) {
    await page.route(`**${PREFIX}/drafts/${id}.screen.json`, (route) =>
      route.fulfill({ json: plotScreen(id, i + 1) })
    );
  }
}

/** Seeds the open tabs, the stored 2x2 dock and the long-task observer before the app runs. */
async function seed(page: Page): Promise<void> {
  const tabs = { keys: KEYS, active: KEYS[0] };
  const dock = {
    version: 1,
    layout: LAYOUT,
    panels: Object.fromEntries(KEYS.map((k) => [k, { kind: 'screen' }])),
  };
  await page.addInitScript(
    ([tabsKey, tabsValue, dockKey, dockValue]) => {
      if (window !== window.top) return;
      if (sessionStorage.getItem(tabsKey) === null) {
        sessionStorage.setItem(tabsKey, tabsValue);
        localStorage.setItem(dockKey, dockValue);
      }
      const store = window as unknown as { __perfLongTasks?: { start: number; ms: number }[] };
      store.__perfLongTasks = [];
      try {
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            store.__perfLongTasks!.push({ start: e.startTime, ms: e.duration });
          }
        }).observe({ type: 'longtask', buffered: true });
      } catch {
        // No longtask support: the spec fails on the missing observer below.
      }
    },
    [TABS_KEY, JSON.stringify(tabs), DOCK_KEY, JSON.stringify(dock)] as const
  );
}

/** The tiles of the dock's layout (its test surface), in layout order. */
function layoutTiles(page: Page): Promise<string[]> {
  return page.locator('[data-testid="workspace-dock"]').evaluate((el) => {
    const out: string[] = [];
    const walk = (node: unknown): void => {
      if (!node || typeof node !== 'object') return;
      const n = node as { tile?: string; items?: unknown[] };
      if (typeof n.tile === 'string') out.push(n.tile);
      for (const item of n.items ?? []) walk(item);
    };
    walk(JSON.parse(el.getAttribute('data-layout') ?? 'null'));
    return out;
  });
}

/** The layout's split shape: `row[column[t1,t2],column[t3,t4]]`. */
function layoutShape(page: Page): Promise<string> {
  return page.locator('[data-testid="workspace-dock"]').evaluate((el) => {
    const shape = (node: unknown): string => {
      const n = node as { tile?: string; split?: string; items?: unknown[] };
      if (typeof n.tile === 'string') return n.tile;
      return `${n.split}[${(n.items ?? []).map(shape).join(',')}]`;
    };
    const layout = JSON.parse(el.getAttribute('data-layout') ?? 'null') as unknown;
    return layout ? shape(layout) : 'null';
  });
}

const SHAPE = 'row[column[t1,t2],column[t3,t4]]';

interface WindowResult {
  startMs: number;
  endMs: number;
  longTasks: number[];
}

interface SweepResult extends WindowResult {
  dragovers: number;
  points: number;
  zones: string[];
  previewKinds: string[];
  shieldRose: boolean;
}

/** Long tasks over LONG_TASK_MS that started inside [start, end). */
function longTasksIn(page: Page, start: number, end: number): Promise<number[]> {
  return page.evaluate(
    ({ start, end, min }) => {
      const tasks =
        (window as unknown as { __perfLongTasks?: { start: number; ms: number }[] })
          .__perfLongTasks ?? [];
      return tasks
        .filter((t) => t.start >= start && t.start < end && t.ms > min)
        .map((t) => Math.round(t.ms * 10) / 10);
    },
    { start, end, min: LONG_TASK_MS }
  );
}

/** WINDOW_MS of no drag, timed in the page. */
async function idleWindow(page: Page): Promise<WindowResult> {
  const { startMs, endMs } = await page.evaluate(async (ms) => {
    const startMs = performance.now();
    await new Promise((r) => setTimeout(r, ms));
    return { startMs, endMs: performance.now() };
  }, WINDOW_MS);
  // Let the observer deliver tasks that ended at the window's edge.
  await page.waitForTimeout(200);
  return { startMs, endMs, longTasks: await longTasksIn(page, startMs, endMs) };
}

/** WINDOW_MS of a scripted drag of the first tile's tab over every zone of the dock, never dropped. */
async function sweepWindow(page: Page): Promise<SweepResult> {
  const result = await page.evaluate(
    async ({ ms, sourceKey }) => {
      const sleep = (t: number) => new Promise((r) => setTimeout(r, t));
      const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)));
      const root = document.querySelector<HTMLElement>('[data-testid="workspace-dock"]');
      if (!root) throw new Error('sweep: no dock root');
      const dock = root.getBoundingClientRect();

      // The tour: every zone of every tile, the borders between tiles, the outer band.
      type Stop = { x: number; y: number; zone: string };
      const tour: Stop[] = [];
      const bars = [...document.querySelectorAll<HTMLElement>('.canopy-tile-bar[data-tile]')];
      for (const bar of bars) {
        const tile = bar.getAttribute('data-tile') ?? '?';
        const b = bar.getBoundingClientRect();
        tour.push({ x: b.x + b.width / 2, y: b.y + b.height / 2, zone: `${tile}:bar` });
        for (const tab of bar.querySelectorAll<HTMLElement>('.canopy-tile-bar__tab')) {
          const r = tab.getBoundingClientRect();
          tour.push({ x: r.x + r.width / 4, y: r.y + r.height / 2, zone: `${tile}:tab` });
          tour.push({ x: r.x + (3 * r.width) / 4, y: r.y + r.height / 2, zone: `${tile}:tab` });
        }
        const key = bar.getAttribute('data-panel-key') ?? '';
        const item = [...document.querySelectorAll<HTMLElement>('.canopy-dock-overlay__item')].find(
          (el) => el.getAttribute('data-tab-key') === key
        );
        if (!item) throw new Error(`sweep: no content for tile ${tile}`);
        const c = item.getBoundingClientRect();
        const cx = c.x + c.width / 2;
        const cy = c.y + c.height / 2;
        const inset = Math.min(20, c.width / 8, c.height / 8);
        tour.push({ x: cx, y: cy, zone: `${tile}:center` });
        tour.push({ x: c.x + inset, y: cy, zone: `${tile}:left` });
        tour.push({ x: c.x + c.width - inset, y: cy, zone: `${tile}:right` });
        tour.push({ x: cx, y: c.y + inset, zone: `${tile}:top` });
        tour.push({ x: cx, y: c.y + c.height - inset, zone: `${tile}:bottom` });
      }
      // Split lines: the dock's mid lines (the 2x2 grid's sashes), at several points along each.
      const midX = dock.x + dock.width / 2;
      const midY = dock.y + dock.height / 2;
      for (const f of [0.2, 0.4, 0.6, 0.8]) {
        tour.push({ x: midX, y: dock.y + dock.height * f, zone: 'split-line:vertical' });
        tour.push({ x: dock.x + dock.width * (f / 2), y: midY, zone: 'split-line:left' });
        tour.push({ x: dock.x + dock.width * (0.5 + f / 2), y: midY, zone: 'split-line:right' });
      }
      // The dock's sides: just inside each dock edge.
      for (const f of [0.25, 0.5, 0.75]) {
        tour.push({ x: dock.x + 3, y: dock.y + dock.height * f, zone: 'dock-side:left' });
        tour.push({
          x: dock.x + dock.width - 3,
          y: dock.y + dock.height * f,
          zone: 'dock-side:right',
        });
        tour.push({ x: dock.x + dock.width * f, y: dock.y + 3, zone: 'dock-side:top' });
        tour.push({
          x: dock.x + dock.width * f,
          y: dock.y + dock.height - 3,
          zone: 'dock-side:bottom',
        });
      }

      const source = document.querySelector<HTMLElement>(
        `.canopy-tile-bar__tab[data-tab-key="${CSS.escape(sourceKey)}"]`
      );
      if (!source) throw new Error(`sweep: no tile-bar tab for '${sourceKey}'`);
      const dataTransfer = new DataTransfer();
      const init = (x: number, y: number): DragEventInit => ({
        bubbles: true,
        cancelable: true,
        composed: true,
        dataTransfer,
        clientX: x,
        clientY: y,
      });
      const kinds = new Set<string>();
      const zones = new Set<string>();
      const watchPreview = () => {
        for (const el of document.querySelectorAll('.canopy-dock-drop-preview__rect')) {
          const kind = el.getAttribute('data-kind');
          if (kind) kinds.add(kind);
        }
      };

      const startMs = performance.now();
      const s = source.getBoundingClientRect();
      source.dispatchEvent(new DragEvent('dragstart', init(s.x + s.width / 2, s.y + s.height / 2)));
      // The drag shield is a render away; hit-test only once it is up.
      let shieldRose = false;
      const shieldDeadline = performance.now() + 1000;
      while (performance.now() < shieldDeadline) {
        if (
          document.querySelector('.canopy-dock-overlay')?.getAttribute('data-dragging') === 'true'
        ) {
          shieldRose = true;
          break;
        }
        await sleep(16);
      }
      let last: Element | null = null;
      let lastPoint = { x: s.x, y: s.y };
      let dragovers = 0;
      let i = 0;
      while (performance.now() - startMs < ms) {
        const stop = tour[i % tour.length]!;
        i += 1;
        const target = document.elementFromPoint(stop.x, stop.y);
        if (target) {
          if (target !== last) {
            last?.dispatchEvent(new DragEvent('dragleave', init(stop.x, stop.y)));
            target.dispatchEvent(new DragEvent('dragenter', init(stop.x, stop.y)));
            last = target;
          }
          target.dispatchEvent(new DragEvent('dragover', init(stop.x, stop.y)));
          dragovers += 1;
          zones.add(stop.zone);
          lastPoint = stop;
        }
        await frame();
        watchPreview();
      }
      // Cancel: no drop, so the layout stays as seeded.
      last?.dispatchEvent(new DragEvent('dragleave', init(lastPoint.x, lastPoint.y)));
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      );
      (source.isConnected ? source : document).dispatchEvent(
        new DragEvent('dragend', init(lastPoint.x, lastPoint.y))
      );
      const endMs = performance.now();
      return {
        startMs,
        endMs,
        dragovers,
        points: tour.length,
        zones: [...zones].sort(),
        previewKinds: [...kinds].sort(),
        shieldRose,
      };
    },
    { ms: WINDOW_MS, sourceKey: KEYS[0] }
  );
  await page.waitForTimeout(200);
  return { ...result, longTasks: await longTasksIn(page, result.startMs, result.endMs) };
}

test.describe.configure({ timeout: 60_000 });

test('a 5 s drag sweep over a 2x2 dock of live plots adds no long task over 50 ms', async ({
  page,
}) => {
  await serveFixture(page);
  await seed(page);
  await page.goto(`${PREFIX}/embed/${KEYS[0]}`);

  // The seeded 2x2 grid is what opened, every tile with its bar and its live plot.
  const root = page.locator('[data-testid="workspace-dock"]');
  await expect(root).toBeVisible();
  await expect.poll(() => layoutShape(page)).toBe(SHAPE);
  expect(await layoutTiles(page)).toEqual(TILES);
  await expect(page.locator('.canopy-tile-bar[data-tile]')).toHaveCount(4);
  for (const key of KEYS) {
    // XYPlot renders with ECharts' SVG renderer; a live plot's drawing keeps changing.
    const plot = page
      .locator(`.canopy-dock-overlay__item[data-tab-key="${key}"] [_echarts_instance_] svg`)
      .first();
    await expect(plot).toBeVisible();
    const before = await plot.innerHTML();
    await expect
      .poll(() => plot.innerHTML(), { message: `${key}'s plot updates live`, timeout: 10_000 })
      .not.toBe(before);
  }
  const observing = await page.evaluate(
    () =>
      PerformanceObserver.supportedEntryTypes.includes('longtask') &&
      Array.isArray((window as unknown as { __perfLongTasks?: unknown }).__perfLongTasks)
  );
  expect(observing, 'longtask PerformanceObserver installed').toBe(true);
  // Let the first paints and data settle before either window opens.
  await page.waitForTimeout(1000);

  const idle = await idleWindow(page);
  const sweep = await sweepWindow(page);

  // The sweep was a real drag that the dock answered, over every zone, and it left the layout alone.
  expect(sweep.shieldRose, 'the drag shield rose').toBe(true);
  expect(sweep.previewKinds.length, 'a drop preview was painted').toBeGreaterThan(0);
  for (const tile of TILES) {
    for (const zone of ['bar', 'tab', 'center', 'left', 'right', 'top', 'bottom']) {
      expect(sweep.zones, `the sweep visited ${tile}:${zone}`).toContain(`${tile}:${zone}`);
    }
  }
  for (const zone of [
    'split-line:vertical',
    'split-line:left',
    'split-line:right',
    'dock-side:left',
    'dock-side:right',
    'dock-side:top',
    'dock-side:bottom',
  ]) {
    expect(sweep.zones, `the sweep visited ${zone}`).toContain(zone);
  }
  await expect(page.locator('.canopy-dock-overlay')).not.toHaveAttribute('data-dragging', 'true');
  expect(await layoutShape(page)).toBe(SHAPE);

  const report = {
    windowMs: WINDOW_MS,
    longTaskMs: LONG_TASK_MS,
    idle: {
      measuredMs: Math.round(idle.endMs - idle.startMs),
      longTasks: idle.longTasks.length,
      durationsMs: idle.longTasks,
    },
    drag: {
      measuredMs: Math.round(sweep.endMs - sweep.startMs),
      longTasks: sweep.longTasks.length,
      durationsMs: sweep.longTasks,
      dragovers: sweep.dragovers,
      tourPoints: sweep.points,
      zones: sweep.zones.length,
      previewKinds: sweep.previewKinds,
    },
    addedLongTasks: Math.max(0, sweep.longTasks.length - idle.longTasks.length),
    gated: PERF_GATE,
    browser: page.context().browser()?.version() ?? null,
    at: new Date().toISOString(),
  };
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'dock-perf.json'), `${JSON.stringify(report, null, 2)}\n`);

  if (!PERF_GATE) return;
  expect(
    sweep.longTasks.length,
    `long tasks > ${LONG_TASK_MS} ms during the drag (${JSON.stringify(sweep.longTasks)}) vs idle (${JSON.stringify(idle.longTasks)})`
  ).toBeLessThanOrEqual(idle.longTasks.length);
});
