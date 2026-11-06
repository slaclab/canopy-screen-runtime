// "Save open tabs as collection…": stripMembers turns the strip into
// members (screens from their tab key; tool instances with the live query or
// the config default, named by `from` > view > a non-generic displayed title
// in that order; later duplicates dropped and listed), draftLayout adds the
// dock's layout in collection form over the members' indexes (a one-tile dock
// as a one-tile layout), and the dialog saves a new collection or replaces a
// personal one from the rows it snapshotted when it opened, offering Save as new / Cancel on a refusal. finishSave and
// focusCollectionsTrigger pin the page's success path. The last block pins
// the window menu entry that opens the dialog, and that the strip's menus do
// not offer it.

import '../test/memoryStorage.js';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Member, MemberKey } from './collections.js';
import { memberKey } from './collections.js';
import { validateLayout } from '@slaclab/canopy-dock-engine';
import type { Layout } from '@slaclab/canopy-dock-engine';
import {
  COLLECTIONS_TRIGGER,
  NO_TABS,
  SAVE_AS_NEW,
  SaveCollectionDialog,
  conflictText,
  draftLayout,
  finishSave,
  focusCollectionsTrigger,
  isGenericTitle,
  personalRows,
  rowSummary,
  stripMembers,
} from './SaveCollection.js';
import type { SavedView } from './savedViews.js';
import { EMPTY_TABS } from './tabs.js';
import type { TabsState, ToolInstance } from './tabs.js';
import { TabStrip } from './TabStrip.js';
import {
  RESET_LAYOUT,
  SAVE_AS_COLLECTION,
  WINDOW_MENU,
  WindowMenu,
  type WindowMenuProps,
} from './dock/WindowMenu.js';
import type { Collection, CollectionDraft, WriteResult } from './useCollections.js';

const css = readFileSync(createRequire(import.meta.url).resolve('./SaveCollection.css'), 'utf8');

/** The dock of `tiles` (tab keys per tile, left to right; default: one tile of `keys`). */
function dockOf(tiles: string[][]): Layout | null {
  const cells = tiles.map((tabs, i) => ({ tile: `t${i + 1}`, tabs, showing: tabs[0]! }));
  if (cells.length === 0) return null;
  if (cells.length === 1) return cells[0]!;
  return { split: 'row', items: cells.map((c) => ({ ...c, size: 1 / cells.length })) };
}

function tabs(
  keys: string[],
  instances: Record<string, ToolInstance> = {},
  tiles: string[][] = keys.length > 0 ? [keys] : []
): TabsState {
  return {
    ...EMPTY_TABS,
    keys,
    layout: dockOf(tiles),
    focusedTile: tiles.length > 0 ? 't1' : null,
    active: tiles[0]?.[0] ?? null,
    instances,
    toolMru: [],
  };
}

function collection(
  source: 'facility' | 'personal',
  id: string,
  name: string,
  members: Member[],
  extra: Partial<Collection> = {}
): Collection {
  return {
    source,
    ref: `${source}:${id}`,
    id,
    name,
    members,
    layout: null,
    default: false,
    ...extra,
  };
}

const OK: WriteResult = { ok: true, ref: 'personal:x', collection: null };

