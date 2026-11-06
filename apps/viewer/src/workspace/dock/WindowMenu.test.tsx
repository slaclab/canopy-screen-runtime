// The window menu (☰): its entries and their order, each
// entry's enabled state, that every entry runs by mouse and by keyboard,
// focus going back to the ☰, the shortcut predicate and the top-right tile.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { useRef, useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  CLOSE_ALL,
  RECENTLY_CLOSED,
  REPORT_BUG,
  RESET_LAYOUT,
  SAVE_AS_COLLECTION,
  TOOL_DOCS,
  WINDOW_MENU,
  WindowMenu,
  isWindowMenuShortcut,
  topRightTile,
  windowMenuShortcutLabel,
} from './WindowMenu.js';
import type { WindowMenuProps } from './WindowMenu.js';
import type { Layout } from '@slaclab/canopy-dock-engine';
import { EmbedThemeContext } from '../../pages/EmbedPage.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

type Props = Omit<WindowMenuProps, 'open' | 'onOpenChange'>;

/** The menu with its open state held like the page holds it. */
function Harness(props: Props & { initiallyOpen?: boolean }) {
  const { initiallyOpen = false, ...rest } = props;
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <>
      <WindowMenu open={open} onOpenChange={setOpen} {...rest} />
      <button type="button" onClick={() => setOpen(true)}>
        shortcut
      </button>
    </>
  );
}

function full(overrides: Partial<Props> = {}) {
  const calls = {
    onReset: vi.fn(),
    onSaveAsCollection: vi.fn(),
    onReopenGroup: vi.fn(),
    onCloseAll: vi.fn(),
  };
  const props: Props = {
    tabCount: 2,
    resetDisabled: false,
    closedGroups: [
      { id: 'g2', label: 'Trace', closedBy: 'you' },
      { id: 'g1', label: 'BPM', closedBy: 'agent' },
    ],
    toolLinks: { docs: 'https://docs.example/tool', bug: 'https://bugs.example/new' },
    ...calls,
    ...overrides,
  };
  render(<Harness {...props} />);
  return calls;
}

function button(): HTMLElement {
  return screen.getByRole('button', { name: WINDOW_MENU });
}

async function items(): Promise<{ label: string; disabled: boolean }[]> {
  await screen.findAllByRole('menuitem');
  return screen
    .getAllByRole('menuitem')
    .filter((m) => m.closest('[role="menu"]')?.closest('[role="menuitem"]') == null)
    .map((m) => ({
      label: m.getAttribute('title') ?? m.textContent ?? '',
      disabled: m.getAttribute('aria-disabled') === 'true',
    }));
}

async function openByClick() {
  fireEvent.click(button());
  await screen.findAllByRole('menuitem');
}

describe('WindowMenu entries', () => {
  it('lists reset, save, recently closed, close all, docs and bug report in that order', async () => {
    full();
    expect(button().getAttribute('aria-haspopup')).toBe('menu');
    expect(button().getAttribute('aria-expanded')).toBe('false');
    await openByClick();
    expect(button().getAttribute('aria-expanded')).toBe('true');
    expect(await items()).toEqual([
      { label: RESET_LAYOUT, disabled: false },
      { label: SAVE_AS_COLLECTION, disabled: false },
      { label: RECENTLY_CLOSED, disabled: false },
      { label: CLOSE_ALL, disabled: false },
      { label: TOOL_DOCS, disabled: false },
      { label: REPORT_BUG, disabled: false },
    ]);
  });

  it('disables reset below two tiles, save and close all with no tab, recently closed with nothing closed', async () => {
    full({ resetDisabled: true, tabCount: 0, closedGroups: [], toolLinks: null });
    await openByClick();
    expect(await items()).toEqual([
      { label: RESET_LAYOUT, disabled: true },
      { label: SAVE_AS_COLLECTION, disabled: true },
      { label: RECENTLY_CLOSED, disabled: true },
      { label: CLOSE_ALL, disabled: true },
    ]);
  });

  it('leaves out an entry whose callback is absent, and links the tool did not report', async () => {
    full({ onSaveAsCollection: undefined, onReset: undefined, toolLinks: { docs: 'https://d' } });
    await openByClick();
    expect((await items()).map((i) => i.label)).toEqual([RECENTLY_CLOSED, CLOSE_ALL, TOOL_DOCS]);
  });

  it('a disabled entry does nothing', async () => {
    const calls = full({ resetDisabled: true });
    await openByClick();
    fireEvent.click(screen.getByRole('menuitem', { name: RESET_LAYOUT }));
    expect(calls.onReset).not.toHaveBeenCalled();
  });
});

