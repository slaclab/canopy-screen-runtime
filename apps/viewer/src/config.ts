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
//   VITE_EDM_BASE_URL      display-file endpoint for /edl/<path> (legacy EDM
//                          screens rendered directly): Canopy's EDM display
//                          tree, {base}/files/<path>, {base}/config/colors.list.
//                          Default '/displays/v1/edm' (same origin).
//   VITE_EDM_API_KEY       X-API-Key for that endpoint. Default: the Canopy
//                          key when the endpoint is Canopy's (under
//                          VITE_CANOPY_BASE_URL, or same-origin when that is
//                          unset), else none.
//   VITE_SCREEN_POLICY     'magpie' | 'none' — where the site's choice of
//                          screen variant comes from (policy.ts). Default
//                          'magpie' in hare mode, 'none' in mock mode.
//   VITE_SCREEN_POLICY_SLUG  magpie slug of the policy config (default: find
//                          it by name)

import { DEFAULT_RENDER_MODE, parseRenderMode } from '@slaclab/canopy-screen-runtime';
import type { RenderMode } from '@slaclab/canopy-screen-runtime';

export interface ViewerConfig {
  screensBaseUrl: string;
  pvMode: 'mock' | 'hare';
  canopyBaseUrl: string;
  canopyApiKey: string | undefined;
  renderMode: RenderMode;
  edmBaseUrl: string;
  edmApiKey: string | undefined;
  screenPolicy: 'magpie' | 'none';
  screenPolicySlug: string | undefined;
}

/** Is the display endpoint Canopy's own (so the Canopy key may go to it)? */
function isCanopyEndpoint(edmBaseUrl: string, canopyBaseUrl: string): boolean {
  if (!canopyBaseUrl) return edmBaseUrl.startsWith('/') && !edmBaseUrl.startsWith('//');
  return edmBaseUrl === canopyBaseUrl || edmBaseUrl.startsWith(`${canopyBaseUrl}/`);
}

export function readConfig(
  env: Record<string, string | undefined> = import.meta.env
): ViewerConfig {
  const pvMode = env.VITE_PV_MODE === 'hare' ? 'hare' : 'mock';
  const canopyBaseUrl = (env.VITE_CANOPY_BASE_URL ?? '').replace(/\/+$/, '');
  const canopyApiKey = env.VITE_CANOPY_API_KEY || undefined;
  const edmBaseUrl = (env.VITE_EDM_BASE_URL || '/displays/v1/edm').replace(/\/+$/, '');
  const policy = env.VITE_SCREEN_POLICY;
  return {
    screensBaseUrl: (env.VITE_SCREENS_BASE_URL ?? '').replace(/\/+$/, ''),
    pvMode,
    canopyBaseUrl,
    canopyApiKey,
    renderMode: parseRenderMode(env.VITE_RENDER_MODE) ?? DEFAULT_RENDER_MODE,
    edmBaseUrl,
    edmApiKey:
      env.VITE_EDM_API_KEY ||
      (isCanopyEndpoint(edmBaseUrl, canopyBaseUrl) ? canopyApiKey : undefined),
    screenPolicy:
      policy === 'magpie' || policy === 'none' ? policy : pvMode === 'hare' ? 'magpie' : 'none',
    screenPolicySlug: env.VITE_SCREEN_POLICY_SLUG || undefined,
  };
}
