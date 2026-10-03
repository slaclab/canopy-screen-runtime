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
  edmBaseUrl = '/displays/edm',
}: {
  screensBaseUrl: string;
  /** VITE_RENDER_MODE; a screen URL's ?render= overrides it. Default 'edm'. */
  defaultRenderMode?: RenderMode;
  /** VITE_EDM_BASE_URL: the static EDM display tree behind /edl/<path>. */
  edmBaseUrl?: string;
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
          />
        }
      />
      {/* legacy EDM screens rendered directly from their .edl file */}
      <Route path="/edl/*" element={<EdlPage edmBaseUrl={edmBaseUrl} />} />
      <Route path="*" element={<ErrorPanel title="Page not found" />} />
    </Routes>
  );
}
