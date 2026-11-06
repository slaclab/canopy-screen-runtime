// The dock bridge as the single decider, against a real dockview-core 7.0.2 (made by
// createDock) in jsdom, the real tabs reducer and real DOM drag events — never a
// hand-raised shield. Pinned here: with the engine stubbed to `changed:false`, drags over a
// content edge, a dockview tab and the dock's side leave the dock as it was (dockview
// moves nothing by itself, every overlay is prevented); a real dockview tab dragstart and a
// real tile-bar grip dragstart each give a recognised source, raise the shield and paint a
// preview; a foreign drag gets nothing; a drop dispatches `drop` and the holder applies once
// the drag has ended; an apply followed by a microtask dispatches no `resized`; an `open`
// dispatched mid-drag applies once, at drag end; a sash gesture reports `resized` sizes and
// never re-applies.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { useCallback, useReducer, useRef, type Dispatch } from 'react';
import { createPortal } from 'react-dom';
import type { DockviewApi } from 'dockview-core';
import { fromLayout, tabsReducer, type TabsAction, type TabsState } from '../tabs.js';
import type { Layout } from '@slaclab/canopy-dock-engine';
import { createDock } from './createDock.js';
import { TileBar } from './TileBar.js';
import { clearDockDrag } from './tabAdapter.js';
import { useDockBridge, type DockBridge } from './useDockBridge.js';

const engine = vi.hoisted(() => ({ unchanged: false }));

vi.mock('@slaclab/canopy-dock-engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@slaclab/canopy-dock-engine')>();
  return {
    ...actual,
    planDrop: (...args: Parameters<typeof actual.planDrop>) =>
      engine.unchanged ? { layout: args[0], changed: false } : actual.planDrop(...args),
  };
});

/** Every element is this many px square; the dock root's client rect is (0, 0, SIZE, SIZE). */
const SIZE = 400;
const sizeProps = ['offsetWidth', 'offsetHeight'] as const;

/** Tiles A | B, half each. */
const AB: Layout = {
  split: 'row',
  items: [
    { tile: 'A', tabs: ['demo/a'], showing: 'demo/a', size: 0.5 },
    { tile: 'B', tabs: ['demo/b'], showing: 'demo/b', size: 0.5 },
  ],
};

/** Inside A's content, in its right edge zone (clear of the A|B border). */
const A_RIGHT_EDGE = { clientX: 150, clientY: 200 };
/** The dock's left side, 5 px in. */
const OUTER_LEFT = { clientX: 5, clientY: 200 };
/** B's centre. */
const B_CENTRE = { clientX: 300, clientY: 200 };

const roots: HTMLElement[] = [];
const apis: DockviewApi[] = [];

beforeEach(() => {
  engine.unchanged = false;
  // jsdom has no PointerEvent; dockview's drag source checks for it on dragstart.
  vi.stubGlobal('PointerEvent', class extends MouseEvent {});
  for (const prop of sizeProps) {
    Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get: () => SIZE });
  }
});

afterEach(() => {
  cleanup();
  clearDockDrag();
  for (const api of apis.splice(0)) api.dispose();
  for (const root of roots.splice(0)) root.remove();
  for (const prop of sizeProps)
    delete (HTMLElement.prototype as unknown as Record<string, unknown>)[prop];
  vi.unstubAllGlobals();
});

interface Handle {
  state: TabsState;
  dispatch: Dispatch<TabsAction>;
  bridge: DockBridge;
}

