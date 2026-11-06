import { describe, it, expect } from 'vitest';
import { widgetRegistry } from './WidgetRegistry.js';
import { registerBuiltinWidgets } from './registerBuiltins.js';
import {
  CarbonPVTextDisplay,
  CarbonPVTextInput,
  CarbonPVButton,
  CarbonPVSlider,
  CarbonPVToggle,
  CarbonPVDropdown,
  CarbonPVRadioGroup,
  CarbonPVCheckbox,
  CarbonPVLed,
  CarbonPVProgressBar,
  CarbonPVByteIndicator,
} from '../pv-wrappers/CarbonWidgets.js';
import { XYPlot } from '../charts/XYPlot.js';
import { PVArrayPlot } from '../charts/PVArrayPlot.js';

describe('registerBuiltinWidgets', () => {
  registerBuiltinWidgets();

  // These are mapped by the IR importer (irWidgetMap.ts), so an unregistered
  // type would render as nothing on the canvas. Guard against that regressing.
  it.each([
    'PVDropdown',
    'PVRadioGroup',
    'PVCheckbox',
    'PVByteIndicator',
    'ScreenImage',
    'Polygon',
    'XYPlot',
    'PVArrayPlot',
    // Plus the long-standing set, as a sanity check.
    'PVTextDisplay',
    'PVButton',
    'PVLed',
    'Rectangle',
    'Group',
  ] as const)('registers a renderable component for %s', (type) => {
    const def = widgetRegistry.get(type);
    expect(def).toBeDefined();
    expect(def!.component).toBeTypeOf('function');
  });
});

describe('live-component unification', () => {
  registerBuiltinWidgets();

  // Pins the contract that the registry registers the live Carbon component
  // as the single component for each PV widget type — no separate
  // editor-only vs runtime-only component split.
  it.each([
    ['PVTextDisplay', CarbonPVTextDisplay],
    ['PVTextInput', CarbonPVTextInput],
    ['PVButton', CarbonPVButton],
    ['PVSlider', CarbonPVSlider],
    ['PVToggle', CarbonPVToggle],
    ['PVDropdown', CarbonPVDropdown],
    ['PVRadioGroup', CarbonPVRadioGroup],
    ['PVCheckbox', CarbonPVCheckbox],
    ['PVLed', CarbonPVLed],
    ['PVProgressBar', CarbonPVProgressBar],
    ['PVByteIndicator', CarbonPVByteIndicator],
  ] as const)('%s registers the live Carbon component', (type, component) => {
    expect(widgetRegistry.get(type)!.component).toBe(component);
  });
});

describe('XYPlot registration', () => {
  registerBuiltinWidgets();

  it('registers XYPlot as the chart component for the xy-plot IR type', () => {
    const def = widgetRegistry.get('XYPlot');
    expect(def!.component).toBe(XYPlot);
    expect(def!.category).toBe('chart');
  });
});

describe('PVArrayPlot registration', () => {
  registerBuiltinWidgets();

  it('registers PVArrayPlot as the chart component for the pv-array-plot IR type', () => {
    const def = widgetRegistry.get('PVArrayPlot');
    expect(def!.component).toBe(PVArrayPlot);
    expect(def!.category).toBe('chart');
    expect(def!.defaultProps).toMatchObject({ mode: 'bar' });
  });
});
