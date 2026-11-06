// The overlay layer and useTileRect. Pinned here: each trigger (layout
// change, active-group change, window resize, ResizeObserver) copies the placeholder group's
// content rect onto the overlay element relative to the layer; no synthetic resize is
// dispatched; a key without a tile is marked unplaced, never left at a stale rect; the item
// re-binds when its element changes; the drag shield is one class on the layer and nothing
// writes inline pointer-events; dock.css carries none of the stacking-context properties.
// Tabs: a tile's showing tab is placed and its hidden tabs stay mounted but unplaced; a
// `fromJSON` rebuild (every drop and tab switch) re-places and re-targets at once; a native
// drag from outside the layer raises the shield and nothing leaves it up; a frame shown
// during a drag keeps its input after dockview restores its pointer-events snapshot.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { useLayoutEffect, useRef, useState } from 'react';
import type { DockviewApi } from 'dockview-core';
import { createDock } from './createDock.js';
import { toSerialized } from './applyLayout.js';
import type { Layout } from '@slaclab/canopy-dock-engine';
import { TraceTab } from '../TraceTab.js';
import {
  DockOverlay,
  DockOverlayItem,
  OVERLAY_CLASS,
  OVERLAY_DRAGGING_CLASS,
  OVERLAY_ITEM_CLASS,
  stableOrder,
} from './DockOverlay.js';
import { CONTENT_CONTAINER, type TileRectApi } from './useTileRect.js';

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** jsdom has no layout: give `el` a fixed client rect, changeable by re-stubbing. */
function stubRect(el: Element, box: Box): void {
  Object.defineProperty(el, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      ...box,
      x: box.left,
      y: box.top,
      right: box.left + box.width,
      bottom: box.top + box.height,
      toJSON() {},
    }),
  });
}

function geometry(el: HTMLElement) {
  const { top, left, width, height } = el.style;
  return { top, left, width, height };
}

/** A ResizeObserver stand-in whose callback the test fires by hand (App.test.tsx pattern). */
function stubResizeObserver() {
  const observers: { callback: ResizeObserverCallback; targets: Element[] }[] = [];
  class FakeResizeObserver {
    private readonly entry: { callback: ResizeObserverCallback; targets: Element[] };
    constructor(callback: ResizeObserverCallback) {
      this.entry = { callback, targets: [] };
      observers.push(this.entry);
    }
    observe(target: Element) {
      this.entry.targets.push(target);
    }
    unobserve() {}
    disconnect() {
      this.entry.targets = [];
    }
  }
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  return observers;
}

// ---------------------------------------------------------------------------------------------
// A hand-driven api: each dockview event fires alone, so each trigger is proven on its own.

type Listener = () => void;

function emitter() {
  const listeners = new Set<Listener>();
  return {
    event: (listener: Listener) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    fire: () => {
      for (const listener of [...listeners]) listener();
    },
    size: () => listeners.size,
  };
}

function fakeApi() {
  const layout = emitter();
  const activeGroup = emitter();
  const activePanel = emitter();
  const fromJSON = emitter();
  const tiles = new Map<string, { group: { element: HTMLElement; activePanel: object } }>();
  const api = {
    // The returned panel is the object its group's activePanel holds, as in dockview.
    getPanel: (id: string) => tiles.get(id)?.group.activePanel,
    onDidLayoutChange: layout.event,
    onDidActiveGroupChange: activeGroup.event,
    onDidActivePanelChange: activePanel.event,
    onDidLayoutFromJSON: fromJSON.event,
  } as unknown as TileRectApi;
  /** Adds (or moves) a tile for `key` whose content container has `box`; returns it. */
  function tile(key: string, box: Box): HTMLElement {
    const element = document.createElement('div');
    const content = document.createElement('div');
    content.className = CONTENT_CONTAINER.slice(1);
    element.appendChild(content);
    stubRect(content, box);
    const group = { element, activePanel: {} as object };
    group.activePanel = { id: key, group };
    tiles.set(key, { group });
    return content;
  }
  return { api, layout, activeGroup, activePanel, fromJSON, tiles, tile };
}

const LAYER_BOX: Box = { left: 100, top: 50, width: 1000, height: 800 };

