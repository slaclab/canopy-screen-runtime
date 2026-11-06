// Tile focus wiring. Pinned here: a press or a focus move inside an
// overlay panel root or a tile bar reports `focus(key)` without consuming the event, so the
// same click still reaches the control under the pointer; an event from outside the root's
// DOM subtree (a React portal such as the toast column) and an item that is not shown in a
// tile report nothing; a tool frame taking focus is found on window `blur`; Enter or
// ArrowDown on a bar moves keyboard focus into its panel root; an Escape nobody handled
// returns focus from a screen to its bar. Placement and tile focus are read from the
// layout holder (`tabPlacement`): a key shows iff it is its tile's showing tab, and is
// focused iff it shows in the holder's focused tile; a hidden tab reports no gesture.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';
import { DockOverlay, DockOverlayItem, OVERLAY_ITEM_CLASS } from './DockOverlay.js';
import { TileBar } from './TileBar.js';
import { tabPlacement, tilePanelId, tileTitleId } from './useTileFocus.js';
import type { Layout } from '@slaclab/canopy-dock-engine';
import type { TileRectApi } from './useTileRect.js';

const SCREEN = 'screen/sr/magnets?sector=01&kind=quad';
const OTHER = 'screen/sr/rf';
const TOOL = 'tool/trace';

/** An api in which no key has a tile: every item it places is marked `data-placed="false"`. */
function emptyApi(): TileRectApi {
  const event = () => ({ dispose() {} });
  return {
    getPanel: () => undefined,
    onDidLayoutChange: event,
    onDidActiveGroupChange: event,
    onDidActivePanelChange: event,
    onDidLayoutFromJSON: event,
  } as unknown as TileRectApi;
}

interface TileSpec {
  key: string;
  title?: string;
  content?: ReactNode;
  api?: TileRectApi | null;
}

function renderTiles(tiles: TileSpec[], onFocus: ((key: string) => void) | undefined) {
  const onRemove = vi.fn();
  const tree = (handler: ((key: string) => void) | undefined) => (
    <div>
      {tiles.map(({ key, title = key }) => (
        <TileBar
          key={key}
          panelKey={key}
          title={title}
          focused={false}
          multiTile
          documentFocused
          onRemove={onRemove}
          onFocus={handler}
        />
      ))}
      <DockOverlay dragging={false} onFocus={handler}>
        {tiles.map(({ key, content, api = null }) => (
          <DockOverlayItem key={key} api={api} tileKey={key}>
            {content}
          </DockOverlayItem>
        ))}
      </DockOverlay>
    </div>
  );
  const view = render(tree(onFocus));
  const find = (selector: string, attribute: 'tabKey' | 'panelKey', key: string) =>
    [...view.container.querySelectorAll<HTMLElement>(selector)].find(
      (el) => el.dataset[attribute] === key
    )!;
  return {
    ...view,
    onRemove,
    item: (key: string) => find(`.${OVERLAY_ITEM_CLASS}`, 'tabKey', key),
    bar: (key: string) => find('.canopy-tile-bar', 'panelKey', key),
    rerenderWith: (handler: ((key: string) => void) | undefined) => view.rerender(tree(handler)),
  };
}

