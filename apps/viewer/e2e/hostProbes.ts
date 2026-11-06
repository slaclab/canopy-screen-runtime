// The shared host-probe data, owned by the shell package
// (@slaclab/canopy-shell/fixtures/host/*): the probe table hostProbes.json,
// the synthetic host values host.json, and the runner.mjs every spec asserts
// through. This module holds no assertion logic and no setup bodies.
//
// JSON is read with createRequire + readFileSync: under Node 26 a bare JSON
// import throws ERR_IMPORT_ATTRIBUTE_MISSING in this ESM package.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type {
  HostFixture,
  HostProbes,
  ProbeRow,
} from '@slaclab/canopy-shell/fixtures/host/runner.mjs';

const require = createRequire(import.meta.url);
const readJson = <T>(file: string): T =>
  JSON.parse(
    readFileSync(require.resolve(`@slaclab/canopy-shell/fixtures/host/${file}`), 'utf8')
  ) as T;

export const hostProbes = readJson<HostProbes>('hostProbes.json');
export const hostFixture = readJson<HostFixture>('host.json');
/** The app a row runs in: its own `app`, else `defaults.app`. */
const defaultApp = (hostProbes.defaults as { app?: string }).app;
/**
 * The viewer's probe rows, in table order: every consumer (host-smoke,
 * host-mechanics) iterates this list, so a row the shell adds for
 * the viewer is probed by both once the SDK pin carries it.
 */
export const viewerRows: ProbeRow[] = hostProbes.rows.filter(
  (row) => (row.app ?? defaultApp) === 'viewer'
);

export * from '@slaclab/canopy-shell/fixtures/host/runner.mjs';
