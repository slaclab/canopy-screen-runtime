// useCollections: the collections client and Open all, against the real tabs
// reducer with a fake persistence. Pinned here: the wire
// contract (URLs, exact op bodies), refetch on mount/focus, state answers
// applied in request order only, the shown selection, the inline notices of
// 409/413 and the quiet failure of `recent`, Recent held back while the
// pointer is in its branch, Open all (plan, one `openSet` through the real
// holder: tabs per tile as saved, skipped members pruned, side by side for a
// layout-less collection with its fallback notice, refused collections and
// layouts leaving the dock unchanged, Reset-style persistence, one tile
// without chrome), the once-only `_canopyOpen` run and the rendered member keys;
// the conditional-write client: rev/raw/rawIndex, conditional PUT/DELETE with typed
// 412/428 results, write answers applied at once, per-id and state chains,
// and refresh() skipping GETs while a write or a state POST is in flight;
// the conditional poll (If-None-Match, a 304 renders nothing, every
// COLLECTIONS_POLL_MS only while the root is in view, none while a write is in
// flight) and holdCollection buffering a held collection's listing; Recent
// as history: openMember, Open all's `recent-many` (the plan's opened
// members in display order, at most MAX_RECENT), the mount record of a fresh
// URL (none on a reload), Remove / Clear recent shown through the hover hold,
// and Open all's k of N from the plan; the edit gestures (edit and
// deleteCollection under the captured rev) and their Undo sequences: re-PUT
// under the returned rev, re-create with If-None-Match: * then tick.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { useReducer, useRef } from 'react';
import type { ManifestScreen } from '../api.js';
import { memberKey, renamed, withoutMember } from './collections.js';
import type { Member } from './collections.js';
import { EMPTY_TABS, TOO_MANY_FOR_SIDE, stepTabs, tabsReducer } from './tabs.js';
import type { TabsState } from './tabs.js';
import {
  COLLECTIONS_POLL_MS,
  NO_LAYOUT,
  SIDE_NOTICE,
  parseCollection,
  shownSelection,
  stateUrl,
  collectionsUrl,
  conflictReason,
  CollectionsError,
  freeId,
  MAX_RECENT,
  MAX_SAVE_RETRIES,
  screenMemberOfKey,
  upsertCollection,
  useCollections,
  withoutOpenParam,
} from './useCollections.js';
import type {
  CollectionsApi,
  OpenAllOptions,
  OpenAllResult,
  UseCollectionsOptions,
} from './useCollections.js';
import { keysOf } from '@slaclab/canopy-dock-engine';

const BASE = 'http://h/embed/';
const LIST_URL = 'http://h/embed/collections';
const STATE_URL = 'http://h/embed/collections-state';

function entry(category: string, id: string, kind = 'ir'): ManifestScreen {
  return { id, kind, title: id, category, path: `screens/${category}/${id}.screen.json` };
}

const SCREENS: ManifestScreen[] = [
  entry('library', 'sr/overview'),
  entry('library', 's3-promo/promotion'),
  entry('library', 'gtb/GTLView'),
  entry('examples', 'legacy', 'code'),
  entry('@tools', 'hidden'),
];

const SR: Member = { screen: 'library/sr/overview' };
const PROMO: Member = { screen: 'library/s3-promo/promotion' };
const GTL: Member = { screen: 'library/gtb/GTLView' };
const CURRENT: Member = { tool: 'trace', query: 'pv=A:B&range=-1h', name: 'Beam current' };

const LIST = {
  collections: [
    {
      source: 'facility',
      ref: 'facility:control',
      id: 'control',
      name: 'Control',
      members: [SR, { tool: 'trace', name: 'Trace' }],
      default: true,
      updated: '2026-10-16T00:00:00+00:00',
    },
    {
      source: 'facility',
      ref: 'facility:injector',
      id: 'injector',
      name: 'Injector',
      members: [GTL],
      default: true,
    },
    {
      source: 'facility',
      ref: 'facility:spare',
      id: 'spare',
      name: 'Spare',
      members: [PROMO],
    },
    {
      source: 'personal',
      ref: 'personal:grid',
      id: 'grid',
      rev: '0123456789abcdef',
      name: 'Ring grid',
      members: [SR, PROMO, CURRENT],
      layout: { split: 'row', items: [{ tabs: [0, 1], showing: 1 }, { tabs: [2] }] },
    },
    {
      source: 'personal',
      ref: 'personal:mine',
      id: 'mine',
      rev: 'fedcba9876543210',
      name: 'Mine',
      members: [{ screen: 'library/missing/x' }, PROMO],
    },
  ],
};

