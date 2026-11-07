// The workspace URL of a tab key and back: /embed/ (no tab),
// /embed/@<tool>[/<n>] (a tool instance) and /embed/<category>/<id>?<macros>
// (a screen). The workspace writes only the active tab's URL, with `replace`.
// /embed/@<tool>?<query> is read, never written: it asks for that query in a
// tab, and the active tab's own URL replaces it (toolUrlOf, toolUrlOutcome).

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
} from './tools.js';

/**
 * The tab key a router-relative URL names: a tool instance at
 * `/embed/@<tool>[/<n>]` (by the key grammar alone — registered or not; a
 * query it carries is toolUrlOf's), or a screen at `/embed/<category>/<id>` (or `/s/...`)
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

/** What a tool URL with a query asks for. */
export interface ToolUrl {
  tool: string;
  query: string;
}

/** A parameter the viewer's frame reads itself: never part of a tool's query. */
function isReservedParam(pair: string): boolean {
  const name = pair.split('=', 1)[0]!;
  return ['embedded', 'theme', 'mode'].includes(name) || name.startsWith('_canopy');
}

/**
 * The tool and query a router-relative `/embed/@<tool>?<query>` asks for, the
 * query as written less the viewer's own parameters. Null for anything else: a
 * numbered instance names its tab, and a URL with no query left is a plain tool URL.
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
  const query = match[2]!
    .split('&')
    .filter((pair) => pair !== '' && !isReservedParam(pair))
    .join('&');
  return tool === undefined || query === '' ? null : { tool, query };
}

/**
 * What a tool URL does, by the rules of the agent's open_tool: the tab already
 * showing the query takes focus, else a new instance opens with it. A tool
 * this viewer has not configured, a query an agent could not send and a tool
 * at its instance cap are refused with the notice to show. `defaultQuery` is
 * what an instance with no query of its own shows.
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
  if (!isAgentQuery(toolSpec(tool)!, query, nowMs)) {
    return { notice: `${toolLabel(tool)}: the URL's query is not valid; nothing opened` };
  }
  const showing = instanceShowing(tabs, tool, query, defaultQuery);
  if (showing !== null) return { action: { type: 'focus', key: showing } };
  if (instancesOf(tabs, tool).length >= MAX_TOOL_INSTANCES) {
    return { notice: `At most ${MAX_TOOL_INSTANCES} ${toolLabel(tool)} tabs; nothing opened` };
  }
  return { action: { type: 'newInstance', tool, query } };
}
