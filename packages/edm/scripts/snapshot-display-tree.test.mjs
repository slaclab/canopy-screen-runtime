// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { searchDirsUnderRoot, snapshotDisplayTree } from './snapshot-display-tree.mjs';

const dirs = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

/** A tree under <tmp>/displays with config beside it and a file outside it. */
function makeTree() {
  const tmp = mkdtempSync(path.join(tmpdir(), 'edm-snapshot-'));
  dirs.push(tmp);
  const root = path.join(tmp, 'displays');
  const put = (rel, text = `# ${rel}\n`) => {
    const p = path.join(root, rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, text);
  };
  for (const rel of ['top.edl', 'misc/a.edl', 'misc/IMG.GIF', 'misc/notes.txt', 'CVS/Entries.edl']) {
    put(rel);
  }
  put('Archive/old.edl');
  put('.hidden.edl');
  mkdirSync(path.join(tmp, 'outside'));
  writeFileSync(path.join(tmp, 'outside', 'secret.edl'), '# secret\n');
  symlinkSync(path.join(root, 'misc', 'a.edl'), path.join(root, 'inside-link.edl'));
  symlinkSync(path.join(tmp, 'outside', 'secret.edl'), path.join(root, 'escape.edl'));
  symlinkSync(path.join(root, 'nowhere.edl'), path.join(root, 'broken.edl'));
  symlinkSync(path.join(root, 'misc'), path.join(root, 'misc-link'));
  symlinkSync(root, path.join(root, 'misc', 'loop')); // back to the root
  const config = path.join(tmp, 'config');
  mkdirSync(config);
  writeFileSync(path.join(config, 'colors.list'), '4 0 0\n');
  writeFileSync(path.join(config, 'calc.list'), 'calc\n');
  return { tmp, root, config, out: path.join(tmp, 'out') };
}

describe('snapshotDisplayTree', () => {
  it('copies served files under their own paths, resolving links inside the root', () => {
    const { root, config, out } = makeTree();
    const { files, dropped } = snapshotDisplayTree({
      root,
      out,
      configDir: config,
      searchDirs: ['', 'misc'],
      rootAliases: ['/path/to/edm/displays'],
    });
    expect(files).toEqual([
      'inside-link.edl',
      'misc-link/IMG.GIF',
      'misc-link/a.edl',
      'misc/IMG.GIF',
      'misc/a.edl',
      'top.edl',
    ]);
    expect(dropped.sort()).toEqual(['broken.edl', 'escape.edl']);
    expect(readFileSync(path.join(out, 'inside-link.edl'), 'utf8')).toBe('# misc/a.edl\n');
    expect(existsSync(path.join(out, 'escape.edl'))).toBe(false);
    expect(existsSync(path.join(out, 'CVS'))).toBe(false);
    expect(readFileSync(path.join(out, 'config', 'colors.list'), 'utf8')).toBe('4 0 0\n');
    expect(existsSync(path.join(out, 'config', 'fonts.list'))).toBe(false);
    const index = JSON.parse(readFileSync(path.join(out, 'index.json'), 'utf8'));
    expect(index).toMatchObject({
      version: 1,
      files,
      searchDirs: ['', 'misc'],
      rootAliases: ['/path/to/edm/displays'],
    });
  });

  it('writes only the index and config with indexOnly; honours --exclude', () => {
    const { root, config, out } = makeTree();
    const { files } = snapshotDisplayTree({ root, out, configDir: config, indexOnly: true, exclude: [] });
    expect(files).toContain('CVS/Entries.edl');
    expect(files).toContain('Archive/old.edl');
    expect(files).not.toContain('.hidden.edl');
    expect(existsSync(path.join(out, 'top.edl'))).toBe(false);
    expect(existsSync(path.join(out, 'index.json'))).toBe(true);
    expect(existsSync(path.join(out, 'config', 'calc.list'))).toBe(true);
  });
});

describe('searchDirsUnderRoot', () => {
  it('keeps directories under the root, maps aliases, refuses the rest', () => {
    const alias = '/path/to/edm/displays';
    expect(searchDirsUnderRoot(['', '.', 'misc/', `${alias}/cud`, alias], [alias])).toEqual([
      '',
      '',
      'misc',
      'cud',
      '',
    ]);
    expect(() => searchDirsUnderRoot(['../x'])).toThrow();
    expect(() => searchDirsUnderRoot(['/opt/other'])).toThrow();
  });
});
