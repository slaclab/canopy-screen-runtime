// resolveMember: the tab key a collection member opens into, against the
// manifest's IR screens and the tools served here, with a distinct reason for
// each member that does not resolve; a drop is honoured only for a member the
// Browse tree renders (its payload is authored outside the page).
import { describe, expect, it } from 'vitest';
import type { ManifestScreen } from '../api.js';
import { memberKey, resolveMember } from './collections.js';
import type { Member, MemberKey, ResolveContext, ResolveOptions } from './collections.js';
import { fromLayout } from './tabs.js';
import type { TabsState, ToolInstance } from './tabs.js';

function entry(category: string, id: string, kind = 'ir'): ManifestScreen {
  return { id, kind, title: id, category, path: `screens/${category}/${id}.screen.json` };
}

const SCREENS: ManifestScreen[] = [
  entry('transfer', 'bts/a'),
  entry('examples', 'legacy', 'code'),
  entry('examples', 'wrapped', 'wrapper'),
  entry('drafts', 'mine'),
  entry('@drafts', 'draft1'),
];

function tabs(
  keys: string[],
  shown: string[],
  toolMru: string[] = [],
  instances: Record<string, ToolInstance> = {}
): TabsState {
  // One tile holding every key, showing shown[0], else its first key.
  const showing = shown[0] ?? keys[0];
  const layout = showing === undefined ? null : { tile: 't1', tabs: keys, showing };
  return { ...fromLayout(layout, 't1'), toolMru, instances };
}

function context(state: TabsState, extra: Partial<ResolveContext> = {}): ResolveContext {
  return { state, screens: SCREENS, tools: ['trace'], ...extra };
}

const OPEN: ResolveOptions = { source: 'open', atCap: 'mru' };
const SKIP: ResolveOptions = { source: 'open', atCap: 'skip' };
const DROP: ResolveOptions = { source: 'drop', atCap: 'mru' };

const rendered = (...members: Member[]): ReadonlySet<MemberKey> =>
  new Set(members.map((member) => memberKey(member)));

/** Ten open Trace instances: @trace, @trace/2 … @trace/10. */
const FULL = Array.from({ length: 10 }, (_, i) => (i === 0 ? '@trace' : `@trace/${i + 1}`));

describe('resolveMember: screens', () => {
  it('a listed IR screen opens its tab key, macros canonical as the tab model writes them', () => {
    const state = tabs([], []);
    expect(resolveMember({ screen: 'transfer/bts/a' }, context(state), OPEN)).toEqual({
      status: 'resolved',
      key: 'transfer/bts/a',
      member: 'screen:transfer/bts/a',
    });
    expect(
      resolveMember(
        { screen: 'transfer/bts/a', macros: { Z: '1', A: 'x y' } },
        context(state),
        OPEN
      )
    ).toEqual({
      status: 'resolved',
      key: 'transfer/bts/a?A=x+y&Z=1',
      member: 'screen:transfer/bts/a?A=x%20y&Z=1',
    });
  });

  it('resolves against the full manifest: a drafts screen is a screen too', () => {
    expect(resolveMember({ screen: 'drafts/mine' }, context(tabs([], [])), OPEN)).toMatchObject({
      status: 'resolved',
      key: 'drafts/mine',
    });
  });

  it('a screen the manifest lacks, or one in no category, is not in the library', () => {
    for (const screen of [
      'transfer/bts/zzz',
      'nocategory',
      'transfer/',
      '/x',
      '@drafts/draft1',
      // A tool key is never taken as a screen.
      '@trace',
      '@trace/7',
    ]) {
      expect(resolveMember({ screen }, context(tabs([], [])), OPEN), screen).toEqual({
        status: 'unresolved',
        reason: 'Not in the library',
      });
    }
  });

  it('a listed screen that is not IR is a code screen, not viewable', () => {
    for (const screen of ['examples/legacy', 'examples/wrapped']) {
      expect(resolveMember({ screen }, context(tabs([], [])), OPEN), screen).toEqual({
        status: 'unresolved',
        reason: 'Code screen — not viewable',
      });
    }
  });

  it('before the first manifest a screen member is pending; a tool member still resolves', () => {
    const ctx = context(tabs([], []), { screens: null });
    expect(resolveMember({ screen: 'transfer/bts/a' }, ctx, OPEN)).toEqual({ status: 'pending' });
    expect(resolveMember({ screen: 'nowhere/x' }, ctx, OPEN)).toEqual({ status: 'pending' });
    expect(resolveMember({ tool: 'trace' }, ctx, OPEN)).toMatchObject({
      status: 'resolved',
      key: '@trace',
    });
  });
});