const VIEWS: SavedView[] = [{ id: 'orbit', name: 'Orbit view', kind: 'trace', query: 'pv=O' }];

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('stripMembers', () => {
  it('writes screens from their tab keys, in strip order', () => {
    const out = stripMembers(tabs(['ops/main', 'bts/bpm?SECTOR=3']), [], []);
    expect(out.members).toEqual([
      { screen: 'ops/main' },
      { screen: 'bts/bpm', macros: { SECTOR: '3' } },
    ]);
    expect(out.tabKeys).toEqual(['ops/main', 'bts/bpm?SECTOR=3']);
    expect(out.dropped).toEqual([]);
  });

  it('writes a tool instance with its live query, absent only when it and the default are blank', () => {
    const out = stripMembers(
      tabs(['@trace', '@trace/2', '@waveform', '@correlation'], {
        '@trace': { query: 'pv=A' },
        '@trace/2': { query: '' },
        '@waveform': { query: null },
        '@correlation': { query: null },
      }),
      [],
      []
    );
    expect(out.members).toEqual([
      { tool: 'trace', query: 'pv=A' },
      { tool: 'trace' },
      { tool: 'waveform' },
      { tool: 'correlation' },
    ]);
  });

  it('writes the config default for an instance on it (a restored Data Browser tab)', () => {
    const defaults: Record<string, string> = { trace: 'pv=SR:DCCT', waveform: '' };
    const toolQuery = (tool: string) => defaults[tool];
    const out = stripMembers(
      tabs(['@trace', '@trace/2', '@waveform', '@trace/3'], {
        '@trace': { query: null },
        '@trace/2': { query: '' },
        '@waveform': { query: null },
        '@trace/3': { query: 'pv=LIVE' },
      }),
      [],
      [],
      { toolQuery }
    );
    expect(out.members).toEqual([
      { tool: 'trace', query: 'pv=SR:DCCT' },
      // A cleared query over a non-blank default stays cleared.
      { tool: 'trace', query: '' },
      { tool: 'waveform' },
      { tool: 'trace', query: 'pv=LIVE' },
    ]);
  });

  it('an instance with no instance record still takes the config default', () => {
    const out = stripMembers(tabs(['@trace']), [], [], { toolQuery: () => 'pv=D' });
    expect(out.members).toEqual([{ tool: 'trace', query: 'pv=D' }]);
  });

  it('writes an instance with `from` as its origin with the live query and the first GET-order name', () => {
    const origin: Member = { tool: 'trace', query: 'pv=OLD', name: 'Second' };
    const from = memberKey(origin);
    const collections = [
      collection('facility', 'a', 'A', [{ screen: 'ops/main' }]),
      collection('facility', 'b', 'B', [{ ...origin, name: 'First' }]),
      collection('personal', 'c', 'C', [origin]),
    ];
    const out = stripMembers(
      tabs(['@trace'], { '@trace': { query: 'pv=LIVE', from } }),
      collections,
      VIEWS
    );
    expect(out.members).toEqual([{ tool: 'trace', query: 'pv=LIVE', name: 'First' }]);
  });

  it('writes no name when no collection member carries the `from` key', () => {
    const out = stripMembers(
      tabs(['@trace'], { '@trace': { query: 'pv=X', from: 'tool:trace?pv=Y' as MemberKey } }),
      [collection('facility', 'a', 'A', [{ tool: 'trace', query: 'pv=Z', name: 'Z' }])],
      []
    );
    expect(out.members).toEqual([{ tool: 'trace', query: 'pv=X' }]);
  });

  it('names an unmatched `from` by its view, then by a non-generic title', () => {
    const from = 'tool:trace?pv=Y' as MemberKey;
    const viewed = stripMembers(
      tabs(['@trace'], { '@trace': { query: 'pv=O', view: 'orbit', from } }),
      [],
      VIEWS,
      { titleOf: () => 'Ignored title' }
    );
    expect(viewed.members).toEqual([{ tool: 'trace', query: 'pv=O', name: 'Orbit view' }]);
    const titled = stripMembers(tabs(['@trace'], { '@trace': { query: 'pv=X', from } }), [], [], {
      titleOf: () => 'Gun high voltage and heater',
    });
    expect(titled.members).toEqual([
      { tool: 'trace', query: 'pv=X', name: 'Gun high voltage and heater' },
    ]);
  });

  it('the `from` name wins over the view name and the title', () => {
    const origin: Member = { tool: 'trace', query: 'pv=G', name: 'Gun high voltage and heater' };
    const out = stripMembers(
      tabs(['@trace'], { '@trace': { query: 'pv=G', view: 'orbit', from: memberKey(origin) } }),
      [collection('facility', 'inj', 'Injector', [origin])],
      VIEWS,
      { titleOf: () => 'Other' }
    );
    expect(out.members).toEqual([origin]);
  });

  it('names a tab by its displayed title, omitted when the title is generic', () => {
    const titles: Record<string, string> = {
      '@trace': 'Data Browser',
      '@trace/2': 'Data Browser 2',
      '@correlation/3': 'Correlation 3',
      '@trace/4': 'Septum scan',
    };
    const out = stripMembers(
      tabs(['@trace', '@trace/2', '@correlation/3', '@trace/4'], {
        '@trace': { query: 'pv=1' },
        '@trace/2': { query: 'pv=2' },
        '@correlation/3': { query: 'x=3' },
        '@trace/4': { query: 'pv=4' },
      }),
      [],
      [],
      { titleOf: (key) => titles[key] }
    );
    expect(out.members).toEqual([
      { tool: 'trace', query: 'pv=1' },
      { tool: 'trace', query: 'pv=2' },
      { tool: 'correlation', query: 'x=3' },
      { tool: 'trace', query: 'pv=4', name: 'Septum scan' },
    ]);
  });

  it('writes a view-loaded instance as {tool, query, name: <view name>}', () => {
    const out = stripMembers(
      tabs(['@trace'], { '@trace': { query: 'pv=O', view: 'orbit' } }),
      [],
      VIEWS
    );
    expect(out.members).toEqual([{ tool: 'trace', query: 'pv=O', name: 'Orbit view' }]);
  });

  it('drops later duplicates by member key and lists them', () => {
    const out = stripMembers(
      tabs(['@trace', 'ops/main', '@trace/2'], {
        '@trace': { query: 'pv=A' },
        '@trace/2': { query: 'pv=A', view: 'orbit' },
      }),
      [],
      VIEWS
    );
    expect(out.members).toEqual([{ tool: 'trace', query: 'pv=A' }, { screen: 'ops/main' }]);
    expect(out.tabKeys).toEqual(['@trace', 'ops/main']);
    expect(out.dropped).toEqual(['Orbit view']);
  });
});

