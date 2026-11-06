// The color scheme in effect for a rendered screen. Provided once, by the top
// ScreenRenderer root; embedded screens inherit it and never re-provide it.

import { createContext, useContext } from 'react';
import { canopyDefaultFlat } from '@slaclab/canopy-screen-ir';
import type { FlatScheme } from '@slaclab/canopy-screen-ir';

export const SchemeContext = createContext<FlatScheme>(canopyDefaultFlat);

/** The flat color scheme roles resolve against. */
export function useColorScheme(): FlatScheme {
  return useContext(SchemeContext);
}
