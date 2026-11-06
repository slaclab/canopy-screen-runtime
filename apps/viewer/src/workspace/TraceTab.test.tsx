// TraceTab hosts react-trace in one iframe. These tests drive it with props
// and synthetic MessageEvents: IntersectionObserver is stubbed with a fake
// that tests fire by hand, the iframe's contentWindow.postMessage is spied,
// and the viewport size and document.visibilityState are overridden per test
// and restored afterwards.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import {
  TRACE_OPEN,
  QUICK_OPEN,
  TRACE_QUERY,
  TRACE_READY,
  TRACE_THEME,
  TRACE_VISIBILITY,
  TraceTab,
  traceSrc,
} from './TraceTab.js';
import { HOST_SHELL_CAPABILITIES, HostCapabilitiesContext } from './host/hostCapabilities.js';
import type { TraceTabProps } from './TraceTab.js';
import { isValidTraceQuery } from './traceQuery.js';
import {
  SAVE_VIEW,
  TOOL_ACTIONS,
  TOOL_INVOKE,
  createToolActionsStore,
} from './toolActionsStore.js';

// Node 26 defines a global `localStorage` that is undefined without
// --localstorage-file and shadows jsdom's; canopy-shell's theme store reads
// it at import. Hoisted above the imports, this puts an in-memory Storage
// in its place when the global one is unusable.
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

class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  targets: Element[] = [];
  callback: IntersectionObserverCallback;
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    FakeIntersectionObserver.instances.push(this);
  }
  observe(target: Element) {
    this.targets.push(target);
  }
  unobserve() {}
  disconnect() {
    this.targets = [];
  }
  takeRecords() {
    return [];
  }
  fire(isIntersecting: boolean) {
    const entries = this.targets.map(
      (target) => ({ target, isIntersecting }) as unknown as IntersectionObserverEntry
    );
    this.callback(entries, this as unknown as IntersectionObserver);
  }
}

const QUERY = 'pv=BTS:DIAG:BPM:01:POSITION:X&range=-1h';
// A query as Trace writes it once the operator changed an axis: the plot
// config is JSON with its structure characters left readable.
const PLOT_JSON = '{"v":1,"axes":[{},{"name":"I","logScale":true}],"traces":[{},{"axis":1}]}';
const PLOT_QUERY =
  'pv=GTL:BPM1:X&pv=GTL:QF1:I&range=-6h&plot=' +
  encodeURIComponent(PLOT_JSON).replace(/%(3A|2C|5B|5D|7B|7D)/gi, (m) => decodeURIComponent(m));
const originalWidth = window.innerWidth;
const originalHeight = window.innerHeight;

function setViewport(width: number, height: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
}

let visibilityState: DocumentVisibilityState = 'visible';

beforeEach(() => {
  FakeIntersectionObserver.instances = [];
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
  visibilityState = 'visible';
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibilityState,
  });
  setViewport(1024, 768);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  // Drop the own-property override so the prototype getter shows through again.
  delete (document as { visibilityState?: unknown }).visibilityState;
  setViewport(originalWidth, originalHeight);
});

function renderTab(overrides: Partial<TraceTabProps> = {}) {
  const props: TraceTabProps = {
    mode: 'light',
    showing: true,
    path: 'trace/',
    query: QUERY,
    onQuery: vi.fn(),
    ...overrides,
  };
  const utils = render(<TraceTab {...props} />);
  const iframe = utils.container.querySelector('iframe') as HTMLIFrameElement;
  const frame = iframe.contentWindow as Window;
  const postSpy = vi.spyOn(frame, 'postMessage');
  const rerender = (next: Partial<TraceTabProps>) => {
    Object.assign(props, next);
    utils.rerender(<TraceTab {...props} />);
  };
  return { ...utils, props, iframe, frame, postSpy, rerender };
}

function observer(): FakeIntersectionObserver {
  const io = FakeIntersectionObserver.instances.at(-1);
  if (!io) throw new Error('no IntersectionObserver created');
  return io;
}

function onScreen(on = true) {
  act(() => observer().fire(on));
}

function sendFrom(source: Window | null, data: unknown, origin = window.location.origin) {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data, source, origin }));
  });
}

function lastVisibility(spy: { mock: { calls: unknown[][] } }): unknown {
  const calls = spy.mock.calls
    .map((c: unknown[]) => c[0] as { type?: string; visible?: boolean })
    .filter((m) => m.type === TRACE_VISIBILITY);
  return calls.at(-1)?.visible;
}

