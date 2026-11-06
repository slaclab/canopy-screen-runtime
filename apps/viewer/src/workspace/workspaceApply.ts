// The apply loop for a batch the hub delivered to this window: each command
// is checked, dispatched through the handlers the workspace's own UI uses,
// and awaited until it has committed, in order, and the batch's results go
// back in one POST with the state after the last command.
//
//   busy       while the operator is busy (an open or queued write dialog, a
//              multi-write run: guard.ts), a command waits for not-busy until
//              BUSY_MARGIN_MS before the batch deadline; still busy then, it
//              is rejected operator_busy, early enough for the result to land.
//   base       checked once at batch start: the window's seq must be the
//              batch's base.seq (precheckBatch).
//   operator   the window counts the changes it did not make for the agent
//              (operatorChanges, read with the agent's own changes marked by
//              setApplying); one between two commands fails the next one
//              stale_state.
//   precheck   precheckCommand on the state (and the holder's layout) just
//              before dispatch. An
//              unknown_target on what the manifest or the collection list
//              decides (open's ref, open_collection's ref) is provisional:
//              both are refetched, once per batch, and the command checked
//              again. The first rejection stops the batch: it and every later
//              command go back as rejected / skipped{after}.
//   guard      the input guard is armed (pending) before each dispatch. Once
//              the command has committed it is dropped when nothing changed;
//              when the command mounted a screen that was not mounted before
//              (focus of an evicted tab, an open, a drop of a new screen) it counts from
//              the paint after that screen's ready render with its embeds
//              resolved or failed (capped at READY_CAP_MS); otherwise from the
//              next paint.
//   dispatch   every command is one reducer action on the layout holder, the
//              one the person's gesture dispatches, so an agent's result is
//              the person's (the bridge applies the holder to the dock):
//              open as a tab of the focused tile (an open key is shown
//              where it is); drop is the person's drop, its `new`
//              member keyed here (a screen by ref and macros, a tool at its
//              smallest free instance unless one already shows the query;
//              an open key drops as {tab}); open_set and open_collection go
//              through the workspace's Open all (the holder's openSet,
//              caller agent). Tool queries load into the instance (`load`, a
//              remount). Destructive commands go through the workspace's
//              close path, which pushes one closed group (closedBy agent)
//              and raises the Undo toast: close_tab, close_tile, close_others
//              and close_right (within the tab's tile), close_all (the dock,
//              one layout group); reset_layout and a layout-replacing set
//              push one layout group. A refusal the holder alone can tell
//              (no_dock, too_many_for_side, an Open all refusal) rejects the
//              command with its reason, as a precheck rejection would.
//   attribution every element a changed command touched (its tab and tile
//              bar, or a zoom's control) is highlighted for HIGHLIGHT_MS.
//   deadline   past the batch's deadline the loop stops and posts nothing:
//              the hub has already resolved the rest as lost.

import type { GuardArm } from '../writeGate/guard.js';
import type { ZoomState } from '../ZoomContext.js';
import { stepZoom } from '../zoom.js';
import type { Member } from './collections.js';
import { findTile, tileOf } from '@slaclab/canopy-dock-engine';
import type { Source, Target, CollectionLayout } from '@slaclab/canopy-dock-engine';
import type {
  ClosedAction,
  ClosedBy,
  CloseInfo,
  OpenSetAs,
  TabsAction,
  TabsState,
} from './tabs.js';
import { freeInstance, reopenClosed, stepTabs, tabKey } from './tabs.js';
import { toolKey, toolOf } from './tools.js';
import {
  instanceShowing,
  type PrecheckContext,
  precheckBatch,
  precheckCommand,
  type RejectedResult,
  type RejectionReason,
  rejectedFrom,
  type SkippedResult,
  type WorkspaceCommand,
} from './workspacePrecheck.js';
import type { BatchEvent, BatchResult } from './workspaceSync.js';

