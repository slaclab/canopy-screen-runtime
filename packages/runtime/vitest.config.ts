import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Sibling workspace packages are read from their source (the `canopy-source`
    // export condition); Vitest appends its own node conditions after it.
    conditions: ['canopy-source'],
    // One React for every module a test loads: react and react-dom resolve
    // from this package wherever they are imported.
    dedupe: ['react', 'react-dom'],
  },
  test: {
    environment: 'jsdom',
  },
});
