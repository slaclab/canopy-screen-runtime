// The collection edits: pure functions over a collection's raw document (the listed
// document minus source/ref/rev/updated), each taking raw member indices. The
// layout's tabs are member indexes, so every edit keeps them pointing at the
// same members: a reorder remaps them through its permutation, a removal drops
// one and renumbers the rest. Every layout an edit produces must pass
// checkCollection, which mirrors canopy's validator, so a PUT of the result is
// never refused for its layout.

import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkCollection, parseMember, renamed, reordered, withoutMember } from './collections.js';
import { keysOf } from '@slaclab/canopy-dock-engine';
import type { CollectionLayout } from '@slaclab/canopy-dock-engine';

const FIXTURES = createRequire(import.meta.url)
  .resolve('../../e2e/fixtures/collections/member-key-vectors.json')
  .replace(/member-key-vectors\.json$/, '');
const PERSONAL = join(FIXTURES, 'valid/personal');

/** A listed document as an edit receives it: without source/ref/rev/updated. */
function rawOf(doc: Record<string, unknown>): Record<string, unknown> {
  const raw = { ...doc };
  for (const field of ['source', 'ref', 'rev', 'updated']) delete raw[field];
  return raw;
}

function load(name: string): Record<string, unknown> {
  const doc = JSON.parse(readFileSync(join(PERSONAL, name), 'utf8')) as Record<string, unknown>;
  return rawOf(doc);
}

const personal = readdirSync(PERSONAL)
  .filter((name) => name.endsWith('.json'))
  .sort();
const laidOut = personal.filter((name) => Object.hasOwn(load(name), 'layout'));

function layoutOf(raw: Record<string, unknown>): CollectionLayout<number> {
  return raw.layout as CollectionLayout<number>;
}

function expectValid(doc: Record<string, unknown>): void {
  expect(checkCollection(doc), JSON.stringify(doc.layout)).toEqual(
    expect.objectContaining({ ok: true })
  );
}

/** Sizes rounded to 1e-9, so fractions compare exactly. */
function rounded(layout: unknown): unknown {
  return JSON.parse(
    JSON.stringify(layout, (key, value: unknown) =>
      key === 'size' && typeof value === 'number' ? Math.round(value * 1e9) / 1e9 : value
    )
  ) as unknown;
}

/** Which member each tab names, tile by tile: the identity an edit must keep. */
function tabMembers(raw: Record<string, unknown>): unknown[] {
  const members = raw.members as unknown[];
  return keysOf(layoutOf(raw)).map((index) => members[index]);
}

describe('fixtures', () => {
  it('covers every personal fixture, the tabbed, one-tile and deep layouts among them', () => {
    expect(personal).toEqual(
      expect.arrayContaining([
        'deep.json',
        'drafts.json',
        'grid.json',
        'root-tile.json',
        'tabbed.json',
      ])
    );
    expect(laidOut).toEqual(['deep.json', 'grid.json', 'root-tile.json', 'tabbed.json']);
  });
});

describe('renamed', () => {
  it.each(personal)('%s round-trips: equal to the input except name', (file) => {
    const raw = load(file);
    const before = structuredClone(raw);
    const out = renamed(raw, 'Something else');
    expect(out.name).toBe('Something else');
    expect({ ...out, name: before.name }).toEqual(before);
    expect(raw).toEqual(before);
    expectValid(out);
  });

  it('back to the old name is the input again', () => {
    const raw = load('grid.json');
    expect(renamed(renamed(raw, 'x'), raw.name as string)).toEqual(raw);
  });
});

describe('withoutMember', () => {
  it('drops the index, renumbers the rest, removes the emptied tile and normalises (grid.json)', () => {
    const raw = load('grid.json');
    const out = withoutMember(raw, 0);
    expect(out.members).toEqual((raw.members as unknown[]).slice(1));
    expect(rounded(out.layout)).toEqual(
      rounded({
        split: 'row',
        items: [
          { tabs: [1], size: 2 / 3 },
          {
            split: 'column',
            items: [
              { tabs: [0], size: 0.5 },
              { tabs: [2], size: 0.5 },
            ],
            size: 1 / 3,
          },
        ],
      })
    );
    expectValid(out);
  });

  it('keeps a tile that still has tabs; its showing tab follows its member (tabbed.json)', () => {
    const raw = load('tabbed.json');
    const out = withoutMember(raw, 0);
    // The left tile [0, 1] showing 1 becomes [0] (the old 1), the default showing.
    expect(rounded(out.layout)).toEqual(
      rounded({
        split: 'row',
        items: [
          { tabs: [0], size: 0.5 },
          { tabs: [1], size: 0.5 },
        ],
      })
    );
    expectValid(out);
  });

  it('clears a showing tab that went (tabbed.json, the showing member removed)', () => {
    const out = withoutMember(load('tabbed.json'), 1);
    expect(rounded(out.layout)).toEqual(
      rounded({
        split: 'row',
        items: [
          { tabs: [0], size: 0.5 },
          { tabs: [1], size: 0.5 },
        ],
      })
    );
    expectValid(out);
  });

  it('a one-tile layout loses a tab and stays one tile (root-tile.json)', () => {
    const out = withoutMember(load('root-tile.json'), 1);
    expect(out.layout).toEqual({ tabs: [0, 1] });
    expectValid(out);
  });

  it('drops the layout with the last member', () => {
    const raw = { name: 'x', members: [{ screen: 'library/a' }], layout: { tabs: [0] } };
    const out = withoutMember(raw, 0);
    expect(out.members).toEqual([]);
    expect(Object.hasOwn(out, 'layout')).toBe(false);
  });

  it('leaves a document without a layout without one', () => {
    const out = withoutMember(load('drafts.json'), 0);
    expect(Object.hasOwn(out, 'layout')).toBe(false);
  });

  it.each(laidOut)(
    '%s: every removal order down to one member stays valid and keeps identities',
    (file) => {
      let raw = load(file);
      while ((raw.members as unknown[]).length > 1) {
        const before = tabMembers(raw);
        const index = Math.floor((raw.members as unknown[]).length / 2);
        const gone = (raw.members as unknown[])[index];
        raw = withoutMember(raw, index);
        expectValid(raw);
        expect(tabMembers(raw)).toEqual(before.filter((member) => member !== gone));
      }
    }
  );

  it('never mutates its input', () => {
    const raw = load('grid.json');
    const before = structuredClone(raw);
    withoutMember(raw, 2);
    expect(raw).toEqual(before);
  });

  it('refuses an index that names no member', () => {
    const raw = load('grid.json');
    expect(() => withoutMember(raw, 4)).toThrow(RangeError);
    expect(() => withoutMember(raw, -1)).toThrow(RangeError);
    expect(() => withoutMember(raw, 1.5)).toThrow(RangeError);
  });
});

