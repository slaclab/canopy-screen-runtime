// Query parameters -> screen macros. Every ?NAME=value becomes a macro except
// the viewer's own reserved parameters: `embedded`, `theme` and `mode` (read
// by the host pages, e.g. EmbedPage's ?theme=), `render` (the screen page's
// render mode, RENDER_QUERY_PARAM) and anything prefixed
// `_canopy` (reserved for future viewer use). Matching is exact and
// case-sensitive; a repeated name keeps its last value.

/** The viewer-reserved query parameter selecting the render mode. */
export const RENDER_QUERY_PARAM = 'render';

const RESERVED = new Set(['embedded', 'theme', 'mode', RENDER_QUERY_PARAM]);
const RESERVED_PREFIX = '_canopy';

export function macrosFromSearch(search: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of search.entries()) {
    if (RESERVED.has(name) || name.startsWith(RESERVED_PREFIX)) continue;
    out[name] = value;
  }
  return out;
}
