// FocusSentinels: standalone renders none; embedded, the sentinels are the tab
// stops just before the first and just after the last control (the Trace
// iframe included), and focusing one posts canopy-host-focus-exit to the parent
// with location.origin while focus stays put.
//
// jsdom has window.parent === window and no sequential focus navigation, so
// the parent is stubbed with a spy getter and Tab / Shift+Tab are emulated by
// moving focus to the next / previous tabbable element in document order.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { FOCUS_EXIT, FocusSentinels } from './FocusSentinels.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Content() {
  return (
    <div className="workspace">
      <button type="button">first</button>
      <a href="#x">middle</a>
      <iframe title="Trace" src="about:blank" />
      <button type="button">last</button>
    </div>
  );
}

function tabbables(): HTMLElement[] {
  const all = Array.from(
    document.body.querySelectorAll<HTMLElement>('button, a[href], iframe, [tabindex]')
  );
  return all.filter((el) => el.tabIndex >= 0);
}

// Emulates the browser's sequential navigation from the focused element.
function tab(shift = false): void {
  const order = tabbables();
  const index = order.indexOf(document.activeElement as HTMLElement);
  const next = order[index + (shift ? -1 : 1)];
  if (next) next.focus();
}

function embed() {
  const postMessage = vi.fn();
  const parent = { postMessage } as unknown as Window;
  vi.spyOn(window, 'parent', 'get').mockReturnValue(parent as Window & typeof globalThis);
  return postMessage;
}

describe('FocusSentinels', () => {
  it('renders no sentinel standalone', () => {
    const postMessage = vi.spyOn(window, 'postMessage');
    const { container, getByText } = render(
      <FocusSentinels>
        <Content />
      </FocusSentinels>
    );
    expect(container.querySelectorAll('[data-focus-exit]')).toHaveLength(0);
    // Tab order is just the content's own.
    expect(tabbables()[0]).toBe(getByText('first'));
    expect(tabbables().at(-1)).toBe(getByText('last'));
    getByText('first').focus();
    tab(true);
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('embedded: Shift+Tab from the first control posts backward and keeps focus', () => {
    const postMessage = embed();
    const { getByText, container } = render(
      <FocusSentinels>
        <Content />
      </FocusSentinels>
    );
    expect(container.querySelectorAll('[data-focus-exit]')).toHaveLength(2);
    getByText('first').focus();
    expect(postMessage).not.toHaveBeenCalled();
    tab(true);
    const sentinel = container.querySelector('[data-focus-exit="backward"]');
    expect(document.activeElement).toBe(sentinel);
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith(
      { type: FOCUS_EXIT, direction: 'backward' },
      window.location.origin
    );
    expect(FOCUS_EXIT).toBe('canopy-host-focus-exit');
    // Focus stays on the sentinel: nothing moved it afterwards.
    expect(document.activeElement).toBe(sentinel);
  });

  it('embedded: Tab from the last control posts forward and keeps focus', () => {
    const postMessage = embed();
    const { getByText, getByTitle, container } = render(
      <FocusSentinels>
        <Content />
      </FocusSentinels>
    );
    // The trailing sentinel is the last tabbable, after the Trace iframe.
    const order = tabbables();
    const sentinel = container.querySelector('[data-focus-exit="forward"]');
    expect(order.at(-1)).toBe(sentinel);
    expect(order.indexOf(getByTitle('Trace'))).toBeLessThan(order.length - 1);
    getByText('last').focus();
    tab();
    expect(document.activeElement).toBe(sentinel);
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith(
      { type: FOCUS_EXIT, direction: 'forward' },
      window.location.origin
    );
    expect(document.activeElement).toBe(sentinel);
  });

  it('sentinels are tabbable and bracket the content', () => {
    embed();
    const { container } = render(
      <FocusSentinels>
        <Content />
      </FocusSentinels>
    );
    const order = tabbables();
    expect(order[0]).toBe(container.querySelector('[data-focus-exit="backward"]'));
    expect(order[0].tabIndex).toBe(0);
    expect(order.at(-1)!.tabIndex).toBe(0);
  });
});
