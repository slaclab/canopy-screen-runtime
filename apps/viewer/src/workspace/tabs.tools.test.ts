// Tool instances in the tab model: the key grammar (tools.ts), per
// instance {query, view, epoch}, toolMru, the cap, the opening rules the
// reducer owns, and the stored instances record.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config.js';
import {
  EMPTY_TABS,
  tabsStorageKey,
  canOpen,
  fromLayout,
  loadTabs,
  mruInstance,
  readTabs,
  tabsReducer,
  viewInstance,
  writeTabs,
  type TabsAction,
  type TabsState,
} from './tabs.js';
import {
  MAX_TOOL_INSTANCES,
  TOOLS,
  configuredTools,
  instanceLabel,
  isToolKey,
  parseToolKey,
  toolConfig,
  toolKey,
  toolSpec,
} from './tools.js';

function run(state: TabsState, ...actions: TabsAction[]): TabsState {
  return actions.reduce(tabsReducer, state);
}

/** Open `keys` as the tabs of one tile showing `active` (@slaclab/canopy-dock-engine); [] is an empty dock. */
function tabs(keys: string[], active: string | null = keys[0] ?? null): TabsState {
  const showing = active ?? keys[0];
  return fromLayout(showing === undefined ? null : { tile: 't1', tabs: keys, showing }, 't1');
}

const BOTH = { tools: ['trace', 'correlation'] };

describe('tool key grammar', () => {
  it('canonicalises instance 1 and parses instances 2..999', () => {
    expect(parseToolKey('@trace')).toEqual({ tool: 'trace', instance: 1, key: '@trace' });
    expect(parseToolKey('@trace/1')).toEqual({ tool: 'trace', instance: 1, key: '@trace' });
    expect(parseToolKey('@correlation/2')?.key).toBe('@correlation/2');
    expect(parseToolKey('@correlation/10')?.instance).toBe(10);
    expect(parseToolKey('@correlation/999')?.instance).toBe(999);
  });

  it.each([
    '@trace/0',
    '@trace/01',
    '@trace/1000',
    '@trace/x',
    '@Trace',
    '@',
    'trace',
    '@trace/2/3',
  ])('rejects %s', (key) => {
    expect(parseToolKey(key)).toBeNull();
  });

  it('isToolKey needs a registered tool', () => {
    expect(isToolKey('@trace')).toBe(true);
    expect(isToolKey('@correlation/3')).toBe(true);
    expect(isToolKey('@nope')).toBe(false);
    expect(isToolKey('bts/a')).toBe(false);
    expect(isToolKey(null)).toBe(false);
  });

  it('toolKey and instanceLabel', () => {
    expect(toolKey('trace')).toBe('@trace');
    expect(toolKey('trace', 1)).toBe('@trace');
    expect(toolKey('correlation', 4)).toBe('@correlation/4');
    expect(instanceLabel('@trace')).toBe('Data Browser');
    expect(instanceLabel('@trace/3')).toBe('Data Browser 3');
    expect(instanceLabel('@correlation')).toBe('Correlation');
  });
});

