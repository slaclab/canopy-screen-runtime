import { afterEach, describe, expect, it } from 'vitest';
import { STORAGE_SCOPE_ATTRIBUTE, storageKey, storageScope } from './storageScope.js';

const root = () => document.documentElement;

afterEach(() => {
  root().removeAttribute(STORAGE_SCOPE_ATTRIBUTE);
});

describe('storageKey', () => {
  it('keys the origin root as `/`', () => {
    expect(storageKey('canopy-viewer:tabs', '/')).toBe('canopy-viewer:tabs:/');
    expect(storageKey('canopy-viewer:tabs', '')).toBe('canopy-viewer:tabs:/');
  });

  it('suffixes the mount path, trailing slash or not', () => {
    expect(storageKey('canopy-viewer:tabs', '/u/alice/panel/canopy/')).toBe(
      'canopy-viewer:tabs:/u/alice/panel/canopy'
    );
    expect(storageKey('canopy-viewer:tabs', '/u/alice/panel/canopy')).toBe(
      storageKey('canopy-viewer:tabs', '/u/alice/panel/canopy/')
    );
  });

  it('tells two mounts apart', () => {
    expect(storageKey('canopy-viewer:tabs', '/u/alice/panel/canopy')).not.toBe(
      storageKey('canopy-viewer:tabs', '/u/bob/panel/canopy')
    );
  });

  it("defaults to this document's mount", () => {
    expect(storageKey('n')).toBe(storageKey('n', new URL(document.baseURI).pathname));
  });

  it('appends the host scope, and never falls back to the unscoped key', () => {
    root().setAttribute(STORAGE_SCOPE_ATTRIBUTE, 'alice');
    expect(storageKey('n', '/m')).toBe('n:/m--alice');
    root().setAttribute(STORAGE_SCOPE_ATTRIBUTE, 'bob');
    expect(storageKey('n', '/m')).toBe('n:/m--bob');
  });

  it('treats an empty scope as none', () => {
    root().setAttribute(STORAGE_SCOPE_ATTRIBUTE, '');
    expect(storageKey('n', '/m')).toBe('n:/m');
  });
});

describe('storageScope', () => {
  it('reads the scope attribute; an empty one is no scope', () => {
    expect(storageScope()).toBeNull();
    root().setAttribute(STORAGE_SCOPE_ATTRIBUTE, 'bob');
    expect(storageScope()).toBe('bob');
    root().setAttribute(STORAGE_SCOPE_ATTRIBUTE, '');
    expect(storageScope()).toBeNull();
  });
});
