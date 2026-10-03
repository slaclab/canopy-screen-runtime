// A display source over static files: a frozen display tree published as plain
// files under {base}/, in the layout of the production display root, with
//
//   {base}/index.json   { "files": [...], "searchDirs"?: [...], "rootAliases"?: [...] }
//                       every served file's path under the root, plus the tree's
//                       search path and root aliases (scripts/snapshot-display-tree.mjs
//                       writes it when the snapshot is taken)
//   {base}/config/{colors,fonts,calc}.list   the site config
//
// {base} is the display root: a path a display or a manifest names ("misc/sdr_fb.edl")
// is a file under it. Names are resolved here, in the browser, against the index,
// the way EDM's EDMDATAFILES search does (and the read-only Canopy endpoint of
// slaclab/canopy#130 did, which this replaces):
//
//   - a leading root alias (/path/to/edm/displays/) maps onto the root;
//     any other absolute name is not found;
//   - backslashes are separators; ".." never leaves the root;
//   - the referring file's directory and each ancestor short of the root (deepest
//     first), then the search directories in order ("" is the root); the first
//     indexed file wins;
//   - only served suffixes count (.edl and images, any case);
//   - a referring path that is unusable (leaves the root, holds control characters,
//     is too long) fails the lookup.
//
// The path found is what load() returns, and the next lookup's relativeTo. No
// credentials are sent: the static host is protected like the viewer itself.

import type { EdmDisplaySource } from './source.js';
import { EdmHttpError } from './source.js';

export const DEFAULT_DISPLAY_SUFFIXES = ['.edl', '.png', '.gif', '.jpg', '.jpeg', '.xpm'];
const CONFIG_NAMES = new Set(['colors.list', 'fonts.list', 'calc.list']);

/** {base}/index.json. */
export interface DisplayTreeIndexFile {
  readonly files: readonly string[];
  readonly searchDirs?: readonly string[];
  readonly rootAliases?: readonly string[];
}

export interface DisplayTreeOptions {
  /** Directories under the root searched after the referrer's; "" is the root. Default [""]. */
  readonly searchDirs?: readonly string[];
  /** Absolute paths that mean the root in display files. */
  readonly rootAliases?: readonly string[];
  /** Served file suffixes (matched case-insensitively). */
  readonly suffixes?: readonly string[];
  /** Longest relativeTo accepted. Default 4096. */
  readonly maxRelativeToChars?: number;
}

/** POSIX normpath: "." and empty segments dropped, ".." folded; "." for nothing. */
function normpath(path: string): string {
  const absolute = path.startsWith('/');
  const out: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop();
      else if (!absolute) out.push('..');
    } else out.push(segment);
  }
  const body = out.join('/');
  return absolute ? `/${body}` : body || '.';
}

/** `path` normalised, or null when it is the root itself, absolute, or leaves the root. */
function lexicallyWithin(path: string): string | null {
  const normal = normpath(path);
  if (normal === '.' || normal === '..' || normal.startsWith('../') || normal.startsWith('/')) {
    return null;
  }
  return normal;
}

/** No control characters, and latin-1 only (what a display file can hold). */
function usable(text: string): boolean {
  // eslint-disable-next-line no-control-regex
  return !/[\u0000-\u001f\u007f]|[^\u0000-ÿ]/.test(text);
}

/** The suffix of the last segment, as Python's splitext finds it ("" for ".edl"). */
function suffixOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 && base.slice(0, dot).replace(/^\.+/, '') !== '' ? base.slice(dot) : '';
}

const dirname = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** EDMDATAFILES-style lookup over the files of one display tree. */
export class DisplayTree {
  private readonly files: ReadonlySet<string>;
  readonly searchDirs: readonly string[];
  private readonly aliases: readonly string[];
  private readonly suffixes: ReadonlySet<string>;
  private readonly maxRelativeToChars: number;

  /** Throws when a search directory is absolute or leaves the root. */
  constructor(files: Iterable<string>, options: DisplayTreeOptions = {}) {
    this.files = new Set(files);
    this.searchDirs = (options.searchDirs ?? ['']).map((dir) => {
      if (normpath(dir || '.') === '.') return '';
      const within = lexicallyWithin(dir);
      if (within === null) throw new Error(`search directory "${dir}" is not inside the root`);
      return within;
    });
    this.aliases = (options.rootAliases ?? []).map((a) => `${a.replace(/\/+$/, '')}/`);
    this.suffixes = new Set(
      (options.suffixes ?? DEFAULT_DISPLAY_SUFFIXES).map((s) => s.toLowerCase())
    );
    this.maxRelativeToChars = options.maxRelativeToChars ?? 4096;
  }

