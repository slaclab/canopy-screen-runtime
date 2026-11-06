import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { RenderModeContext, registerBuiltinWidgets } from '@slaclab/canopy-screen-widgets';
import { applyHostSheetFallback } from '@slaclab/canopy-shell';
import './index.scss';
import '@slaclab/canopy-shell/styles.css';
import '@slaclab/canopy-shell/host-contract.css';
import '@slaclab/canopy-screen-widgets/styles.css';
import './index.css';
import { App } from './App.js';
import { routerBasename, screensBaseUrl } from './api.js';
import { canopyDefaultFlat } from '@slaclab/canopy-screen-ir';
import { ColorSchemeContext } from './colorSchemeContext.js';
import { loadConfig } from './config.js';
import { createServices, fixtureKeyFromSearch, loadFixture, ServicesContext } from './services.js';
import { applyHostEmbeddedClass } from './workspace/host/hostEmbed.js';

registerBuiltinWidgets();

// Runtime config (config.json next to the app) must be in hand before the
// services are composed, so rendering waits for it.
const config = await loadConfig();
// Parsed once here: the one object every screen renders with (stable identity).
const colorScheme = config.colorScheme ?? canopyDefaultFlat;
// Canopy mounts the viewer under an arbitrary path prefix; document.baseURI
// is the mount point for routing, content and the Hare/Formula Engine endpoints alike.
const base = new URL(document.baseURI);
// Fixture mode (`?_canopyPv=fixture&_canopyFixture=<key>`) is latched from
// the first URL: the snapshot must be in hand before the services exist.
const fixtureKey = fixtureKeyFromSearch(window.location.search);
const fixture = fixtureKey === null ? undefined : await loadFixture(fixtureKey, base);
const services = createServices(config, base, fixture);

// A host page that marks the document for its own tokens but whose marked
// stylesheet is missing or empty would leave those tokens undefined: drop the
// marker before the first paint so the app renders with its standalone look.
applyHostSheetFallback();
// Inside the hub's frame (`?embedded=true` and a parent window), latched for
// the page's life before any URL write can drop the flag; body.embedded is
// what the embedded chrome styles key on.
applyHostEmbeddedClass();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ServicesContext.Provider value={services}>
      <ColorSchemeContext.Provider value={colorScheme}>
        {/* config.json's renderMode: every screen's default, ?render= overrides it per page. */}
        <RenderModeContext.Provider value={config.renderMode}>
          <BrowserRouter basename={routerBasename(base.href)}>
            <App
              screensBaseUrl={screensBaseUrl(config.screensPath, base.href)}
              themes={config.themes}
              config={config}
            />
          </BrowserRouter>
        </RenderModeContext.Provider>
      </ColorSchemeContext.Provider>
    </ServicesContext.Provider>
  </StrictMode>
);