describe('WindowMenu by mouse', () => {
  it('each entry runs its action and closes the menu', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const calls = full();
    for (const [label, spy] of [
      [RESET_LAYOUT, calls.onReset],
      [SAVE_AS_COLLECTION, calls.onSaveAsCollection],
      [CLOSE_ALL, calls.onCloseAll],
    ] as const) {
      await openByClick();
      fireEvent.click(screen.getByRole('menuitem', { name: label }));
      expect(spy).toHaveBeenCalledTimes(1);
      expect(screen.queryAllByRole('menuitem')).toHaveLength(0);
    }
    await openByClick();
    fireEvent.click(screen.getByRole('menuitem', { name: TOOL_DOCS }));
    await openByClick();
    fireEvent.click(screen.getByRole('menuitem', { name: REPORT_BUG }));
    expect(open.mock.calls).toEqual([
      ['https://docs.example/tool', '_blank', 'noopener,noreferrer'],
      ['https://bugs.example/new', '_blank', 'noopener,noreferrer'],
    ]);
  });

  it('Recently closed lists each group newest first with its closer; choosing one reopens it', async () => {
    const calls = full();
    await openByClick();
    const parent = screen
      .getAllByRole('menuitem')
      .find((m) => m.getAttribute('title') === RECENTLY_CLOSED)!;
    expect(parent.getAttribute('aria-haspopup')).toBe('true');
    fireEvent.click(parent);
    const children = [...parent.querySelectorAll('[role="menu"] [role="menuitem"]')];
    expect(children.map((m) => m.getAttribute('title'))).toEqual(['Trace · you', 'BPM · agent']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'BPM · agent' }));
    expect(calls.onReopenGroup).toHaveBeenCalledExactlyOnceWith('g1');
  });

  it('a second click on the ☰ closes it', async () => {
    full();
    await openByClick();
    fireEvent.click(button());
    await waitFor(() => expect(screen.queryAllByRole('menuitem')).toHaveLength(0));
  });
});

describe('WindowMenu by pointer', () => {
  it('a press on the ☰ that blurs the open menu, then its click, leaves it closed', async () => {
    full();
    await openByClick();
    // A real press: pointerdown, focus leaves the menu for the ☰ (Carbon closes on blur),
    // then the click.
    fireEvent.pointerDown(button());
    act(() => button().focus());
    fireEvent.click(button());
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    // The next press opens it again.
    fireEvent.pointerDown(button());
    fireEvent.click(button());
    expect((await items()).length).toBe(6);
  });
});

