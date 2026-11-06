// The host side of widget actions: manifest lookup, navigation, window
// opening, closing and error display, supplied by the app embedding the
// runtime (the viewer). The renderer combines it with the widget's macros,
// its declaring document and the instance PV service to run `dispatchActions`.
//
// The default host only warns, so a renderer mounted without a provider still
// renders and runs `write_pv` actions; anything needing the host is a no-op.

import { createContext } from 'react';
import type { ActionContext } from './dispatch.js';

/** The callbacks an app provides; the renderer supplies macros and PV service. */
export type ActionHost = Omit<ActionContext, 'macros' | 'pvService'>;

const warned = new Set<string>();

function warnNoHost(what: string): void {
  if (warned.has(what)) return;
  warned.add(what);
  console.warn(`[canopy-screen-runtime] no ActionHost provided; '${what}' was ignored`);
}

/** Warn-only host used when no `ActionHostContext.Provider` is mounted. */
export const warnOnlyActionHost: ActionHost = {
  resolveManifest(file) {
    warnNoHost(`resolveManifest(${file})`);
    return null;
  },
  navigate(url) {
    warnNoHost(`navigate(${url})`);
  },
  openWindow(url) {
    warnNoHost(`openWindow(${url})`);
  },
  close() {
    warnNoHost('close');
  },
  showError(message) {
    warnNoHost(`showError(${message})`);
  },
};

export const ActionHostContext = createContext<ActionHost>(warnOnlyActionHost);
