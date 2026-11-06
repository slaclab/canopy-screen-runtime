// ScreenHeader: the zoom buttons take their look from canopy-shell's
// `canopy-btn` class, and ScreenHeader.css carries no button recipe of its own.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { useReducer, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ScreenHeader } from './ScreenHeader.js';
import { tileFloor, tileStep } from './workspace/dock/tileHeaderFit.js';
import { TILE_HEADER_FIT, TileHeaderContext, tileHeaderCaps } from './workspace/dock/TileBar.js';
import type { ScreenHistory, ScreenZoom } from './ScreenHeader.js';
import type { ScreenActionContext } from './screenActions/types.js';
import { useKeyedZoom, ZoomStore } from './ZoomContext.js';
import { stepZoom } from './zoom.js';
import { EMPTY_TABS, tabsReducer } from './workspace/tabs.js';

// Same in-memory localStorage shim as App.test.tsx: Node >= 25 can shadow
// jsdom's with an unusable global, and canopy-shell's themeStore reads
// localStorage at import time.
vi.hoisted(() => {
  let usable = false;
  try {
    usable = typeof globalThis.localStorage?.getItem === 'function';
  } catch {
    // Treat a throwing getter as unusable.
  }
  if (usable) return;
  const store = new Map<string, string>();
  const memory = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, String(value)),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  };
  for (const target of [globalThis, globalThis.window]) {
    if (target)
      Object.defineProperty(target, 'localStorage', { value: memory, configurable: true });
  }
});

// Read from disk: vitest blanks `.css` imports, `?raw` included.
const css = readFileSync(createRequire(import.meta.url).resolve('./ScreenHeader.css'), 'utf8');

/** The selectors of every rule in `text`, comments removed. */
function selectors(text: string): string[] {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('}')
    .map((rule) => rule.split('{')[0].trim())
    .filter((selector) => selector !== '');
}

/** The declarations of the rule whose selector is exactly `selector`. */
function declarations(text: string, selector: string): string[] {
  const bare = text.replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = bare.split('}').find((r) => r.split('{')[0].trim() === selector);
  if (rule === undefined) return [];
  return rule
    .split('{')[1]
    .split(';')
    .map((d) => d.trim())
    .filter((d) => d !== '');
}

function zoom(overrides: Partial<ScreenZoom> = {}): ScreenZoom {
  return {
    scale: 1,
    fit: false,
    onZoomOut: vi.fn(),
    onZoomIn: vi.fn(),
    onFit: vi.fn(),
    onActualSize: vi.fn(),
    ...overrides,
  };
}

function history(overrides: Partial<ScreenHistory> = {}): ScreenHistory {
  return {
    back: { enabled: true, onClick: vi.fn() },
    forward: { enabled: false, onClick: vi.fn() },
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ScreenHeader bar', () => {
  it('stays the dark label-only bar in both themes, without a skip link', () => {
    for (const mode of ['light', 'dark']) {
      document.documentElement.dataset.theme = mode;
      render(<ScreenHeader title="GTL" />);
      const header = screen.getByRole('banner');
      expect(header.closest('.cds--g100')).not.toBeNull();
      expect(header.classList.contains('canopy-header--brand')).toBe(false);
      expect(header.querySelector('.cds--header__name--prefix')).toBeNull();
      expect(header.querySelector('.cds--header__name')?.textContent).toBe('SCREEN');
      expect(header.querySelector('.cds--skip-to-content')).toBeNull();
      cleanup();
    }
    delete document.documentElement.dataset.theme;
  });
});

describe('ScreenHeader zoom buttons', () => {
  it('carry canopy-btn beside screen-header__button', () => {
    render(<ScreenHeader title="GTL" zoom={zoom()} />);
    const buttons = screen.getByRole('group', { name: 'Zoom' }).querySelectorAll('button');
    expect(buttons).toHaveLength(4);
    for (const button of buttons) {
      expect(button.classList.contains('canopy-btn')).toBe(true);
      expect(button.classList.contains('screen-header__button')).toBe(true);
    }
  });

  it('keep the text modifier and the pressed state of Fit', () => {
    render(<ScreenHeader title="GTL" zoom={zoom({ fit: true })} />);
    const fit = screen.getByRole('button', { name: 'Fit' });
    expect(fit.classList.contains('screen-header__button--text')).toBe(true);
    expect(fit.classList.contains('canopy-btn')).toBe(true);
    expect(fit.getAttribute('aria-pressed')).toBe('true');
    expect(
      screen.getByRole('button', { name: 'Actual size' }).classList.contains('canopy-btn')
    ).toBe(true);
  });

  it('are absent without a zoom', () => {
    render(<ScreenHeader title="GTL" />);
    expect(screen.queryByRole('group', { name: 'Zoom' })).toBeNull();
    expect(document.querySelector('.screen-header__button')).toBeNull();
  });
});

