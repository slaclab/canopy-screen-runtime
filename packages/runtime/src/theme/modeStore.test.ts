import { afterEach, describe, expect, it, vi } from 'vitest';
import { getMode, setMode, subscribe } from './modeStore.js';

afterEach(() => {
  setMode('light');
});

describe('mode store', () => {
  it("starts in light, today's look", () => {
    expect(getMode()).toBe('light');
  });

  it('applies a write synchronously and notifies subscribers before returning', () => {
    const seen: string[] = [];
    const off = subscribe(() => seen.push(getMode()));
    setMode('dark');
    expect(getMode()).toBe('dark');
    expect(seen).toEqual(['dark']);
    off();
  });

  it('does not notify when the mode is unchanged', () => {
    const listener = vi.fn();
    const off = subscribe(listener);
    setMode('light');
    expect(listener).not.toHaveBeenCalled();
    off();
  });

  it('stops notifying after unsubscribe, and other subscribers keep theirs', () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = subscribe(a);
    const offB = subscribe(b);
    offA();
    setMode('dark');
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
    offB();
  });

  it('tolerates a listener that unsubscribes itself during notification', () => {
    const later = vi.fn();
    const off = subscribe(() => off());
    const offLater = subscribe(later);
    setMode('dark');
    expect(later).toHaveBeenCalledTimes(1);
    offLater();
  });
});
