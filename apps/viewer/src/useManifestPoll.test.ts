// useManifestPoll: a three-second, conditional manifest poll that turns a change of the
// open document's rev (or of any entry beside it) into a new generation, and
// that never starts for a static site whose entries carry no rev.

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManifestScreen } from './api.js';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import type { SharedManifest } from './useManifestPoll.js';
import { SharedManifestContext, useManifestPoll } from './useManifestPoll.js';

const BASE = 'http://h/drafts/';
const OPEN = 'screens/drafts/panel.screen.json';

function entry(path: string, rev?: string): ManifestScreen {
  return { id: path, kind: 'ir', title: path, category: 'drafts', path, rev };
}

let manifest: { screens: ManifestScreen[] } | null;
let failWith: 'network' | 'status' | null;
let etag: string | null;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  manifest = {
    screens: [
      entry(OPEN, 'r1'),
      entry('screens/drafts/embedded.screen.json', 'e1'),
      entry('screens/other/elsewhere.screen.json', 'x1'),
    ],
  };
  failWith = null;
  etag = null;
  fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    if (failWith === 'network') throw new TypeError('Failed to fetch');
    if (failWith === 'status')
      return new Response('nope', { status: 404, statusText: 'Not Found' });
    if (etag !== null && new Headers(init?.headers).get('If-None-Match') === etag) {
      return new Response(null, { status: 304, headers: { ETag: etag } });
    }
    return new Response(JSON.stringify(manifest), {
      status: 200,
      headers: etag === null ? {} : { ETag: etag },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function setRev(path: string, rev: string): void {
  if (!manifest) throw new Error('no manifest');
  manifest = { screens: manifest.screens.map((s) => (s.path === path ? { ...s, rev } : s)) };
}

/** The server's validator for the current manifest; a change means a new document. */
function setEtag(value: string): void {
  etag = value;
}

async function tick(ms = 3000): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function renderPoll(openPath: string | undefined, openRev: string | undefined) {
  let renders = 0;
  const hook = renderHook(
    ({ path, rev }: { path: string | undefined; rev: string | undefined }) => {
      renders += 1;
      return useManifestPoll(BASE, path, rev);
    },
    { initialProps: { path: openPath, rev: openRev } }
  );
  return { hook, renders: () => renders };
}

describe('useManifestPoll', () => {
  it('fetches manifest.json past the HTTP cache every three seconds', async () => {
    renderPoll(OPEN, 'r1');
    expect(fetchMock).not.toHaveBeenCalled();

    await tick();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('http://h/drafts/manifest.json', {
      cache: 'no-cache',
    });

    await tick();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await tick(9000);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('does not re-render while the revs stay the same', async () => {
    const { hook, renders } = renderPoll(OPEN, 'r1');
    const before = renders();
    const first = hook.result.current;

    await tick(15000);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(renders()).toBe(before);
    expect(hook.result.current).toBe(first);
  });

  it('bumps the generation when the open document rev changes', async () => {
    const { hook, renders } = renderPoll(OPEN, 'r1');
    await tick();
    const first = hook.result.current;
    const before = renders();

    setRev(OPEN, 'r2');
    await tick();
    expect(hook.result.current).not.toBe(first);
    expect(renders()).toBe(before + 1);

    // Stable again: no further re-render.
    await tick(3000);
    expect(renders()).toBe(before + 1);
  });

  it('bumps the generation when an entry in the open directory changes', async () => {
    const { hook } = renderPoll(OPEN, 'r1');
    await tick();
    const first = hook.result.current;

    setRev('screens/drafts/embedded.screen.json', 'e2');
    await tick();
    expect(hook.result.current).not.toBe(first);
  });

  it('ignores entries outside the open directory', async () => {
    const { hook, renders } = renderPoll(OPEN, 'r1');
    await tick();
    const first = hook.result.current;
    const before = renders();

    setRev('screens/other/elsewhere.screen.json', 'x2');
    await tick(6000);
    expect(hook.result.current).toBe(first);
    expect(renders()).toBe(before);
  });

  it('bumps on the first poll when the document changed since it was loaded', async () => {
    const { hook } = renderPoll(OPEN, 'r0');
    const first = hook.result.current;
    await tick();
    expect(hook.result.current).not.toBe(first);
  });

  it('never polls when the open entry carries no rev', async () => {
    renderPoll(OPEN, undefined);
    await tick(5000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never polls when no document is open', async () => {
    renderPoll(undefined, undefined);
    await tick(5000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the last value and retries on network errors and a missing manifest', async () => {
    const { hook, renders } = renderPoll(OPEN, 'r1');
    await tick();
    const first = hook.result.current;
    const before = renders();

    failWith = 'network';
    await tick();
    failWith = 'status';
    await tick();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(hook.result.current).toBe(first);
    expect(renders()).toBe(before);

    failWith = null;
    setRev(OPEN, 'r2');
    await tick();
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(hook.result.current).not.toBe(first);
  });

  it('keeps the generation stable when the reloaded rev is fed back in', async () => {
    const { hook, renders } = renderPoll(OPEN, 'r1');
    await tick();
    setRev(OPEN, 'r2');
    await tick();
    const bumped = hook.result.current;

    // The page refetched the document and now passes the new rev.
    hook.rerender({ path: OPEN, rev: 'r2' });
    const before = renders();
    await tick(3000);
    expect(hook.result.current).toBe(bumped);
    expect(renders()).toBe(before);
  });

  it('stops polling on unmount', async () => {
    const { hook } = renderPoll(OPEN, 'r1');
    await tick();
    hook.unmount();
    await tick(3000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends the ETag it last saw and leaves the generation alone on a 304', async () => {
    setEtag('"m1"');
    const { hook, renders } = renderPoll(OPEN, 'r1');
    await tick();
    expect(fetchMock.mock.calls[0]![1]).toEqual({ cache: 'no-cache' });
    const first = hook.result.current;
    const before = renders();

    await tick();
    expect(fetchMock.mock.calls[1]![1]).toEqual({
      cache: 'no-store',
      headers: { 'If-None-Match': '"m1"' },
    });
    expect(hook.result.current).toBe(first);
    expect(renders()).toBe(before);

    // The document changed: a new validator, a 200, a bump — and the new
    // validator goes out on the poll after.
    setRev(OPEN, 'r2');
    setEtag('"m2"');
    await tick();
    expect(hook.result.current).not.toBe(first);
    await tick();
    expect(fetchMock.mock.calls[3]![1]).toEqual({
      cache: 'no-store',
      headers: { 'If-None-Match': '"m2"' },
    });
  });

  it('polls at once when the document becomes visible, and not while it is hidden', async () => {
    let visibility: DocumentVisibilityState = 'hidden';
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visibility,
    });
    try {
      renderPoll(OPEN, 'r1');
      await tick(9000);
      expect(fetchMock).not.toHaveBeenCalled();

      visibility = 'visible';
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      delete (document as { visibilityState?: unknown }).visibilityState;
    }
  });
});

describe('useManifestPoll with a shared manifest', () => {
  function renderShared(shared: SharedManifest, openRev = 'r1') {
    let value = shared;
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(SharedManifestContext.Provider, { value }, children);
    const hook = renderHook(() => useManifestPoll(BASE, OPEN, openRev), { wrapper });
    return {
      hook,
      publish(next: SharedManifest) {
        value = next;
        hook.rerender();
      },
    };
  }

  it('never fetches on its own: the workspace poll feeds it', async () => {
    renderShared({ base: BASE, manifest: manifest! });
    await tick(5000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('bumps when a delivered manifest changes the open rev, once', async () => {
    const { hook, publish } = renderShared({ base: BASE, manifest: manifest! });
    const first = hook.result.current;
    setRev(OPEN, 'r2');
    publish({ base: BASE, manifest: manifest! });
    const bumped = hook.result.current;
    expect(bumped).not.toBe(first);
    // The same revs again (a new object from the next poll): no bump.
    publish({ base: BASE, manifest: { screens: [...manifest!.screens] } });
    expect(hook.result.current).toBe(bumped);
  });

  it('polls for itself when the shared manifest is for another base', async () => {
    renderShared({ base: 'http://elsewhere/', manifest: null });
    await tick();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
