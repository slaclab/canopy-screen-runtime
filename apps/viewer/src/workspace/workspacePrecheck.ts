// The viewer's precheck of an agent's workspace commands: a pure, synchronous
// verdict per command, taken on the window's state just before the command
// would be dispatched. The hub has already checked each command's shape (verb,
// argument types and enums, the structured source/target/members/layout
// arguments, macro grammar, percent range, the 4 KB query bound, base on a
// command naming a tile id); this module checks what only the window can know.
//
//   batch      precheckBatch: at batch start, `stale_state` when the window's
//              seq is no longer the batch's base.seq (an operator change since
//              the agent read the workspace).
//   command    precheckCommand: the first reason that applies, in this order:
//                stale_state   the window's seq moved past the seq the apply
//                              loop expects after its own commands
//                operator_busy the caller's flag: the batch deadline arrived
//                              while a write dialog or a multi-write run was open
//                no_dock       chrome-off mode keeps one tile: a drop, and an
//                              open_set or open_collection `as` side or layout,
//                              would need a second tile
//                unknown_target the key, ref, tile, group, collection or tool the
//                              command names is not there (or is the wrong kind:
//                              set_query on a screen); per verb: a tab key that
//                              is not open, a tile id the layout does not hold, a
//                              screen ref the manifest lacks, a tool this viewer
//                              has not configured, a drop source or target tile
//                              that is not there
//                invalid_args  a tool query its tool does not read (tools.ts
//                              isAgentQuery; open_tool, set_query, a drop's new
//                              tool, an open_set tool member), a drop at a tab-bar
//                              index past the target tile's tabs
//                not_zoomable  zoom on a tool instance
//                no_history    back/forward with nothing behind/ahead
//                nothing_to_reopen reopen with an empty closed stack
//                instance_cap  a new instance of a tool already at the cap
//                tab_limit     the command would leave more than MAX_OPEN_TABS
//                              tabs open (open, open_tool, drop of a new item,
//                              open_set, open_collection, reopen)
//   stop       the first rejection stops the batch: rejectedFrom builds the
//              rejected result and the later commands' skipped results.
//
// Refetching the manifest once before an `unknown_target` stands is the
// apply loop's: it calls precheckCommand again with the fresh manifest.

import type { ManifestScreen } from '../api.js';
import { type Member, planOpenMany } from './collections.js';
import { findTile } from '@slaclab/canopy-dock-engine';
import type { Layout } from '@slaclab/canopy-dock-engine';
import {
  findClosed,
  instancesOf,
  parseTabKey,
  recordKeys,
  type TabsState,
  tabKey,
} from './tabs.js';
import { isAgentQuery, MAX_TOOL_INSTANCES, toolOf, toolSpec } from './tools.js';

/** At most this many tabs are open after an agent's command. */
export const MAX_OPEN_TABS = 50;

export type RejectionReason =
  | 'unknown_target'
  | 'invalid_args'
  | 'instance_cap'
  | 'tab_limit'
  | 'nothing_to_reopen'
  | 'no_history'
  | 'not_zoomable'
  | 'operator_busy'
  | 'stale_state'
  | 'no_dock';

/** One command as the window receives it in a batch event. */
export interface WorkspaceCommand {
  id: string;
  cmd: string;
  args?: Readonly<Record<string, unknown>>;
}

/** A collection as the workspace lists it: its ref (`<source>:<id>`) and members. */
export interface PrecheckCollection {
  ref: string;
  members: readonly Member[];
}

export interface PrecheckContext {
  /** The window's tabs, with history and the closed stack. */
  tabs: TabsState;
  /** The window's dock layout, null with no tab open; absent: no tile is known. */
  layout?: Layout | null;
  /** False in chrome-off mode: the window keeps one tile and has no dock to drop into. */
  dock?: boolean;
  /** The manifest's screens (only kind 'ir' opens). */
  screens: readonly ManifestScreen[];
  /** The tools this viewer has configured (tools.ts ids). */
  tools: readonly string[];
  /** The collections the workspace lists. */
  collections: readonly PrecheckCollection[];
  /** The operator is still busy (write dialog, multi-write run) at the batch deadline. */
  busy?: boolean;
  /** Now, epoch ms: a custom Trace range without `to` ends here. */
  nowMs: number;
  /** The window's seq now, and the seq the apply loop expects after its own commands. */
  seq?: number;
  expectedSeq?: number;
  /** A tool's config default query: an instance on its default (query null) shows it. */
  toolQuery?: (tool: string) => string | undefined;
}

export interface RejectedResult {
  id: string;
  status: 'rejected';
  reason: RejectionReason;
}

export interface SkippedResult {
  id: string;
  status: 'skipped';
  after: string;
}

/** `stale_state` when the window's seq is not the batch's base.seq; null without a base. */
export function precheckBatch(
  base: { seq: number } | null | undefined,
  seq: number
): 'stale_state' | null {
  if (base === null || base === undefined) return null;
  return base.seq === seq ? null : 'stale_state';
}

