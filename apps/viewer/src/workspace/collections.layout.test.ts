// checkCollection: a collection document's layout rules (the dock layout's collection
// form). The fixture set is a byte copy of canopy's
// tests/canopy_mcp/fixtures/collections/{valid,invalid}/, replayed
// so the viewer refuses exactly what canopy refuses for a layout reason, in the
// same words, and passes every document canopy refuses for another reason.

import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LAYOUT_REASON_TEXT, MAX_LAYOUT_BYTES, checkCollection } from './collections.js';
import { LAYOUT_REASONS } from '@slaclab/canopy-dock-engine';

const FIXTURES = createRequire(import.meta.url)
  .resolve('../../e2e/fixtures/collections/member-key-vectors.json')
  .replace(/member-key-vectors\.json$/, '');
const VALID_DIRS = ['valid/facility', 'valid/personal'];
const INVALID = join(FIXTURES, 'invalid');

/** canopy's test_collections_fixtures.py REFUSALS for the rules checkCollection owns. */
const LAYOUT_REFUSALS: Record<string, string> = {
  'not-object.json': 'a collection must be an object',
  'layout-not-object.json': 'layout: not_layout',
  'layout-unknown-field.json': 'layout.gap: unknown_field',
  'layout-tile-id.json': 'layout.items[0].tile: unknown_field',
  'layout-from.json': 'layout.items[1].from: unknown_field',
  'layout-bad-split.json': 'layout.split: bad_split',
  'layout-one-item.json': 'layout.items: split_too_few_items',
  'layout-empty-tabs.json': 'layout.items[0].tabs: empty_tabs',
  'layout-bad-key.json': 'layout.items[1].tabs[0]: bad_key',
  'layout-duplicate-key.json': 'layout.items[1].tabs[0]: duplicate_key',
  'layout-showing-not-in-tabs.json': 'layout.items[0].showing: showing_not_in_tabs',
  'layout-bad-size.json': 'layout.items[0].size: bad_size',
  'layout-member-missing.json': 'layout: member_missing',
};
/** Refused by canopy before its validator sees a document (name, kind, decoding). */
const NOT_DOCUMENTS = new Set([
  'bad.stem.json',
  'not-a-file.json',
  'not-utf8.json',
  'not-json.json',
]);

function load(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function errorOf(doc: unknown): string {
  const check = checkCollection(doc);
  return check.ok ? '' : check.error;
}

const validFiles = VALID_DIRS.flatMap((dir) =>
  readdirSync(join(FIXTURES, dir))
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => `${dir}/${name}`)
);
const invalidFiles = readdirSync(INVALID).sort();
const documents = invalidFiles.filter((name) => !NOT_DOCUMENTS.has(name));

describe('fixture replay', () => {
  it('finds the copied set', () => {
    expect(validFiles).toEqual(
      expect.arrayContaining([
        'valid/personal/grid.json',
        'valid/personal/tabbed.json',
        'valid/personal/root-tile.json',
        'valid/personal/deep.json',
      ])
    );
    expect(invalidFiles).toEqual(expect.arrayContaining(Object.keys(LAYOUT_REFUSALS)));
    for (const name of NOT_DOCUMENTS) expect(invalidFiles).toContain(name);
  });

  it.each(validFiles)('passes %s', (file) => {
    expect(checkCollection(load(join(FIXTURES, file)))).toMatchObject({ ok: true });
  });

  it('reads the tabbed layout of valid/personal/tabbed.json as it is stored', () => {
    const check = checkCollection(load(join(FIXTURES, 'valid/personal/tabbed.json')));
    expect(check).toEqual({
      ok: true,
      layout: { split: 'row', items: [{ tabs: [0, 1], showing: 1 }, { tabs: [2] }] },
    });
  });

  it('reads a root tile: a one-tile layout', () => {
    const check = checkCollection(load(join(FIXTURES, 'valid/personal/root-tile.json')));
    expect(check).toEqual({ ok: true, layout: { tabs: [0, 1, 2] } });
  });

  it('passes deep.json, eight splits deep: there is no depth cap', () => {
    const check = checkCollection(load(join(FIXTURES, 'valid/personal/deep.json')));
    expect(check.ok).toBe(true);
  });

  it('has no layout for a document without one', () => {
    const check = checkCollection(load(join(FIXTURES, 'valid/personal/drafts.json')));
    expect(check).toEqual({ ok: true, layout: null });
  });

  it.each(Object.entries(LAYOUT_REFUSALS))('refuses %s: %s', (file, phrase) => {
    const error = errorOf(load(join(INVALID, file)));
    expect(error.startsWith(phrase), error).toBe(true);
  });

  it.each(documents.filter((name) => !(name in LAYOUT_REFUSALS)))(
    'leaves %s to canopy (no layout rule broken)',
    (file) => {
      expect(checkCollection(load(join(INVALID, file)))).toMatchObject({ ok: true });
    }
  );
});

describe('checkCollection rules', () => {
  const members = [{ screen: 'library/a' }, { screen: 'library/b' }];
  const doc = (layout: unknown): unknown => ({ name: 'x', members, layout });

  it('accepts tabs per tile and a showing tab', () => {
    expect(checkCollection(doc({ tabs: [1, 0], showing: 0 }))).toEqual({
      ok: true,
      layout: { tabs: [1, 0], showing: 0 },
    });
  });

  it('refuses a partly placed layout: member_missing', () => {
    const check = checkCollection(doc({ tabs: [0] }));
    expect(check).toEqual({
      ok: false,
      error: 'layout: member_missing: every member is placed in a tile',
      reason: LAYOUT_REASONS.memberMissing,
    });
  });

  it('refuses a key past the members: bad_key', () => {
    expect(errorOf(doc({ split: 'row', items: [{ tabs: [0] }, { tabs: [1, 2] }] }))).toBe(
      `layout.items[1].tabs[1]: bad_key: ${LAYOUT_REASON_TEXT.bad_key}`
    );
  });

  it('refuses a string key in a collection document', () => {
    expect(errorOf(doc({ tabs: ['a', 1] }))).toMatch(/^layout\.tabs\[0\]: bad_key/);
  });

  it.each([0, -1, true, '2', null])('refuses size %s', (size) => {
    expect(errorOf(doc({ split: 'row', items: [{ tabs: [0], size }, { tabs: [1] }] }))).toBe(
      `layout.items[0].size: bad_size: ${LAYOUT_REASON_TEXT.bad_size}`
    );
  });

  it('caps the layout at MAX_LAYOUT_BYTES of UTF-8', () => {
    const many = Array.from({ length: 8000 }, (_, i) => ({ screen: `library/s${i}` }));
    const layout = { tabs: many.map((_, i) => i) };
    const check = checkCollection({ name: 'x', members: many, layout });
    expect(JSON.stringify(layout).length).toBeGreaterThan(MAX_LAYOUT_BYTES);
    expect(check).toEqual({
      ok: false,
      error: `layout exceeds ${MAX_LAYOUT_BYTES} bytes (MAX_LAYOUT_BYTES)`,
    });
  });

  it('refuses a non-object document', () => {
    expect(checkCollection([])).toEqual({ ok: false, error: 'a collection must be an object' });
  });
});
