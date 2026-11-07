// The workspace URL of a tab key and back: /embed/ (no tab),
// /embed/@<tool>[/<n>] (a tool instance) and /embed/<category>/<id>?<macros>
// (a screen). The workspace writes only the active tab's URL, with `replace`.
// A query on a tool URL is the host's hand-off and nothing else's: see toolUrlOf.

import {
  type TabsAction,
  type TabsState,
  instancesOf,
  parseTabKey,
  tabKey,
  toolProblem,
} from './tabs.js';
import { instanceShowing } from './workspacePrecheck.js';
import {
  MAX_TOOL_INSTANCES,
  isAgentQuery,
  parseToolKey,
  toolKey,
  toolLabel,
  toolSpec,
  withoutViewerParams,
} from './tools.js';

/**
 * The tab key a router-relative URL names: a tool instance at
 * `/embed/@<tool>[/<n>]` (by the key grammar alone — registered or not; its
 * query is ignored, because a page URL is not trusted to reach a tool or to
 * overwrite a stored instance: only the host's hand-off carries one, see
 * toolUrlOf), or a screen at `/embed/<category>/<id>` (or `/s/...`)
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

/** What a host's tool URL with a query asks for. */
export interface ToolUrl {
  tool: string;
  query: string;
}

/**
 * True in a frame whose parent is same-origin (a cross-origin read throws):
 * the host's load of a tool URL, as opposed to a URL anyone can open or link.
 */
export function framedBySameOrigin(): boolean {
  try {
    return window.parent !== window && window.parent.location.origin === window.location.origin;
  } catch {
    return false;
  }
}

/**
 * The tool and query of a router-relative `/embed/@<tool>?<query>`, the query
 * less the viewer's own parameters and in one encoding, so that one query
 * compares equal however it was spelled. Null for anything else: a numbered
 * instance names its tab, and a URL with no query left is a plain tool URL.
 *
 * Read only for what the host hands over: its navigate message, or a first
 * load while framedBySameOrigin. Any other URL's query stays ignored (keyForUrl).
 */
export function toolUrlOf(url: string): ToolUrl | null {
  const match = /^\/embed\/(@[^/?#]+)\/?\?([^#]*)/.exec(url);
  if (!match) return null;
  let key: string;
  try {
    key = decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
  const tool = parseToolKey(key)?.tool;
  const query = new URLSearchParams(withoutViewerParams(match[2]!)).toString();
  return tool === undefined || query === '' ? null : { tool, query };
}

/**
 * What a host's tool URL does, by the rules of the agent's open_tool: the tab
 * already showing the query takes focus, else a new instance opens with it, so
 * no instance's stored query ever changes. Refused, with the notice to show: a
 * tool this viewer has not configured or that takes no host query, a parameter
 * outside the tool's hostQueryParams, a query an agent could not send, and a
 * tool at its instance cap. `defaultQuery` is what an instance with no query
 * of its own shows.
 */
export function toolUrlOutcome(
  tabs: TabsState,
  { tool, query }: ToolUrl,
  tools: readonly string[],
  defaultQuery: string | undefined,
  nowMs: number
): { action: TabsAction } | { notice: string } {
  const problem = toolProblem(toolKey(tool), tools);
  if (problem !== null) return { notice: `${problem}; nothing opened` };
  const spec = toolSpec(tool)!;
  const named = [...new URLSearchParams(query).keys()];
  if (
    !named.every((name) => spec.hostQueryParams?.includes(name)) ||
    !isAgentQuery(spec, query, nowMs)
  ) {
    return { notice: `${toolLabel(tool)}: the URL's query is not valid; nothing opened` };
  }
  const showing = instanceShowing(tabs, tool, query, defaultQuery);
  if (showing !== null) return { action: { type: 'focus', key: showing } };
  if (instancesOf(tabs, tool).length >= MAX_TOOL_INSTANCES) {
    return { notice: `At most ${MAX_TOOL_INSTANCES} ${toolLabel(tool)} tabs; nothing opened` };
  }
  return { action: { type: 'newInstance', tool, query } };
}
