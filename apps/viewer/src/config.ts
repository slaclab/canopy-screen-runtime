// Viewer configuration — the only file that reads import.meta.env.
//
//   VITE_SCREENS_BASE_URL  base URL serving a canopy-screens checkout
//                          (manifest.json + screens/**). Default '' =
//                          same-origin.
//   VITE_PV_MODE           'mock' (default) | 'hare'
//   VITE_CANOPY_BASE_URL   Canopy API base (hare mode), e.g. https://host
//   VITE_CANOPY_API_KEY    API key (hare mode)
//   VITE_RENDER_MODE       'edm' (default) | 'carbon' — default presentation
//                          of rendered screens; a screen URL's ?render=
//                          overrides it per page.

import { DEFAULT_RENDER_MODE, parseRenderMode } from '@slaclab/canopy-screen-runtime';
import type { RenderMode } from '@slaclab/canopy-screen-runtime';

export interface ViewerConfig {
  screensBaseUrl: string;
  pvMode: 'mock' | 'hare';
  canopyBaseUrl: string;
  canopyApiKey: string | undefined;
  renderMode: RenderMode;
}

export function readConfig(
  env: Record<string, string | undefined> = import.meta.env
): ViewerConfig {
  const pvMode = env.VITE_PV_MODE === 'hare' ? 'hare' : 'mock';
  return {
    screensBaseUrl: (env.VITE_SCREENS_BASE_URL ?? '').replace(/\/+$/, ''),
    pvMode,
    canopyBaseUrl: (env.VITE_CANOPY_BASE_URL ?? '').replace(/\/+$/, ''),
    canopyApiKey: env.VITE_CANOPY_API_KEY || undefined,
    renderMode: parseRenderMode(env.VITE_RENDER_MODE) ?? DEFAULT_RENDER_MODE,
  };
}
