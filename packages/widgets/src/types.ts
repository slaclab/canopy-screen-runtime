// ── Display Format ──────────────────────────────���────────────────────────────

export const DisplayFormat = {
  Default: 'default',
  Decimal: 'decimal',
  Exponential: 'exponential',
  Hex: 'hex',
  Binary: 'binary',
  String: 'string',
  Engineering: 'engineering',
} as const;
export type DisplayFormat = (typeof DisplayFormat)[keyof typeof DisplayFormat];

// ── Rules & Actions ──────────────────────────────────────────────────────────

export interface RuleExpression {
  condition: string;
  value: unknown;
}

export interface RulePV {
  name: string;
  trigger: boolean;
}

export interface Rule {
  /**
   * The canonical IR rule id. Preserved verbatim through import so save
   * re-emits it unchanged; minted deterministically on export when absent.
   */
  id?: string;
  name: string;
  targetProperty: string;
  outputExpression: boolean;
  expressions: RuleExpression[];
  pvs: RulePV[];
}

export type Action =
  | {
      type: 'open_display';
      file: string;
      macros?: Record<string, string>;
      target: 'tab' | 'window' | 'replace';
    }
  | { type: 'write_pv'; pvName: string; value: string | number }
  | { type: 'execute'; command: string; description?: string }
  | { type: 'open_webpage'; url: string }
  | { type: 'open_file'; file: string };

// ── Layout ────────────────────────────────────────────────────────────────���──

export type LayoutMode = 'absolute' | 'flex' | 'grid';

export interface Position {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface AbsoluteLayout extends Position, Size {}

// ── Widget Catalog ───────────────────────────────────────────────────────────
// Single source of truth for widget types and how they are imported in
// generated TSX. Both parseTSX (recognising tags) and generateTSX (emitting
// imports) read from here, so adding a widget is a one-line change.

export const WIDGET_CATALOG = {
  pvWrappers: [
    'PVTextDisplay',
    'PVTextInput',
    'PVButton',
    'PVDropdown',
    'PVCheckbox',
    'PVRadioGroup',
    'PVSlider',
    'PVSpinbox',
    'PVToggle',
    'PVProgressBar',
    'PVTabs',
  ],
  indicators: ['PVLed', 'PVByteIndicator', 'PVMeter', 'PVGauge', 'PVTank', 'PVThermometer'],
  drawings: ['Rectangle', 'Ellipse', 'Line', 'Arc', 'Polygon', 'StaticLabel', 'ScreenImage'],
  containers: ['Group', 'EmbeddedScreen'],
  charts: ['WaveformPlot'],
} as const;

export type WidgetType = (typeof WIDGET_CATALOG)[keyof typeof WIDGET_CATALOG][number];

export const ALL_WIDGET_TYPES: readonly WidgetType[] = [
  ...WIDGET_CATALOG.pvWrappers,
  ...WIDGET_CATALOG.indicators,
  ...WIDGET_CATALOG.drawings,
  ...WIDGET_CATALOG.containers,
  ...WIDGET_CATALOG.charts,
];

// ── Widget Model ────────────────────────────────���────────────────────────────

export interface WidgetProps {
  // PV binding
  pvName?: string;
  pvBindings?: Record<string, string>;

  // Display
  label?: string;
  format?: DisplayFormat;
  precision?: number;
  precisionFromPV?: boolean;
  showUnits?: boolean;

  // Appearance
  foregroundColor?: string;
  backgroundColor?: string;
  borderColor?: string;
  fontSize?: number;
  fontFamily?: string;
  fitText?: boolean;
  opacity?: number;

  // Alarm
  alarmSensitiveBorder?: boolean;
  alarmSensitiveContent?: boolean;

  // Write widgets
  confirmOnWrite?: boolean;
  confirmMessage?: string;
  minValue?: number;
  maxValue?: number;
  limitsFromPV?: boolean;
  enabled?: boolean;

  // Button-specific
  pressValue?: string | number;
  releaseValue?: string | number;
  onLabel?: string;
  offLabel?: string;
  onColor?: string;
  offColor?: string;
  bit?: number;

  // Slider-specific
  orientation?: 'horizontal' | 'vertical';
  showScale?: boolean;
  showValueLabel?: boolean;
  increment?: number;

  // Shape-specific
  lineColor?: string;
  lineWidth?: number;
  lineStyle?: 'solid' | 'dashed' | 'dotted';
  fillColor?: string;
  fill?: boolean;
  cornerRadius?: number;
  startAngle?: number;
  spanAngle?: number;

  // Image
  filename?: string;
  stretchMode?: 'none' | 'fit' | 'fill' | 'stretch';

  // Embedded display
  file?: string;
  macros?: Record<string, string>;
  resizeMode?: 'none' | 'resize' | 'sizeToContent' | 'stretch' | 'crop';

  // LED
  numBits?: number;
  startBit?: number;
  bigEndian?: boolean;

  // Container layout
  layoutMode?: LayoutMode;
  gap?: number;
  flexDirection?: 'row' | 'column';
  alignItems?: string;
  justifyContent?: string;

  // Text
  text?: string;

  // Allow arbitrary extra props
  [key: string]: unknown;
}
