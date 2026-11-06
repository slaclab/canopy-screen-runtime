// The viewer against the machine's statement of whether it accepts writes, as
// the mocked PV socket's heartbeat frames carry it (machineFrames.ts).
//
// Write-inert widgets: while the statement is neither `on` nor `asked`, a machine write widget
// (HCM 01) and an action button whose list holds a machine write stay
// focusable, are aria-disabled, carry the reason as hover and accessible
// description, and a click or Enter sends no put, opens no dialog, runs
// nothing in its list and toasts nothing. A list of only navigation and
// loc:// writes stays live. A legacy frame (no statement) changes nothing.
// `asked` asks before every write whatever `confirmWrites` says, and the PUT
// then carries `confirmed: true`; `held` is inert with the hold's reason and
// the badge says "writes held".
//
// Machine toasts: the page's own notices, visual only, titled by the machine
// label. A change between definite states of the same binding toasts once;
// the page's first heartbeat, `unknown`, `applying` and socket gaps never do;
// a writes change an open dialog already reported ("writes changed") adds none.
// Reachability toasts pass a trailing 10-s limiter. The heartbeat vectors'
// `sequences` are replayed through the mocked socket for their counts.
//
// The screen is the write-button draft, replaced in transit: no fixture file
// and no manifest entry.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { WRITABLE_PV, installHareMock, installPvWriteRoute } from './hostFixture';
import type { MachineSocket } from './hostFixture';
import {
  heartbeat,
  reachable,
  recordedLegacyFrame,
  recordedSequence,
  recordedWritesFrame,
  writes,
} from './machineFrames';

const PREFIX = '/x/y/';
const SCREEN = 'drafts/write-button';

const HCM = 'HCM 01';
const STEER = 'Steer and open';
const LOCAL = 'Open and flag';

/** A screen node at (x, y). */
function node(id: string, type: string, props: Record<string, unknown>, x: number, y: number) {
  return { id, type, props, geometry: { x, y, width: 120, height: 30 } };
}

const OPEN_PANEL = { type: 'open_display', file: 'e2e-panel.screen.json', target: 'tab' };

/** HCM 01 (a machine write button) and two action buttons, one with a machine write. */
const MACHINE_SCREEN = {
  schemaVersion: '1.0',
  kind: 'screen',
  id: 'write-button',
  metadata: {
    title: 'Machine state',
    source: { type: 'hand-authored' },
    size: { width: 420, height: 120 },
  },
  macros: [],
  root: {
    id: 'ms-root',
    type: 'absolute-canvas',
    props: { width: 420, height: 120 },
    geometry: { x: 0, y: 0, width: 420, height: 120 },
    children: [
      node('ms-hcm', 'pv-button', { pv: WRITABLE_PV, label: HCM, pressValue: 1 }, 10, 20),
      node(
        'ms-steer',
        'regular-button',
        {
          label: STEER,
          actions: [{ type: 'write_pv', pvName: WRITABLE_PV, value: 1 }, OPEN_PANEL],
        },
        140,
        20
      ),
      node(
        'ms-local',
        'regular-button',
        {
          label: LOCAL,
          actions: [OPEN_PANEL, { type: 'write_pv', pvName: 'loc://e2e', value: 1 }],
        },
        270,
        20
      ),
    ],
  },
};

/** Serves MACHINE_SCREEN for the write-button draft. */
async function serveMachineScreen(page: Page): Promise<void> {
  await page.route(`**/${SCREEN}.screen.json`, async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: MACHINE_SCREEN });
  });
}

/** A writes statement of the heartbeat vectors. */
interface VectorWrites {
  state: string;
  reason: string | null;
  cause: string | null;
}

/** The writes statements of the heartbeat vectors' writes frames that carry a reason. */
function writesWithReason(): (VectorWrites & { reason: string })[] {
  const path = fileURLToPath(
    new URL('./fixtures/contracts/heartbeat_vectors.json', import.meta.url)
  );
  const vectors = JSON.parse(readFileSync(path, 'utf8')) as {
    writes_frames: { frame: { writes: VectorWrites } }[];
  };
  return vectors.writes_frames
    .map((c) => c.frame.writes)
    .filter((w): w is VectorWrites & { reason: string } => w.state !== 'on' && w.reason !== null);
}

