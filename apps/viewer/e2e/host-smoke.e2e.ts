// The smoke gate of the host-stylesheet specs: every viewer row of the shell's
// probe table (hostProbes.json) still finds its element. Each row opens its
// page in the stand-in host against the synthetic fixture (under the hare mock
// when the row carries `hare`), runs its setups through the shell's
// setups.mjs in order, and asserts only that its selector resolves to at least
// one element; a `pseudo` row asserts a painted pseudo-element. The styling
// specs assume this passed, so a renamed class fails here, by name, and not as
// a colour mismatch there.
//
// The dock rows (the tile bars and the drop highlight) are read in the
// tiles-with-tabs model, as host-mechanics.e2e.ts reads them: two seeded
// tiles, today's element for an old selector, and a held tab drag for
// `hold-tab-drag`. The table still names the dock before tiles with tabs.
//
// Resolution does not depend on the theme, so one synthetic theme is enough.

import { expect, test, type Page } from '@playwright/test';
import {
  edgePoint,
  holdDrag,
  releaseDrag,
  seedDock,
  tileContentRect,
  type Layout,
} from './dockHelpers';
import { installHost } from './hostFixture';
import {
  hostFixture,
  hostProbes,
  pageFor,
  runSetups,
  viewerRows,
  type ProbeRow,
} from './hostProbes';

const PREFIX = '/x/y';
const THEME = Object.keys(hostFixture.themes)[0]!;

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
const SECOND_TILE = 'dock-second-tile';
const HOLD_DRAG = 'hold-tab-drag';
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

for (const [i, tableRow] of viewerRows.entries()) {
  const setup = tableRow.setup.length > 0 ? ` [${tableRow.setup.join(', ')}]` : '';
  test(`viewer row ${i}: ${tableRow.selector}${tableRow.pseudo ?? ''}${setup}`, async ({
    page,
  }) => {
    const row = viewerRow(tableRow);
    const held = (tableRow.setup as string[]).includes(HOLD_DRAG);
    if (row.viewport) await page.setViewportSize(row.viewport);
    await installHost(page, { sheets: 'synthetic', hare: row.hare === true });
    if (isDockRow(tableRow)) {
      await page.setViewportSize({ width: 1400, height: 900 });
      await seedDock(
        page,
        { keys: [DRAGGED_KEY, 'drafts/wide-panel', PROBE_KEY], active: PROBE_KEY },
        DOCK_TILES
      );
    }
    const goto = (path: string) => page.goto(`${PREFIX}${path}`);
    await goto(pageFor(hostProbes, row, THEME));
    await runSetups(page, row, { theme: THEME, goto });
    if (isDockRow(tableRow)) await expect(page.getByTestId('tile-bar')).toHaveCount(2);
    if (held) await holdDockDrag(page);

    const target = page.locator(row.selector);
    await expect(target.first()).toBeAttached();
    expect(await target.count()).toBeGreaterThanOrEqual(1);

    if (row.pseudo) {
      const painted = await target.first().evaluate((el, pseudo) => {
        const style = getComputedStyle(el, pseudo);
        const content = style.content !== 'none' && style.content !== 'normal';
        return content || style.backgroundColor !== 'rgba(0, 0, 0, 0)';
      }, row.pseudo);
      expect(painted, `${row.selector}${row.pseudo} is painted`).toBe(true);
    }
    if (held) await releaseDrag(page, 'cancel');
  });
}
