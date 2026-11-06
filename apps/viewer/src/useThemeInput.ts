// The viewer's theme input, shared by its two mode-store writers: the /embed
// layout (EmbedPage) and the /s/ deep-link route element (App). Both take the
// same input:
//
//   * ?theme=<id> — the theme the page loaded with. It stays in force after
//     in-page navigation drops it from the URL.
//   * theme messages ({type: 'canopy:theme', theme: <id>}) from window.parent,
//     which win over the URL.
//
// An id resolves to light/dark through config.themes, then through its own
// name (canopy-shell's modeFromThemeId: 'light' or '*-light' is light,
// anything else dark). Without any id
// the caller's default applies: dark for /embed (a frame on a host's dark
// backdrop), light for /s/.
//
// The runtime's mode store is written directly — never through React state —
// so a flip reaches each screen root imperatively and no widget re-renders.
// Each writer seeds the store during its first render, before the first
// screen's layout effect reads it. Workspace tabs (ScreenPage) never write it.
//
// The raw id itself is React state of the writer only: it names the host
// theme on the writer's root element (canopy-shell's useHostTheme), so a flip
// between two themes of one mode re-renders that wrapper and no widget.

import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { setMode } from '@slaclab/canopy-screen-runtime';
import { modeFromThemeId } from '@slaclab/canopy-shell';
import type { ThemeName } from './config.js';

/** The `type` of a theme message from the parent page. */
export const THEME_MESSAGE = 'canopy:theme';

/** A theme id -> light/dark: config.themes first, then the id's own name. */
export function resolveMode(
  id: string | null,
  themes: Record<string, ThemeName>,
  fallback: ThemeName
): ThemeName {
  if (id === null || id === '') return fallback;
  const mapped = themes[id];
  if (mapped !== undefined) return mapped;
  return modeFromThemeId(id);
}

/**
 * Calls `onTheme(id)` for every theme message (THEME_MESSAGE) from the
 * parent. The host serves the viewer from its own origin, so a message from
 * any other origin is ignored.
 */
export function useThemeMessages(onTheme: (id: string) => void) {
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window.parent) return;
      if (event.origin !== window.location.origin) return;
      const data: unknown = event.data;
      if (typeof data !== 'object' || data === null) return;
      const { type, theme } = data as { type?: unknown; theme?: unknown };
      if (type !== THEME_MESSAGE) return;
      if (typeof theme === 'string') onTheme(theme);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [onTheme]);
}

/**
 * The ?theme= in force: the URL's, else the one the page loaded with (in-page
 * links do not carry it). The load value is latched in a useState initializer
 * that also seeds the mode store, so the first screen already sees the right
 * mode.
 */
export function useUrlTheme(themes: Record<string, ThemeName>, fallback: ThemeName): string | null {
  const [searchParams] = useSearchParams();
  const [loadTheme] = useState(() => {
    const id = searchParams.get('theme');
    setMode(resolveMode(id, themes, fallback));
    return id;
  });
  return searchParams.get('theme') ?? loadTheme;
}

/**
 * The theme input of a mode-store writer: writes the store from ?theme= and
 * theme messages, `fallback` when neither names a theme. Returns the raw id
 * in force (a host message wins over the URL), or null without one; it is
 * untrusted, for useHostTheme to check.
 */
export function useThemeInput(
  themes: Record<string, ThemeName>,
  fallback: ThemeName
): string | null {
  const urlTheme = useUrlTheme(themes, fallback);
  const [messageTheme, setMessageTheme] = useState<string | null>(null);

  // Later ?theme= changes only; the mount value is already in the store.
  useLayoutEffect(() => {
    setMode(resolveMode(urlTheme, themes, fallback));
  }, [urlTheme, themes, fallback]);

  const onTheme = useCallback(
    (id: string) => {
      setMode(resolveMode(id, themes, fallback));
      setMessageTheme(id);
    },
    [themes, fallback]
  );
  useThemeMessages(onTheme);
  return messageTheme ?? urlTheme;
}
