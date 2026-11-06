// Fixture PV service: a recorded snapshot in Formula Engine binding form, served as
// PVData so every stock widget renders it exactly like live gateway PVs.

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FixturePVService,
  parseFixtureSnapshot,
  type FixtureSnapshot,
} from './FixturePVService.js';

const SNAPSHOT: FixtureSnapshot = {
  timestamp: 1700000000,
  pvs: {
    'SYN:AI': { value: 3.25, connected: true },
    'SYN:AI.SEVR': { value: 1, connected: true },
    'SYN:MODE': { value: 2, connected: true },
    'SYN:BI': 1,
    'SYN:BI.SEVR': 2,
    'SYN:NAME': { value: 'beam' },
    'SYN:GONE': { value: 7, connected: false },
    'SYN:GONE.SEVR': { value: 2, connected: true },
    'SYN:BADSEV': 5,
    'SYN:BADSEV.SEVR': 9,
  },
};

function service(snapshot: FixtureSnapshot = SNAPSHOT): FixturePVService {
  const s = new FixturePVService(snapshot);
  s.connect();
  return s;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('FixturePVService', () => {
  it('serves an enum PV as its stored index, displayValue unchanged', () => {
    const listener = vi.fn();
    service().subscribe('SYN:MODE', listener);
    expect(listener).toHaveBeenCalledTimes(1);
    const data = listener.mock.calls[0][0];
    expect(data.value).toBe(2);
    expect(data.displayValue).toBe('2');
    expect(data.connected).toBe(true);
    expect(data.severity).toBe(0);
    expect(data.enumChoices).toBeUndefined();
  });

  it('feeds <pv>.SEVR into the base PV severity as a number', () => {
    const s = service();
    const ai = vi.fn();
    s.subscribe('SYN:AI', ai);
    expect(ai.mock.calls[0][0]).toMatchObject({
      value: 3.25,
      displayValue: '3.25',
      severity: 1,
      connected: true,
      timestamp: 1700000000,
    });
    const bi = vi.fn();
    s.subscribe('SYN:BI', bi);
    expect(bi.mock.calls[0][0]).toMatchObject({ value: 1, severity: 2, connected: true });
  });

  it('serves the .SEVR channel itself as a plain numeric PV', () => {
    const listener = vi.fn();
    service().subscribe('SYN:AI.SEVR', listener);
    expect(listener.mock.calls[0][0]).toMatchObject({ value: 1, severity: 0, connected: true });
  });

  it('serves string values and treats a missing connected flag as connected', () => {
    const listener = vi.fn();
    service().subscribe('SYN:NAME', listener);
    expect(listener.mock.calls[0][0]).toMatchObject({
      value: 'beam',
      displayValue: 'beam',
      connected: true,
      severity: 0,
    });
  });

  it('renders a recorded disconnected PV as disconnected (severity 4), ignoring its SEVR', () => {
    const listener = vi.fn();
    service().subscribe('SYN:GONE', listener);
    expect(listener.mock.calls[0][0]).toMatchObject({
      value: 0,
      displayValue: '---',
      severity: 4,
      connected: false,
    });
  });

  it('renders a PV absent from the snapshot as disconnected', () => {
    const s = service();
    const listener = vi.fn();
    s.subscribe('SYN:NOT_THERE', listener);
    expect(listener.mock.calls[0][0]).toMatchObject({ connected: false, severity: 4 });
    expect(s.getSnapshot('SYN:NOT_THERE')?.connected).toBe(false);
  });

  it('drops an out-of-range SEVR rather than inventing a severity', () => {
    const listener = vi.fn();
    service().subscribe('SYN:BADSEV', listener);
    expect(listener.mock.calls[0][0]).toMatchObject({ value: 5, severity: 0, connected: true });
  });

  it('resolves ca:// and pva:// names against the bare PV name', () => {
    const s = service();
    expect(s.getSnapshot('ca://SYN:AI')).toMatchObject({ value: 3.25, severity: 1 });
    expect(s.getSnapshot('pva://SYN:MODE')).toMatchObject({ value: 2 });
  });

  it('defaults timestamp to 0 so renders are deterministic', () => {
    const s = service({ pvs: { X: 1 } });
    expect(s.getSnapshot('X')?.timestamp).toBe(0);
  });

  it('returns an idempotent unsubscribe and never pushes after subscribe', () => {
    const s = service();
    const listener = vi.fn();
    const off = s.subscribe('SYN:AI', listener);
    off();
    off();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('ignores put with a warning (the fixture is read-only)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = service();
    s.put('SYN:AI', 9);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(s.getSnapshot('SYN:AI')?.value).toBe(3.25);
  });

  it('tracks isConnected through connect/disconnect', () => {
    const s = new FixturePVService(SNAPSHOT);
    expect(s.isConnected).toBe(false);
    s.connect();
    expect(s.isConnected).toBe(true);
    s.disconnect();
    expect(s.isConnected).toBe(false);
  });
});

describe('parseFixtureSnapshot', () => {
  it('accepts the documented shape', () => {
    const parsed = parseFixtureSnapshot(JSON.parse(JSON.stringify(SNAPSHOT)));
    expect(parsed.pvs['SYN:AI']).toEqual({ value: 3.25, connected: true });
    expect(parsed.timestamp).toBe(1700000000);
  });

  it.each([
    ['null', null],
    ['an array', []],
    ['no pvs', {}],
    ['pvs as an array', { pvs: [] }],
    ['an object value without value', { pvs: { X: { connected: true } } }],
    ['a non-scalar value', { pvs: { X: { value: [1, 2] } } }],
    ['a non-boolean connected', { pvs: { X: { value: 1, connected: 'yes' } } }],
    ['a null bare value', { pvs: { X: null } }],
    ['a non-numeric timestamp', { pvs: {}, timestamp: 'now' }],
  ])('rejects %s', (_label, raw) => {
    expect(() => parseFixtureSnapshot(raw)).toThrow(/fixture/i);
  });
});
