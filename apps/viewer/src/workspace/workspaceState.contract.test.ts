// buildState / reduceOversize against the shared workspace vectors
// (e2e/fixtures/workspace/, a byte copy of canopy's): the sample state round-trips,
// the oversize body reduces to exactly the reduced vector, and the reported
// layout is the holder's, holding exactly the reported tabs (null with none).

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ZoomState } from '../ZoomContext.js';
import type { Layout } from '@slaclab/canopy-dock-engine';
import { EMPTY_TABS, type TabsState } from './tabs.js';
import {
  buildState,
  MAX_BODY_BYTES,
  MAX_LABEL,
  reduceOversize,
  type StateBody,
  withoutPlot,
  type WorkspaceState,
} from './workspaceState.js';

const require = createRequire(import.meta.url);
const ROOT = dirname(require.resolve('../../e2e/fixtures/workspace/state.sample.json'));
const STUB_HUB = pathToFileURL(require.resolve('../../e2e/workspaceHub.mjs')).href;

function load<T = StateBody>(name: string): T {
  return JSON.parse(readFileSync(join(ROOT, name), 'utf8')) as T;
}

function bytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

async function stubNormalise(state: WorkspaceState): Promise<unknown> {
  const hub = (await import(/* @vite-ignore */ STUB_HUB)) as {
    normaliseState: (raw: unknown) => unknown;
  };
  return hub.normaliseState(state);
}

const FIT: ZoomState = { mode: 'fit', scale: 1 };

/**
 * A holder state: `keys` as the tabs of one tile t1 showing `active` (else the
 * first key), unless `layout` is given; `keys` is kept as given, since the
 * holder's own order is its layout's.
 */
function tabsOf(partial: Partial<TabsState>): TabsState {
  const keys = partial.keys ?? [];
  const layout: Layout | null =
    partial.layout !== undefined
      ? partial.layout
      : keys.length === 0
        ? null
        : { tile: 't1', tabs: [...keys], showing: partial.active ?? keys[0]! };
  return {
    ...EMPTY_TABS,
    history: {},
    closedStack: [],
    layout,
    focusedTile: layout === null ? null : 't1',
    ...partial,
  };
}

// --- the sample's inputs: what the viewer holds when it reports state.sample.json ---

const LINAC = 'library/linac/LinacView?SR=1';
const XFER = 'library/xfer/TransferView';
const SR = 'library/sr/overview';
const TRACE = '@trace';

const SAMPLE_LAYOUT = load<StateBody>('state.sample.json').state.layout;

// The sample's keys are in its own order (its layout's tree order would put SR
// second); the report keeps the holder's key order, whatever it is.
const SAMPLE_TABS = tabsOf({
  keys: [LINAC, XFER, TRACE, SR],
  active: LINAC,
  layout: SAMPLE_LAYOUT,
  instances: {
    [TRACE]: { query: 'pv=SR:DIAG:DCCT:01:CURRENT:RB&range=-1h', view: null, epoch: 3 },
  },
  toolMru: [TRACE],
  history: { [LINAC]: { back: ['library/linac/LinacView?SR=2'], forward: [] } },
  closedStack: [],
});

const SAMPLE_ZOOM: Record<string, ZoomState> = {
  [LINAC]: FIT,
  [XFER]: { mode: 'manual', scale: 0.75 },
  [SR]: FIT,
};

const SAMPLE_LABELS: Record<string, string> = {
  [LINAC]: 'LINAC View',
  [XFER]: 'XFER View',
  [TRACE]: 'Data Browser',
  [SR]: 'Storage Ring',
};

function sampleState(): WorkspaceState {
  return buildState({
    tabs: SAMPLE_TABS,
    zoomOf: (key) => SAMPLE_ZOOM[key] ?? FIT,
    labelOf: (key) => SAMPLE_LABELS[key],
  });
}

