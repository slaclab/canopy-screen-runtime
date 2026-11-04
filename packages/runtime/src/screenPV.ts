// Screen-scoped PV routing: `fox://<name>` widget channels → screen formulas.
//
// Converters emit calc channels (EDM `CALC\{expr}(a,b)`, PyDM `calc://`) as
// screen-level `formulas[]` declarations, referenced from widget channel
// props as `fox://<name>`. Widgets are scheme-unaware — they call
// usePV(address) against the ambient PVService — so the renderer installs one
// ScreenPVService per rendered screen (the root and every embedded screen):
//
//  - `fox://<name>` resolves against THAT screen's `formulas[]`, with THAT
//    screen's effective macros substituted into the bindings (the same
//    compileFormulaSpec path formula-driven rules use), and is evaluated
//    through the ambient FormulaSubscriber — Fox over WS
//    /fox/v1/ws/formulas, or page-local for loc://-only formulas. Results
//    feed widgets as PVData: value, severity (Fox's worst input severity),
//    connected. One upstream subscription per formula name, shared by every
//    widget that reads it.
//  - Formula channels are read-only: `put` is rejected with a warning.
//  - Every other address delegates to the parent service untouched, so an
//    embedded screen's scope chains up to the page's (Hare/mock + loc://)
//    service while its own `fox://` names never leak to the parent's
//    formulas.
//
// Anything that keeps a formula from evaluating — no declaration, a
// non-scalar kind, a compile error, a `fox://` binding (Fox rejects
// formula-of-formula), a Fox error frame — leaves the channel disconnected
// (widgets show their `---` placeholder) with a console warning; never a
// crash. Without a FormulaSubscriber (no formula service at all) formula
// channels simply stay disconnected, as rules stay inert.

import type { FormulaDeclaration, MacroValues } from '@slaclab/canopy-screen-ir';
import type { PVData, PVListener, PVService } from '@slaclab/canopy-screen-widgets';
import { AlarmSeverity, DISCONNECTED_PV } from '@slaclab/canopy-screen-widgets';
import type {
  FormulaResultMeta,
  FormulaScalarValue,
  FormulaSeverity,
  FormulaSpec,
  FormulaSubscriber,
} from './formula.js';
import { foxName, isFoxRef } from './foxRef.js';
import { compileFormulaSpec, RuleCompileError } from './rules/compileRule.js';

const SEVERITY: Readonly<Record<FormulaSeverity, AlarmSeverity>> = {
  NO_ALARM: AlarmSeverity.NO_ALARM,
  MINOR: AlarmSeverity.MINOR,
  MAJOR: AlarmSeverity.MAJOR,
  INVALID: AlarmSeverity.INVALID,
};

/** Significant digits for formula display values (Fox reports no precision). */
const DISPLAY_SIGNIFICANT_DIGITS = 6;

/**
 * Display text for a formula result. Fox carries no display metadata
 * (precision/units), so floats are shown to a bounded number of significant
 * digits with trailing zeros trimmed; integers, strings and booleans as-is.
 */
export function formatFormulaValue(value: FormulaScalarValue): string {
  if (typeof value !== 'number') return String(value);
  if (!Number.isFinite(value) || Number.isInteger(value)) return String(value);
  return String(Number(value.toPrecision(DISPLAY_SIGNIFICANT_DIGITS)));
}

interface FormulaChannel {
  readonly listeners: Set<PVListener>;
  data: PVData;
  /** Upstream formula unsubscribe; absent when the channel never subscribed. */
  release?: () => void;
  closed: boolean;
}

export class ScreenPVService implements PVService {
  private readonly parent: PVService;
  private readonly formulas: readonly FormulaDeclaration[] | undefined;
  private readonly macros: MacroValues;
  private readonly subscriber: FormulaSubscriber | null;
  private readonly channels = new Map<string, FormulaChannel>();
  /** Warnings already printed by this scope (dedupes recurring Fox errors). */
  private readonly warned = new Set<string>();

  constructor(
    parent: PVService,
    formulas: readonly FormulaDeclaration[] | undefined,
    macros: MacroValues,
    subscriber: FormulaSubscriber | null
  ) {
    this.parent = parent;
    this.formulas = formulas;
    this.macros = macros;
    this.subscriber = subscriber;
  }

