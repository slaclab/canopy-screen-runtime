// The PV layer screens subscribe through: a registry of connections by EDM
// PV scheme (the cs-web-lib "connection plugin" idea), plus a record of what
// each widget subscribed, so the fidelity harness can compare the bound PV
// set with EDM's (PV parity).

import { AlarmSeverity } from '@slaclab/canopy-client';
import { parsePvName } from './names.js';
import type { EdmPvScheme } from './names.js';
import type { EdmPvConnection, EdmPvData, EdmPvListener } from './types.js';

export const DISCONNECTED: EdmPvData = {
  connected: false,
  type: 'unknown',
  num: 0,
  text: '',
  severity: AlarmSeverity.DISCONNECTED,
  units: '',
  precision: null,
  enumChoices: [],
  lowerLimit: 0,
  upperLimit: 0,
  writable: false,
};

export interface EdmPvSubscription {
  /** The PV string as written in the .edl, before macro expansion. */
  readonly raw: string;
  /** After macro expansion, with its type prefix. */
  readonly expanded: string;
  readonly scheme: EdmPvScheme;
  readonly name: string;
  /** "<EDM class>.<property>" of the subscriber. */
  readonly by: string;
  /**
   * '' for the displayed screen itself; for an object inside an embedded
   * display or symbol file, the chain of files it came through.
   */
  readonly scope: string;
  /** False when no connection serves the scheme (placeholder data only). */
  readonly served: boolean;
}

export class EdmPvLayer {
  private readonly connections = new Map<EdmPvScheme, EdmPvConnection>();
  private readonly log = new Map<string, EdmPvSubscription>();
  /** Last connection state per expanded PV (undefined until its first update). */
  private readonly state = new Map<string, boolean | undefined>();

  register(scheme: EdmPvScheme, connection: EdmPvConnection): this {
    this.connections.set(scheme, connection);
    return this;
  }

  /**
   * Subscribe to an expanded EDM PV string. Unserved schemes (CALC\ in M0)
   * stay disconnected but are still recorded.
   */
  subscribe(
    raw: string,
    expanded: string,
    by: string,
    listener: EdmPvListener,
    scope = ''
  ): () => void {
    const ref = parsePvName(expanded);
    if (!ref) return () => {};
    const conn = this.connections.get(ref.scheme);
    const key = `${expanded}\u0000${by}\u0000${scope}`;
    if (!this.log.has(key)) {
      const sub = { raw, expanded, scheme: ref.scheme, name: ref.name, by, served: !!conn, scope };
      this.log.set(key, sub);
    }
    if (!this.state.has(expanded)) this.state.set(expanded, undefined);
    if (!conn) {
      this.state.set(expanded, false);
      listener(DISCONNECTED);
      return () => {};
    }
    return conn.subscribe(ref.name, (d) => {
      this.state.set(expanded, d.connected);
      listener(d);
    });
  }

  /** Channel states: `pending` = subscribed but no update yet. */
  stats(): { pvs: number; connected: number; disconnected: string[]; pending: string[] } {
    const disconnected: string[] = [];
    const pending: string[] = [];
    let connected = 0;
    for (const [pv, st] of this.state) {
      if (st === true) connected++;
      else if (st === false) disconnected.push(pv);
      else pending.push(pv);
    }
    return { pvs: this.state.size, connected, disconnected, pending };
  }

  put(expanded: string, value: number | string): void {
    const ref = parsePvName(expanded);
    if (!ref) return;
    this.connections.get(ref.scheme)?.put?.(ref.name, value);
  }

  /** Everything subscribed since the layer was created (or last cleared). */
  subscriptions(): EdmPvSubscription[] {
    return [...this.log.values()];
  }

  clearLog(): void {
    this.log.clear();
  }
}
