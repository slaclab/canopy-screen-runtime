import { widgetRegistry } from './WidgetRegistry.js';
import type { WidgetRendererProps, PropSchema } from './WidgetRegistry.js';
import {
  CarbonPVTextDisplay,
  CarbonPVTextInput,
  CarbonPVButton,
  CarbonPVSlider,
  CarbonPVToggle,
  CarbonPVProgressBar,
  CarbonPVLed,
  CarbonPVDropdown,
  CarbonPVRadioGroup,
  CarbonPVCheckbox,
  CarbonPVByteIndicator,
  CarbonPVMeter,
} from '../pv-wrappers/CarbonWidgets.js';
import { LineWidget } from '../drawing/LineWidget.js';
import { PolygonWidget } from '../drawing/PolygonWidget.js';
import { ScreenImageWidget } from '../drawing/ScreenImageWidget.js';
import { WaveformPlot } from '../charts/WaveformPlot.js';
import { useFitText } from '../shared/useFitText.js';
import { ArcWidget } from '../drawing/ArcWidget.js';

// ── Shared prop schemas ─────────────────────────────────────────────────────

const pvSchema: PropSchema = {
  key: 'pvName',
  label: 'PV Name',
  type: 'pv',
  section: 'pv',
};

const alarmSchemas: PropSchema[] = [
  { key: 'alarmSensitiveBorder', label: 'Alarm Border', type: 'boolean', section: 'alarm' },
  { key: 'alarmSensitiveContent', label: 'Alarm Content', type: 'boolean', section: 'alarm' },
];

const appearanceSchemas: PropSchema[] = [
  { key: 'foregroundColor', label: 'Foreground', type: 'color', section: 'appearance' },
  { key: 'backgroundColor', label: 'Background', type: 'color', section: 'appearance' },
  { key: 'fontSize', label: 'Font Size', type: 'number', section: 'appearance', min: 8, max: 72 },
  {
    key: 'opacity',
    label: 'Transparency (%)',
    type: 'number',
    section: 'appearance',
    min: 0,
    max: 100,
    step: 1,
  },
];

const fitTextSchema: PropSchema = {
  key: 'fitText',
  label: 'Shrink to Fit',
  type: 'boolean',
  section: 'appearance',
};

// NOTE: containers render `children` (nested widget overlays from the canvas's
// recursive renderer). Children are absolutely positioned against this box, so
// do NOT add `overflow: hidden` here or to `.widget-overlay` — the imported Qt
// `centralwidget` arrives as a 0×0 Rectangle wrapper, and clipping would make
// every nested widget invisible again (the bug this whole change fixes).
function RectangleWidget({ layout, props, isSelected, children }: WidgetRendererProps) {
  return (
    <div
      style={{
        width: layout.width,
        height: layout.height,
        backgroundColor: props.fill ? (props.fillColor ?? '#393939') : 'transparent',
        border: `${props.lineWidth ?? 1}px ${props.lineStyle ?? 'solid'} ${props.lineColor ?? '#6f6f6f'}`,
        borderRadius: props.cornerRadius ?? 0,
        outline: isSelected ? '2px solid #0f62fe' : 'none',
      }}
    >
      {children}
    </div>
  );
}

function EllipseWidget({ layout, props, isSelected, children }: WidgetRendererProps) {
  return (
    <div
      style={{
        width: layout.width,
        height: layout.height,
        backgroundColor: props.fill ? (props.fillColor ?? '#393939') : 'transparent',
        border: `${props.lineWidth ?? 1}px ${props.lineStyle ?? 'solid'} ${props.lineColor ?? '#6f6f6f'}`,
        borderRadius: '50%',
        outline: isSelected ? '2px solid #0f62fe' : 'none',
      }}
    >
      {children}
    </div>
  );
}

