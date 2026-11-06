// The link state of a set of PV channels: are the values a widget shows
// current, or is some channel down?
//
// `usePV` starts every channel disconnected, so it cannot tell "no data yet"
// from "dead". This hook reads the per-instance service directly instead:
// `getSnapshot` (undefined = nothing delivered yet) and `subscribe` (every
// later delivery). States:
//   - `pending`: some channel has delivered nothing yet; no cue is drawn.
//   - `connected`: every channel's latest snapshot is connected.
//   - `partial`: some, not all, channels are connected.
//   - `disconnected`: no channel is connected.
// `loc://` locals are skipped (they never reach a machine); `formula://` formula
// channels are included: a Formula Engine formula whose input is in an outage fails at
// once, so it is as machine-bound as a gateway PV.

import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { PVServiceContext } from '@slaclab/canopy-react';
import { isLocalChannel } from '../channels.js';
import type { PVData } from '@slaclab/canopy-screen-widgets';

export type PVLinkState = 'pending' | 'connected' | 'partial' | 'disconnected';

/** The channels a link state covers: trimmed, blanks and `loc://` dropped, unique, in order. */
export function linkChannels(names: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of names) {
    const name = raw.trim();
    if (name === '' || isLocalChannel(name) || out.includes(name)) continue;
    out.push(name);
  }
  return out;
}

/**
 * The link state of channels whose latest snapshots are `snapshots`
 * (`undefined` = nothing delivered yet). Null for no channel at all.
 */
export function linkStateOf(snapshots: readonly (PVData | undefined)[]): PVLinkState | null {
  if (snapshots.length === 0) return null;
  let connected = 0;
  for (const snapshot of snapshots) {
    if (snapshot === undefined) return 'pending';
    if (snapshot.connected) connected += 1;
  }
  if (connected === snapshots.length) return 'connected';
  return connected === 0 ? 'disconnected' : 'partial';
}

/**
 * The link state of `names` (see the module comment) on the ambient
 * PVService; null when no machine channel is left after dropping `loc://`
 * names. Without a PVService in context the channels can never connect, so
 * the state is `disconnected`. The state is set only when it changes.
 */
export function usePVLinkState(names: readonly string[]): PVLinkState | null {
  const service = useContext(PVServiceContext);
  // Keyed on the joined names, so a fresh array with the same names keeps
  // the subscriptions.
  const key = linkChannels(names).join('\n');
  const channels = useMemo(() => (key === '' ? [] : key.split('\n')), [key]);

  const initial = (): PVLinkState | null => {
    if (channels.length === 0) return null;
    if (!service) return 'disconnected';
    return linkStateOf(channels.map((name) => service.getSnapshot(name)));
  };
  const [state, setState] = useState<PVLinkState | null>(initial);
  // The last state set, so a delivery that leaves it unchanged schedules no
  // render at all (a same-value setState can still re-render once).
  const current = useRef(state);

  useEffect(() => {
    const set = (next: PVLinkState | null) => {
      if (current.current === next) return;
      current.current = next;
      setState(next);
    };
    if (channels.length === 0) {
      set(null);
      return;
    }
    if (!service) {
      set('disconnected');
      return;
    }
    const latest = new Map<string, PVData | undefined>(
      channels.map((name) => [name, service.getSnapshot(name)])
    );
    let subscribed = false;
    const recompute = () => set(linkStateOf(channels.map((name) => latest.get(name))));
    const unsubscribes = channels.map((name) =>
      service.subscribe(name, (data) => {
        latest.set(name, data);
        if (subscribed) recompute();
      })
    );
    subscribed = true;
    recompute();
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  }, [service, channels]);

  return state;
}