describe('buildState', () => {
  it('reports the shared sample state from the viewer state behind it', () => {
    const sample = load('state.sample.json');
    const state = sampleState();
    expect(state).toEqual(sample.state);
    expect(JSON.stringify(state)).toBe(JSON.stringify(sample.state));
  });

  it('round-trips through the stub hub unchanged', async () => {
    const state = sampleState();
    expect(await stubNormalise(state)).toEqual(state);
  });

  it('reports an empty window', async () => {
    const state = buildState({ tabs: tabsOf({}), zoomOf: () => FIT });
    expect(state).toEqual({
      tabs: [],
      active: null,
      layout: null,
      zoom: {},
      instances: {},
      toolMru: [],
      labels: {},
    });
    expect(await stubNormalise(state)).toEqual(state);
  });

  it('carries zoom for open screens only, one entry per category/id', () => {
    const state = buildState({
      tabs: tabsOf({
        keys: ['a/x?N=1', 'a/x?N=2', '@trace'],
        active: 'a/x?N=1',
        instances: { '@trace': { query: '' } },
        toolMru: ['@trace'],
      }),
      zoomOf: (key) => (key === 'a/x?N=1' ? { mode: 'manual', scale: 1.254 } : FIT),
    });
    expect(state.zoom).toEqual({ 'a/x': { mode: 'manual', percent: 125 } });
  });

  it('clamps a manual zoom into the hub percent bounds', () => {
    const zoomAt = (scale: number) =>
      buildState({
        tabs: tabsOf({ keys: ['a/x'], active: 'a/x' }),
        zoomOf: () => ({ mode: 'manual', scale }),
      }).zoom['a/x'];
    expect(zoomAt(0.01)).toEqual({ mode: 'manual', percent: 10 });
    expect(zoomAt(9)).toEqual({ mode: 'manual', percent: 400 });
    expect(zoomAt(Number.NaN)).toEqual({ mode: 'fit' });
  });

  it('reports every open tool tab as an instance with a string query and an object view', async () => {
    const state = buildState({
      tabs: tabsOf({
        keys: ['@trace', '@trace/2', '@correlation'],
        active: '@trace',
        instances: {
          '@trace': { query: null },
          '@trace/2': { query: 'pv=A', view: 'v-1' },
          '@waveform': { query: 'pv=CLOSED' },
        },
        toolMru: ['@trace/2', '@waveform', '@trace', '@trace/2'],
      }),
      zoomOf: () => FIT,
      defaultQueryOf: (tool) => (tool === 'trace' ? 'range=-1h' : null),
    });
    expect(state.instances).toEqual({
      '@trace': { tool: 'trace', n: 1, query: 'range=-1h', view: null },
      '@trace/2': { tool: 'trace', n: 2, query: 'pv=A', view: { id: 'v-1' } },
      '@correlation': { tool: 'correlation', n: 1, query: '', view: null },
    });
    expect(state.toolMru).toEqual(['@trace/2', '@trace']);
    expect(state.zoom).toEqual({});
    expect(await stubNormalise(state)).toEqual(state);
  });

  it('leaves out keys that name no screen and no tool, and an active key not open', () => {
    const state = buildState({
      tabs: tabsOf({
        keys: ['a/x', '@nosuchtool', 'bare'],
        active: 'bare',
        instances: { '@nosuchtool': { query: 'x' } },
        toolMru: ['@nosuchtool'],
      }),
      zoomOf: () => FIT,
      labelOf: (key) => key,
    });
    expect(state.tabs.map((t) => t.key)).toEqual(['a/x']);
    expect(state.active).toBeNull();
    expect(state.instances).toEqual({});
    expect(state.toolMru).toEqual([]);
    expect(state.labels).toEqual({ 'a/x': 'a/x' });
  });

  it('carries labels of open keys only, trimmed and capped at the hub limit', () => {
    const long = 'é'.repeat(MAX_LABEL + 30);
    const state = buildState({
      tabs: tabsOf({ keys: ['a/x', 'a/y', 'a/z'], active: 'a/x' }),
      zoomOf: () => FIT,
      labelOf: (key) => ({ 'a/x': `  ${long}  `, 'a/y': '   ', 'b/q': 'closed' })[key],
    });
    expect(state.labels).toEqual({ 'a/x': 'é'.repeat(MAX_LABEL) });
  });

  it('reports canBack and canForward from the screen history', () => {
    const state = buildState({
      tabs: tabsOf({
        keys: ['a/x', 'a/y'],
        active: 'a/x',
        history: { 'a/y': { back: [], forward: ['a/w'] } },
      }),
      zoomOf: () => FIT,
    });
    expect(state.tabs).toEqual([
      { key: 'a/x', kind: 'screen', canBack: false, canForward: false },
      { key: 'a/y', kind: 'screen', canBack: false, canForward: true },
    ]);
  });

  it('never carries anything beyond the closed schema', () => {
    const state = sampleState();
    expect(Object.keys(state)).toEqual([
      'tabs',
      'active',
      'layout',
      'zoom',
      'instances',
      'toolMru',
      'labels',
    ]);
    for (const instance of Object.values(state.instances)) {
      expect(Object.keys(instance)).toEqual(['tool', 'n', 'query', 'view']);
    }
  });
});

