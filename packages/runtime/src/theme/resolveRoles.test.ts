import { describe, expect, it } from 'vitest';
import { canopyDefaultFlat } from '@slaclab/canopy-screen-ir';
import type { FlatScheme, PropertyValue } from '@slaclab/canopy-screen-ir';
import { resolveRole, resolveRoles } from './resolveRoles.js';

const scheme: FlatScheme = {
  roles: ['Transparent', 'OK', 'MAJOR'],
  light: ['#ffffff00', '#00ff00', '#ff0000'],
  dark: ['#00000000', '#00aa00', '#aa0000'],
  meta: { id: 'test', sha256: null, flatHash: 'h', served: 'test', errors: [] },
};

function deepFreeze<T>(x: T): T {
  if (x !== null && typeof x === 'object') {
    for (const v of Object.values(x)) deepFreeze(v);
    Object.freeze(x);
  }
  return x;
}

type Bag = Record<string, PropertyValue>;

describe('resolveRole', () => {
  it('maps a role in the scheme to its custom property with the fallback', () => {
    expect(resolveRole({ $role: 'MAJOR', fallback: '#ee0000' }, scheme)).toBe(
      'var(--cr-2, #ee0000)'
    );
    expect(resolveRole({ $role: 'Transparent', fallback: '#ffffff00' }, scheme)).toBe(
      'var(--cr-0, #ffffff00)'
    );
  });

  it('maps a role outside the scheme to light-dark() of its fallbacks', () => {
    expect(
      resolveRole({ $role: 'site.custom', fallback: '#112233', fallbackDark: '#445566' }, scheme)
    ).toBe('light-dark(#112233, #445566)');
  });

  it('repeats the fallback as the dark value when fallbackDark is absent', () => {
    expect(resolveRole({ $role: 'site.custom', fallback: '#112233' }, scheme)).toBe(
      'light-dark(#112233, #112233)'
    );
  });

  it('uses the role index of the given scheme (canopy-default)', () => {
    const i = canopyDefaultFlat.roles.indexOf('OK');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(resolveRole({ $role: 'OK', fallback: '#00ff00' }, canopyDefaultFlat)).toBe(
      `var(--cr-${i}, #00ff00)`
    );
  });
});

describe('resolveRoles', () => {
  it('resolves top-level color props and leaves other props alone', () => {
    const props: Bag = {
      foregroundColor: { $role: 'OK', fallback: '#00ff00' },
      backgroundColor: { $role: 'nope', fallback: '#000000', fallbackDark: '#ffffff' },
      text: 'hello',
      fontSize: 12,
      visible: true,
      empty: null,
    };
    expect(resolveRoles(props, scheme)).toEqual({
      foregroundColor: 'var(--cr-1, #00ff00)',
      backgroundColor: 'light-dark(#000000, #ffffff)',
      text: 'hello',
      fontSize: 12,
      visible: true,
      empty: null,
    });
  });

  it('resolves roles nested in arrays of objects (curves[].color)', () => {
    const plain = { channel: 'B', color: '#123456' };
    const props: Bag = {
      curves: [{ channel: 'A', color: { $role: 'MAJOR', fallback: '#ff0000' } }, plain],
    };
    const out = resolveRoles(props, scheme);
    const curves = out.curves as readonly Bag[];
    expect(curves[0]).toEqual({ channel: 'A', color: 'var(--cr-2, #ff0000)' });
    // Role-free subtrees keep their identity.
    expect(curves[1]).toBe(plain);
  });

  it('returns the input itself when there is no role anywhere', () => {
    const props: Bag = { text: 'x', curves: [{ color: '#ffffff' }], nested: { a: [1, 2] } };
    expect(resolveRoles(props, scheme)).toBe(props);
  });

  it('shares role-free subtrees with the input', () => {
    const nested = { a: [1, 2] };
    const props: Bag = { nested, foregroundColor: { $role: 'OK', fallback: '#00ff00' } };
    const out = resolveRoles(props, scheme);
    expect(out).not.toBe(props);
    expect(out.nested).toBe(nested);
  });

  it('never mutates a frozen IR props bag', () => {
    const props = deepFreeze<Bag>({
      foregroundColor: { $role: 'OK', fallback: '#00ff00' },
      curves: [{ color: { $role: 'x', fallback: '#010203' } }],
    });
    const snapshot = JSON.parse(JSON.stringify(props)) as unknown;
    const out = resolveRoles(props, scheme);
    expect(out.foregroundColor).toBe('var(--cr-1, #00ff00)');
    expect((out.curves as readonly Bag[])[0]!.color).toBe('light-dark(#010203, #010203)');
    expect(props).toEqual(snapshot);
    expect(props.foregroundColor).toEqual({ $role: 'OK', fallback: '#00ff00' });
  });

  it('gives the same output reference for the same props reference and scheme', () => {
    const props: Bag = { foregroundColor: { $role: 'OK', fallback: '#00ff00' } };
    const a = resolveRoles(props, scheme);
    const b = resolveRoles(props, scheme);
    expect(b).toBe(a);
    // A different scheme is a different resolution.
    const c = resolveRoles(props, canopyDefaultFlat);
    expect(c).not.toBe(a);
  });

  it('does not treat a malformed role-like object as a role', () => {
    const odd = { $role: 'OK', fallback: 'red' };
    const props: Bag = { foregroundColor: odd };
    expect(resolveRoles(props, scheme).foregroundColor).toBe(odd);
  });
});
