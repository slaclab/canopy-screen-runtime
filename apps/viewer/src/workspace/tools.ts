// The workspace's tool registry: the apps that open as tool tabs (an iframe
// per instance) rather than as screens. Every tool special case reads this
// table; no other module names a tool.
//
//   keys       `@<tool>` is instance 1 and `@<tool>/<n>` instance n >= 2, with
//              n matching ^[2-9]$|^[1-9][0-9]{1,2}$; `@<tool>/1` parses to
//              `@<tool>`, so the data browser's historical `@trace` key is
//              its first instance unchanged.
//   configured a tool is usable only when the viewer config carries its entry
//              ({path, query}, config.ts); a registered tool without one is
//              refused like an unregistered key.
//   cap        at most MAX_TOOL_INSTANCES instances of one tool are open.
//   queries    each tool validates its own query (the one its page reports
//              through canopy:trace-query) and describes one for the save
//              dialog. The runtime never parses a tool's query grammar beyond
//              that: the tool's page owns it.
//   agent      a query an agent command carries (open_tool, set_query) must
//              also pass isAgentQuery: at most `maxPvs` distinct non-blank
//              values of the tool's `pvKey` (read as URLSearchParams does,
//              '+' a space), and the tool's own readability check (Trace: a
//              range react-trace reads). The 4 KB bound is canopy_mcp's.

import type { ToolConfig, ViewerConfig } from '../config.js';
import { isTraceQuery } from '../config.js';
import { describeTraceQuery, isDecodableQuery, isValidTraceQuery } from './traceQuery.js';

export interface ToolSpec {
  /** Registry id: the key segment after '@' and the saved views' `kind`. */
  id: string;
  /** Tab title and dialog wording ("Save <label> view"). */
  label: string;
  /** The tool's entry in the tree's Tools section. */
  treeLabel: string;
  /** True for a query the workspace may keep for an instance of this tool. */
  isValidQuery: (query: unknown) => query is string;
  /** What a saved view of `query` holds, for the save dialog. */
  describeQuery: (query: string) => string;
  /** Why Save is disabled while the instance's query is ''. */
  emptyHint: string;
  /** Extra class on the tool's iframes, for styles and test locators. */
  frameClass?: string;
  /** The query key whose distinct non-blank values are the instance's PVs. */
  pvKey?: string;
  /** At most this many distinct `pvKey` values in an agent's query (absent: no cap). */
  maxPvs?: number;
  /** An agent's query beyond isValidQuery and the PV cap, judged at `nowMs` (epoch ms). */
  isReadableQuery?: (query: string, nowMs: number) => boolean;
}

/** A saved view's kind when it has none: the data browser's. */
export const DEFAULT_TOOL = 'trace';

/** At most this many open instances of one tool. */
export const MAX_TOOL_INSTANCES = 10;

const TOOL_ID = /^[a-z][a-z0-9-]{0,31}$/;
const INSTANCE = /^(?:[2-9]|[1-9][0-9]{1,2})$/;

/** Correlation's query: within the size limit and decodable; '' allowed. */
function isValidCorrelationQuery(value: unknown): value is string {
  return isTraceQuery(value) && isDecodableQuery(value);
}

/** "<k> Y PVs" from the raw `y=` keys; the page owns the rest of the grammar. */
function describeCorrelationQuery(query: string): string {
  const count = new URLSearchParams(query).getAll('y').length;
  return count === 1 ? '1 Y PV' : `${count} Y PVs`;
}

/** Waveform's query: within the size limit and decodable; '' allowed. */
function isValidWaveformQuery(value: unknown): value is string {
  return isTraceQuery(value) && isDecodableQuery(value);
}

/** "<k> PVs" from the raw `pv=` keys; the page owns the rest of the grammar. */
function describeWaveformQuery(query: string): string {
  const count = new URLSearchParams(query).getAll('pv').length;
  return count === 1 ? '1 PV' : `${count} PVs`;
}

// --- Trace's range, as react-trace reads it (src/embed/query.ts, src/api/time.ts) ---

/** Zone-less datetime-local value: "YYYY-MM-DDTHH:mm", optional seconds and millis. */
const DATETIME_LOCAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/;
/** A positive span: a number and a unit (m minutes, h, d, w, M months). */
const SPAN = /^\s*(\d+(?:\.\d+)?)\s*([mhdwM])\s*$/;

function isSpan(span: string): boolean {
  const match = SPAN.exec(span);
  if (!match) return false;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0;
}

/**
 * True when Trace reads the query's range: absent (Trace's default), a
 * relative `-<span>`, or `custom` with a local `from`, an optional local `to`
 * ('' = absent = `nowMs`), and `from` strictly before `to`.
 */
function isReadableTraceRange(query: string, nowMs: number): boolean {
  const params = new URLSearchParams(query);
  const range = params.get('range');
  if (range === null) return true;
  if (range !== 'custom') return range.startsWith('-') && isSpan(range.slice(1));
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  if (!DATETIME_LOCAL.test(from)) return false;
  if (to !== '' && !DATETIME_LOCAL.test(to)) return false;
  const fromMs = new Date(from).getTime();
  const toMs = to === '' ? nowMs : new Date(to).getTime();
  return Number.isFinite(fromMs) && Number.isFinite(toMs) && fromMs < toMs;
}