describe('TraceTab src', () => {
  it('builds src from path, query, theme and embedded, resolved against baseURI', () => {
    const { iframe } = renderTab();
    const expected = new URL(`trace/?${QUERY}&theme=light&embedded=true`, document.baseURI).href;
    expect(iframe.src).toBe(expected);
  });

  it('adds hostbar=1 only when the host owns the header', () => {
    const { iframe } = renderTab();
    expect(new URL(iframe.src).searchParams.has('hostbar')).toBe(false);
    cleanup();
    const hosted = render(
      <HostCapabilitiesContext.Provider value={HOST_SHELL_CAPABILITIES}>
        <TraceTab mode="light" showing path="trace/" query={QUERY} onQuery={vi.fn()} />
      </HostCapabilitiesContext.Provider>
    );
    const frame = hosted.container.querySelector('iframe')!;
    expect(new URL(frame.src).searchParams.get('hostbar')).toBe('1');
  });

  it('omits the query separator when the query is empty', () => {
    expect(traceSrc('trace/', '', 'dark')).toBe(
      new URL('trace/?theme=dark&embedded=true', document.baseURI).href
    );
  });

  it('sets src once across theme changes and posts the new theme instead', () => {
    const { iframe, rerender, postSpy } = renderTab();
    const src = iframe.src;
    rerender({ mode: 'dark' });
    expect(iframe.src).toBe(src);
    expect(src).toContain('theme=light');
    expect(postSpy).toHaveBeenCalledWith(
      { type: TRACE_THEME, mode: 'dark', theme: 'dark' },
      window.location.origin
    );
  });

  it('keeps a crafted theme out of the query', () => {
    const src = new URL(traceSrc('trace/', '', 'dark&embedded=false&pv=X'));
    expect(src.searchParams.getAll('embedded')).toEqual(['true']);
    expect(src.searchParams.get('embedded')).toBe('true');
    expect(src.searchParams.has('pv')).toBe(false);
    expect(src.searchParams.get('theme')).toBe('dark');
  });

  it('falls back to the mode, not to dark, when the theme is malformed', () => {
    const src = new URL(traceSrc('trace/', '', '../x', 'light'));
    expect(src.searchParams.get('theme')).toBe('light');
    const { iframe } = renderTab({ mode: 'light', theme: 'dark&embedded=false' });
    expect(new URL(iframe.src).searchParams.get('theme')).toBe('light');
    expect(new URL(iframe.src).searchParams.getAll('embedded')).toEqual(['true']);
  });

  it.each(['light', 'dark'] as const)(
    'names the %s mode as theme when no theme is given',
    (mode) => {
      const { iframe } = renderTab({ mode });
      expect(new URL(iframe.src).searchParams.get('theme')).toBe(mode);
      expect(new URL(traceSrc('trace/', '', null, mode)).searchParams.get('theme')).toBe(mode);
    }
  );

  it('bakes a concrete host theme id into src', () => {
    const { iframe } = renderTab({ mode: 'dark', theme: 'retro-dark' });
    expect(iframe.src).toBe(
      new URL(`trace/?${QUERY}&theme=retro-dark&embedded=true`, document.baseURI).href
    );
  });

  it('posts the concrete host theme id', () => {
    const { rerender, postSpy, frame } = renderTab({ mode: 'dark', theme: 'desy-dark' });
    postSpy.mockClear();
    // Same mode, another theme: the mode alone would not post again.
    rerender({ theme: 'retro-dark' });
    expect(postSpy).toHaveBeenCalledTimes(1);
    expect(postSpy).toHaveBeenCalledWith(
      { type: TRACE_THEME, mode: 'dark', theme: 'retro-dark' },
      window.location.origin
    );
    postSpy.mockClear();
    sendFrom(frame, { type: TRACE_READY });
    expect(postSpy).toHaveBeenCalledWith(
      { type: TRACE_THEME, mode: 'dark', theme: 'retro-dark' },
      window.location.origin
    );
  });

  it('posts the mode as theme when the id is malformed', () => {
    const { postSpy, frame } = renderTab({ mode: 'light', theme: 'dark&embedded=false' });
    postSpy.mockClear();
    sendFrom(frame, { type: TRACE_READY });
    expect(postSpy).toHaveBeenCalledWith(
      { type: TRACE_THEME, mode: 'light', theme: 'light' },
      window.location.origin
    );
  });

  it('keeps src when the query prop changes', () => {
    const { iframe, rerender } = renderTab();
    const src = iframe.src;
    rerender({ query: 'pv=OTHER&range=-2h' });
    expect(iframe.src).toBe(src);
  });
});

