// IR widget type → renderable widget mapping for the runtime.
//
// Ported from the builder's src/editor/import/irWidgetMap.ts (the IR ↔ SB
// contract), trimmed to the rendering direction: no editor actions, no
// import report. Each entry maps an IR node's type + props bag onto a widget
// registry type and its component props; keys not consumed by the mapper
// pass through verbatim so newer-than-runtime props survive.
//
// NOT handled here (the renderer special-cases them before lookup):
//  - `absolute-canvas` → a chrome-less positioned container (no component)
//  - `embedded-display` → recursive screen embedding
//  - `unknown-widget` and any unmapped IR type → labeled placeholder box
//
// `related-display-button` renders as a plain button; its open-display
// navigation action is not wired in runtime v0.1 (the viewer owns routing).
//
// Two deliberate deviations from the builder's table, both because the
// unified live components are the single render target here:
//  - `pv-button`'s `pv` maps to `controlPV` (what CarbonPVButton writes),
//    not `pvName` (which it ignores);
//  - a button `label` also populates `onLabel`/`offLabel` so the authored
//    text is what CarbonPVButton actually shows.

import type { WidgetProps, WidgetType } from '@slaclab/canopy-screen-widgets';
import { isFoxRef } from '../foxRef.js';

type IRProps = Record<string, unknown>;
type PropMapper = (ir: IRProps, props: WidgetProps) => void;

interface TypeMapEntry {
  type: WidgetType;
  map: PropMapper;
  /** IR prop keys this mapper reads; the generic pass-through skips these. */
  consumes: readonly string[];
}

export interface MappedWidget {
  type: WidgetType;
  props: WidgetProps;
}

// ── Coercion helpers (mirror the builder's) ─────────────────────────────────

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
function num(v: unknown): number | undefined {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}
function bool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}

function put(props: WidgetProps, key: string, value: unknown): void {
  if (value !== undefined) props[key] = value;
}

const FOREGROUND = ['foregroundColor', 'backgroundColor', 'borderColor', 'fontSize', 'fontFamily'];
function copyAppearance(ir: IRProps, props: WidgetProps): void {
  for (const k of FOREGROUND) put(props, k, ir[k]);
}

/** Copy every IR prop through verbatim, under its own key. */
function copyVerbatim(ir: IRProps, props: WidgetProps): void {
  for (const [k, v] of Object.entries(ir)) put(props, k, v);
}

/**
 * Copy every IR prop through verbatim, with the builder's `pv` → `pvName`
 * hand-authoring tolerance for SB-native pv-flavored types.
 */
function copyPvFlavoredVerbatim(ir: IRProps, props: WidgetProps): void {
  for (const [k, v] of Object.entries(ir)) {
    if (k === 'pv' && typeof v === 'string' && ir.pvName === undefined) {
      put(props, 'pvName', v);
    } else {
      put(props, k, v);
    }
  }
}

