#!/usr/bin/env node
// Checks the e2e fixture sets copied from canopy (see e2e/fixtures/SOURCES.md)
// against a canopy checkout: every file of a copy must exist in canopy and be
// byte-identical to it. Files canopy has and the copy does not are listed,
// but do not fail the check (a copy may leave some out).
//
//   CANOPY_SRC=<canopy checkout> node scripts/check-fixture-copies.mjs
//
// Without $CANOPY_SRC it says so and exits 0, so it can run anywhere.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const FIXTURES = fileURLToPath(new URL('../e2e/fixtures/', import.meta.url));

/** Each copied set: its directory here, and its source path in a canopy checkout. */
export const COPIES = [
  { copy: 'workspace', source: 'tests/canopy_mcp/fixtures/workspace' },
  { copy: 'collections', source: 'tests/canopy_mcp/fixtures/collections' },
  { copy: 'contracts', source: 'src/canopy/contracts' },
];

/** Every file under `root`, as sorted `/`-separated paths relative to it. */
function listFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else out.push(relative(root, path).split(sep).join('/'));
    }
  };
  walk(root);
  return out.sort();
}

const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

/**
 * Compare every copied set against `canopySrc`. Returns the exit code, the
 * failures (`err`) and the notes (`out`).
 */
export function check(canopySrc, { fixtures = FIXTURES, copies = COPIES } = {}) {
  const err = [];
  const out = [];
  for (const { copy, source } of copies) {
    const here = join(fixtures, copy);
    const there = join(canopySrc, source);
    if (!existsSync(there)) {
      err.push(`${copy}: no ${source} in ${canopySrc}`);
      continue;
    }
    const sourceFiles = new Set(listFiles(there));
    const copied = listFiles(here);
    let same = 0;
    for (const file of copied) {
      if (!sourceFiles.has(file)) err.push(`${copy}/${file}: not in canopy's ${source}`);
      else if (digest(join(here, file)) !== digest(join(there, file)))
        err.push(`${copy}/${file}: differs from canopy's ${source}/${file}`);
      else same += 1;
    }
    const copiedSet = new Set(copied);
    const notCopied = [...sourceFiles].filter((file) => !copiedSet.has(file));
    out.push(`${copy}: ${same} of ${copied.length} files identical to ${source}`);
    for (const file of notCopied) out.push(`${copy}/${file}: in canopy, not copied`);
  }
  return { code: err.length > 0 ? 1 : 0, out, err };
}

function main() {
  const canopySrc = process.env.CANOPY_SRC;
  if (!canopySrc) {
    console.log('check-fixture-copies: CANOPY_SRC is not set; nothing compared');
    return;
  }
  const { code, out, err } = check(canopySrc);
  for (const line of out) console.log(line);
  if (code !== 0) {
    console.error('check-fixture-copies: the copies differ from canopy:');
    for (const line of err) console.error(`  ${line}`);
    process.exit(code);
  }
}

// Importing this module must not compare or exit.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