  // ── PVService ────────────────────────────────────────────────────────────

  subscribe(pvName: string, listener: PVListener): () => void {
    if (!isFoxRef(pvName)) return this.parent.subscribe(pvName, listener);

    let channel = this.channels.get(pvName);
    if (!channel) {
      channel = this.open(pvName);
      this.channels.set(pvName, channel);
    }
    const owned = channel;
    owned.listeners.add(listener);
    listener(owned.data);

    return () => {
      if (!owned.listeners.delete(listener) || owned.listeners.size > 0) return;
      owned.closed = true;
      owned.release?.();
      if (this.channels.get(pvName) === owned) this.channels.delete(pvName);
    };
  }

  put(pvName: string, value: number | string | boolean): void {
    if (!isFoxRef(pvName)) {
      this.parent.put(pvName, value);
      return;
    }
    console.warn(
      `'${pvName}' is a read-only formula channel; write of ${JSON.stringify(value)} rejected`
    );
  }

  getSnapshot(pvName: string): PVData | undefined {
    if (!isFoxRef(pvName)) return this.parent.getSnapshot(pvName);
    return this.channels.get(pvName)?.data;
  }

  /** No-op: the composition root owns the parent service's lifecycle. */
  connect(): void {}

  /** No-op: formula channels release with their last listener. */
  disconnect(): void {}

  get isConnected(): boolean {
    return this.parent.isConnected;
  }

  // ── Formula channels ─────────────────────────────────────────────────────

  private open(address: string): FormulaChannel {
    const channel: FormulaChannel = {
      listeners: new Set(),
      data: DISCONNECTED_PV,
      closed: false,
    };

    const spec = this.resolve(address);
    if (!spec || !this.subscriber) return channel;

    channel.release = this.subscriber.subscribe(spec, {
      onResult: (value, meta) => {
        if (channel.closed) return;
        this.update(channel, resultData(value, meta));
      },
      onError: (error) => {
        if (channel.closed) return;
        this.warnOnce(`formula channel '${address}' evaluation error: ${error.message}`);
        this.update(channel, {
          ...channel.data,
          connected: false,
          severity: AlarmSeverity.DISCONNECTED,
        });
      },
    });
    return channel;
  }

  /** The address's FormulaSpec, or undefined (with a warning) when it can't evaluate. */
  private resolve(address: string): FormulaSpec | undefined {
    const name = foxName(address);
    const decl = (this.formulas ?? []).find((f) => f.name === name);
    if (!decl) {
      this.warnOnce(`widget channel '${address}': no formulas[] entry declares '${name}'`);
      return undefined;
    }
    const kind = decl.kind ?? 'scalar';
    if (kind !== 'scalar') {
      this.warnOnce(
        `widget channel '${address}': '${kind}' formulas cannot feed a widget channel (scalar only)`
      );
      return undefined;
    }

    let spec: FormulaSpec;
    try {
      spec = compileFormulaSpec(decl, this.macros);
    } catch (err) {
      if (!(err instanceof RuleCompileError)) throw err;
      this.warnOnce(`widget channel '${address}': ${err.message}`);
      return undefined;
    }

    const nested = Object.values(spec.bindings).filter(isFoxRef);
    if (nested.length > 0) {
      this.warnOnce(
        `widget channel '${address}': formula-of-formula bindings (${nested.join(', ')}) ` +
          'are not supported by Fox'
      );
      return undefined;
    }
    return spec;
  }

  private update(channel: FormulaChannel, data: PVData): void {
    channel.data = data;
    for (const listener of channel.listeners) listener(data);
  }

  private warnOnce(message: string): void {
    if (this.warned.has(message)) return;
    this.warned.add(message);
    console.warn(message);
  }
}

function resultData(value: FormulaScalarValue, meta: FormulaResultMeta | undefined): PVData {
  return {
    value,
    displayValue: formatFormulaValue(value),
    severity: meta?.severity
      ? (SEVERITY[meta.severity] ?? AlarmSeverity.INVALID)
      : AlarmSeverity.NO_ALARM,
    connected: true,
    timestamp: meta?.timestampMs ?? Date.now(),
    units: '',
    precision: 0,
    lowerLimit: 0,
    upperLimit: 0,
  };
}