/** How long a touched tab, tile bar or zoom control stays highlighted. */
export const HIGHLIGHT_MS = 1500;
/** A batch without a deadline closes this long after it arrived (the hub's delivery window). */
export const DELIVERY_MS = 10_000;
/** A busy wait gives up this long before the deadline, so operator_busy still lands. */
export const BUSY_MARGIN_MS = 500;
/** A newly mounted screen that never settles starts the guard's countdown after this long. */
export const READY_CAP_MS = 10_000;

export interface AppliedResult {
  id: string;
  status: 'applied';
  changed: boolean;
  [extra: string]: unknown;
}

export type CommandResult = AppliedResult | RejectedResult | SkippedResult;

/** What a command touched: its tab and tile bar, or a screen's zoom control. */
export interface Touch {
  key: string;
  part: 'tab' | 'zoom';
}

/** What one dispatched command did. */
export interface Outcome {
  changed: boolean;
  extras?: Record<string, unknown>;
  touched?: Touch[];
  /** The holder refused the command (nothing changed): the batch rejects it with this reason. */
  refusal?: string;
}

/** What an Open all (open_collection, open_set) reports once it has committed. */
export interface OpenAllOutcome {
  /** The tab key each member landed on, in member order. */
  keys: string[];
  /** Whether it changed the tabs or the layout. */
  changed: boolean;
  /** The layout group a layout-replacing open pushed; null or absent otherwise. */
  group?: string | null;
  /** Why nothing opened (NO_DOCK, too_many_for_side, a refused collection or layout). */
  refusal?: string;
}

/** How an Open all runs for the agent. */
export interface AgentOpenOptions {
  /** absent: the collection's saved layout, else side (open_collection only). */
  as?: OpenSetAs;
  /** open_set's exact layout over the member indexes (with `as: 'layout'`). */
  layout?: CollectionLayout<number>;
  closedBy: ClosedBy;
}

/** The workspace's own handlers, the ones its UI uses. */
export interface WorkspaceHandlers {
  /** The latest committed tabs state. */
  tabs(): TabsState;
  dispatch(action: TabsAction): void;
  /** The one close path: records the group and offers Undo; the group id or null when nothing closed. */
  closeTabs(
    keys: readonly string[],
    make: (closed: CloseInfo) => TabsAction,
    closedBy: ClosedBy
  ): string | null;
  /** Reopen a closed group (the newest without `id`); null when there is none. */
  reopenGroup(id?: string): ClosedAction | null;
  /** Reset layout: the group it recorded, or null below two tiles (nothing done). */
  resetLayout(closedBy: ClosedBy): string | null;
  /** A key's zoom (its screen's), and the scale its tile reports. */
  zoomOf(key: string): ZoomState;
  setZoom(key: string, state: ZoomState): void;
  reportedScale(key: string): number | undefined;
  /**
   * Open all of collection `ref`, or of the agent's own `members` (open_set),
   * resolved once committed; null when `ref` is not listed.
   */
  openAll(
    source: string | readonly Member[],
    options: AgentOpenOptions
  ): Promise<OpenAllOutcome | null>;
  /** A tool's config default query. */
  toolQuery(tool: string): string | undefined;
  /** Resolves once everything the last dispatches started has committed. */
  settled(): Promise<void>;
}