const TYPE_MAP: Record<string, TypeMapEntry> = {
  'text-label': {
    type: 'StaticLabel',
    map: (ir, p) => {
      put(p, 'text', str(ir.text) ?? str(ir.label));
      if (ir.text !== undefined && ir.label !== undefined) put(p, 'label', ir.label);
      copyAppearance(ir, p);
    },
    consumes: ['text', 'label', ...FOREGROUND],
  },
  'pv-label': {
    type: 'PVTextDisplay',
    map: (ir, p) => {
      put(p, 'pvName', str(ir.pv));
      // Fallback shown by a static (channel-less) PyDMLabel with no PV bound.
      put(p, 'text', str(ir.text));
      put(p, 'format', ir.format);
      put(p, 'precision', num(ir.precision));
      put(p, 'showUnits', bool(ir.showUnits));
      // A fox:// formula channel carries no PV precision, so the authored
      // precision is the only source (EDM without limitsFromDb; PyDM's
      // precision-property fallback) unless the IR says otherwise.
      put(p, 'precisionFromPV', bool(ir.precisionFromPV) ?? (isFoxRef(ir.pv) ? false : undefined));
      copyAppearance(ir, p);
    },
    consumes: ['pv', 'text', 'format', 'precision', 'showUnits', 'precisionFromPV', ...FOREGROUND],
  },
  'pv-text-input': {
    type: 'PVTextInput',
    map: (ir, p) => {
      put(p, 'pvName', str(ir.pv));
      put(p, 'confirmOnWrite', bool(ir.confirmOnWrite));
      put(p, 'confirmMessage', str(ir.confirmMessage));
      copyAppearance(ir, p);
    },
    consumes: ['pv', 'confirmOnWrite', 'confirmMessage', ...FOREGROUND],
  },
  'pv-button': {
    type: 'PVButton',
    map: (ir, p) => {
      // The runtime PVButton reads controlPV (multi-PV button); the IR's
      // `pv` is its control channel and `readbackPV` its state source.
      put(p, 'controlPV', str(ir.pv));
      put(p, 'readbackPV', str(ir.readbackPV));
      put(p, 'buttonType', str(ir.buttonType));
      put(p, 'label', str(ir.label));
      // Authored state labels win; a plain label populates both so the
      // authored text is what the button shows in either state.
      put(p, 'onLabel', str(ir.onLabel) ?? str(ir.label));
      put(p, 'offLabel', str(ir.offLabel) ?? str(ir.label));
      put(p, 'pressValue', ir.pressValue);
      put(p, 'releaseValue', ir.releaseValue);
    },
    consumes: [
      'pv',
      'readbackPV',
      'buttonType',
      'label',
      'onLabel',
      'offLabel',
      'pressValue',
      'releaseValue',
    ],
  },
  'regular-button': {
    type: 'PVButton',
    map: (ir, p) => {
      put(p, 'label', str(ir.label));
      if (ir.label !== undefined) {
        put(p, 'onLabel', str(ir.label));
        put(p, 'offLabel', str(ir.label));
      }
      put(p, 'pressValue', ir.pressValue);
      put(p, 'releaseValue', ir.releaseValue);
    },
    consumes: ['label', 'pressValue', 'releaseValue'],
  },
  'related-display-button': {
    type: 'PVButton',
    map: (ir, p) => {
      put(p, 'label', str(ir.label));
      if (ir.label !== undefined) {
        put(p, 'onLabel', str(ir.label));
        put(p, 'offLabel', str(ir.label));
      }
    },
    consumes: ['label', 'file', 'macros'],
  },
  // No browser analog for spawning a process; degrade to a labeled (inert)
  // button so the button and its label survive rather than becoming Unknown.
  'shell-command-button': {
    type: 'PVButton',
    map: (ir, p) => {
      put(p, 'label', str(ir.label));
      if (ir.label !== undefined) {
        put(p, 'onLabel', str(ir.label));
        put(p, 'offLabel', str(ir.label));
      }
    },
    consumes: ['label', 'command', 'showIcon'],
  },
  'pv-checkbox': {
    type: 'PVCheckbox',
    map: (ir, p) => {
      put(p, 'pvName', str(ir.pv));
      put(p, 'label', str(ir.label));
    },
    consumes: ['pv', 'label'],
  },
  'pv-enum-combobox': {
    type: 'PVDropdown',
    map: (ir, p) => put(p, 'pvName', str(ir.pv)),
    consumes: ['pv'],
  },
  'pv-slider': {
    type: 'PVSlider',
    map: (ir, p) => {
      put(p, 'pvName', str(ir.pv));
      put(p, 'minValue', num(ir.min));
      put(p, 'maxValue', num(ir.max));
      put(p, 'orientation', ir.orientation);
      put(p, 'showValueLabel', bool(ir.showValue));
      put(p, 'increment', num(ir.increment));
      put(p, 'showScale', bool(ir.showScale));
      put(p, 'limitsFromPV', bool(ir.limitsFromPV));
    },
    consumes: [
      'pv',
      'min',
      'max',
      'orientation',
      'showValue',
      'increment',
      'showScale',
      'limitsFromPV',
    ],
  },
  'pv-progress-bar': {
    type: 'PVProgressBar',
    map: (ir, p) => {
      put(p, 'pvName', str(ir.pv));
      put(p, 'minValue', num(ir.min));
      put(p, 'maxValue', num(ir.max));
      put(p, 'orientation', ir.orientation);
    },
    consumes: ['pv', 'min', 'max', 'orientation'],
  },
  'pv-byte-led': {
    type: 'PVByteIndicator',
    map: (ir, p) => {
      put(p, 'pvName', str(ir.pv));
      put(p, 'numBits', num(ir.numBits));
      put(p, 'startBit', num(ir.shift));
      put(p, 'bigEndian', bool(ir.bigEndian));
      put(p, 'onColor', str(ir.onColor));
      put(p, 'offColor', str(ir.offColor));
    },
    consumes: ['pv', 'numBits', 'shift', 'bigEndian', 'onColor', 'offColor'],
  },
  'pv-led': {
    type: 'PVLed',
    map: (ir, p) => {
      put(p, 'pvName', str(ir.pv));
      put(p, 'bit', num(ir.bit));
      put(p, 'onColor', str(ir.onColor));
      put(p, 'offColor', str(ir.offColor));
    },
    consumes: ['pv', 'bit', 'onColor', 'offColor'],
  },
  'image-view': {
    type: 'ScreenImage',
    map: (ir, p) => {
      put(p, 'filename', str(ir.src));
      put(p, 'stretchMode', ir.stretchMode);
    },
    consumes: ['src', 'stretchMode'],
  },
  // Containers degrade to Group: children + z-order survive, chrome does not.
  frame: {
    type: 'Group',
    map: (_ir, p) => {
      p.layoutMode = 'absolute';
    },
    consumes: [],
  },
  // The .ui converter's top-level QWidget wrapper (e.g. `centralwidget`);
  // without this entry its whole subtree becomes an Unknown placeholder.
  'qwidget-container': {
    type: 'Group',
    map: (_ir, p) => {
      p.layoutMode = 'absolute';
    },
    consumes: [],
  },
  'group-box': {
    type: 'Group',
    map: (ir, p) => {
      p.layoutMode = 'absolute';
      put(p, 'label', str(ir.title));
    },
    consumes: ['title'],
  },
  'scroll-area': {
    type: 'Group',
    map: (_ir, p) => {
      p.layoutMode = 'absolute';
    },
    consumes: [],
  },
  tabs: {
    type: 'Group',
    map: (_ir, p) => {
      p.layoutMode = 'absolute';
    },
    consumes: [],
  },
  // ── Identity entries for SB-native types ──────────────────────────────────
  rectangle: { type: 'Rectangle', map: copyVerbatim, consumes: [] },
  ellipse: { type: 'Ellipse', map: copyVerbatim, consumes: [] },
  arc: { type: 'Arc', map: copyVerbatim, consumes: [] },
  line: { type: 'Line', map: copyVerbatim, consumes: [] },
  polygon: { type: 'Polygon', map: copyVerbatim, consumes: [] },
  group: { type: 'Group', map: copyVerbatim, consumes: [] },
  'pv-toggle': { type: 'PVToggle', map: copyPvFlavoredVerbatim, consumes: [] },
  'pv-radio-group': { type: 'PVRadioGroup', map: copyPvFlavoredVerbatim, consumes: [] },
  'pv-spinbox': { type: 'PVSpinbox', map: copyPvFlavoredVerbatim, consumes: [] },
  'pv-tabs': { type: 'PVTabs', map: copyPvFlavoredVerbatim, consumes: [] },
  'pv-meter': { type: 'PVMeter', map: copyPvFlavoredVerbatim, consumes: [] },
  'pv-gauge': { type: 'PVGauge', map: copyPvFlavoredVerbatim, consumes: [] },
  'pv-tank': { type: 'PVTank', map: copyPvFlavoredVerbatim, consumes: [] },
  'pv-thermometer': { type: 'PVThermometer', map: copyPvFlavoredVerbatim, consumes: [] },
  // Curve/axis config passes through; WaveformPlot subscribes to each curve's channels.
  'waveform-plot': {
    type: 'WaveformPlot',
    map: (ir, p) => {
      put(p, 'title', str(ir.title));
      put(p, 'curves', ir.curves);
      put(p, 'yAxes', ir.yAxes);
      put(p, 'xLabels', ir.xLabels);
    },
    consumes: ['title', 'curves', 'yAxes', 'xLabels'],
  },
};

