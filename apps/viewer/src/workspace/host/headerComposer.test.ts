// headerComposer: the replay contract for the host tile bar and its ⋯ menu.
// One expected list per tab kind, the multi-tile bar, the workspace-verb
// gates, each unhealthy subtitle, the zoom labels and the 12-entry cap, on
// both platforms.

import { describe, expect, it } from 'vitest';
import type { ScreenVerbView } from '../../screenActions/useScreenActions.js';
import { CONNECTION_HEALTH_LABELS, type UnhealthyConnection } from '../connectionHealth.js';
import {
  composeHeader,
  composeMoreEntries,
  formatToolShortcut,
  type HeaderInput,
} from './headerComposer.js';
import type { HeaderItem, HeaderMenuItem } from './hostBridge.js';
import type { ToolActionEntry, ToolActionsReport } from '../toolActionsStore.js';

function report(actions: ToolActionEntry[], state?: string): ToolActionsReport {
  return { version: 1, state, actions, links: {} };
}

const TRACE_ACTIONS: ToolActionEntry[] = [
  { id: 'import', label: 'Import…', kind: 'button', shortcut: 'primary+O' },
  { id: 'export-csv', label: 'Export CSV', kind: 'button' },
  { id: 'export-png', label: 'Export PNG', kind: 'button', shortcut: 'primary+I' },
  { id: 'export-trace', label: 'Export trace file', kind: 'button' },
  { id: 'print', label: 'Print', kind: 'button', shortcut: 'primary+P' },
  { id: 'post-elog', label: 'Post to E-Log', kind: 'button', shortcut: 'primary+E' },
  { id: 'plots-grid', label: 'Plots as grid', kind: 'toggle', pressed: true },
];
const TRACE_NO_ELOG = TRACE_ACTIONS.filter((a) => a.id !== 'post-elog');

const CORRELATION_ACTIONS: ToolActionEntry[] = [
  { id: 'export-csv', label: 'Export CSV', kind: 'button' },
  {
    id: 'export-png',
    label: 'Export PNG',
    kind: 'button',
    shortcut: 'primary+I',
    disabled: 'No data yet',
  },
  { id: 'post-elog', label: 'Post to E-Log', kind: 'button', shortcut: 'primary+E' },
];
const WAVEFORM_ACTIONS: ToolActionEntry[] = [
  { id: 'export-csv', label: 'Export CSV', kind: 'button' },
  { id: 'export-png', label: 'Export PNG', kind: 'button', shortcut: 'primary+I' },
];

function view(over: Partial<ScreenVerbView> = {}): ScreenVerbView {
  return {
    canGoBack: true,
    canGoForward: false,
    verbs: [
      { id: 'plot-data-browser', available: true },
      { id: 'reload', available: true },
      { id: 'download', available: true },
      { id: 'export-png', available: true },
      { id: 'print', available: true },
      { id: 'copy-link', available: true },
    ],
    zoom: { scale: 1, fit: false },
    download: { available: true },
    ...over,
  };
}

function toolInput(
  title: string,
  toolActions: ToolActionsReport | null,
  over: Partial<HeaderInput> = {}
): HeaderInput {
  return {
    activeTab: { kind: 'tool', title },
    screenView: null,
    toolActions,
    savedViewsEnabled: true,
    collectionsEnabled: true,
    dockAvailable: true,
    resetDisabled: false,
    multiTile: false,
    health: 'healthy',
    showSubScreens: false,
    mac: true,
    ...over,
  };
}

function screenInput(
  macros: Record<string, string> | undefined,
  over: Partial<HeaderInput> = {}
): HeaderInput {
  return {
    activeTab: { kind: 'screen', title: 'BTS View', id: 'bts/BTSView', macros },
    screenView: view(),
    toolActions: null,
    savedViewsEnabled: true,
    collectionsEnabled: true,
    dockAvailable: true,
    resetDisabled: false,
    multiTile: false,
    health: 'healthy',
    showSubScreens: true,
    mac: true,
    ...over,
  };
}

