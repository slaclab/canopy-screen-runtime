// Proves the dock specs' shared ground once each (dockHelpers.ts, and the
// write-button fixture with its confirmed write route in hostFixture.ts):
// a held strip drag paints the DropPreview split highlight and its drop splits
// the tile; a held drag over a tile's centre paints the tab highlight (a centre
// drop adds a tab; nothing is vetoed); a cancel leaves none; the write-button screen
// opens the write dialog and a confirmed write is answered and counted.

import { expect, test } from '@playwright/test';
import {
  PREFIX,
  centrePoint,
  dockLayout,
  dockedKeys,
  dragToEdge,
  dropHighlight,
  edgePoint,
  holdDrag,
  layoutKeys,
  layoutShape,
  overlayItem,
  releaseDrag,
  seedTabs,
  tileContentRect,
} from './dockHelpers';
import { WRITABLE_PV, installHareMock, installPvWriteRoute } from './hostFixture';

test.describe.configure({ timeout: 15_000 });

const PROBE = 'drafts/write-probe';
const BUTTON = 'drafts/write-button';

test.describe('dock helpers', () => {
  test('a held strip drag paints the split highlight; its drop splits the tile', async ({
    page,
  }) => {
    await seedTabs(page, { keys: [PROBE, BUTTON], active: PROBE });
    await page.goto(`${PREFIX}/embed/${PROBE}`);
    // Both tabs in the one tile, the probe showing.
    await expect.poll(() => dockedKeys(page)).toEqual([PROBE]);
    expect(layoutKeys(await dockLayout(page))).toEqual([PROBE, BUTTON]);
    await expect(overlayItem(page, PROBE)).toHaveAttribute('data-placed', 'true');

    // A tile's centre means "add as a tab" (no veto any more): the tab highlight,
    // over the whole tile; a cancel leaves none behind.
    const probeRect = await tileContentRect(page, PROBE);
    expect(probeRect).not.toBeNull();
    const centre = await holdDrag(page, { from: 'strip', key: BUTTON }, centrePoint(probeRect!));
    expect(centre.preview?.kind).toBe('tab');
    expect(await dropHighlight(page)).toBe('tab');
    await releaseDrag(page, 'cancel');
    await expect.poll(() => dropHighlight(page)).toBeNull();

    const held = await holdDrag(
      page,
      { from: 'strip', key: BUTTON },
      edgePoint(probeRect!, 'right', 64)
    );
    expect(held.preview?.kind).toBe('split');
    expect(await dropHighlight(page)).toBe('split');
    await expect(page.locator('.canopy-dock-overlay')).toHaveAttribute('data-dragging', 'true');

    await releaseDrag(page, 'cancel');
    await expect(page.locator('.canopy-dock-overlay')).not.toHaveAttribute('data-dragging', 'true');
    expect(await dropHighlight(page)).toBeNull();
    expect(await dockedKeys(page)).toEqual([PROBE]);

    await dragToEdge(page, BUTTON, PROBE, 'right');
    await expect.poll(() => dockedKeys(page)).toEqual([PROBE, BUTTON]);
    expect(layoutShape(await dockLayout(page))).toBe(`row[${PROBE},${BUTTON}]`);

    const left = (await tileContentRect(page, PROBE))!;
    const right = (await tileContentRect(page, BUTTON))!;
    expect(right.x).toBeGreaterThanOrEqual(left.x + left.width - 1);
    expect(Math.abs(right.y - left.y)).toBeLessThan(2);
  });

  test('the write-button screen opens the write dialog; a confirm is one counted write', async ({
    page,
  }) => {
    await installHareMock(page);
    const writes = await installPvWriteRoute(page);
    await page.goto(`${PREFIX}/embed/${BUTTON}`);

    const button = overlayItem(page, BUTTON).getByRole('button', { name: 'Write' });
    await expect(button).toBeVisible();
    await button.click();

    const dialog = page.getByTestId('canopy-write-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(WRITABLE_PV);
    expect(writes.count).toBe(0);

    await page.getByTestId('canopy-write-confirm').click();
    await expect.poll(() => writes.count).toBe(1);
    expect(writes.writes[0]).toMatchObject({ pv: WRITABLE_PV, body: { value: 1 } });
    await expect(dialog).toBeHidden();
  });
});
