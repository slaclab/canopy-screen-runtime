// words / matchEntry / rankEntries / searchable. The matcher is pinned by the
// shared vectors file, a byte copy of canopy's
// tests/canopy_mcp/fixtures/collections/match-vectors.json.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { matchEntry, rankEntries, searchable, words } from './match.js';

interface Candidate {
  label: string;
  keywords: string[];
}

interface RankCase {
  name: string;
  kind: 'rank';
  query: string;
  candidates: Candidate[];
  expect: string[];
}

interface IncludeCase {
  name: string;
  kind: 'include';
  manifest: { id: string; category: string; kind: string }[];
  showSubScreens: boolean;
  expect: string[];
}

interface Case {
  name: string;
  kind: string;
}

const VECTORS_PATH = createRequire(import.meta.url).resolve(
  '../../e2e/fixtures/collections/match-vectors.json'
);
const RAW = readFileSync(VECTORS_PATH, 'utf8');
const CASES = (JSON.parse(RAW) as { cases: Case[] }).cases;

/** Runs one vector case; a kind this reader does not know is a failure. */
function run(c: Case): string[] {
  switch (c.kind) {
    case 'rank': {
      const r = c as RankCase;
      return rankEntries(r.candidates, r.query).map((e) => e.label);
    }
    case 'include': {
      const i = c as IncludeCase;
      return i.manifest
        .filter((screen) => searchable(screen, { showSubScreens: i.showSubScreens }))
        .map((screen) => screen.id);
    }
    default:
      throw new Error(`unknown vector kind ${JSON.stringify(c.kind)} in case ${c.name}`);
  }
}

describe('match vectors', () => {
  it('has both kinds and nothing else', () => {
    const rank = CASES.filter((c) => c.kind === 'rank').length;
    const include = CASES.filter((c) => c.kind === 'include').length;
    expect(rank).toBeGreaterThan(0);
    expect(include).toBeGreaterThan(0);
    expect(rank + include).toBe(CASES.length);
  });

  it('fails on an unknown kind', () => {
    expect(() => run({ name: 'bogus', kind: 'fuzzy' })).toThrow(/unknown vector kind/);
  });

  it.each(CASES.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    expect(run(c)).toEqual((c as RankCase | IncludeCase).expect);
  });
});

describe('words', () => {
  it('splits on camelCase, acronym and digit boundaries', () => {
    expect(words('GTLView')).toEqual(['gtl', 'view']);
    expect(words('SR01C')).toEqual(['sr', '01', 'c']);
    expect(words('BPMTable')).toEqual(['bpm', 'table']);
    expect(words('library/sr/sr01c-correctors')).toEqual([
      'library',
      'sr',
      'sr',
      '01',
      'c',
      'correctors',
    ]);
  });

  it('returns no words for text without alphanumerics', () => {
    expect(words('')).toEqual([]);
    expect(words(' /-_ ')).toEqual([]);
  });
});

describe('matchEntry', () => {
  it('returns null for a blank query or a miss', () => {
    expect(matchEntry('  ', { label: 'Trace' })).toBeNull();
    expect(matchEntry('xyz', { label: 'Trace' })).toBeNull();
  });

  it('accepts an entry without keywords', () => {
    expect(matchEntry('tr', { label: 'Trace' })).not.toBeNull();
  });
});

describe('rankEntries', () => {
  it('keeps the entry objects it was given', () => {
    const entries = [{ label: 'Trace', id: 't' }];
    expect(rankEntries(entries, 'tr')[0]).toBe(entries[0]);
  });
});
