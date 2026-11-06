// The shared write-toast column of a page. The workspace (chrome mode)
// renders one viewport-level column, `WriteToastColumn`, and gives every
// mounted screen a `WriteToastHost` through context: the column element, the
// screen's tab title, and a report of whether the screen has a live toast, so
// toasts of several docked screens never stack in one corner. WriteGateView
// portals its toasts into that column, each named by the tab title; without a
// host (the single-screen route, `_canopyChrome=0`) it renders its own inline
// stack.
//
// A portalled toast leaves its screen's subtree, so it stays visible and
// operable when the screen is vacated (hidden and inert). The gate wipes its
// toasts when its screen unmounts, so the workspace also keeps every screen
// with a live toast mounted (`pinLiveToasts`) until its toasts are gone.
//
// The confirmation dialog never moves: it stays a fixed, viewport-level child
// of its screen, so a vacated screen's dialog is hidden and inert with it and
// still pending when the screen comes back.
//
// The column is the page's "Notices": beside the screens' write toasts it
// holds the page's machine toasts (machineToasts.ts), mounted once per page
// by `MachineToasts`: the workspace chrome, and a chrome `/s/` page. Each
// carries the machine label as its title and is visual only (no live role):
// the target badge stays the page's one live region. The screens of a page
// put their write gates in its `MachineGatesContext`, so a writes change a
// gate already reported ("writes changed") raises no second toast.

import { createContext, useContext, useEffect, useMemo, useSyncExternalStore } from 'react';
import type React from 'react';
import { createPortal } from 'react-dom';
import { usePrefix } from '@carbon/react';
import { CheckmarkFilled, Close, ErrorFilled, WarningFilled } from '@carbon/icons-react';
import { ServicesContext } from '../services.js';
import { createMachineToasts } from './machineToasts.js';
import type {
  MachineGateRegistry,
  MachineToaster,
  MachineToastKind,
  MachineToastsState,
} from './machineToasts.js';

/** What a workspace gives one screen's write gate. */
export interface WriteToastHost {
  /** The shared column (null until it has mounted: the gate renders inline). */
  readonly element: HTMLElement | null;
  /** The screen's tab title, shown above each of its toasts. */
  readonly title: string;
  /** Called with true while the screen has a toast, false once it has none. */
  readonly onLive?: (live: boolean) => void;
}

export const WriteToastHostContext = createContext<WriteToastHost | null>(null);

/** The host of the screen below, or null outside a workspace. */
export function useWriteToastHost(): WriteToastHost | null {
  return useContext(WriteToastHostContext);
}

/**
 * The viewport-level stack: fixed to the bottom-left corner, above tiles and
 * sashes. Bottom-left keeps it clear of a host's bottom-right overlay, which
 * would clip the toast and take its close button's clicks. Fixed geometry
 * against the viewport needs an ancestor chain with no transform (the
 * workspace.css / dock.css stacking invariant).
 */
export const TOASTS_STYLE: React.CSSProperties = {
  position: 'fixed',
  left: '1rem',
  bottom: '1rem',
  zIndex: 9000,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  gap: '0.5rem',
  maxWidth: 'calc(100vw - 2rem)',
};

/** The page's one notices column (write and machine toasts); `onElement` receives its element. */
export function WriteToastColumn({
  onElement,
}: {
  onElement: (element: HTMLDivElement | null) => void;
}) {
  return (
    <div
      ref={onElement}
      className="canopy-write-toasts canopy-write-toasts--workspace"
      data-testid="canopy-write-toast-column"
      role="region"
      aria-label="Notices"
      style={TOASTS_STYLE}
    />
  );
}

/**
 * The mount set `mounted` (strip order) widened by every open screen tab in
 * `live` (a screen with a toast), so the keep-mounted bound never drops a
 * toast. Strip order is kept, so a pinned screen never moves in the DOM.
 */
export function pinLiveToasts(
  mounted: readonly string[],
  keys: readonly string[],
  live: readonly string[],
  isScreen: (key: string) => boolean
): string[] {
  if (live.length === 0) return [...mounted];
  return keys.filter((key) => mounted.includes(key) || (live.includes(key) && isScreen(key)));
}

/** The write gates of the page around a screen, or null outside one. */
export const MachineGatesContext = createContext<MachineGateRegistry | null>(null);

/** The registry the screen below puts its write gate in, or null. */
export function useMachineGates(): MachineGateRegistry | null {
  return useContext(MachineGatesContext);
}

const EMPTY_TOASTS: MachineToastsState = Object.freeze({ toasts: Object.freeze([]) });
const NO_TOASTS: Pick<MachineToaster, 'subscribe' | 'getSnapshot'> = {
  subscribe: () => () => {},
  getSnapshot: () => EMPTY_TOASTS,
};

const ICONS: Record<MachineToastKind, typeof ErrorFilled> = {
  error: ErrorFilled,
  success: CheckmarkFilled,
  warning: WarningFilled,
};

/** One group of toasts, laid out like a screen's group in the column. */
const GROUP_STYLE: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  gap: '0.5rem',
};

/**
 * The page's machine toasts, read from its backend badge store (none in mock
 * or fixture mode). Rendered into `column` when given, else in their own
 * stack at the column's corner. Mount once per page.
 */
export function MachineToasts({
  column,
  gates = null,
}: {
  column: HTMLElement | null;
  gates?: MachineGateRegistry | null;
}) {
  const store = useContext(ServicesContext)?.backend ?? null;
  const toaster = useMemo(
    () => (store ? createMachineToasts(store, { gates }) : null),
    [store, gates]
  );
  useEffect(() => {
    if (!toaster) return;
    toaster.activate();
    return () => toaster.dispose();
  }, [toaster]);
  const source = toaster ?? NO_TOASTS;
  const state = useSyncExternalStore(source.subscribe, source.getSnapshot);
  const prefix = usePrefix();
  if (!toaster || state.toasts.length === 0) return null;
  const list = (
    <div className="canopy-machine-toasts" data-testid="canopy-machine-toasts" style={GROUP_STYLE}>
      {state.toasts.map((t) => {
        const Icon = ICONS[t.kind];
        return (
          <div
            key={t.id}
            className={
              `canopy-machine-toasts__item ${prefix}--toast-notification ` +
              `${prefix}--toast-notification--low-contrast ${prefix}--toast-notification--${t.kind}`
            }
            data-kind={t.kind}
            onMouseEnter={() => toaster.hold(t.id)}
            onMouseLeave={() => toaster.release(t.id)}
            onFocus={() => toaster.hold(t.id)}
            onBlur={() => toaster.release(t.id)}
          >
            <Icon className={`${prefix}--toast-notification__icon`} size={20} aria-hidden="true" />
            <div className={`${prefix}--toast-notification__details`}>
              {t.title !== null && (
                <div
                  className="canopy-write-toast__screen"
                  data-testid="canopy-machine-toast-title"
                >
                  {t.title}
                </div>
              )}
              <span className="canopy-machine-toast__text" data-testid="canopy-machine-toast">
                {t.text}
              </span>
            </div>
            <button
              type="button"
              className={`${prefix}--toast-notification__close-button`}
              aria-label="Close notice"
              onClick={() => toaster.dismiss(t.id)}
            >
              <Close className={`${prefix}--toast-notification__close-icon`} aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </div>
  );
  return column ? (
    createPortal(list, column)
  ) : (
    <div className="canopy-write-toasts" style={TOASTS_STYLE}>
      {list}
    </div>
  );
}
