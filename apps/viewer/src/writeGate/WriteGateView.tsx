// The screen's write gate in React: created per screen, provided to the
// widgets and the action dispatcher through the widgets' WriteGate context,
// and rendered as one confirmation dialog (Carbon modal) and the summary
// toasts (Carbon toasts).
//
// DOM contract (read by the run drivers): data-testid `canopy-write-dialog`
// on the dialog, `canopy-write-confirm` / `canopy-write-decline` on its two
// buttons, `canopy-write-toast` on each toast's text (exactly the summary)
// with `data-outcome` set to the summary's outcome ('confirmed' for
// "written", an outcome kind, 'coalesced', or 'guarded' for a run the window's
// input guard refused: "screen just changed, nothing sent").
// Each toast sits in a `canopy-write-toasts__item` wrapper that holds it (the
// gate's holdToast/releaseToast) while hovered or focused.
//
// Where the toasts go (toastHost.tsx): under a workspace's WriteToastHost
// they are portalled into its one shared, viewport-level column, as one group
// per screen (`data-screen-title`), each toast headed by the screen's tab
// title (`canopy-write-toast-screen`, outside the contract element); without
// one they render in place, in the screen's own fixed stack, as before. The
// dialog always renders in place: a fixed, viewport-level child of its
// screen, hidden and inert with it.

import { useEffect, useLayoutEffect, useMemo, useSyncExternalStore } from 'react';
import type React from 'react';
import { createPortal } from 'react-dom';
import {
  Button,
  ComposedModal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ToastNotification,
} from '@carbon/react';
import type { PVWriteOrigin } from '@slaclab/canopy-client';
import { WriteGate } from '@slaclab/canopy-screen-widgets';
import type { WriteRequest } from '@slaclab/canopy-screen-widgets';
import { createWriteGate } from './gate.js';
import type { ScreenWriteGate, WriteBackend, WriteToastState } from './gate.js';
import { TOASTS_STYLE, useWriteToastHost } from './toastHost.js';
import './WriteGateView.css';

/**
 * The gate of one open screen, or null without a backend (mock and fixture
 * mode): the widgets then write straight through. A new gate per `key` (the
 * screen); queued runs are dropped when the screen changes or unmounts.
 */
export function useScreenWriteGate(
  backend: WriteBackend | undefined,
  origin: PVWriteOrigin,
  key: string
): ScreenWriteGate | null {
  const gate = useMemo(
    () => (backend ? createWriteGate(backend, origin) : null),
    // origin: kept current below, without a new gate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [backend, key]
  );
  const screen = origin.screen;
  const rev = origin.rev ?? null;
  useLayoutEffect(() => {
    gate?.setOrigin({ screen, rev });
  }, [gate, screen, rev]);
  useEffect(() => {
    if (!gate) return;
    gate.activate();
    return () => gate.dispose();
  }, [gate]);
  return gate;
}

const NO_GATE = {
  subscribe: () => () => {},
  getSnapshot: () => null,
};

function formatValue(value: WriteRequest['value']): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

/** The value cell: the value, and the text it was typed as when that reads differently. */
function formatWrite(w: WriteRequest): string {
  const value = formatValue(w.value);
  const entered = w.entered?.trim();
  return entered === undefined || entered === value
    ? value
    : `${value} (entered ${JSON.stringify(entered)})`;
}

function toastKind(t: WriteToastState): 'success' | 'warning' | 'error' {
  switch (t.outcome) {
    case 'confirmed':
      return 'success';
    case 'mismatch':
    case 'unconfirmed':
    case 'unknown':
    case 'coalesced':
    case 'guarded':
      return 'warning';
    default:
      return 'error';
  }
}

