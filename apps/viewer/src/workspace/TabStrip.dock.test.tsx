// The strip's part of the docking mechanic, with one tile (the strip shows
// only then, and is that tile's bar): nothing is dimmed (every open tab is in
// the tile), and the strip hands every dragover and drop, with its measured
// rects, to the page, which passes them to the dock bridge's strip handlers
// (here the real bridge and the real reducer: a tab dropped on the strip
// moves there). The tab's context menu keeps the per-tab close set only; the
// window-wide entries are the ☰ window menu's (dock/WindowMenu). Every
// close is offered for Undo against the real reducer and toast store, and
// Recently closed (in the ☰) reopens a group in place. jsdom has no
// DataTransfer and no scrollIntoView, so both are stubbed.

import '../test/memoryStorage.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { useLayoutEffect, useReducer, useRef, useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useDockBridge } from './dock/useDockBridge.js';
import { dockDragStart } from './dock/tabAdapter.js';
import {
  CLOSE_ALL,
  RECENTLY_CLOSED,
  RESET_LAYOUT,
  SAVE_AS_COLLECTION,
  WINDOW_MENU,
  WindowMenu,
  closedGroupLabel,
  closedTitles,
} from './dock/WindowMenu.js';
import {
  CLOSE_OTHERS,
  CLOSE_TAB,
  CLOSE_TO_RIGHT,
  TabStrip,
  UNDO,
  isReopenClosedShortcut,
} from './TabStrip.js';
import type { StripRects, TabStripProps, TabStripTab } from './TabStrip.js';
import { EMPTY_TABS, mintClosedId, recordKeys, tabsReducer } from './tabs.js';
import type { ClosedBy, CloseInfo, TabsAction, TabsState } from './tabs.js';
import { ToastContext, ToastRegion, useOfferUndo, useToasts } from './useToasts.js';

const TABS: TabStripTab[] = [
  { key: 'ops/main', title: 'Main' },
  { key: 'bts/bpm?SECTOR=3', title: 'BPM' },
  { key: '@trace', title: 'Trace' },
];

/** One tile holding all three tabs, Main showing. */
const START: TabsState = tabsReducer(EMPTY_TABS, {
  type: 'restore',
  layout: { tile: 't1', tabs: TABS.map((t) => t.key), showing: 'ops/main' },
  focusedTile: 't1',
});

const originalScroll = Element.prototype.scrollIntoView;

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn() as unknown as Element['scrollIntoView'];
});

afterEach(() => {
  cleanup();
  Element.prototype.scrollIntoView = originalScroll;
  vi.restoreAllMocks();
});

function renderStrip(props: Partial<TabStripProps> = {}) {
  const onFocus = vi.fn();
  const onClose = vi.fn();
  const onDragStart = vi.fn();
  const onDragOver = vi.fn();
  const onDrop = vi.fn();
  const utils = render(
    <TabStrip
      tabs={TABS}
      activeKey="ops/main"
      onFocus={onFocus}
      onClose={onClose}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      {...props}
    />
  );
  return { ...utils, onFocus, onClose, onDragStart, onDragOver, onDrop };
}

function tab(key: string): HTMLElement {
  return screen.getAllByRole('tab').find((t) => t.getAttribute('data-tab-key') === key)!;
}

/** A minimal DataTransfer: jsdom has none. */
function transfer(): DataTransfer {
  const store: Record<string, string> = {};
  return {
    get types() {
      return Object.keys(store);
    },
    getData: (type: string) => store[type] ?? '',
    setData: (type: string, value: string) => {
      store[type] = value;
    },
    clearData: () => {},
    setDragImage: () => {},
    effectAllowed: 'all',
    dropEffect: 'move',
    items: { length: 0 },
    files: { length: 0 },
  } as unknown as DataTransfer;
}

function fireDrag(
  target: Element,
  type: string,
  dataTransfer: DataTransfer | null,
  point: { clientX: number; clientY: number } = { clientX: 0, clientY: 0 }
): Event {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...point });
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

