// loadConfig: runtime config comes from `config.json` next to the app, so one
// build serves any mount path. A missing/unparseable file (dev server, no
// canopy_mcp) means mock mode; a served file without a known pvMode means the
// deployment is live, so it defaults to hare.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canopyDefaultFlat } from '@slaclab/canopy-screen-ir';
import {
  FALLBACK_CONFIG,
  createConfirmWritesSource,
  loadConfig,
  parseCollections,
  parseColorScheme,
  parseHome,
  readConfirmWrites,
} from './config.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('loadConfig', () => {
  let fetchImpl: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches config.json relative to document.baseURI', async () => {
    fetchImpl.mockResolvedValue(
      jsonResponse({ pvMode: 'mock', screensPath: 'screens', themes: {} })
    );
    await loadConfig();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0][0])).toBe(new URL('config.json', document.baseURI).href);
  });

  it('resolves config.json under a sub-path base', async () => {
    fetchImpl.mockResolvedValue(jsonResponse({ pvMode: 'hare' }));
    await loadConfig('https://host/canopy/viewer/');
    expect(String(fetchImpl.mock.calls[0][0])).toBe('https://host/canopy/viewer/config.json');
  });

  it('returns the served values', async () => {
    fetchImpl.mockResolvedValue(
      jsonResponse({
        pvMode: 'mock',
        screensPath: '../screens',
        themes: { 'vacuum-system': 'dark', 'rf-overview': 'light' },
      })
    );
    expect(await loadConfig()).toEqual({
      pvMode: 'mock',
      renderMode: 'edm',
      screensPath: '../screens',
      themes: { 'vacuum-system': 'dark', 'rf-overview': 'light' },
      confirmWrites: false,
    });
  });

  it('carries no baseUrl and no key', async () => {
    fetchImpl.mockResolvedValue(
      jsonResponse({ pvMode: 'hare', screensPath: '.', baseUrl: 'https://x', apiKey: 'secret' })
    );
    const config = await loadConfig();
    expect(Object.keys(config).sort()).toEqual([
      'confirmWrites',
      'pvMode',
      'renderMode',
      'screensPath',
      'themes',
    ]);
  });

  it('falls back to mock on 404', async () => {
    fetchImpl.mockResolvedValue(new Response('not found', { status: 404 }));
    expect(await loadConfig()).toEqual({
      pvMode: 'mock',
      renderMode: 'edm',
      themes: {},
      screensPath: '.',
      confirmWrites: false,
    });
  });

  it('falls back to mock on a parse error (dev server serves index.html)', async () => {
    fetchImpl.mockResolvedValue(
      new Response('<!doctype html><html></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      })
    );
    expect(await loadConfig()).toEqual(FALLBACK_CONFIG);
  });

  it('falls back to mock when the served JSON is not an object', async () => {
    fetchImpl.mockResolvedValue(jsonResponse('[1, 2]'));
    expect(await loadConfig()).toEqual(FALLBACK_CONFIG);
  });

  it('falls back to mock when fetch rejects', async () => {
    fetchImpl.mockRejectedValue(new TypeError('network down'));
    expect(await loadConfig()).toEqual(FALLBACK_CONFIG);
  });

  it('returns a fresh fallback object each time', async () => {
    fetchImpl.mockResolvedValue(new Response('', { status: 404 }));
    const a = await loadConfig();
    a.themes['x'] = 'dark';
    const b = await loadConfig();
    expect(b.themes).toEqual({});
    expect(FALLBACK_CONFIG.themes).toEqual({});
  });

  describe('pvMode rule for a served config', () => {
    it('treats a missing pvMode as hare', async () => {
      fetchImpl.mockResolvedValue(jsonResponse({ screensPath: '.' }));
      expect((await loadConfig()).pvMode).toBe('hare');
    });

    it('treats an unknown pvMode as hare', async () => {
      fetchImpl.mockResolvedValue(jsonResponse({ pvMode: 'live' }));
      expect((await loadConfig()).pvMode).toBe('hare');
    });

    it('treats a non-string pvMode as hare', async () => {
      fetchImpl.mockResolvedValue(jsonResponse({ pvMode: 1 }));
      expect((await loadConfig()).pvMode).toBe('hare');
    });

    it('keeps an explicit mock', async () => {
      fetchImpl.mockResolvedValue(jsonResponse({ pvMode: 'mock' }));
      expect((await loadConfig()).pvMode).toBe('mock');
    });

    it('keeps an explicit hare', async () => {
      fetchImpl.mockResolvedValue(jsonResponse({ pvMode: 'hare' }));
      expect((await loadConfig()).pvMode).toBe('hare');
    });

    it('an empty served object is hare with defaults', async () => {
      fetchImpl.mockResolvedValue(jsonResponse({}));
      expect(await loadConfig()).toEqual({
        pvMode: 'hare',
        renderMode: 'edm',
        screensPath: '.',
        themes: {},
        confirmWrites: true,
      });
    });
  });

  describe('field validation', () => {
    it('defaults a missing or non-string screensPath to "."', async () => {
      fetchImpl.mockResolvedValue(jsonResponse({ pvMode: 'hare', screensPath: 42 }));
      expect((await loadConfig()).screensPath).toBe('.');
    });

    it('drops theme entries that are not light or dark', async () => {
      fetchImpl.mockResolvedValue(
        jsonResponse({ themes: { a: 'dark', b: 'blue', c: 3, d: 'light' } })
      );
      expect((await loadConfig()).themes).toEqual({ a: 'dark', d: 'light' });
    });

    it('ignores a themes value that is not an object', async () => {
      fetchImpl.mockResolvedValue(jsonResponse({ themes: ['dark'] }));
      expect((await loadConfig()).themes).toEqual({});
    });
  });

  describe('backend and binding (hare mode: DATA identity)', () => {
    it('are omitted when the served config has neither (mock mode, older server)', async () => {
      fetchImpl.mockResolvedValue(jsonResponse({ pvMode: 'hare' }));
      const config = await loadConfig();
      expect('backend' in config).toBe(false);
      expect('binding' in config).toBe(false);
    });

    it('keep the served identity', async () => {
      fetchImpl.mockResolvedValue(
        jsonResponse({
          pvMode: 'hare',
          backend: { name: 'example', label: 'Simulator', notice: null },
          binding: 'va@3',
        })
      );
      const config = await loadConfig();
      expect(config.backend).toEqual({ name: 'example', label: 'Simulator', notice: null });
      expect(config.binding).toBe('va@3');
    });

    it.each(['fallback', 'unservable'] as const)('keep the notice token %s', async (notice) => {
      fetchImpl.mockResolvedValue(
        jsonResponse({ backend: { name: 'example', label: 'Live', notice }, binding: notice })
      );
      const config = await loadConfig();
      expect(config.backend).toEqual({ name: 'example', label: 'Live', notice });
      expect(config.binding).toBe(notice);
    });

    it('keep a backend and binding served as null (DATA unreachable)', async () => {
      fetchImpl.mockResolvedValue(jsonResponse({ pvMode: 'hare', backend: null, binding: null }));
      const config = await loadConfig();
      expect(config.backend).toBeNull();
      expect(config.binding).toBeNull();
    });

    it('null the fields of a backend that are not of their type', async () => {
      fetchImpl.mockResolvedValue(
        jsonResponse({ backend: { name: 7, label: ['x'], notice: 'loud' }, binding: 'va@1' })
      );
      expect((await loadConfig()).backend).toEqual({ name: null, label: null, notice: null });
    });

    it.each([
      ['a string', 'example'],
      ['an array', [{ label: 'x' }]],
      ['a number', 3],
    ])('read a backend that is %s as null', async (_label, backend) => {
      fetchImpl.mockResolvedValue(jsonResponse({ backend }));
      expect((await loadConfig()).backend).toBeNull();
    });

    it('read a binding that is not a string as null', async () => {
      fetchImpl.mockResolvedValue(jsonResponse({ binding: 42 }));
      expect((await loadConfig()).binding).toBeNull();
    });
  });

  describe('trace', () => {
    it('is omitted when the served config has none', async () => {
      fetchImpl.mockResolvedValue(jsonResponse({ pvMode: 'hare' }));
      expect('trace' in (await loadConfig())).toBe(false);
    });

    it('is omitted from the fallback config', async () => {
      fetchImpl.mockResolvedValue(new Response('', { status: 404 }));
      expect('trace' in (await loadConfig())).toBe(false);
      expect('trace' in FALLBACK_CONFIG).toBe(false);
    });

    it('keeps path and query when both are valid', async () => {
      fetchImpl.mockResolvedValue(
        jsonResponse({ trace: { path: 'trace/', query: 'pv=A&range=-1h' } })
      );
      expect((await loadConfig()).trace).toEqual({ path: 'trace/', query: 'pv=A&range=-1h' });
    });

    it.each([
      ['an empty path', { path: '', query: 'pv=A' }],
      ['a non-string path', { path: 3, query: 'pv=A' }],
      ['a missing path', { query: 'pv=A' }],
      ['a non-object trace', 'trace/'],
      ['an array trace', ['trace/']],
      ['a null trace', null],
    ])('is omitted for %s', async (_label, trace) => {
      fetchImpl.mockResolvedValue(jsonResponse({ pvMode: 'hare', trace }));
      const config = await loadConfig();
      expect('trace' in config).toBe(false);
      expect(Object.keys(config).sort()).toEqual([
        'confirmWrites',
        'pvMode',
        'renderMode',
        'screensPath',
        'themes',
      ]);
    });

    it.each([
      ['missing', undefined],
      ['not a string', 42],
      ['null', null],
      ['longer than 4 KB', 'pv=' + 'A'.repeat(4096)],
    ])('defaults a query that is %s to an empty string', async (_label, query) => {
      fetchImpl.mockResolvedValue(jsonResponse({ trace: { path: 'trace/', query } }));
      expect((await loadConfig()).trace).toEqual({ path: 'trace/', query: '' });
    });

    it('accepts a query of exactly 4 KB', async () => {
      const query = 'pv=' + 'A'.repeat(4096 - 3);
      fetchImpl.mockResolvedValue(jsonResponse({ trace: { path: 'trace/', query } }));
      expect((await loadConfig()).trace).toEqual({ path: 'trace/', query });
    });

    it('measures the 4 KB limit in UTF-8 bytes', async () => {
      // 2048 two-byte characters = 4096 bytes (ok); one more is over.
      const ok = '\u00e9'.repeat(2048);
      fetchImpl.mockResolvedValue(jsonResponse({ trace: { path: 'trace/', query: ok } }));
      expect((await loadConfig()).trace?.query).toBe(ok);
      fetchImpl.mockResolvedValue(
        jsonResponse({ trace: { path: 'trace/', query: ok + '\u00e9' } })
      );
      expect((await loadConfig()).trace?.query).toBe('');
    });

    it('carries only path and query', async () => {
      fetchImpl.mockResolvedValue(
        jsonResponse({ trace: { path: 'trace/', query: '', extra: 'x' } })
      );
      expect(Object.keys((await loadConfig()).trace ?? {}).sort()).toEqual(['path', 'query']);
    });
  });
});

