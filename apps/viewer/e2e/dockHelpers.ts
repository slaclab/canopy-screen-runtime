// Shared ground for the dock specs (tiles with tabs): one synthetic
// drag and the read-only views of the dock every drag assertion uses.
//
// The drag. Playwright's mouse never raises HTML5 drag-and-drop, so the
// gesture runs in the page with a real DataTransfer: `dragstart` on the real
// source element (whose own handler records the dock source: a strip tab or a
// tile-bar tab is `{tab}`, a tile's grip is `{tile}`, a screen-browser row is
// `{new}`), then, once the overlay's drag shield is up, `dragenter` and a
// `dragover` every 50 ms at the target point until the drop preview paints,
// then either `drop` or `dragleave`, and `dragend` on the source last. The
// target is `document.elementFromPoint`, exactly what a real pointer would
// hit, so a shield that leaks shows up as a failure instead of being bypassed.
// holdDrag and releaseDrag split the gesture so a spec can assert on the held
// state; dragTo is the whole gesture.
//
// The views. The layout and the showing keys come only from the dock root's
// test surface (`data-layout`, the holder's layout; `data-showing`); the drop
// highlight is the DropPreview rect (`.canopy-dock-drop-preview__rect`, its
// kind in `data-kind`); a tile's rect is its dockview group's box. Nothing here
// reaches into dockview's internals or React state.

import type { Locator, Page } from '@playwright/test';

export const PREFIX = '/x/y';
/** sessionStorage key of the open tabs: scoped to the mount (src/storageScope.ts). */
export const TABS_KEY = `canopy-viewer:tabs:${PREFIX}`;
/** localStorage key of the per-screen zoom record at the mount (src/ZoomContext.tsx ZoomStore). */
export const ZOOM_KEY = `canopy-viewer:zoom-by-screen:${PREFIX}`;
/** localStorage key of the stored dock under the e2e server (dock/storage.ts dockStorageKey). */
export const DOCK_KEY = `canopy-workspace-dock:${PREFIX}`;

/** A side of a tile, a border or the dock. */
export type Side = 'left' | 'right' | 'top' | 'bottom';
/** Kept for the specs that name tile edges. */
export type DropEdge = Side;
/** The drop preview's styles (DropPreview previewKind). */
export type PreviewKind = 'split' | 'tab' | 'strip';

/**
 * Where a drag starts: the key's strip tab (one tile), its tile-bar tab (two
 * or more tiles), its screen-browser row, or a tile's grip (the whole tile).
 */
export type DragFrom =
  | { from: 'strip'; key: string }
  | { from: 'tab'; key: string }
  | { from: 'tree'; key: string }
  | { from: 'grip'; tile: string };

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** The layout, holder form. */
export interface LayoutTile {
  tile: string;
  tabs: string[];
  showing: string;
  size?: number;
}
export interface LayoutSplit {
  split: 'row' | 'column';
  items: Layout[];
  size?: number;
}
export type Layout = LayoutTile | LayoutSplit;

/** The stored tabs a spec seeds. */
export interface SeedTabs {
  keys: string[];
  active: string | null;
}

/** Seeds the open tabs before the app runs: top window only, key absent (a reload keeps them). */
export async function seedTabs(page: Page, tabs: SeedTabs): Promise<void> {
  await page.addInitScript(
    ([key, value]) => {
      if (window === window.top && sessionStorage.getItem(key) === null) {
        sessionStorage.setItem(key, value);
      }
    },
    [TABS_KEY, JSON.stringify(tabs)] as const
  );
}

/** The version 1 stored dock (storage.ts StoredDock) for `layout`. */
export function storedDock(layout: Layout | null): object {
  const keys = layout === null ? [] : tilesOf(layout).flatMap((t) => t.tabs);
  return {
    version: 1,
    layout,
    panels: Object.fromEntries(
      keys.map((k) => [k, { kind: k.startsWith('@') ? 'tool' : 'screen' }])
    ),
  };
}

/**
 * Seeds the open tabs and a stored dock before the app runs, top window only
 * and once (a reload keeps what the app wrote since). `dock` defaults to the
 * version 1 dock of `layout`; pass any object to seed another shape.
 */
