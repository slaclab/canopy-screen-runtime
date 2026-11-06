// Editor metadata for every IR type the runtime renders: the display name,
// category, children support and description a panel builder shows for it.
//
// The catalog owner is `@slaclab/canopy-screen-widgets`: an IR type takes the
// registry `label` and `category` of the runtime widget type it renders as.
// Those values are mirrored here as a static table, because this file is
// imported by `scripts/emit-ir-map.ts` under plain `node` and so may import
// types only (the registry itself lives in `.tsx`). irMap.test.ts compares
// the mirror with the live registry, so it cannot drift silently.
//
// Per-IR-id overrides cover the cases the registry cannot answer:
//  - IR types that share one runtime type (the buttons on `PVButton`, the
//    containers on `Group`), so every IR type keeps a distinct name;
//  - the renderer-native types (`absolute-canvas`, `embedded-display`);
//  - runtime types the registry does not register (`PVSpinbox`, `PVTabs`,
//    `PVGauge`, `PVTank`, `PVThermometer`).
//
// `supportsChildren` is derived, never authored: a type holds children when
// its category is `container` or it renders as `Group` / `EmbeddedScreen`.

import type { WidgetDefinition, WidgetType } from '@slaclab/canopy-screen-widgets';

export type IrCategory = WidgetDefinition['category'];

/** Every category the registry knows, in its declared order. */
export const IR_CATEGORIES: readonly IrCategory[] = [
  'display',
  'input',
  'indicator',
  'container',
  'chart',
  'drawing',
  'navigation',
];

export interface IrMeta {
  displayName: string;
  description: string;
  category: IrCategory;
  supportsChildren: boolean;
}

interface CatalogEntry {
  label: string;
  category: IrCategory;
}

/**
 * The registry `label` and `category` of each runtime type an IR type renders
 * as — a mirror of `registerBuiltinWidgets()`, checked by irMap.test.ts.
 */
export const REGISTRY_CATALOG: Partial<Record<WidgetType, CatalogEntry>> = {
  PVTextDisplay: { label: 'Text Display', category: 'display' },
  PVTextInput: { label: 'Text Input', category: 'input' },
  PVButton: { label: 'Button', category: 'input' },
  PVSlider: { label: 'Slider', category: 'input' },
  PVToggle: { label: 'Toggle', category: 'input' },
  PVDropdown: { label: 'Dropdown', category: 'input' },
  PVRadioGroup: { label: 'Radio Group', category: 'input' },
  PVCheckbox: { label: 'Checkbox', category: 'input' },
  PVLed: { label: 'LED', category: 'indicator' },
  PVProgressBar: { label: 'Progress Bar', category: 'indicator' },
  PVByteIndicator: { label: 'Byte Indicator', category: 'indicator' },
  PVMeter: { label: 'Meter', category: 'indicator' },
  Rectangle: { label: 'Rectangle', category: 'drawing' },
  Ellipse: { label: 'Ellipse', category: 'drawing' },
  Arc: { label: 'Arc', category: 'drawing' },
  Line: { label: 'Line', category: 'drawing' },
  Polygon: { label: 'Polygon', category: 'drawing' },
  StaticLabel: { label: 'Label', category: 'drawing' },
  ScreenImage: { label: 'Image', category: 'drawing' },
  Group: { label: 'Group', category: 'container' },
  WaveformPlot: { label: 'Waveform Plot', category: 'chart' },
  XYPlot: { label: 'XY Plot', category: 'chart' },
  PVArrayPlot: { label: 'PV Array Plot', category: 'chart' },
};

/** Runtime types the registry does not register; their IR types carry a full override. */
export const UNREGISTERED_TYPES: readonly WidgetType[] = [
  'PVSpinbox',
  'PVTabs',
  'PVGauge',
  'PVTank',
  'PVThermometer',
];

/** Runtime types that hold children whatever their category. */
const CHILD_HOLDING_TYPES: readonly WidgetType[] = ['Group', 'EmbeddedScreen'];

/**
 * Per-IR-id values that replace the registry's. A category override is only
 * needed where the registry has no entry for the type.
 */
