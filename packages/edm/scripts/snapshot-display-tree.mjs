#!/usr/bin/env node
// Snapshot a legacy display tree for staticDisplaySource (src/loader/static.ts): the frozen
// tree as plain static files, an index of what it serves, and the site config lists.
//
//   node scripts/snapshot-display-tree.mjs <root> <out>
//        [--search-paths FILE]       {"dirs": [...]}: the EDMDATAFILES search path, under <root>
//        [--root-alias PATH]...      absolute paths that mean <root> in display files
//        [--config DIR]              where colors.list, fonts.list and calc.list live
//        [--exclude NAME[,NAME...]]  entries skipped by name anywhere (default: CVS,Archive)
//        [--index-only]              write index.json and config/ but copy no display files
//                                    (serve <root> itself at the same base)
//
// Writes <out>/index.json — { version, generatedAt, rootAliases, searchDirs, files } with files
// the sorted paths under <root> of every served file — <out>/config/<name>.list for the lists
// present in --config, and (without --index-only) each served file at <out>/<path>.
//
// Served: .edl, .png, .gif, .jpg, .jpeg, .xpm, any case. Skipped: entries named in --exclude and
// anything whose name starts with "." (CVS metadata, editor files). Symlinks are resolved here:
// a link whose target is inside <root> is served under the link's own path, copied as the
// target's contents; a link that leaves <root>, or is broken, is dropped and reported. A
// directory reached again through a link on its own walk is not walked twice (no loops).

import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const SERVED_SUFFIXES = ['.edl', '.png', '.gif', '.jpg', '.jpeg', '.xpm'];
export const DEFAULT_EXCLUDE = ['CVS', 'Archive'];
const CONFIG_LISTS = ['colors.list', 'fonts.list', 'calc.list'];

const within = (base, p) => p === base || p.startsWith(base + path.sep);
const served = (name) => SERVED_SUFFIXES.includes(path.extname(name).toLowerCase());

/** Search directories as paths under the root ("" for the root); throws on one outside it. */
export function searchDirsUnderRoot(dirs, rootAliases = []) {
  const aliases = rootAliases.map((a) => `${a.replace(/\/+$/, '')}/`);
  return dirs.map((dir) => {
    let d = `${dir.replace(/\/+$/, '')}/`;
    const alias = aliases.find((a) => d.startsWith(a));
    if (alias) d = d.slice(alias.length);
    const normal = path.posix.normalize(d || '.').replace(/\/+$/, '');
    if (normal === '.' || normal === '') return '';
    if (normal.startsWith('/') || normal === '..' || normal.startsWith('../')) {
      throw new Error(`search directory "${dir}" is not inside the root`);
    }
    return normal;
  });
}

/**
 * Snapshot `root` into `out`. Returns { files, dropped, bytes }: the served paths, the links
 * dropped, and the bytes of served files.
 */
export function snapshotDisplayTree({
  root,
  out,
  searchDirs = [''],
  rootAliases = [],
  configDir,
  exclude = DEFAULT_EXCLUDE,
  indexOnly = false,
}) {
  const realRoot = realpathSync(root);
  const skip = new Set(exclude);
  const found = [];
  const dropped = [];

  const walk = (realDir, rel, onStack) => {
    const entries = readdirSync(realDir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    );
    for (const entry of entries) {
      if (entry.name.startsWith('.') || skip.has(entry.name)) continue;
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      let real = path.join(realDir, entry.name);
      if (entry.isSymbolicLink()) {
        try {
          real = realpathSync(real);
        } catch {
          dropped.push(relPath); // broken
          continue;
        }
        if (!within(realRoot, real)) {
          dropped.push(relPath); // leaves the root
          continue;
        }
      }
      const st = statSync(real);
      if (st.isDirectory()) {
        if (onStack.has(real)) continue;
        walk(real, relPath, new Set([...onStack, real]));
      } else if (st.isFile() && served(entry.name)) {
        found.push({ rel: relPath, real, size: st.size });
      }
    }
  };
  walk(realRoot, '', new Set([realRoot]));
  found.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));

  mkdirSync(out, { recursive: true });
  if (!indexOnly) {
    for (const { rel, real } of found) {
      const target = path.join(out, ...rel.split('/'));
      mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(real, target);
    }
  }
  if (configDir) {
    mkdirSync(path.join(out, 'config'), { recursive: true });
    for (const name of CONFIG_LISTS) {
      const source = path.join(configDir, name);
      let isFile = false;
      try {
        isFile = statSync(source).isFile();
      } catch {
        // absent: the source treats a missing list as none (calc.list) or an error (colors.list)
      }
      if (isFile) copyFileSync(source, path.join(out, 'config', name));
    }
  }
  const files = found.map((f) => f.rel);
  const index = {
    version: 1,
    generatedAt: new Date().toISOString(),
    rootAliases,
    searchDirs: searchDirsUnderRoot(searchDirs, rootAliases),
    files,
  };
  writeFileSync(path.join(out, 'index.json'), JSON.stringify(index) + '\n');
  return { files, dropped, bytes: found.reduce((n, f) => n + f.size, 0) };
}

function main(argv) {
  const positional = [];
  const opts = { rootAliases: [], exclude: DEFAULT_EXCLUDE, indexOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--search-paths') opts.searchDirs = JSON.parse(readFileSync(argv[++i], 'utf8')).dirs;
    else if (a === '--root-alias') opts.rootAliases.push(argv[++i]);
    else if (a === '--config') opts.configDir = argv[++i];
    else if (a === '--exclude') opts.exclude = argv[++i].split(',').filter(Boolean);
    else if (a === '--index-only') opts.indexOnly = true;
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else positional.push(a);
  }
  if (positional.length !== 2) {
    throw new Error('usage: snapshot-display-tree.mjs <root> <out> [options] (see the header)');
  }
  const [root, out] = positional;
  const { files, dropped, bytes } = snapshotDisplayTree({ root, out, ...opts });
  console.log(
    `${out}: ${files.length} files (${(bytes / 1e6).toFixed(1)} MB${opts.indexOnly ? ', not copied' : ''})` +
      `${dropped.length ? `; dropped ${dropped.length} link(s): ${dropped.join(', ')}` : ''}`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