describe('draftLayout', () => {
  const state = tabs(['ops/main', 'ops/aux', '@trace'], { '@trace': { query: 'pv=A' } }, [
    ['ops/main', 'ops/aux'],
    ['@trace'],
  ]);

  it('writes the dock in collection form over the member indexes', () => {
    const strip = stripMembers(state, [], []);
    const out = draftLayout(strip, state.layout);
    expect(out.members).toEqual([
      { screen: 'ops/main' },
      { screen: 'ops/aux' },
      { tool: 'trace', query: 'pv=A' },
    ]);
    expect(out.layout).toEqual({
      split: 'row',
      items: [
        { tabs: [0, 1], size: 0.5 },
        { tabs: [2], size: 0.5 },
      ],
    });
    expect(validateLayout(out.layout, { form: 'collection', members: 3 })).toEqual({ valid: true });
  });

  it('keeps the showing tab of each tile', () => {
    const shown: TabsState = {
      ...state,
      layout: {
        split: 'row',
        items: [
          { tile: 't1', tabs: ['ops/main', 'ops/aux'], showing: 'ops/aux', size: 0.7 },
          { tile: 't2', tabs: ['@trace'], showing: '@trace', size: 0.3, from: 't1' },
        ],
      },
    };
    const out = draftLayout(stripMembers(shown, [], []), shown.layout);
    expect(out.layout).toEqual({
      split: 'row',
      items: [
        { tabs: [0, 1], showing: 1, size: 0.7 },
        { tabs: [2], size: 0.3 },
      ],
    });
  });

  it('saves a one-tile dock as a one-tile layout', () => {
    const one = tabs(['ops/main', '@trace'], { '@trace': { query: 'pv=A' } });
    const out = draftLayout(stripMembers(one, [], []), one.layout);
    expect(out.layout).toEqual({ tabs: [0, 1] });
  });

  it('prunes a tab dropped as a duplicate, so every member is placed once', () => {
    const dup = tabs(
      ['ops/main', '@trace', '@trace/2'],
      {
        '@trace': { query: 'pv=A' },
        '@trace/2': { query: 'pv=A' },
      },
      [['ops/main'], ['@trace', '@trace/2']]
    );
    const strip = stripMembers(dup, [], []);
    expect(strip.members).toHaveLength(2);
    const out = draftLayout(strip, dup.layout);
    expect(out.layout).toEqual({
      split: 'row',
      items: [
        { tabs: [0], size: 0.5 },
        { tabs: [1], size: 0.5 },
      ],
    });
    expect(validateLayout(out.layout, { form: 'collection', members: 2 })).toEqual({ valid: true });
  });

  it('has no layout for an empty dock', () => {
    expect(draftLayout(stripMembers(EMPTY_TABS, [], []), null)).toEqual({ members: [] });
  });
});

