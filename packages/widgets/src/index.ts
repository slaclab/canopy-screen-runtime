// @slaclab/canopy-screen-widgets — Carbon PV widgets, drawing primitives, and
// the widget registry.

// DisplayFormat is a merged value+type export (const object + type alias of
// the same name); re-exporting it via plain `export {}` already carries both
// facets, so it must not also appear in the `export type {}` list below
// (TypeScript rejects that as a duplicate identifier).
export { WIDGET_CATALOG, ALL_WIDGET_TYPES, DisplayFormat } from './types.js';
export type {
  RuleExpression,
  RulePV,
  Rule,
  Action,
  LayoutMode,
  Position,
  Size,
  AbsoluteLayout,
  WidgetType,
  WidgetProps,
} from './types.js';

export {
  alarmColor,
  alarmBorderColor,
  alarmBorderStyle,
  alarmContentColor,
  CARBON_ALARM_PALETTE,
  EDM_ALARM_PALETTE,
} from './alarm.js';
export type { AlarmPalette } from './alarm.js';

// Render mode (edm | carbon): the presentation switch widgets read via context.
export {
  RENDER_MODES,
  DEFAULT_RENDER_MODE,
  RENDER_PROFILES,
  RenderModeContext,
  parseRenderMode,
  useRenderMode,
  useRenderProfile,
} from './renderMode.js';
export type { RenderMode, RenderProfile } from './renderMode.js';

// The PV context (and PV shapes) the widget set reads through usePV. The
// screen runtime installs screen-scoped PVServices (formula:// formula channels)
// into THIS context instance; re-exporting it here binds the runtime to the
// exact copy its widgets consume without a second direct SDK dependency.
export { PVServiceContext } from '@slaclab/canopy-react';
export { AlarmSeverity, DISCONNECTED_PV } from '@slaclab/canopy-client';
export type { PVData, PVListener, PVService } from '@slaclab/canopy-client';

export { AssetResolverContext, useResolveAsset } from './assets.js';
export type { ResolveAsset } from './assets.js';

export { WriteGate, useWriteGate } from './writeGate/WriteGate.js';
export { useGatedWrite } from './writeGate/useGatedWrite.js';
export { allConfirmed } from './writeGate/types.js';
export { WRITES_INERT_PROP } from './writeGate/inert.js';
export type {
  WriteValue,
  WriteOutcomeKind,
  WriteOutcome,
  WriteRequest,
  WriteRunOptions,
  WriteRunResult,
  WriteGateService,
} from './writeGate/types.js';
export type { WritableHandle, GatedWrite, GatedWriteResult } from './writeGate/useGatedWrite.js';

export { widgetRegistry } from './registry/WidgetRegistry.js';
export type {
  WidgetDefinition,
  PropSchema,
  WidgetRendererProps,
} from './registry/WidgetRegistry.js';

export { registerBuiltinWidgets } from './registry/registerBuiltins.js';

export {
  CarbonPVTextDisplay,
  CarbonPVTextInput,
  CarbonPVButton,
  CarbonPVSlider,
  CarbonPVToggle,
  CarbonPVProgressBar,
  CarbonPVLed,
  CarbonPVDropdown,
  CarbonPVCheckbox,
  CarbonPVByteIndicator,
} from './pv-wrappers/CarbonWidgets.js';

export { ArcWidget } from './drawing/ArcWidget.js';
export { LineWidget } from './drawing/LineWidget.js';
export { ScreenImageWidget } from './drawing/ScreenImageWidget.js';
export { WaveformPlot } from './charts/WaveformPlot.js';

export { useFitText, computeFitFontSize, MIN_FONT_SIZE } from './shared/useFitText.js';
export type { UseFitTextResult } from './shared/useFitText.js';
