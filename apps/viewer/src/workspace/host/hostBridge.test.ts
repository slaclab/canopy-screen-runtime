// hostBridge: the viewer's half of the host's header-bar contract. The
// parent is stubbed by overriding window.parent's getter; host-embedding comes
// from ?embedded=true plus that parent (hostEmbed.ts).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Node 26 shadows jsdom's storages with undefined globals; hostEmbed reads
// sessionStorage. Install in-memory stores.
vi.hoisted(() => {
  const memory = (): Storage => {
    const data = new Map<string, string>();
    return {
      get length() {
        return data.size;
      },
      clear: () => data.clear(),
      getItem: (key) => data.get(key) ?? null,
      key: (index) => [...data.keys()][index] ?? null,
      removeItem: (key) => void data.delete(key),
      setItem: (key, value) => void data.set(key, String(value)),
    };
  };
  const g = globalThis as { localStorage?: Storage; sessionStorage?: Storage };
  for (const name of ['localStorage', 'sessionStorage'] as const) {
    if (typeof g[name]?.getItem === 'function') continue;
    Object.defineProperty(globalThis, name, { configurable: true, value: memory() });
  }
});

import { resetHostEmbeddedForTests } from './hostEmbed.js';
import {
  type HeaderItem,
  contribute,
  onAction,
  resetHostBridgeForTests,
  sanitizeHeaderItems,
} from './hostBridge.js';

const postMessage = vi.fn();
const FAKE_PARENT = { postMessage } as unknown as Window;

function hostEmbed(): void {
  vi.spyOn(window, 'parent', 'get').mockReturnValue(FAKE_PARENT);
  window.history.replaceState(null, '', '/?embedded=true');
}

function lastItems(): unknown {
  const call = postMessage.mock.calls.at(-1);
  return (call?.[0] as { items: unknown }).items;
}

function send(
  source: MessageEventSource | null,
  data: unknown,
  origin = window.location.origin
): void {
  window.dispatchEvent(new MessageEvent('message', { data, origin, source }));
}

beforeEach(() => {
  resetHostEmbeddedForTests();
  resetHostBridgeForTests();
  window.sessionStorage.clear();
  postMessage.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
  resetHostEmbeddedForTests();
  resetHostBridgeForTests();
  window.sessionStorage.clear();
});

