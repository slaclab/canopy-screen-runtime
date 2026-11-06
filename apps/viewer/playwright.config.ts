// Browser tests for the built viewer, served under a path prefix by
// e2e/server.mjs (a mirror of canopy_mcp's static routes). Run after
// `pnpm build`: the server serves dist/ as-is and never builds.
//
// Specs are named *.e2e.ts so vitest's default include (*.test.* / *.spec.*)
// never collects them.

import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.E2E_PORT ?? 4179);
const origin = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './e2e',
  testMatch: /.*\.e2e\.ts$/,
  // Traces and failure context; ignored by e2e/.gitignore.
  outputDir: './e2e/.results',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'line' : 'list',
  use: {
    baseURL: origin,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    // The host-stylesheet mechanics and contract specs also run on Gecko.
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
      testMatch: /host-(mechanics|contract)\.e2e\.ts$/,
    },
  ],
  webServer: {
    command: 'node e2e/server.mjs',
    url: `${origin}/x/y/health`,
    env: { E2E_PORT: String(port), E2E_PREFIX: '/x/y' },
    reuseExistingServer: !process.env.CI,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
