// headerComposer: the pure mapping from the workspace's state to the items the
// viewer contributes to the host's tile bar, including the ⋯ menu's
// composition. No React, no DOM: WorkspacePage gathers the inputs and
// hands the result to hostBridge.contribute, headerActions routes the ids back.
//
// Item order is position in the host bar: the subtitle text on the left, then
// the interactive items right-anchored against the host's ×, the primary
// (Save view, accent) last.
//
//   tool tab, one tile:    subtitle · Search ⌘K · ⋯ · [Save view]
//   screen tab, one tile:  subtitle · ◀ · ▶ · Reload · Export PNG · Print ·
//                          [Plot in Data Browser] · Copy link · Search ⌘K · ⋯
//   ≥ 2 tiles:            subtitle · Search ⌘K · ⋯
//
// With two or more tiles each tile has its own bar carrying its showing tab's
// controls (the screen verbs, Save view), so the host bar drops them;
// `multiTile` counts tiles, not tabs.
//
// Subtitle: a tool reads `<title> · <its reported state>`, a screen
// `<macros or id> · <screen title>` with the distinguishing fragment first; an
// unhealthy data connection leads instead: `<state> · <title>` on a tool,
// `<state> · <fragment>` on a screen. Never a control-target name.
//
// ⋯: [Save open tabs as collection…] + the tool's reported actions (tool tab)
// or [Download screen ⌘S, Zoom in · N%, Zoom out · N%, Fit, 100%] (screen tab)
// + [Reset layout, Show sub-screens ✓, Collections…]; over the host's 12-entry
// cap the bottom of that order is dropped, never the top. Menu entries carry
// their shortcut in the label (the host has no shortcut column) and a boolean
// `disabled` (the tool's reason stays in the viewer for the toast).

import { formatShortcut, isMac } from '../../screenActions/shortcuts.js';
import type { ScreenVerbView } from '../../screenActions/useScreenActions.js';
import { healthLabel, type ConnectionHealth } from '../connectionHealth.js';
import {
  MAX_ENTRIES,
  MAX_ITEMS,
  type HeaderButtonItem,
  type HeaderItem,
  type HeaderMenuEntry,
} from './hostBridge.js';
import type { ToolActionsReport } from '../toolActionsStore.js';

// ---- item ids --------------------------------------------------------------

export const SUBTITLE_ID = 'subtitle';
export const NAV_BACK_ID = 'nav-back';
export const NAV_FORWARD_ID = 'nav-forward';
export const SEARCH_ID = 'search';
export const MORE_ID = 'more';
export const SAVE_VIEW_ID = 'save-view';
export const SCREEN_VERB_PREFIX = 'screen:';
export const TOOL_ENTRY_PREFIX = 'tool:';

// ---- ⋯ entry ids -----------------------------------------------------------

export const MENU_SAVE_COLLECTION = 'menu:save-collection';
export const MENU_DOWNLOAD_SCREEN = 'menu:download-screen';
export const MENU_ZOOM_IN = 'menu:zoom-in';
export const MENU_ZOOM_OUT = 'menu:zoom-out';
export const MENU_ZOOM_FIT = 'menu:zoom-fit';
export const MENU_ZOOM_100 = 'menu:zoom-100';
export const MENU_RESET_LAYOUT = 'menu:reset-layout';
export const MENU_SHOW_SUB_SCREENS = 'menu:show-sub-screens';
export const MENU_COLLECTIONS = 'menu:collections';

// ---- priorities (higher survives a narrow tile) ----------------------------

/** Text never folds in the host bar; the highest value pins that intent anyway. */
export const PRIORITY_SUBTITLE = 4;
export const PRIORITY_MORE = 0;
export const PRIORITY_SEARCH = 1;
export const PRIORITY_SCREEN_VERB = 2;
export const PRIORITY_SAVE_VIEW = 3;

// ---- user-visible strings -------------------------------------------------

export const SUBTITLE_SEPARATOR = ' · ';
export const MORE_LABEL = 'More actions';
export const NAV_BACK_LABEL = '◀';
export const NAV_BACK_TITLE = 'Back';
export const NAV_FORWARD_LABEL = '▶';
export const NAV_FORWARD_TITLE = 'Forward';
export const SAVE_VIEW_LABEL = 'Save view';
export const SAVE_COLLECTION_LABEL = 'Save open tabs as collection…';
export const DOWNLOAD_SCREEN_LABEL = 'Download screen';
export const ZOOM_IN_LABEL = 'Zoom in';
export const ZOOM_OUT_LABEL = 'Zoom out';
export const ZOOM_FIT_LABEL = 'Fit';
export const ZOOM_100_LABEL = '100%';
export const RESET_LAYOUT_LABEL = 'Reset layout';
export const SHOW_SUB_SCREENS_LABEL = 'Show sub-screens';
export const COLLECTIONS_LABEL = 'Collections…';