/** The dialog and toasts of `gate` (nothing when null). */
export function WriteGateView({ gate }: { gate: ScreenWriteGate | null }) {
  const source = gate ?? NO_GATE;
  const state = useSyncExternalStore(source.subscribe, source.getSnapshot);
  const host = useWriteToastHost();
  const live = !!gate && !!state && state.toasts.length > 0;
  const onLive = host?.onLive;
  // Tell the workspace while this screen has a toast, so it stays mounted
  // (its gate, and with it the toast, would go with it).
  useEffect(() => {
    if (!onLive) return;
    onLive(live);
    return () => {
      if (live) onLive(false);
    };
  }, [onLive, live]);
  if (!gate || !state) return null;
  const dialog = state.dialog;
  const column = host?.element ?? null;
  const toastList = state.toasts.map((t) => (
    <div
      key={t.id}
      className="canopy-write-toasts__item"
      onMouseEnter={() => gate.holdToast(t.id)}
      onMouseLeave={() => gate.releaseToast(t.id)}
      onFocus={() => gate.holdToast(t.id)}
      onBlur={() => gate.releaseToast(t.id)}
    >
      <ToastNotification
        kind={toastKind(t)}
        lowContrast
        role="status"
        title=""
        onClose={() => {
          gate.dismissToast(t.id);
          return false;
        }}
      >
        {column && (
          <div className="canopy-write-toast__screen" data-testid="canopy-write-toast-screen">
            {host!.title}
          </div>
        )}
        {/* The contract element: its text is exactly the summary (the
            run drivers compare it; Carbon's icon title and the screen
            title stay outside). */}
        <span
          className="canopy-write-toast__text"
          data-testid="canopy-write-toast"
          data-outcome={t.outcome}
        >
          {t.text}
        </span>
      </ToastNotification>
    </div>
  ));
  let toasts: React.ReactNode = null;
  if (state.toasts.length > 0) {
    toasts = column ? (
      createPortal(
        <div className="canopy-write-toasts__screen" data-screen-title={host!.title}>
          {toastList}
        </div>,
        column
      )
    ) : (
      <div className="canopy-write-toasts" style={TOASTS_STYLE}>
        {toastList}
      </div>
    );
  }
  return (
    <>
      {dialog && (
        <ComposedModal
          open
          size="sm"
          className="canopy-write-dialog"
          data-testid="canopy-write-dialog"
          preventCloseOnClickOutside
          onClose={() => {
            gate.decline(dialog.id);
            return false;
          }}
        >
          <ModalHeader
            title={dialog.writes.length === 1 ? 'Write to the machine?' : 'Write these values?'}
            label={dialog.machine ? `Machine: ${dialog.machine}` : 'Machine'}
          />
          <ModalBody>
            {/* Initial focus lands here, on no button: the dialog opens inside
                the event that asked for it (a text input's Enter keydown), and
                that key's keypress goes to the focused element. On Carbon's
                default target, the close button, Enter declined the dialog the
                moment it opened. */}
            <table className="canopy-write-dialog__writes" tabIndex={-1} data-modal-primary-focus>
              <thead>
                <tr>
                  <th scope="col">PV</th>
                  <th scope="col">Value</th>
                </tr>
              </thead>
              <tbody>
                {dialog.writes.map((w, i) => (
                  <tr key={i}>
                    <td>
                      <code>{w.pv}</code>
                    </td>
                    <td>
                      <code>{formatWrite(w)}</code>
                      {w.release ? ' (release)' : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ModalBody>
          <ModalFooter>
            <Button
              kind="secondary"
              size="sm"
              data-testid="canopy-write-decline"
              onClick={() => gate.decline(dialog.id)}
            >
              Cancel
            </Button>
            <Button
              kind="primary"
              size="sm"
              data-testid="canopy-write-confirm"
              onClick={() => gate.confirm(dialog.id)}
            >
              Write
            </Button>
          </ModalFooter>
        </ComposedModal>
      )}
      {toasts}
    </>
  );
}

/** Provides `gate` to the screen below and renders its dialog and toasts. */
export function ScreenWriteGateProvider({
  gate,
  children,
}: {
  gate: ScreenWriteGate | null;
  children: React.ReactNode;
}) {
  return (
    <WriteGate.Provider value={gate}>
      {children}
      <WriteGateView gate={gate} />
    </WriteGate.Provider>
  );
}
