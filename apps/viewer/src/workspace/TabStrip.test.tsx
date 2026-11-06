// TabStrip is presentational: it takes the tab list, the active key and
// callbacks as props, so these tests drive it with vi.fn() callbacks and
// assert the calls. tabDetail feeds the ScreenHeader the focused screen's
// tile bar holds; the last block pins that composition. jsdom has no scrollIntoView, so it
// is stubbed per test and restored afterwards.

import '../test/memoryStorage.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ScreenHeader } from '../ScreenHeader.js';
import { TabStrip, tabDetail } from './TabStrip.js';
import type { TabStripTab } from './TabStrip.js';

const TABS: TabStripTab[] = [
  { key: 'ops/main', title: 'Main' },
  { key: 'bts/bpm?SECTOR=3', title: 'BPM' },
  { key: '@trace', title: 'Trace' },
];

const originalScroll = Element.prototype.scrollIntoView;
let scrollSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  scrollSpy = vi.fn();
  Element.prototype.scrollIntoView = scrollSpy as unknown as Element['scrollIntoView'];
});

afterEach(() => {
  cleanup();
  Element.prototype.scrollIntoView = originalScroll;
});

function renderStrip(activeKey: string | null = 'ops/main', tabs = TABS) {
  const onFocus = vi.fn();
  const onClose = vi.fn();
  const utils = render(
    <TabStrip tabs={tabs} activeKey={activeKey} onFocus={onFocus} onClose={onClose} />
  );
  return { ...utils, onFocus, onClose };
}

function auxClick(el: Element, button: number) {
  fireEvent(el, new MouseEvent('auxclick', { bubbles: true, cancelable: true, button }));
}

describe('TabStrip rendering', () => {
  it('renders one tab per entry with its title, in order', () => {
    renderStrip();
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Main', 'BPM', 'Trace']);
    expect(tabs.map((t) => t.getAttribute('data-tab-key'))).toEqual([
      'ops/main',
      'bts/bpm?SECTOR=3',
      '@trace',
    ]);
    expect(screen.getByRole('tablist', { name: 'Open tabs' })).toBeTruthy();
  });

  it('marks only the active tab selected', () => {
    renderStrip('bts/bpm?SECTOR=3');
    const selected = screen
      .getAllByRole('tab')
      .filter((t) => t.getAttribute('aria-selected') === 'true');
    expect(selected).toHaveLength(1);
    expect(selected[0].getAttribute('data-tab-key')).toBe('bts/bpm?SECTOR=3');
    expect(selected[0].className).toContain('tab-strip__tab--active');
  });

  it('renders an empty strip with zero tabs', () => {
    renderStrip(null, []);
    expect(screen.getByRole('tablist')).toBeTruthy();
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    expect(scrollSpy).not.toHaveBeenCalled();
  });

  it('renders a markup title as text', () => {
    const { container } = renderStrip('x/y', [
      { key: 'x/y', title: '<img src=x onerror=alert(1)>' },
    ]);
    expect(screen.getByRole('tab').textContent).toBe('<img src=x onerror=alert(1)>');
    expect(container.querySelector('img')).toBeNull();
  });
});

