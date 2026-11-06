#!/usr/bin/env node
// Chrome literal gate: viewer chrome CSS takes its colors and fonts from the
// `--canopy-*` contract, so a bare hex color or a font literal is an error
// unless the line above it carries `canopy-allow-literal: <reason>` and
// chrome-literals.allow pins that exemption. Nothing is exempt silently.
//
//   node tooling/src/check-chrome-literals.mjs [file-or-glob ...]
//
// The default set is the viewer's CSS (apps/viewer/src/**) and the widget
// stylesheet (packages/widgets/styles.css).
//
// Without arguments the full default set is checked and the exemptions found
// must equal chrome-literals.allow in both directions. With arguments only
// those files are checked, and each of their exemptions must be covered.
//
// In the workspace CSS (apps/viewer/src/workspace/**) a `font-size` literal is
// an error too: the workspace type comes from `--canopy-text-*`.
import { existsSync, globSync, readFileSync, statSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** The closed reason vocabulary; any other reason is rejected. */
export const REASONS = [
  'document background',
  '@media print',
  'widget prop default',
  'Carbon danger pair',
];

// Everything is resolved from this file, never from the cwd: a developer may
// run it from anywhere.
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SRC = fileURLToPath(new URL('../../apps/viewer/src/', import.meta.url));
const WIDGETS = fileURLToPath(new URL('../../packages/widgets/styles.css', import.meta.url));
const ALLOW = fileURLToPath(new URL('../chrome-literals.allow', import.meta.url));
const WORKSPACE = fileURLToPath(new URL('../../apps/viewer/src/workspace/', import.meta.url));

const HEX = /#[0-9a-fA-F]{3,8}\b/;
const FONT = /(?:font(?:-family)?|fontFamily)\s*:([^;}]*)/g;
const MARKER = /canopy-allow-literal:\s*(.*?)\s*(?:\*\/)?\s*$/;
const FONT_SIZE = /font-size\s*:([^;}]*)/g;

/** The path every report line and allow entry uses: relative to the repo root. */
export function repoKey(file) {
  return relative(ROOT, resolve(file)).split(sep).join('/');
}

/** True when `file` is workspace CSS, where font-size literals are gated. */
export function gatesFontSize(file) {
  const path = resolve(file);
  return path.startsWith(WORKSPACE) && path.endsWith('.css');
}

/** Blank out comments, keeping every line break so line numbers survive. */
export function stripComments(text, { lineComments = false } = {}) {
  let out = text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ''));
  // `//` opens a comment in script sources only; in CSS it is part of a URL.
  if (lineComments) out = out.replace(/(^|[^:])\/\/.*$/gm, '$1');
  return out;
}

/** A font-size whose value is neither inherit nor a contract type variable. */
function isFontSizeLiteral(line) {
  for (const [, raw] of line.matchAll(FONT_SIZE)) {
    const value = raw.replace(/!important/, '').trim();
    if (value !== 'inherit' && !value.includes('var(--canopy-text-')) return true;
  }
  return false;
}