const STATE = {
  ticked: ['personal:mine', 'personal:gone'],
  unticked: ['facility:injector'],
  pinned: [CURRENT],
  recent: [PROMO, { screen: 'drafts/bts/view' }],
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface Deferred {
  promise: Promise<Response>;
  resolve: (r: Response) => void;
}

function deferred(): Deferred {
  let resolve!: (r: Response) => void;
  const promise = new Promise<Response>((r) => (resolve = r));
  return { promise, resolve };
}

type Route = (url: string, init: RequestInit | undefined) => Promise<Response> | Response;

let fetchMock: ReturnType<typeof vi.fn<(url: string, init?: RequestInit) => Promise<Response>>>;
let route: Route;

function defaultRoute(url: string, init: RequestInit | undefined): Response {
  if (url === LIST_URL) return json(LIST);
  if (url === STATE_URL && (init?.method ?? 'GET') === 'GET') return json(STATE);
  if (url === STATE_URL) return json(STATE);
  return json({ code: 'not_found', detail: 'not_found' }, 404);
}

beforeEach(() => {
  route = defaultRoute;
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => route(String(url), init));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function calls(method: string, url: string) {
  return fetchMock.mock.calls.filter(
    ([u, init]) => String(u) === url && (init?.method ?? 'GET') === method
  );
}

function posted(): unknown[] {
  return calls('POST', STATE_URL).map(([, init]) => JSON.parse(String(init!.body)));
}

async function flush() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

interface Harness {
  api: () => CollectionsApi;
  tabs: () => TabsState;
  schedule: ReturnType<typeof vi.fn>;
  notify: ReturnType<typeof vi.fn>;
  writeUrl: ReturnType<typeof vi.fn>;
  rerender: (patch: Partial<Props>) => void;
}

type Props = Partial<
  Pick<
    UseCollectionsOptions,
    | 'path'
    | 'screens'
    | 'chrome'
    | 'openRef'
    | 'here'
    | 'tools'
    | 'root'
    | 'urlKey'
    | 'restoredKeys'
  >
>;

/** Host renders since the last mount. */
let renders = 0;

function mount(props: Props = {}, initial: TabsState = EMPTY_TABS): Harness {
  const schedule = vi.fn();
  const notify = vi.fn();
  const writeUrl = vi.fn();
  let api!: CollectionsApi;
  let tabs!: TabsState;
  renders = 0;
  function Host(p: Props) {
    renders += 1;
    const [state, dispatch] = useReducer(tabsReducer, initial);
    const stateRef = useRef(state);
    stateRef.current = state;
    tabs = state;
    api = useCollections({
      path: 'path' in p ? p.path : 'collections',
      base: BASE,
      state,
      stateRef,
      dispatch,
      screens: 'screens' in p ? p.screens! : SCREENS,
      tools: p.tools ?? ['trace'],
      chrome: p.chrome ?? true,
      persistence: { schedule },
      notify,
      openRef: p.openRef ?? null,
      here: p.here ?? '/',
      writeUrl,
      ...(p.root ? { root: p.root } : {}),
      ...(p.urlKey !== undefined ? { urlKey: p.urlKey } : {}),
      ...(p.restoredKeys ? { restoredKeys: p.restoredKeys } : {}),
    });
    return null;
  }
  let current = props;
  const view = render(<Host {...current} />);
  return {
    api: () => api,
    tabs: () => tabs,
    schedule,
    notify,
    writeUrl,
    rerender: (patch) => {
      current = { ...current, ...patch };
      view.rerender(<Host {...current} />);
    },
  };
}

describe('wire helpers', () => {
  it('builds the list, item and state URLs against the base', () => {
    expect(collectionsUrl('collections', BASE)).toBe(LIST_URL);
    expect(collectionsUrl('collections/', BASE, 'a b')).toBe(`${LIST_URL}/a%20b`);
    expect(stateUrl('collections', BASE)).toBe(STATE_URL);
  });

  it('drops only _canopyOpen from a URL', () => {
    expect(withoutOpenParam('/x?_canopyOpen=facility%3Aa&b=1#h')).toBe('/x?b=1#h');
    expect(withoutOpenParam('/x?_canopyOpen=facility%3Aa')).toBe('/x');
    expect(withoutOpenParam('/x?b=1')).toBe('/x?b=1');
    expect(withoutOpenParam('/x')).toBe('/x');
  });

  it('parses a listed collection with its tabbed layout', () => {
    const grid = parseCollection(LIST.collections[3])!;
    expect(grid.members).toEqual([SR, PROMO, CURRENT]);
    expect(grid.layout).toEqual({
      split: 'row',
      items: [{ tabs: [0, 1], showing: 1 }, { tabs: [2] }],
    });
    expect(grid.refused).toBeUndefined();
    expect(grid.default).toBe(false);
  });

  it('maps the layout onto the kept members when one cannot be keyed', () => {
    const odd = parseCollection({
      ...LIST.collections[3],
      members: [SR, { bogus: 1 }, PROMO],
      layout: { split: 'row', items: [{ tabs: [0, 1] }, { tabs: [2] }] },
    })!;
    expect(odd.members).toEqual([SR, PROMO]);
    expect(odd.layout).toEqual({
      split: 'row',
      items: [
        { tabs: [0], size: 0.5 },
        { tabs: [1], size: 0.5 },
      ],
    });
  });

  it("carries the server's refusal of a file it cannot read", () => {
    const refused = parseCollection({
      source: 'personal',
      ref: 'personal:part-grid',
      id: 'part-grid',
      name: 'Partial ring grid',
      members: [SR],
      refused: 'layout: member_missing: every member is placed in a tile',
    })!;
    expect(refused.members).toEqual([SR]);
    expect(refused.layout).toBeNull();
    expect(refused.refused).toMatch(/^layout: member_missing/);
  });

  it('keeps rev, the raw document without listed keys, and rawIndex', () => {
    const grid = parseCollection({ ...LIST.collections[3], updated: '2026-10-17T00:00:00Z' })!;
    expect(grid.rev).toBe('0123456789abcdef');
    const { source, ref, rev, ...stored } = LIST.collections[3]!;
    void source;
    void ref;
    void rev;
    expect(grid.raw).toEqual(stored);
    expect(grid.raw).not.toHaveProperty('updated');
    expect(grid.rawIndex).toEqual([0, 1, 2]);
  });

  it('aligns rawIndex with the kept members when one cannot be keyed', () => {
    const odd = parseCollection({
      ...LIST.collections[4],
      members: [{ bogus: 1 }, SR, 'nope', PROMO],
    })!;
    expect(odd.members).toEqual([SR, PROMO]);
    expect(odd.rawIndex).toEqual([1, 3]);
    expect((odd.raw!.members as unknown[])[0]).toEqual({ bogus: 1 });
  });

  it('leaves rev unset when the server lists none', () => {
    expect(parseCollection(LIST.collections[0])!.rev).toBeUndefined();
  });

  it('maps 412 exists|stale|gone and 428 to typed reasons, nothing else', () => {
    expect(conflictReason(412, 'exists')).toBe('exists');
    expect(conflictReason(412, 'stale')).toBe('stale');
    expect(conflictReason(412, 'gone')).toBe('gone');
    expect(conflictReason(412, '412 Precondition Failed')).toBe('stale');
    expect(conflictReason(428, 'precondition_required')).toBe('precondition_required');
    expect(conflictReason(404, 'not_found')).toBeNull();
    expect(conflictReason(400, 'invalid_collection')).toBeNull();
  });

  it('mints the first free personal id; facility ids do not count', () => {
    const all = LIST.collections.map((c) => parseCollection(c)!);
    expect(freeId('mine', all)).toBe('mine-2');
    expect(freeId('control', all)).toBe('control');
    const many = Array.from(
      { length: 100 },
      (_, i) =>
        parseCollection({
          ...LIST.collections[4],
          id: i === 0 ? 'x' : `x-${i + 1}`,
          ref: i === 0 ? 'personal:x' : `personal:x-${i + 1}`,
        })!
    );
    expect(freeId('x', many)).toBeNull();
  });

  it('upserts in place, a new personal last, a new facility after the facility block', () => {
    const all = LIST.collections.map((c) => parseCollection(c)!);
    const renamed = { ...all[4]!, name: 'Renamed' };
    expect(upsertCollection(all, renamed).map((c) => c.name)).toEqual([
      'Control',
      'Injector',
      'Spare',
      'Ring grid',
      'Renamed',
    ]);
    const fresh = parseCollection({ ...LIST.collections[4], id: 'new', ref: 'personal:new' })!;
    expect(upsertCollection(all, fresh).at(-1)!.ref).toBe('personal:new');
    const fac = parseCollection({ ...LIST.collections[2], id: 'f2', ref: 'facility:f2' })!;
    expect(upsertCollection(all, fac).map((c) => c.ref)[3]).toBe('facility:f2');
  });

  it("refuses a broken layout and says why in canopy's words", () => {
    const broken = parseCollection({
      ...LIST.collections[3],
      layout: { split: 'grid', items: [{ tabs: [0] }, { tabs: [1] }] },
    })!;
    expect(broken.layout).toBeNull();
    expect(broken.refused).toBe("layout.split: bad_split: split must be 'row' or 'column'");
  });

  it('refuses a collection whose ref does not match its source and id', () => {
    expect(parseCollection({ ...LIST.collections[0], ref: 'personal:control' })).toBeNull();
    expect(parseCollection({ ...LIST.collections[0], source: 'other' })).toBeNull();
  });

  it('honours default only on facility collections', () => {
    expect(parseCollection({ ...LIST.collections[4], default: true })!.default).toBe(false);
  });

  it('shows (defaults ∪ ticked) − unticked in list order, unknown refs ignored', () => {
    const all = LIST.collections.map((c) => parseCollection(c)!);
    expect(shownSelection(all, STATE).map((c) => c.ref)).toEqual([
      'facility:control',
      'personal:mine',
    ]);
    expect(
      shownSelection(all, { ticked: ['facility:spare'], unticked: ['facility:control'] }).map(
        (c) => c.ref
      )
    ).toEqual(['facility:injector', 'facility:spare']);
  });
});

describe('useCollections fetching', () => {
  it('fetches nothing and is disabled without config.collections', async () => {
    const h = mount({ path: undefined });
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.api().enabled).toBe(false);
    expect(h.api().collections).toEqual([]);
    expect(h.api().shown).toEqual([]);
  });

  it('loads the list and the state on mount', async () => {
    const h = mount();
    await flush();
    expect(calls('GET', LIST_URL)).toHaveLength(1);
    expect(calls('GET', STATE_URL)).toHaveLength(1);
    expect(h.api().enabled).toBe(true);
    expect(h.api().collections.map((c) => c.ref)).toHaveLength(5);
    expect(h.api().shown.map((c) => c.ref)).toEqual(['facility:control', 'personal:mine']);
    expect(h.api().state.pinned).toEqual([CURRENT]);
    expect(h.api().recent).toEqual(STATE.recent);
    expect(h.api().pinnedKeys.has(memberKey(CURRENT))).toBe(true);
  });

  it('refetches both on window focus', async () => {
    mount();
    await flush();
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await flush();
    expect(calls('GET', LIST_URL)).toHaveLength(2);
    expect(calls('GET', STATE_URL)).toHaveLength(2);
  });

  it('keeps the last list on a fetch error and shows a notice', async () => {
    const h = mount();
    await flush();
    route = (url, init) =>
      url === LIST_URL ? json({ code: 'boom', detail: 'boom' }, 500) : defaultRoute(url, init);
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await flush();
    expect(h.api().collections).toHaveLength(5);
    expect(h.api().error).toContain('boom');
    expect(h.notify).toHaveBeenCalledWith(expect.stringContaining('boom'));
  });
});

describe('useCollections state ops', () => {
  it('posts exactly {op, ref} and {op, member}', async () => {
    const h = mount();
    await flush();
    await act(async () => {
      await h.api().tick('facility:spare');
      await h.api().untick('facility:control');
      await h.api().pin(CURRENT);
      await h.api().unpin(SR);
    });
    expect(posted()).toEqual([
      { op: 'tick', ref: 'facility:spare' },
      { op: 'untick', ref: 'facility:control' },
      { op: 'pin', member: CURRENT },
      { op: 'unpin', member: SR },
    ]);
    const init = calls('POST', STATE_URL)[0]![1]!;
    expect(new Headers(init.headers).get('Content-Type')).toBe('application/json');
  });

  it('applies a POST answer directly, without a follow-up GET', async () => {
    const h = mount();
    await flush();
    const after = { ...STATE, ticked: ['facility:spare'], unticked: [] };
    route = (url, init) => (init?.method === 'POST' ? json(after) : defaultRoute(url, init));
    await act(async () => {
      await h.api().tick('facility:spare');
    });
    expect(calls('GET', STATE_URL)).toHaveLength(1);
    expect(h.api().shown.map((c) => c.ref)).toEqual([
      'facility:control',
      'facility:injector',
      'facility:spare',
    ]);
  });

  it('sends state POSTs one after another: the next waits for the previous answer', async () => {
    const h = mount();
    await flush();
    const first = deferred();
    const second = deferred();
    const queue = [first, second];
    route = (url, init) =>
      init?.method === 'POST' ? queue.shift()!.promise : defaultRoute(url, init);
    let a!: Promise<void>;
    let b!: Promise<void>;
    act(() => {
      a = h.api().pin(SR);
      b = h.api().unpin(SR);
    });
    await flush();
    expect(posted()).toEqual([{ op: 'pin', member: SR }]);
    await act(async () => {
      first.resolve(json({ ...STATE, pinned: [CURRENT, SR] }));
      await a;
    });
    await flush();
    expect(posted()).toEqual([
      { op: 'pin', member: SR },
      { op: 'unpin', member: SR },
    ]);
    await act(async () => {
      second.resolve(json({ ...STATE, pinned: [CURRENT] }));
      await b;
    });
    expect(h.api().state.pinned).toEqual([CURRENT]);
  });

  it('a failed POST does not stop the chain', async () => {
    const h = mount();
    await flush();
    let n = 0;
    route = (url, init) => {
      if (init?.method !== 'POST') return defaultRoute(url, init);
      n += 1;
      return n === 1
        ? json({ code: 'pinned_full', detail: 'pinned_full' }, 409)
        : json({ ...STATE, pinned: [] });
    };
    await act(async () => {
      void h.api().pin(SR);
      await h.api().unpin(CURRENT);
    });
    expect(posted()).toHaveLength(2);
    expect(h.api().state.pinned).toEqual([]);
  });

  it('skips the state GET of a focus refresh while a POST is in flight', async () => {
    const h = mount();
    await flush();
    const post = deferred();
    route = (url, init) => (init?.method === 'POST' ? post.promise : defaultRoute(url, init));
    let done!: Promise<void>;
    act(() => {
      done = h.api().tick('facility:spare');
    });
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await flush();
    expect(calls('GET', STATE_URL)).toHaveLength(1);
    expect(calls('GET', LIST_URL)).toHaveLength(2);
    await act(async () => {
      post.resolve(json({ ...STATE, ticked: ['facility:spare'] }));
      await done;
    });
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await flush();
    expect(calls('GET', STATE_URL)).toHaveLength(2);
  });

  it('drops a mount GET that lands after a newer POST answer', async () => {
    const get = deferred();
    route = (url, init) =>
      url === STATE_URL && (init?.method ?? 'GET') === 'GET'
        ? get.promise
        : defaultRoute(url, init);
    const h = mount();
    await flush();
    route = (url, init) =>
      init?.method === 'POST' ? json({ ...STATE, pinned: [] }) : defaultRoute(url, init);
    await act(async () => {
      await h.api().unpin(CURRENT);
    });
    await act(async () => {
      get.resolve(json(STATE));
    });
    await flush();
    expect(h.api().state.pinned).toEqual([]);
  });

  it.each([
    ['pinned_full', 409, 'pin', /Pinned is full/],
    ['selection_full', 409, 'tick', /Too many collections ticked/],
    ['too_large', 413, 'pin', /too large/],
  ] as const)('shows an inline notice for %s', async (code, status, op, words) => {
    const h = mount();
    await flush();
    route = (url, init) =>
      init?.method === 'POST'
        ? json({ code: code, detail: code }, status)
        : defaultRoute(url, init);
    await act(async () => {
      if (op === 'pin') await h.api().pin(SR);
      else await h.api().tick('facility:spare');
    });
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.notify.mock.calls[0]![0]).toMatch(words);
  });

  it('logs one warning and no notice when `recent` fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = mount();
    await flush();
    route = (url, init) =>
      init?.method === 'POST'
        ? json({ code: 'too_large', detail: 'too_large' }, 413)
        : defaultRoute(url, init);
    await act(async () => {
      await h.api().recentOp(SR);
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(h.notify).not.toHaveBeenCalled();
  });
});

describe('useCollections recent', () => {
  it('a single member open dispatches it and posts it to Recent', async () => {
    const h = mount();
    await flush();
    await act(async () => {
      h.api().openMember(PROMO, { newTab: true });
    });
    await flush();
    expect(h.tabs().keys).toContain('library/s3-promo/promotion');
    expect(posted()).toEqual([{ op: 'recent', member: PROMO }]);
  });

  it('holds a new Recent order back while the pointer is in the branch', async () => {
    const h = mount();
    await flush();
    const resorted = { ...STATE, recent: [SR, PROMO] };
    route = (url, init) => (init?.method === 'POST' ? json(resorted) : defaultRoute(url, init));
    act(() => h.api().setRecentHover(true));
    await act(async () => {
      await h.api().recentOp(SR);
    });
    expect(h.api().recent).toEqual(STATE.recent);
    act(() => h.api().setRecentHover(false));
    expect(h.api().recent).toEqual([SR, PROMO]);
  });

  it('names the screen member of a screen tab key, none for a tool key', () => {
    expect(screenMemberOfKey('library/sr/overview')).toEqual(SR);
    expect(screenMemberOfKey('library/sr/overview?b=2&a=1')).toEqual({
      screen: 'library/sr/overview',
      macros: { a: '1', b: '2' },
    });
    expect(screenMemberOfKey('@trace')).toBeNull();
    expect(screenMemberOfKey('nocategory')).toBeNull();
  });

  describe('Open all of 12 members', () => {
    const many: { screen: string }[] = Array.from({ length: 12 }, (_, i) => ({
      screen: `library/many/s${String(i).padStart(2, '0')}`,
    }));
    const manyScreens = many.map((m) => entry('library', m.screen.slice('library/'.length)));
    const manyList = {
      collections: [
        {
          source: 'facility',
          ref: 'facility:many',
          id: 'many',
          name: 'Many',
          // Display order is not alphabetical: the post must keep it.
          members: [...many].reverse(),
        },
      ],
    };

    it('posts one recent-many of the first MAX_RECENT opened, in display order', async () => {
      route = (url, init) =>
        url === LIST_URL && (init?.method ?? 'GET') === 'GET'
          ? json(manyList)
          : defaultRoute(url, init);
      const h = mount({ screens: manyScreens });
      await flush();
      const collection = h.api().collections.find((c) => c.ref === 'facility:many')!;
      await act(async () => {
        h.api().openAll(collection);
      });
      await flush();
      expect(h.tabs().keys).toHaveLength(12);
      const sent = posted();
      expect(sent).toHaveLength(1);
      const op = sent[0] as { op: string; members: Member[] };
      expect(op.op).toBe('recent-many');
      expect(op.members.length).toBeLessThanOrEqual(MAX_RECENT);
      expect(op.members).toEqual([...many].reverse().slice(0, MAX_RECENT));
    });

    it('counts Open all as the plan opens it (k of N)', async () => {
      route = (url, init) =>
        url === LIST_URL && (init?.method ?? 'GET') === 'GET'
          ? json(manyList)
          : defaultRoute(url, init);
      const h = mount({ screens: manyScreens.slice(0, 9) });
      await flush();
      const collection = h.api().collections.find((c) => c.ref === 'facility:many')!;
      expect(h.api().openAllCount(collection)).toEqual({ opened: 9, total: 12 });
    });
  });

  it('records only the members the plan opened (a skipped member is not history)', async () => {
    const h = mount();
    await flush();
    const mine = h.api().collections.find((c) => c.ref === 'personal:mine')!;
    expect(h.api().openAllCount(mine)).toEqual({ opened: 1, total: 2 });
    await act(async () => {
      h.api().openAll(mine);
    });
    await flush();
    expect(posted()).toEqual([{ op: 'recent-many', members: [PROMO] }]);
  });

  it('posts every member a layout open opened, in display order', async () => {
    const h = mount();
    await flush();
    await act(async () => {
      h.api().openAll(h.api().collections.find((c) => c.ref === 'personal:grid')!);
    });
    await flush();
    expect(posted()).toEqual([{ op: 'recent-many', members: [SR, PROMO, CURRENT] }]);
  });

  it('counts nothing while the first manifest is pending', async () => {
    const h = mount({ screens: null });
    await flush();
    const control = h.api().collections.find((c) => c.ref === 'facility:control')!;
    expect(h.api().openAllCount(control)).toBeNull();
  });

  it('a reload (the URL key among the restored keys) records nothing', async () => {
    const restored = {
      ...EMPTY_TABS,
      keys: ['library/sr/overview'],
      active: 'library/sr/overview',
    };
    mount(
      { urlKey: 'library/sr/overview', restoredKeys: ['library/sr/overview'] },
      restored as TabsState
    );
    await flush();
    expect(posted()).toEqual([]);
  });

  it('a fresh src URL not among the restored keys records its screen once', async () => {
    const h = mount({ urlKey: 'library/sr/overview', restoredKeys: ['library/gtb/GTLView'] });
    await flush();
    h.rerender({ here: '/x' });
    await flush();
    expect(posted()).toEqual([{ op: 'recent', member: SR }]);
  });

  it('a tool URL key records nothing at mount', async () => {
    mount({ urlKey: '@trace', restoredKeys: [] });
    await flush();
    expect(posted()).toEqual([]);
  });

  it('records nothing at mount without the feature', async () => {
    mount({ path: undefined, urlKey: 'library/sr/overview', restoredKeys: [] });
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('remove while hovered hides the row at once', async () => {
    const h = mount();
    await flush();
    const without = { ...STATE, recent: [{ screen: 'drafts/bts/view' }] };
    route = (url, init) => (init?.method === 'POST' ? json(without) : defaultRoute(url, init));
    act(() => h.api().setRecentHover(true));
    await act(async () => {
      await h.api().recentRemove(PROMO);
    });
    expect(posted()).toEqual([{ op: 'recent-remove', member: PROMO }]);
    expect(h.api().recent).toEqual([{ screen: 'drafts/bts/view' }]);
    // Leaving later shows nothing stale.
    act(() => h.api().setRecentHover(false));
    expect(h.api().recent).toEqual([{ screen: 'drafts/bts/view' }]);
  });

  it('clear recent while hovered empties the branch at once', async () => {
    const h = mount();
    await flush();
    route = (url, init) =>
      init?.method === 'POST' ? json({ ...STATE, recent: [] }) : defaultRoute(url, init);
    act(() => h.api().setRecentHover(true));
    await act(async () => {
      await h.api().recentClear();
    });
    expect(posted()).toEqual([{ op: 'recent-clear' }]);
    expect(h.api().recent).toEqual([]);
  });

  it('a failed recent-remove notifies in plain words', async () => {
    const h = mount();
    await flush();
    route = (url, init) =>
      init?.method === 'POST'
        ? json({ code: 'boom', detail: 'boom' }, 500)
        : defaultRoute(url, init);
    await act(async () => {
      await h.api().recentRemove(PROMO);
    });
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.notify.mock.calls[0]![0]).toMatch(/^Could not remove the member from Recent/);
  });

  it('a failed recent-many warns once and notifies nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = mount();
    await flush();
    route = (url, init) =>
      init?.method === 'POST'
        ? json({ code: 'invalid_op', detail: 'invalid_op' }, 400)
        : defaultRoute(url, init);
    await act(async () => {
      h.api().openAll(h.api().collections.find((c) => c.ref === 'facility:control')!);
    });
    await flush();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('recordOpen is the single-open post', async () => {
    const h = mount();
    await flush();
    await act(async () => {
      await h.api().recordOpen(GTL);
    });
    expect(posted()).toEqual([{ op: 'recent', member: GTL }]);
  });
});

describe('useCollections openAll', () => {
  const byRef = (h: Harness, ref: string) => h.api().collections.find((c) => c.ref === ref)!;

  it('opens a layout-less collection side by side, posts Recent and arms persistence', async () => {
    const h = mount();
    await flush();
    await act(async () => {
      h.api().openAll(byRef(h, 'facility:control'));
    });
    expect(h.tabs().keys).toEqual(['library/sr/overview', '@trace']);
    // A person's click: one tile each, in a row.
    expect(h.tabs().layout).toMatchObject({
      split: 'row',
      items: [{ tabs: ['library/sr/overview'] }, { tabs: ['@trace'] }],
    });
    expect(h.tabs().active).toBe('library/sr/overview');
    expect(h.schedule).toHaveBeenCalledWith(true);
    // Open all is history too, one atomic recent-many.
    expect(posted()).toEqual([
      { op: 'recent-many', members: [SR, { tool: 'trace', name: 'Trace' }] },
    ]);
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('opens tabs per tile as saved, through the holder', async () => {
    const h = mount();
    await flush();
    await act(async () => {
      h.api().openAll(byRef(h, 'personal:grid'));
    });
    const trace = h.tabs().keys.find((k) => k.startsWith('@trace'))!;
    expect(h.tabs().layout).toEqual({
      split: 'row',
      items: [
        {
          tile: 't1',
          tabs: ['library/sr/overview', 'library/s3-promo/promotion'],
          showing: 'library/s3-promo/promotion',
          size: 0.5,
        },
        { tile: 't2', tabs: [trace], showing: trace, size: 0.5 },
      ],
    });
    expect(h.tabs().instances[trace]).toMatchObject({
      query: (CURRENT as { query: string }).query,
      from: memberKey(CURRENT),
    });
    expect(h.schedule).toHaveBeenCalledWith(true);
  });

  it('prunes a skipped member from the layout, normalises and names it in the notice', async () => {
    route = (url, init) =>
      url === LIST_URL && (init?.method ?? 'GET') === 'GET'
        ? json({
            collections: [
              {
                source: 'personal',
                ref: 'personal:gaps',
                id: 'gaps',
                name: 'Gaps',
                members: [SR, { screen: 'library/missing/x' }, PROMO],
                layout: {
                  split: 'column',
                  items: [{ tabs: [0] }, { tabs: [1] }, { tabs: [2] }],
                },
              },
            ],
          })
        : defaultRoute(url, init);
    const h = mount();
    await flush();
    await act(async () => {
      h.api().openAll(byRef(h, 'personal:gaps'));
    });
    expect(h.tabs().layout).toEqual({
      split: 'column',
      items: [
        { tile: 't1', tabs: ['library/sr/overview'], showing: 'library/sr/overview', size: 0.5 },
        {
          tile: 't2',
          tabs: ['library/s3-promo/promotion'],
          showing: 'library/s3-promo/promotion',
          size: 0.5,
        },
      ],
    });
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.notify.mock.calls[0]![0]).toMatch(/^Skipped 1 member: library\/missing\/x/);
  });

  it('refuses a collection the server lists as refused: one notice, the dock unchanged', async () => {
    const reason = 'layout: member_missing: every member is placed in a tile';
    route = (url, init) =>
      url === LIST_URL && (init?.method ?? 'GET') === 'GET'
        ? json({
            collections: [
              {
                source: 'personal',
                ref: 'personal:part',
                id: 'part',
                name: 'Part',
                members: [SR],
                refused: reason,
              },
            ],
          })
        : defaultRoute(url, init);
    const start = tabsReducer(EMPTY_TABS, {
      type: 'open',
      key: 'library/gtb/GTLView',
      mode: 'append',
    });
    const h = mount({}, start);
    await flush();
    const part = byRef(h, 'personal:part');
    expect(part.refused).toBe(reason);
    let pending!: Promise<OpenAllResult>;
    await act(async () => {
      pending = h.api().openAll(part);
    });
    const result = await pending;
    expect(result).toEqual({ keys: [], changed: false, group: null, refusal: reason });
    expect(h.tabs()).toBe(start);
    expect(h.notify).toHaveBeenCalledWith(`“Part” cannot be opened: ${reason}`);
    expect(posted()).toEqual([]);
  });

  it('refuses a partly placed layout the viewer reads, the dock unchanged', async () => {
    route = (url, init) =>
      url === LIST_URL && (init?.method ?? 'GET') === 'GET'
        ? json({
            collections: [
              {
                source: 'personal',
                ref: 'personal:part',
                id: 'part',
                name: 'Part',
                members: [SR, PROMO],
                layout: { tabs: [0] },
              },
            ],
          })
        : defaultRoute(url, init);
    const h = mount();
    await flush();
    expect(byRef(h, 'personal:part').refused).toBe(
      'layout: member_missing: every member is placed in a tile'
    );
    await act(async () => {
      h.api().openAll(byRef(h, 'personal:part'));
    });
    expect(h.tabs().keys).toEqual([]);
    expect(h.notify).toHaveBeenCalledTimes(1);
  });

  it("a person's side by side falls back to tabs of one tile with a notice", async () => {
    const wide: Member[] = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].map((id) => ({
      screen: `library/w/${id}`,
    }));
    route = (url, init) =>
      url === LIST_URL && (init?.method ?? 'GET') === 'GET'
        ? json({
            collections: [
              { source: 'facility', ref: 'facility:wide', id: 'wide', name: 'Wide', members: wide },
            ],
          })
        : defaultRoute(url, init);
    // One tile already open, in a dock too small for 11 cells or a grid of them.
    const start = stepTabs(
      tabsReducer(EMPTY_TABS, { type: 'open', key: 'library/gtb/GTLView', mode: 'append' }),
      { type: 'resized', dock: { width: 200, height: 100 } }
    ).state;
    const screens = [
      ...SCREENS,
      ...wide.map((m) => entry('library', (m as { screen: string }).screen.slice(8))),
    ];
    const h = mount({ screens }, start);
    await flush();
    let pending!: Promise<OpenAllResult>;
    await act(async () => {
      pending = h.api().openAll(byRef(h, 'facility:wide'));
    });
    const result = await pending;
    expect(result.notice).toBe(TOO_MANY_FOR_SIDE);
    expect(h.notify).toHaveBeenCalledWith(SIDE_NOTICE);
    expect(h.tabs().keys).toHaveLength(11);
  });

  it('opens a layout as tabs of the one tile without chrome, and persists nothing', async () => {
    const h = mount({ chrome: false });
    await flush();
    await act(async () => {
      h.api().openAll(byRef(h, 'personal:grid'));
    });
    expect(h.tabs().keys).toHaveLength(3);
    expect(h.tabs().layout).toMatchObject({ tabs: expect.any(Array) });
    expect(h.schedule).not.toHaveBeenCalled();
  });

  it('summarises skipped members in one notice', async () => {
    const h = mount();
    await flush();
    await act(async () => {
      h.api().openAll(byRef(h, 'personal:mine'));
    });
    expect(h.tabs().keys).toEqual(['library/s3-promo/promotion']);
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.notify.mock.calls[0]![0]).toMatch(/^Skipped 1 member: library\/missing\/x/);
  });

  it('waits for the first manifest, then opens', async () => {
    const h = mount({ screens: null });
    await flush();
    await act(async () => {
      h.api().openAll(byRef(h, 'facility:control'));
    });
    expect(h.tabs().keys).toEqual([]);
    await act(async () => h.rerender({ screens: SCREENS }));
    expect(h.tabs().keys).toHaveLength(2);
  });

  it('a second Open all leaves the keys unchanged', async () => {
    const h = mount();
    await flush();
    await act(async () => {
      h.api().openAll(byRef(h, 'personal:grid'));
    });
    const keys = [...h.tabs().keys];
    const layout = h.tabs().layout;
    await act(async () => {
      h.api().openAll(byRef(h, 'personal:grid'));
    });
    expect(h.tabs().keys).toEqual(keys);
    expect(h.tabs().layout).toEqual(layout);
  });
});

describe('useCollections _canopyOpen', () => {
  it('opens the collection once after the list and manifest, then drops the param', async () => {
    const here = '/?_canopyOpen=facility%3Acontrol&x=1';
    const h = mount({ openRef: 'facility:control', here, screens: null });
    await flush();
    expect(h.tabs().keys).toEqual([]);
    await act(async () => h.rerender({ screens: SCREENS }));
    await flush();
    expect(h.tabs().keys).toHaveLength(2);
    expect(h.writeUrl).toHaveBeenCalledTimes(1);
    expect(h.writeUrl).toHaveBeenCalledWith('/?x=1');
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await flush();
    h.rerender({ screens: [...SCREENS] });
    await flush();
    expect(h.writeUrl).toHaveBeenCalledTimes(1);
    expect(h.tabs().keys).toHaveLength(2);
  });

  it('shows one notice for an unknown ref', async () => {
    const h = mount({ openRef: 'personal:ghost', here: '/?_canopyOpen=personal%3Aghost' });
    await flush();
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.notify.mock.calls[0]![0]).toContain('personal:ghost');
    expect(h.writeUrl).toHaveBeenCalledWith('/');
    expect(h.tabs().keys).toEqual([]);
  });

  it('shows one notice when the store errors', async () => {
    route = (url, init) =>
      url === LIST_URL ? json({ code: 'boom', detail: 'boom' }, 500) : defaultRoute(url, init);
    const h = mount({ openRef: 'facility:control', here: '/?_canopyOpen=facility%3Acontrol' });
    await flush();
    const deepLink = h.notify.mock.calls.filter(([t]) => String(t).includes('facility:control'));
    expect(deepLink).toHaveLength(1);
    expect(h.tabs().keys).toEqual([]);
  });

  it('shows one notice when the store is absent', async () => {
    const h = mount({ path: undefined, openRef: 'facility:control' });
    await flush();
    expect(h.notify).toHaveBeenCalledTimes(1);
  });

  it('is ignored without chrome: no open, no URL write, one warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = mount({
      chrome: false,
      openRef: 'facility:control',
      here: '/?_canopyChrome=0&_canopyOpen=facility%3Acontrol',
    });
    await flush();
    expect(h.tabs().keys).toEqual([]);
    expect(h.writeUrl).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('useCollections rendered keys', () => {
  it('lists Pinned, Recent, shown members, served tools and IR library screens', async () => {
    const h = mount();
    await flush();
    const keys = h.api().renderedKeys;
    expect(keys.has(memberKey(CURRENT))).toBe(true); // pinned
    expect(keys.has(memberKey({ screen: 'drafts/bts/view' }))).toBe(true); // recent
    expect(keys.has(memberKey({ tool: 'trace', name: 'Trace' }))).toBe(true); // shown member
    expect(keys.has(memberKey({ screen: 'library/missing/x' }))).toBe(true); // personal:mine
    expect(keys.has(memberKey({ tool: 'trace' }))).toBe(true); // Tools
    expect(keys.has(memberKey(GTL))).toBe(true); // All screens
    expect(keys.has(memberKey({ screen: 'examples/legacy' }))).toBe(false); // code screen
    expect(keys.has(memberKey({ screen: '@tools/hidden' }))).toBe(false);
    expect(keys.has(memberKey({ tool: 'correlation' }))).toBe(false);
  });
});

/** A PUT answer: the listed document the server stored. */
function listedAnswer(id: string, body: unknown, rev: string, status = 200): Response {
  return json(
    { source: 'personal', ref: `personal:${id}`, id, rev, ...(body as object), updated: 'now' },
    status
  );
}

function header(init: RequestInit | undefined, name: string): string | null {
  return new Headers(init?.headers).get(name);
}

function putRoute(answer: (url: string, init: RequestInit) => Response | Promise<Response>): Route {
  return (url, init) =>
    init?.method === 'PUT' || init?.method === 'DELETE'
      ? answer(url, init)
      : defaultRoute(url, init);
}

describe('useCollections personal collections', () => {
  it('mints the id from a fresh list: a duplicate name costs one PUT', async () => {
    const h = mount();
    await flush();
    route = putRoute((_url, init) => {
      expect(header(init, 'If-None-Match')).toBe('*');
      expect(header(init, 'If-Match')).toBeNull();
      return listedAnswer('mine-2', JSON.parse(String(init.body)), 'aaaa', 201);
    });
    let result!: Awaited<ReturnType<CollectionsApi['save']>>;
    await act(async () => {
      result = await h.api().save({ name: 'Mine', members: [SR], layout: { tabs: [0] } });
    });
    expect(calls('GET', LIST_URL)).toHaveLength(2);
    expect(fetchMock.mock.calls.filter(([, i]) => i?.method === 'PUT')).toHaveLength(1);
    expect(calls('PUT', `${LIST_URL}/mine-2`)).toHaveLength(1);
    expect(result).toMatchObject({ ok: true, ref: 'personal:mine-2' });
    const body = JSON.parse(String(calls('PUT', `${LIST_URL}/mine-2`)[0]![1]!.body));
    expect(body).toEqual({ name: 'Mine', members: [SR], layout: { tabs: [0] } });
    // The answer is in the cache at once, without another list GET.
    await flush();
    expect(calls('GET', LIST_URL)).toHaveLength(2);
    expect(h.api().collections.find((c) => c.ref === 'personal:mine-2')?.rev).toBe('aaaa');
  });

  it('retries a racing 412 exists with a refetched list, at most MAX_SAVE_RETRIES times', async () => {
    const h = mount();
    await flush();
    route = putRoute(() => json({ code: 'exists', detail: 'exists' }, 412));
    let result!: Awaited<ReturnType<CollectionsApi['save']>>;
    await act(async () => {
      result = await h.api().save({ name: 'Fresh', members: [SR] });
    });
    expect(result).toEqual({ ok: false, reason: 'exists', status: 412 });
    expect(calls('PUT', `${LIST_URL}/fresh`)).toHaveLength(1 + MAX_SAVE_RETRIES);
    // One fresh GET per attempt, plus the mount GET (and a refresh after the refusal).
    await flush();
    expect(calls('GET', LIST_URL).length).toBeGreaterThanOrEqual(2 + MAX_SAVE_RETRIES);
  });

  it('a race that clears on retry saves under the next free id', async () => {
    const h = mount();
    await flush();
    let lists = 0;
    route = (url, init) => {
      if (init?.method === 'PUT') {
        return url.endsWith('/fresh')
          ? json({ code: 'exists', detail: 'exists' }, 412)
          : listedAnswer('fresh-2', JSON.parse(String(init.body)), 'bbbb', 201);
      }
      if (url === LIST_URL) {
        lists += 1;
        // The retry's fresh list shows the collection that won the race.
        if (lists >= 2) {
          return json({
            collections: [
              ...LIST.collections,
              { ...LIST.collections[4], id: 'fresh', ref: 'personal:fresh' },
            ],
          });
        }
      }
      return defaultRoute(url, init);
    };
    let result!: Awaited<ReturnType<CollectionsApi['save']>>;
    await act(async () => {
      result = await h.api().save({ name: 'Fresh', members: [SR] });
    });
    expect(result).toMatchObject({ ok: true, ref: 'personal:fresh-2' });
    expect(fetchMock.mock.calls.filter(([, i]) => i?.method === 'PUT').map(([u]) => u)).toEqual([
      `${LIST_URL}/fresh`,
      `${LIST_URL}/fresh-2`,
    ]);
  });

  it('refuses a blank name before any request', async () => {
    const h = mount();
    await flush();
    const before = fetchMock.mock.calls.length;
    await expect(h.api().save({ name: '   ', members: [SR] })).rejects.toThrow(/letters or digits/);
    expect(fetchMock.mock.calls.length).toBe(before);
  });

  it('replaces under If-Match with the rev given, else the cached rev', async () => {
    const h = mount();
    await flush();
    route = putRoute((url, init) =>
      listedAnswer(url.slice(LIST_URL.length + 1), JSON.parse(String(init.body)), 'cccc')
    );
    await act(async () => {
      await h.api().save({ name: 'Mine', members: [SR] }, 'mine', 'seen-at-open');
    });
    await act(async () => {
      await h.api().save({ name: 'Mine', members: [SR] }, 'grid');
    });
    const [first, second] = fetchMock.mock.calls.filter(([, i]) => i?.method === 'PUT');
    expect(header(first![1], 'If-Match')).toBe('seen-at-open');
    expect(header(first![1], 'If-None-Match')).toBeNull();
    expect(header(second![1], 'If-Match')).toBe('0123456789abcdef');
    expect(h.api().collections.find((c) => c.ref === 'personal:mine')?.rev).toBe('cccc');
  });

  it.each([
    [412, 'stale', 'stale'],
    [412, 'gone', 'gone'],
    [428, 'precondition_required', 'precondition_required'],
  ] as const)(
    'a replace answered %i %s is a typed result and refetches',
    async (status, code, reason) => {
      const h = mount();
      await flush();
      route = putRoute(() => json({ code: code, detail: code }, status));
      let result!: Awaited<ReturnType<CollectionsApi['save']>>;
      await act(async () => {
        result = await h.api().save({ name: 'Mine', members: [SR] }, 'mine', 'old');
      });
      expect(result).toEqual({ ok: false, reason, status });
      await flush();
      expect(calls('GET', LIST_URL)).toHaveLength(2);
      expect(h.notify).not.toHaveBeenCalled();
    }
  );

  it('a replace of an id with no known rev sends no precondition (the server answers 428)', async () => {
    const h = mount();
    await flush();
    route = putRoute(() =>
      json({ code: 'precondition_required', detail: 'precondition_required' }, 428)
    );
    let result!: Awaited<ReturnType<CollectionsApi['save']>>;
    await act(async () => {
      result = await h.api().save({ name: 'X', members: [SR] }, 'unknown');
    });
    const init = calls('PUT', `${LIST_URL}/unknown`)[0]![1];
    expect(header(init, 'If-Match')).toBeNull();
    expect(header(init, 'If-None-Match')).toBeNull();
    expect(result).toMatchObject({ ok: false, reason: 'precondition_required' });
  });

  it('throws CollectionsError for a failure that is not a precondition', async () => {
    const h = mount();
    await flush();
    route = putRoute(() => json({ code: 'invalid_collection', detail: 'invalid_collection' }, 400));
    await expect(
      h.api().put('mine', { name: 'Mine', members: [] }, { rev: 'fedcba9876543210' })
    ).rejects.toBeInstanceOf(CollectionsError);
  });
});

describe('useCollections edits (put)', () => {
  it('PUTs the raw document under If-Match, listed keys stripped, and applies the answer', async () => {
    const h = mount();
    await flush();
    route = putRoute((_url, init) => listedAnswer('mine', JSON.parse(String(init.body)), 'dddd'));
    const mine = h.api().collections.find((c) => c.ref === 'personal:mine')!;
    let result!: Awaited<ReturnType<CollectionsApi['put']>>;
    await act(async () => {
      result = await h
        .api()
        .put(
          'mine',
          { ...mine.raw, name: 'Renamed', source: 'personal', rev: 'x', ref: 'y', updated: 'z' },
          { rev: mine.rev! }
        );
    });
    const init = calls('PUT', `${LIST_URL}/mine`)[0]![1]!;
    expect(header(init, 'If-Match')).toBe('fedcba9876543210');
    expect(header(init, 'Content-Type')).toBe('application/json');
    expect(JSON.parse(String(init.body))).toEqual({ ...mine.raw, name: 'Renamed' });
    expect(result).toMatchObject({ ok: true, ref: 'personal:mine' });
    const after = h.api().collections.find((c) => c.ref === 'personal:mine')!;
    expect(after.name).toBe('Renamed');
    expect(after.rev).toBe('dddd');
    await flush();
    expect(calls('GET', LIST_URL)).toHaveLength(1);
  });

  it('a create (undo-delete) sends If-None-Match: * and 412 exists is typed', async () => {
    const h = mount();
    await flush();
    route = putRoute(() => json({ code: 'exists', detail: 'exists' }, 412));
    let result!: Awaited<ReturnType<CollectionsApi['put']>>;
    await act(async () => {
      result = await h.api().put('mine', { name: 'Mine', members: [] }, { create: true });
    });
    const init = calls('PUT', `${LIST_URL}/mine`)[0]![1];
    expect(header(init, 'If-None-Match')).toBe('*');
    expect(header(init, 'If-Match')).toBeNull();
    expect(result).toEqual({ ok: false, reason: 'exists', status: 412 });
  });

  it('a list GET sent before the write and landing after its answer is dropped', async () => {
    const h = mount();
    await flush();
    const slowList = deferred();
    route = (url, init) => (url === LIST_URL ? slowList.promise : defaultRoute(url, init));
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    route = putRoute((_url, init) => listedAnswer('mine', JSON.parse(String(init.body)), 'eeee'));
    await act(async () => {
      await h
        .api()
        .put('mine', { name: 'New name', members: [PROMO] }, { rev: 'fedcba9876543210' });
    });
    await act(async () => {
      slowList.resolve(json(LIST));
    });
    await flush();
    expect(h.api().collections.find((c) => c.ref === 'personal:mine')?.name).toBe('New name');
  });

  it('an answer without the listed document falls back to a list GET', async () => {
    const h = mount();
    await flush();
    route = putRoute(() => new Response(null, { status: 204 }));
    let result!: Awaited<ReturnType<CollectionsApi['put']>>;
    await act(async () => {
      result = await h.api().put('mine', { name: 'Mine', members: [] }, { rev: 'r' });
    });
    await flush();
    expect(result).toEqual({ ok: true, ref: 'personal:mine', collection: null });
    expect(calls('GET', LIST_URL)).toHaveLength(2);
  });

  it('serialises writes per id; other ids run alongside', async () => {
    const h = mount();
    await flush();
    const answers: Deferred[] = [];
    route = putRoute(() => {
      const d = deferred();
      answers.push(d);
      return d.promise;
    });
    let a!: Promise<unknown>;
    let b!: Promise<unknown>;
    let c!: Promise<unknown>;
    act(() => {
      a = h.api().put('mine', { name: 'A', members: [] }, { rev: '1' });
      b = h.api().put('mine', { name: 'B', members: [] }, { rev: '2' });
      c = h.api().put('grid', { name: 'C', members: [] }, { rev: '3' });
    });
    await flush();
    const puts = () => fetchMock.mock.calls.filter(([, i]) => i?.method === 'PUT').map(([u]) => u);
    expect(puts()).toEqual([`${LIST_URL}/mine`, `${LIST_URL}/grid`]);
    await act(async () => {
      answers[0]!.resolve(listedAnswer('mine', { name: 'A', members: [] }, 'r1'));
      await a;
    });
    await flush();
    expect(puts()).toEqual([`${LIST_URL}/mine`, `${LIST_URL}/grid`, `${LIST_URL}/mine`]);
    await act(async () => {
      answers[1]!.resolve(listedAnswer('grid', { name: 'C', members: [] }, 'r3'));
      answers[2]!.resolve(listedAnswer('mine', { name: 'B', members: [] }, 'r2'));
      await Promise.all([b, c]);
    });
    expect(h.api().collections.find((x) => x.ref === 'personal:mine')?.name).toBe('B');
  });

  it('a failed write does not block the next one on the same id', async () => {
    const h = mount();
    await flush();
    let n = 0;
    route = putRoute((_url, init) => {
      n += 1;
      return n === 1
        ? json({ code: 'invalid_collection', detail: 'invalid_collection' }, 400)
        : listedAnswer('mine', JSON.parse(String(init.body)), 'ffff');
    });
    await act(async () => {
      await expect(
        h.api().put('mine', { name: 'Bad', members: [] }, { rev: '1' })
      ).rejects.toThrow();
      await h.api().put('mine', { name: 'Good', members: [] }, { rev: '1' });
    });
    expect(h.api().collections.find((c) => c.ref === 'personal:mine')?.name).toBe('Good');
  });

  it('skips the list GET of a focus refresh while a write is in flight', async () => {
    const h = mount();
    await flush();
    const answer = deferred();
    route = putRoute(() => answer.promise);
    let done!: Promise<unknown>;
    act(() => {
      done = h.api().put('mine', { name: 'Mine', members: [] }, { rev: '1' });
    });
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await flush();
    expect(calls('GET', LIST_URL)).toHaveLength(1);
    expect(calls('GET', STATE_URL)).toHaveLength(2);
    await act(async () => {
      answer.resolve(listedAnswer('mine', { name: 'Mine', members: [] }, 'r'));
      await done;
    });
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await flush();
    expect(calls('GET', LIST_URL)).toHaveLength(2);
  });
});

describe('useCollections remove', () => {
  it('deletes under If-Match, drops it from the cache at once and rereads the state', async () => {
    const h = mount();
    await flush();
    route = putRoute(() => new Response(null, { status: 204 }));
    let result!: Awaited<ReturnType<CollectionsApi['remove']>>;
    await act(async () => {
      result = await h.api().remove('mine', 'fedcba9876543210');
    });
    await flush();
    const init = calls('DELETE', `${LIST_URL}/mine`)[0]![1];
    expect(header(init, 'If-Match')).toBe('fedcba9876543210');
    expect(result).toEqual({ ok: true, missing: false });
    expect(h.api().collections.map((c) => c.ref)).not.toContain('personal:mine');
    expect(calls('GET', LIST_URL)).toHaveLength(1);
    expect(calls('GET', STATE_URL)).toHaveLength(2);
  });

  it('deletes unconditionally without a rev and takes 404 as done', async () => {
    const h = mount();
    await flush();
    route = putRoute(() => new Response(null, { status: 404 }));
    let result!: Awaited<ReturnType<CollectionsApi['remove']>>;
    await act(async () => {
      result = await h.api().remove('mine');
    });
    expect(header(calls('DELETE', `${LIST_URL}/mine`)[0]![1], 'If-Match')).toBeNull();
    expect(result).toEqual({ ok: true, missing: true });
    expect(h.api().collections.map((c) => c.ref)).not.toContain('personal:mine');
  });

  it('a 412 stale delete is typed, keeps the collection and refetches the list', async () => {
    const h = mount();
    await flush();
    route = putRoute(() => json({ code: 'stale', detail: 'stale' }, 412));
    let result!: Awaited<ReturnType<CollectionsApi['remove']>>;
    await act(async () => {
      result = await h.api().remove('mine', 'old');
    });
    await flush();
    expect(result).toEqual({ ok: false, reason: 'stale', status: 412 });
    expect(h.api().collections.map((c) => c.ref)).toContain('personal:mine');
    expect(calls('GET', LIST_URL)).toHaveLength(2);
  });

  it('runs after a pending write to the same id', async () => {
    const h = mount();
    await flush();
    const answer = deferred();
    route = (url, init) => {
      if (init?.method === 'PUT') return answer.promise;
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      return defaultRoute(url, init);
    };
    let put!: Promise<unknown>;
    let del!: Promise<unknown>;
    act(() => {
      put = h.api().put('mine', { name: 'Mine', members: [] }, { rev: '1' });
      del = h.api().remove('mine', '1');
    });
    await flush();
    expect(calls('DELETE', `${LIST_URL}/mine`)).toHaveLength(0);
    await act(async () => {
      answer.resolve(listedAnswer('mine', { name: 'Mine', members: [] }, '2'));
      await put;
      await del;
    });
    expect(calls('DELETE', `${LIST_URL}/mine`)).toHaveLength(1);
    expect(h.api().collections.map((c) => c.ref)).not.toContain('personal:mine');
  });
});

describe('useCollections edit gestures and Undo', () => {
  const MINE_RAW = { id: 'mine', name: 'Mine', members: [{ screen: 'library/missing/x' }, PROMO] };

  it('an edit PUTs under the captured rev; its Undo re-PUTs the captured raw under the returned rev', async () => {
    const h = mount();
    await flush();
    let rev = 0;
    route = putRoute((_url, init) =>
      listedAnswer('mine', JSON.parse(String(init.body)), `r${++rev}`)
    );
    const mine = h.api().collections.find((c) => c.ref === 'personal:mine')!;
    expect(mine.raw).toEqual(MINE_RAW);
    let result!: Awaited<ReturnType<CollectionsApi['edit']>>;
    await act(async () => {
      result = await h.api().edit(mine, (raw) => withoutMember(raw, 0));
    });
    const puts = calls('PUT', `${LIST_URL}/mine`);
    expect(header(puts[0]![1], 'If-Match')).toBe('fedcba9876543210');
    expect(JSON.parse(String(puts[0]![1]!.body))).toEqual({ ...MINE_RAW, members: [PROMO] });
    expect(result.ok).toBe(true);
    expect(h.api().collections.find((c) => c.ref === 'personal:mine')!.members).toEqual([PROMO]);
    let undone!: Awaited<ReturnType<Extract<typeof result, { ok: true }>['undo']>>;
    await act(async () => {
      undone = await (result as Extract<typeof result, { ok: true }>).undo();
    });
    expect(undone).toEqual({ ok: true });
    const back = calls('PUT', `${LIST_URL}/mine`)[1]![1]!;
    expect(header(back, 'If-Match')).toBe('r1');
    expect(JSON.parse(String(back.body))).toEqual(MINE_RAW);
    expect(h.api().collections.find((c) => c.ref === 'personal:mine')!.rev).toBe('r2');
  });

  it('a stale edit is typed, writes nothing else and rereads the list', async () => {
    const h = mount();
    await flush();
    route = putRoute(() => json({ code: 'stale', detail: 'stale' }, 412));
    const mine = h.api().collections.find((c) => c.ref === 'personal:mine')!;
    let result!: Awaited<ReturnType<CollectionsApi['edit']>>;
    await act(async () => {
      result = await h.api().edit(mine, (raw) => renamed(raw, 'X'));
    });
    await flush();
    expect(result).toEqual({ ok: false, reason: 'stale' });
    expect(calls('PUT', `${LIST_URL}/mine`)).toHaveLength(1);
    expect(calls('GET', LIST_URL)).toHaveLength(2);
  });

  it('a facility collection cannot be edited or deleted', async () => {
    const h = mount();
    await flush();
    const control = h.api().collections.find((c) => c.ref === 'facility:control')!;
    await expect(h.api().edit(control, (raw) => renamed(raw, 'X'))).rejects.toThrow();
    await expect(h.api().deleteCollection(control)).rejects.toThrow();
    expect(calls('PUT', `${LIST_URL}/control`)).toHaveLength(0);
    expect(calls('DELETE', `${LIST_URL}/control`)).toHaveLength(0);
  });

  it('Delete of a ticked collection: DELETE under its rev; Undo re-creates it, then ticks it', async () => {
    const h = mount();
    await flush();
    const order: string[] = [];
    route = (url, init) => {
      const method = init?.method ?? 'GET';
      if (method !== 'GET') order.push(`${method} ${url}`);
      if (method === 'DELETE') return new Response(null, { status: 204 });
      if (method === 'PUT') return listedAnswer('mine', JSON.parse(String(init!.body)), 'r9', 201);
      return defaultRoute(url, init);
    };
    const mine = h.api().collections.find((c) => c.ref === 'personal:mine')!;
    let result!: Awaited<ReturnType<CollectionsApi['deleteCollection']>>;
    await act(async () => {
      result = await h.api().deleteCollection(mine);
    });
    await flush();
    expect(header(calls('DELETE', `${LIST_URL}/mine`)[0]![1], 'If-Match')).toBe('fedcba9876543210');
    expect(h.api().collections.map((c) => c.ref)).not.toContain('personal:mine');
    expect(result).toMatchObject({ ok: true, missing: false });
    await act(async () => {
      await (result as Extract<typeof result, { ok: true }>).undo();
    });
    await flush();
    const put = calls('PUT', `${LIST_URL}/mine`)[0]![1]!;
    expect(header(put, 'If-None-Match')).toBe('*');
    expect(header(put, 'If-Match')).toBeNull();
    // Byte-identical to what was listed, minus the listed-only keys.
    expect(JSON.parse(String(put.body))).toEqual(MINE_RAW);
    expect(posted()).toEqual([{ op: 'tick', ref: 'personal:mine' }]);
    expect(order).toEqual([`DELETE ${LIST_URL}/mine`, `PUT ${LIST_URL}/mine`, `POST ${STATE_URL}`]);
    expect(h.api().collections.find((c) => c.ref === 'personal:mine')?.rev).toBe('r9');
  });

  it('Undo of a Delete of an unticked collection re-creates it without a tick', async () => {
    const h = mount();
    await flush();
    route = putRoute((_url, init) =>
      init.method === 'DELETE'
        ? new Response(null, { status: 204 })
        : listedAnswer('grid', JSON.parse(String(init.body)), 'g2', 201)
    );
    const grid = h.api().collections.find((c) => c.ref === 'personal:grid')!;
    let result!: Awaited<ReturnType<CollectionsApi['deleteCollection']>>;
    await act(async () => {
      result = await h.api().deleteCollection(grid);
    });
    await act(async () => {
      await (result as Extract<typeof result, { ok: true }>).undo();
    });
    await flush();
    const body = JSON.parse(String(calls('PUT', `${LIST_URL}/grid`)[0]![1]!.body));
    // The members and the layout come back as stored.
    expect(body.members[0]).toEqual(SR);
    expect(body.layout).toEqual({
      split: 'row',
      items: [{ tabs: [0, 1], showing: 1 }, { tabs: [2] }],
    });
    expect(posted()).toEqual([]);
  });

  it('an Undo of a Delete meeting 412 exists is typed and ticks nothing', async () => {
    const h = mount();
    await flush();
    route = putRoute((_url, init) =>
      init.method === 'DELETE'
        ? new Response(null, { status: 204 })
        : json({ code: 'exists', detail: 'exists' }, 412)
    );
    const mine = h.api().collections.find((c) => c.ref === 'personal:mine')!;
    let result!: Awaited<ReturnType<CollectionsApi['deleteCollection']>>;
    await act(async () => {
      result = await h.api().deleteCollection(mine);
    });
    let undone!: unknown;
    await act(async () => {
      undone = await (result as Extract<typeof result, { ok: true }>).undo();
    });
    await flush();
    expect(undone).toEqual({ ok: false, reason: 'exists' });
    expect(posted()).toEqual([]);
  });

  it('a stale Delete is typed and keeps the collection', async () => {
    const h = mount();
    await flush();
    route = putRoute(() => json({ code: 'stale', detail: 'stale' }, 412));
    const mine = h.api().collections.find((c) => c.ref === 'personal:mine')!;
    let result!: Awaited<ReturnType<CollectionsApi['deleteCollection']>>;
    await act(async () => {
      result = await h.api().deleteCollection(mine);
    });
    expect(result).toEqual({ ok: false, reason: 'stale' });
    expect(h.api().collections.map((c) => c.ref)).toContain('personal:mine');
  });
});

describe('useCollections poll', () => {
  /** IntersectionObserver stand-in: `report` delivers one entry to every observer. */
  let observers: { callback: IntersectionObserverCallback; target: Element | null }[];
  function report(isIntersecting: boolean) {
    for (const o of observers) {
      o.callback(
        [{ isIntersecting, target: o.target } as IntersectionObserverEntry],
        {} as IntersectionObserver
      );
    }
  }
  function rootRef() {
    return { current: document.createElement('div') };
  }

  beforeEach(() => {
    observers = [];
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        private readonly o: (typeof observers)[number];
        constructor(callback: IntersectionObserverCallback) {
          this.o = { callback, target: null };
          observers.push(this.o);
        }
        observe(target: Element) {
          this.o.target = target;
        }
        disconnect() {
          observers = observers.filter((o) => o !== this.o);
        }
        unobserve() {}
        takeRecords() {
          return [];
        }
      }
    );
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Lets one poll interval pass and settles its answers. */
  async function tick(ms = COLLECTIONS_POLL_MS) {
    act(() => {
      vi.advanceTimersByTime(ms);
    });
    await flush();
  }

  /** The If-None-Match a GET of `url` sent, call `n` (null without one). */
  function validator(url: string, n: number): string | null {
    return new Headers(calls('GET', url)[n]?.[1]?.headers).get('If-None-Match');
  }

  /** Answers the list and the state with ETags; a matching If-None-Match gets a 304. */
  function etagRoute(tags: { list: string; state: string }, bodies = { list: LIST, state: STATE }) {
    return (url: string, init: RequestInit | undefined): Response => {
      const method = init?.method ?? 'GET';
      if (method === 'GET' && (url === LIST_URL || url === STATE_URL)) {
        const etag = url === LIST_URL ? tags.list : tags.state;
        if (new Headers(init?.headers).get('If-None-Match') === etag) {
          return new Response(null, { status: 304, headers: { ETag: etag } });
        }
        return new Response(JSON.stringify(url === LIST_URL ? bodies.list : bodies.state), {
          status: 200,
          headers: { 'Content-Type': 'application/json', ETag: etag },
        });
      }
      return defaultRoute(url, init);
    };
  }

  it('polls the list and the state every COLLECTIONS_POLL_MS while the root is in view', async () => {
    route = etagRoute({ list: '"l1"', state: '"s1"' });
    mount({ root: rootRef() });
    await flush();
    act(() => report(true));
    expect(calls('GET', LIST_URL)).toHaveLength(1);
    await tick(COLLECTIONS_POLL_MS - 1);
    expect(calls('GET', LIST_URL)).toHaveLength(1);
    await tick(1);
    expect(calls('GET', LIST_URL)).toHaveLength(2);
    expect(calls('GET', STATE_URL)).toHaveLength(2);
    await tick();
    expect(calls('GET', LIST_URL)).toHaveLength(3);
    expect(calls('GET', STATE_URL)).toHaveLength(3);
  });

  it('sends the last ETag as If-None-Match with no-store, and a 304 poll does not re-render', async () => {
    route = etagRoute({ list: '"l1"', state: '"s1"' });
    const h = mount({ root: rootRef() });
    await flush();
    act(() => report(true));
    const list = h.api().collections;
    const state = h.api().state;
    expect(validator(LIST_URL, 0)).toBeNull();
    const before = renders;
    await tick();
    expect(calls('GET', LIST_URL)).toHaveLength(2);
    expect(calls('GET', LIST_URL)[1]![1]).toEqual({
      cache: 'no-store',
      headers: { 'If-None-Match': '"l1"' },
    });
    expect(validator(STATE_URL, 1)).toBe('"s1"');
    expect(renders).toBe(before);
    expect(h.api().collections).toBe(list);
    expect(h.api().state).toBe(state);
  });

  it('applies a changed list answered with a new ETag, and sends that ETag next', async () => {
    const tags = { list: '"l1"', state: '"s1"' };
    const bodies = { list: LIST, state: STATE };
    route = etagRoute(tags, bodies);
    const h = mount({ root: rootRef() });
    await flush();
    act(() => report(true));
    tags.list = '"l2"';
    bodies.list = { collections: LIST.collections.slice(0, 2) };
    await tick();
    expect(h.api().collections).toHaveLength(2);
    await tick();
    expect(validator(LIST_URL, 2)).toBe('"l2"');
  });

  it('sends no request while the root is out of view, and polls when it comes back', async () => {
    route = etagRoute({ list: '"l1"', state: '"s1"' });
    mount({ root: rootRef() });
    await flush();
    act(() => report(false));
    await tick(COLLECTIONS_POLL_MS * 3);
    expect(calls('GET', LIST_URL)).toHaveLength(1);
    expect(calls('GET', STATE_URL)).toHaveLength(1);
    await act(async () => report(true));
    await flush();
    expect(calls('GET', LIST_URL)).toHaveLength(2);
    expect(calls('GET', STATE_URL)).toHaveLength(2);
  });

  it('skips the poll while a write is in flight and drops the list ETag after its answer', async () => {
    const h = mount({ root: rootRef() });
    route = etagRoute({ list: '"l1"', state: '"s1"' });
    act(() => report(true));
    await tick();
    expect(calls('GET', LIST_URL)).toHaveLength(2);
    const answer = deferred();
    const ordinary = route;
    route = (url, init) =>
      (init?.method ?? 'GET') === 'PUT' ? answer.promise : ordinary(url, init);
    let done!: Promise<unknown>;
    act(() => {
      done = h.api().put('mine', { name: 'Mine', members: [] }, { rev: '1' });
    });
    await tick();
    expect(calls('GET', LIST_URL)).toHaveLength(2);
    expect(calls('GET', STATE_URL)).toHaveLength(2);
    await act(async () => {
      answer.resolve(
        json({
          source: 'personal',
          ref: 'personal:mine',
          id: 'mine',
          rev: 'r2',
          name: 'Mine',
          members: [],
        })
      );
      await done;
    });
    await tick();
    expect(calls('GET', LIST_URL)).toHaveLength(3);
    // The cache changed without a GET: the next list GET is unconditional.
    expect(validator(LIST_URL, 2)).toBeNull();
    expect(validator(STATE_URL, 2)).toBe('"s1"');
  });

  it('skips the poll while a state POST is in flight and drops the state ETag after it', async () => {
    const h = mount({ root: rootRef() });
    route = etagRoute({ list: '"l1"', state: '"s1"' });
    act(() => report(true));
    await tick();
    const answer = deferred();
    const ordinary = route;
    route = (url, init) =>
      (init?.method ?? 'GET') === 'POST' ? answer.promise : ordinary(url, init);
    let done!: Promise<unknown>;
    act(() => {
      done = h.api().tick('facility:spare');
    });
    await tick();
    expect(calls('GET', LIST_URL)).toHaveLength(2);
    expect(calls('GET', STATE_URL)).toHaveLength(2);
    await act(async () => {
      answer.resolve(json(STATE));
      await done;
    });
    await tick();
    expect(validator(LIST_URL, 2)).toBe('"l1"');
    expect(validator(STATE_URL, 2)).toBeNull();
  });

  it('does not start a poll while the previous one is unanswered', async () => {
    mount({ root: rootRef() });
    await flush();
    act(() => report(true));
    const list = deferred();
    route = (url, init) => (url === LIST_URL ? list.promise : defaultRoute(url, init));
    await tick();
    await tick();
    expect(calls('GET', LIST_URL)).toHaveLength(2);
    await act(async () => {
      list.resolve(json(LIST));
    });
    await flush();
    route = defaultRoute;
    await tick();
    expect(calls('GET', LIST_URL)).toHaveLength(3);
  });

  it('polls without a root (no observer to ask) and stops on unmount', async () => {
    mount();
    await flush();
    await tick();
    expect(calls('GET', LIST_URL)).toHaveLength(2);
    cleanup();
    await tick(COLLECTIONS_POLL_MS * 2);
    expect(calls('GET', LIST_URL)).toHaveLength(2);
  });

  it('keeps a held collection as shown and applies its polled listing on release', async () => {
    const tags = { list: '"l1"', state: '"s1"' };
    const bodies = { list: LIST, state: STATE };
    route = etagRoute(tags, bodies);
    const h = mount({ root: rootRef() });
    await flush();
    act(() => report(true));
    act(() => h.api().holdCollection('personal:mine'));
    tags.list = '"l2"';
    bodies.list = {
      collections: LIST.collections.map((c) =>
        c.ref === 'personal:mine'
          ? { ...c, name: 'Renamed elsewhere' }
          : c.ref === 'facility:spare'
            ? { ...c, name: 'Spare 2' }
            : c
      ),
    };
    await tick();
    const name = (ref: string) => h.api().collections.find((c) => c.ref === ref)?.name;
    // Every other collection updates at once; the held one waits.
    expect(name('facility:spare')).toBe('Spare 2');
    expect(name('personal:mine')).toBe('Mine');
    act(() => h.api().holdCollection(null));
    expect(name('personal:mine')).toBe('Renamed elsewhere');
  });

  it('keeps a held collection the poll no longer lists, and drops it on release', async () => {
    const tags = { list: '"l1"', state: '"s1"' };
    const bodies = { list: LIST, state: STATE };
    route = etagRoute(tags, bodies);
    const h = mount({ root: rootRef() });
    await flush();
    act(() => report(true));
    act(() => h.api().holdCollection('personal:grid'));
    tags.list = '"l2"';
    bodies.list = {
      collections: LIST.collections.filter((c) => c.ref !== 'personal:grid'),
    };
    await tick();
    expect(h.api().collections.map((c) => c.ref)).toEqual([
      'facility:control',
      'facility:injector',
      'facility:spare',
      'personal:grid',
      'personal:mine',
    ]);
    act(() => h.api().holdCollection(null));
    expect(h.api().collections.map((c) => c.ref)).not.toContain('personal:grid');
  });

  it('a release with nothing buffered changes nothing', async () => {
    route = etagRoute({ list: '"l1"', state: '"s1"' });
    const h = mount({ root: rootRef() });
    await flush();
    act(() => report(true));
    const list = h.api().collections;
    act(() => h.api().holdCollection('personal:mine'));
    await tick();
    const before = renders;
    act(() => h.api().holdCollection(null));
    expect(renders).toBe(before);
    expect(h.api().collections).toBe(list);
  });
});

describe('useCollections openAll as a promise (the agent path)', () => {
  async function run(h: Harness, ref: string, options?: OpenAllOptions): Promise<OpenAllResult> {
    const collection = h.api().collections.find((c) => c.ref === ref)!;
    let pending!: Promise<OpenAllResult>;
    await act(async () => {
      pending = h.api().openAll(collection, options);
    });
    const result = await pending;
    return result;
  }

  it('resolves once committed, with each member key in member order', async () => {
    const h = mount();
    await flush();
    const result = await run(h, 'facility:control', { as: 'tabs', caller: 'agent' });
    expect(result).toEqual({ keys: ['library/sr/overview', '@trace'], changed: true, group: null });
    // As tabs: one tile holding both.
    expect(h.tabs().layout).toMatchObject({ tabs: ['library/sr/overview', '@trace'] });
  });

  it('an agent picks tabs, side by side or the collection layout at open time', async () => {
    const h = mount();
    await flush();
    await run(h, 'personal:grid', { as: 'side', caller: 'agent' });
    expect(h.tabs().layout).toMatchObject({ split: 'row' });
    expect(keysOf(h.tabs().layout)).toHaveLength(3);
  });

  it("a layout open names its undo group, recorded as the agent's", async () => {
    const start = tabsReducer(EMPTY_TABS, {
      type: 'open',
      key: 'library/gtb/GTLView',
      mode: 'append',
    });
    const h = mount({}, start);
    await flush();
    const result = await run(h, 'personal:grid', { closedBy: 'agent', caller: 'agent' });
    expect(result.group).not.toBeNull();
    const entry = h.tabs().closedStack!.at(-1)!;
    expect(entry.id).toBe(result.group);
    expect(entry.closedBy).toBe('agent');
  });

  it('an exact layout over the member indexes opens as given', async () => {
    const h = mount();
    await flush();
    const result = await run(h, 'facility:control', {
      caller: 'agent',
      layout: { split: 'column', items: [{ tabs: [1] }, { tabs: [0] }] },
    });
    expect(result.changed).toBe(true);
    expect(h.tabs().layout).toMatchObject({
      split: 'column',
      items: [{ tabs: ['@trace'] }, { tabs: ['library/sr/overview'] }],
    });
  });

  it('refuses an exact layout that breaks a rule, the dock unchanged', async () => {
    const h = mount();
    await flush();
    const result = await run(h, 'facility:control', { caller: 'agent', layout: { tabs: [0] } });
    expect(result.refusal).toBe('layout: member_missing: every member is placed in a tile');
    expect(h.tabs().keys).toEqual([]);
  });

  it("an agent's layout open of a collection without one is refused", async () => {
    const h = mount();
    await flush();
    const result = await run(h, 'facility:control', { as: 'layout', caller: 'agent' });
    expect(result.refusal).toBe(NO_LAYOUT);
    expect(h.tabs().keys).toEqual([]);
  });

  it('held for the first manifest, it resolves once that arrives', async () => {
    const h = mount({ screens: null });
    await flush();
    const collection = h.api().collections.find((c) => c.ref === 'facility:control')!;
    let result: OpenAllResult | null = null;
    await act(async () => {
      void h
        .api()
        .openAll(collection)
        .then((r) => (result = r));
    });
    expect(result).toBeNull();
    await act(async () => h.rerender({ screens: SCREENS }));
    await flush();
    expect(result).toMatchObject({ keys: ['library/sr/overview', '@trace'], changed: true });
  });

  it('an Open all of what is already open resolves unchanged', async () => {
    const h = mount();
    await flush();
    await run(h, 'facility:control', { as: 'tabs', caller: 'agent' });
    const again = await run(h, 'facility:control', { as: 'tabs', caller: 'agent' });
    expect(again).toEqual({ keys: ['library/sr/overview', '@trace'], changed: false, group: null });
  });
});
