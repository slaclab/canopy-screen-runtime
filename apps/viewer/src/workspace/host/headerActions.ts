// headerActions: the route back from the host's tile bar. hostBridge
// delivers `(id, value)` exactly as the host posted it; the ⋯ menu arrives as
// `id === 'more'` with the chosen entry's id in `value`. dispatchHeaderAction
// turns that key into one workspace effect.
//
// Pure like headerComposer: every effect comes through the injected context,
// which WorkspacePage binds to the focused tile, so the routing is testable
// with fakes.
//
// Toasts: every result or refusal lands in the toast column. Where the
// handler already reports its own outcome (screen verbs through their
// notify, Reset layout's undo toast, the save dialogs' "Saved …"), nothing is
// added; a handler that opens a surface (Quick Open, a dialog, Collections)
// has that surface as its result; everything else gets a short past-tense
// label. A refusal (nothing focused, a verb unavailable, a disabled tool
// entry) always toasts its reason; a disabled tool entry toasts the reason
// from the tool's canopy:tool-actions report and is never sent to the tool.

import type { ScreenHistory } from '../../ScreenHeader.js';
import { DOWNLOAD_ACTION_ID, type ScreenVerbs } from '../../screenActions/useScreenActions.js';
import {
  DOWNLOAD_SCREEN_LABEL,
  MENU_COLLECTIONS,
  MENU_DOWNLOAD_SCREEN,
  MENU_RESET_LAYOUT,
  MENU_SAVE_COLLECTION,
  MENU_SHOW_SUB_SCREENS,
  MENU_ZOOM_100,
  MENU_ZOOM_FIT,
  MENU_ZOOM_IN,
  MENU_ZOOM_OUT,
  MORE_ID,
  NAV_BACK_ID,
  NAV_FORWARD_ID,
  SAVE_VIEW_ID,
  SCREEN_VERB_BUTTONS,
  SCREEN_VERB_PREFIX,
  SEARCH_ID,
  TOOL_ENTRY_PREFIX,
} from './headerComposer.js';
import type { ToolActionsReport } from '../toolActionsStore.js';

// ---- user-visible strings -------------------------------------------------

export const WENT_BACK = 'Went back';
export const WENT_FORWARD = 'Went forward';
export const NO_BACK = 'Nothing to go back to';
export const NO_FORWARD = 'Nothing to go forward to';
export const NO_SCREEN = 'No screen is focused';
export const NO_TOOL = 'No tool is focused';
export const SEARCH_UNAVAILABLE = 'Search is unavailable';
export const SAVE_VIEW_UNAVAILABLE = 'Save view is unavailable';
export const SAVE_COLLECTION_UNAVAILABLE = 'Collections are unavailable';
export const COLLECTIONS_UNAVAILABLE = 'Collections are unavailable';
export const RESET_LAYOUT_UNAVAILABLE = 'Nothing to reset';
export const SUB_SCREENS_SHOWN = 'Sub-screens shown';
export const SUB_SCREENS_HIDDEN = 'Sub-screens hidden';
export const ZOOMED_IN = 'Zoomed in';
export const ZOOMED_OUT = 'Zoomed out';
export const ZOOMED_FIT = 'Zoomed to fit';
export const ZOOMED_100 = 'Zoomed to 100%';
export const ZOOM_UNAVAILABLE = 'Zoom is unavailable';

/** A screen verb or tool action that cannot run now. */
export function unavailableMessage(label: string): string {
  return `${label} is unavailable`;
}

/** The past-tense label of a tool action the tool accepted. */
export function toolDoneMessage(
  label: string,
  kind: 'button' | 'toggle',
  pressed?: boolean
): string {
  if (kind === 'toggle') return `${label} ${pressed ? 'off' : 'on'}`;
  return `${label} done`;
}

// ---- context --------------------------------------------------------------

/** The focused screen tile's zoom controls. */
export interface HeaderZoomControls {
  zoomIn(): void;
  zoomOut(): void;
  fit(): void;
  actual(): void;
}

/** The focused tool tab: its last canopy:tool-actions report and its canopy:tool-invoke sender. */
export interface HeaderToolTarget {
  report: ToolActionsReport | null;
  /** Post canopy:tool-invoke for `id`; false when the tab has no frame. */
  invoke(id: string): boolean;
}

/** Everything the dispatcher acts on, bound by WorkspacePage to the focused tile. */
export interface HeaderActionContext {
  /** The toast column. */
  toast(message: string): void;
  /** Move focus into the viewer frame (the click happened in the host). */
  focusViewer(): void;
  /** Open Quick Open; false when no palette is mounted. */
  openQuickOpen(): boolean;
  /** Open Save view for the focused tool tab; absent when it cannot. */
  saveView?: () => void;
  /** Open Save open tabs as collection; absent when collections are off. */
  openSaveCollection?: () => void;
  /** Reset the layout (offers its own undo toast); absent when disabled. */
  resetLayout?: () => void;
  getShowSubScreens(): boolean;
  setShowSubScreens(show: boolean): void;
  /** Open Collections (expanding a collapsed sidebar); false when not mounted. */
  openCollections(): boolean;
  /** The focused screen tile's history, or null. */
  history: ScreenHistory | null;
  /** The focused screen tile's verbs, or null. */
  screenVerbs: ScreenVerbs | null;
  /** The focused screen tile's zoom, or null. */
  zoom: HeaderZoomControls | null;
  /** The focused tool tab, or null. */
  tool: HeaderToolTarget | null;
}

