// plotPVs: the chooser's preselection, search, and the query it opens Trace with.

import { describe, expect, it } from 'vitest';
import type { ScreenPVGroup, ScreenPVRole } from '@slaclab/canopy-screen-runtime';
import {
  DEFAULT_PLOT_PVS,
  defaultSelection,
  filterGroups,
  fitsTraceQuery,
  plotQuery,
} from './plotPVs.js';

function group(
  title: string,
  pvs: [string, ScreenPVRole][],
  extra: Partial<ScreenPVGroup> = {}
): ScreenPVGroup {
  return {
    key: title,
    title,
    detail: '',
    depth: title === 'GTL' ? 0 : 1,
    pvs: pvs.map(([name, role]) => ({ name, role })),
    ...extra,
  };
}

const GROUPS = [
  group('GTL', [
    ['GTL:RULE', 'rule'],
    ['GTL:Q1:I', 'readback'],
    ['GTL:Q1:SET', 'control'],
    ['GTL:LED', 'status'],
    ['GTL:Q2:I', 'readback'],
  ]),
  group(
    'BPM',
    [
      ['GTL:BPM1:X', 'readback'],
      ['GTL:BPM1:Y', 'readback'],
    ],
    {
      detail: 'BPM=GTL BPM1',
    }
  ),
  group('Empty', []),
  group('Plot', [
    ['GTL:WF', 'plot'],
    ['GTL:F:IN', 'formula'],
  ]),
];

describe('defaultSelection', () => {
  it('preselects readbacks and plotted channels in screen order, up to the default', () => {
    expect(defaultSelection(GROUPS)).toEqual([
      'GTL:Q1:I',
      'GTL:Q2:I',
      'GTL:BPM1:X',
      'GTL:BPM1:Y',
      'GTL:WF',
    ]);
    expect(defaultSelection(GROUPS, 3)).toEqual(['GTL:Q1:I', 'GTL:Q2:I', 'GTL:BPM1:X']);
  });

  it('stops at the default for a large screen', () => {
    const many = [
      group(
        'GTL',
        Array.from({ length: 40 }, (_, i) => [`R:${i}`, 'readback'] as [string, ScreenPVRole])
      ),
    ];
    expect(defaultSelection(many)).toHaveLength(DEFAULT_PLOT_PVS);
  });

  it('preselects nothing when the screen shows no value', () => {
    expect(
      defaultSelection([
        group('GTL', [
          ['A', 'rule'],
          ['B', 'control'],
          ['C', 'status'],
        ]),
      ])
    ).toEqual([]);
  });
});

describe('filterGroups', () => {
  it('drops empty groups and keeps the rest without a search', () => {
    expect(filterGroups(GROUPS, '  ').map((g) => g.title)).toEqual(['GTL', 'BPM', 'Plot']);
  });

  it('matches PV names case-insensitively, every word', () => {
    const out = filterGroups(GROUPS, 'q1 gtl');
    expect(out.map((g) => [g.title, g.pvs.map((p) => p.name)])).toEqual([
      ['GTL', ['GTL:Q1:I', 'GTL:Q1:SET']],
    ]);
  });

  it('keeps a whole group whose title or macros match', () => {
    expect(filterGroups(GROUPS, 'bpm1').map((g) => g.pvs.length)).toEqual([2]);
    expect(filterGroups(GROUPS, 'plot')[0]!.pvs).toHaveLength(2);
  });

  it('is empty when nothing matches', () => {
    expect(filterGroups(GROUPS, 'nope')).toEqual([]);
  });
});

describe('plotQuery', () => {
  it('opens the PVs over the last hour without a current query', () => {
    expect(plotQuery(['GTL:Q1:I', 'GTL:BPM1:X'])).toBe('pv=GTL:Q1:I&pv=GTL:BPM1:X&range=-1h');
  });

  it("keeps the data browser's range and leaves its PVs and plot config behind", () => {
    const current = 'pv=OLD&range=-6h&plot=%7B%22v%22%3A1%7D';
    expect(plotQuery(['A'], current)).toBe('pv=A&range=-6h');
  });

  it('keeps a custom window', () => {
    const current = 'pv=OLD&range=custom&from=2026-09-30T10:00&to=2026-09-30T11:00';
    expect(plotQuery(['A'], current)).toBe(
      'pv=A&range=custom&from=2026-09-30T10:00&to=2026-09-30T11:00'
    );
    expect(plotQuery(['A'], 'range=custom&from=2026-09-30T10:00')).toBe(
      'pv=A&range=custom&from=2026-09-30T10:00'
    );
  });

  it('encodes names that are not plain', () => {
    const query = plotQuery(['A B&C=D', 'ca://X:Y']);
    expect(new URLSearchParams(query).getAll('pv')).toEqual(['A B&C=D', 'ca://X:Y']);
  });
});

describe('fitsTraceQuery', () => {
  it("holds Trace's 4 KB limit", () => {
    expect(fitsTraceQuery(`pv=${'A'.repeat(4093)}`)).toBe(true);
    expect(fitsTraceQuery(`pv=${'A'.repeat(4094)}`)).toBe(false);
  });
});
