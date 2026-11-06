// /embed/... — the viewer inside an iframe host.
// EmbedPage is the layout route of every embed page, so its state outlives
// navigation between them:
//
//   /embed/...                 the workspace (WorkspacePage)
//
// It gives a host a theme input: the host's ?theme=<id> and its theme
// messages ({type: 'canopy:theme', theme: <id>}, see useThemeInput.ts),
// mapped to light/dark through config.themes, then applied as a Carbon
// <Theme> plus html[data-theme]. The <Theme> element is also the anchor a
// host stylesheet styles: it carries the host's theme id itself
// (canopy-shell's useHostTheme). The ?theme= the frame loaded with stays in
// force after in-frame navigation drops it from the URL.
//
// The resolved mode also goes to the runtime's mode store, which every
// screen root reads: seeded during the first render (before any screen
// mounts), then rewritten on each flip. The ?theme= and message input is
// shared with the /s/ route (useThemeInput.ts).
//
// html[data-theme] is set directly and restored on unmount. canopy-shell's
// setColorMode is deliberately NOT used: it persists to localStorage, which
// an embed shares with the origin of the page that hosts it.

import { createContext, useLayoutEffect, useMemo, useState } from 'react';
import type { RefObject } from 'react';
import { Outlet } from 'react-router-dom';
import { Theme } from '@carbon/react';
import { setMode } from '@slaclab/canopy-screen-runtime';
import { useHostTheme } from '@slaclab/canopy-shell';
import type { ThemeName } from '../config.js';
import { resolveMode, useThemeMessages, useUrlTheme } from '../useThemeInput.js';
import '../embed.css';

/**
 * The theme of the embed layout, for pages under it that pass it on (the
 * workspace's Trace tab) or render into its root element.
 */
export interface EmbedTheme {
  /** The resolved light/dark mode. */
  mode: ThemeName;
  /** The host's theme id when it is well-formed, else the mode. */
  id: string;
  /** The layout's root element, the anchor a host stylesheet styles. */
  anchorRef: RefObject<HTMLDivElement | null>;
}

/** Dark and unanchored outside an EmbedPage, like a frame loaded without ?theme=. */
export const EmbedThemeContext = createContext<EmbedTheme>({
  mode: 'dark',
  id: 'dark',
  anchorRef: { current: null },
});

/** Layout route of every /embed page: theme input and the Carbon <Theme>. */
export function EmbedPage({ themes }: { themes: Record<string, ThemeName> }) {
  // Also seeds the mode store, before the first screen mounts and reads it.
  const urlTheme = useUrlTheme(themes, 'dark');
  // A theme message from the host wins over the ?theme= the frame loaded with.
  const [messageTheme, setMessageTheme] = useState<string | null>(null);
  const raw = messageTheme ?? urlTheme;
  const mode = resolveMode(raw, themes, 'dark');
  useThemeMessages(setMessageTheme);

  // Before paint, so a light embed never flashes the dark backdrop. The store
  // write here only matters for later flips; the mount value is seeded above.
  useLayoutEffect(() => {
    setMode(mode);
    const html = document.documentElement;
    const previous = html.dataset.theme;
    html.dataset.theme = mode;
    return () => {
      if (previous === undefined) delete html.dataset.theme;
      else html.dataset.theme = previous;
    };
  }, [mode]);

  // After the effect above, which must read html[data-theme] before this
  // hook's own effect writes the mode to it.
  const { id, anchorRef, anchorProps } = useHostTheme<HTMLDivElement>(raw, mode);
  // Keyed on the id as well as the mode: a flip between two themes of one
  // mode has to reach the pages that pass the id on.
  const theme = useMemo(() => ({ mode, id, anchorRef }), [mode, id, anchorRef]);

  return (
    <Theme
      ref={anchorRef}
      {...anchorProps}
      theme={mode === 'dark' ? 'g100' : 'white'}
      className="viewer-embed"
    >
      <EmbedThemeContext.Provider value={theme}>
        <Outlet />
      </EmbedThemeContext.Provider>
    </Theme>
  );
}
