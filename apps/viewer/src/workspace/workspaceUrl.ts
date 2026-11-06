// The workspace URL of a tab key and back: /embed/ (no tab),
// /embed/@<tool>[/<n>] (a tool instance) and /embed/<category>/<id>?<macros>
// (a screen). The workspace writes only the active tab's URL, with `replace`.

import { parseTabKey, tabKey } from './tabs.js';
import { parseToolKey, toolKey } from './tools.js';

/**
 * The tab key a router-relative URL names: a tool instance at
 * `/embed/@<tool>[/<n>]` (by the key grammar alone — registered or not; its
 * query is ignored), or a screen at `/embed/<category>/<id>` (or `/s/...`)
 * with its macro query. Null for `/embed/`, `/embed/<category>` alone, and
 * anything else.
 */
export function keyForUrl(url: string): string | null {
  const cut = url.search(/[?#]/);
  const path = cut === -1 ? url : url.slice(0, cut);
  const search = cut === -1 || url[cut] === '#' ? '' : url.slice(cut + 1).split('#')[0]!;
  const tool = /^\/embed\/(@[^/]+(?:\/[^/]+)?)\/?$/.exec(path);
  if (tool) {
    try {
      return parseToolKey(decodeURIComponent(tool[1]!))?.key ?? null;
    } catch {
      return null;
    }
  }
  const match = /^\/(?:s|embed)\/([^/]+)\/(.+)$/.exec(path);
  if (!match) return null;
  let category: string;
  let id: string;
  try {
    category = decodeURIComponent(match[1]!);
    id = match[2]!.split('/').map(decodeURIComponent).join('/');
  } catch {
    return null;
  }
  if (category.startsWith('@')) return null;
  return tabKey(category, id, search);
}

/** The router-relative URL of a tab key (`/embed/` for none). */
export function urlForKey(key: string | null): string {
  if (key === null) return '/embed/';
  const parsed = parseTabKey(key);
  if (!parsed) return '/embed/';
  if (parsed.kind === 'tool') return `/embed/${toolKey(parsed.tool, parsed.instance)}`;
  const id = parsed.id.split('/').map(encodeURIComponent).join('/');
  const path = `/embed/${encodeURIComponent(parsed.category)}/${id}`;
  return parsed.query ? `${path}?${parsed.query}` : path;
}
