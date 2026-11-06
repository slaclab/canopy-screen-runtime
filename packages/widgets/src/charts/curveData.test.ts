// Shared curve-data helpers: the per-curve PV subscriber, its change key, and
// the sample coercions used by WaveformPlot and XYPlot.
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';

let pvState: Record<string, { connected: boolean; value: unknown }> = {};

vi.mock('@slaclab/canopy-react', () => ({
  usePV: (address?: string) => ({
    address: address ?? '',
    connected: (address && pvState[address]?.connected) || false,
    value: address ? pvState[address]?.value : undefined,
    displayValue: '',
    severity: 0,
    put: () => {},
  }),
}));

const { CurveSubscriber, dashFromLineStyle, toNumberArray, toSamples } =
  await import('./curveData.js');

afterEach(cleanup);
beforeEach(() => {
  pvState = {};
});

describe('CurveSubscriber', () => {
  it('fires again when x moves while y stays still', () => {
    pvState = {
      Y: { connected: true, value: [1, 2, 3] },
      X: { connected: true, value: [10, 20, 30] },
    };
    const onData = vi.fn();
    const el = () =>
      createElement(CurveSubscriber, { index: 0, yChannel: 'Y', xChannel: 'X', onData });
    const { rerender } = render(el());
    expect(onData).toHaveBeenCalledTimes(1);
    expect(onData).toHaveBeenLastCalledWith(0, { y: [1, 2, 3], x: [10, 20, 30] });

    pvState = { ...pvState, X: { connected: true, value: [10, 25, 30] } };
    act(() => rerender(el()));
    expect(onData).toHaveBeenCalledTimes(2);
    expect(onData).toHaveBeenLastCalledWith(0, { y: [1, 2, 3], x: [10, 25, 30] });

    // No change: no extra callback.
    act(() => rerender(el()));
    expect(onData).toHaveBeenCalledTimes(2);
  });

  it("reports x undefined when the x PV value is 'n/a'", () => {
    pvState = {
      Y: { connected: true, value: [0.3] },
      X: { connected: true, value: 'n/a' },
    };
    const onData = vi.fn();
    render(createElement(CurveSubscriber, { index: 2, yChannel: 'Y', xChannel: 'X', onData }));
    expect(onData).toHaveBeenLastCalledWith(2, { y: [0.3], x: undefined });
  });

  it('reports x undefined when the x PV is absent or disconnected', () => {
    pvState = { Y: { connected: true, value: 5 }, X: { connected: false, value: [1] } };
    const onData = vi.fn();
    render(createElement(CurveSubscriber, { index: 0, yChannel: 'Y', xChannel: 'X', onData }));
    expect(onData).toHaveBeenLastCalledWith(0, { y: [5], x: undefined });
    cleanup();
    const onData2 = vi.fn();
    render(createElement(CurveSubscriber, { index: 1, yChannel: 'Y', onData: onData2 }));
    expect(onData2).toHaveBeenLastCalledWith(1, { y: [5], x: undefined });
  });

  it('uses the sample prop when given', () => {
    pvState = {
      Y: { connected: true, value: [1, Number.NaN, 3] },
      X: { connected: true, value: [0, 1, 2] },
    };
    const onData = vi.fn();
    render(
      createElement(CurveSubscriber, {
        index: 0,
        yChannel: 'Y',
        xChannel: 'X',
        onData,
        sample: toSamples,
      })
    );
    expect(onData).toHaveBeenLastCalledWith(0, { y: [1, null, 3], x: [0, 1, 2] });
  });

  it('defaults to toNumberArray and gives y [] when disconnected', () => {
    pvState = { Y: { connected: false, value: [1, 2] } };
    const onData = vi.fn();
    render(createElement(CurveSubscriber, { index: 0, yChannel: 'Y', onData }));
    expect(onData).toHaveBeenLastCalledWith(0, { y: [], x: undefined });
  });
});

describe('toSamples', () => {
  it('is index-preserving and maps non-finite values to null', () => {
    expect(toSamples([1, NaN, 3])).toEqual([1, null, 3]);
    expect(toSamples(['2', 'x', Infinity])).toEqual([2, null, null]);
  });

  it('coerces scalars like toNumberArray', () => {
    expect(toSamples(4)).toEqual([4]);
    expect(toSamples('7')).toEqual([7]);
    expect(toSamples('n/a')).toEqual([]);
    expect(toSamples(null)).toEqual([]);
  });
});

describe('toNumberArray', () => {
  it('filters non-finite values', () => {
    expect(toNumberArray([1, NaN, 3])).toEqual([1, 3]);
    expect(toNumberArray(2)).toEqual([2]);
    expect(toNumberArray('n/a')).toEqual([]);
  });
});

describe('dashFromLineStyle', () => {
  it('maps Qt::PenStyle 1..5', () => {
    expect(dashFromLineStyle(1)).toBe('solid');
    expect(dashFromLineStyle(2)).toBe('dashed');
    expect(dashFromLineStyle(3)).toBe('dotted');
    expect(dashFromLineStyle(4)).toEqual([8, 4, 2, 4]);
    expect(dashFromLineStyle(5)).toEqual([8, 4, 2, 4, 2, 4]);
  });

  it('falls back to solid', () => {
    expect(dashFromLineStyle(undefined)).toBe('solid');
    expect(dashFromLineStyle(0)).toBe('solid');
    expect(dashFromLineStyle(9)).toBe('solid');
  });
});
