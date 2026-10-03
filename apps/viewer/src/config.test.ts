import { describe, expect, it } from 'vitest';
import { readConfig } from './config.js';

describe('readConfig render mode', () => {
  it("defaults to 'edm'", () => {
    expect(readConfig({}).renderMode).toBe('edm');
  });

  it('reads VITE_RENDER_MODE', () => {
    expect(readConfig({ VITE_RENDER_MODE: 'carbon' }).renderMode).toBe('carbon');
    expect(readConfig({ VITE_RENDER_MODE: 'edm' }).renderMode).toBe('edm');
  });

  it("falls back to 'edm' for an unknown mode", () => {
    expect(readConfig({ VITE_RENDER_MODE: 'legacy' }).renderMode).toBe('edm');
  });
});

describe('readConfig EDM display tree', () => {
  it('defaults to the static tree at /displays/edm; a trailing slash is dropped', () => {
    expect(readConfig({}).edmBaseUrl).toBe('/displays/edm');
    expect(readConfig({ VITE_EDM_BASE_URL: 'https://static/edm/' }).edmBaseUrl).toBe(
      'https://static/edm'
    );
  });
});

describe('readConfig screen policy', () => {
  it('reads magpie in hare mode, nothing in mock mode, unless told', () => {
    expect(readConfig({ VITE_PV_MODE: 'hare' }).screenPolicy).toBe('magpie');
    expect(readConfig({}).screenPolicy).toBe('none');
    expect(readConfig({ VITE_SCREEN_POLICY: 'magpie' }).screenPolicy).toBe('magpie');
    expect(readConfig({ VITE_PV_MODE: 'hare', VITE_SCREEN_POLICY: 'none' }).screenPolicy).toBe(
      'none'
    );
    expect(readConfig({ VITE_SCREEN_POLICY_SLUG: 'Ab12' }).screenPolicySlug).toBe('Ab12');
  });
});