/** Mounts the bridge over the real reducer and a dock made by createDock, holding `layout`. */
function mount(
  layout: Layout,
  opts: { bars?: boolean; unsized?: boolean; storedPx?: boolean } = {}
) {
  const root = document.createElement('div');
  root.getBoundingClientRect = () => new DOMRect(0, 0, SIZE, SIZE);
  document.body.appendChild(root);
  roots.push(root);
  const api = createDock(root);
  // `unsized`: the dock has no size yet when the bridge first applies (a page load).
  if (!opts.unsized) api.layout(SIZE, SIZE, true);
  apis.push(api);
  const barHost = document.createElement('div');
  root.appendChild(barHost);
  const spy = vi.fn<(action: TabsAction) => void>();
  const handle = {} as Handle;
  const initial: TabsState =
    opts.unsized && !opts.storedPx
      ? fromLayout(layout, 'A')
      : { ...fromLayout(layout, 'A'), dockPx: { width: SIZE, height: SIZE } };
  function Harness() {
    const [state, dispatch] = useReducer(tabsReducer, initial);
    const raw = useRef(dispatch);
    raw.current = dispatch;
    const bridgeDispatch = useCallback((action: TabsAction) => {
      spy(action);
      raw.current(action);
    }, []);
    const bridge = useDockBridge(api, state, bridgeDispatch, { root });
    handle.state = state;
    handle.dispatch = dispatch;
    handle.bridge = bridge;
    return opts.bars
      ? createPortal(
          <TileBar
            tile="B"
            tabs={[{ key: 'demo/b', title: 'b' }]}
            panelKey="demo/b"
            title="b"
            focused={false}
            multiTile
            documentFocused
          />,
          barHost
        )
      : null;
  }
  render(<Harness />);
  spy.mockClear();
  return { root, api, spy, handle };
}

type Mounted = ReturnType<typeof mount>;

/** A minimal DataTransfer: jsdom has none. */
function transfer(data: Record<string, string> = {}): DataTransfer {
  const store = { ...data };
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
    dropEffect: 'none',
    items: { length: 0 },
    files: { length: 0 },
  } as unknown as DataTransfer;
}

function fire(
  target: Element,
  type: string,
  dataTransfer: DataTransfer,
  point = B_CENTRE
): MouseEvent {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...point });
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