// IR alarm flags → the widget set's names. The IR (widget registry qtPropMap)
// calls PyDM's alarmSensitiveContent `alarmSensitive` (EDM fgAlarm) and
// alarmSensitiveBorder `alarmBorder`. Translated only when present — the
// render mode owns the defaults — and an explicit widget-named prop wins.
const ALARM_ALIASES: readonly (readonly [irKey: string, widgetKey: string])[] = [
  ['alarmSensitive', 'alarmSensitiveContent'],
  ['alarmBorder', 'alarmSensitiveBorder'],
];

/**
 * Map an IR node's type + (macro-resolved, rule-patched) props onto a widget
 * registry type + component props. Returns undefined for IR types with no
 * mapping (`unknown-widget` included) — the renderer shows a placeholder.
 */
export function mapIRWidget(
  type: string,
  irProps: Record<string, unknown>
): MappedWidget | undefined {
  const entry = TYPE_MAP[type];
  if (!entry) return undefined;

  const props: WidgetProps = {};
  entry.map(irProps, props);

  const aliased: string[] = [];
  for (const [irKey, widgetKey] of ALARM_ALIASES) {
    const flag = bool(irProps[irKey]);
    if (flag === undefined) continue;
    aliased.push(irKey);
    if (!(widgetKey in props) && irProps[widgetKey] === undefined) props[widgetKey] = flag;
  }

  const consumed = entry.consumes;
  for (const [key, value] of Object.entries(irProps)) {
    if (!consumed.includes(key) && !aliased.includes(key) && !(key in props)) props[key] = value;
  }
  return { type: entry.type, props };
}