describe('resolveMember: tools', () => {
  it('a bare tool member is the Tools row: its most recently used instance, else its first', () => {
    expect(resolveMember({ tool: 'trace' }, context(tabs([], [])), OPEN)).toEqual({
      status: 'resolved',
      key: '@trace',
      member: 'tool:trace',
    });
    const state = tabs(['@trace', '@trace/2'], ['@trace'], ['@trace/2']);
    expect(resolveMember({ tool: 'trace' }, context(state), OPEN)).toMatchObject({
      key: '@trace/2',
    });
  });

  it('a bare tool member never hits the cap: it focuses an instance', () => {
    const state = tabs(FULL, ['@trace'], ['@trace/4']);
    expect(resolveMember({ tool: 'trace' }, context(state), SKIP)).toEqual({
      status: 'resolved',
      key: '@trace/4',
      member: 'tool:trace',
    });
  });

  it('a tool not served here is not available, with its label', () => {
    expect(resolveMember({ tool: 'correlation' }, context(tabs([], [])), OPEN)).toEqual({
      status: 'unresolved',
      reason: 'Correlation not available here',
    });
    expect(
      resolveMember({ tool: 'correlation', query: 'x=1' }, context(tabs([], [])), OPEN)
    ).toEqual({ status: 'unresolved', reason: 'Correlation not available here' });
    expect(resolveMember({ tool: 'nosuch' }, context(tabs([], [])), OPEN)).toEqual({
      status: 'unresolved',
      reason: 'nosuch not available here',
    });
  });

  it('a {tool, query} member: a new instance loading the query when none shows it', () => {
    const state = tabs(['@trace'], ['@trace'], [], { '@trace': { query: 'pv=B' } });
    expect(resolveMember({ tool: 'trace', query: 'pv=A' }, context(state), OPEN)).toEqual({
      status: 'resolved',
      key: '@trace/2',
      member: 'tool:trace?pv=A',
      load: { query: 'pv=A', view: null },
    });
  });

  it('focuses the instance showing it: by `from`, or with no `from` by its query', () => {
    const byQuery = tabs(['@trace', '@trace/2'], ['@trace'], [], {
      '@trace': { query: 'pv=B' },
      '@trace/2': { query: 'pv=A' },
    });
    expect(resolveMember({ tool: 'trace', query: 'pv=A' }, context(byQuery), OPEN)).toEqual({
      status: 'resolved',
      key: '@trace/2',
      member: 'tool:trace?pv=A',
    });
    // `from` wins over the live query: edited since the member opened, it still shows it.
    const byFrom = tabs(['@trace', '@trace/3'], ['@trace'], [], {
      '@trace': { query: 'pv=A', from: 'tool:trace?pv=Z' } as ToolInstance,
      '@trace/3': { query: 'pv=edited', from: 'tool:trace?pv=A' } as ToolInstance,
    });
    expect(resolveMember({ tool: 'trace', query: 'pv=A' }, context(byFrom), OPEN)).toMatchObject({
      key: '@trace/3',
    });
    expect(resolveMember({ tool: 'trace', query: 'pv=Z' }, context(byFrom), OPEN)).toMatchObject({
      key: '@trace',
    });
  });

  it('of several instances showing it, the most recently used', () => {
    const state = tabs(['@trace', '@trace/2', '@trace/3'], ['@trace'], ['@trace/3', '@trace'], {
      '@trace/2': { query: 'pv=A' },
      '@trace/3': { query: 'pv=A' },
    });
    expect(resolveMember({ tool: 'trace', query: 'pv=A' }, context(state), OPEN)).toMatchObject({
      key: '@trace/3',
    });
  });

  it("an instance on the config default (query null) shows the bare member, a blank '' only 'tool:x?'", () => {
    const state = tabs(['@trace', '@trace/2'], ['@trace'], [], {
      '@trace': { query: null },
      '@trace/2': { query: '' },
    });
    expect(resolveMember({ tool: 'trace', query: '' }, context(state), OPEN)).toMatchObject({
      key: '@trace/2',
    });
  });

  it("at the cap: with 'mru' the most recently used instance loads it, flagged; with 'skip' it is skipped", () => {
    const state = tabs(FULL, ['@trace'], ['@trace/4']);
    expect(resolveMember({ tool: 'trace', query: 'pv=A' }, context(state), OPEN)).toEqual({
      status: 'resolved',
      key: '@trace/4',
      member: 'tool:trace?pv=A',
      load: { query: 'pv=A', view: null },
      atCap: 'trace',
    });
    expect(resolveMember({ tool: 'trace', query: 'pv=A' }, context(state), SKIP)).toEqual({
      status: 'skipped',
      tool: 'trace',
    });
  });

  it('at the cap an instance already showing the member is focused, not skipped', () => {
    const state = tabs(FULL, ['@trace'], ['@trace/4'], { '@trace/7': { query: 'pv=A' } });
    expect(resolveMember({ tool: 'trace', query: 'pv=A' }, context(state), SKIP)).toEqual({
      status: 'resolved',
      key: '@trace/7',
      member: 'tool:trace?pv=A',
    });
  });
});

