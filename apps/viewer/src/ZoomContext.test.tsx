// The zoom context: the app-level provider (one value, /s/ and chrome off)
// and the workspace's store, one remembered zoom per screen in one
// localStorage record, read by a keyed provider around each screen and by
// that screen's tile bar.

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  KeyedZoomProvider,
  ZOOM_BY_SCREEN_NAME,
  ZoomProvider,
  ZoomStore,
  useKeyedZoom,
  useZoom,
} from './ZoomContext.js';

// Node 26 defines a global `localStorage` that is undefined without
// --localstorage-file and shadows jsdom's. Hoisted above the imports, this
// puts an in-memory Storage in its place when the global one is unusable.
vi.hoisted(() => {
  const g = globalThis as { localStorage?: Storage };
  if (typeof g.localStorage?.getItem === 'function') return;
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
});

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  localStorage.clear();
  document.documentElement.removeAttribute('data-canopy-storage-scope');
  vi.restoreAllMocks();
});

/** The record at the origin root. */
const RECORD = `${ZOOM_BY_SCREEN_NAME}:/`;
const record = (key = RECORD) => {
  const raw = localStorage.getItem(key);
  return raw === null ? null : (JSON.parse(raw) as Record<string, unknown>);
};

/** Shows the zoom it reads and steps it; one per provider. */
function Probe({ name }: { name: string }) {
  const zoom = useZoom();
  return (
    <div data-testid={name}>
      <span data-testid={`${name}-value`}>{`${zoom.mode}:${zoom.scale}`}</span>
      <button type="button" onClick={() => zoom.setManual(1.5)}>
        {`${name} manual`}
      </button>
      <button type="button" onClick={() => zoom.setFit()}>
        {`${name} fit`}
      </button>
    </div>
  );
}

const value = (name: string) => screen.getByTestId(`${name}-value`).textContent;

