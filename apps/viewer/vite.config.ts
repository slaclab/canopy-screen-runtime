import { fileURLToPath } from 'node:url';
import { defaultClientConditions } from 'vite';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  resolve: {
    // Sibling workspace packages are read from their source (the `canopy-source`
    // export condition). The bundle and the dev server keep Vite's client
    // conditions behind it; under Vitest (mode `test`) Vitest appends its own
    // node conditions instead, so the tests never resolve a browser build.
    conditions: mode === 'test' ? ['canopy-source'] : ['canopy-source', ...defaultClientConditions],
    // Force react and @carbon/react to this app's single copy; the @slaclab SDK
    // packages otherwise pull their own, bundling a second React/Carbon.
    dedupe: ['react', 'react-dom'],
    alias: {
      '@carbon/react': fileURLToPath(new URL('./node_modules/@carbon/react', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
  },
}));
