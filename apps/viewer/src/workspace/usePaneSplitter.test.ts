// usePaneSplitter on its own: Home/End jump to the bounds (APG window
// splitter), and `toggle` is the collapse a visible control drives.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { parseSplitterState, usePaneSplitter } from './usePaneSplitter.js';

const KEY = 'pane-splitter-test';
const MIN = 180;
const MAX = 560;
const FALLBACK = 256;

function memoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, String(value)),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  };
}

function setup(max: number | (() => number) = MAX) {
  return renderHook(() =>
    usePaneSplitter({ storageKey: KEY, min: MIN, max, fallbackSize: FALLBACK, label: 'Resize' })
  );
}

function key(result: ReturnType<typeof setup>['result'], k: string) {
  const preventDefault = vi.fn();
  act(() => {
    result.current.handleProps.onKeyDown({
      key: k,
      preventDefault,
    } as unknown as ReactKeyboardEvent<HTMLElement>);
  });
  return preventDefault;
}

const stored = () => parseSplitterState(localStorage.getItem(KEY));

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('usePaneSplitter Home/End', () => {
  it('Home jumps to the minimum and End to the maximum, persisted', () => {
    const { result } = setup();
    expect(key(result, 'Home')).toHaveBeenCalled();
    expect(result.current.handleProps['aria-valuenow']).toBe(MIN);
    expect(result.current.paneProps.style?.flexBasis).toBe(`${MIN}px`);
    expect(stored()).toEqual({ size: MIN, collapsed: false });

    expect(key(result, 'End')).toHaveBeenCalled();
    expect(result.current.handleProps['aria-valuenow']).toBe(MAX);
    expect(result.current.paneProps.style?.flexBasis).toBe(`${MAX}px`);
    expect(stored()).toEqual({ size: MAX, collapsed: false });
  });

  it('End honours a dynamic maximum', () => {
    const { result } = setup(() => 300);
    key(result, 'End');
    expect(result.current.handleProps['aria-valuenow']).toBe(300);
  });

  it('Home/End expand a collapsed pane', () => {
    localStorage.setItem(KEY, JSON.stringify({ size: 400, collapsed: true }));
    const { result } = setup();
    expect(result.current.collapsed).toBe(true);
    key(result, 'End');
    expect(result.current.collapsed).toBe(false);
    expect(result.current.handleProps['aria-valuenow']).toBe(MAX);
    expect(stored()).toEqual({ size: MAX, collapsed: false });
  });

  it('arrow steps still nudge beside Home/End', () => {
    const { result } = setup();
    key(result, 'Home');
    key(result, 'ArrowRight');
    expect(result.current.handleProps['aria-valuenow']).toBe(MIN + 16);
    key(result, 'End');
    key(result, 'ArrowLeft');
    expect(result.current.handleProps['aria-valuenow']).toBe(MAX - 16);
  });

  it('other keys are not claimed', () => {
    const { result } = setup();
    expect(key(result, 'PageUp')).not.toHaveBeenCalled();
    expect(localStorage.getItem(KEY)).toBeNull();
  });
});

describe('usePaneSplitter toggle', () => {
  it('collapses and restores the size it had, persisted', () => {
    const { result } = setup();
    key(result, 'End');
    act(() => result.current.toggle());
    expect(result.current.collapsed).toBe(true);
    expect(result.current.paneProps['data-collapsed']).toBe('');
    expect(stored()).toEqual({ size: MAX, collapsed: true });
    act(() => result.current.toggle());
    expect(result.current.collapsed).toBe(false);
    expect(result.current.handleProps['aria-valuenow']).toBe(MAX);
    expect(stored()).toEqual({ size: MAX, collapsed: false });
  });
});