// ---- dispatch -------------------------------------------------------------

function verbLabel(verb: string): string {
  if (verb === DOWNLOAD_ACTION_ID) return DOWNLOAD_SCREEN_LABEL;
  return SCREEN_VERB_BUTTONS.find((b) => b.id === verb)?.label ?? verb;
}

function runScreenVerb(verb: string, ctx: HeaderActionContext): void {
  if (!ctx.screenVerbs) {
    ctx.toast(NO_SCREEN);
    return;
  }
  // The verb's own notify reports its outcome; only a refusal is ours.
  if (!ctx.screenVerbs.invoke(verb)) ctx.toast(unavailableMessage(verbLabel(verb)));
}

function runTool(toolId: string, ctx: HeaderActionContext): void {
  if (!ctx.tool) {
    ctx.toast(NO_TOOL);
    return;
  }
  const entry = ctx.tool.report?.actions.find((a) => a.id === toolId);
  if (!entry) return; // not in the last report: never invoked
  if (typeof entry.disabled === 'string') {
    ctx.toast(entry.disabled);
    return;
  }
  if (ctx.tool.invoke(toolId)) ctx.toast(toolDoneMessage(entry.label, entry.kind, entry.pressed));
  else ctx.toast(unavailableMessage(entry.label));
}

function navigate(back: boolean, ctx: HeaderActionContext): void {
  if (!ctx.history) {
    ctx.toast(NO_SCREEN);
    return;
  }
  const step = back ? ctx.history.back : ctx.history.forward;
  if (!step.enabled) {
    ctx.toast(back ? NO_BACK : NO_FORWARD);
    return;
  }
  step.onClick();
  ctx.toast(back ? WENT_BACK : WENT_FORWARD);
}

function runZoom(
  pick: (z: HeaderZoomControls) => void,
  done: string,
  ctx: HeaderActionContext
): void {
  if (!ctx.zoom) {
    ctx.toast(ZOOM_UNAVAILABLE);
    return;
  }
  pick(ctx.zoom);
  ctx.toast(done);
}

/**
 * Route one host header action. `id` is the item id; for `more` the chosen ⋯ entry's
 * id is in `value`. Unknown keys are ignored.
 */
export function dispatchHeaderAction(
  id: string,
  value: string | undefined,
  ctx: HeaderActionContext
): void {
  const key = id === MORE_ID ? value : id;
  if (key === undefined) return;

  if (key.startsWith(SCREEN_VERB_PREFIX)) {
    runScreenVerb(key.slice(SCREEN_VERB_PREFIX.length), ctx);
    return;
  }
  if (key.startsWith(TOOL_ENTRY_PREFIX)) {
    runTool(key.slice(TOOL_ENTRY_PREFIX.length), ctx);
    return;
  }

  switch (key) {
    case SEARCH_ID:
      ctx.focusViewer();
      if (!ctx.openQuickOpen()) ctx.toast(SEARCH_UNAVAILABLE);
      return;
    case SAVE_VIEW_ID:
      if (!ctx.saveView) {
        ctx.toast(SAVE_VIEW_UNAVAILABLE);
        return;
      }
      ctx.focusViewer();
      ctx.saveView();
      return;
    case NAV_BACK_ID:
      navigate(true, ctx);
      return;
    case NAV_FORWARD_ID:
      navigate(false, ctx);
      return;
    case MENU_SAVE_COLLECTION:
      if (!ctx.openSaveCollection) {
        ctx.toast(SAVE_COLLECTION_UNAVAILABLE);
        return;
      }
      ctx.focusViewer();
      ctx.openSaveCollection();
      return;
    case MENU_DOWNLOAD_SCREEN:
      runScreenVerb(DOWNLOAD_ACTION_ID, ctx);
      return;
    case MENU_ZOOM_IN:
      runZoom((z) => z.zoomIn(), ZOOMED_IN, ctx);
      return;
    case MENU_ZOOM_OUT:
      runZoom((z) => z.zoomOut(), ZOOMED_OUT, ctx);
      return;
    case MENU_ZOOM_FIT:
      runZoom((z) => z.fit(), ZOOMED_FIT, ctx);
      return;
    case MENU_ZOOM_100:
      runZoom((z) => z.actual(), ZOOMED_100, ctx);
      return;
    case MENU_RESET_LAYOUT:
      if (!ctx.resetLayout) ctx.toast(RESET_LAYOUT_UNAVAILABLE);
      else ctx.resetLayout(); // offers its own undo toast
      return;
    case MENU_SHOW_SUB_SCREENS: {
      const show = !ctx.getShowSubScreens();
      ctx.setShowSubScreens(show);
      ctx.toast(show ? SUB_SCREENS_SHOWN : SUB_SCREENS_HIDDEN);
      return;
    }
    case MENU_COLLECTIONS:
      if (!ctx.openCollections()) ctx.toast(COLLECTIONS_UNAVAILABLE);
      return;
    default:
      return;
  }
}