export async function seedDock(
  page: Page,
  tabs: SeedTabs,
  layout: Layout | null,
  dock: object = storedDock(layout)
): Promise<void> {
  await page.addInitScript(
    ([tabsKey, tabsValue, dockKey, dockValue]) => {
      if (window !== window.top || sessionStorage.getItem(tabsKey) !== null) return;
      sessionStorage.setItem(tabsKey, tabsValue);
      localStorage.setItem(dockKey, dockValue);
    },
    [TABS_KEY, JSON.stringify(tabs), DOCK_KEY, JSON.stringify(dock)] as const
  );
}

/** `screen`'s (`category/id`) entry in the stored zoom record; null when it has none. */
export function storedZoom(page: Page, screen: string): Promise<unknown> {
  return page.evaluate(
    ([key, s]) => {
      const record = JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, unknown>;
      return record[s] ?? null;
    },
    [ZOOM_KEY, screen] as const
  );
}

/** The dock root, which carries the read-only test surface. */
export function dockRoot(page: Page): Locator {
  return page.getByTestId('workspace-dock');
}

/** The holder's layout (the dock root's `data-layout`); null with none. */
export async function dockLayout(page: Page): Promise<Layout | null> {
  const raw = await dockRoot(page).getAttribute('data-layout');
  if (raw === null) throw new Error('dockLayout: the dock root has no data-layout');
  return JSON.parse(raw) as Layout | null;
}

/** The showing key of every tile, in strip order (the dock root's `data-showing`). */
export async function showingKeys(page: Page): Promise<string[]> {
  const raw = await dockRoot(page).getAttribute('data-showing');
  if (raw === null) throw new Error('showingKeys: the dock root has no data-showing');
  return JSON.parse(raw) as string[];
}

/** The tiles of `layout`, in layout order. */
export function tilesOf(layout: Layout | null): LayoutTile[] {
  if (layout === null) return [];
  if ('tile' in layout) return [layout];
  return layout.items.flatMap(tilesOf);
}

/** Every key the layout holds, tile by tile, tab order within a tile. */
export function layoutKeys(layout: Layout | null): string[] {
  return tilesOf(layout).flatMap((t) => t.tabs);
}

/** The tile holding `key`, or null. */
export function tileOf(layout: Layout | null, key: string): LayoutTile | null {
  return tilesOf(layout).find((t) => t.tabs.includes(key)) ?? null;
}

/**
 * The layout's shape with each tile named by its tabs (`showing` marked `*`
 * when a tile holds more than one): `row[A,column[B,C*|D]]`. Sizes and tile ids
 * left out, so shapes compare across drops that mint new ids.
 */
export function layoutShape(layout: Layout | null): string {
  if (layout === null) return 'null';
  if ('tile' in layout) {
    if (layout.tabs.length === 1) return layout.tabs[0]!;
    return layout.tabs.map((k) => (k === layout.showing ? `${k}*` : k)).join('|');
  }
  return `${layout.split}[${layout.items.map(layoutShape).join(',')}]`;
}

/** The strip tab of `key` (one tile: the strip is that tile's bar). */
export function stripTab(page: Page, key: string): Locator {
  return page.locator(`.tab-strip [role="tab"][data-tab-key="${cssString(key)}"]`);
}

/** The tile-bar tab of `key` (two or more tiles). */
export function tileTab(page: Page, key: string): Locator {
  return page.locator(`.canopy-tile-bar__tab[data-tab-key="${cssString(key)}"]`);
}

/** The tab bar of tile `tile` (two or more tiles). */
export function tileTabBar(page: Page, tile: string): Locator {
  return page.locator(`[data-testid="tile-bar"][data-tile="${cssString(tile)}"]`);
}

/**
 * The header chrome of the tile showing `key`: with two or more tiles, that
 * tile's dockview header (its tab bar and its actions, where the screen header
 * and Save view sit); with one tile, which has no bar, the workspace's
 * strip row and header row, matched only while `key` is the focused tab.
 */
export function tileBar(page: Page, key: string): Locator {
  const k = cssString(key);
  const multi = page.locator(
    `.dv-groupview:has([data-testid="tile-bar"][data-panel-key="${k}"]) .dv-tabs-and-actions-container`
  );
  const single = page.locator('.workspace__main').filter({
    has: page.locator(`.tab-strip [role="tab"][aria-selected="true"][data-tab-key="${k}"]`),
  });
  return multi.or(single);
}

/**
 * Whether a real pointer can reach `target`: it is in the viewport and the
 * topmost element at its centre is `target` or inside it (nothing else, such as
 * a tile's header actions or a menu clipped off-screen, sits over it). Returns
 * a description of what is wrong, or '' when it is reachable; a spec asserts
 * `expect(await unreachable(x)).toBe('')` so a failure names the obstruction.
 */
