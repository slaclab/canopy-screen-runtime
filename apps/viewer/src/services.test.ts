// createServices: the Hare and Formula Engine endpoints are derived from the document
// base URL (the viewer may be mounted under any path prefix), and the PV
// connection status is mirrored on window.__canopy for headless consumers.

import './test/memoryStorage.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HareBackend, HareConnectionStatus } from '@slaclab/canopy-client';

interface HareOptions {
  url: string;
  reconnectDelaysMs?: number[];
  terminalCloseCodes?: number[];
  onStatusChange?: (s: HareConnectionStatus) => void;
  onBackendChange?: (backend: HareBackend) => void;
}

interface FormulaEngineOptions {
  baseUrl: string;
  reconnectDelaysMs?: number[];
  terminalCloseCodes?: number[];
}

const captured = vi.hoisted(() => ({
  hare: [] as HareOptions[],
  formulaEngine: [] as FormulaEngineOptions[],
}));

vi.mock('@slaclab/canopy-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@slaclab/canopy-client')>();
  class FakeHare extends actual.MockPVService {
    constructor(options: HareOptions) {
      super();
      captured.hare.push(options);
    }
  }
  class FakeFormulaEngine {
    constructor(options: FormulaEngineOptions) {
      captured.formulaEngine.push(options);
    }
    connect() {}
    disconnect() {}
    subscribe() {
      return () => {};
    }
  }
  return { ...actual, HarePVService: FakeHare, FormulaEngineService: FakeFormulaEngine };
});

import { createServices, fixtureKeyFromSearch, fixtureUrl, loadFixture } from './services.js';

const HARE = {
  pvMode: 'hare',
  renderMode: 'edm',
  screensPath: '.',
  themes: {},
  confirmWrites: true,
} as const;
const SIM = { name: 'example', label: 'Simulator', notice: null } as const;
const MOCK = {
  pvMode: 'mock',
  renderMode: 'edm',
  screensPath: '.',
  themes: {},
  confirmWrites: false,
} as const;

beforeEach(() => {
  captured.hare.length = 0;
  captured.formulaEngine.length = 0;
  delete window.__canopy;
});

afterEach(() => {
  delete window.__canopy;
});

