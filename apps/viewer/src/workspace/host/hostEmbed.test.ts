// isHostEmbedded: `?embedded=true` AND a parent window, latched at first call
// and carried across a flag-less reload through sessionStorage. The parent is
// stubbed by overriding window.parent's getter; the query by replaceState.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Node 26 defines a global `localStorage`/`sessionStorage` that is undefined
// without --localstorage-file and shadows jsdom's; canopy-shell's theme store
// (reached through TraceTab) reads it at import. Install in-memory stores.
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

import {
  HOST_EMBEDDED_CLASS,
  applyHostEmbeddedClass,
  isHostEmbedded,
  resetHostEmbeddedForTests,
} from './hostEmbed.js';
import { traceSrc } from '../TraceTab.js';
import {
  HOST_SHELL_CAPABILITIES,
  STANDALONE_CAPABILITIES,
  embeddedCapabilities,
} from './hostCapabilities.js';

const FAKE_PARENT = {} as Window;

function stubParent(): void {
  vi.spyOn(window, 'parent', 'get').mockReturnValue(FAKE_PARENT);
}

function at(url: string): void {
  window.history.replaceState(null, '', url);
}

// The viewer's index.html carries a <base> at its mount, so document.baseURI
// stays put while the router rewrites the path below it.
const MOUNT = '/u/alice/panel/canopy/';
let base: HTMLBaseElement | null = null;

function mountAt(): void {
  base = document.createElement('base');
  base.href = `${window.location.origin}${MOUNT}`;
  document.head.appendChild(base);
}

beforeEach(() => {
  resetHostEmbeddedForTests();
  window.sessionStorage.clear();
  document.body.classList.remove(HOST_EMBEDDED_CLASS);
});

afterEach(() => {
  base?.remove();
  base = null;
  vi.restoreAllMocks();
  at('/');
  resetHostEmbeddedForTests();
  window.sessionStorage.clear();
  document.body.classList.remove(HOST_EMBEDDED_CLASS);
});

describe('isHostEmbedded', () => {
  it('is true with ?embedded=true and a parent window', () => {
    stubParent();
    at('/?embedded=true');
    expect(isHostEmbedded()).toBe(true);
  });

  it('is false with ?embedded=true but no parent window', () => {
    at('/?embedded=true');
    expect(isHostEmbedded()).toBe(false);
    expect(window.sessionStorage.length).toBe(0);
  });

  it('is false in a parent window without the flag', () => {
    stubParent();
    at('/?embedded=false');
    expect(isHostEmbedded()).toBe(false);
  });

  it('is false with neither', () => {
    at('/');
    expect(isHostEmbedded()).toBe(false);
  });

  it('is latched: the URL writer dropping the flag does not change it', () => {
    stubParent();
    at('/?embedded=true');
    expect(isHostEmbedded()).toBe(true);
    at('/screen/x');
    expect(isHostEmbedded()).toBe(true);
  });

  it('is latched negative too', () => {
    at('/');
    expect(isHostEmbedded()).toBe(false);
    stubParent();
    at('/?embedded=true');
    expect(isHostEmbedded()).toBe(false);
  });

  it('survives a flag-less reload in the frame through sessionStorage (fresh module)', async () => {
    mountAt();
    stubParent();
    at(`${MOUNT}?embedded=true`);
    expect(isHostEmbedded()).toBe(true);

    // A replace navigation / reload: a fresh page (fresh module), no flag.
    at(`${MOUNT}screen/x`);
    vi.resetModules();
    const fresh = await import('./hostEmbed.js');
    expect(fresh.isHostEmbedded()).toBe(true);
  });

  it('does not read the stored answer outside a frame', async () => {
    mountAt();
    stubParent();
    at(`${MOUNT}?embedded=true`);
    expect(isHostEmbedded()).toBe(true);
    vi.restoreAllMocks();

    at(`${MOUNT}screen/x`);
    vi.resetModules();
    const fresh = await import('./hostEmbed.js');
    expect(fresh.isHostEmbedded()).toBe(false);
  });

  it('keys the stored answer under the base path', async () => {
    mountAt();
    stubParent();
    at(`${MOUNT}?embedded=true`);
    expect(isHostEmbedded()).toBe(true);
    expect(window.sessionStorage.getItem('canopy-viewer:host-embedded:/u/alice/panel/canopy')).toBe(
      '1'
    );
    expect(window.sessionStorage.getItem('canopy-viewer:host-embedded:/')).toBeNull();

    // Another mount on the same origin does not inherit it.
    base!.href = `${window.location.origin}/u/bob/panel/canopy/`;
    at('/u/bob/panel/canopy/');
    vi.resetModules();
    const fresh = await import('./hostEmbed.js');
    expect(fresh.isHostEmbedded()).toBe(false);
  });
});

describe('applyHostEmbeddedClass', () => {
  it('adds body.embedded when host-embedded', () => {
    stubParent();
    at('/?embedded=true');
    applyHostEmbeddedClass();
    expect(document.body.classList.contains(HOST_EMBEDDED_CLASS)).toBe(true);
    expect(HOST_EMBEDDED_CLASS).toBe('embedded');
  });

  it('leaves body alone otherwise', () => {
    at('/?embedded=true');
    applyHostEmbeddedClass();
    expect(document.body.classList.contains('embedded')).toBe(false);
  });
});

describe('embeddedCapabilities', () => {
  it('is the host shell when host-embedded', () => {
    stubParent();
    at('/?embedded=true');
    expect(embeddedCapabilities()).toEqual(HOST_SHELL_CAPABILITIES);
  });

  it('is standalone when not host-embedded', () => {
    at('/?embedded=true');
    expect(embeddedCapabilities()).toEqual(STANDALONE_CAPABILITIES);
  });
});

describe('traceSrc hostbar=1', () => {
  it('appends hostbar=1 when the host owns the header, and only then', () => {
    const url = new URL(traceSrc('trace/', 'pv=A', 'dark', 'dark', true));
    expect(url.searchParams.get('hostbar')).toBe('1');
    expect(url.searchParams.get('embedded')).toBe('true');
    expect(url.searchParams.get('pv')).toBe('A');
    const plain = new URL(traceSrc('trace/', 'pv=A', 'dark'));
    expect(plain.searchParams.has('hostbar')).toBe(false);
    expect(plain.href).not.toContain('hostbar');
  });
});