describe('the registry', () => {
  it('lists trace, then correlation, then waveform', () => {
    expect(TOOLS.map((t) => t.id)).toEqual(['trace', 'correlation', 'waveform']);
  });

  it('registers waveform with its tab and tree labels', () => {
    const wf = toolSpec('waveform')!;
    expect(wf.label).toBe('Waveform');
    expect(wf.treeLabel).toBe('Waveform Plot');
    expect(isToolKey('@waveform')).toBe(true);
    expect(isToolKey('@waveform/2')).toBe(true);
    expect(instanceLabel('@waveform')).toBe('Waveform');
    expect(instanceLabel('@waveform/3')).toBe('Waveform 3');
  });

  it('waveform accepts its grammar: size and decoding only, empty allowed', () => {
    const wf = toolSpec('waveform')!;
    expect(wf.isValidQuery('')).toBe(true);
    expect(wf.isValidQuery('pv=WF%3A1&pv=WF%3A2&x=index')).toBe(true);
    expect(wf.isValidQuery('pv=A&hide=0')).toBe(true);
    expect(wf.isValidQuery('pv=%E0%A4%A')).toBe(false);
    expect(wf.isValidQuery('pv=' + 'x'.repeat(4096))).toBe(false);
    expect(wf.isValidQuery(null)).toBe(false);
    expect(wf.isValidQuery(7)).toBe(false);
  });

  it('describes a waveform query by its count of pv keys', () => {
    const wf = toolSpec('waveform')!;
    expect(wf.describeQuery('pv=A&pv=B&pv=C&x=index')).toBe('3 PVs');
    expect(wf.describeQuery('pv=A')).toBe('1 PV');
    expect(wf.describeQuery('x=index')).toBe('0 PVs');
    expect(wf.describeQuery('')).toBe('0 PVs');
  });

  it('trace validates like isValidTraceQuery; correlation only checks size and decoding', () => {
    const trace = toolSpec('trace')!;
    const corr = toolSpec('correlation')!;
    expect(trace.isValidQuery('pv=X')).toBe(true);
    expect(trace.isValidQuery('')).toBe(false);
    expect(trace.isValidQuery('foo=1')).toBe(false);
    expect(corr.isValidQuery('')).toBe(true);
    expect(corr.isValidQuery('x=A&y=B&n=50')).toBe(true);
    expect(corr.isValidQuery('anything=goes')).toBe(true);
    expect(corr.isValidQuery('x=%E0%A4%A')).toBe(false);
    expect(corr.isValidQuery('y=' + 'x'.repeat(4096))).toBe(false);
    expect(corr.isValidQuery(7)).toBe(false);
  });

  it('describes a correlation query by its raw y= count only', () => {
    const corr = toolSpec('correlation')!;
    expect(corr.describeQuery('x=A&y=B&y=C&trig=T')).toBe('2 Y PVs');
    expect(corr.describeQuery('x=A&y=B')).toBe('1 Y PV');
    expect(corr.describeQuery('')).toBe('0 Y PVs');
  });

  it('reads a tool entry from the config only when it is well formed', () => {
    const config = {
      trace: { path: 'trace/', query: '' },
      correlation: { path: 'trace/correlation.html', query: 'n=500' },
    };
    expect(toolConfig(config, 'correlation')).toEqual(config.correlation);
    expect(toolConfig({ trace: config.trace }, 'correlation')).toBeUndefined();
    expect(toolConfig(config, 'nope')).toBeUndefined();
    expect(configuredTools(config)).toEqual(['trace', 'correlation']);
    expect(configuredTools({ correlation: config.correlation })).toEqual(['correlation']);
    expect(configuredTools(undefined)).toEqual([]);
  });

  it('configured tools follow registry order and omit an absent waveform', () => {
    const trace = { path: 'trace/', query: '' };
    const correlation = { path: 'trace/correlation.html', query: '' };
    const waveform = { path: 'trace/waveform.html', query: 'pv=WF' };
    expect(configuredTools({ waveform, trace, correlation })).toEqual([
      'trace',
      'correlation',
      'waveform',
    ]);
    expect(configuredTools({ waveform, trace })).toEqual(['trace', 'waveform']);
    expect(configuredTools({ trace, correlation })).toEqual(['trace', 'correlation']);
    expect(toolConfig({ trace, correlation }, 'waveform')).toBeUndefined();
    expect(toolConfig({ waveform }, 'waveform')).toEqual(waveform);
    expect(toolConfig({ waveform: { path: '', query: '' } }, 'waveform')).toBeUndefined();
  });
});

describe('config.json waveform entry', () => {
  afterEach(() => vi.unstubAllGlobals());

  function served(body: unknown) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }))
    );
  }

  it('is parsed like correlation: kept with a non-empty path, query capped to 4 KB', async () => {
    served({ pvMode: 'hare', waveform: { path: 'trace/waveform.html', query: 'pv=WF' } });
    expect((await loadConfig('http://h/')).waveform).toEqual({
      path: 'trace/waveform.html',
      query: 'pv=WF',
    });
    served({ waveform: { path: 'trace/waveform.html', query: 'pv=' + 'x'.repeat(4096) } });
    expect((await loadConfig('http://h/')).waveform).toEqual({
      path: 'trace/waveform.html',
      query: '',
    });
  });

  it('is omitted when absent or malformed', async () => {
    served({ pvMode: 'hare' });
    expect('waveform' in (await loadConfig('http://h/'))).toBe(false);
    served({ waveform: { path: '' } });
    expect('waveform' in (await loadConfig('http://h/'))).toBe(false);
    served({ waveform: 'trace/waveform.html' });
    expect('waveform' in (await loadConfig('http://h/'))).toBe(false);
  });

  it('makes waveform a configured tool after correlation', async () => {
    served({
      waveform: { path: 'trace/waveform.html', query: '' },
      trace: { path: 'trace/', query: '' },
      correlation: { path: 'trace/correlation.html', query: '' },
    });
    expect(configuredTools(await loadConfig('http://h/'))).toEqual([
      'trace',
      'correlation',
      'waveform',
    ]);
  });
});

