// Route table. main.tsx wraps this in BrowserRouter + ServicesContext;
// tests use MemoryRouter and mock services. App also owns the widget-action
// host (see actionHost.ts) for the /s/ deep links: action errors render as an
// ErrorPanel above the current page until dismissed or the viewer navigates.
// The workspace under /embed installs its own host. The app-level zoom
// (ZoomContext's ZoomProvider) sits here too, for the workspace with chrome
// off (/s/ is never zoomed); the docked workspace gives each screen tile its
// own zoom underneath it (WorkspacePage's ZoomStore).
//
// The /s/ route element (ScreenTheme) is the /s/ theme writer: it takes the
// embed's theme input (?theme=, the canopy:theme message; light when neither is
// given) into the runtime's mode store and wraps the page in a Carbon <Theme>
// that follows the store and is the anchor a host stylesheet styles
// (canopy-shell's useHostTheme). ScreenPage itself never writes the store,
// since it also renders every workspace tab.
//
// Two error surfaces render outside every page's <Theme>: the action-error
// overlay and the catch-all "Page not found" panel. The error panel's colours
// exist only inside a Carbon zone, so each gets a read-only one (ErrorZone)
// that follows the mode store and never writes it.
//
//   /                    -> /embed/ (query kept)
//   /s/:category/*       one screen with the full chrome (deep links)
//   /embed/...           the workspace inside the themed embed layout:
//     /embed/, /embed/@<tool>[/<n>], /embed/<category>/<id>  the workspace
//     /embed/<seg>  any other single segment (a category alone, a tool not
//                   served here): the workspace itself replaces the URL with
//                   its active tab's, on mount and on every later change —
//                   no manifest lookup, so nothing waits on its load.
//
// Every /embed/* match renders the SAME un-keyed WorkspacePage element under
// the one /embed layout route, so switching tabs (a URL change) never
// remounts it and the tool tabs stay mounted. (React Router keys no route
// match: a different element on one child route would remount the workspace
// and reload every tool iframe.) Redirects use `replace`.

import { useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Theme } from '@carbon/react';
import { ActionHostContext, getMode, subscribe } from '@slaclab/canopy-screen-runtime';
import { useHostTheme } from '@slaclab/canopy-shell';
import { EmbedPage } from './pages/EmbedPage.js';
import { ScreenPage } from './pages/ScreenPage.js';
import { WorkspacePage } from './workspace/WorkspacePage.js';
import { ErrorPanel } from './ErrorPanel.js';
import { useViewerActionHost } from './actionHost.js';
import { ZoomProvider } from './ZoomContext.js';
import type { ThemeName, ViewerConfig } from './config.js';
import { useThemeInput } from './useThemeInput.js';
import './embed.css';

const NO_THEMES: Record<string, ThemeName> = {};

/** Replace-redirect to the workspace root, keeping the query (theme, chrome). */
function ToWorkspace() {
  const { search } = useLocation();
  return <Navigate to={{ pathname: '/embed/', search }} replace />;
}

/**
 * The /s/ route element: writes the mode store from the theme input, and
 * themes Carbon from the store; its root element carries the host's theme
 * id. `children` (the page) is a stable element, so a flip re-renders this
 * wrapper and none of the screen's widgets.
 * `viewer-embed` is the full-height class the embed layout uses.
 */
function ScreenTheme({
  themes,
  children,
}: {
  themes: Record<string, ThemeName>;
  children: ReactNode;
}) {
  const raw = useThemeInput(themes, 'light');
  const mode = useSyncExternalStore(subscribe, getMode);
  const { anchorRef, anchorProps } = useHostTheme<HTMLDivElement>(raw, mode);
  return (
    <Theme
      ref={anchorRef}
      {...anchorProps}
      theme={mode === 'dark' ? 'g100' : 'white'}
      className="viewer-embed"
    >
      {children}
    </Theme>
  );
}

/**
 * A Carbon zone for an error surface outside every page: follows the mode
 * store, never writes it. (ScreenTheme would: it resolves a missing theme
 * input to light, and so would flip an /embed page.)
 */
function ErrorZone({ children }: { children: ReactNode }) {
  const mode = useSyncExternalStore(subscribe, getMode);
  return <Theme theme={mode === 'dark' ? 'g100' : 'white'}>{children}</Theme>;
}

export function App({
  screensBaseUrl,
  themes = NO_THEMES,
  config,
}: {
  screensBaseUrl: string;
  /** config.themes: host theme id -> light/dark, used by /embed and /s/. */
  themes?: Record<string, ThemeName>;
  /** The viewer config, passed to the pages; each tool's entry enables its tabs. */
  config?: Readonly<Partial<ViewerConfig>>;
}) {
  const { host, error, clearError } = useViewerActionHost(screensBaseUrl);
  // One element for every workspace route: the child routes render no key,
  // so React reconciles it in place when the matched child changes.
  const workspace = <WorkspacePage screensBaseUrl={screensBaseUrl} config={config} />;
  return (
    <ActionHostContext.Provider value={host}>
      <ZoomProvider>
        {error !== null && (
          <ErrorZone>
            <div className="viewer-action-error">
              <ErrorPanel title="Action failed" detail={error} />
              <button type="button" onClick={clearError}>
                Dismiss
              </button>
            </div>
          </ErrorZone>
        )}
        <Routes>
          <Route path="/" element={<ToWorkspace />} />
          {/* splat, not :id, so slashed ids like "CBXFEL/Landing" match */}
          <Route
            path="/s/:category/*"
            element={
              <ScreenTheme themes={themes}>
                <ScreenPage screensBaseUrl={screensBaseUrl} chrome config={config} />
              </ScreenTheme>
            }
          />
          {/* The workspace, for an iframe host: one themed layout, so the
            host's theme survives navigation. WorkspacePage redirects the
            URLs that name no tab. */}
          <Route path="/embed" element={<EmbedPage themes={themes} />}>
            <Route index element={workspace} />
            <Route path="*" element={workspace} />
          </Route>
          <Route
            path="*"
            element={
              <ErrorZone>
                <ErrorPanel title="Page not found" />
              </ErrorZone>
            }
          />
        </Routes>
      </ZoomProvider>
    </ActionHostContext.Provider>
  );
}