const ids = (items: HeaderItem[]) => items.map((i) => i.id);
const more = (items: HeaderItem[]) => items.find((i) => i.id === 'more') as HeaderMenuItem;
const labels = (items: HeaderItem[]) => more(items).items.map((e) => e.label);
const subtitle = (items: HeaderItem[]) =>
  (items[0] as { kind: string; text: string }).kind === 'text'
    ? (items[0] as { text: string }).text
    : null;

const SEARCH_MAC = { kind: 'button', id: 'search', priority: 1, label: 'Search ⌘K' };
const SAVE_VIEW_MAC = {
  kind: 'button',
  id: 'save-view',
  priority: 3,
  label: 'Save view',
  title: 'Save view (⌘S)',
  tone: 'accent',
};
const WORKSPACE_TAIL = [
  { id: 'menu:reset-layout', label: 'Reset layout', disabled: false },
  { id: 'menu:show-sub-screens', label: 'Show sub-screens', checked: false },
  { id: 'menu:collections', label: 'Collections…' },
];
const SAVE_COLLECTION = { id: 'menu:save-collection', label: 'Save open tabs as collection…' };

describe('composeHeader — tool tabs', () => {
  it('Trace with E-Log and saved views: subtitle · Search · ⋯ · Save view', () => {
    const items = composeHeader(toolInput('Trace', report(TRACE_ACTIONS, '2 curves · live')));
    expect(items).toEqual([
      { kind: 'text', id: 'subtitle', priority: 4, text: 'Trace · 2 curves · live' },
      SEARCH_MAC,
      {
        kind: 'menu',
        id: 'more',
        priority: 0,
        label: 'More actions',
        items: [
          SAVE_COLLECTION,
          { id: 'tool:import', label: 'Import… ⌘O', disabled: false },
          { id: 'tool:export-csv', label: 'Export CSV', disabled: false },
          { id: 'tool:export-png', label: 'Export PNG ⌘I', disabled: false },
          { id: 'tool:export-trace', label: 'Export trace file', disabled: false },
          { id: 'tool:print', label: 'Print ⌘P', disabled: false },
          { id: 'tool:post-elog', label: 'Post to E-Log ⌘E', disabled: false },
          { id: 'tool:plots-grid', label: 'Plots as grid', checked: true, disabled: false },
          ...WORKSPACE_TAIL,
        ],
      },
      SAVE_VIEW_MAC,
    ]);
    expect(more(items).items).toHaveLength(11);
  });

  it('Trace without E-Log and without saved views: no E-Log entry, no Save view', () => {
    const items = composeHeader(
      toolInput('Trace', report(TRACE_NO_ELOG), { savedViewsEnabled: false })
    );
    expect(ids(items)).toEqual(['subtitle', 'search', 'more']);
    expect(subtitle(items)).toBe('Trace');
    expect(labels(items)).toEqual([
      'Save open tabs as collection…',
      'Import… ⌘O',
      'Export CSV',
      'Export PNG ⌘I',
      'Export trace file',
      'Print ⌘P',
      'Plots as grid',
      'Reset layout',
      'Show sub-screens',
      'Collections…',
    ]);
  });

  it('Correlation: a reported reason becomes a boolean disabled', () => {
    const items = composeHeader(toolInput('Correlation', report(CORRELATION_ACTIONS, 'paused')));
    expect(subtitle(items)).toBe('Correlation · paused');
    expect(more(items).items).toEqual([
      SAVE_COLLECTION,
      { id: 'tool:export-csv', label: 'Export CSV', disabled: false },
      { id: 'tool:export-png', label: 'Export PNG ⌘I', disabled: true },
      { id: 'tool:post-elog', label: 'Post to E-Log ⌘E', disabled: false },
      ...WORKSPACE_TAIL,
    ]);
    expect(ids(items)).toEqual(['subtitle', 'search', 'more', 'save-view']);
  });

  it('Waveform', () => {
    const items = composeHeader(toolInput('Waveform', report(WAVEFORM_ACTIONS)));
    expect(labels(items)).toEqual([
      'Save open tabs as collection…',
      'Export CSV',
      'Export PNG ⌘I',
      'Reset layout',
      'Show sub-screens',
      'Collections…',
    ]);
  });

  it('a tool that has not reported shows only the workspace entries', () => {
    const items = composeHeader(toolInput('Trace', null));
    expect(subtitle(items)).toBe('Trace');
    expect(labels(items)).toEqual([
      'Save open tabs as collection…',
      'Reset layout',
      'Show sub-screens',
      'Collections…',
    ]);
  });
});