describe('per-instance state', () => {
  it("'+' opens a blank instance at the smallest free id, appended", () => {
    let s = run(tabs(['a/1']), { type: 'newInstance', tool: 'correlation' });
    expect(s.keys).toEqual(['a/1', '@correlation']);
    expect(s.instances['@correlation']).toMatchObject({ query: '', view: null });
    s = run(
      s,
      { type: 'newInstance', tool: 'correlation' },
      { type: 'newInstance', tool: 'correlation' }
    );
    expect(s.keys).toEqual(['a/1', '@correlation', '@correlation/2', '@correlation/3']);
    s = run(
      s,
      { type: 'close', key: '@correlation/2' },
      { type: 'newInstance', tool: 'correlation' }
    );
    expect(s.keys).toEqual(['a/1', '@correlation', '@correlation/3', '@correlation/2']);
    expect(s.active).toBe('@correlation/2');
  });

  it("'+' taking id 1 discards the data browser's survived state", () => {
    const s = run(
      { ...tabs([]), instances: { '@trace': { query: 'pv=OLD', view: 'v1' } } },
      { type: 'newInstance', tool: 'trace' }
    );
    expect(s.keys).toEqual(['@trace']);
    expect(s.instances['@trace']).toMatchObject({ query: '', view: null });
  });

  it('closing an instance drops its state, except Trace instance 1', () => {
    let s = run(
      tabs([]),
      { type: 'newInstance', tool: 'trace' },
      { type: 'setQuery', key: '@trace', query: 'pv=A' },
      { type: 'newInstance', tool: 'trace' },
      { type: 'setQuery', key: '@trace/2', query: 'pv=B' },
      { type: 'newInstance', tool: 'correlation' }
    );
    s = run(
      s,
      { type: 'close', key: '@trace' },
      { type: 'close', key: '@trace/2' },
      { type: 'close', key: '@correlation' }
    );
    expect(Object.keys(s.instances)).toEqual(['@trace']);
    expect(s.instances['@trace']?.query).toBe('pv=A');
    // Reopening @trace (the Tools entry) comes back with that state.
    s = run(s, { type: 'open', key: '@trace', mode: 'replace' });
    expect(s.instances['@trace']?.query).toBe('pv=A');
  });

  it('loading a view into instance A bumps only A’s epoch', () => {
    let s = run(
      tabs([]),
      { type: 'newInstance', tool: 'trace' },
      { type: 'newInstance', tool: 'trace' }
    );
    const before2 = s.instances['@trace/2']?.epoch;
    const before1 = s.instances['@trace']?.epoch ?? 0;
    s = run(s, { type: 'load', key: '@trace', query: 'pv=V', view: 'v' });
    expect(s.instances['@trace']).toEqual({ query: 'pv=V', view: 'v', epoch: before1 + 1 });
    expect(s.instances['@trace/2']?.epoch).toBe(before2);
    expect(s.active).toBe('@trace');
  });

  it('setQuery validates with the tool’s own check', () => {
    const s = run(
      tabs([]),
      { type: 'newInstance', tool: 'correlation' },
      { type: 'newInstance', tool: 'trace' }
    );
    const corr = run(s, { type: 'setQuery', key: '@correlation', query: 'x=A&y=B' });
    expect(corr.instances['@correlation']?.query).toBe('x=A&y=B');
    expect(run(s, { type: 'setQuery', key: '@trace', query: 'x=A&y=B' })).toBe(s);
  });

  it('setView keeps the query and epoch', () => {
    let s = run(tabs([]), { type: 'load', key: '@trace', query: 'pv=A', view: null });
    s = run(s, { type: 'setView', key: '@trace', view: 'v2' });
    expect(s.instances['@trace']).toEqual({ query: 'pv=A', view: 'v2', epoch: 1 });
  });
});