describe('SaveCollectionDialog', () => {
  function renderDialog(
    options: {
      state?: TabsState;
      collections?: Collection[];
      onSave?: (draft: CollectionDraft, replace?: string, rev?: string) => Promise<WriteResult>;
      toolQuery?: (tool: string) => string | undefined;
      titleOf?: (key: string) => string | undefined;
    } = {}
  ) {
    const onSave = vi.fn(options.onSave ?? (async () => OK));
    const onCancel = vi.fn();
    const element = (state: TabsState, collections: Collection[]) => (
      <SaveCollectionDialog
        state={state}
        collections={collections}
        views={VIEWS}
        toolQuery={options.toolQuery}
        titleOf={options.titleOf}
        onCancel={onCancel}
        onSave={onSave}
      />
    );
    const { rerender } = render(
      element(
        options.state ?? tabs(['ops/main', '@trace'], { '@trace': { query: 'pv=A' } }),
        options.collections ?? []
      )
    );
    const input = document.getElementById('save-collection-name') as HTMLInputElement;
    const update = (state: TabsState, collections: Collection[]) =>
      rerender(element(state, collections));
    return { onSave, onCancel, input, update };
  }

  const primary = () =>
    document.querySelector<HTMLButtonElement>('.cds--modal-footer .cds--btn--primary')!;

  it('saves a new collection with exactly the strip under the typed name', async () => {
    const { onSave, input } = renderDialog();
    expect(screen.getByTestId('save-collection-summary').textContent).toContain('2 members');
    fireEvent.change(input, { target: { value: '  Morning  ' } });
    expect(primary().textContent).toBe('Save');
    fireEvent.click(primary());
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith(
      { name: 'Morning', members: [{ screen: 'ops/main' }, { tool: 'trace', query: 'pv=A' }] },
      undefined,
      undefined
    );
  });

  it('refuses an empty name and an empty strip', () => {
    const { onSave, input } = renderDialog();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSave).not.toHaveBeenCalled();
    cleanup();
    renderDialog({ state: tabs([]) });
    expect(screen.getByTestId('save-collection-summary').textContent).toBe(NO_TABS);
    expect(primary().disabled).toBe(true);
  });

  it('lists the duplicates it drops', () => {
    renderDialog({
      state: tabs(['@trace', '@trace/2'], {
        '@trace': { query: 'pv=O' },
        '@trace/2': { query: 'pv=O', view: 'orbit' },
      }),
    });
    expect(screen.getByTestId('save-collection-dropped').textContent).toContain('Orbit view');
  });

  it('replaces a picked personal collection, confirmed by the Replace button and a warning', async () => {
    const collections = [
      collection('facility', 'f', 'Facility one', []),
      collection('personal', 'mine', 'Mine', [{ screen: 'ops/old' }], { rev: 'r1' }),
    ];
    const { onSave, input } = renderDialog({ collections });
    const select = document.getElementById('save-collection-target') as HTMLSelectElement;
    const options = Array.from(select.options).map((o) => o.textContent);
    expect(options).toEqual(['A new collection', 'Mine · 1']);
    fireEvent.change(select, { target: { value: 'mine' } });
    expect(input.value).toBe('Mine');
    expect(primary().textContent).toBe('Replace');
    expect(document.body.textContent).toContain('Replaces the collection “Mine”');
    fireEvent.click(primary());
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]![1]).toBe('mine');
    expect(onSave.mock.calls[0]![2]).toBe('r1');
    expect(onSave.mock.calls[0]![0].members).toEqual([
      { screen: 'ops/main' },
      { tool: 'trace', query: 'pv=A' },
    ]);
  });

  it('lists each personal row as "<name> · N · <when>", the full text in its title', () => {
    const updated = '2026-03-04T05:06:00Z';
    const collections = [
      collection('personal', 'a', 'Same', [{ screen: 'ops/a' }, { screen: 'ops/b' }], { updated }),
      collection('personal', 'a-2', 'Same', [{ screen: 'ops/c' }]),
    ];
    renderDialog({ collections });
    const select = document.getElementById('save-collection-target') as HTMLSelectElement;
    const rows = Array.from(select.options).slice(1);
    const first = rowSummary({ id: 'a', name: 'Same', memberCount: 2, updated });
    expect(first).toMatch(/^Same · 2 · \S/);
    expect(rows.map((o) => o.textContent)).toEqual([first, 'Same · 1']);
    expect(rows.map((o) => o.getAttribute('title'))).toEqual([first, 'Same · 1']);
  });

  it('builds the Replace dropdown and its target from the rows seen at open', async () => {
    const opened = [collection('personal', 'mine', 'Mine', [{ screen: 'ops/old' }], { rev: 'r1' })];
    const state = tabs(['ops/main']);
    const { onSave, update } = renderDialog({ state, collections: opened });
    // Meanwhile the list moved on: Mine changed (r2), Other appeared.
    update(state, [
      collection('personal', 'mine', 'Mine renamed', [], { rev: 'r2' }),
      collection('personal', 'other', 'Other', []),
    ]);
    const select = document.getElementById('save-collection-target') as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual([
      'A new collection',
      'Mine · 1',
    ]);
    fireEvent.change(select, { target: { value: 'mine' } });
    fireEvent.click(primary());
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]!.slice(1)).toEqual(['mine', 'r1']);
  });

  it('a row deleted meanwhile still replaces with its rev', async () => {
    const state = tabs(['ops/main']);
    const { onSave, update } = renderDialog({
      state,
      collections: [collection('personal', 'gone', 'Gone', [], { rev: 'r9' })],
    });
    update(state, []);
    const select = document.getElementById('save-collection-target') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'gone' } });
    fireEvent.click(primary());
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]!.slice(1)).toEqual(['gone', 'r9']);
  });

  it('a refused replace offers Save as new / Cancel and then saves as new', async () => {
    const state = tabs(['ops/main']);
    const results: WriteResult[] = [{ ok: false, reason: 'stale', status: 412 }, OK];
    const { onSave, onCancel, update } = renderDialog({
      state,
      collections: [collection('personal', 'mine', 'Mine', [], { rev: 'r1' })],
      onSave: async () => results.shift()!,
    });
    const select = document.getElementById('save-collection-target') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'mine' } });
    fireEvent.click(primary());
    const note = await screen.findByTestId('save-collection-conflict');
    expect(note.textContent).toContain(`${conflictText('stale', 'Mine')} Save as new or cancel.`);
    expect(primary().textContent).toBe(SAVE_AS_NEW);
    const cancel = document.querySelector<HTMLButtonElement>(
      '.cds--modal-footer .cds--btn--secondary'
    )!;
    expect(cancel.textContent).toBe('Cancel');
    // The dialog follows the refetched list while the refusal shows.
    update(state, [collection('personal', 'mine', 'Mine', [{ screen: 'ops/x' }], { rev: 'r2' })]);
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual([
      'A new collection',
      'Mine · 1',
    ]);
    fireEvent.click(primary());
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect(onSave.mock.calls[1]![0].name).toBe('Mine');
    expect(onSave.mock.calls[1]!.slice(1)).toEqual([undefined, undefined]);
    await waitFor(() => expect(screen.queryByTestId('save-collection-conflict')).toBeNull());
    fireEvent.click(cancel);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('a refused new save (412 exists after the retries) offers Save as new too', async () => {
    const { input } = renderDialog({
      onSave: async () => ({ ok: false, reason: 'exists', status: 412 }),
    });
    fireEvent.change(input, { target: { value: 'Race' } });
    fireEvent.click(primary());
    expect((await screen.findByTestId('save-collection-conflict')).textContent).toContain(
      conflictText('exists', undefined)
    );
    expect(primary().textContent).toBe(SAVE_AS_NEW);
  });

  it('builds the members at submit, from the strip as it is then', async () => {
    const { onSave, input, update } = renderDialog({
      state: tabs(['@trace'], { '@trace': { query: 'pv=OLD' } }),
      toolQuery: () => 'pv=DEFAULT',
      titleOf: (key) => (key === '@trace' ? 'Gun high voltage and heater' : undefined),
    });
    update(tabs(['@trace', 'ops/main'], { '@trace': { query: 'pv=NEW' } }), []);
    fireEvent.change(input, { target: { value: 'Now' } });
    fireEvent.click(primary());
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]![0].members).toEqual([
      { tool: 'trace', query: 'pv=NEW', name: 'Gun high voltage and heater' },
      { screen: 'ops/main' },
    ]);
  });

  it('saves a restored Data Browser tab with the config default PVs', async () => {
    const { onSave, input } = renderDialog({
      state: tabs(['@trace'], { '@trace': { query: null } }),
      toolQuery: (tool) => (tool === 'trace' ? 'pv=SR:DCCT' : undefined),
      titleOf: () => 'Data Browser',
    });
    fireEvent.change(input, { target: { value: 'Restored' } });
    fireEvent.click(primary());
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]![0].members).toEqual([{ tool: 'trace', query: 'pv=SR:DCCT' }]);
  });

  it('includes the layout when asked', async () => {
    const { onSave, input } = renderDialog({
      state: tabs(['ops/main', '@trace'], { '@trace': { query: 'pv=A' } }, [
        ['ops/main'],
        ['@trace'],
      ]),
    });
    fireEvent.change(input, { target: { value: 'Laid out' } });
    fireEvent.click(screen.getByLabelText('Include layout'));
    fireEvent.click(primary());
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const draft = onSave.mock.calls[0]![0];
    expect(draft.members).toEqual([{ screen: 'ops/main' }, { tool: 'trace', query: 'pv=A' }]);
    expect(draft.layout).toEqual({
      split: 'row',
      items: [
        { tabs: [0], size: 0.5 },
        { tabs: [1], size: 0.5 },
      ],
    });
  });

  it('includes a one-tile layout', async () => {
    const { onSave, input } = renderDialog();
    fireEvent.change(input, { target: { value: 'One tile' } });
    fireEvent.click(screen.getByLabelText('Include layout'));
    fireEvent.click(primary());
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]![0].layout).toEqual({ tabs: [0, 1] });
  });

  it('saves no layout unless asked', async () => {
    const { onSave, input } = renderDialog();
    fireEvent.change(input, { target: { value: 'Plain' } });
    fireEvent.click(primary());
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]![0].layout).toBeUndefined();
  });

  it('shows no layout option for an empty dock', () => {
    renderDialog({ state: tabs([]) });
    expect(screen.queryByLabelText('Include layout')).toBeNull();
  });

  it('shows a failed save as its error', async () => {
    const { input } = renderDialog({
      onSave: async () => {
        throw new Error('Could not save the collection: read_only_store');
      },
    });
    fireEvent.change(input, { target: { value: 'X' } });
    fireEvent.click(primary());
    expect(await screen.findByText('Could not save the collection: read_only_store')).toBeTruthy();
  });

  it('sizes its text from the canopy tokens only', () => {
    const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of bare.matchAll(/font-size:\s*([^;]+);/g)) {
      expect(m[1]).toMatch(/^var\(--canopy-text-/);
    }
  });
});

