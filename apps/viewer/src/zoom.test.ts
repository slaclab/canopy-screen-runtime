import { describe, expect, it } from 'vitest';
import { fitScale, formatPercent, stepZoom, ZOOM_LADDER } from './zoom.js';

describe('fitScale', () => {
  it('scales a wide panel down to the available width', () => {
    expect(fitScale(1200, 800, 2400, 800)).toBeCloseTo(0.5);
  });

  it('scales a tall panel down to the available height', () => {
    expect(fitScale(1000, 300, 500, 600)).toBeCloseTo(0.5);
  });

  it('takes the tighter of the two axes', () => {
    // width allows 0.8, height allows 0.4
    expect(fitScale(800, 400, 1000, 1000)).toBeCloseTo(0.4);
  });

  it('scales a panel smaller than the area up to fill it', () => {
    // width allows 5, height allows 10: the tighter axis wins
    expect(fitScale(2000, 2000, 400, 200)).toBeCloseTo(5);
  });

  it('magnifies a large panel in a larger tile, keeping the aspect ratio', () => {
    // 1600 x 920 authored in a 2368 x 1268 area: height allows ~1.378, width 1.48
    expect(fitScale(2368, 1268, 1600, 920)).toBeCloseTo(1268 / 920);
  });

  it('is exactly 1 when the panel fits exactly', () => {
    expect(fitScale(400, 200, 400, 200)).toBe(1);
  });

  it('falls back to 1 for an unmeasured area or a degenerate screen', () => {
    expect(fitScale(0, 0, 400, 200)).toBe(1);
    expect(fitScale(-5, 100, 400, 200)).toBe(1);
    expect(fitScale(800, 600, 0, 200)).toBe(1);
    expect(fitScale(Number.NaN, 600, 400, 200)).toBe(1);
  });
});

describe('stepZoom', () => {
  it('is an ascending ladder that contains 100%', () => {
    expect([...ZOOM_LADDER].sort((a, b) => a - b)).toEqual([...ZOOM_LADDER]);
    expect(ZOOM_LADDER).toContain(1);
  });

  it('steps to the neighbouring rung from a rung', () => {
    expect(stepZoom(1, 1)).toBe(1.1);
    expect(stepZoom(1, -1)).toBe(0.9);
    expect(stepZoom(0.5, 1)).toBe(0.67);
  });

  it('steps from an off-ladder fit scale to the next rung in that direction', () => {
    expect(stepZoom(0.47, 1)).toBe(0.5);
    expect(stepZoom(0.47, -1)).toBe(0.33);
  });

  it('clamps at both ends of the ladder', () => {
    const min = ZOOM_LADDER[0]!;
    const max = ZOOM_LADDER[ZOOM_LADDER.length - 1]!;
    expect(stepZoom(max, 1)).toBe(max);
    expect(stepZoom(min, -1)).toBe(min);
    expect(stepZoom(0.01, -1)).toBe(min);
    expect(stepZoom(99, 1)).toBe(max);
  });

  it('treats float noise around a rung as that rung', () => {
    expect(stepZoom(0.3333333, 1)).toBe(0.5);
    expect(stepZoom(1.0000001, -1)).toBe(0.9);
  });
});

describe('formatPercent', () => {
  it('rounds to a whole percentage', () => {
    expect(formatPercent(1)).toBe('100%');
    expect(formatPercent(0.4666)).toBe('47%');
    expect(formatPercent(0.33)).toBe('33%');
  });
});