describe('toolMru', () => {
  it('moves a tool instance to the front on focus, open and load', () => {
    let s = run(
      tabs(['a/1']),
      { type: 'newInstance', tool: 'trace' },
      { type: 'newInstance', tool: 'trace' },
      { type: 'newInstance', tool: 'correlation' }
    );
    expect(s.toolMru).toEqual(['@correlation', '@trace/2', '@trace']);
    s = run(s, { type: 'focus', key: '@trace' });
    expect(s.toolMru[0]).toBe('@trace');
    s = run(s, { type: 'load', key: '@trace/2', query: 'pv=X', view: null });
    expect(s.toolMru[0]).toBe('@trace/2');
    s = run(s, { type: 'focus', key: 'a/1' });
    expect(s.toolMru[0]).toBe('@trace/2');
    expect(mruInstance(s, 'trace')).toBe('@trace/2');
  });

  it('a neighbour that becomes active by a close is not promoted', () => {
    let s = run(
      tabs([]),
      { type: 'newInstance', tool: 'trace' },
      { type: 'newInstance', tool: 'trace' },
      { type: 'newInstance', tool: 'trace' },
      { type: 'focus', key: '@trace' },
      { type: 'focus', key: '@trace/2' }
    );
    expect(s.toolMru).toEqual(['@trace/2', '@trace', '@trace/3']);
    s = run(s, { type: 'close', key: '@trace/2' });
    expect(s.active).toBe('@trace/3');
    expect(s.toolMru).toEqual(['@trace', '@trace/3']);
    expect(mruInstance(s, 'trace')).toBe('@trace');
  });

  it('is pruned on close and on replace-open', () => {
    let s = run(tabs(['a/1']), { type: 'open', key: '@trace', mode: 'replace' });
    expect(s.keys).toEqual(['@trace']);
    expect(s.toolMru).toEqual(['@trace']);
    s = run(s, { type: 'open', key: 'a/2', mode: 'append' }, { type: 'close', key: '@trace' });
    expect(s.toolMru).toEqual([]);
    // A stale MRU entry (from storage) is pruned by the next action that changes state.
    s = run(
      { ...tabs(['a/1', 'a/2'], 'a/1'), toolMru: ['@trace/5'] },
      {
        type: 'open',
        key: 'a/3',
        mode: 'replace',
      }
    );
    expect(s.keys).toEqual(['a/3', 'a/2']);
    expect(s.toolMru).toEqual([]);
  });

  it('falls back to the lowest open instance without an MRU entry', () => {
    const s: TabsState = { ...tabs(['@trace/4', '@trace/2', '@trace/3']), toolMru: [] };
    expect(mruInstance(s, 'trace')).toBe('@trace/2');
    expect(mruInstance(s, 'correlation')).toBeNull();
  });

  it('loadTabs prunes it to the open keys', () => {
    const { state } = loadTabs(
      {
        keys: ['@trace'],
        active: '@trace',
        layout: null,
        focusedTile: null,
        instances: {},
        toolMru: ['@trace/2', '@trace'],
      },
      null,
      BOTH
    );
    expect(state.toolMru).toEqual(['@trace']);
  });
});

