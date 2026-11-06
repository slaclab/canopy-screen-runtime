// @vitest-environment node
// The committed dist/ files: as fresh as the sources, replaying the whole case
// set, exporting exactly what src/index.ts exports, and standing alone (no
// imports, no absolute paths, declarations that type-check by themselves).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CASE_KINDS, CASES_DIR, loadCases, runCase } from '../dist/cases.mjs';
import * as engine from '../dist/dock-engine.mjs';
import * as source from './index.js';

const path = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));

const PKG = path('../');
const REPO = path('../../../');
const DIST = path('../dist/');
const CASES = path('../cases/');
const TSC = path('../../../node_modules/typescript/bin/tsc');

/** Every path a bundle must never name, with and without the trailing separator. */
const MACHINE_PATHS = [PKG, REPO].flatMap((dir) => [dir, dir.replace(/[\\/]$/, '')]);

/** The import specifiers of an ES module's static import statements. */
function importSpecifiers(code: string): string[] {
  return [...code.matchAll(/^\s*import\s(?:[^'";]*?\sfrom\s*)?['"]([^'"]+)['"]/gm)].map(
    (m) => m[1] as string
  );
}

describe('dist/', () => {
  it('is what scripts/build.mjs builds from src/ today', () => {
    // Throws, naming the stale files on stderr, when any is stale.
    execFileSync(process.execPath, [join(PKG, 'scripts/build.mjs'), '--check'], {
      cwd: PKG,
      encoding: 'utf8',
      stdio: 'pipe',
    });
  });
});

describe.each(CASE_KINDS.map((kind) => [kind]))(
  '%s cases replay against dist/dock-engine.mjs',
  (kind) => {
    const loaded = loadCases(kind);

    it('has cases', () => {
      expect(loaded.length).toBeGreaterThan(0);
    });

    it.each(loaded.map((c) => [c.file, c]))('%s', (_file, c) => {
      expect(runCase(kind, c.data, engine)).toEqual([]);
    });
  }
);

describe('dist/dock-engine.mjs', () => {
  const js = readFileSync(join(DIST, 'dock-engine.mjs'), 'utf8');

  it('exports exactly what src/index.ts exports', () => {
    expect(Object.keys(engine).sort()).toEqual(Object.keys(source).sort());
  });

  it('imports nothing and names no machine path', () => {
    expect(js).not.toMatch(/^\s*import\s/m);
    expect(js).not.toMatch(/\brequire\(/);
    for (const dir of MACHINE_PATHS) expect(js).not.toContain(dir);
  });

  it('says it is generated', () => {
    const lines = js.split('\n');
    expect(lines[0]).toMatch(/^\/\/ @slaclab\/canopy-dock-engine: /);
    expect(lines[1]).toBe(
      '// Generated from packages/dock-engine/src/ by packages/dock-engine/scripts/build.mjs.'
    );
  });
});

describe('dist/dock-engine.d.mts', () => {
  const dts = readFileSync(join(DIST, 'dock-engine.d.mts'), 'utf8');

  it('declares exactly the runtime exports', () => {
    const declared = [...dts.matchAll(/^export declare (?:function|const) (\w+)/gm)].map(
      (m) => m[1]
    );
    expect([...new Set(declared)].sort()).toEqual(Object.keys(engine).sort());
  });

  it('stands alone: no imports, and the declarations type-check by themselves', () => {
    expect(dts).not.toMatch(/^\s*import\s/m);
    // Throws, with tsc's diagnostics on stdout, when the check fails.
    execFileSync(process.execPath, [TSC, '--noEmit', '-p', join(PKG, 'tsconfig.dts.json')], {
      cwd: REPO,
      encoding: 'utf8',
      stdio: 'pipe',
    });
  });
});

describe('dist/cases.mjs', () => {
  const js = readFileSync(join(DIST, 'cases.mjs'), 'utf8');

  it('imports exactly the four allowed specifiers', () => {
    expect([...new Set(importSpecifiers(js))].sort()).toEqual([
      './dock-engine.mjs',
      'node:fs',
      'node:module',
      'node:path',
    ]);
  });

  it('names no machine path', () => {
    for (const dir of MACHINE_PATHS) expect(js).not.toContain(dir);
  });

  it('resolves CASES_DIR to the package cases directory', () => {
    expect(CASES_DIR).toBe(CASES.replace(/[\\/]$/, ''));
  });

  describe.each(CASE_KINDS.map((kind) => [kind]))('%s', (kind) => {
    const loaded = loadCases(kind);

    it('replays every case clean through runCase', () => {
      const failures = loaded.flatMap((c) =>
        runCase(kind, c.data, engine).map((f) => `${c.file}: ${f}`)
      );
      expect(failures).toEqual([]);
    });
  });
});