/**
 * The screen verbs that are host bar buttons, in this order (Download screen is a ⋯
 * entry, never a button). `shortcut` is the viewer's bare letter, shown in the
 * button's title.
 */
export const SCREEN_VERB_BUTTONS: readonly { id: string; label: string; shortcut?: string }[] = [
  { id: 'reload', label: 'Reload' },
  { id: 'export-png', label: 'Export PNG', shortcut: 'i' },
  { id: 'print', label: 'Print', shortcut: 'p' },
  { id: 'plot-data-browser', label: 'Plot in Data Browser' },
  { id: 'copy-link', label: 'Copy link' },
];

/** Plot in Data Browser is omitted, not disabled, when unavailable (unconfigured). */
const OMIT_WHEN_UNAVAILABLE = new Set(['plot-data-browser']);

// ---- input ----------------------------------------------------------------

export type HeaderTab =
  | { kind: 'tool'; title: string }
  | {
      kind: 'screen';
      /** The screen's display title (may be empty before it loads). */
      title: string;
      id: string;
      macros?: Readonly<Record<string, string>>;
    };

export interface HeaderInput {
  /** The active (focused) tab, or null with an empty strip. */
  activeTab: HeaderTab | null;
  /** The focused screen tile's verb view, null before it reports. */
  screenView: ScreenVerbView | null;
  /** The focused tool's last canopy:tool-actions report, null when it has not reported. */
  toolActions: ToolActionsReport | null;
  savedViewsEnabled: boolean;
  collectionsEnabled: boolean;
  dockAvailable: boolean;
  resetDisabled: boolean;
  /** Two or more tiles are open (tabs inside one tile do not count). */
  multiTile: boolean;
  health: ConnectionHealth;
  showSubScreens: boolean;
  /** Platform for shortcut labels; defaults to the running platform. */
  mac?: boolean;
}

// ---- helpers --------------------------------------------------------------

const C2_SHORTCUT = /^(primary|alt)\+([a-z0-9])$/i;

/** A reported tool shortcut (`primary+O`, `alt+D`) for the platform; '' when unparseable. */
export function formatToolShortcut(shortcut: string | undefined, mac: boolean): string {
  if (!shortcut) return '';
  const match = C2_SHORTCUT.exec(shortcut.trim());
  if (!match) return '';
  const key = match[2].toUpperCase();
  if (match[1].toLowerCase() === 'primary') return formatShortcut(key, mac);
  return mac ? `⌥${key}` : `Alt+${key}`;
}

function withShortcut(label: string, shortcut: string): string {
  return shortcut ? `${label} ${shortcut}` : label;
}

/** The distinguishing fragment of a screen: `k=v` macros, else its id. */
export function screenFragment(tab: {
  id: string;
  macros?: Readonly<Record<string, string>>;
}): string {
  const pairs = Object.entries(tab.macros ?? {}).map(([k, v]) => `${k}=${v}`);
  return pairs.length > 0 ? pairs.join(', ') : tab.id;
}

function join(...parts: (string | null | undefined)[]): string {
  return parts
    .filter((p): p is string => typeof p === 'string' && p !== '')
    .join(SUBTITLE_SEPARATOR);
}

/** The subtitle text (see the header). */
export function composeSubtitle(
  tab: HeaderTab | null,
  health: ConnectionHealth,
  toolState?: string
): string {
  const state = healthLabel(health);
  if (tab === null) return state ?? '';
  if (tab.kind === 'tool') {
    return state ? join(state, tab.title) : join(tab.title, toolState);
  }
  const fragment = screenFragment(tab);
  return state ? join(state, fragment) : join(fragment, tab.title);
}

function zoomPercent(scale: number): string {
  return `${Math.round(scale * 100)}%`;
}

function workspaceHead(input: HeaderInput): HeaderMenuEntry[] {
  return input.collectionsEnabled
    ? [{ id: MENU_SAVE_COLLECTION, label: SAVE_COLLECTION_LABEL }]
    : [];
}

function workspaceTail(input: HeaderInput): HeaderMenuEntry[] {
  const out: HeaderMenuEntry[] = [];
  if (input.dockAvailable) {
    out.push({ id: MENU_RESET_LAYOUT, label: RESET_LAYOUT_LABEL, disabled: input.resetDisabled });
  }
  out.push({
    id: MENU_SHOW_SUB_SCREENS,
    label: SHOW_SUB_SCREENS_LABEL,
    checked: input.showSubScreens,
  });
  if (input.collectionsEnabled) out.push({ id: MENU_COLLECTIONS, label: COLLECTIONS_LABEL });
  return out;
}