describe('reordered', () => {
  it('moves a member; every index and showing follows it, the shape unchanged', () => {
    const raw = load('tabbed.json');
    const out = reordered(raw, 0, 2);
    const members = raw.members as unknown[];
    expect(out.members).toEqual([members[1], members[2], members[0]]);
    // old 0 -> 2, 1 -> 0, 2 -> 1; the left tile still shows the old member 1.
    expect(out.layout).toEqual({
      split: 'row',
      items: [{ tabs: [2, 0], showing: 0 }, { tabs: [1] }],
    });
    expectValid(out);
  });

  it('keeps the sizes as stored (grid.json)', () => {
    const raw = load('grid.json');
    const out = reordered(raw, 3, 0);
    expect(out.layout).toEqual({
      split: 'row',
      items: [
        { split: 'column', items: [{ tabs: [1] }, { tabs: [3] }], size: 2 },
        { split: 'column', items: [{ tabs: [2] }, { tabs: [0] }], size: 1 },
      ],
    });
    expectValid(out);
  });

  it.each(laidOut)('%s: every move keeps each tab on its member', (file) => {
    const raw = load(file);
    const count = (raw.members as unknown[]).length;
    for (let from = 0; from < count; from++) {
      const to = (from + 2) % count;
      const out = reordered(raw, from, to);
      expectValid(out);
      expect(tabMembers(out)).toEqual(tabMembers(raw));
    }
  });

  it('moving down then back up is the input again', () => {
    const raw = load('grid.json');
    expect(reordered(reordered(raw, 0, 3), 3, 0)).toEqual(raw);
  });

  it('refuses indices that name no member', () => {
    const raw = load('grid.json');
    expect(() => reordered(raw, 0, 4)).toThrow(RangeError);
    expect(() => reordered(raw, -1, 0)).toThrow(RangeError);
  });
});

describe('an unkeyable member in raw', () => {
  // The parsed collection skips member 1, so the UI's row i maps to rawIndex[i]:
  // row 0 -> 0, row 1 -> 2, row 2 -> 3. Edits take that raw index, as do the
  // layout's tabs.
  const raw = {
    id: 'mixed',
    name: 'Mixed',
    members: [
      { screen: 'library/sr/overview' },
      { widget: 'future-kind' },
      { tool: 'trace' },
      { screen: 'library/bts/BTSView' },
    ],
    layout: { split: 'row', items: [{ tabs: [0, 1] }, { tabs: [2, 3], showing: 3 }] },
  } as Record<string, unknown>;
  const members = raw.members as Record<string, unknown>[];

  it('the fixture really carries an unkeyable member and is a valid layout', () => {
    expect(parseMember(members[1])).toBeNull();
    expectValid(raw);
  });

  it('withoutMember at a raw index keeps the unkeyable member', () => {
    const out = withoutMember(raw, 2);
    expect(out.members).toEqual([members[0], members[1], members[3]]);
    expect(rounded(out.layout)).toEqual(
      rounded({
        split: 'row',
        items: [
          { tabs: [0, 1], size: 0.5 },
          { tabs: [2], size: 0.5 },
        ],
      })
    );
    expectValid(out);
  });

  it('removing the unkeyable member itself drops its tab too', () => {
    const out = withoutMember(raw, 1);
    expect(out.members).toEqual([members[0], members[2], members[3]]);
    expect(rounded(out.layout)).toEqual(
      rounded({
        split: 'row',
        items: [
          { tabs: [0], size: 0.5 },
          { tabs: [1, 2], showing: 2, size: 0.5 },
        ],
      })
    );
    expectValid(out);
  });

  it('reordered at raw indices moves around the unkeyable member, which stays put', () => {
    const out = reordered(raw, 3, 2);
    expect(out.members).toEqual([members[0], members[1], members[3], members[2]]);
    expect(out.layout).toEqual({
      split: 'row',
      items: [{ tabs: [0, 1] }, { tabs: [3, 2], showing: 2 }],
    });
    expectValid(out);
  });

  it('renamed keeps the unkeyable member verbatim', () => {
    expect(renamed(raw, 'Renamed')).toEqual({ ...raw, name: 'Renamed' });
  });
});