export async function unreachable(target: Locator): Promise<string> {
  await target.waitFor({ state: 'visible' });
  return target.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const x = r.x + r.width / 2;
    const y = r.y + r.height / 2;
    if (r.width === 0 || r.height === 0) return 'zero-sized';
    if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) {
      return `centre (${Math.round(x)}, ${Math.round(y)}) outside the ${window.innerWidth}x${window.innerHeight} viewport`;
    }
    const top = document.elementFromPoint(x, y);
    if (top && (top === el || el.contains(top))) return '';
    const name = (e: Element | null) =>
      e ? `<${e.tagName.toLowerCase()} class="${e.getAttribute('class') ?? ''}">` : 'nothing';
    return `centre (${Math.round(x)}, ${Math.round(y)}) is covered by ${name(top)}`;
  });
}

/**
 * Closes `key`'s tab with a real click on the × in its tile bar, after checking
 * that the tab and its × are where a pointer can reach them (a failure names
 * what covers them instead of timing out on the click).
 */
export async function closeTileTab(page: Page, key: string): Promise<void> {
  const tab = tileTab(page, key);
  const tabWhy = await unreachable(tab);
  if (tabWhy) throw new Error(`the tile-bar tab of ${key} is unreachable: ${tabWhy}`);
  await tab.hover();
  const close = tab.locator('.canopy-tile-bar__close');
  const closeWhy = await unreachable(close);
  if (closeWhy) throw new Error(`the close button of ${key} is unreachable: ${closeWhy}`);
  await close.click();
}

/** The overlay root that mounts `key`'s panel. */
export function overlayItem(page: Page, key: string): Locator {
  return page.locator(`.canopy-dock-overlay__item[data-tab-key="${cssString(key)}"]`);
}

/**
 * The viewport rect of tile `tile` (its dockview group: bar and content), or
 * null when it is not in the dock. With one tile, which has no bar, the one
 * group.
 */
export async function tileRect(page: Page, tile: string): Promise<Rect | null> {
  return page.evaluate((t) => {
    const root = document.querySelector('[data-testid="workspace-dock"]');
    if (!root) return null;
    const bar = root.querySelector(`[data-testid="tile-bar"][data-tile="${CSS.escape(t)}"]`);
    let group = bar?.closest('.dv-groupview') ?? null;
    if (!group) {
      const layout = JSON.parse(root.getAttribute('data-layout') ?? 'null') as {
        tile?: string;
      } | null;
      const groups = root.querySelectorAll('.dv-groupview');
      if (layout?.tile === t && groups.length === 1) group = groups[0]!;
    }
    if (!group) return null;
    const r = group.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }, tile);
}

/** The viewport rect of the tile holding `key`, or null. */
export async function tileRectOf(page: Page, key: string): Promise<Rect | null> {
  const tile = tileOf(await dockLayout(page), key);
  return tile === null ? null : tileRect(page, tile.tile);
}

/** The viewport rect of `key`'s content (its placed overlay item), or null when not placed. */
export async function tileContentRect(page: Page, key: string): Promise<Rect | null> {
  return page.evaluate((k) => {
    const item = document.querySelector<HTMLElement>(
      `.canopy-dock-overlay__item[data-tab-key="${CSS.escape(k)}"]`
    );
    if (!item || item.getAttribute('data-placed') !== 'true') return null;
    const r = item.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }, key);
}

/** Waits until `fn` returns the same value across two animation frames, and returns it. */
export async function settled<T>(page: Page, fn: () => Promise<T>, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = JSON.stringify(await fn());
  for (;;) {
    await page.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    );
    const value = await fn();
    const now = JSON.stringify(value);
    if (now === last) return value;
    last = now;
    if (Date.now() > deadline) throw new Error('settled: never held still');
  }
}

/** A point `inset` px inside `rect`'s side, centred along it. */
export function edgePoint(rect: Rect, edge: Side, inset = 5): Point {
  const midX = rect.x + rect.width / 2;
  const midY = rect.y + rect.height / 2;
  switch (edge) {
    case 'left':
      return { x: rect.x + inset, y: midY };
    case 'right':
      return { x: rect.x + rect.width - inset, y: midY };
    case 'top':
      return { x: midX, y: rect.y + inset };
    case 'bottom':
      return { x: midX, y: rect.y + rect.height - inset };
  }
}

