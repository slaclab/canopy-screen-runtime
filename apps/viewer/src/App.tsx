// Route table. main.tsx wraps this in BrowserRouter + ServicesContext;
// tests use MemoryRouter and mock services.

import { Route, Routes } from 'react-router-dom';
import type { RenderMode } from '@slaclab/canopy-screen-runtime';
import { BrowsePage } from './pages/BrowsePage.js';
import { ScreenPage } from './pages/ScreenPage.js';
import { EdlPage } from './pages/EdlPage.js';
import { ErrorPanel } from './ErrorPanel.js';

export function App({
  screensBaseUrl,
  defaultRenderMode,
  edmBaseUrl = '/displays/v1/edm',
  edmApiKey,
}: {
  screensBaseUrl: string;
  /** VITE_RENDER_MODE; a screen URL's ?render= overrides it. Default 'edm'. */
  defaultRenderMode?: RenderMode;
  /** VITE_EDM_BASE_URL: the display-file endpoint behind /edl/<path>. */
  edmBaseUrl?: string;
  /** VITE_EDM_API_KEY: sent as X-API-Key to that endpoint. */
  edmApiKey?: string;
}) {
  return (
    <Routes>
      <Route path="/" element={<BrowsePage screensBaseUrl={screensBaseUrl} />} />
      {/* splat, not :id, so slashed ids like "CBXFEL/Landing" match */}
      <Route
        path="/s/:category/*"
        element={
          <ScreenPage
            screensBaseUrl={screensBaseUrl}
            defaultRenderMode={defaultRenderMode}
            edmBaseUrl={edmBaseUrl}
            edmApiKey={edmApiKey}
          />
        }
      />
      {/* legacy EDM screens rendered directly from their .edl file */}
      <Route path="/edl/*" element={<EdlPage edmBaseUrl={edmBaseUrl} edmApiKey={edmApiKey} />} />
      <Route path="*" element={<ErrorPanel title="Page not found" />} />
    </Routes>
  );
}
