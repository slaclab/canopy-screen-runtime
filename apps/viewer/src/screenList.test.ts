import { afterEach, describe, expect, it, vi } from 'vitest';
import { isSubScreen, readShowSubScreens, writeShowSubScreens } from './screenList.js';

describe('isSubScreen', () => {
  it('flags ids with an embedded path segment', () => {
    expect(isSubScreen('bts/embedded/_tv')).toBe(true);
    expect(isSubScreen('embedded/panel')).toBe(true);
    expect(isSubScreen('bts/embedded/Tv')).toBe(true);
  });

  it('flags ids whose basename starts with an underscore', () => {
    expect(isSubScreen('_sub')).toBe(true);
    expect(isSubScreen('gtb/_header')).toBe(true);
  });

  it('keeps ordinary screens', () => {
    expect(isSubScreen('bts/BTSView')).toBe(false);
    expect(isSubScreen('common/KnobPanel')).toBe(false);
    expect(isSubScreen('e2e-panel')).toBe(false);
    // An underscore inside a directory name or mid-basename is not a marker.
    expect(isSubScreen('_drafts/Main')).toBe(false);
    expect(isSubScreen('bts/my_view')).toBe(false);
    // 'embedded' only as a whole segment.
    expect(isSubScreen('bts/embeddedView')).toBe(false);
  });
});

/** A Storage stand-in (Node >= 25 shadows jsdom's localStorage with an unusable global). */
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

describe('show-sub-screens preference', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('defaults to hidden and round-trips through localStorage', () => {
    vi.stubGlobal('localStorage', memoryStorage());
    expect(readShowSubScreens()).toBe(false);
    writeShowSubScreens(true);
    expect(readShowSubScreens()).toBe(true);
    writeShowSubScreens(false);
    expect(readShowSubScreens()).toBe(false);
  });

  it('survives a throwing storage', () => {
    const blocked = () => {
      throw new Error('blocked');
    };
    vi.stubGlobal('localStorage', { ...memoryStorage(), getItem: blocked, setItem: blocked });
    expect(() => writeShowSubScreens(true)).not.toThrow();
    expect(readShowSubScreens()).toBe(false);
  });

  it('survives a missing storage', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(() => writeShowSubScreens(true)).not.toThrow();
    expect(readShowSubScreens()).toBe(false);
  });
});
