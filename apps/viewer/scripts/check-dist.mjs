#!/usr/bin/env node
// Build-output guard: the viewer must be fully self-hosted. Canopy serves it
// on networks without internet access, so no file in dist/ may point at an
// external font CDN (IBM's s81c.com, which the precompiled Carbon CSS uses,
// or Google Fonts). Run after `vite build`; exits non-zero on any hit.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const FORBIDDEN = ['s81c.com', 'fonts.googleapis', 'fonts.gstatic'];

const distDir = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else yield path;
  }
}

let files;
try {
  files = [...walk(distDir)];
} catch (err) {
  console.error(`check-dist: cannot read ${distDir}: ${err.message}`);
  process.exit(2);
}
if (files.length === 0) {
  console.error(`check-dist: ${distDir} is empty; run the build first`);
  process.exit(2);
}

const hits = [];
for (const file of files) {
  // latin1 keeps binary files (fonts, images) scannable byte-for-byte.
  const text = readFileSync(file, 'latin1');
  for (const needle of FORBIDDEN) {
    if (text.includes(needle)) hits.push(`${relative(distDir, file)}: ${needle}`);
  }
}

if (hits.length > 0) {
  console.error('check-dist: external font references found in the build output:');
  for (const hit of hits) console.error(`  ${hit}`);
  process.exit(1);
}
console.log(`check-dist: ${files.length} files clean`);
