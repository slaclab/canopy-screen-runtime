// Test setup, imported FIRST by a test file whose imports reach
// canopy-shell: Node >= 25 defines a global `localStorage` that is undefined
// without --localstorage-file and shadows jsdom's, and canopy-shell's theme
// store reads it at import. This puts an in-memory Storage in its place when
// the global one is unusable. (ES imports evaluate in order, so it runs
// before the imports that follow it.)

const g = globalThis as { localStorage?: Storage };
if (typeof g.localStorage?.getItem !== 'function') {
  const data = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => void data.delete(key),
    setItem: (key, value) => void data.set(key, String(value)),
  };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
}

export {};