describe('TraceTab hiding', () => {
  it('stays mounted and is hidden with visibility:hidden + absolute when not showing', () => {
    const { iframe, rerender, container } = renderTab();
    expect(iframe.style.visibility).not.toBe('hidden');
    rerender({ showing: false });
    const same = container.querySelector('iframe');
    expect(same).toBe(iframe);
    expect(iframe.style.visibility).toBe('hidden');
    expect(iframe.style.position).toBe('absolute');
    expect(iframe.style.display).not.toBe('none');
  });
});

describe('TraceTab messages', () => {
  it('replies to canopy:trace-ready with visibility and theme', () => {
    const { frame, postSpy } = renderTab({ mode: 'dark' });
    onScreen();
    postSpy.mockClear();
    sendFrom(frame, { type: TRACE_READY });
    expect(postSpy).toHaveBeenCalledWith(
      { type: TRACE_VISIBILITY, visible: true },
      window.location.origin
    );
    expect(postSpy).toHaveBeenCalledWith(
      { type: TRACE_THEME, mode: 'dark', theme: 'dark' },
      window.location.origin
    );
  });

  it('ignores a message from a foreign source', () => {
    const onQuery = vi.fn();
    const { postSpy } = renderTab({ onQuery });
    postSpy.mockClear();
    sendFrom(window, { type: TRACE_READY });
    sendFrom(window, { type: TRACE_QUERY, query: 'pv=X' });
    sendFrom(null, { type: TRACE_QUERY, query: 'pv=X' });
    expect(postSpy).not.toHaveBeenCalled();
    expect(onQuery).not.toHaveBeenCalled();
  });

  it('ignores a message from the frame with a foreign origin', () => {
    const onQuery = vi.fn();
    const { frame, postSpy } = renderTab({ onQuery });
    postSpy.mockClear();
    sendFrom(frame, { type: TRACE_READY }, 'https://evil.example');
    sendFrom(frame, { type: TRACE_QUERY, query: 'pv=X' }, 'https://evil.example');
    expect(postSpy).not.toHaveBeenCalled();
    expect(onQuery).not.toHaveBeenCalled();
  });

  it('stores a valid query through onQuery and leaves src unchanged', () => {
    const onQuery = vi.fn();
    const { frame, iframe } = renderTab({ onQuery });
    const src = iframe.src;
    sendFrom(frame, { type: TRACE_QUERY, query: 'pv=A%3AB&range=-2h' });
    expect(onQuery).toHaveBeenCalledExactlyOnceWith('pv=A%3AB&range=-2h');
    expect(iframe.src).toBe(src);
  });

  it('stores a query carrying axis settings verbatim and bakes it into src', () => {
    const onQuery = vi.fn();
    const { frame, iframe } = renderTab({ onQuery, query: PLOT_QUERY });
    expect(new URL(iframe.src).searchParams.get('plot')).toBe(PLOT_JSON);
    sendFrom(frame, { type: TRACE_QUERY, query: PLOT_QUERY });
    expect(onQuery).toHaveBeenCalledExactlyOnceWith(PLOT_QUERY);
  });

  it('drops an invalid or oversized query', () => {
    const onQuery = vi.fn();
    const { frame } = renderTab({ onQuery });
    sendFrom(frame, { type: TRACE_QUERY, query: 'pv=%E0%A4%A' });
    sendFrom(frame, { type: TRACE_QUERY, query: 'foo=bar' });
    sendFrom(frame, { type: TRACE_QUERY, query: `pv=${'A'.repeat(4096)}` });
    sendFrom(frame, { type: TRACE_QUERY, query: 42 });
    expect(onQuery).not.toHaveBeenCalled();
  });
});

