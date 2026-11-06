// The notification toast: one at a time (a new toast replaces and commits the shown one),
// 10 s auto-dismiss paused on hover and focus-within, role=status
// aria-live=polite, one optional action, Esc dismisses, primary+Z runs the
// action (⌘Z on macOS, Ctrl+Z elsewhere) unless focus is editable, and the
// region is never inside the write-toast column.

import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { WriteToastColumn } from '../writeGate/toastHost.js';
import {
  TOAST_TIMEOUT_MS,
  ToastContext,
  ToastRegion,
  useToast,
  useToasts,
  type ToastStore,
} from './useToasts.js';

let store: ToastStore;

function Harness({ mac }: { mac: boolean }) {
  const toasts = useToasts({ mac });
  useEffect(() => {
    store = toasts;
  });
  return (
    <ToastContext.Provider value={toasts}>
      <input data-testid="field" />
      <div role="dialog" data-testid="dialog">
        <button type="button">in dialog</button>
      </div>
      <button type="button" data-testid="outside">
        outside
      </button>
      <ToastRegion store={toasts} />
      <WriteToastColumn onElement={() => {}} />
    </ToastContext.Provider>
  );
}

function setup(mac = true) {
  return render(<Harness mac={mac} />);
}

function show(spec: Parameters<ToastStore['show']>[0]): number {
  let id = 0;
  act(() => {
    id = store.show(spec);
  });
  return id;
}

const toastEl = () => screen.queryByTestId('canopy-toast');

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('toast region', () => {
  it('is a polite status region, beside and never inside the write column', () => {
    setup();
    const region = screen.getByTestId('canopy-toast-region');
    expect(region.getAttribute('role')).toBe('status');
    expect(region.getAttribute('aria-live')).toBe('polite');
    const column = screen.getByTestId('canopy-write-toast-column');
    expect(column.contains(region)).toBe(false);
    expect(region.contains(column)).toBe(false);
    show({ message: 'Saved “A”' });
    expect(column.contains(toastEl())).toBe(false);
    expect(region.contains(toastEl())).toBe(true);
  });

  it('renders the message and at most one action button', () => {
    setup();
    show({ message: 'Saved “A”' });
    expect(toastEl()?.textContent).toContain('Saved “A”');
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
    show({ message: 'Closed 3 tabs', action: { label: 'Undo', run: () => {} } });
    expect(screen.getAllByRole('button', { name: 'Undo' })).toHaveLength(1);
  });

  it('is reachable through the context, and null outside a workspace', () => {
    function Outside() {
      return <span data-testid="outside-store">{useToast() === null ? 'none' : 'store'}</span>;
    }
    function Inside() {
      const toasts = useToast();
      return (
        <button type="button" onClick={() => toasts?.show({ message: 'from below' })}>
          show
        </button>
      );
    }
    function WithInside() {
      const toasts = useToasts();
      return (
        <ToastContext.Provider value={toasts}>
          <Inside />
          <ToastRegion store={toasts} />
        </ToastContext.Provider>
      );
    }
    render(
      <>
        <Outside />
        <WithInside />
      </>
    );
    expect(screen.getByTestId('outside-store').textContent).toBe('none');
    fireEvent.click(screen.getByRole('button', { name: 'show' }));
    expect(toastEl()?.textContent).toContain('from below');
  });
});

describe('toast one at a time', () => {
  it('a new toast replaces the shown one and commits its undo', () => {
    setup();
    const firstRun = vi.fn();
    const firstCommit = vi.fn();
    show({ message: 'first', action: { label: 'Undo', run: firstRun }, onCommit: firstCommit });
    show({ message: 'second' });
    expect(screen.getAllByTestId('canopy-toast')).toHaveLength(1);
    expect(toastEl()?.textContent).toContain('second');
    expect(firstCommit).toHaveBeenCalledTimes(1);
    // The first undo can no longer run, by button or shortcut.
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
    fireEvent.keyDown(screen.getByTestId('outside'), { key: 'z', code: 'KeyZ', metaKey: true });
    expect(firstRun).not.toHaveBeenCalled();
  });

  it('the action runs once, closes the toast and does not commit', () => {
    setup();
    const run = vi.fn();
    const onCommit = vi.fn();
    show({ message: 'Closed 2 tabs', action: { label: 'Undo', run }, onCommit });
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();
    expect(toastEl()).toBeNull();
  });

  it('dismiss(id) ignores a toast that is no longer shown', () => {
    setup();
    const first = show({ message: 'first' });
    show({ message: 'second' });
    act(() => store.dismiss(first));
    expect(toastEl()?.textContent).toContain('second');
  });
});

