// @slaclab/canopy-screen-runtime — renders Screen IR documents with live
// PV widgets, macro resolution, embedded screens, and rules compiled for the Formula Engine.

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
export {
  collectScreenPVs,
  embedInstanceKey,
  embedOrder,
  expandScreen,
  nodeChannels,
  ruleChannels,
  walkMounted,
} from './render/collectPVs.js';
export { resolveAgainstChain } from './render/resolveRef.js';
export type {
  CollectScreenPVsOptions,
  EmbedSlot,
  ExpandedNode,
  ExpandedScreen,
  ScreenPV,
  ScreenPVGroup,
  ScreenPVRole,
} from './render/collectPVs.js';
export type { MappedWidget } from './render/irMap.js';
export { resolveRoles, resolveRole } from './theme/resolveRoles.js';
export { TEXT_ROLE, withDefaultRoles } from './theme/defaultRoles.js';
export { SchemeContext, useColorScheme } from './theme/schemeContext.js';
export { getMode, setMode, subscribe } from './theme/modeStore.js';
export type { ThemeMode } from './theme/modeStore.js';
export { useSchemeStyleSheet, schemeCss } from './theme/schemeStyleSheet.js';

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
  FormulaSeverity,
  FormulaResultMeta,
  FormulaSubscribeOptions,
  FormulaSubscriber,
} from './formula.js';
export { FormulaSubscriberContext, useFormulaSubscriber } from './formula.js';

export { ScreenPVService, formatFormulaValue } from './screenPV.js';
export { ScreenPVScope } from './render/ScreenPVScope.js';

export { createFormulaEngineSubscriber } from './rules/formulaEngineAdapter.js';
export type { FormulaEngineServiceLike } from './rules/formulaEngineAdapter.js';
export { createLocalAwareFormulaSubscriber } from './rules/localFormula.js';
export type { LocalPVLike } from './rules/localFormula.js';
export { createFixtureFormulaSubscriber } from './rules/fixtureFormulas.js';
export { FixturePVService, parseFixtureSnapshot } from './pv/FixturePVService.js';
export type { FixtureEntry, FixtureSnapshot, FixtureValue } from './pv/FixturePVService.js';
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

export { ActionHostContext, warnOnlyActionHost } from './actions/ActionHostContext.js';
export type { ActionHost } from './actions/ActionHostContext.js';
export { dispatchActions } from './actions/dispatch.js';
export type { ActionContext } from './actions/dispatch.js';
