// The workspace state the active window reports to canopy_mcp's hub (claim, report,
// batch result). Pure: no DOM, no storage, no network. `buildState` reads the
// tabs reducer's state (the layout holder), the zoom store, and the tab titles;
// `reduceOversize` shrinks a report body that would exceed the hub's 128 KiB cap.
//
// What the state carries, and nothing else:
//   tabs       open tab keys in the holder's order (tiles in tree order, then
//              each tile's tabs): kind, canBack, canForward
//   active     the focused tile's showing tab, or null
//   layout     the holder's dock layout (@slaclab/canopy-dock-engine layout dock form: tiles with ids,
//              tabs and the showing tab, splits with sizes; a root tile
//              allowed), holding exactly the reported tabs; null exactly when
//              no tab is open
//   zoom       per open screen (`category/id`, macros dropped): fit or a percent
//   instances  exactly the open tool tabs: tool, n, query (a string), view
//   toolMru    open tool keys, most recently used first, once each
//   labels     tab titles of open keys (at most MAX_LABEL characters)
// Never carried: PV values, credentials, draft content or the operator's unsent
// input. When and how often a window reports is the reporter's, not this module's.

import type { ZoomState } from '../ZoomContext.js';
import { closeTab, keysOf } from '@slaclab/canopy-dock-engine';
import type { Layout } from '@slaclab/canopy-dock-engine';
import { parseTabKey, type TabsState } from './tabs.js';

/** The hub's body cap for claim, report and result (bytes of compact UTF-8 JSON). */
export const MAX_BODY_BYTES = 128 * 1024;
/** The hub's label cap, in characters. */
export const MAX_LABEL = 120;
/** The hub's manual zoom bounds, in percent. */
export const MIN_ZOOM_PERCENT = 10;
export const MAX_ZOOM_PERCENT = 400;

export interface ReportedTab {
  key: string;
  kind: 'screen' | 'tool';
  canBack: boolean;
  canForward: boolean;
}

export type ReportedZoom = { mode: 'fit' } | { mode: 'manual'; percent: number };

export interface ReportedInstance {
  tool: string;
  n: number;
  query: string;
  /** The saved view it was last loaded with, as `{id}`; null for none. */
  view: { id: string } | null;
}

export interface WorkspaceState {
  tabs: ReportedTab[];
  active: string | null;
  layout: Layout | null;
  zoom: Record<string, ReportedZoom>;
  instances: Record<string, ReportedInstance>;
  toolMru: string[];
  labels: Record<string, string>;
}

export interface StateInputs {
  /** The tabs reducer's state: the layout holder. */
  tabs: Readonly<TabsState>;
  /** The zoom of a tab key (the ZoomStore's `get`). */
  zoomOf: (key: string) => ZoomState;
  /** The title a tab shows; undefined or '' for none. */
  labelOf?: (key: string) => string | undefined;
  /** A tool's config default query, for an instance whose query is null. */
  defaultQueryOf?: (tool: string) => string | null | undefined;
}

/** A report body: what claim, report and result send beside their own fields. */
export interface StateBody {
  state: WorkspaceState;
  truncated?: boolean;
  [field: string]: unknown;
}

function screenOf(key: string): string {
  const q = key.indexOf('?');
  return q < 0 ? key : key.slice(0, q);
}

function zoomEntry(zoom: ZoomState): ReportedZoom {
  if (zoom.mode !== 'manual' || !Number.isFinite(zoom.scale)) return { mode: 'fit' };
  const percent = Math.min(
    MAX_ZOOM_PERCENT,
    Math.max(MIN_ZOOM_PERCENT, Math.round(zoom.scale * 100))
  );
  return { mode: 'manual', percent };
}

function labelText(raw: string | undefined): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const chars = [...raw.trim()];
  if (chars.length === 0) return undefined;
  return chars.slice(0, MAX_LABEL).join('');
}

/**
 * The holder's layout holding exactly `reported`: a key the report leaves out
 * is closed out of it the way a person's close would (the layout's leave
 * rule); null when nothing is left.
 */
function reportedLayout(layout: Layout | null, reported: ReadonlySet<string>): Layout | null {
  let next = layout;
  for (const key of keysOf(layout)) {
    if (!reported.has(key)) next = closeTab(next, key).layout;
  }
  return next !== null && keysOf(next).length > 0 ? next : null;
}

/** The reported state of a window. Keys that name no screen and no tool are left out. */
export function buildState(inputs: StateInputs): WorkspaceState {
  const { tabs: tabsState, zoomOf, labelOf, defaultQueryOf } = inputs;
  const seen = new Set<string>();
  const tabs: ReportedTab[] = [];
  const zoom: Record<string, ReportedZoom> = {};
  const instances: Record<string, ReportedInstance> = {};
  const labels: Record<string, string> = {};

  for (const key of tabsState.keys) {
    if (seen.has(key)) continue;
    const parsed = parseTabKey(key);
    if (parsed === null) continue;
    seen.add(key);
    const history = tabsState.history?.[key];
    tabs.push({
      key,
      kind: parsed.kind,
      canBack: (history?.back.length ?? 0) > 0,
      canForward: (history?.forward.length ?? 0) > 0,
    });
    if (parsed.kind === 'screen') {
      const screen = screenOf(key);
      zoom[screen] ??= zoomEntry(zoomOf(key));
    } else {
      const instance = tabsState.instances[key];
      const query = instance?.query ?? defaultQueryOf?.(parsed.tool) ?? '';
      instances[key] = {
        tool: parsed.tool,
        n: parsed.instance,
        query,
        view: typeof instance?.view === 'string' ? { id: instance.view } : null,
      };
    }
    const label = labelText(labelOf?.(key));
    if (label !== undefined) labels[key] = label;
  }

  const active = tabsState.active !== null && seen.has(tabsState.active) ? tabsState.active : null;
  const layout = reportedLayout(tabsState.layout, seen);
  const toolMru = [...new Set(tabsState.toolMru)].filter((key) => key in instances);

  return { tabs, active, layout, zoom, instances, toolMru, labels };
}

function bodyBytes(body: unknown): number {
  return new TextEncoder().encode(JSON.stringify(body)).length;
}

/** `query` without its `plot=` parameters; every other parameter kept byte for byte. */
export function withoutPlot(query: string): string {
  return query
    .split('&')
    .filter((part) => part.split('=', 1)[0] !== 'plot')
    .join('&');
}

/**
 * A body within MAX_BODY_BYTES when the state allows it: over the cap, every
 * instance query loses its `plot=` settings; still over, the labels go. A body
 * that lost anything gains `truncated: true` as its last field. A body within
 * the cap comes back unchanged; the input is never mutated.
 */
export function reduceOversize<B extends StateBody>(body: B): B {
  if (bodyBytes(body) <= MAX_BODY_BYTES) return body;
  const instances: Record<string, ReportedInstance> = {};
  for (const [key, instance] of Object.entries(body.state.instances)) {
    instances[key] = { ...instance, query: withoutPlot(instance.query) };
  }
  const rest: Record<string, unknown> = { ...body };
  delete rest.truncated;
  let reduced = { ...rest, state: { ...body.state, instances }, truncated: true } as B;
  if (bodyBytes(reduced) > MAX_BODY_BYTES) {
    reduced = { ...rest, state: { ...reduced.state, labels: {} }, truncated: true } as B;
  }
  return reduced;
}
