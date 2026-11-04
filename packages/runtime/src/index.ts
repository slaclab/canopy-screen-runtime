// @slaclab/canopy-screen-runtime — renders Screen IR documents with live
// PV widgets, macro resolution, embedded screens, and Fox-compiled rules.

export { ScreenRenderer } from './render/ScreenRenderer.js';
export type { ScreenRendererProps, ResolveScreen } from './render/ScreenRenderer.js';
export type { ResolveAsset } from '@slaclab/canopy-screen-widgets';
// Render mode (edm | carbon), re-exported so hosts need no direct widget-set
// dependency to select it.
export {
  RENDER_MODES,
  DEFAULT_RENDER_MODE,
  RenderModeContext,
  parseRenderMode,
} from '@slaclab/canopy-screen-widgets';
export type { RenderMode } from '@slaclab/canopy-screen-widgets';
export { mapIRWidget } from './render/irMap.js';
export type { MappedWidget } from './render/irMap.js';

export {
  substituteMacros,
  substituteDeep,
  substituteProps,
  resolveScreenMacros,
  childMacros,
  hasMacro,
} from './macros.js';

export { FOX_PREFIX, isFoxRef, foxName } from './foxRef.js';

export type {
  FormulaKind,
  FormulaSpec,
  FormulaScalarValue,
  FormulaSeverity,
  FormulaResultMeta,
  FormulaSubscribeOptions,
  FormulaSubscriber,
} from './formula.js';
export { FormulaSubscriberContext, useFormulaSubscriber } from './formula.js';

export { ScreenPVService, formatFormulaValue } from './screenPV.js';
export { ScreenPVScope } from './render/ScreenPVScope.js';

export { createFoxFormulaSubscriber } from './rules/foxAdapter.js';
export type { FoxServiceLike } from './rules/foxAdapter.js';
export { createLocalAwareFormulaSubscriber } from './rules/localFormula.js';
export type { LocalPVLike } from './rules/localFormula.js';
export { evaluatePyExpr, PyExprError } from './rules/pyExpr.js';

export {
  compileRule,
  compileFormulaSpec,
  toWireExpression,
  RuleCompileError,
} from './rules/compileRule.js';
export type { CompiledRule, RuleScalar } from './rules/compileRule.js';
export { applyRuleOutputs } from './rules/applyRules.js';
export type { EffectiveNode } from './rules/applyRules.js';
export { useWidgetRules } from './rules/useWidgetRules.js';