describe('WindowMenu by keyboard', () => {
  it('↓ on the ☰ opens it and focus moves into the menu', async () => {
    full();
    button().focus();
    fireEvent.keyDown(button(), { key: 'ArrowDown' });
    await screen.findAllByRole('menuitem');
    await waitFor(() => expect(document.activeElement?.closest('[role="menu"]')).not.toBeNull());
  });

  it('Enter on an item runs it and focus goes back to the ☰', async () => {
    const calls = full();
    button().focus();
    fireEvent.keyDown(button(), { key: 'ArrowDown' });
    const item = await screen.findByRole('menuitem', { name: CLOSE_ALL });
    // Carbon's MenuItem runs on Enter's keyup after its keydown.
    fireEvent.keyDown(item, { key: 'Enter' });
    fireEvent.keyUp(item, { key: 'Enter' });
    expect(calls.onCloseAll).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(button());
  });

  it('Escape closes it and focus goes back to the ☰', async () => {
    full();
    button().focus();
    fireEvent.keyDown(button(), { key: 'ArrowDown' });
    const first = await screen.findByRole('menuitem', { name: RESET_LAYOUT });
    fireEvent.keyDown(first, { key: 'Escape' });
    await waitFor(() => expect(screen.queryAllByRole('menuitem')).toHaveLength(0));
    expect(document.activeElement).toBe(button());
  });

  it('opens from outside (the page shortcut) with the ☰ wherever it is', async () => {
    full();
    act(() => fireEvent.click(screen.getByRole('button', { name: 'shortcut' })));
    expect((await items()).length).toBe(6);
  });

  it('the title names the shortcut', () => {
    render(<Harness tabCount={0} shortcutLabel={windowMenuShortcutLabel(true)} />);
    expect(button().getAttribute('title')).toBe(`${WINDOW_MENU} (⌥M)`);
    expect(button().getAttribute('aria-keyshortcuts')).toBe('Alt+M');
    expect(windowMenuShortcutLabel(false)).toBe('Alt+M');
  });
});

// Placement (q-0003): the menu is `position: fixed` and Carbon sets its insets from the ☰'s
// viewport box, so it must be mounted once, in its final portal target. In the hub the target
// is the embed layout's root; a menu first mounted in the body and then moved there lost its
// insets and fell to its static position below the page (Close all at y=977 in a 900 px
// viewport).
describe('WindowMenu placement', () => {
  const VIEW = { width: 1400, height: 900 };
  const MENU = { width: 200, height: 180 };
  /** Carbon keeps this gap from the viewport's edges. */
  const SPACING = 8;

  /** The ☰ at the dock's top-right corner: the strip's right end, or the top-right tile's bar. */
  const corners = [
    { tiles: 1, box: { left: 1368, top: 52, width: 24, height: 24 } },
    { tiles: 2, box: { left: 1372, top: 4, width: 24, height: 24 } },
    { tiles: 4, box: { left: 1372, top: 2, width: 24, height: 24 } },
  ];

  /** Lays the ☰ at `box` and gives the open menu its size; jsdom lays nothing out. */
  function layOut(box: { left: number; top: number; width: number; height: number }) {
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(VIEW.width);
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(VIEW.height);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement
    ) {
      const r =
        this.getAttribute('role') === 'menu'
          ? { left: 0, top: 0, width: MENU.width, height: MENU.height }
          : this.dataset.testid === 'window-menu'
            ? box
            : { left: 0, top: 0, width: 0, height: 0 };
      return {
        ...r,
        x: r.left,
        y: r.top,
        right: r.left + r.width,
        bottom: r.top + r.height,
        toJSON: () => r,
      } as DOMRect;
    });
  }

  /** The embed layout: its root is the menu's portal target, as EmbedPage provides it. */
  function Hub(props: Props) {
    const anchorRef = useRef<HTMLDivElement>(null);
    return (
      <div ref={anchorRef} data-testid="embed-root">
        <EmbedThemeContext.Provider value={{ mode: 'dark', id: 'dark', anchorRef }}>
          <Harness {...props} />
        </EmbedThemeContext.Provider>
      </div>
    );
  }

  /** The open root menu's viewport box, from the insets Carbon wrote on it. */
  async function placed(): Promise<{ menu: HTMLElement; left: number; top: number }> {
    await screen.findAllByRole('menuitem');
    const menu = screen.getAllByRole('menu')[0]!;
    await waitFor(() => expect(menu.style.insetBlockStart).toMatch(/px$/));
    return {
      menu,
      left: parseFloat(menu.style.insetInlineStart),
      top: parseFloat(menu.style.insetBlockStart),
    };
  }

  /** Fully in the viewport, below the ☰ and ending at its right edge. */
  function expectAtCorner(
    at: { left: number; top: number },
    box: { left: number; top: number; width: number; height: number }
  ) {
    expect(at.left).toBeGreaterThanOrEqual(SPACING);
    expect(at.top).toBeGreaterThanOrEqual(0);
    expect(at.left + MENU.width).toBeLessThanOrEqual(VIEW.width);
    expect(at.top + MENU.height).toBeLessThanOrEqual(VIEW.height);
    expect(at.top).toBe(box.top + box.height);
    expect(at.left + MENU.width).toBe(box.left + box.width);
  }

  for (const { tiles, box } of corners) {
    it(`standalone with ${tiles} tile(s): opens in the viewport at the corner, in the body`, async () => {
      layOut(box);
      render(<Harness tabCount={2} onCloseAll={() => {}} />);
      fireEvent.click(button());
      const at = await placed();
      expect(at.menu.parentElement).toBe(document.body);
      expectAtCorner(at, box);
    });

    it(`in the hub with ${tiles} tile(s): opens in the viewport at the corner, in the embed root`, async () => {
      layOut(box);
      render(<Hub tabCount={2} onCloseAll={() => {}} />);
      fireEvent.click(button());
      const at = await placed();
      expect(at.menu.parentElement).toBe(screen.getByTestId('embed-root'));
      expectAtCorner(at, box);
    });
  }

  it('in the hub, reopening places it again at the corner', async () => {
    const box = corners[1]!.box;
    layOut(box);
    render(<Hub tabCount={2} onCloseAll={() => {}} />);
    fireEvent.click(button());
    await placed();
    fireEvent.click(button());
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    fireEvent.click(button());
    expectAtCorner(await placed(), box);
  });
});