export const IR_META_OVERRIDES: Record<string, Partial<CatalogEntry> & { renderAs?: WidgetType }> =
  {
    // Renderer-native: drawn by ScreenRenderer before the type-table lookup.
    'absolute-canvas': { label: 'Canvas', category: 'container' },
    'embedded-display': {
      label: 'Embedded Display',
      category: 'container',
      renderAs: 'EmbeddedScreen',
    },
    // IR types sharing `PVButton` (pv-button keeps the registry name).
    'regular-button': { label: 'Push Button' },
    'related-display-button': { label: 'Related Display Button' },
    'shell-command-button': { label: 'Shell Command Button' },
    // IR types sharing `Group` (group keeps the registry name).
    frame: { label: 'Frame' },
    'qwidget-container': { label: 'Widget Container' },
    'group-box': { label: 'Group Box' },
    'scroll-area': { label: 'Scroll Area' },
    tabs: { label: 'Tab Widget' },
    // Runtime types the registry does not register.
    'pv-spinbox': { label: 'Spinbox', category: 'input' },
    'pv-tabs': { label: 'PV Tabs', category: 'input' },
    'pv-gauge': { label: 'Gauge', category: 'indicator' },
    'pv-tank': { label: 'Tank', category: 'indicator' },
    'pv-thermometer': { label: 'Thermometer', category: 'indicator' },
  };

/** Authored one-line descriptions; an IR type without one gets an empty string. */
export const IR_DESCRIPTIONS: Record<string, string> = {
  'absolute-canvas': 'Top-level canvas that positions its children absolutely.',
  arc: 'Arc segment of an ellipse.',
  'embedded-display': 'Embeds another screen file, with optional macros.',
  ellipse: 'Ellipse or circle shape.',
  frame: 'Plain frame grouping its children.',
  group: 'Group of widgets positioned together.',
  'group-box': 'Titled box grouping its children.',
  'image-view': 'Static image from a file.',
  line: 'Straight or polyline segment.',
  polygon: 'Closed polygon shape.',
  'pv-array-plot': 'Plot of an array PV against its index.',
  'pv-button': 'Button that writes a value to a PV.',
  'pv-byte-led': 'Row of LEDs showing the bits of an integer PV.',
  'pv-checkbox': 'Checkbox bound to a PV.',
  'pv-enum-combobox': 'Drop-down selecting a value of an enum PV.',
  'pv-gauge': 'Dial gauge showing a PV value.',
  'pv-label': 'Read-only text display of a PV value.',
  'pv-led': 'LED indicator showing a PV state.',
  'pv-meter': 'Meter showing a PV value.',
  'pv-progress-bar': 'Bar showing a PV value within its range.',
  'pv-radio-group': 'Radio buttons selecting a value of a PV.',
  'pv-slider': 'Slider that writes a numeric PV.',
  'pv-spinbox': 'Numeric spin box bound to a PV.',
  'pv-tabs': 'Tab selector bound to a PV.',
  'pv-tank': 'Tank level indicator for a PV value.',
  'pv-text-input': 'Text field that writes a PV.',
  'pv-thermometer': 'Thermometer indicator for a PV value.',
  'pv-toggle': 'On/off toggle bound to a PV.',
  'qwidget-container': 'Generic container holding child widgets.',
  rectangle: 'Rectangle shape.',
  'regular-button': 'Push button without a PV.',
  'related-display-button': 'Button that opens a related display.',
  'scroll-area': 'Scrollable area holding child widgets.',
  'shell-command-button': 'Button that runs a shell command.',
  tabs: 'Tabbed container holding child widgets.',
  'text-label': 'Static text label.',
  'waveform-plot': 'Time or waveform plot of one or more PVs.',
  'xy-plot': 'Scatter plot of one PV against another.',
};

/**
 * The editor metadata of one IR type, given the runtime type it renders as
 * (absent for renderer-native types). Throws when neither the registry
 * mirror nor an override names the type, so an unlabeled entry never ships.
 */
export function irMetaFor(irType: string, runtimeType?: WidgetType): IrMeta {
  const override = IR_META_OVERRIDES[irType] ?? {};
  const type = runtimeType ?? override.renderAs;
  const registry = type ? REGISTRY_CATALOG[type] : undefined;
  const displayName = override.label ?? registry?.label;
  const category = override.category ?? registry?.category;
  if (displayName === undefined || category === undefined) {
    throw new Error(`irMeta: no display name or category for IR type '${irType}'`);
  }
  return {
    displayName,
    description: IR_DESCRIPTIONS[irType] ?? '',
    category,
    supportsChildren:
      category === 'container' || (type !== undefined && CHILD_HOLDING_TYPES.includes(type)),
  };
}