describe('loadConfig views', () => {
  afterEach(() => vi.unstubAllGlobals());

  function serve(body: unknown) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }))
    );
  }

  it('keeps a views path', async () => {
    serve({ pvMode: 'hare', views: { path: 'views' } });
    expect((await loadConfig('http://h/')).views).toEqual({ path: 'views' });
  });

  it.each([undefined, {}, { path: '' }, { path: 3 }, 'views'])(
    'omits views for %j',
    async (views) => {
      serve({ pvMode: 'hare', views });
      expect('views' in (await loadConfig('http://h/'))).toBe(false);
    }
  );
});

describe('loadConfig collections', () => {
  afterEach(() => vi.unstubAllGlobals());

  function serve(body: unknown) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }))
    );
  }

  it('keeps a collections path', async () => {
    serve({ pvMode: 'hare', collections: { path: 'collections' } });
    expect((await loadConfig('http://h/')).collections).toEqual({ path: 'collections' });
  });

  it.each([undefined, null, {}, { path: '' }, { path: 3 }, 'collections', ['collections']])(
    'omits collections for %j',
    async (collections) => {
      serve({ pvMode: 'hare', collections });
      expect('collections' in (await loadConfig('http://h/'))).toBe(false);
    }
  );

  it('is absent from the fallback config', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 404 }))
    );
    expect('collections' in (await loadConfig('http://h/'))).toBe(false);
  });
});

