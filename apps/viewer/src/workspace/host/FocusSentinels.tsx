// Focus exit for an embedded workspace (the viewer half; docs/host-embedding.md). Inside a host
// iframe, Tab and Shift+Tab would otherwise cycle through the workspace (and
// the Trace iframe inside it) forever, never reaching the host's own controls.
// Two invisible tabbable sentinels bracket the wrapped content: the leading one
// is the tab stop before the first control, the trailing one the tab stop after
// the last (after the Trace iframe too). Focusing either posts
//
//   canopy-host-focus-exit {direction: 'backward' | 'forward'}
//
// to window.parent with targetOrigin location.origin, and focus stays on the
// sentinel; the host moves focus to its own previous / next control. Standalone
// (window.parent === window) no sentinel renders and nothing is posted.

import type { CSSProperties, ReactNode } from 'react';

export const FOCUS_EXIT = 'canopy-host-focus-exit';

export type FocusExitDirection = 'backward' | 'forward';

export interface FocusExitMessage {
  type: typeof FOCUS_EXIT;
  direction: FocusExitDirection;
}

// Visually hidden but focusable (no display:none / visibility:hidden, which
// would drop it from the tab order).
const SENTINEL_STYLE: CSSProperties = {
  position: 'fixed',
  top: 0,
  left: 0,
  width: 1,
  height: 1,
  margin: -1,
  padding: 0,
  border: 0,
  overflow: 'hidden',
  clipPath: 'inset(50%)',
  whiteSpace: 'nowrap',
};

function isEmbedded(): boolean {
  return typeof window !== 'undefined' && window.parent !== window;
}

function postExit(direction: FocusExitDirection): void {
  const message: FocusExitMessage = { type: FOCUS_EXIT, direction };
  window.parent.postMessage(message, window.location.origin);
}

function Sentinel({ direction }: { direction: FocusExitDirection }) {
  return (
    <div
      tabIndex={0}
      style={SENTINEL_STYLE}
      data-focus-exit={direction}
      aria-hidden="true"
      onFocus={() => postExit(direction)}
    />
  );
}

export function FocusSentinels({ children }: { children: ReactNode }) {
  if (!isEmbedded()) return <>{children}</>;
  return (
    <>
      <Sentinel direction="backward" />
      {children}
      <Sentinel direction="forward" />
    </>
  );
}