describe('composeHeader — screen tabs', () => {
  it('screen with macros: macros-first subtitle, verb order, zoom and Download in ⋯', () => {
    const items = composeHeader(screenInput({ SECTOR: '3', DEV: 'BPM1' }));
    expect(items).toEqual([
      { kind: 'text', id: 'subtitle', priority: 4, text: 'SECTOR=3, DEV=BPM1 · BTS View' },
      { kind: 'button', id: 'nav-back', priority: 2, label: '◀', title: 'Back', disabled: false },
      {
        kind: 'button',
        id: 'nav-forward',
        priority: 2,
        label: '▶',
        title: 'Forward',
        disabled: true,
      },
      {
        kind: 'button',
        id: 'screen:reload',
        priority: 2,
        label: 'Reload',
        title: 'Reload',
        disabled: false,
      },
      {
        kind: 'button',
        id: 'screen:export-png',
        priority: 2,
        label: 'Export PNG',
        title: 'Export PNG (⌘I)',
        disabled: false,
      },
      {
        kind: 'button',
        id: 'screen:print',
        priority: 2,
        label: 'Print',
        title: 'Print (⌘P)',
        disabled: false,
      },
      {
        kind: 'button',
        id: 'screen:plot-data-browser',
        priority: 2,
        label: 'Plot in Data Browser',
        title: 'Plot in Data Browser',
        disabled: false,
      },
      {
        kind: 'button',
        id: 'screen:copy-link',
        priority: 2,
        label: 'Copy link',
        title: 'Copy link',
        disabled: false,
      },
      SEARCH_MAC,
      {
        kind: 'menu',
        id: 'more',
        priority: 0,
        label: 'More actions',
        items: [
          SAVE_COLLECTION,
          { id: 'menu:download-screen', label: 'Download screen ⌘S', disabled: false },
          { id: 'menu:zoom-in', label: 'Zoom in · 100%' },
          { id: 'menu:zoom-out', label: 'Zoom out · 100%' },
          { id: 'menu:zoom-fit', label: 'Fit', checked: false },
          { id: 'menu:zoom-100', label: '100%', checked: true },
          { id: 'menu:reset-layout', label: 'Reset layout', disabled: false },
          { id: 'menu:show-sub-screens', label: 'Show sub-screens', checked: true },
          { id: 'menu:collections', label: 'Collections…' },
        ],
      },
    ]);
    expect(items).toHaveLength(10);
    expect(ids(items)).not.toContain('save-view');
    expect(ids(items)).not.toContain('screen:download');
  });

  it('screen without macros leads with its id', () => {
    expect(subtitle(composeHeader(screenInput(undefined)))).toBe('bts/BTSView · BTS View');
    expect(subtitle(composeHeader(screenInput({})))).toBe('bts/BTSView · BTS View');
  });

  it('Plot in Data Browser is omitted when unconfigured; other unavailable verbs are disabled', () => {
    const items = composeHeader(
      screenInput(undefined, {
        screenView: view({
          canGoBack: false,
          verbs: [
            { id: 'plot-data-browser', available: false },
            { id: 'reload', available: true },
            { id: 'export-png', available: false },
            { id: 'print', available: true },
            { id: 'copy-link', available: true },
          ],
          download: { available: false },
        }),
      })
    );
    expect(ids(items)).toEqual([
      'subtitle',
      'nav-back',
      'nav-forward',
      'screen:reload',
      'screen:export-png',
      'screen:print',
      'screen:copy-link',
      'search',
      'more',
    ]);
    const byId = new Map(items.map((i) => [i.id, i]));
    expect((byId.get('nav-back') as { disabled: boolean }).disabled).toBe(true);
    expect((byId.get('screen:export-png') as { disabled: boolean }).disabled).toBe(true);
    expect(more(items).items.find((e) => e.id === 'menu:download-screen')?.disabled).toBe(true);
  });

  it('a screen that has not reported its view has no verbs and no screen entries', () => {
    const items = composeHeader(screenInput(undefined, { screenView: null }));
    expect(ids(items)).toEqual(['subtitle', 'search', 'more']);
    expect(labels(items)).toEqual([
      'Save open tabs as collection…',
      'Reset layout',
      'Show sub-screens',
      'Collections…',
    ]);
  });

  it('zoom labels carry the current percentage; Fit and 100% check when active', () => {
    const zoomed = more(
      composeHeader(
        screenInput(undefined, { screenView: view({ zoom: { scale: 0.8, fit: false } }) })
      )
    );
    expect(zoomed.items.slice(2, 6)).toEqual([
      { id: 'menu:zoom-in', label: 'Zoom in · 80%' },
      { id: 'menu:zoom-out', label: 'Zoom out · 80%' },
      { id: 'menu:zoom-fit', label: 'Fit', checked: false },
      { id: 'menu:zoom-100', label: '100%', checked: false },
    ]);
    const fit = more(
      composeHeader(screenInput(undefined, { screenView: view({ zoom: { scale: 1, fit: true } }) }))
    );
    expect(fit.items.slice(4, 6)).toEqual([
      { id: 'menu:zoom-fit', label: 'Fit', checked: true },
      { id: 'menu:zoom-100', label: '100%', checked: false },
    ]);
    const odd = more(
      composeHeader(
        screenInput(undefined, { screenView: view({ zoom: { scale: 1.254, fit: false } }) })
      )
    );
    expect(odd.items[2].label).toBe('Zoom in · 125%');
  });
});

