// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { check } from './check-fixture-copies.mjs';

const dirs: string[] = [];

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'fixture-copies-'));
  dirs.push(root);
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return root;
}

const COPIES = [{ copy: 'set', source: 'src/set' }];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('check', () => {
  it('passes identical copies and lists source files left out', () => {
    const fixtures = tree({ 'set/a.json': '1', 'set/sub/b.json': '2' });
    const canopy = tree({
      'src/set/a.json': '1',
      'src/set/sub/b.json': '2',
      'src/set/c.json': '3',
    });
    const result = check(canopy, { fixtures, copies: COPIES });
    expect(result.code).toBe(0);
    expect(result.err).toEqual([]);
    expect(result.out).toEqual([
      'set: 2 of 2 files identical to src/set',
      'set/c.json: in canopy, not copied',
    ]);
  });

  it('fails on a changed file and on a file canopy does not have', () => {
    const fixtures = tree({ 'set/a.json': '1', 'set/extra.json': 'x' });
    const canopy = tree({ 'src/set/a.json': '1 ' });
    const result = check(canopy, { fixtures, copies: COPIES });
    expect(result.code).toBe(1);
    expect(result.err).toEqual([
      "set/a.json: differs from canopy's src/set/a.json",
      "set/extra.json: not in canopy's src/set",
    ]);
  });

  it('fails when the checkout has no source directory', () => {
    const fixtures = tree({ 'set/a.json': '1' });
    const canopy = tree({});
    expect(check(canopy, { fixtures, copies: COPIES }).err).toEqual([
      `set: no src/set in ${canopy}`,
    ]);
  });
});