describe('ZoomStore', () => {
  it('starts every screen at fit and keeps screens apart', () => {
    const store = new ZoomStore();
    expect(store.get('a/one')).toEqual({ mode: 'fit', scale: 1 });
    store.set('a/one', { mode: 'manual', scale: 0.9 });
    expect(store.get('a/one')).toEqual({ mode: 'manual', scale: 0.9 });
    expect(store.get('a/two')).toEqual({ mode: 'fit', scale: 1 });
  });

  it('remembers one record keyed category/id in localStorage, read by a new session', () => {
    expect(ZOOM_BY_SCREEN_NAME).toBe('canopy-viewer:zoom-by-screen');
    new ZoomStore().set('bts/knob?X=1', { mode: 'manual', scale: 2 });
    new ZoomStore().set('cbx fel/CBXFEL/Landing', { mode: 'manual', scale: 0.5 });
    expect(record()).toEqual({
      'bts/knob': { mode: 'manual', scale: 2 },
      'cbx fel/CBXFEL/Landing': { mode: 'manual', scale: 0.5 },
    });
    // Nothing per tab key, nothing in the session.
    expect(sessionStorage.length).toBe(0);
    // A new session (session storage gone) reads it, for any macros.
    sessionStorage.clear();
    const next = new ZoomStore();
    expect(next.get('bts/knob')).toEqual({ mode: 'manual', scale: 2 });
    expect(next.get('bts/knob?Y=3')).toEqual({ mode: 'manual', scale: 2 });
  });

  it('Fit removes the entry, and the record when it empties', () => {
    const store = new ZoomStore();
    store.set('a/one', { mode: 'manual', scale: 1.2 });
    store.set('a/two', { mode: 'manual', scale: 0.8 });
    store.set('a/one', { mode: 'fit', scale: 1 });
    expect(record()).toEqual({ 'a/two': { mode: 'manual', scale: 0.8 } });
    store.set('a/two', { mode: 'fit', scale: 1 });
    expect(localStorage.getItem(RECORD)).toBeNull();
    expect(new ZoomStore().get('a/two')).toEqual({ mode: 'fit', scale: 1 });
  });

  it('keeps tool keys at fit and stores nothing for them', () => {
    const store = new ZoomStore();
    store.set('@trace/2', { mode: 'manual', scale: 2 });
    store.latch('@trace', { mode: 'manual', scale: 2 });
    expect(store.get('@trace/2')).toEqual({ mode: 'fit', scale: 1 });
    expect(store.get('@trace')).toEqual({ mode: 'fit', scale: 1 });
    expect(localStorage.getItem(RECORD)).toBeNull();
  });

  it("scopes the record to the mount and the host's user scope", () => {
    new ZoomStore('/u/alice/panel/canopy/').set('bts/knob', { mode: 'manual', scale: 2 });
    expect(record(`${ZOOM_BY_SCREEN_NAME}:/u/alice/panel/canopy`)).toEqual({
      'bts/knob': { mode: 'manual', scale: 2 },
    });
    expect(localStorage.getItem(RECORD)).toBeNull();
    expect(new ZoomStore('/u/alice/panel/canopy').get('bts/knob')).toEqual({
      mode: 'manual',
      scale: 2,
    });
    expect(new ZoomStore('/u/bob/panel/canopy').get('bts/knob')).toEqual({ mode: 'fit', scale: 1 });
    expect(new ZoomStore().get('bts/knob')).toEqual({ mode: 'fit', scale: 1 });

    document.documentElement.setAttribute('data-canopy-storage-scope', 'alice');
    new ZoomStore().set('bts/knob', { mode: 'manual', scale: 3 });
    expect(record(`${RECORD}--alice`)).toEqual({ 'bts/knob': { mode: 'manual', scale: 3 } });
    expect(localStorage.getItem(RECORD)).toBeNull();
  });

  it('reads an invalid stored entry or record as fit', () => {
    localStorage.setItem(
      RECORD,
      JSON.stringify({
        'a/bad': { mode: 'manual', scale: 0 },
        'a/odd': 7,
        'a/ok': { mode: 'manual', scale: 2 },
      })
    );
    const store = new ZoomStore();
    expect(store.get('a/bad')).toEqual({ mode: 'fit', scale: 1 });
    expect(store.get('a/odd')).toEqual({ mode: 'fit', scale: 1 });
    expect(store.get('a/ok')).toEqual({ mode: 'manual', scale: 2 });
    localStorage.setItem(RECORD, '{not json');
    expect(new ZoomStore().get('a/ok')).toEqual({ mode: 'fit', scale: 1 });
    localStorage.setItem(RECORD, '[1]');
    expect(new ZoomStore().get('a/ok')).toEqual({ mode: 'fit', scale: 1 });
  });

  it('refuses an invalid manual scale', () => {
    const store = new ZoomStore();
    store.set('a/one', { mode: 'manual', scale: Number.NaN });
    expect(store.get('a/one')).toEqual({ mode: 'fit', scale: 1 });
  });

  it('keeps working in memory when storage throws', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    // The in-memory shim (Node without --localstorage-file) is no Storage.
    if (Object.getPrototypeOf(localStorage) !== Storage.prototype) {
      vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
        throw new Error('blocked');
      });
      vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
        throw new Error('blocked');
      });
    }
    const store = new ZoomStore();
    expect(store.get('a/one')).toEqual({ mode: 'fit', scale: 1 });
    store.set('a/one', { mode: 'manual', scale: 1.1 });
    expect(store.get('a/one')).toEqual({ mode: 'manual', scale: 1.1 });
  });

  it('a latch beats the remembered zoom for its tab key only, and is never stored', () => {
    localStorage.setItem(RECORD, JSON.stringify({ 'bts/knob': { mode: 'manual', scale: 2 } }));
    const store = new ZoomStore();
    store.latch('bts/knob', { mode: 'fit', scale: 1 });
    expect(store.get('bts/knob')).toEqual({ mode: 'fit', scale: 1 });
    // Another tab of the same screen reads the remembered zoom.
    expect(store.get('bts/knob?X=1')).toEqual({ mode: 'manual', scale: 2 });
    expect(record()).toEqual({ 'bts/knob': { mode: 'manual', scale: 2 } });
    expect(sessionStorage.length).toBe(0);
    // A new page view has no latch.
    expect(new ZoomStore().get('bts/knob')).toEqual({ mode: 'manual', scale: 2 });
  });

  it('a zoom picked on a latched key drops the latch and is remembered', () => {
    const store = new ZoomStore();
    store.latch('bts/knob', { mode: 'manual', scale: 1 });
    const listener = vi.fn();
    store.subscribe(listener);
    store.set('bts/knob', { mode: 'fit', scale: 1 });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.get('bts/knob')).toEqual({ mode: 'fit', scale: 1 });
    store.set('bts/knob', { mode: 'manual', scale: 1.5 });
    expect(record()).toEqual({ 'bts/knob': { mode: 'manual', scale: 1.5 } });
  });

  it("merges into the stored record, keeping another tab's writes", () => {
    const store = new ZoomStore();
    store.get('a/one');
    // Another browser tab writes meanwhile.
    new ZoomStore().set('a/two', { mode: 'manual', scale: 0.7 });
    store.set('a/one', { mode: 'manual', scale: 1.3 });
    expect(record()).toEqual({
      'a/one': { mode: 'manual', scale: 1.3 },
      'a/two': { mode: 'manual', scale: 0.7 },
    });
  });

  it('refreshes on the storage event and notifies subscribers', () => {
    const store = new ZoomStore();
    expect(store.get('a/one')).toEqual({ mode: 'fit', scale: 1 });
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    localStorage.setItem(RECORD, JSON.stringify({ 'a/one': { mode: 'manual', scale: 1.4 } }));
    window.dispatchEvent(new StorageEvent('storage', { key: 'other' }));
    expect(listener).not.toHaveBeenCalled();
    window.dispatchEvent(new StorageEvent('storage', { key: RECORD }));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.get('a/one')).toEqual({ mode: 'manual', scale: 1.4 });
    // An event that changes nothing does not notify.
    window.dispatchEvent(new StorageEvent('storage', { key: RECORD }));
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    localStorage.removeItem(RECORD);
    window.dispatchEvent(new StorageEvent('storage', { key: RECORD }));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('notifies subscribers and keeps an unchanged snapshot identity', () => {
    const store = new ZoomStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    const before = store.get('a/one');
    expect(store.get('a/one')).toBe(before);
    store.set('a/one', { mode: 'manual', scale: 1.2 });
    expect(listener).toHaveBeenCalledTimes(1);
    const after = store.get('a/one');
    store.set('a/one', { mode: 'manual', scale: 1.2 });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.get('a/one')).toBe(after);
    // Another screen's change keeps this one's identity.
    store.set('a/two', { mode: 'manual', scale: 2 });
    expect(store.get('a/one')).toBe(after);
    unsubscribe();
    store.set('a/one', { mode: 'manual', scale: 1.3 });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('has no inherit', () => {
    expect('inherit' in ZoomStore.prototype).toBe(false);
  });
});