describe('composeHeader — multi-tile', () => {
  it('a tool tile: subtitle · Search · ⋯ only, no Save view', () => {
    const items = composeHeader(
      toolInput('Trace', report(TRACE_ACTIONS, 'live'), { multiTile: true })
    );
    expect(ids(items)).toEqual(['subtitle', 'search', 'more']);
    expect(subtitle(items)).toBe('Trace · live');
  });

  it('a screen tile: no nav or verb buttons', () => {
    const items = composeHeader(screenInput({ S: '1' }, { multiTile: true }));
    expect(ids(items)).toEqual(['subtitle', 'search', 'more']);
    expect(subtitle(items)).toBe('S=1 · BTS View');
  });
});

describe('composeHeader — workspace verb gates', () => {
  it('no collections: no Save open tabs as collection…, no Collections…', () => {
    const items = composeHeader(
      toolInput('Waveform', report(WAVEFORM_ACTIONS), { collectionsEnabled: false })
    );
    expect(labels(items)).toEqual([
      'Export CSV',
      'Export PNG ⌘I',
      'Reset layout',
      'Show sub-screens',
    ]);
  });

  it('no dock: no Reset layout', () => {
    const items = composeHeader(screenInput(undefined, { dockAvailable: false, screenView: null }));
    expect(labels(items)).toEqual([
      'Save open tabs as collection…',
      'Show sub-screens',
      'Collections…',
    ]);
  });

  it('Reset layout is disabled when resetDisabled holds', () => {
    const items = composeHeader(toolInput('Trace', null, { resetDisabled: true }));
    expect(more(items).items.find((e) => e.id === 'menu:reset-layout')).toEqual({
      id: 'menu:reset-layout',
      label: 'Reset layout',
      disabled: true,
    });
  });

  it('Show sub-screens mirrors the store', () => {
    const on = more(composeHeader(toolInput('Trace', null, { showSubScreens: true })));
    expect(on.items.find((e) => e.id === 'menu:show-sub-screens')?.checked).toBe(true);
  });

  it('no active tab: subtitle empty, Search and the workspace ⋯ remain', () => {
    const items = composeHeader({ ...toolInput('x', null), activeTab: null });
    expect(ids(items)).toEqual(['subtitle', 'search', 'more']);
    expect(subtitle(items)).toBe('');
  });
});