describe('opening rules', () => {
  it('a Tools-entry click focuses the most recently used instance', () => {
    let s = run(
      tabs(['a/1']),
      { type: 'newInstance', tool: 'trace' },
      { type: 'newInstance', tool: 'trace' },
      { type: 'focus', key: '@trace' },
      { type: 'focus', key: 'a/1' }
    );
    s = run(s, { type: 'openTool', tool: 'trace' });
    expect(s.active).toBe('@trace');
    expect(s.keys).toHaveLength(3);
  });

  it("a Tools-entry click with none open opens instance 1 with Trace's survived state", () => {
    const s = run(
      { ...tabs(['a/1', 'a/2'], 'a/2'), instances: { '@trace': { query: 'pv=KEPT' } } },
      { type: 'openTool', tool: 'trace' }
    );
    expect(s.keys).toEqual(['a/1', '@trace']);
    expect(s.active).toBe('@trace');
    expect(s.instances['@trace']?.query).toBe('pv=KEPT');
  });

  it('a Tools-entry click with none open opens the tool default for other tools', () => {
    const s = run(tabs([]), { type: 'openTool', tool: 'correlation' });
    expect(s.keys).toEqual(['@correlation']);
    expect(s.instances['@correlation']).toBeUndefined();
  });

  it('a replace-open of a screen while a tool instance is active appends', () => {
    const s = run(
      tabs(['a/1']),
      { type: 'newInstance', tool: 'correlation' },
      { type: 'newInstance', tool: 'correlation' },
      { type: 'open', key: 'a/2', mode: 'replace' }
    );
    expect(s.keys).toEqual(['a/1', '@correlation', '@correlation/2', 'a/2']);
  });

  it('a saved view focuses the most recently used instance showing it', () => {
    let s = run(
      tabs([]),
      { type: 'openView', tool: 'trace', query: 'pv=V', view: 'v' },
      { type: 'openView', tool: 'trace', query: 'pv=V', view: 'v', newTab: true },
      { type: 'newInstance', tool: 'trace' }
    );
    expect(s.keys).toEqual(['@trace', '@trace/2', '@trace/3']);
    s = run(s, { type: 'focus', key: '@trace' }, { type: 'focus', key: '@trace/3' });
    expect(viewInstance(s, 'trace', 'v')).toBe('@trace');
    const epochs = JSON.stringify(s.instances);
    s = run(s, { type: 'openView', tool: 'trace', query: 'pv=V', view: 'v' });
    expect(s.active).toBe('@trace');
    expect(s.keys).toHaveLength(3);
    expect(JSON.stringify(s.instances)).toBe(epochs);
  });

  it('a saved view with no instance showing it opens a new one (appended)', () => {
    const s = run(tabs(['a/1']), {
      type: 'openView',
      tool: 'correlation',
      query: 'x=A&y=B',
      view: 'correlation_c',
    });
    expect(s.keys).toEqual(['a/1', '@correlation']);
    expect(s.instances['@correlation']).toMatchObject({ query: 'x=A&y=B', view: 'correlation_c' });
  });

  it('a waveform saved view loads into a waveform tab', () => {
    const s = run(tabs(['a/1']), {
      type: 'openView',
      tool: 'waveform',
      query: 'pv=WF%3A1&pv=WF%3A2',
      view: 'waveform_w',
    });
    expect(s.keys).toEqual(['a/1', '@waveform']);
    expect(s.active).toBe('@waveform');
    expect(s.instances['@waveform']).toMatchObject({
      query: 'pv=WF%3A1&pv=WF%3A2',
      view: 'waveform_w',
    });
    expect(viewInstance(s, 'waveform', 'waveform_w')).toBe('@waveform');
  });

  it('"Open in new tab" always opens a new instance', () => {
    let s = run(tabs([]), { type: 'openView', tool: 'trace', query: 'pv=V', view: 'v' });
    s = run(s, { type: 'openView', tool: 'trace', query: 'pv=V', view: 'v', newTab: true });
    expect(s.keys).toEqual(['@trace', '@trace/2']);
  });

  describe('the cap', () => {
    function full(): TabsState {
      let s = tabs(['a/1']);
      for (let i = 0; i < MAX_TOOL_INSTANCES; i += 1) {
        s = run(s, { type: 'newInstance', tool: 'correlation' });
      }
      return s;
    }

    it('allows MAX_TOOL_INSTANCES instances per tool', () => {
      const s = full();
      expect(s.keys.filter((k) => k.startsWith('@correlation'))).toHaveLength(MAX_TOOL_INSTANCES);
      expect(canOpen(s, '@correlation/11')).toBe(false);
      expect(canOpen(s, '@correlation/3')).toBe(true);
      expect(canOpen(s, '@trace')).toBe(true);
    });

    it("refuses '+' and an open of an 11th instance, by any path", () => {
      const s = full();
      expect(run(s, { type: 'newInstance', tool: 'correlation' })).toBe(s);
      expect(run(s, { type: 'open', key: '@correlation/11', mode: 'append' })).toBe(s);
      expect(run(s, { type: 'load', key: '@correlation/11', query: '', view: null })).toBe(s);
    });

    it('a saved view at the cap loads into the most recently used instance', () => {
      let s = run(full(), { type: 'focus', key: '@correlation/4' }, { type: 'focus', key: 'a/1' });
      const epoch = s.instances['@correlation/4']?.epoch ?? 0;
      s = run(s, {
        type: 'openView',
        tool: 'correlation',
        query: 'x=Q',
        view: 'correlation_q',
        newTab: true,
      });
      expect(s.keys).toHaveLength(MAX_TOOL_INSTANCES + 1);
      expect(s.active).toBe('@correlation/4');
      expect(s.instances['@correlation/4']).toEqual({
        query: 'x=Q',
        view: 'correlation_q',
        epoch: epoch + 1,
      });
    });

    it('loadTabs refuses a URL instance past the cap with a warning', () => {
      const { state, warnings } = loadTabs(full(), '@correlation/11', BOTH);
      expect(state.keys).toHaveLength(MAX_TOOL_INSTANCES + 1);
      expect(state.keys).not.toContain('@correlation/11');
      expect(warnings).toHaveLength(1);
    });
  });
});

