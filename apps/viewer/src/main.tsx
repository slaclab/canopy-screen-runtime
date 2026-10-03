import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { registerBuiltinWidgets } from '@slaclab/canopy-screen-widgets';
import { registerEdmBuiltins } from '@slaclab/canopy-edm';
import '@carbon/styles/css/styles.css';
import '@slaclab/canopy-shell/styles.css';
import '@slaclab/canopy-screen-widgets/styles.css';
import '@slaclab/canopy-edm/styles.css';
import './index.css';
import { App } from './App.js';
import { readConfig } from './config.js';
import { createServices, ServicesContext } from './services.js';

registerBuiltinWidgets();
registerEdmBuiltins();

const config = readConfig();
const services = createServices(config);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ServicesContext.Provider value={services}>
      <BrowserRouter>
        <App
          screensBaseUrl={config.screensBaseUrl}
          defaultRenderMode={config.renderMode}
          edmBaseUrl={config.edmBaseUrl}
        />
      </BrowserRouter>
    </ServicesContext.Provider>
  </StrictMode>
);