describe('resolveMember: drop trust', () => {
  const screen: Member = { screen: 'transfer/bts/a' };
  const trace: Member = { tool: 'trace' };

  it('a drop resolves only a member the Browse tree renders', () => {
    const state = tabs([], []);
    const ctx = context(state, { renderedKeys: rendered(screen, trace) });
    expect(resolveMember(screen, ctx, DROP)).toMatchObject({
      status: 'resolved',
      key: 'transfer/bts/a',
    });
    expect(resolveMember(trace, ctx, DROP)).toMatchObject({ status: 'resolved', key: '@trace' });
  });

  it('a drop of anything else is untrusted, even a member that would resolve', () => {
    const ctx = context(tabs([], []), { renderedKeys: rendered(screen) });
    for (const member of [
      { screen: 'transfer/bts/a', macros: { M: '1' } },
      { screen: 'drafts/mine' },
      { screen: 'examples/legacy' },
      { tool: 'trace' },
      { tool: 'trace', query: 'pv=A' },
    ] as Member[]) {
      expect(resolveMember(member, ctx, DROP), JSON.stringify(member)).toEqual({
        status: 'untrusted',
      });
    }
    // With no rendered set at all, nothing dropped is trusted.
    expect(resolveMember(screen, context(tabs([], [])), DROP)).toEqual({ status: 'untrusted' });
  });

  it('a rendered member keeps its own outcome on a drop: pending, unresolved, the cap', () => {
    const legacy: Member = { screen: 'examples/legacy' };
    const ctx = context(tabs([], []), { renderedKeys: rendered(screen, legacy) });
    expect(resolveMember(legacy, ctx, DROP)).toEqual({
      status: 'unresolved',
      reason: 'Code screen — not viewable',
    });
    expect(resolveMember(screen, { ...ctx, screens: null }, DROP)).toEqual({ status: 'pending' });
  });

  it("the member's name plays no part in the trust: the key is the identity", () => {
    const ctx = context(tabs([], []), { renderedKeys: rendered({ tool: 'trace', query: 'pv=A' }) });
    expect(resolveMember({ tool: 'trace', query: 'pv=A', name: 'Gun' }, ctx, DROP)).toMatchObject({
      status: 'resolved',
      key: '@trace',
      load: { query: 'pv=A', view: null },
    });
  });
});