describe('TraceTab canopy:trace-open', () => {
  it('is the contract message type', () => {
    expect(TRACE_OPEN).toBe('canopy:trace-open');
  });

  it('forwards a well-formed message from its own frame to onOpen once', () => {
    const onOpen = vi.fn();
    const onQuery = vi.fn();
    const { frame, iframe } = renderTab({ onOpen, onQuery });
    const src = iframe.src;
    sendFrom(frame, { type: TRACE_OPEN, tool: 'waveform', query: 'pv=A%3AB' });
    expect(onOpen).toHaveBeenCalledExactlyOnceWith('waveform', 'pv=A%3AB');
    expect(onQuery).not.toHaveBeenCalled();
    expect(iframe.src).toBe(src);
  });

  it('decides nothing about the tool or its query', () => {
    const onOpen = vi.fn();
    const { frame } = renderTab({ onOpen });
    sendFrom(frame, { type: TRACE_OPEN, tool: 'no-such-tool', query: 'foo=bar' });
    expect(onOpen).toHaveBeenCalledExactlyOnceWith('no-such-tool', 'foo=bar');
  });

  it('uses the latest onOpen after a rerender', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { frame, rerender } = renderTab({ onOpen: first });
    rerender({ onOpen: second });
    sendFrom(frame, { type: TRACE_OPEN, tool: 'waveform', query: 'pv=X' });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledExactlyOnceWith('waveform', 'pv=X');
  });

  it('ignores a message from another window', () => {
    const onOpen = vi.fn();
    renderTab({ onOpen });
    sendFrom(window, { type: TRACE_OPEN, tool: 'waveform', query: 'pv=X' });
    sendFrom(null, { type: TRACE_OPEN, tool: 'waveform', query: 'pv=X' });
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('ignores a message from its frame with a foreign origin', () => {
    const onOpen = vi.fn();
    const { frame } = renderTab({ onOpen });
    sendFrom(frame, { type: TRACE_OPEN, tool: 'waveform', query: 'pv=X' }, 'https://evil.example');
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('drops a malformed message', () => {
    const onOpen = vi.fn();
    const { frame } = renderTab({ onOpen });
    sendFrom(frame, { type: TRACE_OPEN, query: 'pv=X' });
    sendFrom(frame, { type: TRACE_OPEN, tool: 'waveform' });
    sendFrom(frame, { type: TRACE_OPEN, tool: 42, query: 'pv=X' });
    sendFrom(frame, { type: TRACE_OPEN, tool: 'waveform', query: null });
    sendFrom(frame, { type: TRACE_OPEN, tool: ['waveform'], query: { pv: 'X' } });
    sendFrom(frame, TRACE_OPEN);
    sendFrom(frame, null);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('is optional: without onOpen a well-formed message is ignored', () => {
    const { frame } = renderTab();
    expect(() =>
      sendFrom(frame, { type: TRACE_OPEN, tool: 'waveform', query: 'pv=X' })
    ).not.toThrow();
  });
});

describe('TraceTab canopy:quick-open', () => {
  it('is the contract message type', () => {
    expect(QUICK_OPEN).toBe('canopy:quick-open');
  });

  it('forwards a message from its own frame to onQuickOpen once, with the iframe', () => {
    const onQuickOpen = vi.fn();
    const onOpen = vi.fn();
    const onQuery = vi.fn();
    const { frame, iframe } = renderTab({ onQuickOpen, onOpen, onQuery });
    sendFrom(frame, { type: QUICK_OPEN });
    expect(onQuickOpen).toHaveBeenCalledExactlyOnceWith(iframe);
    expect(onOpen).not.toHaveBeenCalled();
    expect(onQuery).not.toHaveBeenCalled();
  });

  it('uses the latest onQuickOpen after a rerender', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { frame, iframe, rerender } = renderTab({ onQuickOpen: first });
    rerender({ onQuickOpen: second });
    sendFrom(frame, { type: QUICK_OPEN });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledExactlyOnceWith(iframe);
  });

  it('ignores a message from another window', () => {
    const onQuickOpen = vi.fn();
    renderTab({ onQuickOpen });
    sendFrom(window, { type: QUICK_OPEN });
    sendFrom(null, { type: QUICK_OPEN });
    expect(onQuickOpen).not.toHaveBeenCalled();
  });

  it('ignores a message from its frame with a foreign origin', () => {
    const onQuickOpen = vi.fn();
    const { frame } = renderTab({ onQuickOpen });
    sendFrom(frame, { type: QUICK_OPEN }, 'https://evil.example');
    expect(onQuickOpen).not.toHaveBeenCalled();
  });

  it('drops a bare string message', () => {
    const onQuickOpen = vi.fn();
    const { frame } = renderTab({ onQuickOpen });
    sendFrom(frame, QUICK_OPEN);
    expect(onQuickOpen).not.toHaveBeenCalled();
  });

  it('is optional: without onQuickOpen the message is ignored', () => {
    const { frame } = renderTab();
    expect(() => sendFrom(frame, { type: QUICK_OPEN })).not.toThrow();
  });
});

describe('TraceTab visibility', () => {
  it('is visible only when showing and on screen', () => {
    const { postSpy, rerender } = renderTab();
    expect(lastVisibility(postSpy)).not.toBe(true);
    onScreen();
    expect(lastVisibility(postSpy)).toBe(true);
    rerender({ showing: false });
    expect(lastVisibility(postSpy)).toBe(false);
    rerender({ showing: true });
    expect(lastVisibility(postSpy)).toBe(true);
    onScreen(false);
    expect(lastVisibility(postSpy)).toBe(false);
  });

  it('is hidden for a zero-size viewport', () => {
    const { postSpy } = renderTab();
    onScreen();
    expect(lastVisibility(postSpy)).toBe(true);
    act(() => {
      setViewport(0, 0);
      window.dispatchEvent(new Event('resize'));
    });
    expect(lastVisibility(postSpy)).toBe(false);
    act(() => {
      setViewport(800, 600);
      window.dispatchEvent(new Event('resize'));
    });
    expect(lastVisibility(postSpy)).toBe(true);
  });

  it('is hidden while the document is not visible', () => {
    const { postSpy } = renderTab();
    onScreen();
    act(() => {
      visibilityState = 'hidden';
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(lastVisibility(postSpy)).toBe(false);
  });

  it('posts visibility only when it changes', () => {
    const { postSpy } = renderTab();
    onScreen();
    postSpy.mockClear();
    onScreen();
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(postSpy).not.toHaveBeenCalled();
  });
});

describe('isValidTraceQuery', () => {
  it('accepts a pv or range query', () => {
    expect(isValidTraceQuery(QUERY)).toBe(true);
    expect(isValidTraceQuery('range=-1h')).toBe(true);
    expect(isValidTraceQuery('pv=A%20B')).toBe(true);
  });

  it('accepts a query with a plot config, readable or fully encoded', () => {
    expect(isValidTraceQuery(PLOT_QUERY)).toBe(true);
    expect(isValidTraceQuery(`pv=A&range=-1h&plot=${encodeURIComponent(PLOT_JSON)}`)).toBe(true);
  });

  it('rejects a non-decodable part, a missing pv/range key, non-strings and > 4 KB', () => {
    expect(isValidTraceQuery('pv=%E0%A4%A')).toBe(false);
    expect(isValidTraceQuery('%ZZ=1&pv=A')).toBe(false);
    expect(isValidTraceQuery('foo=bar')).toBe(false);
    expect(isValidTraceQuery('')).toBe(false);
    expect(isValidTraceQuery(undefined)).toBe(false);
    expect(isValidTraceQuery(`pv=${'A'.repeat(4094)}`)).toBe(false);
    expect(isValidTraceQuery(`pv=${'A'.repeat(4093)}`)).toBe(true);
  });
});

describe('TraceTab tool actions protocol', () => {
  const REPORT = {
    type: TOOL_ACTIONS,
    version: 1,
    state: '1 curve · live',
    actions: [{ id: 'import', label: 'Import…', kind: 'button', shortcut: 'primary+O' }],
    links: { docs: 'https://docs.example/' },
  };

  it('uses the contract message types', () => {
    expect(TOOL_ACTIONS).toBe('canopy:tool-actions');
    expect(TOOL_INVOKE).toBe('canopy:tool-invoke');
    expect(SAVE_VIEW).toBe('canopy:save-view');
  });

  it('stores a report per tab key', () => {
    const actionsStore = createToolActionsStore();
    const a = renderTab({ tabKey: 'trace:a', actionsStore });
    const b = renderTab({ tabKey: 'waveform:b', actionsStore });
    sendFrom(a.frame, REPORT);
    sendFrom(b.frame, { ...REPORT, state: 'paused', actions: [] });
    expect(actionsStore.get('trace:a')).toEqual({
      version: 1,
      state: '1 curve · live',
      actions: [{ id: 'import', label: 'Import…', kind: 'button', shortcut: 'primary+O' }],
      links: { docs: 'https://docs.example/' },
    });
    expect(actionsStore.get('waveform:b')).toMatchObject({ state: 'paused', actions: [] });
  });

  it('replaces a report whole', () => {
    const actionsStore = createToolActionsStore();
    const { frame } = renderTab({ tabKey: 't', actionsStore });
    sendFrom(frame, REPORT);
    sendFrom(frame, {
      type: TOOL_ACTIONS,
      version: 1,
      actions: [{ id: 'print', label: 'Print', kind: 'button' }],
    });
    expect(actionsStore.get('t')).toEqual({
      version: 1,
      actions: [{ id: 'print', label: 'Print', kind: 'button' }],
      links: {},
    });
  });

  it('keeps the last good report when a malformed one arrives', () => {
    const actionsStore = createToolActionsStore();
    const { frame } = renderTab({ tabKey: 't', actionsStore });
    sendFrom(frame, REPORT);
    const before = actionsStore.get('t');
    sendFrom(frame, { ...REPORT, version: 2 });
    sendFrom(frame, { ...REPORT, actions: 'import' });
    expect(actionsStore.get('t')).toBe(before);
  });

  it('stores nothing without a tab key', () => {
    const actionsStore = createToolActionsStore();
    const { frame } = renderTab({ actionsStore });
    sendFrom(frame, REPORT);
    expect(actionsStore.getSnapshot()).toEqual({});
  });

  it('ignores a report from a foreign source or origin', () => {
    const actionsStore = createToolActionsStore();
    const { frame } = renderTab({ tabKey: 't', actionsStore });
    sendFrom(window, REPORT);
    sendFrom(null, REPORT);
    sendFrom(frame, REPORT, 'https://evil.example');
    expect(actionsStore.get('t')).toBeNull();
  });

  it("ignores another tab's frame", () => {
    const actionsStore = createToolActionsStore();
    renderTab({ tabKey: 'a', actionsStore });
    const b = renderTab({ tabKey: 'b', actionsStore });
    sendFrom(b.frame, REPORT);
    expect(actionsStore.get('a')).toBeNull();
    expect(actionsStore.get('b')).not.toBeNull();
  });

  it("clears the report when the frame's document unloads", () => {
    const actionsStore = createToolActionsStore();
    const { frame } = renderTab({ tabKey: 't', actionsStore });
    sendFrom(frame, REPORT);
    act(() => {
      frame.dispatchEvent(new Event('pagehide'));
    });
    expect(actionsStore.get('t')).toBeNull();
  });

  it('clears the report when the tab unmounts', () => {
    const actionsStore = createToolActionsStore();
    const { frame, unmount } = renderTab({ tabKey: 't', actionsStore });
    sendFrom(frame, REPORT);
    unmount();
    expect(actionsStore.get('t')).toBeNull();
    expect(actionsStore.invoke('t', 'import')).toBe(false);
  });

  it('invoke posts the exact canopy:tool-invoke message to the right frame', () => {
    const actionsStore = createToolActionsStore();
    const a = renderTab({ tabKey: 'a', actionsStore });
    const b = renderTab({ tabKey: 'b', actionsStore });
    a.postSpy.mockClear();
    b.postSpy.mockClear();
    expect(actionsStore.invoke('b', 'export-csv')).toBe(true);
    expect(b.postSpy).toHaveBeenCalledExactlyOnceWith(
      { type: 'canopy:tool-invoke', id: 'export-csv' },
      window.location.origin
    );
    expect(a.postSpy).not.toHaveBeenCalled();
  });

  it('canopy:save-view calls onSaveView once, with the latest callback', () => {
    const first = vi.fn();
    const second = vi.fn();
    const onQuery = vi.fn();
    const { frame, rerender } = renderTab({ onSaveView: first, onQuery });
    rerender({ onSaveView: second });
    sendFrom(frame, { type: SAVE_VIEW });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
    expect(onQuery).not.toHaveBeenCalled();
  });

  it('ignores canopy:save-view from a foreign source or origin, or as a bare string', () => {
    const onSaveView = vi.fn();
    const { frame } = renderTab({ onSaveView });
    sendFrom(window, { type: SAVE_VIEW });
    sendFrom(null, { type: SAVE_VIEW });
    sendFrom(frame, { type: SAVE_VIEW }, 'https://evil.example');
    sendFrom(frame, SAVE_VIEW);
    expect(onSaveView).not.toHaveBeenCalled();
  });

  it('is optional: without onSaveView the message is ignored', () => {
    const { frame } = renderTab();
    expect(() => sendFrom(frame, { type: SAVE_VIEW })).not.toThrow();
  });
});