async function turn(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function groupOf(m: Mounted, tile: string): HTMLElement {
  const group = m.api.groups.find((g) => g.id === tile);
  if (!group) throw new Error(`no group ${tile}`);
  return group.element;
}

function dvTab(m: Mounted, tile: string): HTMLElement {
  return groupOf(m, tile).querySelector<HTMLElement>('.dv-tab')!;
}

function content(m: Mounted, tile: string): HTMLElement {
  return groupOf(m, tile).querySelector<HTMLElement>('.dv-content-container')!;
}

function actions(m: Mounted): TabsAction[] {
  return m.spy.mock.calls.map(([action]) => action);
}

/** Every overlay any group or the api would show, recorded after the bridge ran. */
function overlays(m: Mounted): { defaultPrevented: boolean }[] {
  const seen: { defaultPrevented: boolean }[] = [];
  for (const group of m.api.groups) group.model.onWillShowOverlay((e) => seen.push(e));
  m.api.onWillShowOverlay((e) => seen.push(e));
  return seen;
}

describe('mount', () => {
  it('applies the holder layout: group id = tile id, one view per tab', () => {
    const m = mount(AB);
    expect(m.api.groups.map((g) => g.id)).toEqual(['A', 'B']);
    expect(m.api.getGroup('B')!.panels.map((p) => p.id)).toEqual(['demo/b']);
    expect(actions(m)).toEqual([]);
  });
});

describe('dockview decides nothing', () => {
  it.each([
    ['a content edge', (m: Mounted) => content(m, 'A'), A_RIGHT_EDGE],
    ['a tab', (m: Mounted) => dvTab(m, 'A'), { clientX: 50, clientY: 10 }],
    ['the dock side', (m: Mounted) => content(m, 'A'), OUTER_LEFT],
  ])(
    'a drop on %s with the engine unchanged leaves api.toJSON() as it was',
    async (_, at, point) => {
      engine.unchanged = true;
      const m = mount(AB);
      const before = JSON.stringify(m.api.toJSON());
      const seen = overlays(m);
      const dataTransfer = transfer();
      const source = dvTab(m, 'B');
      fire(source, 'dragstart', dataTransfer);
      const target = at(m);
      fire(target, 'dragenter', dataTransfer, point);
      fire(target, 'dragover', dataTransfer, point);
      fire(target, 'drop', dataTransfer, point);
      fire(source, 'dragend', dataTransfer);
      await turn();
      expect(seen.every((e) => e.defaultPrevented)).toBe(true);
      // The bridge did decide: it dispatched a drop, and the engine said nothing changes.
      expect(actions(m).filter((a) => a.type === 'drop')).toHaveLength(1);
      expect(JSON.stringify(m.api.toJSON())).toBe(before);
      expect(m.handle.bridge.dragging).toBe(false);
    }
  );
});

describe('drag sources', () => {
  it('a dockview tab dragstart is a recognised source: shield up and a preview', () => {
    const m = mount(AB);
    const dataTransfer = transfer();
    fire(dvTab(m, 'B'), 'dragstart', dataTransfer);
    expect(m.handle.bridge.dragging).toBe(true);
    const over = fire(content(m, 'A'), 'dragover', dataTransfer, A_RIGHT_EDGE);
    expect(over.defaultPrevented).toBe(true);
    expect(m.handle.bridge.preview.target).toEqual({ tile: 'A', edge: 'right' });
    expect(m.handle.bridge.preview.result).not.toBeNull();
  });

  it('a tile-bar grip dragstart is a recognised source: shield up and a preview', () => {
    const m = mount(AB, { bars: true });
    const grip = m.root.querySelector('.canopy-tile-bar__grip');
    expect(grip).not.toBeNull();
    const dataTransfer = transfer();
    fire(grip!, 'dragstart', dataTransfer);
    expect(m.handle.bridge.dragging).toBe(true);
    fire(content(m, 'A'), 'dragover', dataTransfer, A_RIGHT_EDGE);
    expect(m.handle.bridge.preview.target).toEqual({ tile: 'A', edge: 'right' });
    expect(m.handle.bridge.preview.result).not.toBeNull();
  });

  it('draws the highlight on the hovered tile as the DOM lays it out', () => {
    const m = mount(AB);
    groupOf(m, 'A').getBoundingClientRect = () => new DOMRect(0, 0, 197, SIZE);
    const dataTransfer = transfer();
    fire(dvTab(m, 'B'), 'dragstart', dataTransfer);
    fire(content(m, 'A'), 'dragover', dataTransfer, A_RIGHT_EDGE);
    expect(m.handle.bridge.preview.result?.rect).toEqual({ x: 99, y: 0, width: 98, height: SIZE });
    fire(content(m, 'A'), 'dragover', dataTransfer, { clientX: 100, clientY: 200 });
    expect(m.handle.bridge.preview.target).toEqual({ tile: 'A', zone: 'centre' });
    expect(m.handle.bridge.preview.result?.rect).toEqual({ x: 0, y: 0, width: 197, height: SIZE });
  });

  it('clears the highlight once the drag moves off the dock (above it, say)', () => {
    const m = mount(AB);
    const dataTransfer = transfer();
    fire(dvTab(m, 'B'), 'dragstart', dataTransfer);
    fire(content(m, 'A'), 'dragover', dataTransfer, A_RIGHT_EDGE);
    expect(m.handle.bridge.preview.target).not.toBeNull();
    const header = document.createElement('div');
    document.body.prepend(header);
    roots.push(header);
    fire(header, 'dragover', dataTransfer, { clientX: 150, clientY: -10 });
    expect(m.handle.bridge.preview.target).toBeNull();
    expect(m.handle.bridge.dragging).toBe(true);
  });

  it('a foreign drag gets no preview, no shield and no drop', () => {
    const m = mount(AB);
    const dataTransfer = transfer({ 'text/plain': 'hello' });
    fire(content(m, 'A'), 'dragenter', dataTransfer, A_RIGHT_EDGE);
    fire(content(m, 'A'), 'dragover', dataTransfer, A_RIGHT_EDGE);
    expect(m.handle.bridge.preview.target).toBeNull();
    expect(m.handle.bridge.dragging).toBe(false);
    fire(content(m, 'A'), 'drop', dataTransfer, A_RIGHT_EDGE);
    expect(actions(m)).toEqual([]);
  });
});

describe('drop and apply', () => {
  it('a grip drop on an edge dispatches drop and applies once the drag has ended', async () => {
    const m = mount(AB, { bars: true });
    const fromJSON = vi.spyOn(m.api, 'fromJSON');
    const grip = m.root.querySelector('.canopy-tile-bar__grip')!;
    const dataTransfer = transfer();
    fire(grip, 'dragstart', dataTransfer);
    fire(content(m, 'A'), 'dragover', dataTransfer, { clientX: 100, clientY: 320 });
    fire(content(m, 'A'), 'drop', dataTransfer, { clientX: 100, clientY: 320 });
    expect(actions(m)).toEqual([
      {
        type: 'drop',
        source: { tile: 'B' },
        target: { tile: 'A', edge: 'bottom' },
        dock: { width: SIZE, height: SIZE },
      },
    ]);
    expect(fromJSON).not.toHaveBeenCalled();
    fire(grip, 'dragend', dataTransfer);
    await turn();
    expect(fromJSON).toHaveBeenCalledTimes(1);
    // B under A: the root is now a column of A over B.
    const grid = m.api.toJSON().grid;
    expect(grid.orientation).toBe('VERTICAL');
    const leaves = (grid.root.data as { data: { id: string } }[]).map((n) => n.data.id);
    expect(leaves).toEqual(['A', 'B']);
    expect(m.handle.bridge.dragging).toBe(false);
  });

  it('an apply followed by a microtask dispatches no resized', async () => {
    const m = mount(AB);
    const fromJSON = vi.spyOn(m.api, 'fromJSON');
    act(() =>
      m.handle.dispatch({
        type: 'restore',
        layout: {
          split: 'column',
          items: [
            { tile: 'A', tabs: ['demo/a'], showing: 'demo/a', size: 0.3 },
            { tile: 'B', tabs: ['demo/b'], showing: 'demo/b', size: 0.7 },
          ],
        },
      })
    );
    expect(fromJSON).toHaveBeenCalledTimes(1);
    await act(async () => {
      await Promise.resolve();
    });
    await turn();
    expect(actions(m).filter((a) => a.type === 'resized')).toEqual([]);
    expect(fromJSON).toHaveBeenCalledTimes(1);
  });

  it('an open dispatched mid-drag applies once, at drag end', async () => {
    const m = mount(AB);
    const fromJSON = vi.spyOn(m.api, 'fromJSON');
    const dataTransfer = transfer();
    const source = dvTab(m, 'B');
    fire(source, 'dragstart', dataTransfer);
    act(() => m.handle.dispatch({ type: 'open', key: 'demo/c', mode: 'append' }));
    expect(m.handle.state.keys).toContain('demo/c');
    expect(fromJSON).not.toHaveBeenCalled();
    // The live drag re-reads the holder: the preview already sees the new layout.
    fire(content(m, 'A'), 'dragover', dataTransfer, A_RIGHT_EDGE);
    expect(m.handle.bridge.preview.target).not.toBeNull();
    fire(source, 'dragend', dataTransfer);
    expect(fromJSON).not.toHaveBeenCalled();
    await turn();
    expect(fromJSON).toHaveBeenCalledTimes(1);
    expect(m.api.panels.map((p) => p.id)).toContain('demo/c');
    await turn();
    expect(fromJSON).toHaveBeenCalledTimes(1);
  });
});

describe('the strip handlers', () => {
  it('share the root path: a drop on the strip reports a tab target', () => {
    const m = mount(AB);
    const dataTransfer = transfer();
    fire(dvTab(m, 'B'), 'dragstart', dataTransfer);
    // A strip above the dock, keyed to tile A.
    const strip = {
      A: {
        barRect: { x: 0, y: -30, width: SIZE, height: 30 },
        tabRects: [{ x: 0, y: -30, width: 100, height: 30 }],
      },
    };
    const event = {
      clientX: 150,
      clientY: -15,
      dataTransfer,
      preventDefault: vi.fn(),
    };
    act(() => m.handle.bridge.stripDragOver(event, strip));
    expect(event.preventDefault).toHaveBeenCalled();
    expect(m.handle.bridge.preview.target).toMatchObject({ tile: 'A', zone: 'tab' });
    act(() => m.handle.bridge.stripDrop(event, strip));
    expect(actions(m)).toEqual([
      expect.objectContaining({ type: 'drop', target: expect.objectContaining({ tile: 'A' }) }),
    ]);
  });
});

describe('resized', () => {
  it('a sash gesture reports sizes once and never re-applies', async () => {
    const m = mount(AB);
    const fromJSON = vi.spyOn(m.api, 'fromJSON');
    const sash = m.root.querySelector('.dv-sash');
    expect(sash).not.toBeNull();
    act(() => {
      sash!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    });
    await turn();
    const resized = actions(m).filter((a) => a.type === 'resized');
    expect(resized).toHaveLength(1);
    expect(resized[0]).toMatchObject({ layout: { split: 'row' } });
    expect(fromJSON).not.toHaveBeenCalled();
    // A second pointerup without a pointerdown on a sash reports nothing.
    act(() => {
      document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    });
    await turn();
    expect(actions(m).filter((a) => a.type === 'resized')).toHaveLength(1);
  });
});

describe('a dock size change', () => {
  /** Tiles A | B at 0.7 / 0.3. */
  const UNEVEN: Layout = {
    split: 'row',
    items: [
      { tile: 'A', tabs: ['demo/a'], showing: 'demo/a', size: 0.7 },
      { tile: 'B', tabs: ['demo/b'], showing: 'demo/b', size: 0.3 },
    ],
  };
  const widths = (m: Mounted) =>
    (m.api.toJSON().grid.root.data as { size: number }[]).map((n) => Math.round(n.size));

  it('re-applies the holder sizes the first apply lost on a dock with no size yet', () => {
    const m = mount(UNEVEN, { unsized: true });
    // dockview gets its size after the first apply and lays the tiles out evenly.
    act(() => m.api.layout(SIZE, SIZE, true));
    const before = widths(m);
    expect(Math.abs(before[0]! - SIZE * 0.7)).toBeGreaterThan(2);
    // The ResizeObserver's report changes only dockPx; the layout is the same object.
    const layout = m.handle.state.layout;
    act(() => m.handle.dispatch({ type: 'resized', dock: { width: SIZE, height: SIZE } }));
    expect(m.handle.state.layout).toBe(layout);
    expect(widths(m)).toEqual([SIZE * 0.7, SIZE * 0.3]);
  });

  it('does not re-apply a dock that already shows the holder sizes', () => {
    const m = mount(UNEVEN);
    expect(widths(m)).toEqual([SIZE * 0.7, SIZE * 0.3]);
    const fromJSON = vi.spyOn(m.api, 'fromJSON');
    act(() => m.handle.dispatch({ type: 'resized', dock: { width: SIZE + 1, height: SIZE } }));
    expect(fromJSON).not.toHaveBeenCalled();
  });

  it('re-applies once dockview has laid itself out, also when dockPx is unchanged', () => {
    // A stored dock size equal to the real one: the observer dispatches nothing new. The
    // last observer made is the bridge's (dockview's own is made with the dock, before it).
    let observed: ResizeObserverCallback | null = null;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          observed = callback;
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const m = mount(UNEVEN, { unsized: true, storedPx: true });
    expect(observed).not.toBeNull();
    act(() =>
      observed!(
        [{ contentRect: { width: SIZE, height: SIZE } } as ResizeObserverEntry],
        {} as ResizeObserver
      )
    );
    expect(actions(m).filter((a) => a.type === 'resized')).toEqual([]);
    // dockview's own frame lays it out evenly; the bridge's frame follows it.
    act(() => m.api.layout(SIZE, SIZE, true));
    expect(widths(m)).not.toEqual([SIZE * 0.7, SIZE * 0.3]);
    act(() => frames.splice(0).forEach((cb) => cb(0)));
    expect(widths(m)).toEqual([SIZE * 0.7, SIZE * 0.3]);
  });

  it('waits for a live drag to end', async () => {
    const m = mount(UNEVEN, { unsized: true });
    act(() => m.api.layout(SIZE, SIZE, true));
    const fromJSON = vi.spyOn(m.api, 'fromJSON');
    const dataTransfer = transfer();
    const source = dvTab(m, 'B');
    fire(source, 'dragstart', dataTransfer);
    act(() => m.handle.dispatch({ type: 'resized', dock: { width: SIZE, height: SIZE } }));
    expect(fromJSON).not.toHaveBeenCalled();
    fire(source, 'dragend', dataTransfer);
    await turn();
    expect(widths(m)).toEqual([SIZE * 0.7, SIZE * 0.3]);
  });
});
