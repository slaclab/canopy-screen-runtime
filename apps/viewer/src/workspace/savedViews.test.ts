// savedViews: the client of canopy_mcp's saved data browser views.

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  deleteView,
  listViews,
  saveView,
  kindedViewId,
  viewId,
  viewNameProblem,
  viewsUrl,
} from './savedViews.js';

afterEach(() => vi.unstubAllGlobals());

function serve(status: number, body?: unknown) {
  const impl = vi.fn(
    async () =>
      new Response(body === undefined ? null : JSON.stringify(body), {
        status,
        statusText: status === 200 ? 'OK' : 'Nope',
      })
  );
  vi.stubGlobal('fetch', impl);
  return impl;
}

describe('viewId', () => {
  it.each([
    ['Gun vacuum', 'gun-vacuum'],
    ['  RF / forward power (12 h)  ', 'rf-forward-power-12-h'],
    ['Électron gun', 'electron-gun'],
    ['a'.repeat(80), 'a'.repeat(64)],
    [`${'a'.repeat(63)} b`, 'a'.repeat(63)],
  ])('%j -> %j', (name, id) => {
    expect(viewId(name)).toBe(id);
  });

  it('hashes a name with no ASCII letter or digit, stably', () => {
    const id = viewId('真空');
    expect(id).toMatch(/^view-[0-9a-z]+$/);
    expect(viewId('真空')).toBe(id);
    expect(viewId('電子')).not.toBe(id);
  });

  it('is empty for a blank name', () => {
    expect(viewId('   ')).toBe('');
  });
});

describe('viewNameProblem', () => {
  it('accepts a normal name and refuses blank, long and control characters', () => {
    expect(viewNameProblem('Gun vacuum')).toBeNull();
    expect(viewNameProblem('  ')).toMatch(/name/);
    expect(viewNameProblem('x'.repeat(121))).toMatch(/120/);
    expect(viewNameProblem('a\u0007b')).toMatch(/control/);
  });
});

describe('viewsUrl', () => {
  it('resolves under the mount prefix and encodes the id', () => {
    expect(viewsUrl('views', 'http://h/u/x/panel/canopy/')).toBe('http://h/u/x/panel/canopy/views');
    expect(viewsUrl('views/', 'http://h/p/', 'gun-vacuum')).toBe('http://h/p/views/gun-vacuum');
  });
});

