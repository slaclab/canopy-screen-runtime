// The available screen actions as header icon buttons, and their keyboard
// shortcuts. Meant for an AppHeader's toolbar slot. Each is a plain button
// with Carbon's header-action look, labelled by its native `title` (the label
// plus the shortcut), as the zoom group's buttons are. Both hosts get this on
// purpose, one component with one label mechanism: in the workspace the
// header sits inside a dock tile bar, whose tab container clips and
// transforms its content, so nothing here may render a popover tooltip; the
// /s/ deep link, outside any dock, shows the same buttons the same way. A
// short status text reports what an action wants to say ("Copied") or why it
// failed.
//
// Shortcuts: a page binds exactly one window keydown listener. On the /s/
// deep link the one bar binds it (`shortcuts` defaults to on). In the
// workspace every screen tile has a bar, and the workspace binds the one
// listener itself, for the focused tile: it provides a ShortcutRelay around
// each bar, which turns the bar's own listener off and through which the
// bar hands over its runner, so a shortcut runs the focused tile's action
// with that bar's dedupe and status text, exactly as a click on it would.
// The runner itself lives in useScreenActions, which a tile with no bar
// (inside an embedding host, one tile) calls on its own.

import { createContext, useContext, useMemo } from 'react';
import { SCREEN_ACTIONS } from './actions.js';
import { formatShortcut, shortcutBindings, useShortcuts } from './shortcuts.js';
import type { ScreenAction, ScreenActionContext } from './types.js';
import { useScreenActions } from './useScreenActions.js';

/** The native title and accessible name: `Print (⌘P)`. */
export function actionLabel(action: ScreenAction): string {
  return action.shortcut ? `${action.label} (${formatShortcut(action.shortcut)})` : action.label;
}

/**
 * Where a bar whose shortcuts another component owns hands over its runner:
 * `attach` is called with it while the bar is mounted and returns the detach.
 */
export interface ShortcutRelay {
  attach(run: (action: ScreenAction) => void): () => void;
}

/** A bar below a relay binds no listener of its own (unless told `shortcuts`). */
export const ShortcutRelayContext = createContext<ShortcutRelay | null>(null);

export interface ScreenActionBarProps {
  ctx: ScreenActionContext;
  /** The action list; the viewer's SCREEN_ACTIONS by default. */
  actions?: readonly ScreenAction[];
  /**
   * Whether this bar binds its own shortcut listener: on by default, off
   * below a ShortcutRelay. Off, the buttons still name and run the actions.
   */
  shortcuts?: boolean;
}

export function ScreenActionBar({
  ctx,
  actions = SCREEN_ACTIONS,
  shortcuts,
}: ScreenActionBarProps) {
  const relay = useContext(ShortcutRelayContext);
  const listens = shortcuts ?? relay === null;
  // The runner (dedupe, status text, the relay hand-over) is the headless
  // hook's; this bar only renders it.
  const { available, run, status } = useScreenActions({
    screen: ctx.screen,
    zoom: ctx.zoom,
    config: ctx.config,
    link: ctx.link,
    plotInDataBrowser: ctx.plotInDataBrowser,
    actions,
    relay,
  });

  return (
    <>
      {listens && <BarShortcuts available={available} run={run} />}
      <span
        className={
          'screen-actions__status' + (status?.error ? ' screen-actions__status--error' : '')
        }
        role="status"
        data-testid="screen-action-status"
      >
        {status?.text}
      </span>
      {available.map((action) => {
        const Icon = action.icon;
        const label = actionLabel(action);
        return (
          <button
            key={action.id}
            type="button"
            className="cds--header__action"
            aria-label={label}
            title={label}
            data-screen-action={action.id}
            onClick={() => run(action)}
          >
            <Icon size={20} aria-hidden="true" />
          </button>
        );
      })}
    </>
  );
}

/**
 * The bar's own listener, mounted only while it binds one: a bar with
 * shortcuts off calls no useShortcuts at all (hooks cannot be skipped).
 */
function BarShortcuts({
  available,
  run,
}: {
  available: readonly ScreenAction[];
  run: (action: ScreenAction) => void;
}) {
  const bindings = useMemo(() => shortcutBindings(available), [available]);
  useShortcuts(bindings, run);
  return null;
}
