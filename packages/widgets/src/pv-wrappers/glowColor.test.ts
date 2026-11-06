// glowColor: literal hex keeps the absolute 50 % alpha suffix; role colours
// (var() / light-dark()) are mixed with transparent because a suffix would be invalid CSS.
import { describe, expect, it, vi } from 'vitest';

vi.mock('@slaclab/canopy-react', () => ({
  usePV: () => ({ connected: false, value: undefined }),
}));

const { glowColor } = await import('./CarbonWidgets.js');

function isValidColor(value: string): boolean {
  const el = document.createElement('div');
  el.style.color = value;
  return el.style.color !== '';
}

describe('glowColor on literal hex', () => {
  it('appends 80 to an opaque 6-digit hex', () => {
    expect(glowColor('#00ff00')).toBe('#00ff0080');
  });

  it('drops an existing 8-digit alpha before appending 80', () => {
    expect(glowColor('#00ff00cc')).toBe('#00ff0080');
  });

  it('drops an existing 4-digit alpha before appending 80', () => {
    expect(glowColor('#0f0c')).toBe('#0f080');
  });

  it('appends 80 to a 3-digit hex', () => {
    expect(glowColor('#0f0')).toBe('#0f080');
  });
});

describe('glowColor on role colours', () => {
  it('mixes a var() colour with transparent', () => {
    const out = glowColor('var(--cr-3, #00ff00)');
    expect(out).toBe('color-mix(in srgb, var(--cr-3, #00ff00) 50%, transparent)');
    expect(out).not.toMatch(/\)80$/);
  });

  it('mixes a light-dark() colour with transparent', () => {
    expect(glowColor('light-dark(#24a148, #42be65)')).toBe(
      'color-mix(in srgb, light-dark(#24a148, #42be65) 50%, transparent)'
    );
  });

  it('gives a colour the CSS parser accepts for a var() input', () => {
    const out = glowColor('var(--cr-3, #00ff00)');
    // jsdom accepts any var() expression; the shape check above pins the rest.
    expect(isValidColor(out)).toBe(true);
    // Balanced parentheses: the mix wraps the input whole.
    expect(out.split('(').length).toBe(out.split(')').length);
  });
});
