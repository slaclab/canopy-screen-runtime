// memberKey / parseMember / memberLabel. The key grammar is pinned by the
// shared vectors file, a byte copy of canopy's
// tests/canopy_mcp/fixtures/collections/member-key-vectors.json.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import type { MemberKey } from './collections.js';
import { InvalidMember, memberKey, memberLabel, parseMember } from './collections.js';

interface Vector {
  name: string;
  member: unknown;
  expect?: string;
  refused?: true;
}

const VECTORS_PATH = createRequire(import.meta.url).resolve(
  '../../e2e/fixtures/collections/member-key-vectors.json'
);
const RAW = readFileSync(VECTORS_PATH, 'utf8');
const CASES = (JSON.parse(RAW) as { cases: Vector[] }).cases;
const KEYED = CASES.filter((c) => c.expect !== undefined);
const REFUSED = CASES.filter((c) => c.refused === true);

// --- the brand -------------------------------------------------------------

// A plain string is not a MemberKey; `pnpm --filter viewer typecheck` fails if
// this line stops being an error.
// @ts-expect-error a plain string does not carry the MemberKey brand
const notAKey: MemberKey = 'screen:library/a';

describe('MemberKey brand', () => {
  it('is a plain string at run time', () => {
    const key: MemberKey = memberKey({ screen: 'library/a' });
    const asString: string = key;
    expect(asString).toBe('screen:library/a');
    expect(notAKey).toBe('screen:library/a');
  });
});

// --- the shared vectors -----------------------------------------------------

describe('member-key vectors', () => {
  it('cover keyed and refused members', () => {
    expect(KEYED.length).toBeGreaterThan(20);
    expect(REFUSED.length).toBeGreaterThan(5);
    expect(KEYED.length + REFUSED.length).toBe(CASES.length);
  });

  it.each(KEYED.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const member = parseMember(c.member);
    expect(member).not.toBeNull();
    expect(memberKey(member!)).toBe(c.expect);
  });

  it.each(REFUSED.map((c) => [c.name, c] as const))('refuses: %s', (_name, c) => {
    expect(parseMember(c.member)).toBeNull();
    expect(() => memberKey(c.member as never)).toThrow(InvalidMember);
  });
});

// --- refusals beyond the vectors --------------------------------------------

describe('memberKey refusals', () => {
  it.each([
    ['null', null],
    ['an array', [{ screen: 'library/a' }]],
    ['a string', 'library/a'],
    ['a non-string screen', { screen: 7 }],
    ['a non-string tool', { tool: 7 }],
    ['null macros', { screen: 'library/a', macros: null }],
    ['a lone surrogate in a macro value', { screen: 'library/a', macros: { P: '\ud83d' } }],
    ['a lone surrogate in a macro name', { screen: 'library/a', macros: { '\ude00': 'x' } }],
  ])('refuses %s', (_label, raw) => {
    expect(parseMember(raw)).toBeNull();
    expect(() => memberKey(raw as never)).toThrow(InvalidMember);
  });

  it('a reserved macro is still checked before it is dropped', () => {
    expect(parseMember({ screen: 'library/a', macros: { theme: 1 } })).toBeNull();
  });
});

// --- parseMember --------------------------------------------------------------

describe('parseMember', () => {
  it('keeps the persisted fields and drops the rest', () => {
    expect(parseMember({ screen: 'library/a', macros: { P: 'x' }, query: 'q', extra: 1 })).toEqual({
      screen: 'library/a',
      macros: { P: 'x' },
    });
    expect(parseMember({ tool: 'trace', query: 'pv=a', name: 'Orbit', macros: {} })).toEqual({
      tool: 'trace',
      query: 'pv=a',
      name: 'Orbit',
    });
  });

  it('keeps an absent query absent and a blank one blank', () => {
    expect(parseMember({ tool: 'trace' })).toEqual({ tool: 'trace' });
    expect(parseMember({ tool: 'trace', query: '' })).toEqual({ tool: 'trace', query: '' });
  });

  it('copies the macros', () => {
    const macros = { P: 'x' };
    const member = parseMember({ screen: 'library/a', macros });
    macros.P = 'changed';
    expect(member).toEqual({ screen: 'library/a', macros: { P: 'x' } });
  });

  it('refuses a non-string name', () => {
    expect(parseMember({ tool: 'trace', name: 3 })).toBeNull();
  });
});

// --- memberLabel ---------------------------------------------------------------

describe('memberLabel', () => {
  it('prefers the name', () => {
    expect(memberLabel({ tool: 'trace', query: 'pv=a', name: 'Orbit' })).toBe('Orbit');
    expect(memberLabel({ screen: 'library/a', name: 'Mine' })).toBe('Mine');
  });

  it('is the bare tool label without a query', () => {
    expect(memberLabel({ tool: 'trace' })).toBe('Data Browser');
    expect(memberLabel({ tool: 'correlation' })).toBe('Correlation');
  });

  it('describes the query after the tool label', () => {
    expect(memberLabel({ tool: 'trace', query: 'pv=a&pv=b' })).toBe(
      'Data Browser: 2 PVs and the time range'
    );
    expect(memberLabel({ tool: 'waveform', query: 'pv=a' })).toBe('Waveform: 1 PV');
    expect(memberLabel({ tool: 'correlation', query: '' })).toBe('Correlation: 0 Y PVs');
  });

  it('falls back to the tool id for an unregistered tool', () => {
    expect(memberLabel({ tool: 'nope', query: 'x' })).toBe('nope');
  });

  it('is the screen reference for an unnamed screen', () => {
    expect(memberLabel({ screen: 'library/sr/bpm', macros: { P: 'x' } })).toBe('library/sr/bpm');
  });
});