/** The centre of `rect`. */
export function centrePoint(rect: Rect): Point {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

/** The painted drop preview. */
export interface Preview {
  kind: PreviewKind;
  rect: Rect;
  /** The tab insertion marker, painted for tab and centre drops. */
  marker: Rect | null;
  /** How many preview rects are painted (one, never more). */
  count: number;
}

/** The painted drop preview, or null when none is painted. */
export async function dropPreview(page: Page): Promise<Preview | null> {
  return page.evaluate(readPreview);
}

/** In-page: the painted preview (serialised into page.evaluate). */
function readPreview(): Preview | null {
  const rects = [...document.querySelectorAll<HTMLElement>('.canopy-dock-drop-preview__rect')];
  const shown = rects.filter((el) => {
    const r = el.getBoundingClientRect();
    return getComputedStyle(el).visibility !== 'hidden' && r.width > 0 && r.height > 0;
  });
  const el = shown[0];
  if (!el) return null;
  const box = (e: Element) => {
    const r = e.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  };
  const marker = document.querySelector('.canopy-dock-drop-preview__marker');
  return {
    kind: el.getAttribute('data-kind') as Preview['kind'],
    rect: box(el),
    marker: marker ? box(marker) : null,
    count: shown.length,
  };
}

export interface HoldOptions {
  /** How long dragover repeats before giving up on a preview (default 1000 ms). */
  budgetMs?: number;
}

/** What a held drag reached. */
export interface Held {
  point: Point;
  /** The painted preview, or null when none painted within the budget. */
  preview: Preview | null;
}

/**
 * Starts a drag from `src` and holds it at `point`: dragstart, then dragenter
 * and repeated dragover until a preview is painted or the budget runs out.
 * Never throws for a missing preview, since a self-drop or an infeasible zone
 * paints none by design; finish with releaseDrag.
 */
export async function holdDrag(
  page: Page,
  src: DragFrom,
  point: Point,
  opts: HoldOptions = {}
): Promise<Held> {
  const preview = await page.evaluate(
    async ({ src, point, budgetMs, read }) => {
      const esc = CSS.escape;
      const selector =
        src.from === 'grip'
          ? `[data-testid="tile-bar"][data-tile="${esc(src.tile)}"] .canopy-tile-bar__grip`
          : src.from === 'tab'
            ? `.canopy-tile-bar__tab[data-tab-key="${esc(src.key)}"]`
            : src.from === 'tree'
              ? `.screen-tree [data-screen-key="${esc(src.key)}"] > .nav-tree__row`
              : `.tab-strip [role="tab"][data-tab-key="${esc(src.key)}"]`;
      const source = document.querySelector(selector);
      if (!source) throw new Error(`holdDrag: no source at ${selector}`);
      const dataTransfer = new DataTransfer();
      const at = (p: { x: number; y: number }) => ({
        bubbles: true,
        cancelable: true,
        composed: true,
        dataTransfer,
        clientX: p.x,
        clientY: p.y,
      });
      const s = source.getBoundingClientRect();
      source.dispatchEvent(
        new DragEvent('dragstart', at({ x: s.x + s.width / 2, y: s.y + s.height / 2 }))
      );
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      // The drag shield is a render away; hit-test only once it is up.
      const shieldDeadline = performance.now() + 1000;
      while (
        document.querySelector('.canopy-dock-overlay')?.getAttribute('data-dragging') !== 'true'
      ) {
        if (performance.now() > shieldDeadline)
          throw new Error('holdDrag: the drag shield never rose');
        await sleep(16);
      }
      const target = document.elementFromPoint(point.x, point.y);
      if (!target) throw new Error(`holdDrag: nothing at (${point.x}, ${point.y})`);
      (window as unknown as Record<string, unknown>).__canopyDockDrag = {
        source,
        target,
        dataTransfer,
        point,
      };
      const painted = new Function(`return (${read})()`) as () => unknown;
      target.dispatchEvent(new DragEvent('dragenter', at(point)));
      const deadline = performance.now() + budgetMs;
      for (;;) {
        target.dispatchEvent(new DragEvent('dragover', at(point)));
        await sleep(50);
        const found = painted();
        if (found !== null || performance.now() > deadline) return found;
      }
    },
    { src, point, budgetMs: opts.budgetMs ?? 1000, read: readPreview.toString() }
  );
  return { point, preview: preview as Preview | null };
}

/**
 * Moves the held drag to `point`: dragenter and repeated dragover on whatever
 * `elementFromPoint` hits there, for `ms`; returns the preview painted then.
 */
export async function moveHeldDrag(page: Page, point: Point, ms = 300): Promise<Preview | null> {
  await page.evaluate(
    async ({ point, ms }) => {
      const store = window as unknown as Record<string, unknown>;
      const held = store.__canopyDockDrag as
        | { target: Element; dataTransfer: DataTransfer; point: { x: number; y: number } }
        | undefined;
      if (!held) throw new Error('moveHeldDrag: no drag is held');
      const target = document.elementFromPoint(point.x, point.y);
      if (!target) throw new Error(`moveHeldDrag: nothing at (${point.x}, ${point.y})`);
      const opts = {
        bubbles: true,
        cancelable: true,
        composed: true,
        dataTransfer: held.dataTransfer,
        clientX: point.x,
        clientY: point.y,
      };
      if (target !== held.target) held.target.dispatchEvent(new DragEvent('dragleave', opts));
      held.target = target;
      held.point = point;
      target.dispatchEvent(new DragEvent('dragenter', opts));
      const deadline = performance.now() + ms;
      while (performance.now() < deadline) {
        target.dispatchEvent(new DragEvent('dragover', opts));
        await new Promise((r) => setTimeout(r, 50));
      }
    },
    { point, ms }
  );
  return dropPreview(page);
}

/**
 * Ends the held drag: 'drop' dispatches drop at the held point, 'cancel'
 * dispatches dragleave; both finish with dragend on the source (or the
 * document, when the source left the DOM meanwhile).
 */
export async function releaseDrag(page: Page, how: 'drop' | 'cancel'): Promise<void> {
  await page.evaluate(async (how) => {
    const store = window as unknown as Record<string, unknown>;
    const held = store.__canopyDockDrag as
      | {
          source: Element;
          target: Element;
          dataTransfer: DataTransfer;
          point: { x: number; y: number };
        }
      | undefined;
    if (!held) throw new Error('releaseDrag: no drag is held');
    delete store.__canopyDockDrag;
    const opts = {
      bubbles: true,
      cancelable: true,
      composed: true,
      dataTransfer: held.dataTransfer,
      clientX: held.point.x,
      clientY: held.point.y,
    };
    held.target.dispatchEvent(new DragEvent(how === 'drop' ? 'drop' : 'dragleave', opts));
    await new Promise((r) => setTimeout(r, 80));
    const end = held.source.isConnected ? held.source : document;
    end.dispatchEvent(new DragEvent('dragend', opts));
  }, how);
}

/**
 * The whole gesture: holds `src` at `point` and drops it there. Throws when no
 * preview is painted (the drop would land nowhere) or its kind is not `kind`;
 * returns the preview that was painted, so a caller can compare it with the
 * result.
 */
export async function dragTo(
  page: Page,
  src: DragFrom,
  point: Point,
  kind?: PreviewKind
): Promise<Preview> {
  const held = await holdDrag(page, src, point, { budgetMs: 2000 });
  if (held.preview === null || (kind !== undefined && held.preview.kind !== kind)) {
    await releaseDrag(page, 'cancel');
    throw new Error(
      `dragTo: expected a ${kind ?? 'any'} preview at (${point.x}, ${point.y}), got ${JSON.stringify(held.preview)}`
    );
  }
  await releaseDrag(page, 'drop');
  return held.preview;
}

/** The showing keys in strip order: what the old specs called the docked keys. */
export const dockedKeys = showingKeys;

/** The painted preview's kind, or null: what the old specs called the drop highlight. */
export async function dropHighlight(page: Page): Promise<PreviewKind | null> {
  return (await dropPreview(page))?.kind ?? null;
}

/**
 * Drags `key` (its strip tab, its tile-bar tab, or with `from: 'tree'` its
 * sidebar row) to `edge` of the content of the tile showing `target`, 30 px
 * inside, and drops it there as a split.
 */
export async function dragToEdge(
  page: Page,
  key: string,
  target: string,
  edge: Side,
  from: 'strip' | 'tab' | 'tree' = 'strip'
): Promise<void> {
  const rect = await tileContentRect(page, target);
  if (!rect) throw new Error(`dragToEdge: '${target}' is not placed`);
  let src: DragFrom = { from, key };
  if (from === 'strip' && (await stripTab(page, key).count()) === 0) src = { from: 'tab', key };
  await dragTo(page, src, edgePoint(rect, edge, 64), 'split');
}

/** A CSS attribute-string escape for keys (quotes and backslashes). */
function cssString(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}
