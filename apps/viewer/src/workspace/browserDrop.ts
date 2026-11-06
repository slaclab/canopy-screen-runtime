// What a saved-view drop from the screen browser opens (useDockBridge's
// onBrowserDrop): the instance key the row's click would reach, and the query
// to load once the key is placed. Member drags (screens, tools) resolve
// through collections.ts' resolveMember instead. A drag's payload is authored
// by whoever started the drag, so nothing in it is trusted beyond its shape:
// a view drag is honoured only for a listed view of a tool served here.
// Anything else resolves to nothing, as no row could have produced it.

import type { SavedView } from './savedViews.js';
import { freeInstance, instancesOf, mruInstance, viewInstance } from './tabs.js';
import type { TabsState } from './tabs.js';
import { MAX_TOOL_INSTANCES, toolKey } from './tools.js';

export interface ViewDropContext {
  state: TabsState;
  /** The tools served here (tools.ts ids). */
  tools: readonly string[];
  /** The saved views listed. */
  views: readonly SavedView[];
}

export interface ViewDropTarget {
  /** The key to place. */
  key: string;
  /** The view's query, loaded into `key` after the placement. */
  load?: { query: string; view: string };
  /** Set when `key` is a tool's most recently used instance because the tool is at its cap. */
  atCap?: string;
}

/** The target of a dropped saved view `id`: the instance showing it, else a new one, else the cap's. */
export function resolveViewDrop(
  id: string,
  { state, tools, views }: ViewDropContext
): ViewDropTarget | null {
  const view = views.find((candidate) => candidate.id === id);
  if (!view || !tools.includes(view.kind)) return null;
  const showing = viewInstance(state, view.kind, view.id);
  if (showing !== null) return { key: showing };
  const load = { query: view.query, view: view.id };
  // As openView: a new instance under the cap, else the most recently used one.
  if (instancesOf(state, view.kind).length < MAX_TOOL_INSTANCES) {
    return { key: toolKey(view.kind, freeInstance(state, view.kind)), load };
  }
  return { key: mruInstance(state, view.kind)!, load, atCap: view.kind };
}