/** Everything the loop needs from the window. */
export interface ApplyPort extends WorkspaceHandlers {
  /** The manifest, tools and collections the precheck reads (fresh after refetch). */
  precheckInputs(): Pick<PrecheckContext, 'screens' | 'tools' | 'collections' | 'toolQuery'>;
  /** Refetches the manifest and the collection list; resolves once precheckInputs sees them. */
  refetch(): Promise<void>;
  /** The window's last sent seq. */
  seq(): number;
  /** A counter of the window's changes made while not applying. */
  operatorChanges(): number;
  /** Marks the window's changes as the agent's (true) or the operator's (false). */
  setApplying(applying: boolean): void;
  /** The screen tabs mounted now. */
  mounted(): readonly string[];
  /** Settles at screen `key`'s ready render with its embeds resolved or failed. */
  screenReady(key: string): PromiseLike<unknown>;
  isBusy(): boolean;
  onBusyChange(listener: (busy: boolean) => void): () => void;
  /** Arms the window's input guard (pending). */
  arm(): GuardArm;
  highlight(touched: readonly Touch[]): void;
  /** POSTs the batch's result with the current state. */
  post(result: BatchResult): Promise<number>;
  now?(): number;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

/** The tab key `ref` (`<category>/<id>`) with `macros` opens. */
export function screenKeyOf(ref: string, macros: unknown): string {
  const slash = ref.indexOf('/');
  const params = new URLSearchParams();
  if (typeof macros === 'object' && macros !== null) {
    for (const [name, value] of Object.entries(macros)) params.append(name, String(value));
  }
  return tabKey(ref.slice(0, slash), ref.slice(slash + 1), params);
}

/** What a tab command compares to decide whether it changed anything. */
function picture(tabs: TabsState): string {
  return JSON.stringify([tabs.layout, tabs.focusedTile, tabs.history ?? {}]);
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** An agent's member ({ref, macros?} or {tool, query?}) as a collection member. */
function memberOf(value: unknown): Member {
  if (!isObject(value)) throw new Error('not a member');
  if (isString(value.ref)) {
    return isObject(value.macros)
      ? { screen: value.ref, macros: value.macros as Record<string, string> }
      : { screen: value.ref };
  }
  if (isString(value.tool)) {
    return isString(value.query) ? { tool: value.tool, query: value.query } : { tool: value.tool };
  }
  throw new Error('not a member');
}

/**
 * A drop's source as the holder takes it, with the key a `new` member opens
 * under (minted here: a tool's smallest free instance) and the query it then
 * loads. A `new` member already open (a tool: an instance showing the query)
 * drops as that tab.
 */
function dropSource(
  raw: Readonly<Record<string, unknown>>,
  before: TabsState,
  h: WorkspaceHandlers
): { source: Source; key?: string; load?: string } {
  if (isString(raw.tab)) return { source: { tab: raw.tab } };
  if (isString(raw.tile)) return { source: { tile: raw.tile } };
  const member = memberOf(raw.new);
  if ('screen' in member) {
    const key = screenKeyOf(member.screen, member.macros);
    return { source: before.keys.includes(key) ? { tab: key } : { new: key }, key };
  }
  const showing = instanceShowing(before, member.tool, member.query, h.toolQuery(member.tool));
  if (showing !== null) return { source: { tab: showing }, key: showing };
  const key = toolKey(member.tool, freeInstance(before, member.tool));
  return { source: { new: key }, key, load: member.query };
}

/** A refusal as the rejection reason it is reported with: a named reason, else invalid_args. */
export function refusalReason(refusal: string): RejectionReason {
  return (/^[a-z][a-z_]*$/.test(refusal) ? refusal : 'invalid_args') as RejectionReason;
}

function tabTouches(keys: readonly string[]): Touch[] {
  return keys.map((key) => ({ key, part: 'tab' }));
}

/** The percent a zoom state reports: its manual scale, null for fit. */
function percentOf(state: ZoomState): number | null {
  return state.mode === 'manual' ? Math.round(state.scale * 100) : null;
}

/** The zoom `args` asks for, from `current` (shown at `shown`). */
function zoomTarget(
  args: Readonly<Record<string, unknown>>,
  current: ZoomState,
  shown: number
): ZoomState {
  if (typeof args.percent === 'number') return { mode: 'manual', scale: args.percent / 100 };
  switch (args.step) {
    case 'in':
      return { mode: 'manual', scale: stepZoom(shown, 1) };
    case 'out':
      return { mode: 'manual', scale: stepZoom(shown, -1) };
    case 'actual':
      return { mode: 'manual', scale: 1 };
    default:
      return { mode: 'fit', scale: current.mode === 'fit' ? current.scale : 1 };
  }
}

function sameZoom(a: ZoomState, b: ZoomState): boolean {
  if (a.mode !== b.mode) return false;
  return a.mode === 'fit' || Math.abs(a.scale - b.scale) < 1e-9;
}

/**
 * Dispatches one prechecked command through the workspace's handlers and
 * resolves once it has committed, with what it changed.
 */
export async function executeCommand(
  command: WorkspaceCommand,
  h: WorkspaceHandlers
): Promise<Outcome> {
  const args = command.args ?? {};
  const before = h.tabs();
  const key = isString(args.key) ? args.key : undefined;
  const committed = async (): Promise<TabsState> => {
    await h.settled();
    return h.tabs();
  };
  const tabChange = async (touch: (after: TabsState) => string[] = () => []): Promise<Outcome> => {
    const after = await committed();
    const changed = picture(after) !== picture(before);
    return { changed, touched: changed ? tabTouches(touch(after)) : [] };
  };
  const closed = (group: string | null): Outcome =>
    group === null ? { changed: false } : { changed: true, extras: { group } };

  switch (command.cmd) {
    case 'open': {
      const target = screenKeyOf(String(args.ref), args.macros);
      h.dispatch({ type: 'open', key: target, mode: 'append' });
      const outcome = await tabChange(() => [target]);
      return { ...outcome, extras: { key: target } };
    }

    case 'focus':
      if (before.active !== key) h.dispatch({ type: 'focus', key: key! });
      return tabChange(() => [key!]);

    case 'close_tab':
      return closed(
        h.closeTabs([key!], (info) => ({ type: 'close', key: key!, closed: info }), 'agent')
      );

    case 'close_tile': {
      const tile = findTile(before.layout, String(args.tile));
      if (tile === null) return { changed: false };
      return closed(
        h.closeTabs(
          tile.tabs,
          (info) => ({ type: 'closeTile', tile: tile.tile, closed: info }),
          'agent'
        )
      );
    }

    case 'close_others': {
      const tabs = tileOf(before.layout, key!)?.tabs ?? [];
      return closed(
        h.closeTabs(
          tabs.filter((k) => k !== key),
          (info) => ({ type: 'closeOthers', key: key!, closed: info }),
          'agent'
        )
      );
    }

    case 'close_right': {
      const tabs = tileOf(before.layout, key!)?.tabs ?? [];
      return closed(
        h.closeTabs(
          tabs.slice(tabs.indexOf(key!) + 1),
          (info) => ({ type: 'closeToRight', key: key!, closed: info }),
          'agent'
        )
      );
    }

    case 'close_all':
      return closed(
        h.closeTabs(before.keys, (info) => ({ type: 'closeAll', closed: info }), 'agent')
      );

    case 'reopen': {
      const id = isString(args.id) ? args.id : undefined;
      const { reopened } = reopenClosed(before, id);
      const entry = h.reopenGroup(id);
      await h.settled();
      const keys = entry === null ? [] : reopened.map((r) => r.as);
      return { changed: entry !== null, extras: { keys }, touched: tabTouches(keys) };
    }

    case 'drop': {
      const {
        source,
        key: opened,
        load,
      } = dropSource(args.source as Readonly<Record<string, unknown>>, before, h);
      const action: TabsAction = { type: 'drop', source, target: args.target as Target };
      const refusal = stepTabs(before, action).refusal;
      if (refusal !== undefined) return { changed: false, refusal };
      h.dispatch(action);
      if (load !== undefined && opened !== undefined) {
        const placed = (await committed()).keys.includes(opened);
        if (placed) h.dispatch({ type: 'load', key: opened, query: load, view: null });
      }
      const moved =
        'tab' in source
          ? source.tab
          : 'new' in source
            ? source.new
            : findTile(before.layout, source.tile)?.showing;
      const outcome = await tabChange(() => (moved === undefined ? [] : [moved]));
      return opened === undefined ? outcome : { ...outcome, extras: { key: opened } };
    }

    case 'back':
    case 'forward': {
      const slot = before.keys.indexOf(key!);
      h.dispatch({ type: command.cmd === 'back' ? 'historyBack' : 'historyForward', key: key! });
      return tabChange((after) => (after.keys[slot] === undefined ? [] : [after.keys[slot]!]));
    }

    case 'reset_layout': {
      const group = h.resetLayout('agent');
      await h.settled();
      if (group === null) return { changed: false };
      return { changed: true, extras: { group }, touched: tabTouches(h.tabs().keys) };
    }

    case 'zoom': {
      const current = h.zoomOf(key!);
      const shown = current.mode === 'manual' ? current.scale : (h.reportedScale(key!) ?? 1);
      const next = zoomTarget(args, current, shown);
      const changed = !sameZoom(current, next);
      if (changed) h.setZoom(key!, next);
      await h.settled();
      const result = changed ? h.zoomOf(key!) : current;
      return {
        changed,
        extras: { percent: percentOf(result) },
        touched: changed ? [{ key: key!, part: 'zoom' }] : [],
      };
    }

    case 'open_collection':
    case 'open_set': {
      const as = isString(args.as) ? (args.as as OpenSetAs) : undefined;
      const options: AgentOpenOptions = { closedBy: 'agent' };
      if (as !== undefined) options.as = as;
      if (as === 'layout' && isObject(args.layout)) {
        options.layout = args.layout as unknown as CollectionLayout<number>;
      }
      const source =
        command.cmd === 'open_set' ? (args.members as unknown[]).map(memberOf) : String(args.ref);
      const opened = await h.openAll(source, options);
      if (opened === null) return { changed: false, extras: { keys: [] } };
      if (opened.refusal !== undefined) return { changed: false, refusal: opened.refusal };
      const extras: Record<string, unknown> = { keys: opened.keys };
      if (opened.group) extras.group = opened.group;
      return {
        changed: opened.changed,
        extras,
        touched: opened.changed ? tabTouches(opened.keys) : [],
      };
    }

    case 'open_tool': {
      const tool = String(args.tool);
      const query = isString(args.query) ? args.query : undefined;
      const showing = instanceShowing(before, tool, query, h.toolQuery(tool));
      if (showing !== null) {
        if (before.active !== showing) h.dispatch({ type: 'focus', key: showing });
        const outcome = await tabChange(() => [showing]);
        return { ...outcome, extras: { key: showing } };
      }
      h.dispatch(
        query === undefined ? { type: 'newInstance', tool } : { type: 'newInstance', tool, query }
      );
      const after = await committed();
      const fresh = after.keys.find((k) => !before.keys.includes(k)) ?? after.active;
      return {
        changed: fresh !== null,
        extras: { key: fresh },
        touched: fresh === null ? [] : tabTouches([fresh]),
      };
    }

    case 'set_query': {
      const query = String(args.query);
      const tool = toolOf(key!) ?? '';
      const previous = before.instances[key!]?.query ?? h.toolQuery(tool) ?? '';
      const changed = previous !== query;
      if (changed) h.dispatch({ type: 'load', key: key!, query, view: null });
      await h.settled();
      return {
        changed,
        extras: { previous_query: previous },
        touched: changed ? tabTouches([key!]) : [],
      };
    }

    default:
      throw new Error(`unknown command ${command.cmd}`);
  }
}

/** An unknown_target that a fresh manifest or collection list may lift. */
function provisional(command: WorkspaceCommand): boolean {
  return command.cmd === 'open' || command.cmd === 'open_collection';
}

function deadlineOf(batch: BatchEvent, arrived: number): number {
  const parsed = batch.deadline === undefined ? Number.NaN : Date.parse(batch.deadline);
  return Number.isFinite(parsed) ? parsed : arrived + DELIVERY_MS;
}

function baseOf(base: unknown): { seq: number } | null {
  if (typeof base !== 'object' || base === null) return null;
  const seq = (base as { seq?: unknown }).seq;
  return typeof seq === 'number' ? { seq } : null;
}

/** Resolves true once the operator is not busy, false when still busy at `until`. */
function waitNotBusy(port: ApplyPort, until: number, now: () => number): Promise<boolean> {
  if (!port.isBusy()) return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    const finish = (free: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      off();
      resolve(free);
    };
    const off = port.onBusyChange((busy) => {
      if (!busy) finish(true);
    });
    const timer = setTimeout(() => finish(!port.isBusy()), Math.max(0, until - now()));
  });
}