describe('KeyedZoomProvider', () => {
  it('two screens over one store hold independent scales', () => {
    const store = new ZoomStore();
    render(
      <MemoryRouter>
        <ZoomProvider>
          <KeyedZoomProvider store={store} zoomKey="a/one">
            <Probe name="one" />
          </KeyedZoomProvider>
          <KeyedZoomProvider store={store} zoomKey="a/two">
            <Probe name="two" />
          </KeyedZoomProvider>
        </ZoomProvider>
      </MemoryRouter>
    );
    fireEvent.click(screen.getByRole('button', { name: 'one manual' }));
    expect(value('one')).toBe('manual:1.5');
    expect(value('two')).toBe('fit:1');
    expect(store.get('a/one')).toEqual({ mode: 'manual', scale: 1.5 });
    expect(record()).toEqual({ 'a/one': { mode: 'manual', scale: 1.5 } });
    // The app-level value is untouched.
    expect(sessionStorage.getItem('canopy-viewer:zoom:/')).toBeNull();
  });

  it('follows a change written to its key from outside (a tile bar)', () => {
    const store = new ZoomStore();
    function Bar() {
      const zoom = useKeyedZoom(store, 'a/one');
      return (
        <button type="button" onClick={() => zoom.setManual(0.8)}>
          bar
        </button>
      );
    }
    render(
      <>
        <KeyedZoomProvider store={store} zoomKey="a/one">
          <Probe name="one" />
        </KeyedZoomProvider>
        <Bar />
      </>
    );
    fireEvent.click(screen.getByRole('button', { name: 'bar' }));
    expect(value('one')).toBe('manual:0.8');
    act(() => store.set('a/one', { mode: 'fit', scale: 1 }));
    expect(value('one')).toBe('fit:1');
  });

  it('switches to the new key when its key changes', () => {
    const store = new ZoomStore();
    store.set('a/two', { mode: 'manual', scale: 2 });
    const { rerender } = render(
      <KeyedZoomProvider store={store} zoomKey="a/one">
        <Probe name="p" />
      </KeyedZoomProvider>
    );
    expect(value('p')).toBe('fit:1');
    rerender(
      <KeyedZoomProvider store={store} zoomKey="a/two">
        <Probe name="p" />
      </KeyedZoomProvider>
    );
    expect(value('p')).toBe('manual:2');
  });
});

describe('ZoomProvider (app level)', () => {
  it('keeps the one unkeyed value under the canopy-viewer:zoom record', () => {
    render(
      <MemoryRouter>
        <ZoomProvider>
          <Probe name="app" />
        </ZoomProvider>
      </MemoryRouter>
    );
    fireEvent.click(screen.getByRole('button', { name: 'app manual' }));
    expect(value('app')).toBe('manual:1.5');
    expect(JSON.parse(sessionStorage.getItem('canopy-viewer:zoom:/')!)).toEqual({
      mode: 'manual',
      scale: 1.5,
    });
  });

  it('keeps it under the mount-suffixed key below a router basename', () => {
    render(
      <MemoryRouter basename="/u/alice/panel/canopy" initialEntries={['/u/alice/panel/canopy/']}>
        <ZoomProvider>
          <Probe name="app" />
        </ZoomProvider>
      </MemoryRouter>
    );
    fireEvent.click(screen.getByRole('button', { name: 'app manual' }));
    expect(sessionStorage.getItem('canopy-viewer:zoom:/')).toBeNull();
    expect(JSON.parse(sessionStorage.getItem('canopy-viewer:zoom:/u/alice/panel/canopy')!)).toEqual(
      { mode: 'manual', scale: 1.5 }
    );
  });

  it('is a fixed fit outside every provider', () => {
    render(<Probe name="none" />);
    fireEvent.click(screen.getByRole('button', { name: 'none manual' }));
    expect(value('none')).toBe('fit:1');
  });
});
