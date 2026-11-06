// @slaclab/canopy-screen-runtime/testing — test seams, not part of the public
// API: a render probe for render-count tests and a reset for the dispatcher's
// once-per-kind warnings.

export { __setWidgetRenderProbe } from './render/ScreenRenderer.js';
export { resetActionWarnings } from './actions/dispatch.js';
