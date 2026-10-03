// The static source's lookup, with the fixture tree and cases of the Canopy
// endpoint it replaces (slaclab/canopy#130, tests/canopy/displays/
// test_files_endpoint.py), so the two resolve names alike.

import { describe, expect, it, vi } from 'vitest';
import { EdmHttpError } from './source.js';
import { DisplayTree, latin1, staticDisplaySource } from './static.js';

const ROOT_ALIAS = '/path/to/edm/displays';

// What the snapshot's index lists: served types only (notes.txt and colors.list are
// in the reference tree on disk but would not be indexed; they're listed here so the
// suffix check is what refuses them). folder.edl is a directory, so never indexed.
const FILES = [
  'top.edl',
  'misc/motors/main.edl',
  'misc/motors/near.edl',
  'misc/near.edl',
  'misc/ancestor_only.edl',
  'common/ancestor_only.edl',
  'common/both.edl',
  'lib/both.edl',
  'lib/only_lib.edl',
  'notes.txt',
  'colors.list',
  'images/logo.png',
  'images/ICON.PNG',
];

const tree = () =>
  new DisplayTree(FILES, { searchDirs: ['', 'common', 'lib'], rootAliases: [ROOT_ALIAS] });

describe('DisplayTree lookup (as canopy#130)', () => {
  it('bare name is found on the search path', () => {
    expect(tree().find('only_lib.edl')).toBe('lib/only_lib.edl');
  });

  it('search dirs are tried in order', () => {
    expect(tree().find('both.edl')).toBe('common/both.edl');
  });

  it('empty search dir is the root', () => {
    expect(tree().find('top.edl')).toBe('top.edl');
  });

  it("referring file's directory comes first", () => {
    expect(tree().find('near.edl', 'misc/motors/main.edl')).toBe('misc/motors/near.edl');
  });

  it('ancestors come before the search path', () => {
    expect(tree().find('ancestor_only.edl', 'misc/motors/main.edl')).toBe('misc/ancestor_only.edl');
    expect(tree().find('ancestor_only.edl')).toBe('common/ancestor_only.edl');
  });

  it('parent reference inside the root is followed', () => {
    expect(tree().find('../near.edl', 'misc/motors/main.edl')).toBe('misc/near.edl');
  });

  it('root alias maps onto the root, in names and in the referring path', () => {
    expect(tree().find(`${ROOT_ALIAS}/lib/only_lib.edl`)).toBe('lib/only_lib.edl');
    expect(tree().find('near.edl', `${ROOT_ALIAS}/misc/motors/main.edl`)).toBe(
      'misc/motors/near.edl'
    );
  });

  it('backslashes are path separators', () => {
    expect(tree().find('lib\\only_lib.edl')).toBe('lib/only_lib.edl');
  });

  it('images are found; the suffix match ignores case, the path does not', () => {
    expect(tree().find('images/logo.png')).toBe('images/logo.png');
    expect(tree().find('images/ICON.PNG')).toBe('images/ICON.PNG');
    expect(tree().find('images/icon.png')).toBeNull();
  });

  it.each([
    ['missing file', 'missing.edl', undefined],
    ['absolute name outside every alias', '/etc/top.edl', undefined],
    ['alias that leaves the name absolute', `${ROOT_ALIAS}//top.edl`, undefined],
    ['dotdot cannot leave the root', '../../outside/secret.edl', undefined],
    ['dotdot through a directory', 'common/../../outside/secret.edl', undefined],
    ['relativeTo cannot leave the root', 'top.edl', '../outside/x.edl'],
    ['NUL in the name', 'top\u0000.edl', undefined],
    ['newline in the name', 'top\n.edl', undefined],
    ['control character in relativeTo', 'top.edl', 'misc/\u0001x.edl'],
    ['overlong relativeTo', 'top.edl', `${'a/'.repeat(2100)}x.edl`],
    ['non-latin-1 name', 'top€.edl', undefined],
    ['unserved type', 'notes.txt', undefined],
    ['config list is not a tree file', 'colors.list', undefined],
    ['directory', 'folder.edl', undefined],
    ['the root itself', '.edl', undefined],
  ])('not found: %s', (_, name, relativeTo) => {
    expect(tree().find(name, relativeTo)).toBeNull();
  });

  it('refuses a search directory outside the root', () => {
    expect(() => new DisplayTree(FILES, { searchDirs: ['../x'] })).toThrow();
    expect(() => new DisplayTree(FILES, { searchDirs: ['/abs'] })).toThrow();
    expect(new DisplayTree(FILES, { searchDirs: ['.', 'lib/'] }).searchDirs).toEqual(['', 'lib']);
  });
});

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function stubTree(index: object, files: Record<string, ArrayBuffer | string>) {
  return vi.fn<FetchFn>(async (input) => {
    const url = String(input);
    if (url === '/edm/index.json') return Response.json(index);
    const body = files[url];
    return body === undefined ? new Response('not found', { status: 404 }) : new Response(body);
  });
}

