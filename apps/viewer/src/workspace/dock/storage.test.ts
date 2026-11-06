// The dock's stored value and its key: the per-user
// scope suffix, version 1 as the only readable value (any other version, or an
// invalid value, reads as nothing), removal, the unchanged-value skip and the
// storage guard.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Layout } from '@slaclab/canopy-dock-engine';
import {
  dockStorageKey,
  isStoredDock,
  readDock,
  removeDock,
  writeDock,
  type StoredDock,
} from './storage.js';

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key: string) => (data.has(key) ? (data.get(key) as string) : null),
    key: (index: number) => [...data.keys()][index] ?? null,
    removeItem: (key: string) => {
      data.delete(key);
    },
    setItem: (key: string, value: string) => {
      data.set(key, String(value));
    },
  };
}

const layout: Layout = {
  split: 'row',
  items: [
    { tile: 't1', tabs: ['ops/a', '@trace'], showing: '@trace', size: 0.4 },
    { tile: 't2', tabs: ['ops/b'], showing: 'ops/b', size: 0.6, from: 't1' },
  ],
};

function value(extra: Partial<StoredDock['panels']> = {}): StoredDock {
  return {
    version: 1,
    layout,
    panels: {
      'ops/a': { kind: 'screen' },
      '@trace': { kind: 'tool', query: '' },
      'ops/b': { kind: 'screen' },
      ...extra,
    } as StoredDock['panels'],
  };
}

const KEY = (base: string) => `canopy-workspace-dock:${base}`;

let store: Storage;

beforeEach(() => {
  store = memoryStorage();
  vi.stubGlobal('localStorage', store);
  document.documentElement.removeAttribute('data-canopy-storage-scope');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.documentElement.removeAttribute('data-canopy-storage-scope');
});

describe('dockStorageKey', () => {
  it('uses the bare key without the scope attribute', () => {
    expect(dockStorageKey('/')).toBe('canopy-workspace-dock:/');
    expect(dockStorageKey('')).toBe('canopy-workspace-dock:/');
    expect(dockStorageKey('/u/alice/panel/canopy/')).toBe(
      'canopy-workspace-dock:/u/alice/panel/canopy'
    );
  });

  it('uses the bare key when the scope attribute is empty', () => {
    document.documentElement.setAttribute('data-canopy-storage-scope', '');
    expect(dockStorageKey('/x')).toBe('canopy-workspace-dock:/x');
  });

  it('appends --<scope> when the scope attribute is set', () => {
    document.documentElement.setAttribute('data-canopy-storage-scope', 'alice');
    expect(dockStorageKey('/x')).toBe('canopy-workspace-dock:/x--alice');
  });

  it('never falls back to the bare key when scoped', () => {
    store.setItem(KEY('/x'), JSON.stringify(value()));
    document.documentElement.setAttribute('data-canopy-storage-scope', 'alice');
    expect(readDock('/x')).toBeNull();
    writeDock('/x', value());
    expect(store.getItem('canopy-workspace-dock:/x--alice')).toBe(JSON.stringify(value()));
  });
});

