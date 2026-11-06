// macrosFromSearch: query parameters become screen macros, except the
// viewer's reserved names (embedded, theme, mode, render, _canopy*).

import { describe, expect, it } from 'vitest';
import { macrosFromSearch } from './macros.js';

describe('macrosFromSearch', () => {
  it('turns every ordinary query parameter into a macro', () => {
    expect(macrosFromSearch(new URLSearchParams('P=IOC:1&M=motor'))).toEqual({
      P: 'IOC:1',
      M: 'motor',
    });
  });

  it('returns an empty object for an empty query', () => {
    expect(macrosFromSearch(new URLSearchParams(''))).toEqual({});
  });

  it('drops the reserved embedded, theme and mode parameters', () => {
    const search = new URLSearchParams('embedded=1&theme=dark&mode=edit&P=IOC:1');
    expect(macrosFromSearch(search)).toEqual({ P: 'IOC:1' });
  });

  it('drops every parameter whose name starts with _canopy', () => {
    const search = new URLSearchParams('_canopy=1&_canopyRev=abc&_canopy_x=y&P=IOC:1');
    expect(macrosFromSearch(search)).toEqual({ P: 'IOC:1' });
  });

  it('matches reserved names exactly and case-sensitively', () => {
    const search = new URLSearchParams('THEME=x&themes=y&Mode=z&x_canopy=w&_Canopy=v');
    expect(macrosFromSearch(search)).toEqual({
      THEME: 'x',
      themes: 'y',
      Mode: 'z',
      x_canopy: 'w',
      _Canopy: 'v',
    });
  });

  it('keeps the last value of a repeated parameter', () => {
    expect(macrosFromSearch(new URLSearchParams('P=a&P=b'))).toEqual({ P: 'b' });
  });

  it('keeps empty values', () => {
    expect(macrosFromSearch(new URLSearchParams('P='))).toEqual({ P: '' });
  });

  it('drops the reserved render parameter (the render mode, not a macro)', () => {
    expect(macrosFromSearch(new URLSearchParams('render=carbon&P=IOC:1'))).toEqual({ P: 'IOC:1' });
  });
});
