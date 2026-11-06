// A real canopy_mcp for the live collections smoke (collections-live.e2e.ts).
//
// Where server.mjs is a stub mirror of canopy_mcp's routes, this launcher runs
// the real server from a canopy checkout ($CANOPY_SRC): `python -m canopy_mcp
// --http` on a free loopback port, serving this package's built dist/ at the
// root prefix. Its stores are throwaway:
//
//   CANOPY_FACILITY_COLLECTIONS_DIR  a temp copy of canopy's fixture
//                                    tests/canopy_mcp/fixtures/collections/valid/facility/
//   CANOPY_COLLECTIONS_DIR           an empty temp dir (personal files + .state.json)
//   CANOPY_DRAFTS_DIR                a temp dir, empty unless `drafts` names files
//   CANOPY_LIBRARY_DIR               canopy's fixture library (read-only, served as is)
//   CANOPY_TRACE_DIST                e2e/fixtures/trace-stub (so tool members open)
//   CANOPY_PV_MODE                   mock (no backend)
//
// Every other CANOPY_* variable of the calling environment is dropped, so a
// developer's own deployment settings (secret files, host sheets) cannot leak
// into the run. The interpreter is $CANOPY_PYTHON when set, else the
// checkout's .venv, else `uv run --project $CANOPY_SRC --extra mcp`.
//
// One instance is one user: canopy_mcp keeps a single state file, so a spec
// using it runs serially and lets state carry from test to test.

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const VIEWER_DIST = resolve(HERE, '..', 'dist');
const TRACE_STUB = resolve(HERE, 'fixtures', 'trace-stub');
const FIXTURES = 'tests/canopy_mcp/fixtures/collections';

export interface LiveCanopy {
  /** `http://127.0.0.1:<port>`; the viewer is at `${origin}/embed/`. */
  origin: string;
  /** The personal collections dir (personal `<id>.json` files and `.state.json`). */
  collectionsDir: string;
  /** The temp facility collections dir. */
  facilityDir: string;
  /** The temp drafts dir (drafts at `screens/<id>.screen.json`). */
  draftsDir: string;
  /**
   * Stops the server (SIGTERM) and starts it again on the same port and the
   * same stores; resolves once /health answers. `downMs` is how long it stays
   * down between the two.
   */
  restart(downMs?: number): Promise<void>;
  /** Stops the server and removes the temp dirs. */
  stop(): Promise<void>;
}

export interface LiveCanopyOptions {
  /** Extra CANOPY_* settings, e.g. `{ CANOPY_WORKSPACE: '1' }`. */
  env?: Record<string, string>;
  /** Screen files copied into the drafts dir before start, as `<id>.screen.json`. */
  drafts?: string[];
}

/** Why a live canopy_mcp cannot be started from `canopySrc`, or `null` when it can. */
export function missingCanopy(canopySrc: string | undefined): string | null {
  if (!canopySrc) return 'CANOPY_SRC is not set';
  for (const p of [
    join(canopySrc, 'src', 'canopy_mcp', '__main__.py'),
    join(canopySrc, FIXTURES, 'valid', 'facility'),
    join(canopySrc, FIXTURES, 'library', 'screens'),
  ]) {
    if (!existsSync(p)) return `CANOPY_SRC has no ${p}`;
  }
  if (!existsSync(join(VIEWER_DIST, 'index.html'))) {
    return `no built viewer at ${VIEWER_DIST} (run pnpm build)`;
  }
  return null;
}

function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const server = createServer();
    server.unref();
    server.on('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => ok(port));
    });
  });
}

function command(canopySrc: string, args: string[]): [string, string[]] {
  const explicit = process.env.CANOPY_PYTHON;
  if (explicit) return [explicit, args];
  const venv = join(canopySrc, '.venv', 'bin', 'python');
  if (existsSync(venv)) return [venv, args];
  return ['uv', ['run', '--project', canopySrc, '--extra', 'mcp', 'python', ...args]];
}

async function waitHealthy(origin: string, child: ChildProcess, log: () => string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`canopy_mcp exited with ${child.exitCode}:\n${log()}`);
    }
    try {
      const response = await fetch(`${origin}/health`);
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`canopy_mcp did not answer ${origin}/health within 60 s:\n${log()}`);
}

/** Starts canopy_mcp from `canopySrc` on fresh temp stores; resolves once /health answers. */
export async function startLiveCanopy(
  canopySrc: string,
  options: LiveCanopyOptions = {}
): Promise<LiveCanopy> {
  const root = await mkdtemp(join(tmpdir(), 'canopy-live-'));
  const facilityDir = join(root, 'facility');
  const collectionsDir = join(root, 'collections');
  const draftsDir = join(root, 'drafts');
  await cp(join(canopySrc, FIXTURES, 'valid', 'facility'), facilityDir, { recursive: true });
  await mkdir(collectionsDir);
  await mkdir(join(draftsDir, 'screens'), { recursive: true });
  for (const file of options.drafts ?? []) {
    await cp(file, join(draftsDir, 'screens', basename(file)));
  }

  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('CANOPY_')) env[k] = v;
  }
  Object.assign(env, {
    CANOPY_VIEWER_DIST: VIEWER_DIST,
    CANOPY_TRACE_DIST: TRACE_STUB,
    CANOPY_LIBRARY_DIR: join(canopySrc, FIXTURES, 'library'),
    CANOPY_FACILITY_COLLECTIONS_DIR: facilityDir,
    CANOPY_COLLECTIONS_DIR: collectionsDir,
    CANOPY_DRAFTS_DIR: draftsDir,
    CANOPY_PV_MODE: 'mock',
    ...options.env,
  });
  const [cmd, args] = command(canopySrc, [
    '-m',
    'canopy_mcp',
    '--http',
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
  ]);
  let output = '';
  const keep = (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-8000);
  };
  let child: ChildProcess;
  const launch = async () => {
    child = spawn(cmd, args, { cwd: canopySrc, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    await waitHealthy(origin, child, () => output);
  };
  const halt = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((r) => child.once('exit', r));
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
      await exited;
      clearTimeout(timer);
    }
  };
  const stop = async () => {
    await halt();
    await rm(root, { recursive: true, force: true });
  };
  const restart = async (downMs = 0) => {
    await halt();
    if (downMs > 0) await new Promise((r) => setTimeout(r, downMs));
    await launch();
  };
  try {
    await launch();
  } catch (err) {
    await stop();
    throw err;
  }
  return { origin, collectionsDir, facilityDir, draftsDir, restart, stop };
}

/** The `*.json` file names in `dir` (dot files such as `.state.json` excluded). */
export async function jsonFiles(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((f) => f.endsWith('.json') && !f.startsWith('.')).sort();
}