function StaticLabelWidget({ layout, props, isSelected }: WidgetRendererProps) {
  const text = (props.text as string) ?? 'Label';
  const maxFontSize = (props.fontSize as number) ?? 14;
  const fit = (props.fitText as boolean) ?? false;
  const { ref, fontSize } = useFitText<HTMLSpanElement>(
    maxFontSize,
    [text, layout.width, layout.height],
    undefined,
    fit
  );

  return (
    <div
      style={{
        width: layout.width,
        height: layout.height,
        color: props.foregroundColor ?? '#f4f4f4',
        backgroundColor: (props.backgroundColor as string) ?? 'transparent',
        display: 'flex',
        alignItems: 'center',
        padding: '0 4px',
        outline: isSelected ? '1px solid #0f62fe' : 'none',
        userSelect: 'none',
        overflow: 'hidden',
        boxSizing: 'border-box',
      }}
    >
      <span
        ref={ref}
        style={{
          fontSize,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          maxWidth: '100%',
        }}
      >
        {text}
      </span>
    </div>
  );
}

function GroupWidget({ layout, isSelected, isEditing, children }: WidgetRendererProps) {
  // The dashed outline is an EDITOR affordance. At runtime groups are
  // invisible containers (EDM semantics) — converted screens are full of
  // them, and the outlines read as authored dashed rectangles.
  const border = isEditing ? `1px dashed ${isSelected ? '#0f62fe' : '#525252'}` : 'none';
  return (
    <div
      style={{
        width: layout.width,
        height: layout.height,
        border,
        borderRadius: isEditing ? 2 : 0,
        backgroundColor: 'transparent',
      }}
    >
      {children}
    </div>
  );
}

// ── Register all built-in widgets ───────────────────────────────────────────