const toasts = (page: Page) => page.locator('[data-testid="canopy-write-toast"]');
const machineToasts = (page: Page) => page.locator('[data-testid="canopy-machine-toast"]');
const badge = (page: Page) => page.locator('.target-badge');
const dialog = (page: Page) => page.getByTestId('canopy-write-dialog');
const button = (page: Page, name: string): Locator =>
  page.getByRole('button', { name, exact: true });

/** Presses Tab until `target` has focus; fails after `limit` presses. */
async function tabTo(page: Page, target: Locator, limit = 40): Promise<void> {
  for (let i = 0; i < limit; i += 1) {
    if (await target.evaluate((el) => el === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  await expect(target).toBeFocused();
}

/** Opens the screen; returns the socket, the PUT counter and the popups seen. */
async function openScreen(page: Page, onOpen: object) {
  const socket = await installHareMock(page, { onOpen });
  const puts = await installPvWriteRoute(page);
  await serveMachineScreen(page);
  const popups: string[] = [];
  page.on('popup', (p) => popups.push(p.url()));
  await page.goto(`${PREFIX}embed/${SCREEN}`);
  await expect(button(page, HCM)).toBeVisible();
  return { socket, puts, popups };
}

test.describe('write-inert widgets', () => {
  const locked = recordedWritesFrame('locked-with-reason');
  const reason = (locked.frame.writes as { reason: string }).reason;

  test('writes locked: Tab reaches HCM 01; it is inert and Enter or a click writes nothing', async ({
    page,
  }) => {
    const { socket, puts } = await openScreen(page, locked.frame);
    const hcm = button(page, HCM);
    await expect(hcm).toHaveAttribute('aria-disabled', 'true');
    await expect(hcm).toHaveAccessibleDescription(reason);
    await expect(hcm).toHaveAttribute('title', reason);

    await tabTo(page, hcm);
    await page.keyboard.press('Enter');
    await hcm.click({ force: true });
    // Give a stray write time to leave.
    await page.waitForTimeout(300);
    expect(puts.count).toBe(0);
    expect(socket.received.put ?? 0).toBe(0);
    await expect(dialog(page)).toHaveCount(0);
  });

  test('writes locked: a machine write plus navigation is inert; a click runs nothing', async ({
    page,
  }) => {
    const { socket, puts, popups } = await openScreen(page, locked.frame);
    const steer = button(page, STEER);
    await expect(steer).toHaveAttribute('aria-disabled', 'true');
    await expect(steer).toHaveAccessibleDescription(reason);
    await expect(steer).toHaveAttribute('title', reason);
    const url = page.url();

    await steer.click({ force: true });
    await page.waitForTimeout(300);
    expect(puts.count).toBe(0);
    expect(socket.received.put ?? 0).toBe(0);
    expect(page.url()).toBe(url);
    expect(popups).toEqual([]);
    await expect(dialog(page)).toHaveCount(0);
    await expect(toasts(page)).toHaveCount(0);
  });

  test('writes locked: a list of only navigation and loc:// writes stays live', async ({
    page,
  }) => {
    await openScreen(page, locked.frame);
    const local = button(page, LOCAL);
    await expect(button(page, HCM)).toHaveAttribute('aria-disabled', 'true');
    await expect(local).not.toHaveAttribute('aria-disabled', 'true');
    await local.click();
    await expect(page).toHaveURL(/embed\/drafts\/e2e-panel$/);
  });

  test('every writes frame with a reason: hover and accessible description are its reason', async ({
    page,
  }) => {
    const { socket } = await openScreen(page, heartbeat());
    const hcm = button(page, HCM);
    await expect(hcm).not.toHaveAttribute('aria-disabled', 'true');
    const rows = writesWithReason();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const id = `${row.state}/${row.cause}`;
      await socket.send(heartbeat({ writes: writes(row.state, row.reason, row.cause) }));
      await expect(hcm, id).toHaveAttribute('aria-disabled', 'true');
      await expect(hcm, id).toHaveAttribute('title', row.reason);
      await expect(hcm, id).toHaveAccessibleDescription(row.reason);
      await expect(button(page, STEER), id).toHaveAccessibleDescription(row.reason);
    }
  });

  test("writes held: inert with the hold's reason, and the badge says writes held", async ({
    page,
  }) => {
    const held = recordedWritesFrame('held-with-reason');
    const holdReason = (held.frame.writes as { reason: string }).reason;
    const { socket, puts } = await openScreen(page, held.frame);
    const hcm = button(page, HCM);
    await expect(hcm).toHaveAttribute('aria-disabled', 'true');
    await expect(hcm).toHaveAttribute('title', holdReason);
    await expect(badge(page)).toHaveText(held.expected.badge as string);
    await hcm.click({ force: true });
    await page.waitForTimeout(300);
    expect(puts.count).toBe(0);
    expect(socket.received.put ?? 0).toBe(0);
    await expect(dialog(page)).toHaveCount(0);
  });

  test('recorded legacy frame: nothing is inert and HCM 01 opens the write dialog', async ({
    page,
  }) => {
    const { puts } = await openScreen(page, recordedLegacyFrame().frame);
    await expect(
      page.getByTestId('screen-root').getByRole('button', { name: LOCAL })
    ).toBeVisible();
    // The workspace chrome has disabled controls of its own; the screen has none.
    await expect(page.getByTestId('screen-root').locator('[aria-disabled]')).toHaveCount(0);
    await button(page, HCM).click();
    await expect(dialog(page)).toBeVisible();
    await page.getByTestId('canopy-write-confirm').click();
    await expect.poll(() => puts.count).toBe(1);
  });
});

const TARGET_CHANGED = 'the control target or its write state changed; nothing written';
const WRITES_CHANGED_SIM = 'the write state of Simulator changed; nothing written';
const ROW_3A = 'the write state of this target changed; nothing written';

/** A Simulator heartbeat on `binding` with the given write state. */
function sim(state: string, cause: string | null = null, binding = 'sim@3') {
  return heartbeat({
    backend: 'sim',
    label: 'Simulator',
    binding,
    writes: writes(state, null, cause),
  });
}

const bts = (state: string) =>
  heartbeat({ backend: 'bts', label: 'BTS', binding: 'bts@4', writes: writes(state) });

test.describe('asked', () => {
  /** Opens the screen with the served `confirmWrites` false under Simulator `asked`. */
  async function openAsked(page: Page) {
    const socket = await installHareMock(page, { onOpen: sim('asked', 'asked') });
    // Registered after installHareMock's own config route, so it answers first.
    await page.route('**/config.json', async (route) => {
      const response = await route.fetch();
      const config = (await response.json()) as Record<string, unknown>;
      await route.fulfill({ response, json: { ...config, pvMode: 'hare', confirmWrites: false } });
    });
    const puts = await installPvWriteRoute(page);
    await serveMachineScreen(page);
    await page.goto(`${PREFIX}embed/${SCREEN}`);
    await expect(button(page, HCM)).toBeVisible();
    return { socket, puts };
  }

  test('asks with confirmWrites off; the confirmed write carries confirmed: true', async ({
    page,
  }) => {
    const { puts } = await openAsked(page);
    const hcm = button(page, HCM);
    await expect(hcm).not.toHaveAttribute('aria-disabled', 'true');
    await expect(badge(page)).toHaveText('Simulator');
    await hcm.click();
    await expect(dialog(page)).toBeVisible();
    expect(puts.count).toBe(0);
    await page.getByTestId('canopy-write-confirm').click();
    await expect.poll(() => puts.count).toBe(1);
    expect(puts.writes[0].body).toMatchObject({ confirmed: true });
    await expect(toasts(page)).toHaveText(['written']);
  });

  test('a flip to held while the dialog is open closes it: "writes changed", nothing written', async ({
    page,
  }) => {
    const { socket, puts } = await openAsked(page);
    await button(page, HCM).click();
    await expect(dialog(page)).toBeVisible();
    await socket.send(sim('held', 'session_held'));
    await expect(dialog(page)).toHaveCount(0);
    await expect(toasts(page)).toHaveText([WRITES_CHANGED_SIM]);
    await expect(button(page, HCM)).toHaveAttribute('aria-disabled', 'true');
    await expect(badge(page)).toHaveText('Simulator · writes held');
    expect(puts.count).toBe(0);
  });

  test('a flip to on while the dialog is open closes it too, and the next click sends without a dialog', async ({
    page,
  }) => {
    const { socket, puts } = await openAsked(page);
    await button(page, HCM).click();
    await expect(dialog(page)).toBeVisible();
    await socket.send(sim('on'));
    await expect(dialog(page)).toHaveCount(0);
    await expect(toasts(page)).toHaveText([WRITES_CHANGED_SIM]);
    expect(puts.count).toBe(0);
    await button(page, HCM).click();
    await expect.poll(() => puts.count).toBe(1);
    await expect(dialog(page)).toHaveCount(0);
    expect(puts.writes[0].body).not.toHaveProperty('confirmed');
  });
});

test.describe('an open write dialog and the statement', () => {
  /** Opens the screen under Simulator `on` and opens HCM 01's dialog. */
  async function openDialog(page: Page) {
    const opened = await openScreen(page, sim('on'));
    await button(page, HCM).click();
    await expect(dialog(page)).toBeVisible();
    return opened;
  }

  /** Closes the socket; the next one opens with nothing sent until `first`. */
  async function reconnect(socket: MachineSocket, page: Page, first: object) {
    socket.onOpen = null;
    const before = socket.opened;
    await socket.close();
    await expect(dialog(page)).toHaveCount(0);
    await expect(toasts(page)).toHaveCount(0);
    await socket.waitForOpen(before + 1);
    await socket.send(first);
  }

  test('a live frame saying off closes it: one 16a toast, nothing written', async ({ page }) => {
    const { socket, puts } = await openDialog(page);
    await socket.send(sim('off'));
    await expect(dialog(page)).toHaveCount(0);
    await expect(toasts(page)).toHaveText([WRITES_CHANGED_SIM]);
    await page.waitForTimeout(300);
    await expect(toasts(page)).toHaveCount(1);
    // The 16a toast reported the change: no machine toast for it.
    await expect(machineToasts(page)).toHaveCount(0);
    expect(puts.count).toBe(0);
  });

  test('a close closes it at once; same binding, writes changed on the next socket: 16a', async ({
    page,
  }) => {
    const { socket, puts } = await openDialog(page);
    await reconnect(socket, page, sim('off'));
    await expect(toasts(page)).toHaveText([WRITES_CHANGED_SIM]);
    await page.waitForTimeout(300);
    await expect(machineToasts(page)).toHaveCount(0);
    expect(puts.count).toBe(0);
  });

  test('same writes on the next socket: "target changed"', async ({ page }) => {
    const { socket } = await openDialog(page);
    await reconnect(socket, page, sim('on'));
    await expect(toasts(page)).toHaveText([TARGET_CHANGED]);
  });

  test('another binding on the next socket: "target changed"', async ({ page }) => {
    const { socket } = await openDialog(page);
    await reconnect(socket, page, bts('off'));
    await expect(toasts(page)).toHaveText([TARGET_CHANGED]);
  });

  test('a first frame later than the bound: "target changed", and the late frame adds nothing', async ({
    page,
  }) => {
    const { socket } = await openDialog(page);
    socket.onOpen = null;
    const before = socket.opened;
    await socket.close();
    await socket.waitForOpen(before + 1);
    await expect(toasts(page)).toHaveText([TARGET_CHANGED], { timeout: 10_000 });
    await socket.send(sim('off'));
    await page.waitForTimeout(300);
    await expect(toasts(page)).toHaveText([TARGET_CHANGED]);
  });

  test('two queued dialogs closed by one close: one toast', async ({ page }) => {
    const { socket, puts } = await openDialog(page);
    // A second click behind the open modal queues a second run.
    await button(page, HCM).dispatchEvent('click');
    await reconnect(socket, page, sim('off'));
    await expect(toasts(page)).toHaveText([WRITES_CHANGED_SIM]);
    await page.waitForTimeout(300);
    await expect(toasts(page)).toHaveCount(1);
    await expect(dialog(page)).toHaveCount(0);
    expect(puts.count).toBe(0);
  });

  test('a target switch: closed at the switching frame, one "target changed" after another binding', async ({
    page,
  }) => {
    const { socket } = await openDialog(page);
    await socket.send(sim('applying', 'switching'));
    await expect(dialog(page)).toHaveCount(0);
    await expect(toasts(page)).toHaveCount(0);
    await reconnect(socket, page, bts('on'));
    await expect(toasts(page)).toHaveText([TARGET_CHANGED]);
    await page.waitForTimeout(300);
    await expect(toasts(page)).toHaveText([TARGET_CHANGED]);
  });

  test('an applying frame, next socket same binding and on: one "target changed"', async ({
    page,
  }) => {
    const { socket } = await openDialog(page);
    await socket.send(sim('applying', 'applying'));
    await expect(dialog(page)).toHaveCount(0);
    await reconnect(socket, page, sim('on'));
    await expect(toasts(page)).toHaveText([TARGET_CHANGED]);
  });

  test('a row 3a refusal then a flip to off: the 3a toast, nothing contradicting it', async ({
    page,
  }) => {
    const { socket } = await openDialog(page);
    await page.route(/\/hare\/v1\/pvs\/[^?#]+/, (route) =>
      route.request().method() === 'PUT'
        ? route.fulfill({
            status: 403,
            contentType: 'application/json',
            body: JSON.stringify({ code: 'pv_write_refused', detail: ROW_3A }),
          })
        : route.fallback()
    );
    await page.getByTestId('canopy-write-confirm').click();
    await expect(toasts(page)).toHaveText([ROW_3A]);
    await socket.send(sim('off'));
    await expect(button(page, HCM)).toHaveAttribute('aria-disabled', 'true');
    await page.waitForTimeout(300);
    await expect(toasts(page).filter({ hasText: ROW_3A })).toHaveCount(1);
    await expect(toasts(page).filter({ hasText: TARGET_CHANGED })).toHaveCount(0);
  });
});

/** A Simulator heartbeat stating reachability and writes (cause and reason null). */
function machine(reach: string | null, state: string | null, extra: { reason?: string } = {}) {
  return heartbeat({
    backend: 'example',
    label: 'Simulator',
    binding: 'sim@3',
    ...(reach === null ? {} : { reachable: reachable(reach, reach === 'no' ? 1760700060 : null) }),
    ...(state === null
      ? {}
      : { writes: writes(state, extra.reason ?? null, state === 'applying' ? 'applying' : null) }),
  });
}

const OFF_REASON = 'writes are off for Simulator; turn them back on from the control-target chip';

test.describe('machine toasts', () => {
  /** Closes the socket; the next one opens with nothing sent until `first`. */
  async function gap(socket: MachineSocket, first: object | null) {
    socket.onOpen = null;
    const before = socket.opened;
    await socket.close();
    await socket.waitForOpen(before + 1);
    if (first) await socket.send(first);
  }

  test('writes on → off → on: two writes toasts, none on the first heartbeat', async ({ page }) => {
    const { socket } = await openScreen(page, machine('yes', 'on'));
    const hcm = button(page, HCM);
    await expect(badge(page)).toHaveText('Simulator');
    await page.waitForTimeout(300);
    await expect(machineToasts(page)).toHaveCount(0);

    await socket.send(machine('yes', 'off', { reason: OFF_REASON }));
    await expect(hcm).toHaveAttribute('aria-disabled', 'true');
    await socket.send(machine('yes', 'on'));
    await expect(hcm).not.toHaveAttribute('aria-disabled', 'true');
    await expect(machineToasts(page)).toHaveText([
      'Writes are off for Simulator; turn them back on from the control-target chip',
      'Writes are on for Simulator',
    ]);
    // Titled by the machine, in the Notices column, outside every live region.
    const column = page.getByRole('region', { name: 'Notices' });
    await expect(column.getByTestId('canopy-machine-toast-title').first()).toHaveText('Simulator');
    expect(
      await machineToasts(page)
        .first()
        .evaluate((el) => el.closest('[role="status"], [role="alert"], [aria-live]') === null)
    ).toBe(true);
    await expect(toasts(page)).toHaveCount(0);
  });

  test('reachable no: one error toast; a gap, unknown and yes: exactly one recovery', async ({
    page,
  }) => {
    const { socket } = await openScreen(page, machine('yes', 'on'));
    await expect(badge(page)).toHaveText('Simulator');
    await socket.send(machine('no', 'on'));
    await expect(machineToasts(page)).toHaveText(['Simulator stopped answering']);
    await expect(page.locator('.canopy-machine-toasts__item[data-kind="error"]')).toHaveCount(1);
    await gap(socket, machine('unknown', 'on'));
    await expect(badge(page)).toHaveText('Simulator');
    await socket.send(machine('yes', 'on'));
    // Inside the first toast's 10-s window: the recovery comes at its end.
    const recovery = machineToasts(page).filter({ hasText: 'Simulator is answering again' });
    await expect(recovery).toHaveCount(1, { timeout: 15_000 });
    await page.waitForTimeout(500);
    await expect(recovery).toHaveCount(1);
    await expect(machineToasts(page).filter({ hasText: 'stopped answering' })).toHaveCount(0);
  });

  test('off → applying → close → on: one writes toast, on `on`', async ({ page }) => {
    const { socket } = await openScreen(page, machine('yes', 'off', { reason: OFF_REASON }));
    const hcm = button(page, HCM);
    await expect(hcm).toHaveAttribute('aria-disabled', 'true');
    await socket.send(
      heartbeat({
        backend: 'example',
        label: 'Simulator',
        binding: 'sim@3',
        reachable: reachable('yes'),
        writes: writes('applying', 'applying the new write state', 'applying'),
      })
    );
    await expect(badge(page)).toHaveText('Simulator · writes on · applying…');
    await expect(hcm).toHaveAttribute('aria-disabled', 'true');
    await expect(hcm).toHaveAccessibleDescription('applying the new write state');
    await gap(socket, null);
    await expect(hcm).toHaveAccessibleDescription('Reconnecting to Simulator');
    await expect(hcm).toHaveAttribute('aria-disabled', 'true');
    await socket.send(machine('yes', 'on'));
    await expect(hcm).not.toHaveAttribute('aria-disabled', 'true');
    await expect(machineToasts(page)).toHaveText(['Writes are on for Simulator']);
    await page.waitForTimeout(300);
    await expect(machineToasts(page)).toHaveCount(1);
  });

  test('no / yes / no within 10 s: the last toast shown is "stopped answering"', async ({
    page,
  }) => {
    const { socket } = await openScreen(page, machine('yes', 'on'));
    await expect(badge(page)).toHaveText('Simulator');
    await page.evaluate(() => {
      const w = window as unknown as { __machineToasts: string[] };
      w.__machineToasts = [];
      new MutationObserver(() => {
        for (const el of document.querySelectorAll('[data-testid="canopy-machine-toast"]')) {
          const item = el as HTMLElement;
          if (item.dataset.logged) continue;
          item.dataset.logged = '1';
          w.__machineToasts.push(item.textContent ?? '');
        }
      }).observe(document.body, { childList: true, subtree: true });
    });
    await socket.send(machine('no', 'on'));
    await expect(machineToasts(page)).toHaveText(['Simulator stopped answering']);
    await socket.send(machine('yes', 'on'));
    await socket.send(machine('no', 'on'));
    await page.waitForTimeout(11_000);
    const shown = await page.evaluate(
      () => (window as unknown as { __machineToasts: string[] }).__machineToasts
    );
    expect(shown).toEqual(['Simulator stopped answering']);
  });

  test('a page that loads on reachable no: the badge says not answering; no toast', async ({
    page,
  }) => {
    await openScreen(page, machine('no', 'on'));
    await expect(badge(page)).toContainText('not answering');
    await page.waitForTimeout(500);
    await expect(machineToasts(page)).toHaveCount(0);
  });

  test('recorded legacy frames raise no machine toast', async ({ page }) => {
    const legacy = recordedLegacyFrame().frame;
    const { socket } = await openScreen(page, legacy);
    await socket.send(legacy);
    await gap(socket, legacy);
    await socket.send(legacy);
    await page.waitForTimeout(500);
    await expect(machineToasts(page)).toHaveCount(0);
  });

  for (const id of [
    'same-binding-restart-during-outage',
    'recovery-through-unknown',
    'recovery-through-restart',
    'flip-off',
    'flip-on-through-applying-and-restart',
    'target-switch-through-switching',
    'flip-off-during-an-outage',
    'flip-on-during-an-outage',
    'switch-during-an-outage',
    'asked-to-held',
    'asked-to-on',
  ]) {
    test(`sequence ${id}: its toast count`, async ({ page }) => {
      const sequence = recordedSequence(id);
      const want = sequence.steps.flatMap((step) => step.expected.toasts as string[]);
      const [first, ...rest] = sequence.steps;
      if (first.event !== 'frame') throw new Error('a sequence starts with a frame');
      const { socket } = await openScreen(page, first.frame);
      // The toasts are counted as they appear (each leaves on its own clock).
      await page.evaluate(() => {
        const w = window as unknown as { __machineToasts: string[] };
        w.__machineToasts = [];
        new MutationObserver(() => {
          for (const el of document.querySelectorAll('[data-testid="canopy-machine-toast"]')) {
            const item = el as HTMLElement;
            if (item.dataset.logged) continue;
            item.dataset.logged = '1';
            w.__machineToasts.push(item.textContent ?? '');
          }
        }).observe(document.body, { childList: true, subtree: true });
      });
      for (let i = 0; i < rest.length; i += 1) {
        const step = rest[i];
        if (step.event === 'close') {
          const next = rest[i + 1];
          await gap(socket, next?.event === 'frame' ? next.frame : null);
          if (next?.event === 'frame') i += 1;
        } else {
          await socket.send(step.frame);
        }
        await page.waitForTimeout(200);
      }
      // A reachability change inside the limiter's window lands at its end.
      await page.waitForTimeout(want.length > 0 ? 10_500 : 500);
      const shown = await page.evaluate(
        () => (window as unknown as { __machineToasts: string[] }).__machineToasts
      );
      expect([...shown].sort()).toEqual([...want].sort());
    });
  }

  test('/s/ page under writes locked: the badge shows "· writes locked"', async ({ page }) => {
    const locked = recordedWritesFrame('locked-with-reason');
    await installHareMock(page, { onOpen: locked.frame });
    await serveMachineScreen(page);
    await page.goto(`${PREFIX}s/${SCREEN}`);
    await expect(button(page, HCM)).toBeVisible();
    await expect(badge(page)).toHaveCount(1);
    await expect(badge(page)).toContainText('· writes locked');
  });

  test('workspace with two open tabs and reachable no: one badge and one toast', async ({
    page,
  }) => {
    const { socket } = await openScreen(page, machine('yes', 'on'));
    // A second tab of the same screen family: the draft again under another macro.
    await page.evaluate(
      ([prefix, screen]) => {
        window.history.pushState({}, '', `${prefix}embed/${screen}?M=2`);
        window.dispatchEvent(new PopStateEvent('popstate'));
      },
      [PREFIX, SCREEN]
    );
    await expect(page.getByRole('tab')).toHaveCount(2);
    await socket.send(machine('no', 'on'));
    await expect(machineToasts(page)).toHaveText(['Simulator stopped answering']);
    await expect(badge(page)).toHaveCount(1);
    await page.waitForTimeout(300);
    await expect(machineToasts(page)).toHaveCount(1);
  });
});
