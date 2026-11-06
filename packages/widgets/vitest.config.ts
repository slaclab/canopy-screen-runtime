import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // One React for every module a test loads: react and react-dom resolve
    // from this package wherever they are imported.
    dedupe: ['react', 'react-dom'],
  },
  test: {
    environment: 'jsdom',
    // Node 25+ defines a global localStorage that is undefined without
    // --localstorage-file and shadows jsdom's; canopy-shell reads storage on
    // import. Turning Node's off leaves jsdom's in place.
    execArgv: ['--no-experimental-webstorage'],
  },
});