describe('readDock', () => {
  it('returns null when nothing is stored', () => {
    expect(readDock('/r1')).toBeNull();
  });

  it('round-trips the layout with tiles, tabs, showing, sizes and from', () => {
    writeDock('/r2', value());
    expect(JSON.parse(store.getItem(KEY('/r2'))!)).toEqual(value());
    expect(readDock('/r2')).toEqual(value());
  });

  it('round-trips the per-panel reopen record: query, view, member origin and title', () => {
    const tools = {
      '@trace/2': {
        kind: 'tool' as const,
        query: 'pv=SR:A',
        from: 'tool:trace?pv=SR:A',
        title: 'A',
      },
      '@trace/3': { kind: 'tool' as const, view: 'v1', query: 'q' },
    };
    const withTools: StoredDock = {
      version: 1,
      layout: { tile: 't1', tabs: ['@trace/2', '@trace/3'], showing: '@trace/3' },
      panels: tools,
    };
    writeDock('/r3', withTools);
    expect(readDock('/r3')).toEqual(withTools);
  });

  it('reads a stored empty dock (layout null)', () => {
    const empty: StoredDock = { version: 1, layout: null, panels: {} };
    store.setItem(KEY('/r4'), JSON.stringify(empty));
    expect(readDock('/r4')).toEqual(empty);
  });

  it.each([
    ['non-JSON', 'not json'],
    ['null', 'null'],
    ['an array', '[1]'],
    ['no version', JSON.stringify({ layout, panels: {} })],
    [
      'a dockview grid under another version',
      JSON.stringify({
        version: 0,
        grid: { grid: { root: { type: 'branch', data: [] } }, panels: {} },
        panels: { 'ops/a': { kind: 'screen', strip: 0 } },
      }),
    ],
    ['version 3', JSON.stringify({ ...value(), version: 3 })],
    ['a missing layout', JSON.stringify({ version: 1, panels: {} })],
    [
      'an invalid layout',
      JSON.stringify({ version: 1, layout: { tile: 't1', tabs: [], showing: 'x' }, panels: {} }),
    ],
    [
      'a layout with an unknown field',
      JSON.stringify({
        version: 1,
        layout: { tile: 't1', tabs: ['ops/a'], showing: 'ops/a', extra: 1 },
        panels: {},
      }),
    ],
    ['missing panels', JSON.stringify({ version: 1, layout })],
    [
      'a panel of an unknown kind',
      JSON.stringify({ ...value(), panels: { 'ops/a': { kind: 'frame' } } }),
    ],
    [
      'a panel with a non-string query',
      JSON.stringify({ ...value(), panels: { '@trace': { kind: 'tool', query: 3 } } }),
    ],
    [
      'a panel with an unknown field (an older strip record)',
      JSON.stringify({ ...value(), panels: { 'ops/a': { kind: 'screen', strip: 0 } } }),
    ],
    ['an unknown top-level field', JSON.stringify({ ...value(), grid: {} })],
  ])('%s reads as nothing, silently', (_label, raw) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    store.setItem(KEY('/r5'), raw);
    expect(readDock('/r5')).toBeNull();
    // No removal and no warning: the next write simply replaces it.
    expect(store.getItem(KEY('/r5'))).toBe(raw);
    expect(warn).not.toHaveBeenCalled();
  });

  it('returns null when localStorage is missing or throws', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(readDock('/r6')).toBeNull();
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
    });
    expect(readDock('/r6')).toBeNull();
  });
});

describe('isStoredDock', () => {
  it('accepts exactly a version 1 value', () => {
    expect(isStoredDock(value())).toBe(true);
    expect(isStoredDock({ ...value(), version: 2 })).toBe(false);
    expect(isStoredDock(undefined)).toBe(false);
  });
});

describe('removeDock', () => {
  it('removes the stored value', () => {
    writeDock('/m1', value());
    removeDock('/m1');
    expect(store.getItem(KEY('/m1'))).toBeNull();
    expect(readDock('/m1')).toBeNull();
  });

  it('lets the same value be written again afterwards', () => {
    writeDock('/m2', value());
    removeDock('/m2');
    writeDock('/m2', value());
    expect(store.getItem(KEY('/m2'))).toBe(JSON.stringify(value()));
  });

  it('swallows storage errors', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      removeItem: () => {
        throw new Error('blocked');
      },
    });
    expect(() => removeDock('/m3')).not.toThrow();
  });
});

describe('writeDock', () => {
  it('writes the serialized value', () => {
    writeDock('/w1', value());
    expect(store.getItem(KEY('/w1'))).toBe(JSON.stringify(value()));
  });

  it('skips a write equal to the last value written', () => {
    const setItem = vi.spyOn(store, 'setItem');
    writeDock('/w2', value());
    writeDock('/w2', value());
    expect(setItem).toHaveBeenCalledTimes(1);
    writeDock('/w2', value({ 'ops/c': { kind: 'screen' } }));
    expect(setItem).toHaveBeenCalledTimes(2);
  });

  it('skips a write equal to the last value read', () => {
    store.setItem(KEY('/w3'), JSON.stringify(value()));
    const setItem = vi.spyOn(store, 'setItem');
    readDock('/w3');
    writeDock('/w3', value());
    expect(setItem).not.toHaveBeenCalled();
  });

  it('replaces an unreadable value on the next write', () => {
    store.setItem(KEY('/w4'), JSON.stringify({ version: 0, grid: {}, panels: {} }));
    readDock('/w4');
    writeDock('/w4', value());
    expect(store.getItem(KEY('/w4'))).toBe(JSON.stringify(value()));
  });

  it('keeps the skip memory per key', () => {
    writeDock('/w5', value());
    writeDock('/w6', value());
    expect(store.getItem(KEY('/w6'))).toBe(JSON.stringify(value()));
  });

  it('swallows storage errors and retries the value later', () => {
    const failing = memoryStorage();
    failing.setItem = () => {
      throw new Error('quota');
    };
    vi.stubGlobal('localStorage', failing);
    expect(() => writeDock('/w7', value())).not.toThrow();
    vi.stubGlobal('localStorage', store);
    writeDock('/w7', value());
    expect(store.getItem(KEY('/w7'))).toBe(JSON.stringify(value()));
  });

  it('does nothing when localStorage is missing', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(() => writeDock('/w8', value())).not.toThrow();
  });
});
