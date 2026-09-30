// @slaclab/canopy-edm: faithful in-browser rendering of EDM .edl screens.
//
//   parse     parseEdl / registerFileParser → EdmDocument (the EDM object description)
//   config    EdmPalette (colors.list), resolveFont (EDM font tags + X metrics)
//   pv        EdmPvLayer + connections (PVService/Hare, LOC\ locals)
//   render    <EdmScreen>, widget registry (registerEdmWidget), registerEdmBuiltins()

export * from './model.js';
export { parseEdl } from './parser/edl.js';
export { registerFileParser, getFileParser } from './parser/registry.js';
export type { EdmFileParser } from './parser/registry.js';
export { EdmPalette, evalRule, parseColorSpec } from './config/colors.js';
export type {
  EdmColorRule,
  EdmColorSpec,
  EdmStaticColor,
  EdmAlarmColors,
} from './config/colors.js';
export { resolveFont, textWidth, parseFontTag, DEFAULT_FONT_TAG } from './config/fonts.js';
export type { EdmFont } from './config/fonts.js';
export { motifShadows } from './config/motif.js';
export {
  cFormat,
  cvtDoubleToString,
  cvtDoubleToExpString,
  cvtLongToHexString,
  expNotation,
} from './format.js';
export { expandMacros, parseMacroString } from './macros.js';
export type { EdmMacros } from './macros.js';
export { parsePvName } from './pv/names.js';
export type { EdmPvRef, EdmPvScheme } from './pv/names.js';
export { EdmPvLayer, DISCONNECTED } from './pv/layer.js';
export type { EdmPvSubscription } from './pv/layer.js';
export { pvServiceConnection } from './pv/pvService.js';
export { localConnection, parseLocDeclaration } from './pv/local.js';
export type { LocalConnection } from './pv/local.js';
export type { EdmPvConnection, EdmPvData, EdmPvListener, EdmPvType } from './pv/types.js';
export { EdmScreen, screenSize } from './screen/EdmScreen.js';
export type { EdmScreenProps } from './screen/EdmScreen.js';
export { EdmScreenContext, useEdmScreen, useEdmPv } from './screen/context.js';
export type { EdmOpenDisplayRequest, EdmScreenEnv } from './screen/context.js';
export {
  registerEdmWidget,
  getEdmWidget,
  registeredEdmClasses,
  EdmObjectView,
  Placeholder,
  WidgetBoundary,
} from './widgets/registry.js';
export type { EdmWidgetComponent, EdmWidgetProps } from './widgets/registry.js';
export { registerEdmBuiltins } from './widgets/builtins.js';
export { httpDisplaySource, parseDisplay, EdmHttpError } from './loader/source.js';
export type { EdmDisplaySource } from './loader/source.js';