/** Settles when every one of `keys` is ready, or after READY_CAP_MS. */
function readyOf(port: ApplyPort, keys: readonly string[]): Promise<unknown> {
  const all = Promise.allSettled(keys.map((key) => Promise.resolve(port.screenReady(key))));
  return Promise.race([all, new Promise((resolve) => setTimeout(resolve, READY_CAP_MS))]);
}

/**
 * Applies `batch` and POSTs its results. Resolves with the results posted, or
 * null when the deadline passed first (nothing is posted).
 */
export async function applyBatch(
  batch: BatchEvent,
  port: ApplyPort
): Promise<CommandResult[] | null> {
  const now = port.now ?? Date.now;
  const deadline = deadlineOf(batch, now());
  const commands: WorkspaceCommand[] = batch.commands;
  const results: CommandResult[] = [];
  const finish = async (): Promise<CommandResult[] | null> => {
    if (now() >= deadline) return null;
    await port.post({
      batch: batch.batch,
      results: results as unknown as Record<string, unknown>[],
    });
    return results;
  };

  const stale = precheckBatch(baseOf(batch.base), port.seq());
  if (stale !== null) {
    results.push(...rejectedFrom(commands, 0, stale));
    return finish();
  }
  let expected = port.operatorChanges();
  let refetched = false;

  for (const [index, command] of commands.entries()) {
    if (now() >= deadline) return null;
    const free = await waitNotBusy(port, deadline - BUSY_MARGIN_MS, now);
    const check = () =>
      precheckCommand(command, {
        ...port.precheckInputs(),
        tabs: port.tabs(),
        layout: port.tabs().layout,
        dock: port.tabs().oneTile !== true,
        busy: !free,
        nowMs: now(),
        seq: port.operatorChanges(),
        expectedSeq: expected,
      });
    let reason = check();
    if (reason === 'unknown_target' && !refetched && provisional(command)) {
      refetched = true;
      await port.refetch();
      if (now() >= deadline) return null;
      reason = check();
    }
    if (reason !== null) {
      results.push(...rejectedFrom(commands, index, reason));
      break;
    }

    const mountedBefore = port.mounted();
    const arm = port.arm();
    port.setApplying(true);
    let outcome: Outcome;
    try {
      outcome = await executeCommand(command, port);
    } catch (err) {
      console.warn(`Workspace: ${command.cmd} failed`, err);
      arm.drop();
      results.push(...rejectedFrom(commands, index, 'invalid_args'));
      break;
    } finally {
      port.setApplying(false);
    }
    expected = port.operatorChanges();
    if (outcome.refusal !== undefined) {
      arm.drop();
      results.push(...rejectedFrom(commands, index, refusalReason(outcome.refusal)));
      break;
    }

    if (!outcome.changed) {
      arm.drop();
    } else {
      const fresh = port.mounted().filter((key) => !mountedBefore.includes(key));
      if (fresh.length > 0) arm.startWhen(readyOf(port, fresh));
      else arm.startAfterPaint();
      if (outcome.touched && outcome.touched.length > 0) port.highlight(outcome.touched);
    }
    results.push({
      id: command.id,
      status: 'applied',
      changed: outcome.changed,
      ...outcome.extras,
    });
  }
  return finish();
}