  /** The path under the root of the file `name` names, seen from `relativeTo`; null if none. */
  find(name: string, relativeTo?: string): string | null {
    const local = this.localName(name);
    if (local === null || !this.suffixes.has(suffixOf(local).toLowerCase())) return null;
    let referrer: string | null = null;
    if (relativeTo) {
      referrer = this.referringPath(relativeTo);
      if (referrer === null) return null;
    }
    for (const directory of this.lookupDirs(referrer)) {
      const path = lexicallyWithin(directory ? `${directory}/${local}` : local);
      if (path !== null && this.files.has(path)) return path;
    }
    return null;
  }

  private unalias(path: string): string {
    const alias = this.aliases.find((a) => path.startsWith(a));
    return alias ? path.slice(alias.length) : path;
  }

  private localName(raw: string): string | null {
    if (!usable(raw)) return null;
    // Still absolute after the alias: outside the tree (a join would make it so too).
    const local = this.unalias(raw.replace(/\\/g, '/'));
    return local.startsWith('/') ? null : local;
  }

  private referringPath(relativeTo: string): string | null {
    if (relativeTo.length > this.maxRelativeToChars || !usable(relativeTo)) return null;
    return lexicallyWithin(this.unalias(relativeTo.replace(/\\/g, '/')).replace(/^\/+/, ''));
  }

  private *lookupDirs(referrer: string | null): Generator<string> {
    if (referrer !== null) {
      for (let directory = dirname(referrer); directory; directory = dirname(directory)) {
        yield directory;
      }
    }
    yield* this.searchDirs;
  }
}

/** Bytes as latin-1 text (display files are latin-1; a static host names no charset). */
export function latin1(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let text = '';
  for (let i = 0; i < view.length; i += 0x8000) {
    text += String.fromCharCode(...view.subarray(i, i + 0x8000));
  }
  return text;
}

export interface StaticDisplaySourceOptions extends DisplayTreeOptions {
  /** Where the config lists live under {base}. Default "config". */
  readonly configDir?: string;
  readonly fetch?: typeof fetch;
}

/**
 * A display source over a static display tree at `base` (see the top of this
 * file). The index is fetched once, on first use; searchDirs and rootAliases
 * given here win over the index's own.
 */
export function staticDisplaySource(
  base: string,
  options: StaticDisplaySourceOptions = {}
): EdmDisplaySource {
  const fetchFn = options.fetch ?? ((input: RequestInfo | URL) => fetch(input));
  const root = base.replace(/\/+$/, '');
  const configDir = (options.configDir ?? 'config').replace(/^\/+|\/+$/g, '');
  const get = async (target: string, what: string) => {
    const res = await fetchFn(target);
    if (!res.ok) throw new EdmHttpError(`${what}: HTTP ${res.status}`, res.status);
    return res;
  };
  let tree: Promise<DisplayTree> | null = null;
  const loadTree = () => {
    tree ??= get(`${root}/index.json`, 'index.json')
      .then((res) => res.json() as Promise<DisplayTreeIndexFile>)
      .then((index) => {
        if (!Array.isArray(index.files)) throw new Error('index.json has no files[] array');
        return new DisplayTree(index.files, {
          ...options,
          searchDirs: options.searchDirs ?? index.searchDirs,
          rootAliases: options.rootAliases ?? index.rootAliases,
        });
      });
    tree.catch(() => {
      tree = null; // try again next time
    });
    return tree;
  };
  const found = async (name: string, relativeTo?: string) => {
    const path = (await loadTree()).find(name, relativeTo);
    if (path === null) throw new EdmHttpError(`${name}: not found in the display tree`, 404);
    return { path, url: `${root}/${path.split('/').map(encodeURIComponent).join('/')}` };
  };
  return {
    async load(name, relativeTo) {
      const { path, url } = await found(name, relativeTo);
      return { path, text: latin1(await (await get(url, path)).arrayBuffer()) };
    },
    async image(name, relativeTo) {
      const { path, url } = await found(name, relativeTo);
      return (await get(url, path)).blob();
    },
    async config(name) {
      if (!CONFIG_NAMES.has(name)) throw new EdmHttpError(`${name}: not a config list`, 404);
      return latin1(await (await get(`${root}/${configDir}/${name}`, name)).arrayBuffer());
    },
  };
}