describe('createServices (hare)', () => {
  it('derives the Hare ws URL from the base, under the mount prefix', () => {
    createServices({ ...HARE, themes: {} }, new URL('http://h/u/x/panel/canopy/'));
    expect(captured.hare).toHaveLength(1);
    expect(captured.hare[0].url).toBe('ws://h/u/x/panel/canopy/hare/v1/ws/pvs');
  });

  it('uses wss: for an https base and never produces a double slash', () => {
    createServices({ ...HARE, themes: {} }, new URL('https://h/canopy/'));
    expect(captured.hare[0].url).toBe('wss://h/canopy/hare/v1/ws/pvs');
    createServices({ ...HARE, themes: {} }, new URL('http://h/'));
    expect(captured.hare[1].url).toBe('ws://h/hare/v1/ws/pvs');
    expect(captured.hare[1].url).not.toContain('//hare');
  });

  it('hands the Formula Engine the base href (the Formula Engine builds its own ws URL)', () => {
    createServices({ ...HARE, themes: {} }, new URL('http://h/u/x/panel/canopy/'));
    expect(captured.formulaEngine).toEqual([
      expect.objectContaining({ baseUrl: 'http://h/u/x/panel/canopy/' }),
    ]);
  });

  it('mirrors the Hare connection status on window.__canopy.pvStatus', () => {
    createServices({ ...HARE, themes: {} }, new URL('http://h/u/x/panel/canopy/'));
    const onStatusChange = captured.hare[0].onStatusChange;
    expect(onStatusChange).toBeTypeOf('function');
    expect(window.__canopy?.pvStatus).not.toBe('mock');
    for (const status of ['connecting', 'connected', 'disconnected', 'idle'] as const) {
      onStatusChange!(status);
      expect(window.__canopy?.pvStatus).toBe(status);
    }
  });

  it('gives Hare and the Formula Engine the one reconnect schedule', () => {
    createServices({ ...HARE, themes: {} }, new URL('http://h/'));
    expect(captured.hare[0].reconnectDelaysMs).toEqual([250, 500, 1000, 2000]);
    expect(captured.formulaEngine[0].reconnectDelaysMs).toEqual([250, 500, 1000, 2000]);
  });

  it("leaves Hare and the Formula Engine on the SDK's terminal close codes (1008 stops retrying)", () => {
    createServices({ ...HARE, themes: {} }, new URL('http://h/'));
    expect(captured.hare[0].terminalCloseCodes).toBeUndefined();
    expect(captured.formulaEngine[0].terminalCloseCodes).toBeUndefined();
  });

  it('carries a backend store seeded from the config block and fed by Hare', () => {
    const services = createServices(
      { ...HARE, themes: {}, backend: SIM, binding: 'va@3' },
      new URL('http://h/')
    );
    const store = services.backend!;
    expect(store.getSnapshot()).toMatchObject({
      label: 'Simulator',
      binding: 'va@3',
      link: 'boot',
      labelSeen: true,
    });
    const { onStatusChange, onBackendChange } = captured.hare[0];
    onStatusChange!('connecting');
    expect(store.getSnapshot().link).toBe('boot');
    onStatusChange!('connected');
    expect(store.getSnapshot().link).toBe('up');
    onBackendChange!({
      name: 'example',
      label: 'Live',
      notice: 'fallback',
      binding: 'fallback',
      reachable: null,
      writes: null,
    });
    expect(store.getSnapshot()).toMatchObject({
      label: 'Live',
      notice: 'fallback',
      binding: 'fallback',
      heartbeat: true,
    });
    onStatusChange!('disconnected');
    expect(store.getSnapshot().link).toBe('down');
  });

  it('merge-assigns the badge onto window.__canopy.backend, beside pvStatus', () => {
    createServices({ ...HARE, themes: {}, backend: SIM, binding: 'va@3' }, new URL('http://h/'));
    expect(window.__canopy?.backend).toEqual({
      label: 'Simulator',
      notice: null,
      binding: 'va@3',
      link: 'boot',
    });
    const { onStatusChange, onBackendChange } = captured.hare[0];
    onStatusChange!('connected');
    expect(window.__canopy).toEqual({
      pvStatus: 'connected',
      backend: { label: 'Simulator', notice: null, binding: 'va@3', link: 'up' },
    });
    onBackendChange!({
      name: 'example',
      label: null,
      notice: 'unservable',
      binding: 'unservable',
      reachable: null,
      writes: null,
    });
    expect(window.__canopy).toEqual({
      pvStatus: 'connected',
      backend: { label: null, notice: 'unservable', binding: 'unservable', link: 'up' },
    });
  });

  it('publishPVStatus keeps keys other headless code set on window.__canopy', () => {
    window.__canopy = { other: 1 } as unknown as Window['__canopy'];
    createServices({ ...HARE, themes: {} }, new URL('http://h/'));
    captured.hare[0].onStatusChange!('connected');
    expect(window.__canopy).toMatchObject({ other: 1, pvStatus: 'connected' });
  });
});

describe('createServices (mock)', () => {
  it("sets window.__canopy.pvStatus to 'mock' immediately and builds no Hare/Formula Engine", () => {
    const services = createServices({ ...MOCK, themes: {} }, new URL('http://h/u/x/panel/canopy/'));
    // No badge in mock mode: no backend store and no window.__canopy.backend.
    expect(window.__canopy).toEqual({ pvStatus: 'mock' });
    expect(services.backend).toBeUndefined();
    expect(captured.hare).toHaveLength(0);
    expect(captured.formulaEngine).toHaveLength(0);
    expect(services.formulas).not.toBeNull();
    services.pv.disconnect();
  });
});

describe('screenScope', () => {
  it('gives each screen its own loc:// locals over the shared service', () => {
    const services = createServices({ ...MOCK, themes: {} }, new URL('http://h/'));
    const a = services.screenScope();
    const b = services.screenScope();
    a.pv.put('loc://x', 1);
    expect(a.pv.getSnapshot('loc://x')?.value).toBe(1);
    expect(b.pv.getSnapshot('loc://x')?.value).not.toBe(1);
    expect(services.pv.getSnapshot('loc://x')?.value).not.toBe(1);
    // Clearing one scope leaves the other alone.
    b.pv.put('loc://y', 2);
    a.locals.clear();
    expect(b.pv.getSnapshot('loc://y')?.value).toBe(2);
    services.pv.disconnect();
  });

  it('routes other names to the one shared Hare service', () => {
    createServices({ ...HARE, themes: {} }, new URL('http://h/')).screenScope();
    expect(captured.hare).toHaveLength(1);
    expect(captured.formulaEngine).toHaveLength(1);
  });
});