/** A sink for delivered batches that applies them one at a time, in arrival order. */
export function createBatchApplier(port: () => ApplyPort): (batch: BatchEvent) => Promise<void> {
  let queue: Promise<unknown> = Promise.resolve();
  return (batch) => {
    const run = queue.then(() => applyBatch(batch, port()));
    const settled = run.then(
      () => undefined,
      (err: unknown) => console.warn('Workspace: batch failed', err)
    );
    queue = settled;
    return settled;
  };
}

/**
 * The screen-ready signal by tab key: a mounted screen reports `ready` (its
 * ScreenPage onReady), the apply loop awaits `whenReady`, in either order. An
 * unmount forgets the key, so a remount waits for its own ready render.
 */
export class ScreenReadiness {
  private readonly entries = new Map<
    string,
    { promise: Promise<void>; resolve: () => void; done: boolean }
  >();

  private entry(key: string) {
    let entry = this.entries.get(key);
    if (entry === undefined) {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => (resolve = r));
      const created = { promise, resolve: () => {}, done: false };
      created.resolve = () => {
        created.done = true;
        resolve();
      };
      entry = created;
      this.entries.set(key, entry);
    }
    return entry;
  }

  /** Screen `key` rendered with its embeds settled. */
  ready(key: string): void {
    this.entry(key).resolve();
  }

  /** Screen `key` unmounted. */
  forget(key: string): void {
    this.entries.delete(key);
  }

  /** Settles once screen `key` is ready (at once when it already is). */
  whenReady(key: string): Promise<void> {
    return this.entry(key).promise;
  }
}