/** Give `el` a client box (jsdom lays nothing out). */
function boxAt(el: Element, x: number, y: number, width: number, height: number) {
  el.getBoundingClientRect = () =>
    ({
      x,
      y,
      left: x,
      top: y,
      width,
      height,
      right: x + width,
      bottom: y + height,
      toJSON: () => ({}),
    }) as DOMRect;
}

describe('TabStrip with one tile', () => {
  it('dims nothing: every open tab is in the tile, and no tab is italic', () => {
    renderStrip();
    for (const t of screen.getAllByRole('tab')) {
      expect(t.className).not.toContain('tab-strip__tab--undocked');
      expect(t.hasAttribute('data-docked')).toBe(false);
    }
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Main', 'BPM', 'Trace']);
    const css = readFileSync(createRequire(import.meta.url).resolve('./TabStrip.css'), 'utf8');
    expect(css).not.toMatch(/font-style:\s*italic/);
    expect(css).not.toMatch(/tab-strip__tab--undocked/);
  });
});

describe('TabStrip click outcomes', () => {
  it('a click on a tab hands it to the page', () => {
    const { onFocus } = renderStrip();
    fireEvent.click(tab('@trace'));
    expect(onFocus).toHaveBeenCalledExactlyOnceWith('@trace');
  });

  it('a click or Enter on the focused tab does nothing', () => {
    const { onFocus, onClose } = renderStrip();
    fireEvent.click(tab('ops/main'));
    fireEvent.keyDown(tab('ops/main'), { key: 'Enter' });
    expect(onFocus).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('strip × and middle-click close for good', () => {
    const { onClose, onFocus } = renderStrip();
    fireEvent.click(screen.getByRole('button', { name: 'Close Trace' }));
    fireEvent(tab('ops/main'), new MouseEvent('auxclick', { bubbles: true, button: 1 }));
    expect(onClose.mock.calls).toEqual([['@trace'], ['ops/main']]);
    expect(onFocus).not.toHaveBeenCalled();
  });

  it('the click outcomes against the real reducer: the one tile shows the clicked tab', () => {
    function Harness() {
      const [state, dispatch] = useReducer(tabsReducer, START);
      return (
        <>
          <TabStrip
            tabs={TABS}
            activeKey={state.active}
            onFocus={(key) => dispatch({ type: 'focus', key })}
            onClose={(key) => dispatch({ type: 'close', key })}
          />
          <output data-testid="layout">{JSON.stringify(state.layout)}</output>
        </>
      );
    }
    render(<Harness />);
    fireEvent.click(tab('@trace'));
    expect(tab('@trace').getAttribute('aria-selected')).toBe('true');
    expect(JSON.parse(screen.getByTestId('layout').textContent!)).toMatchObject({
      tile: 't1',
      showing: '@trace',
    });
    fireEvent.click(tab('@trace'));
    expect(tab('@trace').getAttribute('aria-selected')).toBe('true');
  });
});

describe('TabStrip drag', () => {
  it('tabs are draggable only with onDragStart; the close button never is', () => {
    renderStrip();
    expect(tab('@trace').getAttribute('draggable')).toBe('true');
    expect(screen.getByRole('button', { name: 'Close Trace' }).getAttribute('draggable')).toBe(
      'false'
    );
    cleanup();
    renderStrip({ onDragStart: undefined });
    expect(tab('@trace').getAttribute('draggable')).toBe('false');
  });

  it('a tab drag hands the key and the transfer to onDragStart', () => {
    const { onDragStart } = renderStrip();
    const dt = transfer();
    fireDrag(tab('bts/bpm?SECTOR=3'), 'dragstart', dt);
    expect(onDragStart).toHaveBeenCalledExactlyOnceWith('bts/bpm?SECTOR=3', dt);
  });

  it('takes drops: dragenter, dragover and drop reach the page with the strip measured', () => {
    const { onDragOver, onDrop } = renderStrip();
    const strip = screen.getByRole('tablist');
    boxAt(strip, 100, 0, 600, 30);
    TABS.forEach((t, i) => boxAt(tab(t.key), 100 + i * 120, 0, 120, 30));
    const dt = transfer();
    fireDrag(strip, 'dragenter', dt);
    fireDrag(tab('ops/main'), 'dragover', dt);
    fireDrag(strip, 'drop', dt);
    expect(onDragOver).toHaveBeenCalledTimes(2);
    expect(onDrop).toHaveBeenCalledTimes(1);
    const expected: StripRects = {
      barRect: { x: 100, y: 0, width: 600, height: 30 },
      tabRects: [
        { x: 100, y: 0, width: 120, height: 30 },
        { x: 220, y: 0, width: 120, height: 30 },
        { x: 340, y: 0, width: 120, height: 30 },
      ],
    };
    expect(onDragOver.mock.calls[1]![1]).toEqual(expected);
    expect(onDrop.mock.calls[0]![1]).toEqual(expected);
    // The strip itself never sets "none".
    expect(dt.dropEffect).toBe('move');
  });

  it('wired to the real bridge, a strip tab dropped later in the strip moves there', () => {
    /** The page's wiring in miniature: the strip's rects keyed to the one tile. */
    function Harness() {
      const [state, dispatch] = useReducer(tabsReducer, START);
      const [root, setRoot] = useState<HTMLDivElement | null>(null);
      const bridge = useDockBridge(null, state, dispatch, { root });
      const keyed = (rects: StripRects) => ({ t1: rects });
      return (
        <>
          <TabStrip
            tabs={state.keys.map((key) => TABS.find((t) => t.key === key)!)}
            activeKey={state.active}
            onFocus={(key) => dispatch({ type: 'focus', key })}
            onClose={(key) => dispatch({ type: 'close', key })}
            onDragStart={(key, dt) => dockDragStart({ tab: key }, dt)}
            onDragOver={(e, rects) => bridge.stripDragOver(e, keyed(rects))}
            onDrop={(e, rects) => bridge.stripDrop(e, keyed(rects))}
          />
          <div
            ref={(el) => {
              if (el) boxAt(el, 0, 40, 1000, 760);
              setRoot((prev) => (prev === el ? prev : el));
            }}
            data-testid="dock-root"
          />
        </>
      );
    }
    render(<Harness />);
    const strip = screen.getByRole('tablist');
    const lay = () => {
      boxAt(strip, 0, 0, 1000, 30);
      screen.getAllByRole('tab').forEach((t, i) => boxAt(t, i * 120, 0, 120, 30));
    };
    lay();
    const dt = transfer();
    fireDrag(tab('ops/main'), 'dragstart', dt);
    const point = { clientX: 350, clientY: 15 };
    const over = fireDrag(strip, 'dragover', dt, point);
    expect(over.defaultPrevented).toBe(true);
    const drop = fireDrag(strip, 'drop', dt, point);
    expect(drop.defaultPrevented).toBe(true);
    expect(screen.getAllByRole('tab').map((t) => t.getAttribute('data-tab-key'))).toEqual([
      'bts/bpm?SECTOR=3',
      '@trace',
      'ops/main',
    ]);
    fireDrag(tab('ops/main'), 'dragend', dt);
  });

  it('a foreign drag (no dock source) is left to the browser', () => {
    function Harness() {
      const [state, dispatch] = useReducer(tabsReducer, START);
      const bridge = useDockBridge(null, state, dispatch);
      return (
        <TabStrip
          tabs={TABS}
          activeKey={state.active}
          onFocus={() => {}}
          onClose={() => {}}
          onDragOver={(e, rects) => bridge.stripDragOver(e, { t1: rects })}
          onDrop={(e, rects) => bridge.stripDrop(e, { t1: rects })}
        />
      );
    }
    render(<Harness />);
    const over = fireDrag(screen.getByRole('tablist'), 'dragover', transfer());
    expect(over.defaultPrevented).toBe(false);
  });
});

describe('TabStrip context menu', () => {
  async function labels(): Promise<{ label: string; disabled: boolean }[]> {
    await screen.findAllByRole('menuitem');
    return screen.getAllByRole('menuitem').map((item) => ({
      label: item.textContent ?? '',
      disabled: item.getAttribute('aria-disabled') === 'true',
    }));
  }

  it("a tab's menu is the per-tab close set only; the window-wide entries are in the ☰", async () => {
    const onCloseOthers = vi.fn();
    const onCloseToRight = vi.fn();
    renderStrip({ onCloseOthers, onCloseToRight });
    fireEvent.contextMenu(tab('bts/bpm?SECTOR=3'));
    expect(await labels()).toEqual([
      { label: CLOSE_TAB, disabled: false },
      { label: CLOSE_OTHERS, disabled: false },
      { label: CLOSE_TO_RIGHT, disabled: false },
    ]);
    for (const gone of [RESET_LAYOUT, SAVE_AS_COLLECTION, CLOSE_ALL, RECENTLY_CLOSED]) {
      expect(screen.queryByRole('menuitem', { name: gone })).toBeNull();
    }
    fireEvent.click(screen.getByRole('menuitem', { name: CLOSE_TO_RIGHT }));
    expect(onCloseToRight).toHaveBeenCalledExactlyOnceWith('bts/bpm?SECTOR=3');
    fireEvent.contextMenu(tab('bts/bpm?SECTOR=3'));
    await labels();
    fireEvent.click(screen.getByRole('menuitem', { name: CLOSE_OTHERS }));
    expect(onCloseOthers).toHaveBeenCalledExactlyOnceWith('bts/bpm?SECTOR=3');
    // The last tab has nothing to its right.
    fireEvent.contextMenu(tab('@trace'));
    const last = await labels();
    expect(last.find((l) => l.label === CLOSE_TO_RIGHT)?.disabled).toBe(true);
  });

  it('Shift+F10 opens a tab menu from the keyboard', async () => {
    renderStrip();
    fireEvent.keyDown(tab('ops/main'), { key: 'F10', shiftKey: true });
    expect((await labels()).map((l) => l.label)).toEqual([CLOSE_TAB]);
    fireEvent.click(screen.getByRole('menuitem', { name: CLOSE_TAB }));
  });

  it('the empty strip area keeps the browser menu', () => {
    renderStrip();
    const empty = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    act(() => {
      screen.getByRole('tablist').dispatchEvent(empty);
    });
    expect(empty.defaultPrevented).toBe(false);
    expect(screen.queryAllByRole('menuitem')).toHaveLength(0);
  });
});

/**
 * The page's wiring in miniature: the real reducer, the real toast store, the
 * page's one close path (an id per group, its closer, offerUndo), the strip
 * and the ☰ beside it. The hidden "agent close <key>" buttons stand in for an
 * agent's `close`.
 */
function Workspace({ initial = START }: { initial?: TabsState }) {
  const [state, dispatch] = useReducer(tabsReducer, initial);
  const [menuOpen, setMenuOpen] = useState(false);
  const stateRef = useRef(state);
  useLayoutEffect(() => {
    stateRef.current = state;
  });
  const toasts = useToasts();
  const reopen = (id?: string) => dispatch({ type: 'reopenClosed', id });
  const offerUndo = useOfferUndo(toasts, reopen);
  const title = (key: string) => TABS.find((t) => t.key === key)?.title ?? key;
  const closeTabs = (
    keys: readonly string[],
    make: (closed: CloseInfo) => TabsAction,
    closedBy: ClosedBy = 'you'
  ) => {
    const now = stateRef.current;
    const closing = now.keys.filter((k) => keys.includes(k));
    if (closing.length === 0) return;
    const id = mintClosedId(now.closedStack);
    dispatch(make({ id, closedBy }));
    offerUndo(id, closing.length);
  };
  const keys = () => stateRef.current.keys;
  return (
    <ToastContext.Provider value={toasts}>
      <TabStrip
        tabs={state.keys.map((key) => ({ key, title: title(key) }))}
        activeKey={state.active}
        onFocus={(key) => dispatch({ type: 'focus', key })}
        onClose={(key) => closeTabs([key], (closed) => ({ type: 'close', key, closed }))}
        onCloseOthers={(key) =>
          closeTabs(
            keys().filter((k) => k !== key),
            (closed) => ({ type: 'closeOthers', key, closed })
          )
        }
        onCloseToRight={(key) =>
          closeTabs(keys().slice(keys().indexOf(key) + 1), (closed) => ({
            type: 'closeToRight',
            key,
            closed,
          }))
        }
      />
      <WindowMenu
        open={menuOpen}
        onOpenChange={setMenuOpen}
        tabCount={state.keys.length}
        onCloseAll={() => closeTabs(keys(), (closed) => ({ type: 'closeAll', closed }))}
        closedGroups={[...(state.closedStack ?? [])].reverse().map((entry) => ({
          id: entry.id,
          closedBy: entry.closedBy,
          label: closedTitles(recordKeys(entry).map(title)),
        }))}
        onReopenGroup={reopen}
      />
      <button type="button" hidden onClick={() => reopen()}>
        reopen newest
      </button>
      {state.keys.map((key) => (
        <button
          key={key}
          type="button"
          hidden
          onClick={() => closeTabs([key], (closed) => ({ type: 'close', key, closed }), 'agent')}
        >
          {`agent close ${key}`}
        </button>
      ))}
      <ToastRegion store={toasts} />
    </ToastContext.Provider>
  );
}

function stripKeys(): string[] {
  return screen.queryAllByRole('tab').map((t) => t.getAttribute('data-tab-key')!);
}

async function choose(target: HTMLElement, label: string) {
  fireEvent.contextMenu(target);
  fireEvent.click(await screen.findByRole('menuitem', { name: label }));
}

async function chooseInWindowMenu(label: string) {
  fireEvent.click(screen.getByRole('button', { name: WINDOW_MENU }));
  fireEvent.click(await screen.findByRole('menuitem', { name: label }));
}

describe('TabStrip bulk close and Undo (real reducer, real toast)', () => {
  it('Close others → "Closed 2 tabs" → Undo restores the group in order', async () => {
    render(<Workspace />);
    await choose(tab('bts/bpm?SECTOR=3'), CLOSE_OTHERS);
    expect(stripKeys()).toEqual(['bts/bpm?SECTOR=3']);
    expect(screen.getByTestId('canopy-toast').textContent).toContain('Closed 2 tabs');
    fireEvent.click(screen.getByRole('button', { name: UNDO }));
    // Each comes back at its old strip index.
    expect(stripKeys()).toEqual(['ops/main', 'bts/bpm?SECTOR=3', '@trace']);
    expect(screen.queryByTestId('canopy-toast')).toBeNull();
  });

  it('Close to the right and the ☰ Close all toast their count; Undo reopens', async () => {
    render(<Workspace />);
    await choose(tab('ops/main'), CLOSE_TO_RIGHT);
    expect(stripKeys()).toEqual(['ops/main']);
    expect(screen.getByTestId('canopy-toast').textContent).toContain('Closed 2 tabs');
    await chooseInWindowMenu(CLOSE_ALL);
    expect(stripKeys()).toEqual([]);
    expect(screen.getByTestId('canopy-toast').textContent).toContain('Closed 1 tab');
    fireEvent.click(screen.getByRole('button', { name: UNDO }));
    expect(stripKeys()).toEqual(['ops/main']);
  });

  // The toast covers single closes too.
  it('a single Close offers Undo too; reopening brings it back in place', async () => {
    render(<Workspace />);
    await choose(tab('bts/bpm?SECTOR=3'), CLOSE_TAB);
    expect(stripKeys()).toEqual(['ops/main', '@trace']);
    expect(screen.getByTestId('canopy-toast').textContent).toContain('Closed 1 tab');
    // ⌘⇧T's path (the page binds it): the newest group.
    fireEvent.click(screen.getByText('reopen newest'));
    expect(stripKeys()).toEqual(['ops/main', 'bts/bpm?SECTOR=3', '@trace']);
    // The toast's Undo now names a group that is gone: it does nothing.
    fireEvent.click(screen.getByRole('button', { name: UNDO }));
    expect(stripKeys()).toEqual(['ops/main', 'bts/bpm?SECTOR=3', '@trace']);
  });

  it('one toast at a time: the newest close wins and its Undo reopens only its group', async () => {
    render(<Workspace />);
    await choose(tab('@trace'), CLOSE_TAB);
    await choose(tab('ops/main'), CLOSE_TAB);
    expect(screen.getAllByTestId('canopy-toast')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: UNDO }));
    expect(stripKeys()).toEqual(['ops/main', 'bts/bpm?SECTOR=3']);
  });
});