describe('TabStrip interaction', () => {
  it('focuses a tab on click', () => {
    const { onFocus, onClose } = renderStrip();
    fireEvent.click(screen.getByText('BPM'));
    expect(onFocus).toHaveBeenCalledWith('bts/bpm?SECTOR=3');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes a tab from its close button without focusing it', () => {
    const { onFocus, onClose } = renderStrip();
    fireEvent.click(screen.getByRole('button', { name: 'Close Trace' }));
    expect(onClose).toHaveBeenCalledWith('@trace');
    expect(onFocus).not.toHaveBeenCalled();
  });

  it('closes a tab on middle-click', () => {
    const { onFocus, onClose } = renderStrip();
    auxClick(screen.getAllByRole('tab')[1], 1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith('bts/bpm?SECTOR=3');
    expect(onFocus).not.toHaveBeenCalled();
  });

  it('ignores right-button auxclick', () => {
    const { onClose } = renderStrip();
    auxClick(screen.getAllByRole('tab')[1], 2);
    expect(onClose).not.toHaveBeenCalled();
  });
});

function tabOf(key: string): HTMLElement {
  return screen.getAllByRole('tab').find((t) => t.getAttribute('data-tab-key') === key)!;
}

function tabStops(): string[] {
  return screen
    .getAllByRole('tab')
    .filter((t) => t.tabIndex === 0)
    .map((t) => t.getAttribute('data-tab-key')!);
}

describe('TabStrip keyboard (APG tablist)', () => {
  it('is one tab stop: the active tab, else the first', () => {
    renderStrip('bts/bpm?SECTOR=3');
    expect(tabStops()).toEqual(['bts/bpm?SECTOR=3']);
    cleanup();
    renderStrip(null);
    expect(tabStops()).toEqual(['ops/main']);
  });

  it('ArrowRight / ArrowLeft move focus and the tab stop without activating, wrapping', () => {
    const { onFocus } = renderStrip('ops/main');
    act(() => tabOf('ops/main').focus());
    fireEvent.keyDown(tabOf('ops/main'), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(tabOf('bts/bpm?SECTOR=3'));
    expect(tabStops()).toEqual(['bts/bpm?SECTOR=3']);
    fireEvent.keyDown(tabOf('bts/bpm?SECTOR=3'), { key: 'ArrowRight' });
    fireEvent.keyDown(tabOf('@trace'), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(tabOf('ops/main'));
    fireEvent.keyDown(tabOf('ops/main'), { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(tabOf('@trace'));
    expect(onFocus).not.toHaveBeenCalled();
  });

  it('Home and End jump to the ends', () => {
    renderStrip('bts/bpm?SECTOR=3');
    fireEvent.keyDown(tabOf('bts/bpm?SECTOR=3'), { key: 'End' });
    expect(document.activeElement).toBe(tabOf('@trace'));
    fireEvent.keyDown(tabOf('@trace'), { key: 'Home' });
    expect(document.activeElement).toBe(tabOf('ops/main'));
  });

  it('Enter and Space activate the focused tab', () => {
    const { onFocus } = renderStrip('ops/main');
    fireEvent.keyDown(tabOf('ops/main'), { key: 'ArrowRight' });
    fireEvent.keyDown(tabOf('bts/bpm?SECTOR=3'), { key: 'Enter' });
    expect(onFocus).toHaveBeenCalledExactlyOnceWith('bts/bpm?SECTOR=3');
    fireEvent.keyDown(tabOf('@trace'), { key: ' ' });
    expect(onFocus).toHaveBeenLastCalledWith('@trace');
  });

  it('Delete closes the focused tab and focus moves to its right neighbour', () => {
    const { onClose, onFocus, rerender } = renderStrip('ops/main');
    act(() => tabOf('bts/bpm?SECTOR=3').focus());
    fireEvent.keyDown(tabOf('bts/bpm?SECTOR=3'), { key: 'Delete' });
    expect(onClose).toHaveBeenCalledExactlyOnceWith('bts/bpm?SECTOR=3');
    rerender(
      <TabStrip
        tabs={TABS.filter((t) => t.key !== 'bts/bpm?SECTOR=3')}
        activeKey="ops/main"
        onFocus={onFocus}
        onClose={onClose}
      />
    );
    expect(document.activeElement).toBe(tabOf('@trace'));
    expect(tabStops()).toEqual(['@trace']);
    expect(onFocus).not.toHaveBeenCalled();
  });

  it('Backspace on the last tab moves focus to its left neighbour', () => {
    const { onClose, onFocus, rerender } = renderStrip('ops/main');
    act(() => tabOf('@trace').focus());
    fireEvent.keyDown(tabOf('@trace'), { key: 'Backspace' });
    expect(onClose).toHaveBeenCalledExactlyOnceWith('@trace');
    rerender(
      <TabStrip tabs={TABS.slice(0, 2)} activeKey="ops/main" onFocus={onFocus} onClose={onClose} />
    );
    expect(document.activeElement).toBe(tabOf('bts/bpm?SECTOR=3'));
  });

  it("the focusable tab's close button is reachable; Enter on it does not activate", () => {
    const { onClose, onFocus } = renderStrip('ops/main');
    const closeMain = screen.getByRole('button', { name: 'Close Main' });
    const closeBpm = screen.getByRole('button', { name: 'Close BPM' });
    expect(closeMain.tabIndex).toBe(0);
    expect(closeBpm.tabIndex).toBe(-1);
    fireEvent.keyDown(tabOf('ops/main'), { key: 'ArrowRight' });
    expect(closeBpm.tabIndex).toBe(0);
    expect(closeMain.tabIndex).toBe(-1);
    fireEvent.keyDown(closeBpm, { key: 'Enter' });
    fireEvent.keyDown(closeBpm, { key: 'Delete' });
    expect(onFocus).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closing a tab from its focused close button moves focus to the neighbour', () => {
    const { onClose, onFocus, rerender } = renderStrip('ops/main');
    const closeMain = screen.getByRole('button', { name: 'Close Main' });
    act(() => closeMain.focus());
    fireEvent.click(closeMain);
    expect(onClose).toHaveBeenCalledExactlyOnceWith('ops/main');
    rerender(
      <TabStrip
        tabs={TABS.slice(1)}
        activeKey="bts/bpm?SECTOR=3"
        onFocus={onFocus}
        onClose={onClose}
      />
    );
    expect(document.activeElement).toBe(tabOf('bts/bpm?SECTOR=3'));
  });

  it('a tab that gets focus is scrolled into view', () => {
    renderStrip('ops/main');
    scrollSpy.mockClear();
    fireEvent.keyDown(tabOf('ops/main'), { key: 'End' });
    expect(scrollSpy).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' });
    expect((scrollSpy.mock.contexts.at(-1) as Element).getAttribute('data-tab-key')).toBe('@trace');
  });
});

describe('TabStrip overflow fades', () => {
  function geometry(el: HTMLElement, scrollWidth: number, clientWidth: number, scrollLeft: number) {
    Object.defineProperty(el, 'scrollWidth', { value: scrollWidth, configurable: true });
    Object.defineProperty(el, 'clientWidth', { value: clientWidth, configurable: true });
    Object.defineProperty(el, 'scrollLeft', {
      value: scrollLeft,
      configurable: true,
      writable: true,
    });
    fireEvent.scroll(el);
  }

  it('fades the edge that hides tabs, following the scroll position', () => {
    renderStrip();
    const strip = screen.getByRole('tablist');
    geometry(strip, 600, 200, 0);
    expect(strip.className).toContain('tab-strip--fade-end');
    expect(strip.className).not.toContain('tab-strip--fade-start');
    geometry(strip, 600, 200, 200);
    expect(strip.className).toContain('tab-strip--fade-start');
    expect(strip.className).toContain('tab-strip--fade-end');
    geometry(strip, 600, 200, 400);
    expect(strip.className).toContain('tab-strip--fade-start');
    expect(strip.className).not.toContain('tab-strip--fade-end');
  });

  it('shows no fade when every tab fits', () => {
    renderStrip();
    const strip = screen.getByRole('tablist');
    geometry(strip, 200, 200, 0);
    expect(strip.className).not.toMatch(/tab-strip--fade/);
  });
});

describe('TabStrip scrolling', () => {
  it('scrolls the active tab into view', () => {
    renderStrip('@trace');
    expect(scrollSpy).toHaveBeenCalled();
    const target = scrollSpy.mock.contexts.at(-1) as Element;
    expect(target.getAttribute('data-tab-key')).toBe('@trace');
  });

  it('scrolls again when the active tab changes', () => {
    const { rerender, onFocus, onClose } = renderStrip('ops/main');
    scrollSpy.mockClear();
    rerender(
      <TabStrip tabs={TABS} activeKey="bts/bpm?SECTOR=3" onFocus={onFocus} onClose={onClose} />
    );
    const target = scrollSpy.mock.contexts.at(-1) as Element;
    expect(target.getAttribute('data-tab-key')).toBe('bts/bpm?SECTOR=3');
  });

  it('does not throw when scrollIntoView is missing', () => {
    // @ts-expect-error -- simulate jsdom without the method
    delete Element.prototype.scrollIntoView;
    expect(() => renderStrip('@trace')).not.toThrow();
  });
});

describe('tabDetail', () => {
  it('gives category/id for a screen without macros', () => {
    expect(tabDetail('ops/main')).toBe('ops/main');
  });

  it('appends the macro query', () => {
    expect(tabDetail('bts/bpm?SECTOR=3')).toBe('bts/bpm?SECTOR=3');
  });

  it('gives no detail for the trace tab or no tab', () => {
    expect(tabDetail('@trace')).toBeUndefined();
    expect(tabDetail(null)).toBeUndefined();
  });
});

describe('the screen header of a tile bar (ScreenHeader with tabDetail)', () => {
  it('shows the SCREEN label, the title and the macro detail without a router', () => {
    render(<ScreenHeader title="BPM" detail={tabDetail('bts/bpm?SECTOR=3')} />);
    const bar = screen.getByTestId('screen-header');
    expect(bar.textContent).toContain('SCREEN');
    expect(screen.getByTestId('screen-header-title').textContent).toContain('BPM');
    expect(bar.querySelector('.screen-header__detail')?.textContent).toBe('bts/bpm?SECTOR=3');
    expect(screen.queryByText('All screens')).toBeNull();
    // No action context, no action buttons.
    expect(bar.querySelectorAll('[data-screen-action]')).toHaveLength(0);
  });

  it('renders zoom controls when given', () => {
    const zoom = {
      scale: 1,
      fit: false,
      onZoomOut: vi.fn(),
      onZoomIn: vi.fn(),
      onFit: vi.fn(),
      onActualSize: vi.fn(),
    };
    render(<ScreenHeader title="Main" detail={tabDetail('ops/main')} zoom={zoom} />);
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(zoom.onZoomIn).toHaveBeenCalled();
    expect(screen.getByTestId('zoom-percent')).toBeTruthy();
  });

  it('renders a markup title as text', () => {
    const { container } = render(
      <ScreenHeader title="<img src=x onerror=alert(1)>" detail={tabDetail('x/y')} />
    );
    expect(container.querySelector('img')).toBeNull();
  });
});