describe('composeHeader — connection health', () => {
  const states = Object.keys(CONNECTION_HEALTH_LABELS) as UnhealthyConnection[];

  it.each(states)('%s: state leads the tool subtitle and replaces the reported state', (state) => {
    const items = composeHeader(
      toolInput('Trace', report(TRACE_ACTIONS, '2 curves · live'), { health: state })
    );
    expect(subtitle(items)).toBe(`${CONNECTION_HEALTH_LABELS[state]} · Trace`);
  });

  it.each(states)('%s: state leads the screen subtitle before the fragment', (state) => {
    const items = composeHeader(screenInput({ SECTOR: '3' }, { health: state }));
    expect(subtitle(items)).toBe(`${CONNECTION_HEALTH_LABELS[state]} · SECTOR=3`);
  });

  it('the exact five strings', () => {
    expect(
      states.map((s) => subtitle(composeHeader(toolInput('Trace', null, { health: s }))))
    ).toEqual([
      'Disconnected · Trace',
      'No data connection · Trace',
      'Not answering · Trace',
      'Fallback (no target record) · Trace',
      'Cannot be served · Trace',
    ]);
  });
});

describe('composeHeader — 12-entry cap', () => {
  it('drops from the bottom of the ⋯ order, never the top', () => {
    const many: ToolActionEntry[] = Array.from({ length: 10 }, (_, i) => ({
      id: `a${i}`,
      label: `Action ${i}`,
      kind: 'button' as const,
    }));
    const entries = composeMoreEntries(toolInput('Trace', report(many)));
    expect(entries).toHaveLength(12);
    expect(entries[0].id).toBe('menu:save-collection');
    expect(entries.map((e) => e.id).slice(-2)).toEqual(['tool:a9', 'menu:reset-layout']);
    expect(entries.map((e) => e.id)).not.toContain('menu:show-sub-screens');
    expect(entries.map((e) => e.id)).not.toContain('menu:collections');
  });
});

describe('composeHeader — platforms', () => {
  it('non-mac formats every shortcut as Ctrl+/Alt+', () => {
    const tool = composeHeader(toolInput('Trace', report(TRACE_ACTIONS), { mac: false }));
    expect(tool.find((i) => i.id === 'search')).toMatchObject({ label: 'Search Ctrl+K' });
    expect(tool.find((i) => i.id === 'save-view')).toMatchObject({ title: 'Save view (Ctrl+S)' });
    expect(labels(tool)).toContain('Import… Ctrl+O');
    expect(labels(tool)).toContain('Post to E-Log Ctrl+E');

    const screen = composeHeader(screenInput(undefined, { mac: false }));
    expect(labels(screen)).toContain('Download screen Ctrl+S');
    expect(screen.find((i) => i.id === 'screen:export-png')).toMatchObject({
      title: 'Export PNG (Ctrl+I)',
    });
    expect(screen.find((i) => i.id === 'screen:print')).toMatchObject({ title: 'Print (Ctrl+P)' });
  });

  it('formatToolShortcut parses the reported shortcut grammar', () => {
    expect(formatToolShortcut('primary+O', true)).toBe('⌘O');
    expect(formatToolShortcut('primary+o', false)).toBe('Ctrl+O');
    expect(formatToolShortcut('alt+D', true)).toBe('⌥D');
    expect(formatToolShortcut('alt+d', false)).toBe('Alt+D');
    expect(formatToolShortcut('shift+X', true)).toBe('');
    expect(formatToolShortcut(undefined, true)).toBe('');
  });

  it('an Alt shortcut lands in the entry label', () => {
    const items = composeHeader(
      toolInput(
        'Trace',
        report([{ id: 'inspect', label: 'Inspect data', kind: 'button', shortcut: 'alt+D' }])
      )
    );
    expect(labels(items)).toContain('Inspect data ⌥D');
  });
});