describe('toast auto-dismiss', () => {
  it('dismisses after 10 s and commits', () => {
    setup();
    const onCommit = vi.fn();
    show({ message: 'Saved', onCommit });
    act(() => vi.advanceTimersByTime(TOAST_TIMEOUT_MS - 1));
    expect(toastEl()).not.toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(toastEl()).toBeNull();
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('a replacing toast gets its own full 10 s', () => {
    setup();
    show({ message: 'first' });
    act(() => vi.advanceTimersByTime(6000));
    show({ message: 'second' });
    act(() => vi.advanceTimersByTime(6000));
    expect(toastEl()?.textContent).toContain('second');
    act(() => vi.advanceTimersByTime(4000));
    expect(toastEl()).toBeNull();
  });

  it('pauses while hovered and restarts on leave', () => {
    setup();
    show({ message: 'Saved' });
    fireEvent.mouseEnter(toastEl()!);
    act(() => vi.advanceTimersByTime(TOAST_TIMEOUT_MS * 3));
    expect(toastEl()).not.toBeNull();
    fireEvent.mouseLeave(toastEl()!);
    act(() => vi.advanceTimersByTime(TOAST_TIMEOUT_MS - 1));
    expect(toastEl()).not.toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(toastEl()).toBeNull();
  });

  it('pauses while focus is within and resumes when focus leaves', () => {
    setup();
    show({ message: 'Closed 2 tabs', action: { label: 'Undo', run: () => {} } });
    const undo = screen.getByRole('button', { name: 'Undo' });
    act(() => undo.focus());
    act(() => vi.advanceTimersByTime(TOAST_TIMEOUT_MS * 2));
    expect(toastEl()).not.toBeNull();
    // Moving focus between the toast's own buttons keeps it paused.
    act(() => screen.getByRole('button', { name: 'Dismiss' }).focus());
    act(() => vi.advanceTimersByTime(TOAST_TIMEOUT_MS * 2));
    expect(toastEl()).not.toBeNull();
    act(() => screen.getByTestId('outside').focus());
    act(() => vi.advanceTimersByTime(TOAST_TIMEOUT_MS));
    expect(toastEl()).toBeNull();
  });

  it('a toast after an action click is not left paused', () => {
    setup();
    show({ message: 'Closed 2 tabs', action: { label: 'Undo', run: () => {} } });
    fireEvent.mouseEnter(toastEl()!);
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    show({ message: 'next' });
    act(() => vi.advanceTimersByTime(TOAST_TIMEOUT_MS));
    expect(toastEl()).toBeNull();
  });
});

describe('toast Esc', () => {
  it('dismisses from the page and from inside the toast, and commits', () => {
    setup();
    const onCommit = vi.fn();
    show({ message: 'first', onCommit });
    fireEvent.keyDown(screen.getByTestId('outside'), { key: 'Escape' });
    expect(toastEl()).toBeNull();
    expect(onCommit).toHaveBeenCalledTimes(1);
    show({ message: 'second' });
    fireEvent.keyDown(screen.getByRole('button', { name: 'Dismiss' }), { key: 'Escape' });
    expect(toastEl()).toBeNull();
  });

  it('leaves Esc to a dialog or a form field that owns it', () => {
    setup();
    show({ message: 'Saved' });
    fireEvent.keyDown(screen.getByRole('button', { name: 'in dialog' }), { key: 'Escape' });
    expect(toastEl()).not.toBeNull();
    fireEvent.keyDown(screen.getByTestId('field'), { key: 'Escape' });
    expect(toastEl()).not.toBeNull();
  });

  it('the Dismiss button closes it', () => {
    setup();
    show({ message: 'Saved' });
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(toastEl()).toBeNull();
  });
});

describe.each([
  { platform: 'macOS', mac: true, primary: { metaKey: true }, other: { ctrlKey: true } },
  { platform: 'Windows/Linux', mac: false, primary: { ctrlKey: true }, other: { metaKey: true } },
])('toast shortcut on $platform', ({ mac, primary, other }) => {
  it('primary+Z runs the action while shown and closes the toast', () => {
    setup(mac);
    const run = vi.fn();
    show({ message: 'Closed 2 tabs', action: { label: 'Undo', run } });
    const event = fireEvent.keyDown(screen.getByTestId('outside'), {
      key: 'z',
      code: 'KeyZ',
      ...primary,
    });
    expect(event).toBe(false); // preventDefault: the browser's own undo does not run
    expect(run).toHaveBeenCalledTimes(1);
    expect(toastEl()).toBeNull();
    // Once the toast is gone the key is the browser's again.
    fireEvent.keyDown(screen.getByTestId('outside'), { key: 'z', code: 'KeyZ', ...primary });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("ignores the other platform's modifier, Shift and Alt", () => {
    setup(mac);
    const run = vi.fn();
    show({ message: 'Closed 2 tabs', action: { label: 'Undo', run } });
    const outside = screen.getByTestId('outside');
    fireEvent.keyDown(outside, { key: 'z', code: 'KeyZ', ...other });
    fireEvent.keyDown(outside, { key: 'Z', code: 'KeyZ', shiftKey: true, ...primary });
    fireEvent.keyDown(outside, { key: 'z', code: 'KeyZ', altKey: true, ...primary });
    fireEvent.keyDown(outside, { key: 'z', code: 'KeyZ' });
    expect(run).not.toHaveBeenCalled();
    expect(toastEl()).not.toBeNull();
  });

  it('never takes the key from an editable target', () => {
    setup(mac);
    const run = vi.fn();
    show({ message: 'Closed 2 tabs', action: { label: 'Undo', run } });
    const event = fireEvent.keyDown(screen.getByTestId('field'), {
      key: 'z',
      code: 'KeyZ',
      ...primary,
    });
    expect(event).toBe(true);
    expect(run).not.toHaveBeenCalled();
    expect(toastEl()).not.toBeNull();
  });

  it('does nothing for a toast without an action', () => {
    setup(mac);
    show({ message: 'Saved' });
    const event = fireEvent.keyDown(screen.getByTestId('outside'), {
      key: 'z',
      code: 'KeyZ',
      ...primary,
    });
    expect(event).toBe(true);
    expect(toastEl()).not.toBeNull();
  });
});
