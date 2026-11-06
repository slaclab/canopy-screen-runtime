// The Playwright fixture for specs that opt in to collections. e2e/server.mjs
// keeps collections per e2e user, because every worker shares its one process
// (fullyParallel): this fixture gives each test its own user, sets the
// `canopy-e2e-user` cookie on the test's browser context, and resets that user
// through POST <prefix>/__collections-reset before the test runs.
//
//   import { expect, test } from './collectionsFixture';
//   test.use({ collectionsMode: 'default' }); // facility default: true kept
//
// `collectionsMode` is 'on' (config.json carries `collections`, facility
// collections without `default`) unless a spec picks 'default'. Specs that do
// not import this module are the 'default' user, whose config.json has no
// `collections` key, so their tree is unchanged.
//
// `collectionsApi` is the context's request client: it shares the context's
// cookies, so its calls see the same user as the page.

import { test as base, type APIRequestContext } from '@playwright/test';

export { expect } from '@playwright/test';

export const PREFIX = '/x/y/';
export const E2E_USER_COOKIE = 'canopy-e2e-user';
export const E2E_USER_HEADER = 'x-canopy-e2e-user';

export type CollectionsMode = 'on' | 'default';

/** An e2e user id unique to one test attempt, within server.mjs's /^[A-Za-z0-9_-]{1,64}$/. */
export function e2eUser(testId: string, workerIndex: number, retry: number): string {
  const safe = testId.replace(/[^A-Za-z0-9_-]/g, '_');
  return `w${workerIndex}-r${retry}-${safe}`.slice(0, 64);
}

type CollectionsFixtures = {
  collectionsMode: CollectionsMode;
  collectionsUser: string;
  collectionsApi: APIRequestContext;
};

export const test = base.extend<CollectionsFixtures>({
  collectionsMode: ['on', { option: true }],
  // eslint-disable-next-line no-empty-pattern
  collectionsUser: async ({}, provide, testInfo) => {
    await provide(e2eUser(testInfo.testId, testInfo.workerIndex, testInfo.retry));
  },
  context: async ({ context, baseURL, collectionsUser, collectionsMode }, provide) => {
    if (!baseURL) throw new Error('collectionsFixture needs use.baseURL');
    await context.addCookies([{ name: E2E_USER_COOKIE, value: collectionsUser, url: baseURL }]);
    const reset = await context.request.post(
      `${PREFIX}__collections-reset?mode=${collectionsMode}`
    );
    if (!reset.ok()) {
      throw new Error(`collections reset failed: ${reset.status()} ${await reset.text()}`);
    }
    await provide(context);
  },
  collectionsApi: async ({ context }, provide) => {
    await provide(context.request);
  },
});