describe('Recently closed in the ☰ (real reducer)', () => {
  /** "Recently closed" in the ☰ (its name holds its entries; its title is its own). */
  async function recentItem(): Promise<HTMLElement | undefined> {
    fireEvent.click(screen.getByRole('button', { name: WINDOW_MENU }));
    const items = await screen.findAllByRole('menuitem');
    return items.find((m) => m.getAttribute('title') === RECENTLY_CLOSED);
  }

  async function recent(): Promise<string[]> {
    const parent = await recentItem();
    if (!parent) throw new Error('no Recently closed entry');
    expect(parent.getAttribute('aria-haspopup')).toBe('true');
    fireEvent.click(parent);
    return [...parent.querySelectorAll('[role="menu"] [role="menuitem"]')].map(
      (m) => m.getAttribute('title') ?? ''
    );
  }

  it('is disabled while nothing was closed', async () => {
    render(<Workspace />);
    const item = await recentItem();
    expect(item?.getAttribute('aria-disabled')).toBe('true');
  });

  it('lists each group newest first with its closer; choosing one restores it in place', async () => {
    render(<Workspace />);
    fireEvent.click(screen.getByText('agent close bts/bpm?SECTOR=3'));
    expect(screen.getByTestId('canopy-toast').textContent).toContain('Closed 1 tab');
    await choose(tab('@trace'), CLOSE_TAB);
    expect(stripKeys()).toEqual(['ops/main']);
    expect(await recent()).toEqual([
      closedGroupLabel({ id: 'x', label: 'Trace', closedBy: 'you' }),
      closedGroupLabel({ id: 'y', label: 'BPM', closedBy: 'agent' }),
    ]);
    fireEvent.click(screen.getByRole('menuitem', { name: 'BPM · agent' }));
    // The agent's tab is back at its index; the operator's close stands.
    expect(stripKeys()).toEqual(['ops/main', 'bts/bpm?SECTOR=3']);
    // ⌘⇧T's newest is now the operator's group (Trace, closed at index 1):
    // no duplicate of BPM.
    fireEvent.click(screen.getByText('reopen newest'));
    expect(stripKeys()).toEqual(['ops/main', '@trace', 'bts/bpm?SECTOR=3']);
  });

  it('labels a group by its first two titles, then a count', () => {
    expect(closedTitles(['A'])).toBe('A');
    expect(closedTitles(['A', 'B'])).toBe('A, B');
    expect(closedTitles(['A', 'B', 'C', 'D'])).toBe('A, B +2');
    expect(closedGroupLabel({ id: 'g', label: 'A, B', closedBy: 'agent' })).toBe('A, B · agent');
    expect(closedGroupLabel({ id: 'g', label: 'A', closedBy: 'you' })).toBe('A · you');
  });
});

describe('isReopenClosedShortcut', () => {
  const key = (init: Partial<KeyboardEvent>) =>
    ({
      key: 'T',
      metaKey: false,
      ctrlKey: false,
      shiftKey: true,
      altKey: false,
      ...init,
    }) as KeyboardEvent;

  it('is ⌘⇧T on macOS and Ctrl+Shift+T elsewhere', () => {
    expect(isReopenClosedShortcut(key({ metaKey: true }), true)).toBe(true);
    expect(isReopenClosedShortcut(key({ key: 't', metaKey: true }), true)).toBe(true);
    expect(isReopenClosedShortcut(key({ ctrlKey: true }), false)).toBe(true);
    expect(isReopenClosedShortcut(key({ ctrlKey: true }), true)).toBe(false);
    expect(isReopenClosedShortcut(key({ metaKey: true }), false)).toBe(false);
    expect(isReopenClosedShortcut(key({ metaKey: true, shiftKey: false }), true)).toBe(false);
    expect(isReopenClosedShortcut(key({ metaKey: true, altKey: true }), true)).toBe(false);
    expect(isReopenClosedShortcut(key({ metaKey: true, key: 'w' }), true)).toBe(false);
  });
});
