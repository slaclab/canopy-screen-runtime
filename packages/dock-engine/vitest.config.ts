import { defineConfig } from 'vitest/config';

// The engine is pure: its tests run in plain Node.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
