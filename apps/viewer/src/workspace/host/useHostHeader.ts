// The workspace's side of the host header (docs/host-embedding.md), armed
// while the host owns the header: the focused tab's inputs are composed into
// the whole item list (headerComposer) and contributed again on every change
// (hostBridge.contribute); the host's clicks come back through onAction and
// run against the focused tile (headerActions, through the latest context).
// ⌘S pressed outside a tool frame on a tool tab is offered to `onSaveKey`
// (Save view; never the browser's Save Page). Disarmed, none of it runs.

import { useEffect, useLayoutEffect, useRef } from 'react';
import { primaryShortcutKey } from '../../screenActions/shortcuts.js';
import { composeHeader } from './headerComposer.js';
import type { HeaderInput } from './headerComposer.js';
import { dispatchHeaderAction } from './headerActions.js';
import type { HeaderActionContext } from './headerActions.js';
import { contribute, onAction } from './hostBridge.js';

export interface HostHeaderOptions {
  /** Whether the host owns the header (HostCapabilities.headerOwnedByHost). */
  enabled: boolean;
  /** What the header shows now; a new value is contributed whole. */
  input: HeaderInput;
  /** The effects a header action runs, bound to the focused tile. */
  context: HeaderActionContext;
  /** ⌘S outside a frame: true when it was taken (the browser's default is then prevented). */
  onSaveKey: () => boolean;
}

export function useHostHeader({ enabled, input, context, onSaveKey }: HostHeaderOptions): void {
  useEffect(() => {
    if (!enabled) return;
    contribute(composeHeader(input));
  }, [enabled, input]);

  // Bound to the focused tile on every render; the listeners read them live.
  const latest = useRef({ context, onSaveKey });
  useLayoutEffect(() => {
    latest.current = { context, onSaveKey };
  });
  useEffect(() => {
    if (!enabled) return undefined;
    return onAction((actionId, value) =>
      dispatchHeaderAction(actionId, value, latest.current.context)
    );
  }, [enabled]);
  // A key pressed inside a tool frame never reaches this window, so this is
  // focus outside it.
  useEffect(() => {
    if (!enabled) return undefined;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || primaryShortcutKey(e) !== 's') return;
      if (latest.current.onSaveKey()) e.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled]);
}
