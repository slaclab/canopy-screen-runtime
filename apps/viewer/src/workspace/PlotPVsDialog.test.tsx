// PlotPVsDialog: the screen's PVs as a checkbox list, capped at what the data
// browser gets at once, plotted in screen order.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ScreenPVGroup } from '@slaclab/canopy-screen-runtime';
import type { ScreenTarget } from '../screenActions/types.js';
import { PlotPVsDialog } from './PlotPVsDialog.js';
import { MAX_PLOT_PVS } from './plotPVs.js';

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function target(collectPVs?: () => Promise<ScreenPVGroup[]>): ScreenTarget {
  return {
    category: 'lines',
    id: 'GTLView',
    title: 'GTL',
    macros: {},
    element: null,
    documentUrl: '',
    collectPVs,
  };
}

function open(groups: ScreenPVGroup[] | Error, currentQuery = '') {
  const onPlot = vi.fn();
  const onClose = vi.fn();
  const collect = () =>
    groups instanceof Error ? Promise.reject(groups) : Promise.resolve(groups);
  render(
    <PlotPVsDialog
      screen={target(collect)}
      currentQuery={currentQuery}
      onPlot={onPlot}
      onClose={onClose}
    />
  );
  return { onPlot, onClose, dialog: screen.getByRole('dialog') };
}

const box = (dialog: HTMLElement, name: string) =>
  within(dialog).getByLabelText(name) as HTMLInputElement;

describe('PlotPVsDialog', () => {
  it('shows one flat list for a screen without embedded PVs', async () => {
    const { dialog } = open([
      {
        key: '',
        title: 'GTL',
        detail: '',
        depth: 0,
        pvs: [{ name: 'A:I', role: 'readback' }],
      },
    ]);
    await within(dialog).findByLabelText('A:I');
    expect(dialog.querySelector('legend')).toBeNull();
    expect(within(dialog).getByText(/1 PV on this screen/)).toBeTruthy();
  });

  it('caps the selection and plots in screen order', async () => {
    const pvs = Array.from({ length: MAX_PLOT_PVS + 3 }, (_, i) => ({
      name: `R:${String(i).padStart(2, '0')}`,
      role: 'control' as const,
    }));
    const { dialog, onPlot } = open(
      [
        { key: '', title: 'GTL', detail: '', depth: 0, pvs: pvs.slice(0, 5) },
        { key: '/0:e', title: 'Sub', detail: 'M=1', depth: 1, pvs: pvs.slice(5) },
      ],
      'pv=OLD&range=-2h'
    );
    await within(dialog).findByLabelText('R:00');
    // Nothing is a readback, so nothing is preselected.
    expect(within(dialog).getByTestId('plot-pvs-count').textContent).toContain(
      `0 of ${MAX_PLOT_PVS}`
    );
    const plot = () => within(dialog).getByRole('button', { name: /^Plot \d+ PVs?$/ });
    expect((plot() as HTMLButtonElement).disabled).toBe(true);

    // Ticked last-to-first; the plot keeps screen order.
    for (const pv of [...pvs].reverse().slice(0, MAX_PLOT_PVS))
      fireEvent.click(box(dialog, pv.name));
    expect(within(dialog).getByTestId('plot-pvs-count').textContent).toContain(
      `${MAX_PLOT_PVS} of ${MAX_PLOT_PVS}`
    );
    // At the cap the rest cannot be ticked.
    expect(box(dialog, 'R:00').disabled).toBe(true);
    fireEvent.click(box(dialog, 'R:00'));
    expect(box(dialog, 'R:00').checked).toBe(false);

    fireEvent.click(plot());
    const expected = pvs.slice(3).map((pv) => `pv=${pv.name}`);
    expect(onPlot).toHaveBeenCalledExactlyOnceWith(`${expected.join('&')}&range=-2h`);
  });

  it('clears the selection', async () => {
    const { dialog } = open([
      {
        key: '',
        title: 'GTL',
        detail: '',
        depth: 0,
        pvs: [
          { name: 'A:I', role: 'readback' },
          { name: 'B:I', role: 'readback' },
        ],
      },
    ]);
    await waitFor(() => expect(box(dialog, 'A:I').checked).toBe(true));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Clear' }));
    expect(box(dialog, 'A:I').checked).toBe(false);
    expect(box(dialog, 'B:I').checked).toBe(false);
  });

  it('says so when the screen shows no PVs', async () => {
    const { dialog } = open([{ key: '', title: 'GTL', detail: '', depth: 0, pvs: [] }]);
    expect(await within(dialog).findByText('This screen shows no PVs.')).toBeTruthy();
  });

  it('reports a collection failure', async () => {
    const { dialog } = open(new Error('embedded screen 404'));
    expect(await within(dialog).findByText('embedded screen 404')).toBeTruthy();
  });
});