describe('loadTabs with tools', () => {
  it('drops stored keys of unregistered and unconfigured tools, one warning each', () => {
    const { state, warnings } = loadTabs(
      tabs(['a/1', '@nope', '@correlation/2', '@trace'], '@correlation/2'),
      null,
      { tools: ['trace'] }
    );
    expect(state.keys).toEqual(['a/1', '@trace']);
    expect(state.active).toBe('a/1');
    expect(warnings).toHaveLength(2);
  });

  it('opens a URL instance that is not stored with the tool default (no state)', () => {
    const { state, warnings } = loadTabs(tabs(['a/1']), '@correlation/7', BOTH);
    expect(state.keys).toEqual(['a/1', '@correlation/7']);
    expect(state.active).toBe('@correlation/7');
    expect(state.instances['@correlation/7']).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  it('refuses a URL key of an unconfigured tool with one warning', () => {
    const { state, warnings } = loadTabs(tabs(['a/1']), '@correlation', { tools: ['trace'] });
    expect(state.keys).toEqual(['a/1']);
    expect(warnings).toHaveLength(1);
  });

  it('a fresh session opens @trace only when the data browser is configured', () => {
    expect(loadTabs(EMPTY_TABS, null, { tools: ['correlation'], fresh: true }).state.keys).toEqual(
      []
    );
    expect(loadTabs(EMPTY_TABS, null, { ...BOTH, fresh: true }).state.keys).toEqual(['@trace']);
  });
});

describe('stored instances', () => {
  afterEach(() => sessionStorage.clear());

  function stored(raw: unknown): TabsState {
    sessionStorage.setItem(tabsStorageKey('/'), JSON.stringify(raw));
    return readTabs();
  }

  it('reads no instances from a record without an instances map', () => {
    expect(stored({ keys: ['@trace'], active: '@trace' }).instances).toEqual({});
  });

  it("keeps a stored '' (blank) and null (default) ", () => {
    expect(
      stored({
        keys: ['@trace', '@trace/2', '@correlation'],
        active: '@trace',
        instances: {
          '@trace': { query: null },
          '@trace/2': { query: '' },
          '@correlation': { query: 'x=A&y=B', view: 'correlation_c' },
          '@nope': { query: '' },
          '@trace/x': { query: '' },
        },
        toolMru: ['@trace', '@correlation', '@nope', 7],
      })
    ).toEqual({
      keys: ['@trace', '@trace/2', '@correlation'],
      active: '@trace',
      layout: { tile: 't1', tabs: ['@trace', '@trace/2', '@correlation'], showing: '@trace' },
      focusedTile: 't1',
      instances: {
        '@trace': { query: null },
        '@trace/2': { query: '' },
        '@correlation': { query: 'x=A&y=B', view: 'correlation_c' },
      },
      toolMru: ['@trace', '@correlation'],
    });
  });

  it('canonicalises @<tool>/1 keys', () => {
    const s = stored({ keys: ['@trace/1', '@trace'], active: '@trace/1', instances: {} });
    expect(s.keys).toEqual(['@trace']);
    expect(s.active).toBe('@trace');
  });

  it('never stores the epoch', () => {
    const s = run(tabs([]), { type: 'load', key: '@trace/2', query: 'pv=A', view: 'v' });
    writeTabs(s);
    expect(JSON.parse(sessionStorage.getItem(tabsStorageKey('/'))!)).toEqual({
      keys: ['@trace/2'],
      active: '@trace/2',
      instances: { '@trace/2': { query: 'pv=A', view: 'v' } },
      toolMru: ['@trace/2'],
    });
    const back = readTabs();
    expect(back.instances['@trace/2']).toEqual({ query: 'pv=A', view: 'v' });
    expect(loadTabs(back, null, BOTH).state.instances['@trace/2']?.view).toBe('v');
  });

  it('two correlation instances survive a write/read round trip', () => {
    const s = run(
      tabs([]),
      { type: 'newInstance', tool: 'correlation' },
      { type: 'setQuery', key: '@correlation', query: 'x=A&y=B' },
      { type: 'newInstance', tool: 'correlation' }
    );
    writeTabs(s);
    const { state } = loadTabs(readTabs(), null, BOTH);
    expect(state.keys).toEqual(['@correlation', '@correlation/2']);
    expect(state.instances['@correlation']?.query).toBe('x=A&y=B');
    expect(state.instances['@correlation/2']?.query).toBe('');
    expect(state.active).toBe('@correlation/2');
  });
});