function isLiteral(line) {
  if (HEX.test(line)) return true;
  for (const [, raw] of line.matchAll(FONT)) {
    const value = raw
      .replace(/!important/, '')
      .replace(/['"`,]/g, '')
      .trim();
    if (value !== 'inherit' && !raw.includes('var(--canopy-font-')) return true;
  }
  return false;
}

/**
 * Scan one source text. `hits` are unmarked literals, `exempt` the literals
 * whose previous line holds a marker, `errors` markers with an unknown reason.
 * With `fontSize`, a font-size literal counts as a literal too.
 */
export function scan(text, options = {}) {
  const raw = text.split('\n');
  const code = stripComments(text, options).split('\n');
  const hits = [];
  const exempt = [];
  const errors = [];
  code.forEach((line, i) => {
    const literal = isLiteral(line) || (options.fontSize === true && isFontSizeLiteral(line));
    if (!literal) return;
    const marker = i > 0 ? MARKER.exec(raw[i - 1]) : null;
    if (!marker) hits.push({ line: i + 1, text: raw[i].trim() });
    else if (!REASONS.includes(marker[1]))
      errors.push({ line: i, text: `unknown reason '${marker[1]}'` });
    else exempt.push({ line: i + 1, reason: marker[1] });
  });
  return { hits, exempt, errors };
}

/** Parse chrome-literals.allow: `<repo-relative file>: <reason>: <count>` per line. */
export function parseAllow(text) {
  const entries = new Map();
  const errors = [];
  text.split('\n').forEach((line, i) => {
    if (line.trim() === '' || line.startsWith('#')) return;
    const where = `chrome-literals.allow:${i + 1}`;
    const m = /^(.+?): (.+): ([1-9]\d*)$/.exec(line);
    if (!m) return errors.push(`${where}: not '<file>: <reason>: <count>': ${line}`);
    const [, file, reason, count] = m;
    if (!REASONS.includes(reason)) return errors.push(`${where}: unknown reason '${reason}'`);
    const key = `${file}: ${reason}`;
    if (entries.has(key)) return errors.push(`${where}: duplicate entry ${key}`);
    entries.set(key, Number(count));
  });
  return { entries, errors };
}

function expand(argv) {
  const files = [];
  const errors = [];
  if (argv.length === 0) {
    files.push(...globSync('**/*.css', { cwd: SRC }).map((f) => resolve(SRC, f)), WIDGETS);
  }
  for (const arg of argv) {
    if (/[*?[\]{}]/.test(arg)) files.push(...globSync(arg).map((f) => resolve(f)));
    else files.push(resolve(arg));
  }
  const unique = [...new Set(files)].sort();
  for (const file of unique) {
    if (!existsSync(file) || !statSync(file).isFile())
      errors.push(`${repoKey(file)}: no such file`);
  }
  if (unique.length === 0) errors.push('no files to check: the file set is empty');
  return { files: unique, errors };
}

/**
 * Run the gate over `argv` (files or globs; empty = the full default set).
 * Returns the exit code with the stdout and stderr lines; `allowText` stands
 * in for chrome-literals.allow in the unit tests.
 */
export function run(argv, { allowText } = {}) {
  const err = [];
  const { files, errors: fileErrors } = expand(argv);
  err.push(...fileErrors);
  if (fileErrors.length > 0) return { code: 1, out: [], err };

  let allowSource = allowText;
  if (allowSource === undefined) {
    if (!existsSync(ALLOW)) return { code: 1, out: [], err: [`${repoKey(ALLOW)}: no such file`] };
    allowSource = readFileSync(ALLOW, 'utf8');
  }
  const allow = parseAllow(allowSource);
  err.push(...allow.errors);

  const exemptLines = [];
  const found = new Map();
  for (const file of files) {
    const key = repoKey(file);
    const result = scan(readFileSync(file, 'utf8'), {
      lineComments: !file.endsWith('.css'),
      fontSize: gatesFontSize(file),
    });
    for (const hit of result.hits) err.push(`${key}:${hit.line}: ${hit.text}`);
    for (const bad of result.errors) err.push(`${key}:${bad.line}: ${bad.text}`);
    for (const ex of result.exempt) {
      exemptLines.push(`${key}:${ex.line}: ${ex.reason}`);
      const group = `${key}: ${ex.reason}`;
      found.set(group, (found.get(group) ?? 0) + 1);
    }
  }

  // The full set must equal the allow file; named files need only be covered.
  const fullSet = argv.length === 0;
  for (const [group, count] of found) {
    const allowed = allow.entries.get(group);
    if (allowed === undefined) err.push(`${group}: ${count} exempt, not in chrome-literals.allow`);
    else if (fullSet ? count !== allowed : count > allowed)
      err.push(`${group}: ${count} exempt, chrome-literals.allow pins ${allowed}`);
  }
  if (fullSet) {
    for (const [group, allowed] of allow.entries) {
      if (!found.has(group))
        err.push(`${group}: chrome-literals.allow pins ${allowed}, no matching line found`);
    }
  }

  if (err.length > 0) return { code: 1, out: [], err };
  return { code: 0, out: [`${exemptLines.length} exempt`, ...exemptLines], err };
}

function main() {
  const { code, out, err } = run(process.argv.slice(2));
  if (code !== 0) {
    console.error('check-chrome-literals: unmarked or unpinned literals in chrome styles:');
    for (const line of err) console.error(`  ${line}`);
    process.exit(code);
  }
  for (const line of out) console.log(line);
}

// Importing this module (the unit test does) must not scan or exit.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