/** The registered tools, in the order the tree lists them. */
export const TOOLS: readonly ToolSpec[] = Object.freeze([
  {
    id: 'trace',
    label: 'Data Browser',
    treeLabel: 'Data Browser (Trace)',
    isValidQuery: isValidTraceQuery,
    describeQuery: describeTraceQuery,
    emptyHint: 'Add a PV to the data browser first',
    frameClass: 'workspace-trace',
    pvKey: 'pv',
    maxPvs: 12,
    isReadableQuery: isReadableTraceRange,
  },
  {
    id: 'correlation',
    label: 'Correlation',
    treeLabel: 'Correlation Plot',
    isValidQuery: isValidCorrelationQuery,
    describeQuery: describeCorrelationQuery,
    emptyHint: 'Pick an X and a Y PV first',
    pvKey: 'y',
    maxPvs: 8,
  },
  {
    id: 'waveform',
    label: 'Waveform',
    treeLabel: 'Waveform Plot',
    isValidQuery: isValidWaveformQuery,
    describeQuery: describeWaveformQuery,
    emptyHint: 'Add a waveform PV first',
    pvKey: 'pv',
    maxPvs: 8,
  },
]);

/** The distinct non-blank values of `key` in `query` (URLSearchParams reading). */
export function distinctValues(query: string, key: string): number {
  const values = new URLSearchParams(query).getAll(key).filter((value) => value.trim() !== '');
  return new Set(values).size;
}

/**
 * True for a query an agent command may load into an instance of `spec`:
 * the tool's isValidQuery, its PV cap and its own readability check at `nowMs`.
 */
export function isAgentQuery(spec: ToolSpec, query: unknown, nowMs: number): query is string {
  if (!spec.isValidQuery(query)) return false;
  if (spec.pvKey !== undefined && spec.maxPvs !== undefined) {
    if (distinctValues(query, spec.pvKey) > spec.maxPvs) return false;
  }
  return spec.isReadableQuery?.(query, nowMs) ?? true;
}

/** The registered tool `id`, or undefined. */
export function toolSpec(id: string): ToolSpec | undefined {
  return TOOLS.find((tool) => tool.id === id);
}

export interface ParsedToolKey {
  /** The tool id (registered or not: the grammar alone decides). */
  tool: string;
  /** 1 for `@<tool>`. */
  instance: number;
  /** The canonical key (`@<tool>` for instance 1). */
  key: string;
}

/** The canonical key of instance `n` of `tool`. */
export function toolKey(tool: string, n = 1): string {
  return n === 1 ? `@${tool}` : `@${tool}/${n}`;
}

/** Parse a tool key by the grammar alone; null for anything else. */
export function parseToolKey(key: string): ParsedToolKey | null {
  if (!key.startsWith('@')) return null;
  const slash = key.indexOf('/');
  const tool = slash === -1 ? key.slice(1) : key.slice(1, slash);
  if (!TOOL_ID.test(tool)) return null;
  if (slash === -1) return { tool, instance: 1, key: key };
  const n = key.slice(slash + 1);
  if (n === '1') return { tool, instance: 1, key: toolKey(tool) };
  if (!INSTANCE.test(n)) return null;
  return { tool, instance: Number(n), key: toolKey(tool, Number(n)) };
}

/** True for a key that names an instance of a registered tool. */
export function isToolKey(key: string | null | undefined): key is string {
  if (typeof key !== 'string') return false;
  const parsed = parseToolKey(key);
  return parsed !== null && toolSpec(parsed.tool) !== undefined;
}

/** The tool id of a tool key, else undefined. */
export function toolOf(key: string | null | undefined): string | undefined {
  return typeof key === 'string' && isToolKey(key) ? parseToolKey(key)!.tool : undefined;
}

/** The config entry of a registered tool, when this deployment serves it. */
export function toolConfig(
  config: Readonly<Partial<ViewerConfig>> | undefined,
  tool: string
): ToolConfig | undefined {
  if (!config || toolSpec(tool) === undefined) return undefined;
  const entry = (config as Record<string, unknown>)[tool];
  if (typeof entry !== 'object' || entry === null) return undefined;
  const { path, query } = entry as { path?: unknown; query?: unknown };
  return typeof path === 'string' && path !== '' && typeof query === 'string'
    ? { path, query }
    : undefined;
}

/** The ids of the registered tools this config serves, in registry order. */
export function configuredTools(config: Readonly<Partial<ViewerConfig>> | undefined): string[] {
  return TOOLS.filter((tool) => toolConfig(config, tool.id) !== undefined).map((tool) => tool.id);
}

/** A tool tab's title without a loaded view: the label, plus " <n>" for n > 1. */
export function instanceLabel(key: string): string {
  const parsed = parseToolKey(key);
  const spec = parsed ? toolSpec(parsed.tool) : undefined;
  if (!parsed || !spec) return key;
  return parsed.instance === 1 ? spec.label : `${spec.label} ${parsed.instance}`;
}

/** The label of tool `id`, or the id itself for an unregistered kind. */
export function toolLabel(id: string): string {
  return toolSpec(id)?.label ?? id;
}