describe('ScreenHeader history buttons', () => {
  it('are absent without a history (tool tabs, the /s/ route)', () => {
    render(<ScreenHeader title="GTL" zoom={zoom()} />);
    expect(screen.queryByRole('group', { name: 'History' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Forward' })).toBeNull();
  });

  it('show ◀ then ▶ as canopy-btn buttons', () => {
    render(<ScreenHeader title="GTL" history={history()} />);
    const buttons = screen.getByRole('group', { name: 'History' }).querySelectorAll('button');
    expect([...buttons].map((b) => b.getAttribute('aria-label'))).toEqual(['Back', 'Forward']);
    expect([...buttons].map((b) => b.textContent)).toEqual(['◀', '▶']);
    for (const button of buttons) {
      expect(button.classList.contains('canopy-btn')).toBe(true);
      expect(button.classList.contains('screen-header__button')).toBe(true);
    }
  });

  it('disable a direction whose stack is empty and enable the other', () => {
    render(<ScreenHeader title="GTL" history={history()} />);
    expect((screen.getByRole('button', { name: 'Back' }) as HTMLButtonElement).disabled).toBe(
      false
    );
    expect((screen.getByRole('button', { name: 'Forward' }) as HTMLButtonElement).disabled).toBe(
      true
    );
  });

  it('dispatch the click of an enabled button and ignore a disabled one', () => {
    const h = history();
    render(<ScreenHeader title="GTL" history={h} />);
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.click(screen.getByRole('button', { name: 'Forward' }));
    expect(h.back.onClick).toHaveBeenCalledTimes(1);
    expect(h.forward.onClick).not.toHaveBeenCalled();
  });

  it('title a target open elsewhere "Switch to <title>", else Back/Forward', () => {
    render(
      <ScreenHeader
        title="GTL"
        history={history({
          back: { enabled: true, switchTo: 'Booster RF', onClick: vi.fn() },
          forward: { enabled: true, onClick: vi.fn() },
        })}
      />
    );
    expect(screen.getByRole('button', { name: 'Back' }).getAttribute('title')).toBe(
      'Switch to Booster RF'
    );
    expect(screen.getByRole('button', { name: 'Forward' }).getAttribute('title')).toBe('Forward');
  });

  it('bind no Alt+Left/Right shortcut', () => {
    const h = history({ forward: { enabled: true, onClick: vi.fn() } });
    render(<ScreenHeader title="GTL" history={h} />);
    fireEvent.keyDown(window, { key: 'ArrowLeft', altKey: true });
    fireEvent.keyDown(window, { key: 'ArrowRight', altKey: true });
    fireEvent.keyDown(document.body, { key: 'ArrowLeft', altKey: true });
    expect(h.back.onClick).not.toHaveBeenCalled();
    expect(h.forward.onClick).not.toHaveBeenCalled();
  });
});

/**
 * One screen slot as the workspace wires it: the tabs reducer's history for
 * ◀ ▶ and the shared ZoomStore keyed by the slot's current screen.
 */
function SlotHarness({ store }: { store: ZoomStore }) {
  const [state, dispatch] = useReducer(
    tabsReducer,
    tabsReducer(EMPTY_TABS, { type: 'open', key: 'a/one', mode: 'append' })
  );
  const [next, setNext] = useState(0);
  const key = state.active ?? '';
  const { mode, scale: manual, setFit, setManual } = useKeyedZoom(store, key);
  const scale = mode === 'manual' ? manual : 1;
  const entry = state.history?.[key];
  return (
    <>
      <ScreenHeader
        title={key}
        zoom={{
          scale,
          fit: mode === 'fit',
          onZoomOut: () => setManual(stepZoom(scale, -1)),
          onZoomIn: () => setManual(stepZoom(scale, 1)),
          onFit: setFit,
          onActualSize: () => setManual(1),
        }}
        history={{
          back: {
            enabled: (entry?.back.length ?? 0) > 0,
            onClick: () => dispatch({ type: 'historyBack', key }),
          },
          forward: {
            enabled: (entry?.forward.length ?? 0) > 0,
            onClick: () => dispatch({ type: 'historyForward', key }),
          },
        }}
      />
      <button
        type="button"
        onClick={() => {
          setNext(next + 1);
          dispatch({ type: 'open', key: `a/two${next}`, mode: 'replace' });
        }}
      >
        replace
      </button>
    </>
  );
}

describe('ScreenHeader history in a slot', () => {
  it("◀ restores the old screen's own zoom", () => {
    const store = new ZoomStore('/');
    render(<SlotHarness store={store} />);
    const percent = () => screen.getByTestId('zoom-percent').textContent;
    const title = () => screen.getByTestId('screen-header-title').textContent;
    expect(screen.getByRole('button', { name: 'Back' })).toHaveProperty('disabled', true);
    // The operator zooms the first screen past 100%.
    fireEvent.click(screen.getByRole('button', { name: 'Actual size' }));
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    const zoomed = percent();
    expect(zoomed).not.toBe('100%');
    // A single click replaces it: the new screen opens at Fit.
    fireEvent.click(screen.getByRole('button', { name: 'replace' }));
    expect(title()).toBe('a/two0');
    expect(screen.getByRole('button', { name: 'Fit' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Forward' })).toHaveProperty('disabled', true);
    // ◀ brings the replaced screen back at the zoom it had.
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(title()).toBe('a/one');
    expect(percent()).toBe(zoomed);
    expect(screen.getByRole('button', { name: 'Fit' }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('button', { name: 'Back' })).toHaveProperty('disabled', true);
    // ▶ returns to the replacing screen, still at Fit.
    fireEvent.click(screen.getByRole('button', { name: 'Forward' }));
    expect(title()).toBe('a/two0');
    expect(screen.getByRole('button', { name: 'Fit' }).getAttribute('aria-pressed')).toBe('true');
  });
});

/** A header `header` px wide whose fixed parts are 100 px each. */
function stubWidths(header: number, part = 100) {
  // A real observer reports once on observe.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      private readonly callback: () => void;
      constructor(callback: () => void) {
        this.callback = callback;
      }
      observe() {
        this.callback();
      }
      unobserve() {}
      disconnect() {}
    }
  );
  vi.spyOn(Element.prototype, 'clientWidth', 'get').mockImplementation(function (this: Element) {
    return this.classList.contains('screen-header') ? header : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    return this.parentElement?.classList.contains('cds--header') ? part : 0;
  });
}

const actionCtx: ScreenActionContext = {
  screen: {
    category: 'drafts',
    id: 'e2e-panel',
    title: 'E2E Panel',
    macros: {},
    element: document.createElement('div'),
    documentUrl: 'http://localhost/screens/drafts/e2e-panel.screen.json',
  },
  zoom: { scale: 1, fit: false },
  link: 'http://localhost/s/drafts/e2e-panel',
};

describe('ScreenHeader layout', () => {
  it('puts ◀ ▶ beside the title block, not inside the shrinking one', () => {
    render(<ScreenHeader title="GTL" zoom={zoom()} history={history()} />);
    const group = screen.getByRole('group', { name: 'History' });
    const info = document.querySelector('.screen-header__info')!;
    expect(info.contains(group)).toBe(false);
    expect(group.parentElement).toBe(info.parentElement);
    expect(group.nextElementSibling).toBe(info);
  });

  it('keeps the history group and the zoom group from shrinking, and ellipsises the title', () => {
    expect(declarations(css, '.screen-header__history')).toContain('flex: none');
    expect(declarations(css, '.screen-header__zoom')).toContain('flex: none');
    const title = declarations(css, '.screen-header__title');
    expect(title).toContain('text-overflow: ellipsis');
    expect(title).toContain('white-space: nowrap');
    expect(title).toContain('overflow: hidden');
  });
});

describe('ScreenHeader in a narrow header', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows every control in the bar when they fit', () => {
    stubWidths(1200);
    render(<ScreenHeader title="GTL" zoom={zoom()} history={history()} actions={actionCtx} />);
    const bar = screen.getByTestId('screen-header');
    expect(bar.querySelector('.screen-header__zoom')).not.toBeNull();
    expect(bar.querySelector('[data-screen-action="print"]')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'More controls' })).toBeNull();
  });

  it('collapses the zoom group and the actions into one overflow menu below the fit width', () => {
    // ◀ ▶ + title room 214, label 150, zoom 150, actions 150: 375 fits none of the stages.
    stubWidths(375, 150);
    const z = zoom();
    render(<ScreenHeader title="GTL" zoom={z} history={history()} actions={actionCtx} />);
    const bar = screen.getByTestId('screen-header');
    // ◀ ▶ stay in the bar; zoom and actions leave it for the menu.
    expect(bar.querySelector('[aria-label="Back"]')).not.toBeNull();
    expect(bar.querySelector('[aria-label="Forward"]')).not.toBeNull();
    expect(bar.querySelector('.screen-header__zoom')).toBeNull();
    expect(bar.querySelector('[data-screen-action]')).toBeNull();
    const more = screen.getByRole('button', { name: 'More controls' });
    expect(bar.contains(more)).toBe(true);
    expect(more.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('group', { name: 'Zoom' })).toBeNull();

    fireEvent.click(more);
    expect(more.getAttribute('aria-expanded')).toBe('true');
    const menu = screen.getByRole('group', { name: 'Screen controls' });
    expect(more.getAttribute('aria-controls')).toBe(menu.id);
    expect(bar.contains(menu)).toBe(false);
    // The menu escapes the clipping tile bar and paints as the dark header does.
    expect(menu.closest('.cds--g100')).not.toBeNull();
    expect(menu.querySelector('[data-screen-action="print"]')).not.toBeNull();
    expect(menu.querySelector('[data-screen-action="copy-link"]')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(z.onZoomIn).toHaveBeenCalledTimes(1);
    // A zoom step keeps the menu open for the next one.
    expect(more.getAttribute('aria-expanded')).toBe('true');

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(more.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('group', { name: 'Screen controls' })).toBeNull();
  });

  it('moves the actions first and keeps the zoom group while it still fits', () => {
    // Label + ◀ ▶ + title room 264, zoom 100, actions 100: 420 fits all but the actions.
    stubWidths(420);
    render(<ScreenHeader title="GTL" zoom={zoom()} history={history()} actions={actionCtx} />);
    const bar = screen.getByTestId('screen-header');
    expect(bar.querySelector('.screen-header__zoom')).not.toBeNull();
    expect(bar.querySelector('[data-screen-action]')).toBeNull();
    expect(bar.classList.contains('screen-header--no-label')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'More controls' }));
    const menu = screen.getByRole('group', { name: 'Screen controls' });
    expect(menu.querySelector('[data-screen-action="print"]')).not.toBeNull();
    expect(menu.querySelector('.screen-header__zoom')).toBeNull();
    expect(screen.getAllByRole('group', { name: 'Zoom' })).toHaveLength(1);
  });

  it('then drops the SCREEN label before it collapses the zoom group', () => {
    // 330 fits ◀ ▶ + title room 164, zoom 100 and the menu button, not the label as well.
    stubWidths(330);
    render(<ScreenHeader title="GTL" zoom={zoom()} history={history()} actions={actionCtx} />);
    const bar = screen.getByTestId('screen-header');
    expect(bar.classList.contains('screen-header--no-label')).toBe(true);
    expect(bar.querySelector('.screen-header__zoom')).not.toBeNull();
    expect(bar.querySelector('[data-screen-action]')).toBeNull();
    expect(declarations(css, '.screen-header--no-label .canopy-header__name')).toContain(
      'display: none'
    );
  });

  it('closes the overflow menu on a press outside it', () => {
    stubWidths(250, 150);
    render(<ScreenHeader title="GTL" zoom={zoom()} actions={actionCtx} />);
    const more = screen.getByRole('button', { name: 'More controls' });
    fireEvent.click(more);
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Zoom out' }));
    expect(more.getAttribute('aria-expanded')).toBe('true');
    fireEvent.pointerDown(document.body);
    expect(more.getAttribute('aria-expanded')).toBe('false');
  });

  it('keeps the full layout where ResizeObserver is missing', () => {
    vi.stubGlobal('ResizeObserver', undefined);
    render(<ScreenHeader title="GTL" zoom={zoom()} history={history()} actions={actionCtx} />);
    expect(screen.getByRole('group', { name: 'Zoom' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'More controls' })).toBeNull();
  });

  it('has nothing to collapse without zoom or actions', () => {
    stubWidths(200);
    render(<ScreenHeader title="GTL" history={history()} />);
    expect(screen.queryByRole('button', { name: 'More controls' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Back' })).toBeDefined();
  });
});

// Inside a tile bar (TileHeaderContext, which TileActions provides) the header fits the lane its
// tile leaves it, in this order: the path, the title, the zoom group into "41 % ▾", the actions
// into "⋯", then ◀ ▶. The standalone cases above stay as they are.
describe('ScreenHeader in a tile bar (the header fits its tile)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // The parts as a real tile lays them out: ◀ ▶ 64, title 120, path 150, zoom group 210,
  // actions 288 (six icons). The floor is ◀ ▶ + the zoom button + "⋯": 64 + 72 + 32 = 168.
  const PARTS = { history: 64, title: 120, detail: 150, zoom: 210, actions: 288 };
  const HAS = { detail: true, zoom: true, actions: true };
  const LONE_TAB = 170; // the grip and one "Facility overview" tab

  /** Stubs the lane at `lane` px and every part at its PARTS width. */
  function stubTile(lane: number) {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        private readonly callback: () => void;
        constructor(callback: () => void) {
          this.callback = callback;
        }
        observe() {
          this.callback();
        }
        unobserve() {}
        disconnect() {}
      }
    );
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockImplementation(function (this: Element) {
      return this.classList.contains('screen-header') ? lane : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (
      this: HTMLElement
    ) {
      const has = (name: string) => this.classList.contains(name);
      if (has('screen-header__history')) return PARTS.history;
      if (has('screen-header__title-text')) return PARTS.title;
      if (has('screen-header__detail')) return PARTS.detail;
      if (has('screen-header__zoom')) return PARTS.zoom;
      if (has('cds--header__global')) return PARTS.actions;
      return 0;
    });
  }

  function renderInTile(lane: number, reportNeed?: (px: number) => void) {
    stubTile(lane);
    const z = zoom();
    const h = history();
    render(
      <TileHeaderContext.Provider value={{ ...TILE_HEADER_FIT, reportNeed }}>
        <ScreenHeader
          title="Facility overview"
          detail="library/facility/overview"
          zoom={z}
          history={h}
          actions={actionCtx}
        />
      </TileHeaderContext.Provider>
    );
    return { bar: screen.getByTestId('screen-header'), z, h };
  }

  const shows = (bar: HTMLElement) => ({
    step: bar.dataset.step,
    path: bar.querySelector('.screen-header__detail') !== null,
    title: bar.querySelector('.screen-header__title') !== null,
    zoom: bar.querySelector('.screen-header__zoom') !== null,
    zoomButton: bar.querySelector('.screen-header__zoom-menu') !== null,
    actions: bar.querySelector('[data-screen-action]') !== null,
    history: bar.querySelector('[aria-label="Back"]') !== null,
    more: bar.querySelector('.screen-header__more') !== null,
  });

  it.each([
    // tile px, the step its lane reaches
    [1600, 0],
    [800, 2],
    [500, 4],
    [350, 4],
  ])('a %i px tile with one tab: step %i', (tile, step) => {
    const floor = tileFloor(PARTS, TILE_HEADER_FIT, HAS);
    const lane = tileHeaderCaps(tile, LONE_TAB, 0, floor, true).actions;
    expect(tileStep(lane, PARTS, TILE_HEADER_FIT, HAS)).toBe(step);
    // The tab keeps its whole name at every one of these widths.
    expect(tile - lane).toBe(LONE_TAB);
  });

  it('collapses in order: path, title, zoom group, actions, then ◀ ▶', () => {
    const order = [900, 700, 600, 450, 300, 120, 90].map((lane) => {
      const { bar } = renderInTile(lane);
      const seen = shows(bar);
      cleanup();
      vi.restoreAllMocks();
      return seen;
    });
    expect(order.map((s) => s.step)).toEqual(['0', '1', '2', '3', '4', '5', '6']);
    expect(order.map((s) => s.path)).toEqual([true, false, false, false, false, false, false]);
    expect(order.map((s) => s.title)).toEqual([true, true, false, false, false, false, false]);
    expect(order.map((s) => s.zoom)).toEqual([true, true, true, false, false, false, false]);
    expect(order.map((s) => s.zoomButton)).toEqual([false, false, false, true, true, true, false]);
    expect(order.map((s) => s.actions)).toEqual([true, true, true, true, false, false, false]);
    expect(order.map((s) => s.history)).toEqual([true, true, true, true, true, false, false]);
    expect(order.map((s) => s.more)).toEqual([false, false, false, false, true, true, true]);
  });

  it('never shows the SCREEN label in a tile', () => {
    const { bar } = renderInTile(2000);
    expect(bar.classList.contains('screen-header--no-label')).toBe(true);
    expect(bar.classList.contains('screen-header--tile')).toBe(true);
  });

  it('puts Fit, 1:1 and the zoom steps behind the "41 % ▾" button', () => {
    renderInTile(450);
    cleanup();
    stubTile(450);
    const z = zoom({ scale: 0.41 });
    render(
      <TileHeaderContext.Provider value={TILE_HEADER_FIT}>
        <ScreenHeader title="T" zoom={z} history={history()} actions={actionCtx} />
      </TileHeaderContext.Provider>
    );
    const button = screen.getByRole('button', { name: /^Zoom 41/ });
    expect(button.textContent).toContain('▾');
    fireEvent.click(button);
    const menu = screen.getByTestId('screen-header-zoom-menu');
    expect(menu.hidden).toBe(false);
    expect(menu.closest('.cds--g100')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    fireEvent.click(screen.getByRole('button', { name: 'Actual size' }));
    fireEvent.click(screen.getByText('Fit'));
    expect(z.onZoomIn).toHaveBeenCalledTimes(1);
    expect(z.onActualSize).toHaveBeenCalledTimes(1);
    expect(z.onFit).toHaveBeenCalledTimes(1);
  });

  it('moves ◀ ▶ into "⋯" with the actions once even the floor does not fit', () => {
    const { h } = renderInTile(120);
    fireEvent.click(screen.getByRole('button', { name: 'More controls' }));
    const menu = screen.getByRole('group', { name: 'Screen controls' });
    expect(menu.querySelector('[data-screen-action="print"]')).not.toBeNull();
    fireEvent.click(menu.querySelector<HTMLElement>('[aria-label="Back"]')!);
    expect(h.back.onClick).toHaveBeenCalledTimes(1);
    expect(menu.querySelector('.screen-header__zoom')).toBeNull();
  });

  it('comes back as the lane widens: the widths of gone parts are kept', () => {
    stubTile(300);
    const observers: (() => void)[] = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        private readonly callback: () => void;
        constructor(callback: () => void) {
          this.callback = callback;
          observers.push(callback);
        }
        observe() {
          this.callback();
        }
        unobserve() {}
        disconnect() {}
      }
    );
    let lane = 900;
    vi.spyOn(Element.prototype, 'clientWidth', 'get').mockImplementation(function (this: Element) {
      return this.classList.contains('screen-header') ? lane : 0;
    });
    render(
      <TileHeaderContext.Provider value={TILE_HEADER_FIT}>
        <ScreenHeader title="T" detail="d" zoom={zoom()} history={history()} actions={actionCtx} />
      </TileHeaderContext.Provider>
    );
    const bar = screen.getByTestId('screen-header');
    expect(bar.dataset.step).toBe('0');
    lane = 300;
    act(() => observers.forEach((callback) => callback()));
    expect(bar.dataset.step).toBe('4');
    lane = 900;
    act(() => observers.forEach((callback) => callback()));
    expect(bar.dataset.step).toBe('0');
  });

  it('reports its floor (◀ ▶, the zoom button, "⋯") to the tile, and 0 once gone', () => {
    const reportNeed = vi.fn<(px: number) => void>();
    renderInTile(900, reportNeed);
    expect(reportNeed).toHaveBeenLastCalledWith(64 + 72 + 32);
    cleanup();
    expect(reportNeed).toHaveBeenLastCalledWith(0);
  });

  it('is off outside a tile bar: the context defaults to a standalone header', () => {
    stubWidths(1200);
    render(<ScreenHeader title="GTL" zoom={zoom()} history={history()} actions={actionCtx} />);
    const bar = screen.getByTestId('screen-header');
    expect(bar.classList.contains('screen-header--tile')).toBe(false);
    expect(bar.dataset.step).toBeUndefined();
  });
});

describe('ScreenHeader.css', () => {
  it('declares no .screen-header__button rule', () => {
    const all = selectors(css);
    expect(all.length).toBeGreaterThan(0);
    expect(all.filter((selector) => selector.includes('.screen-header__button'))).toEqual([]);
  });

  it('leaves .screen-header without paint', () => {
    const own = declarations(css, '.screen-header');
    expect(own.length).toBeGreaterThan(0);
    const painted = own.filter((d) => /^(background|color|border|box-shadow|outline)/.test(d));
    expect(painted).toEqual([]);
  });

  it('takes its colours and fonts from contract variables', () => {
    const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(bare).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(bare).not.toMatch(/--cds-/);
    const fonts = bare.match(/font-family:[^;]*/g) ?? [];
    expect(fonts.length).toBeGreaterThan(0);
    for (const font of fonts) expect(font).toContain('var(--canopy-font-');
  });
});