describe('contribute', () => {
  it('posts the header contribution to window.parent at location.origin', () => {
    hostEmbed();
    const items: HeaderItem[] = [
      { kind: 'text', id: 'subtitle', text: 'Trace', priority: 0 },
      { kind: 'button', id: 'search', label: 'Search', title: 'Search (⌘K)', priority: 1 },
      {
        kind: 'menu',
        id: 'more',
        priority: 0,
        items: [
          { id: 'menu:reset-layout', label: 'Reset layout' },
          { id: 'tool:import', label: 'Import', disabled: true },
          { id: 'menu:show-sub-screens', label: 'Show sub-screens', checked: false },
        ],
      },
      { kind: 'button', id: 'save-view', label: 'Save view', tone: 'accent', priority: 3 },
    ];
    contribute(items);
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith(
      { type: 'canopy-host-header-contribution', version: 1, items },
      window.location.origin
    );
  });

  it('is a no-op when not host-embedded', () => {
    // A parent but no flag: framed by something else.
    vi.spyOn(window, 'parent', 'get').mockReturnValue(FAKE_PARENT);
    contribute([{ kind: 'text', id: 'subtitle', text: 'x' }]);
    window.dispatchEvent(new Event('pagehide'));
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('is a no-op standalone (no parent) even with the flag', () => {
    window.history.replaceState(null, '', '/?embedded=true');
    contribute([{ kind: 'text', id: 'subtitle', text: 'x' }]);
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('swallows a throwing parent', () => {
    hostEmbed();
    postMessage.mockImplementationOnce(() => {
      throw new Error('cross-origin');
    });
    expect(() => contribute([{ kind: 'text', id: 'subtitle', text: 'x' }])).not.toThrow();
  });

  it('posts an empty item list on pagehide, once per pagehide', () => {
    hostEmbed();
    contribute([{ kind: 'text', id: 'subtitle', text: 'x' }]);
    contribute([{ kind: 'text', id: 'subtitle', text: 'y' }]);
    postMessage.mockReset();
    window.dispatchEvent(new Event('pagehide'));
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith(
      { type: 'canopy-host-header-contribution', version: 1, items: [] },
      window.location.origin
    );
  });

  it('sanitises before posting', () => {
    hostEmbed();
    contribute([
      { kind: 'bogus', id: 'x' } as unknown as HeaderItem,
      { kind: 'text', id: 'subtitle', text: 'a'.repeat(200) },
    ]);
    expect(lastItems()).toEqual([{ kind: 'text', id: 'subtitle', text: 'a'.repeat(120) }]);
  });
});

describe('sanitizeHeaderItems', () => {
  const button = (id: string): HeaderItem => ({ kind: 'button', id, label: id });

  it('drops unknown kinds and malformed items before capping', () => {
    const raw: unknown[] = [
      { kind: 'bogus', id: 'u1' },
      { kind: 'slider', id: 'u2' },
      null,
      'str',
      { kind: 'button', label: 'no id' },
      { kind: 'button', id: 'no-label' },
      { kind: 'text', id: 'no-text' },
      { kind: 'menu', id: 'empty', items: [] },
      ...Array.from({ length: 12 }, (_, i) => button(`b${i}`)),
    ];
    const out = sanitizeHeaderItems(raw);
    expect(out.map((i) => i.id)).toEqual(Array.from({ length: 12 }, (_, i) => `b${i}`));
  });

  it('drops a duplicate kind:id (first wins) but keeps the same id under another kind', () => {
    const out = sanitizeHeaderItems([
      { kind: 'button', id: 'a', label: 'first' },
      { kind: 'button', id: 'a', label: 'second' },
      { kind: 'text', id: 'a', text: 'other kind' },
    ]);
    expect(out).toEqual([
      { kind: 'button', id: 'a', label: 'first' },
      { kind: 'text', id: 'a', text: 'other kind' },
    ]);
  });

  it('keeps the first 12 items', () => {
    const out = sanitizeHeaderItems(Array.from({ length: 15 }, (_, i) => button(`b${i}`)));
    expect(out).toHaveLength(12);
    expect(out.at(-1)?.id).toBe('b11');
  });

  it('keeps the first 12 menu entries and drops malformed ones first', () => {
    const entries = [
      { id: 'bad' },
      { label: 'no id' },
      ...Array.from({ length: 14 }, (_, i) => ({ id: `e${i}`, label: `E${i}` })),
    ];
    const [menu] = sanitizeHeaderItems([{ kind: 'menu', id: 'more', items: entries }]);
    expect(menu.kind).toBe('menu');
    const ids = (menu as { items: { id: string }[] }).items.map((e) => e.id);
    expect(ids).toEqual(Array.from({ length: 12 }, (_, i) => `e${i}`));
  });

  it('truncates every string at 120 characters', () => {
    const long = 'x'.repeat(130);
    const cut = 'x'.repeat(120);
    const out = sanitizeHeaderItems([
      { kind: 'text', id: 't', text: long },
      { kind: 'button', id: 'b', label: long, title: long },
      { kind: 'menu', id: 'm', label: long, items: [{ id: 'e', label: long }] },
      { kind: 'search', id: 's', placeholder: long, value: long },
    ]);
    expect(out).toEqual([
      { kind: 'text', id: 't', text: cut },
      { kind: 'button', id: 'b', label: cut, title: cut },
      { kind: 'menu', id: 'm', label: cut, items: [{ id: 'e', label: cut }] },
      { kind: 'search', id: 's', placeholder: cut, value: cut },
    ]);
  });

  it('keeps menu-entry booleans as given and absent checked absent', () => {
    const [menu] = sanitizeHeaderItems([
      {
        kind: 'menu',
        id: 'more',
        items: [
          { id: 'a', label: 'A', checked: true, disabled: true },
          { id: 'b', label: 'B', checked: false },
          { id: 'c', label: 'C' },
        ],
      },
    ]);
    expect((menu as { items: unknown }).items).toEqual([
      { id: 'a', label: 'A', checked: true, disabled: true },
      { id: 'b', label: 'B', checked: false },
      { id: 'c', label: 'C' },
    ]);
  });

  it('keeps priority and button tone / disabled', () => {
    expect(
      sanitizeHeaderItems([
        {
          kind: 'button',
          id: 'save-view',
          label: 'Save view',
          tone: 'accent',
          disabled: false,
          priority: 3,
        },
      ])
    ).toEqual([
      {
        kind: 'button',
        id: 'save-view',
        label: 'Save view',
        tone: 'accent',
        disabled: false,
        priority: 3,
      },
    ]);
  });
});

describe('onAction', () => {
  it('delivers a button pick as (id, undefined)', () => {
    hostEmbed();
    const cb = vi.fn();
    const off = onAction(cb);
    send(FAKE_PARENT, { type: 'canopy-host-header-action', id: 'search' });
    expect(cb).toHaveBeenCalledWith('search', undefined);
    off();
  });

  it('delivers a menu pick as ("more", entry id)', () => {
    hostEmbed();
    const cb = vi.fn();
    const off = onAction(cb);
    send(FAKE_PARENT, { type: 'canopy-host-header-action', id: 'more', value: 'tool:import' });
    expect(cb).toHaveBeenCalledWith('more', 'tool:import');
    off();
  });

  it('ignores a foreign origin, a foreign source, other types and a non-string id', () => {
    hostEmbed();
    const cb = vi.fn();
    const off = onAction(cb);
    send(FAKE_PARENT, { type: 'canopy-host-header-action', id: 'search' }, 'https://evil.example');
    send(window, { type: 'canopy-host-header-action', id: 'search' });
    send(null, { type: 'canopy-host-header-action', id: 'search' });
    send(FAKE_PARENT, { type: 'canopy-host-header-contribution', id: 'search' });
    send(FAKE_PARENT, { type: 'canopy-host-header-action', id: 7 });
    send(FAKE_PARENT, null);
    expect(cb).not.toHaveBeenCalled();
    off();
  });

  it('drops a non-string value to undefined', () => {
    hostEmbed();
    const cb = vi.fn();
    const off = onAction(cb);
    send(FAKE_PARENT, { type: 'canopy-host-header-action', id: 'more', value: 3 });
    expect(cb).toHaveBeenCalledWith('more', undefined);
    off();
  });

  it('stops delivering after unsubscribe', () => {
    hostEmbed();
    const cb = vi.fn();
    onAction(cb)();
    send(FAKE_PARENT, { type: 'canopy-host-header-action', id: 'search' });
    expect(cb).not.toHaveBeenCalled();
  });

  it('never fires when not host-embedded', () => {
    vi.spyOn(window, 'parent', 'get').mockReturnValue(FAKE_PARENT);
    const cb = vi.fn();
    const off = onAction(cb);
    send(FAKE_PARENT, { type: 'canopy-host-header-action', id: 'search' });
    expect(cb).not.toHaveBeenCalled();
    off();
  });
});
