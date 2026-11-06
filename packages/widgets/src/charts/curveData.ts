// Per-curve live data shared by the chart widgets: the PV subscriber that
// reports each curve's samples, the sample coercions, and the PenStyle mapping.

import { useEffect } from 'react';
import type { LineSeriesOption } from 'echarts';
import { usePV } from '@slaclab/canopy-react';

export type LineType = NonNullable<LineSeriesOption['lineStyle']>['type'];

/**
 * Maps Qt::PenStyle (1 solid, 2 dash, 3 dot, 4 dash-dot, 5 dash-dot-dot) to an
 * ECharts line type; a number[] is rendered as stroke-dasharray.
 */
export function dashFromLineStyle(style: number | undefined): LineType {
  switch (style) {
    case 2:
      return 'dashed';
    case 3:
      return 'dotted';
    case 4:
      return [8, 4, 2, 4];
    case 5:
      return [8, 4, 2, 4, 2, 4];
    default:
      return 'solid';
  }
}

/** Coerce a PV value to a numeric array (waveform) — scalars become a 1-point series. */
export function toNumberArray(value: unknown): number[] {
  if (Array.isArray(value)) {
    return value
      .map((v) => (typeof v === 'number' ? v : Number(v)))
      .filter((n) => Number.isFinite(n));
  }
  if (typeof value === 'number' && Number.isFinite(value)) return [value];
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? [n] : [];
  }
  return [];
}

/**
 * Index-preserving variant of `toNumberArray`: non-finite array entries become
 * `null` (drawn as a gap) instead of being dropped, so x/y pairing by index holds.
 */
export function toSamples(value: unknown): (number | null)[] {
  if (Array.isArray(value)) {
    return value.map((v) => {
      const n = typeof v === 'number' ? v : Number(v);
      return Number.isFinite(n) ? n : null;
    });
  }
  return toNumberArray(value);
}

/** Whether a PV value is sampleable at all: an array, a finite number, or a numeric string. */
function isSampleable(value: unknown): boolean {
  if (Array.isArray(value)) return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return Number.isFinite(Number(value));
  return false;
}

/** One live series: its y (and optional x) samples, keyed by curve index. */
export interface CurveData {
  y: (number | null)[];
  x?: (number | null)[];
}

export interface CurveSubscriberProps {
  index: number;
  yChannel: string | undefined;
  xChannel?: string | undefined;
  onData: (index: number, data: CurveData) => void;
  sample?: (value: unknown) => (number | null)[];
}

// A stable per-curve component (not a loop over usePV) so hook count stays
// constant across renders. Subscribes to one curve's channels and reports its
// latest arrays up by index; renders nothing.
export function CurveSubscriber({
  index,
  yChannel,
  xChannel,
  onData,
  sample = toNumberArray,
}: CurveSubscriberProps): null {
  const yPV = usePV(yChannel);
  const xPV = usePV(xChannel ?? undefined);

  const y = yPV.connected ? sample(yPV.value) : [];
  // x is undefined (index branch) when absent, disconnected, or not numeric.
  const x = xChannel && xPV.connected && isSampleable(xPV.value) ? sample(xPV.value) : undefined;

  // Report after render (not during); key on the samples so only real changes fire.
  const key = JSON.stringify([y, x ?? null]);
  useEffect(() => {
    onData(index, { y, x });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, key, onData]);
  return null;
}