describe('parseCollections', () => {
  it('carries only the path', () => {
    expect(parseCollections({ path: 'collections', extra: 1 })).toEqual({ path: 'collections' });
  });

  it.each([undefined, null, 3, 'collections', [], {}, { path: '' }, { path: null }])(
    'rejects %j',
    (raw) => {
      expect(parseCollections(raw)).toBeUndefined();
    }
  );
});

// colorScheme: the flattened scheme canopy_mcp serves in config.json. It is
// checked with screen-ir's parseFlatScheme; anything that fails falls back to
// the bundled canopy-default with exactly one warning, a server fallback
// (meta.errors non-empty) is used as served with exactly one warning, and an
// older config without the key silently gets the bundled default.
function scheme(overrides: Record<string, unknown> = {}) {
  return {
    roles: ['Text', 'Display_Background'],
    light: ['#123456', '#ffffff'],
    dark: ['#abcdef', '#000000'],
    meta: {
      id: 'site-scheme',
      sha256: 'a'.repeat(64),
      flatHash: 'site-hash',
      served: 'site-scheme',
      errors: [],
    },
    ...overrides,
  };
}

describe('parseColorScheme', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('passes a valid scheme through without a warning', () => {
    const parsed = parseColorScheme(scheme());
    expect(parsed).toEqual(scheme());
    expect(parsed.meta.flatHash).toBe('site-hash');
    expect(warn).not.toHaveBeenCalled();
  });

  it('falls back to canopy-default with one warning on unequal lengths', () => {
    const parsed = parseColorScheme(scheme({ light: ['#123456'] }));
    expect(parsed).toBe(canopyDefaultFlat);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/equal length/);
  });

  it.each([
    ['a non-object', 'scheme'],
    ['a bad colour', scheme({ light: ['#123456', 'white'] })],
    ['a missing meta', scheme({ meta: undefined })],
  ])('falls back with one warning on %s', (_label, raw) => {
    expect(parseColorScheme(raw)).toBe(canopyDefaultFlat);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('uses a server fallback with errors, warning once', () => {
    const served = scheme({
      meta: {
        id: null,
        sha256: null,
        flatHash: 'default-hash',
        served: 'canopy-default',
        errors: [
          { path: '/roles/Text', message: 'bad colour' },
          { path: '/name', message: 'missing' },
        ],
      },
    });
    const parsed = parseColorScheme(served);
    expect(parsed.meta.flatHash).toBe('default-hash');
    expect(parsed.meta.errors).toHaveLength(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/bad colour/);
  });

  it('gives the bundled default without a warning when the key is missing', () => {
    expect(parseColorScheme(undefined)).toBe(canopyDefaultFlat);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('loadConfig colorScheme', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
    vi.unstubAllGlobals();
  });

  it('carries a served scheme', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ pvMode: 'hare', colorScheme: scheme() }))
    );
    const config = await loadConfig();
    expect(config.colorScheme).toEqual(scheme());
    expect(warn).not.toHaveBeenCalled();
  });

  it('replaces an invalid served scheme with the bundled default, warning once', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ pvMode: 'hare', colorScheme: scheme({ dark: [] }) }))
    );
    const config = await loadConfig();
    expect(config.colorScheme).toBe(canopyDefaultFlat);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('omits the key for an old config, with no warning', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ pvMode: 'hare' })));
    const config = await loadConfig();
    expect('colorScheme' in config).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('confirmWrites', () => {
  let fetchImpl: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is true in hare mode unless the server says literally false', async () => {
    for (const [served, want] of [
      [undefined, true],
      [true, true],
      [false, false],
      [0, true],
      ['false', true],
      [null, true],
    ] as const) {
      const body: Record<string, unknown> = { pvMode: 'hare' };
      if (served !== undefined) body.confirmWrites = served;
      fetchImpl.mockResolvedValueOnce(jsonResponse(body));
      expect((await loadConfig()).confirmWrites, JSON.stringify(served)).toBe(want);
    }
  });

  it('is false in mock mode, even when the server says true', async () => {
    fetchImpl.mockResolvedValue(jsonResponse({ pvMode: 'mock', confirmWrites: true }));
    expect((await loadConfig()).confirmWrites).toBe(false);
  });

  it('is false in the fallback config', async () => {
    fetchImpl.mockResolvedValue(new Response('nope', { status: 404 }));
    expect((await loadConfig()).confirmWrites).toBe(false);
    expect(FALLBACK_CONFIG.confirmWrites).toBe(false);
  });

  it('re-reads past the HTTP cache; null when no usable config is served', async () => {
    fetchImpl.mockResolvedValueOnce(jsonResponse({ pvMode: 'hare', confirmWrites: false }));
    expect(await readConfirmWrites('https://host/v/')).toBe(false);
    expect(String(fetchImpl.mock.calls[0][0])).toBe('https://host/v/config.json');
    expect(fetchImpl.mock.calls[0][1]).toEqual({ cache: 'no-store' });
    fetchImpl.mockResolvedValueOnce(new Response('x', { status: 503 }));
    expect(await readConfirmWrites('https://host/v/')).toBeNull();
    fetchImpl.mockRejectedValueOnce(new TypeError('network'));
    expect(await readConfirmWrites('https://host/v/')).toBeNull();
  });
});