describe('isWindowMenuShortcut', () => {
  const key = (init: Partial<KeyboardEvent>) => ({
    key: 'm',
    code: 'KeyM',
    altKey: true,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...init,
  });

  it('is ⌥M / Alt+M by the physical key, alone, on every platform', () => {
    expect(isWindowMenuShortcut(key({}))).toBe(true);
    expect(isWindowMenuShortcut(key({ key: 'µ' }))).toBe(true);
    expect(isWindowMenuShortcut(key({ code: '', key: 'M' }))).toBe(true);
    expect(isWindowMenuShortcut(key({ altKey: false }))).toBe(false);
    expect(isWindowMenuShortcut(key({ metaKey: true }))).toBe(false);
    expect(isWindowMenuShortcut(key({ ctrlKey: true }))).toBe(false);
    expect(isWindowMenuShortcut(key({ shiftKey: true }))).toBe(false);
    expect(isWindowMenuShortcut(key({ code: 'KeyK', key: 'k' }))).toBe(false);
  });
});

describe('topRightTile', () => {
  const t = (tile: string): Layout => ({ tile, tabs: [tile], showing: tile }) as unknown as Layout;

  it('is the one tile, the last of a row, the first of a column', () => {
    expect(topRightTile(null)).toBeNull();
    expect(topRightTile(t('t1'))).toBe('t1');
    expect(topRightTile({ split: 'row', items: [t('t1'), t('t2')] } as Layout)).toBe('t2');
    expect(topRightTile({ split: 'column', items: [t('t1'), t('t2')] } as Layout)).toBe('t1');
  });

  it('with four tiles in two columns, the top of the right column', () => {
    const layout = {
      split: 'row',
      items: [
        { split: 'column', items: [t('t1'), t('t2')] },
        { split: 'column', items: [t('t3'), t('t4')] },
      ],
    } as Layout;
    expect(topRightTile(layout)).toBe('t3');
    const rows = {
      split: 'column',
      items: [
        { split: 'row', items: [t('t1'), t('t2')] },
        { split: 'row', items: [t('t3'), t('t4')] },
      ],
    } as Layout;
    expect(topRightTile(rows)).toBe('t2');
  });
});
