// Saved tool views: a tool page's configuration (its embed query — for the
// data browser the PVs, time range and, once the operator changed them, the
// axis and display settings as `plot=<JSON>`) stored under a name by
// canopy_mcp, shared by everyone who opens this viewer. Each view has a
// `kind`, the tool it belongs to (tools.ts); a view without one is a data
// browser view. The query is opaque here: the tool's page alone parses it.
// config.json names the route (`views.path`) only when the server keeps
// views; without it the feature is absent.
//
//   GET    <path>          -> {views: SavedView[]}, sorted by name
//   GET    <path>/<id>     -> SavedView
//   PUT    <path>/<id>     {name, query, kind?} -> SavedView (201 created,
//                          200 replaced, 409 when <id> holds another kind)
//   DELETE <path>/<id>     -> 204
//
// Ids are derived from the name and kind (kindedViewId): `viewId(name)` for
// the data browser and `<kind>_<viewId(name)>` (cut to 64) for any other
// kind. Slugs never contain `_` and kinds never do, so views of different
// kinds never share an id, and saving under an existing name of the same
// kind replaces that view. A data browser save omits `kind` (the server's
// default), so it works against a server without kinds.

import { useCallback, useEffect, useRef, useState } from 'react';
import { isTraceQuery } from '../config.js';
import { DEFAULT_TOOL } from './tools.js';

export interface SavedView {
  id: string;
  name: string;
  /** The tool the view belongs to; 'trace' when the server sent none. */
  kind: string;
  /** The Trace embed query (`pv=...&range=...[&plot=...]`), at most 4 KB. */
  query: string;
  /** ISO-8601 time of the last save. */
  updated?: string;
}

export const VIEW_NAME_MAX = 120;
const ID_MAX = 64;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const KIND_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * The id a view name is stored under: lower case, runs of anything but
 * letters and digits become one `-`, trimmed, at most 64 characters. Empty
 * when the name has no letter or digit (non-Latin names fall back to a hash).
 */
export function viewId(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, ID_MAX)
    .replace(/-+$/g, '');
  if (slug !== '') return slug;
  if (name.trim() === '') return '';
  // A name with no ASCII letter or digit: a stable short hash of it.
  let h = 0x811c9dc5;
  for (const ch of name.trim()) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `view-${h.toString(36)}`;
}

/** The id a view `name` of `kind` is stored under ('' when the name has none). */
export function kindedViewId(name: string, kind: string): string {
  const id = viewId(name);
  if (id === '' || kind === DEFAULT_TOOL) return id;
  return `${kind}_${id}`.slice(0, ID_MAX);
}

/** Why `name` cannot be saved, or null when it can. */
export function viewNameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed === '') return 'Enter a name.';
  if (trimmed.length > VIEW_NAME_MAX) return `At most ${VIEW_NAME_MAX} characters.`;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/.test(trimmed)) return 'No control characters.';
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseView(raw: unknown): SavedView | null {
  if (!isRecord(raw)) return null;
  const { id, name, query, updated } = raw;
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) return null;
  if (typeof name !== 'string' || name === '') return null;
  if (!isTraceQuery(query)) return null;
  // A malformed kind is no tool's: listed, never opened.
  const kind =
    raw.kind === undefined || raw.kind === null
      ? DEFAULT_TOOL
      : typeof raw.kind === 'string' && KIND_PATTERN.test(raw.kind)
        ? raw.kind
        : '?';
  return typeof updated === 'string'
    ? { id, name, kind, query, updated }
    : { id, name, kind, query };
}

/** The absolute URL of the views collection (or one view) under `base`. */
export function viewsUrl(path: string, base: string, id?: string): string {
  const collection = new URL(path.replace(/\/+$/, ''), base).href;
  return id === undefined ? collection : `${collection}/${encodeURIComponent(id)}`;
}

async function failure(response: Response, what: string): Promise<Error> {
  let detail = `${response.status} ${response.statusText}`.trim();
  try {
    const body: unknown = await response.json();
    if (isRecord(body) && typeof body.detail === 'string') detail = body.detail;
  } catch {
    // No JSON body: the status line says enough.
  }
  return new Error(`${what}: ${detail}`);
}

export async function listViews(path: string, base: string): Promise<SavedView[]> {
  const response = await fetch(viewsUrl(path, base), { cache: 'no-cache' });
  if (!response.ok) throw await failure(response, 'Could not list saved views');
  const body: unknown = await response.json();
  if (!isRecord(body) || !Array.isArray(body.views)) throw new Error('Malformed saved views list');
  return body.views.map(parseView).filter((v): v is SavedView => v !== null);
}

export async function saveView(
  path: string,
  base: string,
  name: string,
  query: string,
  kind: string = DEFAULT_TOOL
): Promise<SavedView> {
  const problem = viewNameProblem(name);
  if (problem) throw new Error(problem);
  const id = kindedViewId(name, kind);
  const body =
    kind === DEFAULT_TOOL ? { name: name.trim(), query } : { name: name.trim(), query, kind };
  const response = await fetch(viewsUrl(path, base, id), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw await failure(response, 'Could not save the view');
  const view = parseView(await response.json());
  if (!view) throw new Error('Malformed saved view');
  return view;
}

export async function deleteView(path: string, base: string, id: string): Promise<void> {
  const response = await fetch(viewsUrl(path, base, id), { method: 'DELETE' });
  // Already gone is what the operator wanted.
  if (!response.ok && response.status !== 404) {
    throw await failure(response, 'Could not delete the view');
  }
}

export interface SavedViewsState {
  /** The views, sorted by name; [] until loaded or when the feature is off. */
  views: SavedView[];
  /** The last load or write error, for the operator. */
  error: string | null;
  refresh: () => void;
  save: (name: string, query: string, kind?: string) => Promise<SavedView>;
  remove: (id: string) => Promise<void>;
}

const byName = (a: SavedView, b: SavedView) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id);

/**
 * The saved views of the server at `base`, when config.json named a `path`.
 * Loaded on mount, on window focus (another operator may have saved one) and
 * after every write.
 */
export function useSavedViews(path: string | undefined, base: string): SavedViewsState {
  const [views, setViews] = useState<SavedView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  const refresh = useCallback(() => {
    if (path === undefined) return;
    const mine = ++generation.current;
    listViews(path, base).then(
      (next) => {
        if (mine !== generation.current) return;
        setViews((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
        setError(null);
      },
      (err: unknown) => {
        if (mine === generation.current) setError(err instanceof Error ? err.message : String(err));
      }
    );
  }, [path, base]);

  useEffect(() => {
    if (path === undefined) return;
    refresh();
    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [path, refresh]);

  const save = useCallback(
    async (name: string, query: string, kind: string = DEFAULT_TOOL) => {
      if (path === undefined) throw new Error('Saved views are not available');
      const view = await saveView(path, base, name, query, kind);
      setViews((prev) => [...prev.filter((v) => v.id !== view.id), view].sort(byName));
      refresh();
      return view;
    },
    [path, base, refresh]
  );

  const remove = useCallback(
    async (id: string) => {
      if (path === undefined) return;
      await deleteView(path, base, id);
      setViews((prev) => prev.filter((v) => v.id !== id));
      refresh();
    },
    [path, base, refresh]
  );

  return { views: path === undefined ? [] : views, error, refresh, save, remove };
}
