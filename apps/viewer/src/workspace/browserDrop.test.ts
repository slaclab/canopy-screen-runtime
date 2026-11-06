// A saved-view drop from the screen browser resolves only to what the row's
// click could reach: the payload is authored outside the page, so the id it
// names is checked against the listed views. Screen and tool drags resolve
// through resolveMember (collections.resolve.test.ts).
import { describe, expect, it } from 'vitest';
import { resolveViewDrop } from './browserDrop.js';
import type { SavedView } from './savedViews.js';
import { fromLayout } from './tabs.js';
import type { TabsState } from './tabs.js';

const VIEWS: SavedView[] = [
  { id: 'gun', name: 'Gun vacuum', kind: 'trace', query: 'pv=GUN:VAC&range=-1h' },
  { id: 'corr', name: 'Corr', kind: 'correlation', query: 'pv=A&range=-1h' },
];

/** `keys` as the tabs of one tile showing `shown[0]`, else its first key. */
function tabs(keys: string[], shown: string[], toolMru: string[] = []): TabsState {
  const showing = shown[0] ?? keys[0];
  const layout = showing === undefined ? null : { tile: 't1', tabs: keys, showing };
  return { ...fromLayout(layout, 't1'), toolMru };
}

const context = (state: TabsState, tools: string[] = ['trace']) => ({
  state,
  tools,
  views: VIEWS,
});

describe('resolveViewDrop', () => {
  it('the instance showing the view, else a new instance loading it', () => {
    const showing: TabsState = {
      ...tabs(['@trace', '@trace/2'], ['@trace']),
      instances: { '@trace/2': { query: 'pv=GUN:VAC&range=-1h', view: 'gun', epoch: 1 } },
    };
    expect(resolveViewDrop('gun', context(showing))).toEqual({ key: '@trace/2' });
    expect(resolveViewDrop('gun', context(tabs(['@trace'], [])))).toEqual({
      key: '@trace/2',
      load: { query: 'pv=GUN:VAC&range=-1h', view: 'gun' },
    });
  });

  it("at the tool's cap: the most recently used instance, flagged", () => {
    const keys = Array.from({ length: 10 }, (_, i) => (i === 0 ? '@trace' : `@trace/${i + 1}`));
    const state = tabs(keys, ['@trace'], ['@trace/4']);
    expect(resolveViewDrop('gun', context(state))).toEqual({
      key: '@trace/4',
      load: { query: 'pv=GUN:VAC&range=-1h', view: 'gun' },
      atCap: 'trace',
    });
  });

  it('an unlisted view, or one of a tool not served here, resolves to nothing', () => {
    expect(resolveViewDrop('nope', context(tabs([], [])))).toBeNull();
    expect(resolveViewDrop('corr', context(tabs([], [])))).toBeNull();
  });
});