function renderOverlay(api: TileRectApi | null, keys: string[], dragging = false) {
  function Harness({
    api: a,
    keys: k,
    dragging: d,
  }: {
    api: TileRectApi | null;
    keys: string[];
    dragging: boolean;
  }) {
    return (
      <DockOverlay dragging={d}>
        {k.map((key) => (
          <DockOverlayItem key={key} api={a} tileKey={key}>
            <span>{key}</span>
          </DockOverlayItem>
        ))}
      </DockOverlay>
    );
  }
  const view = render(<Harness api={api} keys={keys} dragging={dragging} />);
  const layer = view.container.querySelector<HTMLElement>(`.${OVERLAY_CLASS}`)!;
  stubRect(layer, LAYER_BOX);
  const item = (key: string) =>
    view.container.querySelector<HTMLElement>(`.${OVERLAY_ITEM_CLASS}[data-tab-key="${key}"]`)!;
  return {
    ...view,
    layer,
    item,
    rerenderWith: (next: { api?: TileRectApi | null; keys?: string[]; dragging?: boolean }) =>
      view.rerender(
        <Harness
          api={next.api ?? api}
          keys={next.keys ?? keys}
          dragging={next.dragging ?? dragging}
        />
      ),
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useTileRect: each trigger copies the tile content rect', () => {
  it('places the item relative to the layer on a layout change', () => {
    const f = fakeApi();
    const content = f.tile('a', { left: 100, top: 80, width: 400, height: 300 });
    const view = renderOverlay(f.api, ['a']);
    stubRect(content, { left: 140, top: 90.4, width: 500.6, height: 310 });
    act(() => f.layout.fire());
    expect(geometry(view.item('a'))).toEqual({
      top: '40px',
      left: '40px',
      width: '501px',
      height: '310px',
    });
    expect(view.item('a').dataset.placed).toBe('true');
  });

  it('copies the rect on an active-group change', () => {
    const f = fakeApi();
    const content = f.tile('a', { left: 100, top: 50, width: 10, height: 10 });
    const view = renderOverlay(f.api, ['a']);
    stubRect(content, { left: 600, top: 70, width: 500, height: 700 });
    act(() => f.activeGroup.fire());
    expect(geometry(view.item('a'))).toEqual({
      top: '20px',
      left: '500px',
      width: '500px',
      height: '700px',
    });
  });

  it('copies the rect on a window resize', () => {
    const f = fakeApi();
    const content = f.tile('a', { left: 100, top: 50, width: 10, height: 10 });
    const view = renderOverlay(f.api, ['a']);
    stubRect(content, { left: 100, top: 50, width: 1000, height: 800 });
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(geometry(view.item('a'))).toEqual({
      top: '0px',
      left: '0px',
      width: '1000px',
      height: '800px',
    });
  });

  it('copies the rect when the ResizeObserver on the content container fires', () => {
    const observers = stubResizeObserver();
    const f = fakeApi();
    const content = f.tile('a', { left: 100, top: 50, width: 10, height: 10 });
    const view = renderOverlay(f.api, ['a']);
    const watching = observers.filter((o) => o.targets.includes(content));
    expect(watching).toHaveLength(1);
    stubRect(content, { left: 300, top: 250, width: 123, height: 456 });
    act(() => watching[0]!.callback([], {} as ResizeObserver));
    expect(geometry(view.item('a'))).toEqual({
      top: '200px',
      left: '200px',
      width: '123px',
      height: '456px',
    });
  });

  it('re-targets the observer when the tile moves to another group', () => {
    const observers = stubResizeObserver();
    const f = fakeApi();
    const first = f.tile('a', { left: 100, top: 50, width: 10, height: 10 });
    renderOverlay(f.api, ['a']);
    const second = f.tile('a', { left: 200, top: 50, width: 10, height: 10 });
    act(() => f.layout.fire());
    const live = observers.filter((o) => o.targets.length > 0);
    expect(live).toHaveLength(1);
    expect(live[0]!.targets).toEqual([second]);
    expect(live[0]!.targets).not.toContain(first);
  });

  it('dispatches no synthetic resize', () => {
    const f = fakeApi();
    f.tile('a', { left: 100, top: 50, width: 10, height: 10 });
    const spy = vi.spyOn(window, 'dispatchEvent');
    const target = vi.spyOn(EventTarget.prototype, 'dispatchEvent');
    renderOverlay(f.api, ['a']);
    act(() => {
      f.layout.fire();
      f.activeGroup.fire();
      f.activePanel.fire();
    });
    const resizes = [...spy.mock.calls, ...target.mock.calls].filter(([e]) => e.type === 'resize');
    expect(resizes).toEqual([]);
  });

  it('marks a key with no tile unplaced and clears a previously copied rect', () => {
    const f = fakeApi();
    f.tile('a', { left: 140, top: 90, width: 400, height: 300 });
    const view = renderOverlay(f.api, ['a', 'b']);
    act(() => f.layout.fire());
    expect(view.item('a').dataset.placed).toBe('true');
    expect(view.item('b').dataset.placed).toBe('false');
    f.tiles.delete('a');
    act(() => f.layout.fire());
    expect(view.item('a').dataset.placed).toBe('false');
    expect(geometry(view.item('a'))).toEqual({ top: '', left: '', width: '', height: '' });
  });

  it('treats a placeholder that is not its group active panel as unplaced', () => {
    const f = fakeApi();
    f.tile('a', { left: 140, top: 90, width: 400, height: 300 });
    const view = renderOverlay(f.api, ['a']);
    act(() => f.layout.fire());
    f.tiles.get('a')!.group.activePanel = { id: 'other' };
    act(() => f.activePanel.fire());
    expect(view.item('a').dataset.placed).toBe('false');
  });

  it('disposes every subscription on unmount', () => {
    const f = fakeApi();
    f.tile('a', { left: 100, top: 50, width: 10, height: 10 });
    const remove = vi.spyOn(window, 'removeEventListener');
    const view = renderOverlay(f.api, ['a']);
    expect(f.layout.size()).toBe(1);
    view.unmount();
    expect(f.layout.size()).toBe(0);
    expect(f.activeGroup.size()).toBe(0);
    expect(f.activePanel.size()).toBe(0);
    expect(f.fromJSON.size()).toBe(0);
    expect(remove.mock.calls.some(([type]) => type === 'resize')).toBe(true);
  });

  it('re-binds to a new item element and keeps the item stable across child remounts', () => {
    const f = fakeApi();
    const content = f.tile('a', { left: 100, top: 50, width: 10, height: 10 });
    function Harness({ epoch, wrap }: { epoch: number; wrap: string }) {
      return (
        <DockOverlay dragging={false}>
          <DockOverlayItem key={wrap} api={f.api} tileKey="a">
            <iframe key={`a:${epoch}`} title="t" />
          </DockOverlayItem>
        </DockOverlay>
      );
    }
    const view = render(<Harness epoch={0} wrap="w1" />);
    stubRect(view.container.querySelector(`.${OVERLAY_CLASS}`)!, LAYER_BOX);
    const before = view.container.querySelector<HTMLElement>(`.${OVERLAY_ITEM_CLASS}`)!;
    const frame = before.querySelector('iframe');
    view.rerender(<Harness epoch={1} wrap="w1" />);
    expect(view.container.querySelector(`.${OVERLAY_ITEM_CLASS}`)).toBe(before);
    expect(before.querySelector('iframe')).not.toBe(frame);
    // A new wrapper element: the hook binds to it and places it at once.
    stubRect(content, { left: 130, top: 60, width: 70, height: 80 });
    view.rerender(<Harness epoch={1} wrap="w2" />);
    const after = view.container.querySelector<HTMLElement>(`.${OVERLAY_ITEM_CLASS}`)!;
    expect(after).not.toBe(before);
    stubRect(content, { left: 150, top: 60, width: 70, height: 80 });
    act(() => f.layout.fire());
    expect(geometry(after)).toEqual({ top: '10px', left: '50px', width: '70px', height: '80px' });
  });
});

