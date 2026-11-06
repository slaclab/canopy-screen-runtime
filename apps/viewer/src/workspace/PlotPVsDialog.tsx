// The chooser behind the screen action "Plot in Data Browser": the screen's
// PVs (collectScreenPVs, embedded screens included) as a searchable checkbox
// list, grouped per embedded screen when the screen has more than one group,
// with a small readable selection preset (plotPVs.ts). "Plot" hands the
// picked PVs, in screen order, to the host, which opens the data browser.

import { useEffect, useMemo, useState } from 'react';
import { Checkbox, InlineLoading, InlineNotification, Modal, Search } from '@carbon/react';
import type { ScreenPVGroup } from '@slaclab/canopy-screen-runtime';
import type { ScreenTarget } from '../screenActions/types.js';
import {
  MAX_PLOT_PVS,
  defaultSelection,
  filterGroups,
  fitsTraceQuery,
  plotQuery,
} from './plotPVs.js';
import './PlotPVsDialog.css';

export interface PlotPVsDialogProps {
  /** The screen whose PVs are offered. */
  screen: ScreenTarget;
  /** The data browser's current query, whose time range the plot keeps. */
  currentQuery: string;
  /** Called with the Trace query of the picked PVs. */
  onPlot: (query: string) => void;
  onClose: () => void;
}

type Loaded =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; groups: ScreenPVGroup[] };

const ROLE_LABEL: Record<string, string> = {
  readback: 'value',
  plot: 'plot',
  control: 'control',
  status: 'status',
  rule: 'rule',
  formula: 'formula input',
  other: '',
};

export function PlotPVsDialog({ screen, currentQuery, onPlot, onClose }: PlotPVsDialogProps) {
  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' });
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [search, setSearch] = useState('');

  const collect = screen.collectPVs;
  useEffect(() => {
    if (!collect) return;
    let cancelled = false;
    collect().then(
      (groups) => {
        if (cancelled) return;
        setLoaded({ status: 'ready', groups });
        setSelected(new Set(defaultSelection(groups)));
      },
      (err: unknown) => {
        if (!cancelled)
          setLoaded({ status: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    );
    return () => {
      cancelled = true;
    };
  }, [collect]);
  const state: Loaded = collect
    ? loaded
    : { status: 'error', message: 'This screen cannot list its PVs.' };

  const groups = useMemo(() => (loaded.status === 'ready' ? loaded.groups : []), [loaded]);
  const total = useMemo(() => groups.reduce((n, g) => n + g.pvs.length, 0), [groups]);
  const shown = useMemo(() => filterGroups(groups, search), [groups, search]);
  const grouped = groups.filter((g) => g.pvs.length > 0).length > 1;
  // Plot order is screen order, whatever order the boxes were ticked in.
  const picked = useMemo(
    () => groups.flatMap((g) => g.pvs.map((pv) => pv.name)).filter((name) => selected.has(name)),
    [groups, selected]
  );
  const query = plotQuery(picked, currentQuery);
  const fits = fitsTraceQuery(query);
  const full = picked.length >= MAX_PLOT_PVS;

  const toggle = (name: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on && next.size < MAX_PLOT_PVS) next.add(name);
      else next.delete(name);
      return next;
    });

  return (
    <Modal
      open
      size="sm"
      className="plot-pvs"
      modalHeading="Plot in Data Browser"
      primaryButtonText={picked.length === 1 ? 'Plot 1 PV' : `Plot ${picked.length} PVs`}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={picked.length === 0 || !fits}
      onRequestClose={onClose}
      onRequestSubmit={() => {
        if (picked.length > 0 && fits) onPlot(query);
      }}
    >
      {state.status === 'loading' && <InlineLoading description="Collecting the screen's PVs…" />}
      {state.status === 'error' && (
        <InlineNotification
          kind="error"
          lowContrast
          hideCloseButton
          title="Could not list the PVs"
          subtitle={state.message}
        />
      )}
      {state.status === 'ready' && total === 0 && (
        <p className="plot-pvs__empty">This screen shows no PVs.</p>
      )}
      {state.status === 'ready' && total > 0 && (
        <>
          <p className="plot-pvs__intro">
            {total === 1 ? '1 PV' : `${total} PVs`} on this screen. Pick up to {MAX_PLOT_PVS}; the
            data browser opens with them, replacing what it shows.
          </p>
          <Search
            id="plot-pvs-search"
            size="sm"
            labelText="Filter PVs"
            placeholder="Filter by PV name or embedded screen"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            data-modal-primary-focus
          />
          <div className="plot-pvs__bar">
            <span data-testid="plot-pvs-count" aria-live="polite">
              {picked.length} of {MAX_PLOT_PVS} selected
              {full ? ' (the most the data browser gets at once)' : ''}
            </span>
            <button
              type="button"
              className="plot-pvs__clear"
              disabled={picked.length === 0}
              onClick={() => setSelected(new Set())}
            >
              Clear
            </button>
          </div>
          {!fits && (
            <InlineNotification
              kind="warning"
              lowContrast
              hideCloseButton
              title="Too long"
              subtitle="These PV names do not fit the data browser's link; pick fewer."
            />
          )}
          <div className="plot-pvs__list" data-testid="plot-pvs-list">
            {shown.length === 0 && <p className="plot-pvs__empty">No PV matches.</p>}
            {shown.map((group) => (
              <fieldset key={group.key} className="plot-pvs__group">
                {grouped && (
                  <legend
                    className="plot-pvs__legend"
                    style={{ paddingInlineStart: `${group.depth * 0.75}rem` }}
                    title={group.detail || undefined}
                  >
                    <span className="plot-pvs__title">
                      {group.depth === 0 ? `${group.title} (this screen)` : group.title}
                    </span>
                    {group.detail && <span className="plot-pvs__detail">{group.detail}</span>}
                  </legend>
                )}
                {group.pvs.map((pv) => {
                  const checked = selected.has(pv.name);
                  return (
                    <div key={pv.name} className="plot-pvs__row">
                      <Checkbox
                        id={`plot-pv-${encodeURIComponent(`${group.key}|${pv.name}`)}`}
                        labelText={pv.name}
                        checked={checked}
                        disabled={!checked && full}
                        onChange={(_e, { checked: on }) => toggle(pv.name, on)}
                      />
                      {ROLE_LABEL[pv.role] && (
                        <span className="plot-pvs__role">{ROLE_LABEL[pv.role]}</span>
                      )}
                    </div>
                  );
                })}
              </fieldset>
            ))}
          </div>
        </>
      )}
    </Modal>
  );
}
