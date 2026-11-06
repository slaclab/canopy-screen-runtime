import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defaultClientConditions, type Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Ship the runtime's checked-in IR type table as dist/ir-map.json. Emitted as
// a bundle asset (not via publicDir) so it is always the copy the runtime's
// irMap test verified against the code.
function irMapAsset(): Plugin {
  const source = fileURLToPath(new URL('../../packages/runtime/ir-map.json', import.meta.url));
  return {
    name: 'canopy-ir-map',
    apply: 'build',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'ir-map.json',
        source: readFileSync(source, 'utf8'),
      });
    },
  };
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  // Relative asset URLs: the build is mounted under whatever path serves it.
  base: './',
  plugins: [react(), irMapAsset()],
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
    setupFiles: ['./src/test/setup.ts'],
  },
}));
