// Global test setup (vite.config.ts `test.setupFiles`), run before every test
// file. jsdom has no ResizeObserver, and dockview-core constructs one for
// every grid it builds. This installs a no-op observer only when none exists,
// so a test that needs its own (vi.stubGlobal) still overrides it, and
// vi.unstubAllGlobals() restores this one.

if (typeof globalThis.ResizeObserver === 'undefined') {
  class NoopResizeObserver implements ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = NoopResizeObserver;
}
