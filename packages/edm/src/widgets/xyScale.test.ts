import { describe, expect, it } from 'vitest';
import { roundRange } from './xyScale.js';

const r = (a: number, b: number) => {
  const x = roundRange(a, b);
  return [x.min, x.max, x.n, x.majors, x.minors];
};

describe('xyGraph range rounding (EDM get_scale_params1)', () => {
  it('matches EDM on the golden ranges', () => {
    expect(r(-1.98, 101.0196)).toEqual([-20, 120, 7, 2, 2]);
    expect(r(0.84, 9.16)).toEqual([0, 10, 5, 2, 2]);
    expect(r(-200, 200)).toEqual([-200, 200, 4, 5, 2]);
    expect(r(-0.1, 1)).toEqual([-0.2, 1, 6, 2, 2]);
    expect(r(-360, 360)).toEqual([-400, 400, 8, 5, 2]);
    expect(r(0, 299)).toEqual([0, 300, 6, 5, 2]);
    expect(r(0, 6)).toEqual([0, 6, 6, 5, 2]);
    expect(r(0, 10)).toEqual([0, 10, 5, 2, 2]);
    expect(r(-0.2, 10.204)).toEqual([-2, 12, 7, 2, 2]);
  });

  it('powers of ten are exact in this engine (m depends on it)', () => {
    for (let k = -20; k <= 20; k++) expect(Math.log10(10 ** k)).toBe(k);
  });
});

describe('dateTime axis labels', () => {
  it('count seconds from the EPICS epoch in local time (UTC here), with hundredths', async () => {
    const { timeLabel } = await import('./XyGraph.js');
    const tz = process.env.TZ;
    process.env.TZ = 'UTC';
    expect(timeLabel(-20)).toEqual(['23:59:40', '12-31-1989']);
    expect(timeLabel(0.2)).toEqual(['00:00:00.20', '01-01-1990']);
    process.env.TZ = tz;
  });
});