describe('useTileRect: a fromJSON rebuild', () => {
  it('re-places and re-targets on the rebuild event alone', () => {
    const observers = stubResizeObserver();
    const f = fakeApi();
    const before = f.tile('a', { left: 100, top: 50, width: 10, height: 10 });
    const view = renderOverlay(f.api, ['a']);
    // fromJSON disposes the group: a new content container somewhere else.
    before.remove();
    const after = f.tile('a', { left: 400, top: 150, width: 300, height: 200 });
    act(() => f.fromJSON.fire());
    expect(geometry(view.item('a'))).toEqual({
      top: '100px',
      left: '300px',
      width: '300px',
      height: '200px',
    });
    const live = observers.flatMap((o) => o.targets);
    expect(live).toHaveLength(1);
    expect(live[0]).toBe(after);
  });

  it('follows the tile when the observer finds its node detached', () => {
    const observers = stubResizeObserver();
    const f = fakeApi();
    const before = f.tile('a', { left: 100, top: 50, width: 10, height: 10 });
    const host = document.createElement('div');
    document.body.appendChild(host);
    host.appendChild(f.tiles.get('a')!.group.element);
    const view = renderOverlay(f.api, ['a']);
    const watching = observers.find((o) => o.targets.includes(before))!;
    host.remove();
    const after = f.tile('a', { left: 150, top: 60, width: 30, height: 40 });
    act(() => watching.callback([], {} as ResizeObserver));
    expect(geometry(view.item('a'))).toEqual({
      top: '10px',
      left: '50px',
      width: '30px',
      height: '40px',
    });
    // toBe, not toEqual: the two containers are structurally equal DOM nodes.
    const live = observers.flatMap((o) => o.targets);
    expect(live).toHaveLength(1);
    expect(live[0]).toBe(after);
  });
});

