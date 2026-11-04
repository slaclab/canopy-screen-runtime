// @slaclab/canopy-screen-runtime — renders Screen IR documents with live
// PV widgets, macro resolution, embedded screens, and rules compiled for the Formula Engine.

export { ScreenRenderer } from './render/ScreenRenderer.js';
export type { ScreenRendererProps, ResolveScreen } from './render/ScreenRenderer.js';
export type { ResolveAsset } from '@slaclab/canopy-screen-widgets';
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

export { FORMULA_PREFIX, isFormulaRef, formulaName } from './formulaRef.js';

export type {
  FormulaKind,
  FormulaSpec,
  FormulaScalarValue,
  FormulaSubscribeOptions,
  FormulaSubscriber,
} from './formula.js';
export { FormulaSubscriberContext, useFormulaSubscriber } from './formula.js';

export { createFormulaEngineSubscriber } from './rules/formulaEngineAdapter.js';
export type { FormulaEngineServiceLike } from './rules/formulaEngineAdapter.js';
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