describe('buildState layout', () => {
  it('is the holder layout, a root tile included', async () => {
    const tabs = tabsOf({ keys: ['a/x', 'a/y'], active: 'a/y' });
    const state = buildState({ tabs, zoomOf: () => FIT });
    expect(state.layout).toEqual({ tile: 't1', tabs: ['a/x', 'a/y'], showing: 'a/y' });
    expect(await stubNormalise(state)).toEqual(state);
  });

  it('is null exactly when no tab is open', () => {
    expect(buildState({ tabs: tabsOf({}), zoomOf: () => FIT }).layout).toBeNull();
    expect(buildState({ tabs: tabsOf({ keys: ['a/x'] }), zoomOf: () => FIT }).layout).toEqual({
      tile: 't1',
      tabs: ['a/x'],
      showing: 'a/x',
    });
  });

  it('carries no docked flag on any tab', () => {
    for (const tab of sampleState().tabs) expect(Object.keys(tab)).not.toContain('docked');
  });

  it('closes a key the report leaves out of the layout, so it holds exactly the reported tabs', async () => {
    const tabs = tabsOf({
      keys: ['a/x', 'bare', 'a/y'],
      active: 'a/x',
      layout: {
        split: 'row',
        items: [
          { tile: 't1', tabs: ['a/x', 'bare'], showing: 'a/x', size: 0.5 },
          { tile: 't2', tabs: ['a/y'], showing: 'a/y', size: 0.5 },
        ],
      },
      focusedTile: 't1',
    });
    const state = buildState({ tabs, zoomOf: () => FIT });
    expect(state.tabs.map((t) => t.key)).toEqual(['a/x', 'a/y']);
    expect(state.layout).toEqual({
      split: 'row',
      items: [
        { tile: 't1', tabs: ['a/x'], showing: 'a/x', size: 0.5 },
        { tile: 't2', tabs: ['a/y'], showing: 'a/y', size: 0.5 },
      ],
    });
    expect(await stubNormalise(state)).toEqual(state);
  });

  it('is null when every key the layout holds is left out', () => {
    const tabs = tabsOf({ keys: ['bare'], active: 'bare' });
    expect(buildState({ tabs, zoomOf: () => FIT }).layout).toBeNull();
  });
});

describe('reduceOversize', () => {
  it('reduces the shared oversize body to exactly the shared reduced body', () => {
    const oversize = load('state.oversize.json');
    const reduced = load('state.reduced.json');
    expect(bytes(oversize)).toBeGreaterThan(MAX_BODY_BYTES);
    const out = reduceOversize(oversize);
    expect(out).toEqual(reduced);
    expect(JSON.stringify(out)).toBe(JSON.stringify(reduced));
    expect(bytes(out)).toBeLessThanOrEqual(MAX_BODY_BYTES);
  });

  it('never mutates its input', () => {
    const oversize = load('state.oversize.json');
    const before = JSON.stringify(oversize);
    reduceOversize(oversize);
    expect(JSON.stringify(oversize)).toBe(before);
  });

  it('keeps the labels when dropping plot settings is enough', () => {
    const oversize = load('state.oversize.json');
    const plot = `&plot=${'p'.repeat(MAX_BODY_BYTES)}`;
    const small: StateBody = {
      windowId: 'w-A',
      seq: 1,
      shown: true,
      state: {
        ...sampleState(),
        instances: {
          '@trace': { tool: 'trace', n: 1, query: `range=-1h${plot}&pv=A`, view: null },
        },
      },
    };
    expect(oversize.state.labels).not.toEqual({});
    const out = reduceOversize(small);
    expect(out.state.instances['@trace']!.query).toBe('range=-1h&pv=A');
    expect(out.state.labels).toEqual(small.state.labels);
    expect(out.truncated).toBe(true);
    expect(Object.keys(out).at(-1)).toBe('truncated');
  });

  it('returns a body within the cap unchanged', () => {
    const sample = load('state.sample.json');
    expect(reduceOversize(sample)).toBe(sample);
  });

  it('withoutPlot drops only plot parameters, byte for byte', () => {
    expect(withoutPlot('pv=A%3AB&plot=%7B%7D&range=-1h&plot=x')).toBe('pv=A%3AB&range=-1h');
    expect(withoutPlot('plotx=1&pv=A')).toBe('plotx=1&pv=A');
    expect(withoutPlot('')).toBe('');
  });
});