/** The attribute a touched element carries while highlighted. */
export const TOUCHED_ATTR = 'data-agent-touched';

const highlightTimers = new WeakMap<Element, ReturnType<typeof setTimeout>>();

function withAttr(root: ParentNode, selector: string, attr: string, key: string): Element[] {
  return Array.from(root.querySelectorAll(selector)).filter((el) => el.getAttribute(attr) === key);
}

/**
 * Marks what `touched` names under `root` with TOUCHED_ATTR for `ms`: a
 * tab's strip tab, its tab in a tile bar and the tile bar it shows in, or a
 * zoom's control in that screen's tile bar or its tile's actions slot. A later highlight of the same element restarts its time.
 */
export function highlightTouched(
  root: ParentNode,
  touched: readonly Touch[],
  ms: number = HIGHLIGHT_MS
): Element[] {
  const marked: Element[] = [];
  for (const { key, part } of touched) {
    const bars = withAttr(root, '.canopy-tile-bar[data-panel-key]', 'data-panel-key', key);
    if (part === 'zoom') {
      for (const bar of bars) {
        // The header sits in the tile's actions slot beside its bar (data-tile).
        const tile = bar.getAttribute('data-tile');
        const slots =
          tile === null ? [] : withAttr(root, '.canopy-tile-bar__actions', 'data-tile', tile);
        const control =
          bar.querySelector('.screen-header__zoom') ??
          slots.map((slot) => slot.querySelector('.screen-header__zoom')).find((c) => c !== null) ??
          null;
        if (control !== null) marked.push(control);
      }
    } else {
      marked.push(
        ...withAttr(root, '.tab-strip [data-tab-key]', 'data-tab-key', key),
        ...withAttr(root, '.canopy-tile-bar__tab[data-tab-key]', 'data-tab-key', key),
        ...bars
      );
    }
  }
  for (const el of marked) {
    el.setAttribute(TOUCHED_ATTR, '');
    const previous = highlightTimers.get(el);
    if (previous !== undefined) clearTimeout(previous);
    highlightTimers.set(
      el,
      setTimeout(() => {
        el.removeAttribute(TOUCHED_ATTR);
        highlightTimers.delete(el);
      }, ms)
    );
  }
  return marked;
}
