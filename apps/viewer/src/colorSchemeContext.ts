// The color scheme every rendered screen uses. main.tsx parses config.json's
// `colorScheme` once at config load and provides that one object here, so the
// value is referentially stable for the page's lifetime. ScreenPage reads it
// and hands it to ScreenRenderer; that covers /s/ and every workspace tab
// under /embed without threading it through WorkspacePage (whose memoised
// MountedScreen receives no config). Without a provider (tests, a config with
// no scheme) screens get the bundled canopy-default scheme.

import { createContext, useContext } from 'react';
import { canopyDefaultFlat } from '@slaclab/canopy-screen-ir';
import type { FlatScheme } from '@slaclab/canopy-screen-ir';

export const ColorSchemeContext = createContext<FlatScheme>(canopyDefaultFlat);

/** The color scheme the viewer was configured with. */
export function useColorScheme(): FlatScheme {
  return useContext(ColorSchemeContext);
}
