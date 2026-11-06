// ScreenActionBar: renders the available actions as header buttons, runs
// them on click and on their shortcuts, and reports their outcome.

import '../test/memoryStorage.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Download, Link, Printer } from '@carbon/icons-react';
import { ScreenActionBar, ShortcutRelayContext, actionLabel } from './ScreenActionBar.js';
import type { ShortcutRelay } from './ScreenActionBar.js';
import type { ScreenAction, ScreenActionContext } from './types.js';
import { STATUS_MS } from './useScreenActions.js';

const ctx: ScreenActionContext = {
  screen: {
    category: 'bts',
    id: 'BTSView',
    title: 'BTS',
    macros: {},
    element: null,
    documentUrl: 'http://h/screens/bts/BTSView.screen.json',
  },
  zoom: { scale: 1, fit: false },
};

function action(id: string, overrides: Partial<ScreenAction> = {}): ScreenAction {
  return {
    id,
    label: id,
    icon: Download,
    isAvailable: () => true,
    run: vi.fn(),
    ...overrides,
  };
}

const buttons = () =>
  Array.from(document.querySelectorAll<HTMLElement>('[data-screen-action]')).map(
    (b) => b.dataset.screenAction
  );

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('ScreenActionBar', () => {
  it('renders only the available actions, in order, named with their shortcut', () => {
    const save = action('save', { label: 'Download screen', shortcut: 's' });
    const hidden = action('hidden', { isAvailable: () => false });
    const link = action('link', { label: 'Copy link', icon: Link });
    render(<ScreenActionBar ctx={ctx} actions={[save, hidden, link]} />);
    expect(buttons()).toEqual(['save', 'link']);
    expect(screen.getByRole('button', { name: 'Download screen (Ctrl+S)' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeTruthy();
    expect(actionLabel(save)).toBe('Download screen (Ctrl+S)');
  });

  it('runs an action with the current context on click', async () => {
    const run = vi.fn();
    render(<ScreenActionBar ctx={ctx} actions={[action('a', { run })]} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'a' }));
    });
    expect(run).toHaveBeenCalledWith(ctx);
  });

  it('shows an action\'s feedback briefly ("Copied")', async () => {
    vi.useFakeTimers();
    const copy = action('copy', { run: async () => ({ message: 'Copied' }) });
    render(<ScreenActionBar ctx={ctx} actions={[copy]} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'copy' }));
    });
    expect(screen.getByRole('status').textContent).toBe('Copied');
    act(() => {
      vi.advanceTimersByTime(STATUS_MS);
    });
    expect(screen.getByRole('status').textContent).toBe('');
  });

  it('reports a failing action, whether it throws or rejects', async () => {
    const throws = action('throws', {
      label: 'Print',
      run: () => {
        throw new Error('no printer');
      },
    });
    const rejects = action('rejects', {
      label: 'Export PNG',
      run: async () => {
        throw new Error('tainted');
      },
    });
    render(<ScreenActionBar ctx={ctx} actions={[throws, rejects]} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Print' }));
    });
    expect(screen.getByRole('status').textContent).toBe('Print failed: no printer');
    expect(screen.getByRole('status').className).toContain('screen-actions__status--error');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Export PNG' }));
    });
    expect(screen.getByRole('status').textContent).toBe('Export PNG failed: tainted');
  });

  it("runs a bound shortcut and keeps it from the browser's own Save/Print", async () => {
    const print = vi.fn();
    render(
      <ScreenActionBar
        ctx={ctx}
        actions={[action('print', { icon: Printer, shortcut: 'p', run: print })]}
      />
    );
    const event = new KeyboardEvent('keydown', {
      key: 'p',
      code: 'KeyP',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    await act(async () => {
      window.dispatchEvent(event);
    });
    expect(print).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it('leaves unbound keys, unavailable actions and typing alone', async () => {
    const save = vi.fn();
    render(
      <>
        <input aria-label="field" />
        <ScreenActionBar
          ctx={ctx}
          actions={[
            action('save', { shortcut: 's', run: save }),
            action('print', { shortcut: 'p', isAvailable: () => false }),
          ]}
        />
      </>
    );
    const press = (target: EventTarget, init: KeyboardEventInit) => {
      const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
      target.dispatchEvent(e);
      return e;
    };
    // Unavailable action: the browser keeps Ctrl+P.
    expect(press(window, { key: 'p', code: 'KeyP', ctrlKey: true }).defaultPrevented).toBe(false);
    // Unbound key.
    expect(press(window, { key: 'o', code: 'KeyO', ctrlKey: true }).defaultPrevented).toBe(false);
    // Typing in a field.
    const field = screen.getByRole('textbox', { name: 'field' });
    expect(press(field, { key: 's', code: 'KeyS', ctrlKey: true }).defaultPrevented).toBe(false);
    expect(save).not.toHaveBeenCalled();
  });

  it('unbinds its shortcuts when unmounted', () => {
    const save = vi.fn();
    const { unmount } = render(
      <ScreenActionBar ctx={ctx} actions={[action('save', { shortcut: 's', run: save })]} />
    );
    unmount();
    const e = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, cancelable: true });
    window.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
    expect(save).not.toHaveBeenCalled();
  });

  it('binds no listener with shortcuts={false}; its buttons still run', async () => {
    const save = vi.fn();
    render(
      <ScreenActionBar
        ctx={ctx}
        shortcuts={false}
        actions={[action('save', { shortcut: 's', run: save })]}
      />
    );
    const e = new KeyboardEvent('keydown', {
      key: 's',
      code: 'KeyS',
      ctrlKey: true,
      cancelable: true,
    });
    await act(async () => {
      window.dispatchEvent(e);
    });
    expect(e.defaultPrevented).toBe(false);
    expect(save).not.toHaveBeenCalled();
    // The label still names the shortcut: the page's one owner binds it.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'save (Ctrl+S)' }));
    });
    expect(save).toHaveBeenCalledWith(ctx);
  });

  it('under a shortcut relay binds no listener and hands the relay its runner', async () => {
    const attached: Array<(action: ScreenAction) => void> = [];
    const detach = vi.fn();
    const relay: ShortcutRelay = {
      attach: (run) => {
        attached.push(run);
        return detach;
      },
    };
    const copy = action('copy', { shortcut: 'c', run: async () => ({ message: 'Copied' }) });
    const fails = action('fails', {
      label: 'Print',
      run: () => {
        throw new Error('no printer');
      },
    });
    const { unmount } = render(
      <ShortcutRelayContext.Provider value={relay}>
        <ScreenActionBar ctx={ctx} actions={[copy, fails]} />
      </ShortcutRelayContext.Provider>
    );
    // No listener of its own: the key stays with the browser.
    const e = new KeyboardEvent('keydown', {
      key: 'c',
      code: 'KeyC',
      ctrlKey: true,
      cancelable: true,
    });
    window.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
    // The owner runs an action through the bar: its status shows here.
    const run = attached.at(-1)!;
    await act(async () => {
      run(copy);
    });
    expect(screen.getByRole('status').textContent).toBe('Copied');
    await act(async () => {
      run(fails);
    });
    expect(screen.getByRole('status').textContent).toBe('Print failed: no printer');
    unmount();
    expect(detach).toHaveBeenCalled();
  });

  it('keeps its own listener under a relay when told shortcuts={true}', async () => {
    const save = vi.fn();
    const relay: ShortcutRelay = { attach: () => () => {} };
    render(
      <ShortcutRelayContext.Provider value={relay}>
        <ScreenActionBar
          ctx={ctx}
          shortcuts
          actions={[action('save', { shortcut: 's', run: save })]}
        />
      </ShortcutRelayContext.Provider>
    );
    const e = new KeyboardEvent('keydown', {
      key: 's',
      code: 'KeyS',
      ctrlKey: true,
      cancelable: true,
    });
    await act(async () => {
      window.dispatchEvent(e);
    });
    expect(e.defaultPrevented).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
  });
});
