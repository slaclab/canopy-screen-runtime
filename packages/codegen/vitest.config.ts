import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Sibling workspace packages are read from their source (the `canopy-source`
    // export condition); Vitest appends its own node conditions after it.
    conditions: ['canopy-source'],
  },
  // The node test environment resolves through the SSR environment, which
  // takes its conditions from here rather than from the top-level resolve.
  ssr: {
    resolve: {
      conditions: ['canopy-source'],
    },
  },
  test: {
    environment: 'node',
  },
});