/** The results from command `index` on: it rejected with `reason`, every later one skipped. */
export function rejectedFrom(
  commands: readonly WorkspaceCommand[],
  index: number,
  reason: RejectionReason
): Array<RejectedResult | SkippedResult> {
  const rejected = commands[index];
  if (rejected === undefined) return [];
  return [
    { id: rejected.id, status: 'rejected', reason },
    ...commands
      .slice(index + 1)
      .map((command): SkippedResult => ({ id: command.id, status: 'skipped', after: rejected.id })),
  ];
}

/**
 * The open instance of `tool` showing `query` (absent: the tool's default),
 * most recently used first, else null. An instance on its default (query null)
 * shows `defaultQuery`.
 */
export function instanceShowing(
  tabs: TabsState,
  tool: string,
  query: string | undefined,
  defaultQuery?: string
): string | null {
  const effective = (value: string | null | undefined) =>
    value === null || value === undefined ? (defaultQuery ?? null) : value;
  const wanted = effective(query);
  const showing = instancesOf(tabs, tool).filter(
    (key) => effective(tabs.instances[key]?.query) === wanted
  );
  if (showing.length === 0) return null;
  return tabs.toolMru.find((key) => showing.includes(key)) ?? showing[0]!;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

/** The tab key `ref` (`<category>/<id>`) with `macros` opens, or null when the manifest lacks it. */
function screenKey(
  ref: string,
  macros: unknown,
  screens: readonly ManifestScreen[]
): string | null {
  const slash = ref.indexOf('/');
  if (slash <= 0 || ref.startsWith('@')) return null;
  const category = ref.slice(0, slash);
  const id = ref.slice(slash + 1);
  const entry = screens.find(
    (screen) => screen.category === category && screen.id === id && screen.kind === 'ir'
  );
  if (!entry) return null;
  const params = new URLSearchParams();
  if (typeof macros === 'object' && macros !== null) {
    for (const [name, value] of Object.entries(macros)) params.append(name, String(value));
  }
  return tabKey(category, id, params);
}

function overLimit(tabs: TabsState, added: number): boolean {
  return tabs.keys.length + added > MAX_OPEN_TABS;
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** An agent's member ({ref, macros?} or {tool, query?}) as a collection member, else null. */
function memberOf(value: unknown): Member | null {
  if (!isObject(value)) return null;
  if (isString(value.ref)) {
    return isObject(value.macros)
      ? { screen: value.ref, macros: value.macros as Record<string, string> }
      : { screen: value.ref };
  }
  if (isString(value.tool)) {
    return isString(value.query) ? { tool: value.tool, query: value.query } : { tool: value.tool };
  }
  return null;
}

/**
 * The reason opening one new tool instance of `tool` with `query` is rejected,
 * or null; shared by open_tool and a drop's new tool source.
 */
function toolOpenReason(
  tool: unknown,
  query: unknown,
  ctx: PrecheckContext
): RejectionReason | null {
  if (!isString(tool)) return 'invalid_args';
  const spec = toolSpec(tool);
  if (spec === undefined || !ctx.tools.includes(tool)) return 'unknown_target';
  if (query !== undefined && !isAgentQuery(spec, query, ctx.nowMs)) return 'invalid_args';
  const showing = instanceShowing(
    ctx.tabs,
    tool,
    query as string | undefined,
    ctx.toolQuery?.(tool)
  );
  if (showing !== null) return null;
  if (instancesOf(ctx.tabs, tool).length >= MAX_TOOL_INSTANCES) return 'instance_cap';
  return overLimit(ctx.tabs, 1) ? 'tab_limit' : null;
}

/** The reason opening `member` (a drop's new source) is rejected, or null. */
function memberOpenReason(value: unknown, ctx: PrecheckContext): RejectionReason | null {
  if (!isObject(value)) return 'invalid_args';
  if (Object.hasOwn(value, 'tool')) return toolOpenReason(value.tool, value.query, ctx);
  if (!isString(value.ref)) return 'invalid_args';
  const key = screenKey(value.ref, value.macros, ctx.screens);
  if (key === null) return 'unknown_target';
  return ctx.tabs.keys.includes(key) || !overLimit(ctx.tabs, 1) ? null : 'tab_limit';
}

/** The tabs a drop's target tile holds, or null when the target names no tile that is there. */
function targetTabs(target: Readonly<Record<string, unknown>>, layout: Layout | null) {
  const border = target.border;
  const id = isObject(border) ? border.tile : target.tile;
  if (!isString(id)) return null;
  return findTile(layout, id)?.tabs ?? null;
}

/** The reason a drop is rejected (after no_dock), or null. */
function dropReason(args: Readonly<Record<string, unknown>>, ctx: PrecheckContext) {
  const layout = ctx.layout ?? null;
  const { source, target } = args;
  if (!isObject(source) || !isObject(target)) return 'invalid_args';
  if (Object.hasOwn(source, 'tab') && !ctx.tabs.keys.includes(source.tab as string)) {
    return 'unknown_target';
  }
  if (Object.hasOwn(source, 'tile') && (!isString(source.tile) || !findTile(layout, source.tile))) {
    return 'unknown_target';
  }
  if (!Object.hasOwn(target, 'outer')) {
    const tabs = targetTabs(target, layout);
    if (tabs === null) return 'unknown_target';
    if (target.zone === 'tab' && (typeof target.index !== 'number' || target.index > tabs.length)) {
      return 'invalid_args';
    }
  }
  return Object.hasOwn(source, 'new') ? memberOpenReason(source.new, ctx) : null;
}

/** Whether an open_set or open_collection `as` needs a second tile. */
function needsDock(as: unknown): boolean {
  return as === 'side' || as === 'layout';
}

/** The reason `command` is rejected in `ctx`, or null when it may be dispatched. */
export function precheckCommand(
  command: WorkspaceCommand,
  ctx: PrecheckContext
): RejectionReason | null {
  if (ctx.seq !== undefined && ctx.expectedSeq !== undefined && ctx.seq !== ctx.expectedSeq) {
    return 'stale_state';
  }
  if (ctx.busy) return 'operator_busy';
  const { tabs } = ctx;
  const args = command.args ?? {};
  const isOpen = (key: unknown): key is string => isString(key) && tabs.keys.includes(key);

  switch (command.cmd) {
    case 'open': {
      if (!isString(args.ref)) return 'invalid_args';
      const key = screenKey(args.ref, args.macros, ctx.screens);
      if (key === null) return 'unknown_target';
      return isOpen(key) || !overLimit(tabs, 1) ? null : 'tab_limit';
    }

    case 'focus':
    case 'close_tab':
    case 'close_others':
    case 'close_right':
      return isOpen(args.key) ? null : 'unknown_target';

    case 'close_tile':
      return isString(args.tile) && findTile(ctx.layout ?? null, args.tile) !== null
        ? null
        : 'unknown_target';

    case 'drop':
      return ctx.dock === false ? 'no_dock' : dropReason(args, ctx);

    case 'close_all':
    case 'reset_layout':
      return null;

    case 'reopen': {
      const stack = tabs.closedStack ?? [];
      if (args.id !== undefined) {
        if (!isString(args.id)) return 'invalid_args';
        if (!stack.some((group) => group.id === args.id)) return 'unknown_target';
      } else if (stack.length === 0) {
        return 'nothing_to_reopen';
      }
      const group = findClosed(tabs, isString(args.id) ? args.id : undefined);
      if (group === undefined) return 'nothing_to_reopen';
      if (group.kind === 'layout') return null;
      const added = new Set(recordKeys(group).filter((key) => !isOpen(key))).size;
      return overLimit(tabs, added) ? 'tab_limit' : null;
    }

    case 'back':
    case 'forward': {
      if (!isOpen(args.key)) return 'unknown_target';
      const history = tabs.history?.[args.key];
      const stack = command.cmd === 'back' ? history?.back : history?.forward;
      return stack !== undefined && stack.length > 0 ? null : 'no_history';
    }

    case 'zoom': {
      if (!isOpen(args.key)) return 'unknown_target';
      return parseTabKey(args.key)?.kind === 'screen' ? null : 'not_zoomable';
    }

    case 'open_collection': {
      if (ctx.dock === false && needsDock(args.as)) return 'no_dock';
      if (!isString(args.ref)) return 'invalid_args';
      const collection = ctx.collections.find((entry) => entry.ref === args.ref);
      if (collection === undefined) return 'unknown_target';
      const plan = planOpenMany(tabs, collection.members, {
        screens: ctx.screens,
        tools: ctx.tools,
        toolQuery: ctx.toolQuery,
      });
      return plan.state.keys.length > MAX_OPEN_TABS ? 'tab_limit' : null;
    }

    case 'open_set': {
      if (ctx.dock === false && needsDock(args.as)) return 'no_dock';
      if (!Array.isArray(args.members)) return 'invalid_args';
      const members: Member[] = [];
      for (const value of args.members as unknown[]) {
        const member = memberOf(value);
        if (member === null) return 'invalid_args';
        if ('tool' in member && member.query !== undefined) {
          const spec = toolSpec(member.tool);
          if (spec !== undefined && !isAgentQuery(spec, member.query, ctx.nowMs)) {
            return 'invalid_args';
          }
        }
        members.push(member);
      }
      // A member that does not resolve is skipped by the open, as in a collection.
      const plan = planOpenMany(tabs, members, {
        screens: ctx.screens,
        tools: ctx.tools,
        toolQuery: ctx.toolQuery,
      });
      return plan.state.keys.length > MAX_OPEN_TABS ? 'tab_limit' : null;
    }

    case 'open_tool':
      return toolOpenReason(args.tool, args.query, ctx);

    case 'set_query': {
      if (!isOpen(args.key)) return 'unknown_target';
      const tool = toolOf(args.key);
      const spec = tool === undefined ? undefined : toolSpec(tool);
      if (spec === undefined) return 'unknown_target';
      return isAgentQuery(spec, args.query, ctx.nowMs) ? null : 'invalid_args';
    }

    default:
      return 'invalid_args';
  }
}