describe('createConfirmWritesSource', () => {
  function deferred<T>() {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  it('reads the initial value until a re-read', () => {
    const src = createConfirmWritesSource(false, () => Promise.resolve(true));
    expect(src.current()).toBe(false);
    expect(src.state()).toBe('ready');
  });

  it('reads true while a re-read is pending, then the re-read value', async () => {
    const d = deferred<boolean | null>();
    const src = createConfirmWritesSource(false, () => d.promise);
    const done = src.reread();
    expect(src.state()).toBe('pending');
    expect(src.current()).toBe(true);
    d.resolve(false);
    await done;
    expect(src.state()).toBe('ready');
    expect(src.current()).toBe(false);
  });

  it('reads true after a failed re-read (null or a rejection), until one succeeds', async () => {
    const answers: Array<() => Promise<boolean | null>> = [
      () => Promise.resolve(null),
      () => Promise.reject(new Error('down')),
      () => Promise.resolve(false),
    ];
    const src = createConfirmWritesSource(false, () => answers.shift()!());
    await src.reread();
    expect([src.state(), src.current()]).toEqual(['failed', true]);
    await src.reread();
    expect([src.state(), src.current()]).toEqual(['failed', true]);
    await src.reread();
    expect([src.state(), src.current()]).toEqual(['ready', false]);
  });

  it('lets the latest of overlapping re-reads win', async () => {
    const first = deferred<boolean | null>();
    const second = deferred<boolean | null>();
    const queue = [first, second];
    const src = createConfirmWritesSource(true, () => queue.shift()!.promise);
    const a = src.reread();
    const b = src.reread();
    second.resolve(false);
    await b;
    first.resolve(null);
    await a;
    expect([src.state(), src.current()]).toEqual(['ready', false]);
  });
});

describe('home (first-open home screen)', () => {
  let fetchImpl: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps a served home screen id', async () => {
    fetchImpl.mockResolvedValue(jsonResponse({ pvMode: 'hare', home: { screen: 'sr/overview' } }));
    expect((await loadConfig()).home).toEqual({ screen: 'sr/overview' });
  });

  it('omits the key when the server does not declare a home', async () => {
    fetchImpl.mockResolvedValue(jsonResponse({ pvMode: 'hare' }));
    expect('home' in (await loadConfig())).toBe(false);
  });

  it('omits the key for a malformed home', async () => {
    for (const home of [
      null,
      'sr/overview',
      7,
      [],
      {},
      { screen: '' },
      { screen: '   ' },
      { screen: 3 },
    ]) {
      fetchImpl.mockResolvedValue(jsonResponse({ pvMode: 'hare', home }));
      expect('home' in (await loadConfig())).toBe(false);
    }
  });

  it('parseHome drops extra fields', () => {
    expect(parseHome({ screen: 'a/b', extra: 1 })).toEqual({ screen: 'a/b' });
    expect(parseHome(undefined)).toBeUndefined();
  });

  it('the fallback config has no home', () => {
    expect('home' in FALLBACK_CONFIG).toBe(false);
  });
});

describe('loadConfig render mode', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const served = (body: unknown) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(body)));
    return loadConfig();
  };

  it("defaults to 'edm', served or not", async () => {
    expect(FALLBACK_CONFIG.renderMode).toBe('edm');
    expect((await served({ pvMode: 'hare' })).renderMode).toBe('edm');
  });

  it('reads renderMode', async () => {
    expect((await served({ renderMode: 'carbon' })).renderMode).toBe('carbon');
    expect((await served({ renderMode: 'edm' })).renderMode).toBe('edm');
  });

  it("falls back to 'edm' for an unknown mode", async () => {
    expect((await served({ renderMode: 'legacy' })).renderMode).toBe('edm');
  });
});
