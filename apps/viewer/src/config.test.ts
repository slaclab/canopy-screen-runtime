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

describe('readConfig display endpoint key', () => {
  const canopy = { VITE_CANOPY_BASE_URL: 'https://canopy', VITE_CANOPY_API_KEY: 'k1' };

  it("sends the Canopy key only to Canopy's own endpoint", () => {
    expect(
      readConfig({ ...canopy, VITE_EDM_BASE_URL: 'https://canopy/displays/v1/edm' }).edmApiKey
    ).toBe('k1');
    expect(
      readConfig({ ...canopy, VITE_EDM_BASE_URL: 'https://canopy.evil/displays/v1/edm' }).edmApiKey
    ).toBeUndefined();
    expect(readConfig({ ...canopy }).edmApiKey).toBeUndefined();
    // Same-origin Canopy: a relative endpoint is Canopy's, an absolute one is not.
    expect(readConfig({ VITE_CANOPY_API_KEY: 'k1' }).edmApiKey).toBe('k1');
    expect(
      readConfig({ VITE_CANOPY_API_KEY: 'k1', VITE_EDM_BASE_URL: '//cdn/d' }).edmApiKey
    ).toBeUndefined();
  });

  it('takes an explicit VITE_EDM_API_KEY', () => {
    expect(readConfig({ ...canopy, VITE_EDM_API_KEY: 'k2' }).edmApiKey).toBe('k2');
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
