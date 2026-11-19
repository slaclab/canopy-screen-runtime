// Route table. main.tsx wraps this in BrowserRouter + ServicesContext;
// tests use MemoryRouter and mock services.

import { Route, Routes } from 'react-router-dom';
import type { RenderMode } from '@slaclab/canopy-screen-runtime';
import { BrowsePage } from './pages/BrowsePage.js';
import { ScreenPage } from './pages/ScreenPage.js';
import { ErrorPanel } from './ErrorPanel.js';

export function App({
  screensBaseUrl,
  defaultRenderMode,
}: {
  screensBaseUrl: string;
  /** VITE_RENDER_MODE; a screen URL's ?render= overrides it. Default 'edm'. */
  defaultRenderMode?: RenderMode;
}) {
  return (
    <Routes>
      <Route path="/" element={<BrowsePage screensBaseUrl={screensBaseUrl} />} />
      {/* splat, not :id, so slashed ids like "CBXFEL/Landing" match */}
      <Route
        path="/s/:category/*"
        element={
          <ScreenPage screensBaseUrl={screensBaseUrl} defaultRenderMode={defaultRenderMode} />
        }
      />
      <Route path="*" element={<ErrorPanel title="Page not found" />} />
    </Routes>
  );
}