export function registerBuiltinWidgets() {
  // Display
  widgetRegistry.register({
    type: 'PVTextDisplay',
    label: 'Text Display',
    category: 'display',
    icon: 'TextLongParagraph',
    defaultLayout: { x: 0, y: 0, width: 160, height: 32 },
    defaultProps: { label: 'Readback', alarmSensitiveBorder: true },
    component: CarbonPVTextDisplay,
    propsSchema: [
      pvSchema,
      { key: 'label', label: 'Label', type: 'string', section: 'display' },
      {
        key: 'format',
        label: 'Format',
        type: 'select',
        section: 'display',
        options: [
          { label: 'Default', value: 'default' },
          { label: 'Decimal', value: 'decimal' },
          { label: 'Exponential', value: 'exponential' },
          { label: 'Hex', value: 'hex' },
          { label: 'Binary', value: 'binary' },
        ],
      },
      { key: 'precision', label: 'Precision', type: 'number', section: 'display', min: 0, max: 10 },
      { key: 'showUnits', label: 'Show Units', type: 'boolean', section: 'display' },
      ...alarmSchemas,
      ...appearanceSchemas,
      fitTextSchema,
    ],
  });

  // Input
  widgetRegistry.register({
    type: 'PVTextInput',
    label: 'Text Input',
    category: 'input',
    icon: 'TextInput',
    defaultLayout: { x: 0, y: 0, width: 160, height: 40 },
    defaultProps: { label: 'Setpoint' },
    component: CarbonPVTextInput,
    propsSchema: [
      pvSchema,
      { key: 'label', label: 'Label', type: 'string', section: 'display' },
      { key: 'confirmOnWrite', label: 'Confirm on Write', type: 'boolean', section: 'behavior' },
      { key: 'confirmMessage', label: 'Confirm Message', type: 'string', section: 'behavior' },
      { key: 'minValue', label: 'Min Value', type: 'number', section: 'behavior' },
      { key: 'maxValue', label: 'Max Value', type: 'number', section: 'behavior' },
      ...alarmSchemas,
      ...appearanceSchemas,
    ],
  });

  widgetRegistry.register({
    type: 'PVButton',
    label: 'Button',
    category: 'input',
    icon: 'TouchInteraction',
    defaultLayout: { x: 0, y: 0, width: 100, height: 36 },
    defaultProps: {
      buttonType: 'push',
      labelType: 'literal',
      onLabel: 'On',
      offLabel: 'Off',
      invisible: false,
      fontSize: 13,
      foregroundColor: '#ffffff',
      backgroundColor: '#0f62fe',
    },
    component: CarbonPVButton,
    propsSchema: [
      { key: 'controlPV', label: 'Control PV', type: 'pv', section: 'pv' },
      { key: 'readbackPV', label: 'Readback PV', type: 'pv', section: 'pv' },
      { key: 'colorPV', label: 'Color PV', type: 'pv', section: 'pv' },
      { key: 'visibilityPV', label: 'Visibility PV', type: 'pv', section: 'pv' },
      {
        key: 'buttonType',
        label: 'Button Type',
        type: 'select',
        section: 'behavior',
        options: [
          { label: 'Push', value: 'push' },
          { label: 'Toggle', value: 'toggle' },
        ],
      },
      { key: 'invisible', label: 'Invisible', type: 'boolean', section: 'behavior' },
      { key: 'onLabel', label: 'On Label', type: 'string', section: 'display' },
      { key: 'offLabel', label: 'Off Label', type: 'string', section: 'display' },
      {
        key: 'labelType',
        label: 'Label Type',
        type: 'select',
        section: 'display',
        options: [
          { label: 'Literal', value: 'literal' },
          { label: 'PV State', value: 'pvState' },
        ],
      },
      { key: 'fontFamily', label: 'Label Font', type: 'string', section: 'appearance' },
      {
        key: 'fontSize',
        label: 'Label Size',
        type: 'number',
        section: 'appearance',
        min: 8,
        max: 72,
      },
      { key: 'foregroundColor', label: 'Text Color', type: 'color', section: 'appearance' },
      { key: 'backgroundColor', label: 'Background Color', type: 'color', section: 'appearance' },
    ],
  });

  widgetRegistry.register({
    type: 'PVSlider',
    label: 'Slider',
    category: 'input',
    icon: 'Slider',
    defaultLayout: { x: 0, y: 0, width: 200, height: 48 },
    defaultProps: { orientation: 'horizontal', minValue: 0, maxValue: 100 },
    component: CarbonPVSlider,
    propsSchema: [
      pvSchema,
      {
        key: 'orientation',
        label: 'Orientation',
        type: 'select',
        section: 'display',
        options: [
          { label: 'Horizontal', value: 'horizontal' },
          { label: 'Vertical', value: 'vertical' },
        ],
      },
      { key: 'minValue', label: 'Min', type: 'number', section: 'behavior' },
      { key: 'maxValue', label: 'Max', type: 'number', section: 'behavior' },
      { key: 'showValueLabel', label: 'Show Value', type: 'boolean', section: 'display' },
      ...alarmSchemas,
    ],
  });

  widgetRegistry.register({
    type: 'PVToggle',
    label: 'Toggle',
    category: 'input',
    icon: 'ToggleFilled',
    defaultLayout: { x: 0, y: 0, width: 80, height: 32 },
    defaultProps: { onLabel: 'On', offLabel: 'Off' },
    component: CarbonPVToggle,
    propsSchema: [
      pvSchema,
      { key: 'onLabel', label: 'On Label', type: 'string', section: 'display' },
      { key: 'offLabel', label: 'Off Label', type: 'string', section: 'display' },
      ...alarmSchemas,
    ],
  });

  widgetRegistry.register({
    type: 'PVDropdown',
    label: 'Dropdown',
    category: 'input',
    icon: 'ListDropdown',
    defaultLayout: { x: 0, y: 0, width: 160, height: 40 },
    defaultProps: {},
    component: CarbonPVDropdown,
    propsSchema: [
      pvSchema,
      { key: 'label', label: 'Label', type: 'string', section: 'display' },
      ...alarmSchemas,
    ],
  });

  widgetRegistry.register({
    type: 'PVRadioGroup',
    label: 'Radio Group',
    category: 'input',
    icon: 'RadioButtonChecked',
    defaultLayout: { x: 0, y: 0, width: 160, height: 40 },
    defaultProps: {},
    component: CarbonPVRadioGroup,
    propsSchema: [pvSchema, ...alarmSchemas],
  });

  widgetRegistry.register({
    type: 'PVCheckbox',
    label: 'Checkbox',
    category: 'input',
    icon: 'Checkbox',
    defaultLayout: { x: 0, y: 0, width: 140, height: 32 },
    defaultProps: { label: 'Enable' },
    component: CarbonPVCheckbox,
    propsSchema: [
      pvSchema,
      { key: 'label', label: 'Label', type: 'string', section: 'display' },
      ...alarmSchemas,
    ],
  });

  // Indicators
  widgetRegistry.register({
    type: 'PVLed',
    label: 'LED',
    category: 'indicator',
    icon: 'CircleFilled',
    defaultLayout: { x: 0, y: 0, width: 24, height: 24 },
    defaultProps: { onColor: '#24a148', offColor: '#525252' },
    component: CarbonPVLed,
    propsSchema: [
      pvSchema,
      { key: 'onColor', label: 'On Color', type: 'color', section: 'appearance' },
      { key: 'offColor', label: 'Off Color', type: 'color', section: 'appearance' },
      { key: 'bit', label: 'Bit', type: 'number', section: 'behavior', min: 0, max: 31 },
      ...alarmSchemas,
    ],
  });

  widgetRegistry.register({
    type: 'PVProgressBar',
    label: 'Progress Bar',
    category: 'indicator',
    icon: 'Meter',
    defaultLayout: { x: 0, y: 0, width: 200, height: 20 },
    defaultProps: { minValue: 0, maxValue: 100 },
    component: CarbonPVProgressBar,
    propsSchema: [
      pvSchema,
      { key: 'minValue', label: 'Min', type: 'number', section: 'behavior' },
      { key: 'maxValue', label: 'Max', type: 'number', section: 'behavior' },
      ...alarmSchemas,
      ...appearanceSchemas,
    ],
  });

  widgetRegistry.register({
    type: 'PVByteIndicator',
    label: 'Byte Indicator',
    category: 'indicator',
    icon: 'Bat',
    defaultLayout: { x: 0, y: 0, width: 160, height: 24 },
    defaultProps: {
      numBits: 8,
      startBit: 0,
      bigEndian: false,
      onColor: '#24a148',
      offColor: '#525252',
    },
    component: CarbonPVByteIndicator,
    propsSchema: [
      pvSchema,
      { key: 'numBits', label: 'Num Bits', type: 'number', section: 'behavior', min: 1, max: 32 },
      { key: 'startBit', label: 'Start Bit', type: 'number', section: 'behavior', min: 0, max: 31 },
      { key: 'bigEndian', label: 'Big Endian', type: 'boolean', section: 'behavior' },
      { key: 'onColor', label: 'On Color', type: 'color', section: 'appearance' },
      { key: 'offColor', label: 'Off Color', type: 'color', section: 'appearance' },
      ...alarmSchemas,
    ],
  });

  // Drawing
  widgetRegistry.register({
    type: 'Rectangle',
    label: 'Rectangle',
    category: 'drawing',
    icon: 'Checkbox',
    defaultLayout: { x: 0, y: 0, width: 100, height: 60 },
    defaultProps: { lineColor: '#6f6f6f', lineWidth: 1, fill: false },
    component: RectangleWidget,
    propsSchema: [
      { key: 'lineColor', label: 'Line Color', type: 'color', section: 'appearance' },
      {
        key: 'lineWidth',
        label: 'Line Width',
        type: 'number',
        section: 'appearance',
        min: 0,
        max: 20,
      },
      {
        key: 'lineStyle',
        label: 'Line Style',
        type: 'select',
        section: 'appearance',
        options: [
          { label: 'Solid', value: 'solid' },
          { label: 'Dashed', value: 'dashed' },
          { label: 'Dotted', value: 'dotted' },
        ],
      },
      { key: 'fill', label: 'Fill', type: 'boolean', section: 'appearance' },
      { key: 'fillColor', label: 'Fill Color', type: 'color', section: 'appearance' },
      {
        key: 'cornerRadius',
        label: 'Corner Radius',
        type: 'number',
        section: 'appearance',
        min: 0,
      },
    ],
  });

  widgetRegistry.register({
    type: 'Ellipse',
    label: 'Ellipse',
    category: 'drawing',
    icon: 'CircleDash',
    defaultLayout: { x: 0, y: 0, width: 60, height: 60 },
    defaultProps: { lineColor: '#6f6f6f', lineWidth: 1, fill: false },
    component: EllipseWidget,
    propsSchema: [
      { key: 'lineColor', label: 'Line Color', type: 'color', section: 'appearance' },
      {
        key: 'lineWidth',
        label: 'Line Width',
        type: 'number',
        section: 'appearance',
        min: 0,
        max: 20,
      },
      { key: 'fill', label: 'Fill', type: 'boolean', section: 'appearance' },
      { key: 'fillColor', label: 'Fill Color', type: 'color', section: 'appearance' },
    ],
  });

  widgetRegistry.register({
    type: 'Arc',
    label: 'Arc',
    category: 'drawing',
    icon: 'CircleDash',
    defaultLayout: { x: 0, y: 0, width: 80, height: 80 },
    defaultProps: {
      lineColor: '#6f6f6f',
      lineWidth: 2,
      startAngle: 0,
      spanAngle: 90,
    },
    component: ArcWidget,
    propsSchema: [
      { key: 'lineColor', label: 'Line Color', type: 'color', section: 'appearance' },
      {
        key: 'lineWidth',
        label: 'Line Width',
        type: 'number',
        section: 'appearance',
        min: 0,
        max: 20,
      },
      {
        key: 'startAngle',
        label: 'Start Angle',
        type: 'number',
        section: 'appearance',
        min: -360,
        max: 360,
      },
      {
        key: 'spanAngle',
        label: 'Span Angle',
        type: 'number',
        section: 'appearance',
        min: -360,
        max: 360,
      },
    ],
  });

  widgetRegistry.register({
    type: 'Line',
    label: 'Line',
    category: 'drawing',
    icon: 'HorizontalLineSolid',
    defaultLayout: { x: 0, y: 0, width: 200, height: 100 },
    defaultProps: {
      lineColor: '#6f6f6f',
      lineWidth: 2,
      lineStyle: 'solid',
      arrowStart: false,
      arrowEnd: false,
      arrowSize: 10,
    },
    component: LineWidget,
    propsSchema: [
      { key: 'lineColor', label: 'Line Color', type: 'color', section: 'appearance' },
      {
        key: 'lineWidth',
        label: 'Line Width',
        type: 'number',
        section: 'appearance',
        min: 1,
        max: 20,
      },
      {
        key: 'lineStyle',
        label: 'Line Style',
        type: 'select',
        section: 'appearance',
        options: [
          { label: 'Solid', value: 'solid' },
          { label: 'Dashed', value: 'dashed' },
          { label: 'Dotted', value: 'dotted' },
        ],
      },
      { key: 'arrowStart', label: 'Arrow at Start', type: 'boolean', section: 'appearance' },
      { key: 'arrowEnd', label: 'Arrow at End', type: 'boolean', section: 'appearance' },
      {
        key: 'arrowSize',
        label: 'Arrow Size',
        type: 'number',
        section: 'appearance',
        min: 4,
        max: 30,
      },
    ],
  });

  widgetRegistry.register({
    type: 'Polygon',
    label: 'Polygon',
    category: 'drawing',
    icon: 'Triangle',
    defaultLayout: { x: 0, y: 0, width: 100, height: 100 },
    defaultProps: {
      lineColor: '#6f6f6f',
      lineWidth: 2,
      lineStyle: 'solid',
      closed: true,
      fill: false,
    },
    component: PolygonWidget,
    propsSchema: [
      { key: 'lineColor', label: 'Line Color', type: 'color', section: 'appearance' },
      {
        key: 'lineWidth',
        label: 'Line Width',
        type: 'number',
        section: 'appearance',
        min: 0,
        max: 20,
      },
      {
        key: 'lineStyle',
        label: 'Line Style',
        type: 'select',
        section: 'appearance',
        options: [
          { label: 'Solid', value: 'solid' },
          { label: 'Dashed', value: 'dashed' },
          { label: 'Dotted', value: 'dotted' },
        ],
      },
      { key: 'closed', label: 'Closed', type: 'boolean', section: 'appearance' },
      { key: 'fill', label: 'Fill', type: 'boolean', section: 'appearance' },
      { key: 'fillColor', label: 'Fill Color', type: 'color', section: 'appearance' },
    ],
  });

  widgetRegistry.register({
    type: 'StaticLabel',
    label: 'Label',
    category: 'drawing',
    icon: 'TextShortParagraph',
    defaultLayout: { x: 0, y: 0, width: 120, height: 24 },
    defaultProps: { text: 'Label', foregroundColor: '#f4f4f4', fontSize: 14, opacity: 0 },
    component: StaticLabelWidget,
    propsSchema: [
      { key: 'text', label: 'Text', type: 'string', section: 'display' },
      ...appearanceSchemas,
      fitTextSchema,
    ],
  });

  widgetRegistry.register({
    type: 'ScreenImage',
    label: 'Image',
    category: 'drawing',
    icon: 'Image',
    defaultLayout: { x: 0, y: 0, width: 120, height: 120 },
    defaultProps: { stretchMode: 'fit' },
    component: ScreenImageWidget,
    propsSchema: [
      { key: 'filename', label: 'Filename', type: 'string', section: 'display' },
      {
        key: 'stretchMode',
        label: 'Stretch Mode',
        type: 'select',
        section: 'appearance',
        options: [
          { label: 'None', value: 'none' },
          { label: 'Fit', value: 'fit' },
          { label: 'Fill', value: 'fill' },
          { label: 'Stretch', value: 'stretch' },
        ],
      },
    ],
  });

  // Containers
  widgetRegistry.register({
    type: 'Group',
    label: 'Group',
    category: 'container',
    icon: 'GroupObjects',
    defaultLayout: { x: 0, y: 0, width: 200, height: 150 },
    defaultProps: { layoutMode: 'absolute' },
    component: GroupWidget,
    propsSchema: [
      {
        key: 'layoutMode',
        label: 'Layout',
        type: 'select',
        section: 'display',
        options: [
          { label: 'Absolute', value: 'absolute' },
          { label: 'Flex', value: 'flex' },
          { label: 'Grid', value: 'grid' },
        ],
      },
    ],
  });

  widgetRegistry.register({
    type: 'WaveformPlot',
    label: 'Waveform Plot',
    category: 'chart',
    icon: 'ChartLine',
    defaultLayout: { x: 0, y: 0, width: 400, height: 300 },
    defaultProps: { title: '' },
    component: WaveformPlot,
    propsSchema: [{ key: 'title', label: 'Title', type: 'string', section: 'display' }],
  });

  widgetRegistry.register({
    type: 'PVMeter',
    label: 'Meter',
    category: 'indicator',
    icon: 'Meter',
    defaultLayout: { x: 0, y: 0, width: 120, height: 90 },
    defaultProps: { showValue: true },
    component: CarbonPVMeter,
    propsSchema: [
      pvSchema,
      { key: 'min', label: 'Min', type: 'number', section: 'behavior' },
      { key: 'max', label: 'Max', type: 'number', section: 'behavior' },
      { key: 'label', label: 'Label', type: 'string', section: 'display' },
      { key: 'showValue', label: 'Show Value', type: 'boolean', section: 'display' },
      ...alarmSchemas,
    ],
  });

  widgetRegistry.register({
    type: 'PVRadioGroup',
    label: 'Radio Group',
    category: 'input',
    icon: 'RadioButton',
    defaultLayout: { x: 0, y: 0, width: 160, height: 80 },
    defaultProps: {},
    component: CarbonPVRadioGroup,
    propsSchema: [
      pvSchema,
      { key: 'orientation', label: 'Orientation', type: 'string', section: 'appearance' },
      ...alarmSchemas,
    ],
  });
}
