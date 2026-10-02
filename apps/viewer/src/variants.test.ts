import { describe, expect, it } from 'vitest';
import type { ManifestScreen } from './api.js';
import { memoryPreferences, storagePreferences } from './preferences.js';
import {
  chooseVariant,
  findScreen,
  groupScreens,
  implOf,
  notViewable,
  parsePolicy,
  variantLabel,
} from './variants.js';

const IR: ManifestScreen = {
  id: 'vac',
  kind: 'ir',
  title: 'Vacuum',
  category: 'ex',
  path: 'screens/ex/vac.screen.json',
};
const EDL: ManifestScreen = {
  id: 'vac',
  kind: 'edl',
  impl: 'edm',
  look: 'faithful',
  title: 'Vacuum (EDM)',
  category: 'ex',
  path: 'vac/vacuum.edl',
};
const UI: ManifestScreen = { id: 'vac', kind: 'ui', title: 'Vacuum', category: 'ex', path: 'v.ui' };
const CODE: ManifestScreen = {
  id: 'pump',
  kind: 'code',
  title: 'P',
  category: 'ex',
  path: 'p.tsx',
};

describe('variants', () => {
  it('takes the implementation from impl, else from the kind', () => {
    expect([IR, EDL, UI, CODE].map(implOf)).toEqual(['react', 'edm', 'pydm', 'react']);
    expect(implOf({ ...IR, impl: 'edm' })).toBe('edm');
  });

  it('groups entries sharing category and id, in manifest order', () => {
    const screens = groupScreens([UI, IR, CODE, EDL, { ...IR, category: 'other' }]);
    expect(screens.map((s) => s.key)).toEqual(['ex/vac', 'ex/pump', 'other/vac']);
    expect(screens[0].variants.map(variantLabel)).toEqual(['PyDM', 'Screen IR', 'EDM · faithful']);
    expect(findScreen([IR, EDL], 'ex', 'vac')?.variants).toHaveLength(2);
    expect(findScreen([IR, EDL], 'ex', 'nope')).toBeUndefined();
  });

  it('can show IR and EDM variants, not code or PyDM ones', () => {
    const [vac, pump] = groupScreens([IR, EDL, UI, CODE]);
    expect(vac.variants.map((v) => notViewable(v)?.title ?? null)).toEqual([
      null,
      null,
      "Screen 'Vacuum' is a PyDM screen",
    ]);
    expect(notViewable(pump.variants[0])?.title).toBe("Screen 'P' is a code screen");
  });

  it('chooses link, then user, then site screen, then site default, then first viewable', () => {
    const [vac] = groupScreens([UI, IR, EDL]);
    const policy = parsePolicy({
      default: { impl: 'react' },
      screens: { 'ex/vac': { impl: 'edm', look: 'faithful' } },
    });
    const pick = (o: Parameters<typeof chooseVariant>[1]) => {
      const c = chooseVariant(vac, o);
      return [c.variant ? variantLabel(c.variant) : null, c.source];
    };
    expect(pick({ link: { impl: 'pydm' }, user: { impl: 'react' }, policy })).toEqual([
      'PyDM',
      'link',
    ]);
    expect(pick({ link: { impl: 'edm', look: 'modern' } })).toEqual([null, 'link']);
    expect(pick({ user: { impl: 'react' }, policy })).toEqual(['Screen IR', 'user']);
    expect(pick({ policy })).toEqual(['EDM · faithful', 'site']);
    expect(pick({ policy: parsePolicy({ default: { impl: 'edm' } }) })).toEqual([
      'EDM · faithful',
      'site',
    ]);
    // Only a link may open a variant that can't be shown.
    expect(
      pick({ user: { impl: 'pydm' }, policy: parsePolicy({ default: { impl: 'pydm' } }) })
    ).toEqual(['Screen IR', 'listed']);
    expect(pick({})).toEqual(['Screen IR', 'listed']);
  });

  it('drops malformed policy entries', () => {
    expect(parsePolicy(null)).toEqual({ screens: {} });
    expect(
      parsePolicy({ default: 'edm', screens: { a: { impl: 'edm' }, b: { look: 'x' }, c: 3 } })
    ).toEqual({ screens: { a: { impl: 'edm' } } });
  });
});

describe('preferences', () => {
  it('remembers and forgets a choice per screen', () => {
    const items = new Map<string, string>();
    const storage = {
      getItem: (k: string) => items.get(k) ?? null,
      setItem: (k: string, v: string) => void items.set(k, v),
      removeItem: (k: string) => void items.delete(k),
    } as Storage;
    const prefs = storagePreferences(() => storage);
    prefs.set('ex/vac', { impl: 'edm', look: 'faithful' });
    expect(prefs.get('ex/vac')).toEqual({ impl: 'edm', look: 'faithful' });
    expect(prefs.get('ex/other')).toBeNull();
    prefs.set('ex/vac', null);
    expect(prefs.get('ex/vac')).toBeNull();
    items.set('canopy-viewer:variant:ex/bad', '{not json');
    expect(prefs.get('ex/bad')).toBeNull();
  });

  it('works without storage', () => {
    const prefs = storagePreferences(() => {
      throw new Error('blocked');
    });
    prefs.set('ex/vac', { impl: 'edm' });
    expect(prefs.get('ex/vac')).toBeNull();
    const mem = memoryPreferences();
    mem.set('ex/vac', { impl: 'edm' });
    expect(mem.get('ex/vac')).toEqual({ impl: 'edm' });
  });
});
