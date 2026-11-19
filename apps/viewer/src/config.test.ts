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
