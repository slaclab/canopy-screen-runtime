// The dock's collection-layout conversions: mapCollection and collectionOfDock must
// give layouts the collection-form validator accepts.
import { describe, expect, it } from 'vitest';
import { collectionOfDock, mapCollection } from './collectionLayout.js';
import { validateLayout } from '@slaclab/canopy-dock-engine';
import type { CollectionLayout, Layout } from '@slaclab/canopy-dock-engine';

// --- collection layouts --------------------------------------------------------

const GRID: CollectionLayout<number> = {
  split: 'row',
  items: [
    { split: 'column', items: [{ tabs: [0] }, { tabs: [2] }], size: 2 },
    { split: 'column', items: [{ tabs: [1] }, { tabs: [3] }], size: 1 },
  ],
};

/** Member index i opens into the tab key 'k:<i>'. */
const keyOfIndex = (index: number): string => `k:${index}`;

function rounded(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (key, v: unknown) =>
      key === 'size' && typeof v === 'number' ? Math.round(v * 1e9) / 1e9 : v
    )
  ) as unknown;
}

function expectValidCollection(out: unknown, members?: number): void {
  expect(validateLayout(out, { form: 'collection', ...(members ? { members } : {}) })).toEqual({
    valid: true,
  });
}

describe('mapCollection', () => {
  it('maps every key, keeping the shape and weights when nothing drops', () => {
    expect(mapCollection(GRID, keyOfIndex)).toEqual({
      split: 'row',
      items: [
        { split: 'column', items: [{ tabs: ['k:0'] }, { tabs: ['k:2'] }], size: 2 },
        { split: 'column', items: [{ tabs: ['k:1'] }, { tabs: ['k:3'] }], size: 1 },
      ],
    });
  });

  it('keeps tabs per tile and the showing tab, and leaves out a showing that is tabs[0]', () => {
    const tabbed: CollectionLayout<number> = {
      split: 'row',
      items: [
        { tabs: [0, 1], showing: 1 },
        { tabs: [2], showing: 2 },
      ],
    };
    expect(mapCollection(tabbed, keyOfIndex)).toEqual({
      split: 'row',
      items: [{ tabs: ['k:0', 'k:1'], showing: 'k:1' }, { tabs: ['k:2'] }],
    });
  });

  it('prunes an unmapped key, drops the emptied tile and normalises', () => {
    const out = mapCollection(GRID, (i) => (i === 0 ? undefined : keyOfIndex(i)));
    expect(rounded(out)).toEqual(
      rounded({
        split: 'row',
        items: [
          { tabs: ['k:2'], size: 2 / 3 },
          {
            split: 'column',
            items: [
              { tabs: ['k:1'], size: 0.5 },
              { tabs: ['k:3'], size: 0.5 },
            ],
            size: 1 / 3,
          },
        ],
      })
    );
    expectValidCollection(out);
  });

  it('drops a key an earlier tab already took', () => {
    const out = mapCollection({ tabs: [0, 1, 2] }, (i) => (i === 2 ? 'k:0' : keyOfIndex(i)));
    expect(out).toEqual({ tabs: ['k:0', 'k:1'] });
  });

  it('clears a showing tab that was pruned', () => {
    const out = mapCollection({ tabs: [0, 1], showing: 1 }, (i) =>
      i === 1 ? undefined : keyOfIndex(i)
    );
    expect(out).toEqual({ tabs: ['k:0'] });
  });

  it('flattens a split left in its parent direction', () => {
    const nested: CollectionLayout<number> = {
      split: 'row',
      items: [
        { tabs: [0] },
        {
          split: 'column',
          items: [{ tabs: [1] }, { split: 'row', items: [{ tabs: [2] }, { tabs: [3] }] }],
        },
      ],
    };
    const out = mapCollection(nested, (i) => (i === 1 ? undefined : i));
    expect(rounded(out)).toEqual(
      rounded({
        split: 'row',
        items: [
          { tabs: [0], size: 0.5 },
          { tabs: [2], size: 0.25 },
          { tabs: [3], size: 0.25 },
        ],
      })
    );
  });

  it('is null when no tile is left, and never mutates its input', () => {
    const before = structuredClone(GRID);
    expect(mapCollection(GRID, () => undefined)).toBeNull();
    expect(GRID).toEqual(before);
  });

  it('handles a tree ten splits deep (no depth cap)', () => {
    let deep: CollectionLayout<number> = { tabs: [0] };
    for (let i = 1; i <= 10; i++) {
      deep = { split: i % 2 ? 'row' : 'column', items: [deep, { tabs: [i] }] };
    }
    const out = mapCollection(deep, keyOfIndex);
    expect(out).not.toBeNull();
    expectValidCollection(out);
  });
});

describe('collectionOfDock', () => {
  const dock: Layout = {
    split: 'row',
    items: [
      { tile: 't1', tabs: ['a', 'b'], showing: 'b', size: 0.6 },
      { tile: 't2', tabs: ['c'], showing: 'c', size: 0.4, from: 't1' },
    ],
  };
  const indexOf = (key: string): number | undefined =>
    (({ a: 0, b: 1, c: 2 }) as Record<string, number>)[key];

  it('drops tile ids and from, keeps tabs, showing and sizes as weights', () => {
    const out = collectionOfDock(dock, indexOf);
    expect(out).toEqual({
      split: 'row',
      items: [
        { tabs: [0, 1], showing: 1, size: 0.6 },
        { tabs: [2], size: 0.4 },
      ],
    });
    expectValidCollection(out, 3);
  });

  it('saves a one-tile dock as a one-tile layout', () => {
    const one: Layout = { tile: 't1', tabs: ['a', 'b', 'c'], showing: 'a' };
    const out = collectionOfDock(one, indexOf);
    expect(out).toEqual({ tabs: [0, 1, 2] });
    expectValidCollection(out, 3);
  });

  it('prunes a tab without a member index and normalises', () => {
    const out = collectionOfDock(dock, (key) => (key === 'c' ? undefined : indexOf(key)));
    expect(out).toEqual({ tabs: [0, 1], showing: 1 });
  });

  it('round-trips through the open conversion', () => {
    const saved = collectionOfDock(dock, indexOf)!;
    const keys = ['a', 'b', 'c'];
    const reopened = mapCollection(saved, (i) => keys[i]);
    expect(reopened).toEqual({
      split: 'row',
      items: [
        { tabs: ['a', 'b'], showing: 'b', size: 0.6 },
        { tabs: ['c'], size: 0.4 },
      ],
    });
  });
});