describe('requests', () => {
  it('lists past the cache and drops malformed entries', async () => {
    const fetchImpl = serve(200, {
      views: [
        { id: 'ok', name: 'OK', query: 'pv=A' },
        { id: '../x', name: 'Bad id', query: '' },
        { id: 'noname', name: '', query: '' },
        { id: 'big', name: 'Big', query: 'x'.repeat(5000) },
      ],
    });
    expect(await listViews('views', 'http://h/')).toEqual([
      { id: 'ok', name: 'OK', kind: 'trace', query: 'pv=A' },
    ]);
    expect(fetchImpl).toHaveBeenCalledWith('http://h/views', { cache: 'no-cache' });
  });

  it('saves with a JSON PUT under the derived id', async () => {
    const fetchImpl = serve(201, { id: 'gun-vacuum', name: 'Gun vacuum', query: 'pv=A' });
    const view = await saveView('views', 'http://h/', '  Gun vacuum ', 'pv=A');
    expect(view.id).toBe('gun-vacuum');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://h/views/gun-vacuum');
    expect(init.method).toBe('PUT');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(String(init.body))).toEqual({ name: 'Gun vacuum', query: 'pv=A' });
  });

  it("saves and lists a query carrying Trace's axis settings verbatim", async () => {
    const query =
      'pv=GTL:BPM1:X&pv=GTL:QF1:I&range=-6h' +
      '&plot={%22v%22:1,%22axes%22:[{},{%22logScale%22:true}],%22traces%22:[{},{%22axis%22:1}]}';
    const put = serve(201, { id: 'gtl', name: 'GTL', query });
    expect((await saveView('views', 'http://h/', 'GTL', query)).query).toBe(query);
    const [, init] = put.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).query).toBe(query);
    serve(200, { views: [{ id: 'gtl', name: 'GTL', query }] });
    expect(await listViews('views', 'http://h/')).toEqual([
      { id: 'gtl', name: 'GTL', kind: 'trace', query },
    ]);
  });

  it("reports the server's error text and refuses a bad name before any request", async () => {
    serve(400, { code: 'invalid_view', detail: 'query is over 4096 bytes' });
    await expect(saveView('views', 'http://h/', 'X', 'pv=A')).rejects.toThrow(
      'Could not save the view: query is over 4096 bytes'
    );
    const fetchImpl = serve(201, {});
    await expect(saveView('views', 'http://h/', ' ', 'pv=A')).rejects.toThrow('Enter a name.');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reads kind, defaulting to trace, and keeps unknown kinds listed', async () => {
    serve(200, {
      views: [
        { id: 'a', name: 'A', query: 'pv=A' },
        { id: 'correlation_b', name: 'B', kind: 'correlation', query: 'x=X&y=Y' },
        { id: 'waveform_w', name: 'W', kind: 'waveform', query: 'pv=WF' },
        { id: 'c', name: 'C', kind: 'future-tool', query: '' },
        { id: 'd', name: 'D', kind: 'Bad Kind', query: '' },
      ],
    });
    expect((await listViews('views', 'http://h/')).map((v) => v.kind)).toEqual([
      'trace',
      'correlation',
      'waveform',
      'future-tool',
      '?',
    ]);
  });

  it('a trace save omits kind; a correlation save sends it under a kinded id', async () => {
    const trace = serve(201, { id: 'rf', name: 'RF', query: 'pv=A' });
    await saveView('views', 'http://h/', 'RF', 'pv=A', 'trace');
    let [url, init] = trace.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://h/views/rf');
    expect(JSON.parse(String(init.body))).toEqual({ name: 'RF', query: 'pv=A' });

    const corr = serve(201, {
      id: 'correlation_rf',
      name: 'RF',
      kind: 'correlation',
      query: 'x=A',
    });
    const view = await saveView('views', 'http://h/', 'RF', 'x=A', 'correlation');
    [url, init] = corr.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://h/views/correlation_rf');
    expect(JSON.parse(String(init.body))).toEqual({
      name: 'RF',
      query: 'x=A',
      kind: 'correlation',
    });
    expect(view.kind).toBe('correlation');
  });

  it('a waveform save sends kind waveform under a waveform_ id', async () => {
    const wf = serve(201, { id: 'waveform_bpm', name: 'BPM', kind: 'waveform', query: 'pv=WF' });
    const view = await saveView('views', 'http://h/', 'BPM', 'pv=WF', 'waveform');
    const [url, init] = wf.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://h/views/waveform_bpm');
    expect(JSON.parse(String(init.body))).toEqual({
      name: 'BPM',
      query: 'pv=WF',
      kind: 'waveform',
    });
    expect(view).toMatchObject({ id: 'waveform_bpm', kind: 'waveform', query: 'pv=WF' });
  });

  it('kindedViewId keeps trace ids and prefixes others, cut to 64', () => {
    expect(kindedViewId('Gun vacuum', 'trace')).toBe('gun-vacuum');
    expect(kindedViewId('Gun vacuum', 'correlation')).toBe('correlation_gun-vacuum');
    expect(kindedViewId('x'.repeat(80), 'correlation')).toHaveLength(64);
    expect(kindedViewId(' ', 'correlation')).toBe('');
  });

  it('shows a 409 (another kind under that id) as the error', async () => {
    serve(409, { code: 'kind_conflict', detail: "view 'rf' is a trace view" });
    await expect(saveView('views', 'http://h/', 'RF', 'pv=A')).rejects.toThrow(
      "Could not save the view: view 'rf' is a trace view"
    );
  });

  it('treats deleting a missing view as done', async () => {
    serve(404);
    await expect(deleteView('views', 'http://h/', 'gone')).resolves.toBeUndefined();
    serve(403, { code: 'cross_site', detail: 'cross-site write refused' });
    await expect(deleteView('views', 'http://h/', 'x')).rejects.toThrow('cross-site');
  });
});