describe('isGenericTitle', () => {
  it('knows a tool label and its numbered instances, nothing else', () => {
    expect(isGenericTitle('Data Browser', 'trace')).toBe(true);
    expect(isGenericTitle('Data Browser 12', 'trace')).toBe(true);
    expect(isGenericTitle('Correlation 3', 'correlation')).toBe(true);
    expect(isGenericTitle('Data Browser 0', 'trace')).toBe(false);
    expect(isGenericTitle('Data Browser scan', 'trace')).toBe(false);
    expect(isGenericTitle('Orbit', 'trace')).toBe(false);
  });
});

describe('personalRows', () => {
  it('snapshots {id, name, rev, updated, memberCount} of the personal collections only', () => {
    expect(
      personalRows([
        collection('facility', 'f', 'F', [{ screen: 'ops/a' }], { rev: 'rf' }),
        collection('personal', 'p', 'P', [{ screen: 'ops/a' }, { screen: 'ops/b' }], {
          rev: 'r1',
          updated: '2026-01-01T00:00:00Z',
        }),
        collection('personal', 'q', 'Q', []),
      ])
    ).toEqual([
      { id: 'p', name: 'P', rev: 'r1', updated: '2026-01-01T00:00:00Z', memberCount: 2 },
      { id: 'q', name: 'Q', memberCount: 0 },
    ]);
  });
});