function escape(target: Element): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('click-through: a press focuses its tile and still acts', () => {
  it('a press on a button inside a tile reports focus and still reaches the button', () => {
    const onFocus = vi.fn();
    const onClick = vi.fn();
    const onPointerDown = vi.fn();
    const view = renderTiles(
      [
        {
          key: SCREEN,
          content: (
            <button type="button" onClick={onClick} onPointerDown={onPointerDown}>
              write
            </button>
          ),
        },
        { key: OTHER },
      ],
      onFocus
    );
    const button = view.getByText('write');

    const pressed = fireEvent.pointerDown(button);
    expect(onFocus.mock.calls).toEqual([[SCREEN]]);
    // fireEvent returns false when a listener prevented the event.
    expect(pressed).toBe(true);
    expect(onPointerDown).toHaveBeenCalledTimes(1);

    const clicked = fireEvent.click(button);
    expect(clicked).toBe(true);
    expect(onClick).toHaveBeenCalledTimes(1);
    // The click itself is not a focus gesture: one report per press.
    expect(onFocus).toHaveBeenCalledTimes(1);
  });

  it('a press on a bar button reports focus although the bar stops it from bubbling', () => {
    const onFocus = vi.fn();
    const view = renderTiles([{ key: SCREEN }, { key: OTHER }], onFocus);
    const bar = view.bar(OTHER);
    const close = bar.querySelector('button')!;
    const above = vi.fn();
    view.container.addEventListener('pointerdown', above);

    expect(fireEvent.pointerDown(close)).toBe(true);
    expect(onFocus.mock.calls).toEqual([[OTHER]]);
    expect(above).not.toHaveBeenCalled();

    fireEvent.click(close);
    expect(view.onRemove).toHaveBeenCalledTimes(1);

    // The bar surface reports too, and that press does bubble on to dockview.
    fireEvent.pointerDown(bar);
    expect(onFocus.mock.calls).toEqual([[OTHER], [OTHER]]);
    expect(above).toHaveBeenCalledTimes(1);
  });

  it('a focus move into a tile or a bar reports focus', () => {
    const onFocus = vi.fn();
    const view = renderTiles(
      [{ key: SCREEN, content: <input aria-label="setpoint" /> }, { key: OTHER }],
      onFocus
    );
    act(() => view.getByLabelText('setpoint').focus());
    expect(onFocus.mock.calls).toEqual([[SCREEN]]);
    act(() => view.bar(OTHER).focus());
    expect(onFocus.mock.calls).toEqual([[SCREEN], [OTHER]]);
  });

  it('follows a replaced handler without re-binding, and tolerates none', () => {
    const first = vi.fn();
    const second = vi.fn();
    const view = renderTiles([{ key: SCREEN, content: <button type="button">go</button> }], first);
    view.rerenderWith(second);
    fireEvent.pointerDown(view.getByText('go'));
    expect(first).not.toHaveBeenCalled();
    expect(second.mock.calls).toEqual([[SCREEN]]);
    view.rerenderWith(undefined);
    expect(fireEvent.pointerDown(view.getByText('go'))).toBe(true);
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe('events that are not in the tile', () => {
  it('closing a toast portalled out of a screen reports nothing', () => {
    const onFocus = vi.fn();
    const onClose = vi.fn();
    const column = document.createElement('div');
    document.body.appendChild(column);
    const view = renderTiles(
      [
        {
          key: SCREEN,
          content: createPortal(
            <button type="button" onClick={onClose}>
              close toast
            </button>,
            column
          ),
        },
      ],
      onFocus
    );
    const close = column.querySelector('button')!;
    expect(view.item(SCREEN).contains(close)).toBe(false);

    fireEvent.pointerDown(close);
    act(() => close.focus());
    fireEvent.click(close);

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onFocus).not.toHaveBeenCalled();
  });

  it('a vacated screen reports nothing, from its own subtree or from its toast', () => {
    const onFocus = vi.fn();
    const column = document.createElement('div');
    document.body.appendChild(column);
    const view = renderTiles(
      [
        {
          key: SCREEN,
          api: emptyApi(),
          content: (
            <>
              <button type="button">inside</button>
              {createPortal(<button type="button">close toast</button>, column)}
            </>
          ),
        },
      ],
      onFocus
    );
    expect(view.item(SCREEN).dataset.placed).toBe('false');

    fireEvent.pointerDown(view.getByText('inside'));
    act(() => view.getByText('inside').focus());
    fireEvent.pointerDown(column.querySelector('button')!);
    fireEvent.click(column.querySelector('button')!);
    expect(onFocus).not.toHaveBeenCalled();

    // Its bar cannot move focus into it either.
    const bar = view.bar(SCREEN);
    onFocus.mockClear();
    act(() => bar.focus());
    fireEvent.keyDown(bar, { key: 'Enter' });
    expect(document.activeElement).toBe(bar);
  });
});

describe('tool frames', () => {
  it('window blur with a frame of a tile as the active element reports that tile', () => {
    const onFocus = vi.fn();
    const view = renderTiles(
      [{ key: SCREEN }, { key: TOOL, content: <iframe title="Data browser" /> }],
      onFocus
    );
    const frame = view.item(TOOL).querySelector('iframe')!;
    vi.spyOn(document, 'activeElement', 'get').mockReturnValue(frame);
    act(() => {
      window.dispatchEvent(new Event('blur'));
    });
    expect(onFocus.mock.calls).toEqual([[TOOL]]);
  });

  it('looks again after the blur when the frame becomes active late', () => {
    vi.useFakeTimers();
    const onFocus = vi.fn();
    const view = renderTiles([{ key: TOOL, content: <iframe title="Data browser" /> }], onFocus);
    const frame = view.item(TOOL).querySelector('iframe')!;
    window.dispatchEvent(new Event('blur'));
    expect(onFocus).not.toHaveBeenCalled();
    vi.spyOn(document, 'activeElement', 'get').mockReturnValue(frame);
    vi.runAllTimers();
    expect(onFocus.mock.calls).toEqual([[TOOL]]);
  });

  it('ignores a blur to another window, to a frame outside the dock, and to an unplaced frame', () => {
    vi.useFakeTimers();
    const onFocus = vi.fn();
    const view = renderTiles(
      [{ key: TOOL, api: emptyApi(), content: <iframe title="Data browser" /> }],
      onFocus
    );
    window.dispatchEvent(new Event('blur'));
    vi.runAllTimers();

    const outside = document.createElement('iframe');
    document.body.appendChild(outside);
    const active = vi.spyOn(document, 'activeElement', 'get').mockReturnValue(outside);
    window.dispatchEvent(new Event('blur'));
    vi.runAllTimers();

    active.mockReturnValue(view.item(TOOL).querySelector('iframe')!);
    window.dispatchEvent(new Event('blur'));
    vi.runAllTimers();
    expect(onFocus).not.toHaveBeenCalled();
  });
});

describe('keyboard', () => {
  it('names the panel root after the bar title and lets the bar control it', () => {
    const view = renderTiles(
      [
        { key: SCREEN, title: 'Magnets' },
        { key: OTHER, title: 'RF' },
      ],
      vi.fn()
    );
    const item = view.item(SCREEN);
    const bar = view.bar(SCREEN);
    expect(item.id).toBe(tilePanelId(SCREEN));
    expect(item.id).toMatch(/^[A-Za-z][A-Za-z0-9_-]*$/);
    expect(item.getAttribute('tabindex')).toBe('-1');
    // The bar is a tablist: the bar's tab of the key controls the panel root.
    const tab = [...bar.querySelectorAll<HTMLElement>('[role="tab"]')].find(
      (el) => el.dataset.tabKey === SCREEN
    )!;
    expect(tab.getAttribute('aria-controls')).toBe(item.id);
    expect(document.getElementById(tab.getAttribute('aria-controls')!)).toBe(item);
    const label = document.getElementById(item.getAttribute('aria-labelledby')!)!;
    expect(label.id).toBe(tileTitleId(SCREEN));
    expect(bar.contains(label)).toBe(true);
    expect(label.textContent).toBe('Magnets');
    // Distinct keys never share an id.
    expect(view.item(OTHER).id).not.toBe(item.id);
    expect(tilePanelId('a/b')).not.toBe(tilePanelId('a_2f_b'.replace('_2f_', '?')));
    // The bars stay the tab stops; the panel roots are reachable from script only.
    expect(bar.getAttribute('tabindex')).toBe('0');
  });

  it.each(['Enter', 'ArrowDown'])('%s on a bar moves focus into its panel root', (key) => {
    const view = renderTiles(
      [{ key: SCREEN, content: <button type="button">write</button> }, { key: OTHER }],
      vi.fn()
    );
    const bar = view.bar(SCREEN);
    act(() => bar.focus());
    fireEvent.keyDown(bar, { key });
    expect(document.activeElement).toBe(view.item(SCREEN));
  });

  it('for a tool tile the root is its frame', () => {
    const view = renderTiles([{ key: TOOL, content: <iframe title="Data browser" /> }], vi.fn());
    const frame = view.item(TOOL).querySelector('iframe')!;
    const focus = vi.spyOn(frame, 'focus');
    const bar = view.bar(TOOL);
    act(() => bar.focus());
    // A handled ArrowDown is prevented, so the page does not scroll under the dock.
    expect(fireEvent.keyDown(bar, { key: 'ArrowDown' })).toBe(false);
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it('leaves the keys alone on a bar button and with a modifier held', () => {
    const view = renderTiles([{ key: SCREEN }], vi.fn());
    const bar = view.bar(SCREEN);
    const close = bar.querySelector('button')!;
    act(() => close.focus());
    fireEvent.keyDown(close, { key: 'Enter' });
    expect(document.activeElement).toBe(close);
    act(() => bar.focus());
    fireEvent.keyDown(bar, { key: 'ArrowDown', shiftKey: true });
    fireEvent.keyDown(bar, { key: 'Enter', ctrlKey: true });
    expect(document.activeElement).toBe(bar);
  });

  it('an unhandled Escape returns focus from a screen to its bar', () => {
    const view = renderTiles(
      [{ key: SCREEN, content: <button type="button">write</button> }, { key: OTHER }],
      vi.fn()
    );
    const button = view.getByText('write');
    act(() => button.focus());
    const event = escape(button);
    expect(document.activeElement).toBe(view.bar(SCREEN));
    expect(event.defaultPrevented).toBe(false);

    // From the panel root itself as well.
    act(() => view.item(SCREEN).focus());
    escape(view.item(SCREEN));
    expect(document.activeElement).toBe(view.bar(SCREEN));
  });

  it('an Escape a dialog handled stays put', () => {
    const view = renderTiles(
      [{ key: SCREEN, content: <button type="button">write</button> }],
      vi.fn()
    );
    const button = view.getByText('write');
    // Carbon's modal closes on a document-level keydown listener and prevents the event.
    const handled = (event: KeyboardEvent) => {
      if (event.key === 'Escape') event.preventDefault();
    };
    document.addEventListener('keydown', handled);
    try {
      act(() => button.focus());
      escape(button);
      expect(document.activeElement).toBe(button);
    } finally {
      document.removeEventListener('keydown', handled);
    }
  });

  it('an Escape a widget handled stays put', () => {
    const view = renderTiles(
      [
        {
          key: SCREEN,
          content: (
            <>
              <input aria-label="setpoint" />
              <button type="button" aria-expanded="true">
                menu
              </button>
              <button type="button">stopper</button>
            </>
          ),
        },
      ],
      vi.fn()
    );
    for (const control of [
      view.getByLabelText('setpoint'),
      view.getByText('menu'),
      view.getByText('stopper'),
    ]) {
      act(() => control.focus());
      // A widget that keeps the key to itself: the event never arrives at the window.
      if (control.textContent === 'stopper') {
        control.addEventListener('keydown', (event) => event.stopPropagation());
      }
      escape(control);
      expect(document.activeElement).toBe(control);
    }
  });

  it('an Escape under an open dialog of the tile stays put', () => {
    const view = renderTiles(
      [
        {
          key: SCREEN,
          content: (
            <>
              <button type="button">write</button>
              <div className="cds--modal is-visible" />
            </>
          ),
        },
      ],
      vi.fn()
    );
    const button = view.getByText('write');
    act(() => button.focus());
    escape(button);
    expect(document.activeElement).toBe(button);
  });

  it('an Escape outside every tile moves nothing', () => {
    const view = renderTiles([{ key: SCREEN }], vi.fn());
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();
    escape(outside);
    expect(document.activeElement).toBe(outside);
    // On the bar itself: focus is already there.
    act(() => view.bar(SCREEN).focus());
    escape(view.bar(SCREEN));
    expect(document.activeElement).toBe(view.bar(SCREEN));
  });
});

describe('listeners', () => {
  it('removes every window and element listener it added', () => {
    const windowAdd = vi.spyOn(window, 'addEventListener');
    const windowRemove = vi.spyOn(window, 'removeEventListener');
    const elementAdd = vi.spyOn(HTMLElement.prototype, 'addEventListener');
    const elementRemove = vi.spyOn(HTMLElement.prototype, 'removeEventListener');
    const view = renderTiles([{ key: SCREEN }, { key: OTHER }], vi.fn());

    const count = (spy: { mock: { calls: unknown[][] } }, type: string) =>
      spy.mock.calls.filter(([name]) => name === type).length;
    // Only the tile parts: React binds capture listeners of its own on its root container.
    const captured = (spy: { mock: { calls: unknown[][]; contexts: unknown[] } }, type: string) =>
      spy.mock.calls.filter(
        ([name, , options], index) =>
          name === type &&
          options === true &&
          (spy.mock.contexts[index] as HTMLElement).matches(
            `.${OVERLAY_ITEM_CLASS}, .canopy-tile-bar`
          )
      ).length;

    // One blur and one keydown listener for the whole layer, however many tiles it holds.
    expect(count(windowAdd, 'blur')).toBe(1);
    expect(count(windowAdd, 'keydown')).toBe(1);
    // Two items and two bars, each with a capture-phase pair.
    expect(captured(elementAdd, 'pointerdown')).toBe(4);
    expect(captured(elementAdd, 'focusin')).toBe(4);

    view.unmount();
    expect(count(windowRemove, 'blur')).toBe(1);
    expect(count(windowRemove, 'keydown')).toBe(1);
    expect(captured(elementRemove, 'pointerdown')).toBe(4);
    expect(captured(elementRemove, 'focusin')).toBe(4);
  });
});

describe('tabPlacement: tile focus follows the layout holder', () => {
  const layout: Layout = {
    split: 'row',
    items: [
      { tile: 't1', tabs: [SCREEN, OTHER], showing: OTHER },
      { tile: 't2', tabs: [TOOL], showing: TOOL },
    ],
  };

  it('shows only the showing tab of each tile', () => {
    expect(tabPlacement(layout, 't2', OTHER)).toEqual({
      tile: 't1',
      showing: true,
      focused: false,
    });
    expect(tabPlacement(layout, 't2', SCREEN)).toEqual({
      tile: 't1',
      showing: false,
      focused: false,
    });
  });

  it('focuses the showing tab of the focused tile, never a hidden tab in it', () => {
    expect(tabPlacement(layout, 't1', OTHER).focused).toBe(true);
    expect(tabPlacement(layout, 't1', SCREEN).focused).toBe(false);
    expect(tabPlacement(layout, 't1', TOOL).focused).toBe(false);
    expect(tabPlacement(layout, 't2', TOOL).focused).toBe(true);
  });

  it('places nothing for a key with no tile, an empty dock or no focused tile', () => {
    expect(tabPlacement(layout, 't1', 'screen/none')).toEqual({
      tile: null,
      showing: false,
      focused: false,
    });
    expect(tabPlacement(null, null, SCREEN)).toEqual({
      tile: null,
      showing: false,
      focused: false,
    });
    expect(tabPlacement(layout, null, OTHER)).toEqual({
      tile: 't1',
      showing: true,
      focused: false,
    });
  });

  it('reads a root tile', () => {
    const root: Layout = { tile: 'only', tabs: [SCREEN], showing: SCREEN };
    expect(tabPlacement(root, 'only', SCREEN)).toEqual({
      tile: 'only',
      showing: true,
      focused: true,
    });
  });

  it('a press in a hidden tab reports nothing; the same press after it shows reports it', () => {
    const onFocus = vi.fn();
    const hidden = { getPanel: () => undefined };
    const shown = (key: string) => {
      const group = document.createElement('div');
      const content = document.createElement('div');
      content.className = 'dv-content-container';
      group.appendChild(content);
      const panel: { group?: unknown } = {};
      panel.group = { element: group, activePanel: panel };
      return { getPanel: (id: string) => (id === key ? panel : undefined) };
    };
    const api = (base: object) => ({ ...emptyApi(), ...base }) as unknown as TileRectApi;
    const view = render(
      <DockOverlay dragging={false} onFocus={onFocus}>
        <DockOverlayItem api={api(hidden)} tileKey={SCREEN}>
          <button type="button">in screen</button>
        </DockOverlayItem>
      </DockOverlay>
    );
    const button = view.getByText('in screen');
    fireEvent.pointerDown(button);
    expect(onFocus).not.toHaveBeenCalled();
    view.rerender(
      <DockOverlay dragging={false} onFocus={onFocus}>
        <DockOverlayItem api={api(shown(SCREEN))} tileKey={SCREEN}>
          <button type="button">in screen</button>
        </DockOverlayItem>
      </DockOverlay>
    );
    fireEvent.pointerDown(view.getByText('in screen'));
    expect(onFocus).toHaveBeenCalledWith(SCREEN);
  });
});