describe('staticDisplaySource', () => {
  const index = { files: FILES, searchDirs: ['', 'common', 'lib'], rootAliases: [ROOT_ALIAS] };

  it('resolves against the index (fetched once), decoding latin-1, with no credentials', async () => {
    const fetchFn = stubTree(index, {
      '/edm/misc/near.edl': new Uint8Array([0x34, 0x20, 0xb0, 0x43]).buffer, // "4 °C" in latin-1
      '/edm/lib/only_lib.edl': '# lib/only_lib.edl\n',
    });
    const source = staticDisplaySource('/edm/', { fetch: fetchFn });
    expect(await source.load('../near.edl', 'misc/motors/main.edl')).toEqual({
      path: 'misc/near.edl',
      text: '4 °C',
    });
    expect((await source.load('only_lib.edl')).path).toBe('lib/only_lib.edl');
    const urls = fetchFn.mock.calls.map(([u]) => String(u));
    expect(urls.filter((u) => u.endsWith('index.json'))).toHaveLength(1);
    for (const [, init] of fetchFn.mock.calls) expect(init).toBeUndefined();
  });

  it('fetches images and config lists from their static paths', async () => {
    const fetchFn = stubTree(index, {
      '/edm/images/logo.png': new Uint8Array([1, 2, 3]).buffer,
      '/edm/config/colors.list': '4 0 0\n',
    });
    const source = staticDisplaySource('/edm', { fetch: fetchFn });
    expect((await source.image('logo.png', 'images/x.edl')).size).toBe(3);
    expect(await source.config('colors.list')).toBe('4 0 0\n');
    await expect(source.config('passwd' as 'colors.list')).rejects.toMatchObject({ status: 404 });
  });

  it('reports a name the index lacks as a 404, without fetching it', async () => {
    const fetchFn = stubTree(index, {});
    const source = staticDisplaySource('/edm', { fetch: fetchFn });
    await expect(source.load('../../outside/secret.edl')).rejects.toBeInstanceOf(EdmHttpError);
    await expect(source.load('missing.edl')).rejects.toMatchObject({ status: 404 });
    expect(fetchFn.mock.calls.map(([u]) => String(u))).toEqual(['/edm/index.json']);
  });

  it('lets options override the index; encodes the path it fetches', async () => {
    const fetchFn = stubTree(
      { files: ['lib/a b.edl', 'common/a b.edl'], searchDirs: ['common', 'lib'] },
      { '/edm/lib/a%20b.edl': 'lib' }
    );
    const source = staticDisplaySource('/edm', { fetch: fetchFn, searchDirs: ['lib'] });
    expect(await source.load('a b.edl')).toEqual({ path: 'lib/a b.edl', text: 'lib' });
  });

  it('retries the index after a failure', async () => {
    let fail = true;
    const fetchFn = vi.fn<FetchFn>(async (input) => {
      if (String(input) !== '/edm/index.json') return new Response('# top');
      if (fail) return new Response('', { status: 503 });
      return Response.json(index);
    });
    const source = staticDisplaySource('/edm', { fetch: fetchFn });
    await expect(source.load('top.edl')).rejects.toMatchObject({ status: 503 });
    fail = false;
    expect((await source.load('top.edl')).path).toBe('top.edl');
  });

  it('latin1 maps every byte to its code point', () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    const text = latin1(bytes.buffer);
    expect([...text].map((c) => c.charCodeAt(0))).toEqual([...bytes]);
  });
});
