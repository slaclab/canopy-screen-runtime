// Query parameters of a screen URL: every ?NAME=value is a macro value,
// except the viewer's own parameters (they would otherwise leak into every
// embedded screen's macro dictionary).

/** ?render=edm|carbon: the IR render mode for this page. */
export const RENDER_QUERY_PARAM = 'render';
/** ?impl=edm|pydm|react[&look=…]: which variant of the screen (variants.ts). */
export const IMPL_QUERY_PARAM = 'impl';
export const LOOK_QUERY_PARAM = 'look';

export const RESERVED_QUERY_PARAMS: ReadonlySet<string> = new Set([
  RENDER_QUERY_PARAM,
  IMPL_QUERY_PARAM,
  LOOK_QUERY_PARAM,
]);

export function queryMacros(params: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of params.entries()) {
    if (!RESERVED_QUERY_PARAMS.has(name)) out[name] = value;
  }
  return out;
}