function toolEntries(report: ToolActionsReport | null, mac: boolean): HeaderMenuEntry[] {
  if (!report) return [];
  return report.actions.map((action) => {
    const entry: HeaderMenuEntry = {
      id: `${TOOL_ENTRY_PREFIX}${action.id}`,
      label: withShortcut(action.label, formatToolShortcut(action.shortcut, mac)),
    };
    if (action.kind === 'toggle') entry.checked = action.pressed === true;
    entry.disabled = Boolean(action.disabled);
    return entry;
  });
}

function screenEntries(view: ScreenVerbView | null, mac: boolean): HeaderMenuEntry[] {
  if (!view) return [];
  const percent = zoomPercent(view.zoom.scale);
  return [
    {
      id: MENU_DOWNLOAD_SCREEN,
      label: withShortcut(DOWNLOAD_SCREEN_LABEL, formatShortcut('s', mac)),
      disabled: !view.download.available,
    },
    { id: MENU_ZOOM_IN, label: `${ZOOM_IN_LABEL}${SUBTITLE_SEPARATOR}${percent}` },
    { id: MENU_ZOOM_OUT, label: `${ZOOM_OUT_LABEL}${SUBTITLE_SEPARATOR}${percent}` },
    { id: MENU_ZOOM_FIT, label: ZOOM_FIT_LABEL, checked: view.zoom.fit },
    { id: MENU_ZOOM_100, label: ZOOM_100_LABEL, checked: !view.zoom.fit && view.zoom.scale === 1 },
  ];
}

/** The ⋯ entries, capped at the host's 12 by dropping from the bottom. */
export function composeMoreEntries(input: HeaderInput): HeaderMenuEntry[] {
  const mac = input.mac ?? isMac;
  const kind = input.activeTab?.kind;
  const middle =
    kind === 'tool'
      ? toolEntries(input.toolActions, mac)
      : kind === 'screen'
        ? screenEntries(input.screenView, mac)
        : [];
  return [...workspaceHead(input), ...middle, ...workspaceTail(input)].slice(0, MAX_ENTRIES);
}

function screenButtons(view: ScreenVerbView | null, mac: boolean): HeaderButtonItem[] {
  if (!view) return [];
  const out: HeaderButtonItem[] = [
    {
      kind: 'button',
      id: NAV_BACK_ID,
      priority: PRIORITY_SCREEN_VERB,
      label: NAV_BACK_LABEL,
      title: NAV_BACK_TITLE,
      disabled: !view.canGoBack,
    },
    {
      kind: 'button',
      id: NAV_FORWARD_ID,
      priority: PRIORITY_SCREEN_VERB,
      label: NAV_FORWARD_LABEL,
      title: NAV_FORWARD_TITLE,
      disabled: !view.canGoForward,
    },
  ];
  const available = new Map(view.verbs.map((v) => [v.id, v.available]));
  for (const verb of SCREEN_VERB_BUTTONS) {
    const isAvailable = available.get(verb.id) === true;
    if (!isAvailable && OMIT_WHEN_UNAVAILABLE.has(verb.id)) continue;
    out.push({
      kind: 'button',
      id: `${SCREEN_VERB_PREFIX}${verb.id}`,
      priority: PRIORITY_SCREEN_VERB,
      label: verb.label,
      title: verb.shortcut ? `${verb.label} (${formatShortcut(verb.shortcut, mac)})` : verb.label,
      disabled: !isAvailable,
    });
  }
  return out;
}

/** The whole item list for the host tile bar (whole replace on any change). */
export function composeHeader(input: HeaderInput): HeaderItem[] {
  const mac = input.mac ?? isMac;
  const tab = input.activeTab;
  const items: HeaderItem[] = [
    {
      kind: 'text',
      id: SUBTITLE_ID,
      priority: PRIORITY_SUBTITLE,
      text: composeSubtitle(tab, input.health, input.toolActions?.state),
    },
  ];
  if (!input.multiTile && tab?.kind === 'screen') {
    items.push(...screenButtons(input.screenView, mac));
  }
  items.push({
    kind: 'button',
    id: SEARCH_ID,
    priority: PRIORITY_SEARCH,
    label: `Search ${formatShortcut('k', mac)}`,
  });
  items.push({
    kind: 'menu',
    id: MORE_ID,
    priority: PRIORITY_MORE,
    label: MORE_LABEL,
    items: composeMoreEntries({ ...input, mac }),
  });
  if (!input.multiTile && tab?.kind === 'tool' && input.savedViewsEnabled) {
    items.push({
      kind: 'button',
      id: SAVE_VIEW_ID,
      priority: PRIORITY_SAVE_VIEW,
      label: SAVE_VIEW_LABEL,
      title: `${SAVE_VIEW_LABEL} (${formatShortcut('s', mac)})`,
      tone: 'accent',
    });
  }
  return items.slice(0, MAX_ITEMS);
}