describe('DockOverlay: layer and drag shield', () => {
  it('toggles one shield class on the layer while dragging and writes no inline pointer-events', () => {
    const f = fakeApi();
    f.tile('a', { left: 100, top: 50, width: 10, height: 10 });
    const view = renderOverlay(f.api, ['a', 'b']);
    expect(view.layer.classList.contains(OVERLAY_DRAGGING_CLASS)).toBe(false);
    view.rerenderWith({ dragging: true });
    expect(view.layer.classList.contains(OVERLAY_DRAGGING_CLASS)).toBe(true);
    view.rerenderWith({ dragging: false });
    expect(view.layer.classList.contains(OVERLAY_DRAGGING_CLASS)).toBe(false);
    for (const el of [view.layer, view.item('a'), view.item('b')]) {
      expect(el.style.pointerEvents).toBe('');
      expect(el.style.zIndex).toBe('');
      expect(el.style.transform).toBe('');
    }
  });

  it('marks the focused item and passes through the caller attributes', () => {
    render(
      <DockOverlay dragging={false}>
        <DockOverlayItem api={null} tileKey="a" focused aria-hidden={false} />
        <DockOverlayItem api={null} tileKey="b" aria-hidden />
      </DockOverlay>
    );
    const a = document.querySelector<HTMLElement>('[data-tab-key="a"]')!;
    const b = document.querySelector<HTMLElement>('[data-tab-key="b"]')!;
    expect(a.dataset.focused).toBe('true');
    expect(b.dataset.focused).toBeUndefined();
    expect(b.getAttribute('aria-hidden')).toBe('true');
    // A null api leaves the element alone (no placement before the dock exists).
    expect(a.dataset.placed).toBeUndefined();
  });
});