describe('createServices (fixture)', () => {
  const SNAPSHOT = {
    pvs: {
      'SYN:A': { value: 2, connected: true },
      'SYN:A.SEVR': 1,
      'SYN:B': 5,
    },
  };

  it("publishes a fixed 'connected' pvStatus and builds no Hare/Formula Engine, even in hare mode", () => {
    const services = createServices({ ...HARE, themes: {} }, new URL('http://h/x/y/'), SNAPSHOT);
    // No badge in fixture mode either, even with a hare config block.
    expect(window.__canopy).toEqual({ pvStatus: 'connected' });
    expect(services.backend).toBeUndefined();
    expect(captured.hare).toHaveLength(0);
    expect(captured.formulaEngine).toHaveLength(0);
    services.screenScope();
    expect(captured.hare).toHaveLength(0);
    expect(captured.formulaEngine).toHaveLength(0);
    services.pv.disconnect();
  });

  it('serves plain PVs from the snapshot with SEVR as severity, and loc:// locally', () => {
    const services = createServices({ ...MOCK, themes: {} }, new URL('http://h/'), SNAPSHOT);
    const scope = services.screenScope();
    expect(scope.pv.getSnapshot('SYN:A')).toMatchObject({ value: 2, severity: 1, connected: true });
    expect(scope.pv.getSnapshot('SYN:MISSING')?.connected).toBe(false);
    scope.pv.put('loc://x', 3);
    expect(scope.pv.getSnapshot('loc://x')?.value).toBe(3);
    services.pv.disconnect();
  });

  it('evaluates gateway formulas locally in every screen scope', () => {
    const services = createServices({ ...MOCK, themes: {} }, new URL('http://h/'), SNAPSHOT);
    const results: unknown[] = [];
    services
      .screenScope()
      .formulas!.subscribe(
        { kind: 'scalar', expression: '{a} * {b}', bindings: { a: 'SYN:A', b: 'SYN:B' } },
        { onResult: (v) => results.push(v) }
      );
    services.formulas!.subscribe(
      { kind: 'scalar', expression: '{a} + 1', bindings: { a: 'SYN:A' } },
      { onResult: (v) => results.push(v) }
    );
    expect(results).toEqual([10, 3]);
    services.pv.disconnect();
  });
});

describe('fixture selection', () => {
  it('latches only _canopyPv=fixture with a key', () => {
    expect(fixtureKeyFromSearch('')).toBeNull();
    expect(fixtureKeyFromSearch('?_canopyPv=mock&_canopyFixture=k')).toBeNull();
    expect(fixtureKeyFromSearch('?_canopyPv=fixture&_canopyFixture=k1')).toBe('k1');
    expect(fixtureKeyFromSearch(new URLSearchParams('_canopyPv=fixture&_canopyFixture=a b'))).toBe(
      'a b'
    );
    expect(() => fixtureKeyFromSearch('?_canopyPv=fixture')).toThrow(/_canopyFixture/);
  });

  it('resolves the snapshot under the base, with the key encoded', () => {
    expect(fixtureUrl('k1', new URL('http://h/x/y/')).href).toBe('http://h/x/y/__fixture/k1.json');
    expect(fixtureUrl('a/../b', new URL('http://h/x/y/')).href).toBe(
      'http://h/x/y/__fixture/a%2F..%2Fb.json'
    );
  });

  it('fetches and validates the snapshot', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ pvs: { X: 1 } })));
    await expect(loadFixture('k', new URL('http://h/x/'), fetchImpl)).resolves.toEqual({
      pvs: { X: { value: 1 } },
    });
    expect(fetchImpl).toHaveBeenCalledWith('http://h/x/__fixture/k.json', expect.anything());
  });

  it('fails loudly on a missing or malformed snapshot', async () => {
    const missing = vi.fn(async () => new Response('nope', { status: 404 }));
    await expect(loadFixture('k', new URL('http://h/'), missing)).rejects.toThrow(/404/);
    const bad = vi.fn(async () => new Response(JSON.stringify({ values: {} })));
    await expect(loadFixture('k', new URL('http://h/'), bad)).rejects.toThrow(/fixture/);
  });
});
