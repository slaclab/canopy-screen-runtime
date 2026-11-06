// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseAllow, repoKey, run, scan, stripComments } from './check-chrome-literals.mjs';

const script = fileURLToPath(new URL('./check-chrome-literals.mjs', import.meta.url));
const fixture = (name: string) =>
  fileURLToPath(new URL(`./__fixtures__/chrome-literals/${name}`, import.meta.url));
const key = (name: string) => `tooling/src/__fixtures__/chrome-literals/${name}`;
const cli = (...args: string[]) =>
  spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

describe('scan', () => {
  it('reports a bare hex color and a font literal', () => {
    expect(scan('a {\n  color: #fff;\n  font: 12px Arial;\n}').hits.map((h) => h.line)).toEqual([
      2, 3,
    ]);
    expect(scan('a { border: 1px solid var(--cds-border, #8d8d8d); }').hits).toHaveLength(1);
    expect(scan("const s = { fontFamily: 'Arial' };").hits).toHaveLength(1);
  });

  it('with fontSize, reports a font-size literal and accepts the type variables', () => {
    const css = [
      'a { font-size: 0.75rem; }',
      'a { font-size: var(--canopy-text-sm); }',
      'a { font-size: inherit; }',
    ].join('\n');
    expect(scan(css, { fontSize: true }).hits.map((h) => h.line)).toEqual([1]);
    expect(scan(css).hits).toEqual([]);
  });

  it('accepts inherit and the contract font variables', () => {
    const css = [
      'a { font: inherit; }',
      'a { font-family: inherit !important; }',
      'a { font-family: var(--canopy-font-mono); }',
      'a { font-size: 12px; font-weight: 600; }',
      "const s = { fontFamily: 'inherit' };",
    ].join('\n');
    expect(scan(css).hits).toEqual([]);
  });

  it('ignores literals inside comments and keeps line numbers', () => {
    expect(stripComments('a /* #fff\n#000 */ b').split('\n')).toHaveLength(2);
    expect(scan('/* #fff\n   #000 */\na { color: #123456; }').hits).toEqual([
      { line: 3, text: 'a { color: #123456; }' },
    ]);
    expect(scan('// #fff\nconst a = 1;', { lineComments: true }).hits).toEqual([]);
  });

  it('exempts only the line right below a marker', () => {
    const css = '/* canopy-allow-literal: @media print */\na { color: #000; }\nb { color: #000; }';
    const result = scan(css);
    expect(result.exempt).toEqual([{ line: 2, reason: '@media print' }]);
    expect(result.hits.map((h) => h.line)).toEqual([3]);
  });

  it('rejects a marker whose reason is outside the vocabulary', () => {
    const result = scan('/* canopy-allow-literal: looks nicer */\na { color: #000; }');
    expect(result.exempt).toEqual([]);
    expect(result.errors).toEqual([{ line: 1, text: "unknown reason 'looks nicer'" }]);
  });
});

describe('parseAllow', () => {
  it('reads file, reason and count', () => {
    const { entries, errors } = parseAllow('a/b.css: @media print: 2\n\n# note\n');
    expect(errors).toEqual([]);
    expect([...entries]).toEqual([['a/b.css: @media print', 2]]);
  });

  it('rejects an unknown reason, a malformed line and a duplicate', () => {
    const text = 'a.css: looks nicer: 1\na.css: 1\na.css: @media print: 1\na.css: @media print: 2';
    expect(parseAllow(text).errors).toHaveLength(3);
  });
});

describe('run', () => {
  it('fails on a hit, listing file:line: text', () => {
    const { code, err } = run([fixture('hit.css')], { allowText: '' });
    expect(code).toBe(1);
    expect(err).toEqual([
      `${key('hit.css')}:2: color: #0f62fe;`,
      `${key('hit.css')}:3: font-family: 'IBM Plex Mono', monospace;`,
    ]);
  });

  it('passes a clean file with nothing exempt', () => {
    expect(run([fixture('clean.css')], { allowText: '' })).toEqual({
      code: 0,
      out: ['0 exempt'],
      err: [],
    });
  });

  it('passes an exempt line the allow file covers and prints its reason', () => {
    const allowText = `${key('exempt.css')}: document background: 1\n`;
    expect(run([fixture('exempt.css')], { allowText })).toEqual({
      code: 0,
      out: ['1 exempt', `${key('exempt.css')}:3: document background`],
      err: [],
    });
  });

  it('absolute argv matches its repo-relative entry, and so does a cwd-relative one', () => {
    const allowText = `${key('exempt.css')}: document background: 1\n`;
    const absolute = fixture('exempt.css');
    expect(absolute.startsWith('/')).toBe(true);
    expect(repoKey(absolute)).toBe(key('exempt.css'));
    expect(run([absolute], { allowText }).code).toBe(0);
    expect(run([relative(process.cwd(), absolute)], { allowText }).code).toBe(0);
  });

  it('fails on an exempt line the allow file does not cover', () => {
    const none = run([fixture('exempt.css')], { allowText: '' });
    expect(none.code).toBe(1);
    expect(none.err).toEqual([
      `${key('exempt.css')}: document background: 1 exempt, not in chrome-literals.allow`,
    ]);
    const other = `${key('exempt.css')}: @media print: 1\n`;
    expect(run([fixture('exempt.css')], { allowText: other }).code).toBe(1);
  });

  it('fails on a marker with a reason outside the vocabulary', () => {
    const { code, err } = run([fixture('unknown-reason.css')], { allowText: '' });
    expect(code).toBe(1);
    expect(err).toEqual([`${key('unknown-reason.css')}:2: unknown reason 'looks nicer'`]);
  });

  it('with the defaults, fails on an allow entry with no matching line', () => {
    const allowText = 'apps/viewer/src/no-such.css: Carbon danger pair: 2\n';
    const { code, err } = run([], { allowText });
    expect(code).toBe(1);
    expect(err).toContain(
      'apps/viewer/src/no-such.css: Carbon danger pair: chrome-literals.allow pins 2, no matching line found'
    );
  });

  it('with explicit files, does not ask for the rest of the allow file', () => {
    const allowText = 'apps/viewer/src/no-such.css: Carbon danger pair: 2\n';
    expect(run([fixture('clean.css')], { allowText }).code).toBe(0);
  });

  it('keeps the fixtures out of the default set', () => {
    const { err } = run([], { allowText: '' });
    expect(err.some((line) => line.includes('__fixtures__'))).toBe(false);
  });

  it('passes the repository against chrome-literals.allow', () => {
    expect(run([]).err).toEqual([]);
  });
});

describe('command line', () => {
  it('a glob matching no files exits 1', () => {
    const result = cli(fixture('no-such-dir/*.css'));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('the file set is empty');
  });

  it('a named file that is missing exits 1', () => {
    const result = cli(fixture('clean.css'), fixture('missing.css'));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${key('missing.css')}: no such file`);
  });

  it('expands a glob, from any working directory, and lists the hits', () => {
    const result = spawnSync(process.execPath, [script, fixture('h*.css')], {
      encoding: 'utf8',
      cwd: '/',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${key('hit.css')}:2: color: #0f62fe;`);
  });

  it('prints the exempt count for a clean file', () => {
    const result = cli(fixture('clean.css'));
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('0 exempt\n');
  });
});