describe('DockOverlay: item order (a moved iframe reloads)', () => {
  it('stableOrder keeps known keys in place and appends new ones', () => {
    expect(stableOrder([], ['a', 'b'])).toEqual(['a', 'b']);
    expect(stableOrder(['a', 'b', 'c'], ['c', 'a', 'b'])).toEqual(['a', 'b', 'c']);
    expect(stableOrder(['a', 'b', 'c'], ['d', 'c', 'a'])).toEqual(['d', 'a', 'c']);
    expect(stableOrder(['a', 'b', 'c'], ['b', 'd', 'c', 'a'])).toEqual(['a', 'b', 'd', 'c']);
    // Keys mounted one by one, last first, end in the caller's order.
    expect(stableOrder(stableOrder(['c'], ['b', 'c']), ['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
  });

  it('a reorder of the open keys moves no item node and keeps each frame in place', () => {
    const items = (keys: string[]) => (
      <DockOverlay dragging={false}>
        {keys.map((key) => (
          <DockOverlayItem key={key} api={null} tileKey={key}>
            <iframe title={key} />
          </DockOverlayItem>
        ))}
      </DockOverlay>
    );
    const view = render(items(['a', 'b', 'c']));
    const layer = view.container.querySelector<HTMLElement>(`.${OVERLAY_CLASS}`)!;
    const frames = [...layer.querySelectorAll('iframe')];
    // Watch for any node removal under the layer: a move is a remove and an insert.
    const removed: Node[] = [];
    const observer = new MutationObserver((records) => {
      for (const r of records) removed.push(...r.removedNodes);
    });
    observer.observe(layer, { childList: true, subtree: true });
    view.rerender(items(['c', 'a', 'b']));
    view.rerender(items(['b', 'd', 'c', 'a']));
    observer.takeRecords().forEach((r) => removed.push(...r.removedNodes));
    observer.disconnect();
    expect(removed).toEqual([]);
    const keysNow = [...layer.children].map((el) => (el as HTMLElement).dataset.tabKey);
    // d is new: placed after b, the key before it; a, b and c never moved.
    expect(keysNow).toEqual(['a', 'b', 'd', 'c']);
    const frameOf = (key: string) => layer.querySelector(`[data-tab-key="${key}"] iframe`);
    expect(['a', 'b', 'c'].map(frameOf)).toEqual(frames);
    // A closed key leaves; the rest stay put.
    view.rerender(items(['d', 'a']));
    expect([...layer.children].map((el) => (el as HTMLElement).dataset.tabKey)).toEqual(['a', 'd']);
    expect(layer.querySelector('iframe')).toBe(frames[0]);
  });
});

describe('DockOverlay over a real dockview-core 7.0.2', () => {
  it('sits right after the dock root and follows each placeholder group', () => {
    const handle: { api: DockviewApi | null } = { api: null };
    function Harness({ keys }: { keys: string[] }) {
      const rootRef = useRef<HTMLDivElement>(null);
      const [api, setApi] = useState<DockviewApi | null>(null);
      useLayoutEffect(() => {
        const created = createDock(rootRef.current!);
        created.addPanel({ id: 'a', component: 'canopy-panel', title: 'a' });
        created.addPanel({
          id: 'b',
          component: 'canopy-panel',
          title: 'b',
          position: { referencePanel: 'a', direction: 'right' },
        });
        handle.api = created;
        setApi(created);
        return () => created.dispose();
      }, []);
      return (
        <div className="parent">
          <div ref={rootRef} className="dock-root" />
          <DockOverlay dragging={false}>
            {keys.map((key) => (
              <DockOverlayItem key={key} api={api} tileKey={key} />
            ))}
          </DockOverlay>
        </div>
      );
    }
    const view = render(<Harness keys={[]} />);
    const root = view.container.querySelector<HTMLElement>('.dock-root')!;
    const layer = view.container.querySelector<HTMLElement>(`.${OVERLAY_CLASS}`)!;
    expect(root.nextElementSibling).toBe(layer);
    stubRect(layer, LAYER_BOX);
    const api = handle.api!;
    const contentOf = (key: string) =>
      api.getPanel(key)!.group.element.querySelector<HTMLElement>(CONTENT_CONTAINER)!;
    expect(contentOf('a').querySelector('.canopy-dock-placeholder')).not.toBeNull();
    stubRect(contentOf('a'), { left: 100, top: 78, width: 500, height: 772 });
    stubRect(contentOf('b'), { left: 600, top: 78, width: 500, height: 772 });
    view.rerender(<Harness keys={['a', 'b']} />);
    const item = (key: string) => layer.querySelector<HTMLElement>(`[data-tab-key="${key}"]`)!;
    expect(geometry(item('a'))).toEqual({
      top: '28px',
      left: '0px',
      width: '500px',
      height: '772px',
    });
    expect(geometry(item('b'))).toEqual({
      top: '28px',
      left: '500px',
      width: '500px',
      height: '772px',
    });
    // Activating the other group re-copies through the real api.
    stubRect(contentOf('a'), { left: 100, top: 78, width: 300, height: 772 });
    act(() => api.getPanel('b')!.group.api.setActive());
    act(() => api.getPanel('a')!.group.api.setActive());
    expect(item('a').style.width).toBe('300px');
  });
});

describe('DockOverlay over a real dock: tabs after a tab switch and a drop', () => {
  const DOCK = { width: 1000, height: 800 };
  const twoTiles = (showing: string): Layout => ({
    split: 'row',
    items: [
      { tile: 't1', tabs: ['a', 'b'], showing },
      { tile: 't2', tabs: ['c'], showing: 'c' },
    ],
  });

  function mount(layout: Layout) {
    const observers = stubResizeObserver();
    const handle: { api: DockviewApi | null } = { api: null };
    function Harness({ keys }: { keys: string[] }) {
      const rootRef = useRef<HTMLDivElement>(null);
      const [api, setApi] = useState<DockviewApi | null>(null);
      useLayoutEffect(() => {
        const created = createDock(rootRef.current!);
        created.fromJSON(toSerialized(layout, DOCK));
        handle.api = created;
        setApi(created);
        return () => created.dispose();
      }, []);
      return (
        <div className="parent">
          <div ref={rootRef} className="dock-root" />
          <DockOverlay dragging={false}>
            {keys.map((key) => (
              <DockOverlayItem key={key} api={api} tileKey={key}>
                <iframe title={key} />
              </DockOverlayItem>
            ))}
          </DockOverlay>
        </div>
      );
    }
    const view = render(<Harness keys={['a', 'b', 'c']} />, {
      container: document.body.appendChild(document.createElement('div')),
    });
    const item = (key: string) =>
      view.container.querySelector<HTMLElement>(`.${OVERLAY_ITEM_CLASS}[data-tab-key="${key}"]`)!;
    const contentOf = (key: string) =>
      handle.api!.getPanel(key)!.group.element.querySelector<HTMLElement>(CONTENT_CONTAINER)!;
    const watched = () => observers.flatMap((o) => o.targets);
    return { view, api: () => handle.api!, item, contentOf, watched };
  }

  it('places the showing tab and keeps the hidden tab mounted but unplaced', () => {
    const m = mount(twoTiles('a'));
    expect(m.item('a').dataset.placed).toBe('true');
    expect(m.item('b').dataset.placed).toBe('false');
    expect(m.item('c').dataset.placed).toBe('true');
    expect(m.item('b').querySelector('iframe')).not.toBeNull();
  });

  it('a tab switch through fromJSON places the new showing tab and watches live nodes', () => {
    const m = mount(twoTiles('a'));
    const frame = m.item('b').querySelector('iframe');
    act(() => m.api().fromJSON(toSerialized(twoTiles('b'), DOCK)));
    expect(m.item('a').dataset.placed).toBe('false');
    expect(m.item('b').dataset.placed).toBe('true');
    expect(m.item('c').dataset.placed).toBe('true');
    // Same frame, never remounted; every observed node is in the rebuilt dock.
    expect(m.item('b').querySelector('iframe')).toBe(frame);
    expect(m.watched().length).toBeGreaterThan(0);
    for (const node of m.watched()) expect(node.isConnected).toBe(true);
    expect(m.watched()).toContain(m.contentOf('b'));
    expect(m.watched()).toContain(m.contentOf('c'));
  });

  it('a drop rebuild that moves a tab into the other tile places it there', () => {
    const m = mount(twoTiles('a'));
    const moved: Layout = {
      split: 'row',
      items: [
        { tile: 't1', tabs: ['b'], showing: 'b' },
        { tile: 't2', tabs: ['c', 'a'], showing: 'a' },
      ],
    };
    act(() => m.api().fromJSON(toSerialized(moved, DOCK)));
    expect(m.item('a').dataset.placed).toBe('true');
    expect(m.item('b').dataset.placed).toBe('true');
    expect(m.item('c').dataset.placed).toBe('false');
    expect(m.watched()).toContain(m.contentOf('a'));
    for (const node of m.watched()) expect(node.isConnected).toBe(true);
  });
});

describe('DockOverlay: the native drag shield', () => {
  function setup() {
    const f = fakeApi();
    f.tile('a', { left: 100, top: 50, width: 10, height: 10 });
    const outside = document.createElement('div');
    outside.draggable = true;
    document.body.appendChild(outside);
    const view = renderOverlay(f.api, ['a']);
    const shielded = () => view.layer.classList.contains(OVERLAY_DRAGGING_CLASS);
    const fire = (target: EventTarget, type: string, init: PointerEventInit = {}) =>
      act(() => {
        const event =
          type.startsWith('pointer') && typeof PointerEvent !== 'undefined'
            ? new PointerEvent(type, { bubbles: true, ...init })
            : Object.assign(new Event(type, { bubbles: true }), init);
        target.dispatchEvent(event);
      });
    return { view, outside, shielded, fire };
  }

  it('raises the shield for a drag that starts outside the layer and drops it on dragend', () => {
    const s = setup();
    s.fire(s.outside, 'dragstart');
    expect(s.shielded()).toBe(true);
    expect(s.view.layer.dataset.dragging).toBe('true');
    expect(s.view.item('a').style.pointerEvents).toBe('');
    s.fire(s.outside, 'dragend');
    expect(s.shielded()).toBe(false);
  });

  it('drops the shield on drop', () => {
    const s = setup();
    s.fire(s.outside, 'dragstart');
    s.fire(document.body, 'drop');
    expect(s.shielded()).toBe(false);
  });

  it('leaves a drag that starts inside a screen to the screen', () => {
    const s = setup();
    s.fire(s.view.item('a').querySelector('span')!, 'dragstart');
    expect(s.shielded()).toBe(false);
  });

  it('never stays up: a press or a buttonless move after a lost dragend drops it', () => {
    const s = setup();
    s.fire(s.outside, 'dragstart');
    // The source left the document mid-drag: no dragend. A held-button move is still a drag.
    s.outside.remove();
    s.fire(document.body, 'pointermove', { buttons: 1 });
    expect(s.shielded()).toBe(true);
    s.fire(document.body, 'pointermove', { buttons: 0 });
    expect(s.shielded()).toBe(false);
    s.fire(document.body, 'dragstart');
    expect(s.shielded()).toBe(true);
    s.fire(document.body, 'pointerdown');
    expect(s.shielded()).toBe(false);
  });

  it('keeps the shield up while the bridge reports a drag', () => {
    const s = setup();
    s.view.rerenderWith({ dragging: true });
    s.fire(document.body, 'pointerdown');
    expect(s.shielded()).toBe(true);
  });
});

describe('TraceTab: a frame shown during a drag keeps its input', () => {
  /** dockview-core 7.0.2 dom.js disableIframePointEvents: snapshot inline values, restore. */
  function snapshotFrames() {
    const frames = [...document.querySelectorAll<HTMLIFrameElement>('iframe')];
    const original = new Map(frames.map((frame) => [frame, frame.style.pointerEvents]));
    for (const frame of frames) frame.style.pointerEvents = 'none';
    return {
      release: () => {
        for (const frame of frames) frame.style.pointerEvents = original.get(frame) ?? 'auto';
      },
    };
  }

  function Tabs({ showing }: { showing: string }) {
    return (
      <DockOverlay dragging={false}>
        {['a', 'b'].map((key) => (
          <DockOverlayItem key={key} api={null} tileKey={key}>
            <TraceTab
              tabKey={key}
              mode="dark"
              showing={showing === key}
              path="trace/"
              query=""
              onQuery={() => {}}
            />
          </DockOverlayItem>
        ))}
      </DockOverlay>
    );
  }

  it('writes no inline pointer-events on a hidden frame', () => {
    render(<Tabs showing="a" />);
    const hidden = document.querySelector<HTMLIFrameElement>('iframe[data-tab-key="b"]')!;
    expect(hidden.style.visibility).toBe('hidden');
    expect(hidden.style.pointerEvents).toBe('');
  });

  it('a tab switched to mid-drag takes pointer input once dockview releases its snapshot', () => {
    const view = render(<Tabs showing="a" />);
    const drag = snapshotFrames();
    view.rerender(<Tabs showing="b" />);
    drag.release();
    for (const key of ['a', 'b']) {
      const frame = document.querySelector<HTMLIFrameElement>(`iframe[data-tab-key="${key}"]`)!;
      expect(frame.style.pointerEvents).not.toBe('none');
    }
    const shown = document.querySelector<HTMLIFrameElement>('iframe[data-tab-key="b"]')!;
    expect(shown.style.visibility).not.toBe('hidden');
    expect(shown.getAttribute('tabindex')).toBeNull();
    expect(shown.dataset.visible).toBe('true');
  });
});

// ---------------------------------------------------------------------------------------------
// The stylesheet, read from disk: vitest blanks `.css` imports, `?raw` included.

const require = createRequire(import.meta.url);
const stripComments = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '');
const css = stripComments(readFileSync(require.resolve('./dock.css'), 'utf8'));

const FORBIDDEN = [
  'z-index',
  'transform',
  'will-change',
  'contain',
  'filter',
  'perspective',
  'backdrop-filter',
  'isolation',
];

const rules = css
  .split('}')
  .map((rule) => rule.split('{'))
  .filter(([selector]) => selector!.trim() !== '')
  .map(([selector, body = '']) => ({
    selector: selector!.trim(),
    declarations: [...body.matchAll(/([\w-]+)\s*:\s*([^;]+);/g)].map((found) => ({
      property: found[1]!,
      value: found[2]!.trim(),
    })),
  }));

describe('dock.css: the no-stacking-context safety contract', () => {
  it('declares none of the stacking or containing-block properties', () => {
    const declared = rules.flatMap((rule) => rule.declarations.map((d) => d.property));
    for (const property of FORBIDDEN) expect(declared).not.toContain(property);
    const atStart = new RegExp(`(?:^|[;{\\s])(?:${FORBIDDEN.join('|')})\\s*:`);
    expect(css).not.toMatch(atStart);
  });

  it('parses every declaration (the forbidden check cannot be dodged by syntax)', () => {
    const counted = rules.reduce((n, rule) => n + rule.declarations.length, 0);
    expect(counted).toBe((css.match(/:[^;{}]*;/g) ?? []).length);
  });

  it('shields every overlay element under the dragging class by rule', () => {
    const shield = rules.find((rule) => rule.selector.includes(`.${OVERLAY_DRAGGING_CLASS}`));
    expect(shield?.selector).toBe(`.${OVERLAY_DRAGGING_CLASS} .${OVERLAY_ITEM_CLASS}`);
    expect(shield?.declarations).toContainEqual({ property: 'pointer-events', value: 'none' });
  });

  it("shields an item's descendants over their inline pointer-events while dragging", () => {
    const deep = rules.find(
      (rule) => rule.selector === `.${OVERLAY_DRAGGING_CLASS} .${OVERLAY_ITEM_CLASS} *`
    );
    expect(deep?.declarations).toContainEqual({
      property: 'pointer-events',
      value: 'none !important',
    });
  });

  it('gives items overflow hidden and lets the layer pass clicks to bars and sashes', () => {
    const item = rules.find((rule) => rule.selector === `.${OVERLAY_ITEM_CLASS}`);
    expect(item?.declarations).toContainEqual({ property: 'overflow', value: 'hidden' });
    expect(item?.declarations).toContainEqual({ property: 'pointer-events', value: 'auto' });
    const layer = rules.find((rule) => rule.selector === `.${OVERLAY_CLASS}`);
    expect(layer?.declarations).toContainEqual({ property: 'pointer-events', value: 'none' });
  });

  it('touches no dockview element', () => {
    expect(css).not.toMatch(/\.dv-/);
  });
});

// ---------------------------------------------------------------------------------------------
// The split-layout print rule (index.css @media print). jsdom applies no print
// media, so the rule is checked as text: a [data-printing] tile takes the focused tile's place,
// winning over the focused-only rules by specificity (every rule there is !important).

describe('index.css: print prefers the [data-printing] tile over the focused one', () => {
  const indexCss = stripComments(readFileSync(require.resolve('../../index.css'), 'utf8'));
  const printBlock = (() => {
    const start = indexCss.indexOf('@media print');
    expect(start).toBeGreaterThanOrEqual(0);
    // The block's own closing brace: the first '}' at nesting depth zero.
    let depth = 0;
    for (let i = indexCss.indexOf('{', start); i < indexCss.length; i++) {
      if (indexCss[i] === '{') depth++;
      if (indexCss[i] === '}' && --depth === 0) return indexCss.slice(start, i);
    }
    throw new Error('unterminated @media print');
  })();
  const printRules = printBlock
    .slice(printBlock.indexOf('{') + 1)
    .split('}')
    .map((rule) => rule.split('{'))
    .filter(([selectors]) => selectors!.trim() !== '')
    .map(([selectors, body = '']) => ({
      selectors: selectors!.split(/,(?![^(]*\))/).map((s) => s.trim().replace(/\s+/g, ' ')),
      body,
    }));
  const item = `.${OVERLAY_ITEM_CLASS}`;
  const declares = (body: string, declaration: RegExp) => declaration.test(body);
  /** Classes and attribute selectors (also inside :not()/:has()); no ids or elements here. */
  const specificity = (selector: string) =>
    (selector.match(/\.[\w-]+/g) ?? []).length + (selector.match(/\[/g) ?? []).length;
  const ruleWith = (selector: string) =>
    printRules.find((rule) => rule.selectors.includes(selector));

  const hideUnfocused = `${item}:not([data-focused='true'])`;
  const hideUnmarked = `.${OVERLAY_CLASS}:has(> ${item}[data-printing='true']) > ${item}:not([data-printing='true'])`;
  const showMarked = `.${OVERLAY_CLASS} > ${item}[data-printing='true']`;
  const showFocused = `${item}[data-focused='true']`;

  it('keeps the focused-only rules for a print that marks nothing', () => {
    expect(declares(ruleWith(hideUnfocused)!.body, /display:\s*none\s*!important/)).toBe(true);
    expect(declares(ruleWith(showFocused)!.body, /display:\s*block\s*!important/)).toBe(true);
  });

  it('hides every unmarked element, the focused one included, while a tile is marked', () => {
    const rule = ruleWith(hideUnmarked);
    expect(rule, hideUnmarked).toBeDefined();
    expect(declares(rule!.body, /display:\s*none\s*!important/)).toBe(true);
    // Alone in its rule: a browser without :has() drops only this selector's rule.
    expect(rule!.selectors).toEqual([hideUnmarked]);
    // It beats the focused element's display: block.
    expect(specificity(hideUnmarked)).toBeGreaterThan(specificity(showFocused));
  });

  it('gives the marked element the focused one`s display and flow reset, over the hide rule', () => {
    const displayed = printRules.filter((rule) => rule.selectors.includes(showFocused));
    expect(displayed.length).toBeGreaterThan(0);
    for (const rule of displayed) expect(rule.selectors).toContain(showMarked);
    const reset = displayed.map((rule) => rule.body).join(';');
    for (const declaration of [
      /display:\s*block\s*!important/,
      /position:\s*static\s*!important/,
      /inset:\s*auto\s*!important/,
      /width:\s*auto\s*!important/,
      /visibility:\s*visible\s*!important/,
      /overflow:\s*visible\s*!important/,
    ])
      expect(declares(reset, declaration), String(declaration)).toBe(true);
    // An unfocused marked element is not hidden by the focused-only rule.
    expect(specificity(showMarked)).toBeGreaterThan(specificity(hideUnfocused));
  });
});