describe('finishSave and focusCollectionsTrigger', () => {
  it('on success says Saved “<name>”, ticks the collection and closes the dialog', async () => {
    const show = vi.fn();
    const tick = vi.fn(async () => {});
    const close = vi.fn();
    const result: WriteResult = { ok: true, ref: 'personal:morning-2', collection: null };
    expect(finishSave(result, '  Morning ', { show, tick, close })).toBe(result);
    expect(show).toHaveBeenCalledWith({ message: 'Saved “Morning”' });
    expect(tick).toHaveBeenCalledWith('personal:morning-2');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('names the toast after the stored collection when the answer carries it', () => {
    const show = vi.fn();
    const stored = collection('personal', 'm', 'Stored name', []);
    finishSave({ ok: true, ref: 'personal:m', collection: stored }, 'typed', {
      show,
      tick: async () => {},
      close: () => {},
    });
    expect(show).toHaveBeenCalledWith({ message: 'Saved “Stored name”' });
  });

  it('leaves the dialog open, untouched, on a refusal', () => {
    const show = vi.fn();
    const tick = vi.fn(async () => {});
    const close = vi.fn();
    const result: WriteResult = { ok: false, reason: 'gone', status: 412 };
    expect(finishSave(result, 'X', { show, tick, close })).toBe(result);
    expect(show).not.toHaveBeenCalled();
    expect(tick).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it('survives a failed tick', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const close = vi.fn();
    finishSave(OK, 'X', {
      show: () => {},
      tick: () => Promise.reject(new Error('down')),
      close,
    });
    expect(close).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(warn).toHaveBeenCalled());
    warn.mockRestore();
  });

  it('focuses the Collections trigger when it is on the page', () => {
    const { container } = render(
      <div>
        <button type="button">Other</button>
        <button type="button" data-testid="collections-popover-trigger">
          Collections
        </button>
      </div>
    );
    expect(container.querySelector(COLLECTIONS_TRIGGER)).not.toBeNull();
    expect(focusCollectionsTrigger()).toBe(true);
    expect(document.activeElement?.textContent).toBe('Collections');
    cleanup();
    expect(focusCollectionsTrigger()).toBe(false);
  });
});

// "Save open tabs as collection…" lives in the window menu (☰); the strip's
// menus do not offer it.
describe('Window menu "Save open tabs as collection…"', () => {
  const TABS = [
    { key: 'ops/main', title: 'Main' },
    { key: '@trace', title: 'Trace' },
  ];
  const original = Element.prototype.scrollIntoView;
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn() as unknown as Element['scrollIntoView'];
  });
  afterEach(() => {
    Element.prototype.scrollIntoView = original;
  });

  async function labels() {
    await screen.findAllByRole('menuitem');
    return screen.getAllByRole('menuitem').map((item) => ({
      label: item.getAttribute('title') ?? item.textContent ?? '',
      disabled: item.getAttribute('aria-disabled') === 'true',
    }));
  }

  /** The ☰ with its open state held as the page holds it. */
  function Menu(props: Omit<WindowMenuProps, 'open' | 'onOpenChange'>) {
    const [open, setOpen] = useState(false);
    return <WindowMenu open={open} onOpenChange={setOpen} {...props} />;
  }

  function openMenu() {
    fireEvent.click(screen.getByRole('button', { name: WINDOW_MENU }));
  }

  it('is offered in the window menu after Reset layout, and asks for the dialog', async () => {
    const onSave = vi.fn();
    render(<Menu tabCount={TABS.length} onReset={vi.fn()} onSaveAsCollection={onSave} />);
    openMenu();
    expect((await labels()).slice(0, 2)).toEqual([
      { label: RESET_LAYOUT, disabled: false },
      { label: SAVE_AS_COLLECTION, disabled: false },
    ]);
    fireEvent.click(screen.getByRole('menuitem', { name: SAVE_AS_COLLECTION }));
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('is disabled with no tab open, absent without the callback, and never on the strip', async () => {
    const onSave = vi.fn();
    render(<Menu tabCount={0} onSaveAsCollection={onSave} />);
    openMenu();
    expect(await labels()).toEqual([{ label: SAVE_AS_COLLECTION, disabled: true }]);
    fireEvent.click(screen.getByRole('menuitem', { name: SAVE_AS_COLLECTION }));
    expect(onSave).not.toHaveBeenCalled();
    cleanup();
    render(<Menu tabCount={TABS.length} onCloseAll={vi.fn()} />);
    openMenu();
    expect((await labels()).map((l) => l.label)).not.toContain(SAVE_AS_COLLECTION);
    cleanup();
    render(<TabStrip tabs={TABS} activeKey="ops/main" onFocus={vi.fn()} onClose={vi.fn()} />);
    fireEvent.contextMenu(screen.getAllByRole('tab')[1]!);
    expect((await labels()).map((l) => l.label)).not.toContain(SAVE_AS_COLLECTION);
    cleanup();
    render(<TabStrip tabs={TABS} activeKey="ops/main" onFocus={vi.fn()} onClose={vi.fn()} />);
    fireEvent.contextMenu(screen.getByRole('tablist'));
    expect(screen.queryAllByRole('menuitem')).toHaveLength(0);
  });
});
