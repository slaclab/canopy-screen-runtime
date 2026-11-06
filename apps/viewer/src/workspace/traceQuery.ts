// Validation for a query a tool page reports back to the workspace
// (`canopy:trace-query`). This is a shape check, not the grammar parser —
// that lives in react-trace (src/embed/query.ts). A Trace query is accepted
// when it fits the 4 KB limit, every `&`-separated key and value survives
// decodeURIComponent, and at least one key is `pv` or `range`. The
// correlation page's check (tools.ts) is the first two only.

import { isTraceQuery } from '../config.js';

function decodes(part: string): boolean {
  try {
    decodeURIComponent(part);
    return true;
  } catch {
    return false;
  }
}

/** The `&`-separated keys of `query`, or null when one key or value does not decode. */
function decodedKeys(query: string): string[] | null {
  if (query === '') return [];
  const keys: string[] = [];
  for (const pair of query.split('&')) {
    const eq = pair.indexOf('=');
    const key = eq === -1 ? pair : pair.slice(0, eq);
    const val = eq === -1 ? '' : pair.slice(eq + 1);
    if (!decodes(key) || !decodes(val)) return null;
    keys.push(decodeURIComponent(key));
  }
  return keys;
}

/** True when every key and value of `query` survives decodeURIComponent. */
export function isDecodableQuery(query: string): boolean {
  return decodedKeys(query) !== null;
}

/** True for a string the workspace may store as a Trace tab's query. */
export function isValidTraceQuery(value: unknown): value is string {
  if (!isTraceQuery(value)) return false;
  const keys = decodedKeys(value);
  return keys !== null && keys.some((name) => name === 'pv' || name === 'range');
}

/** What a saved Trace view of `query` holds, for the save dialog. */
export function describeTraceQuery(query: string): string {
  const params = new URLSearchParams(query);
  const count = params.getAll('pv').length;
  const pvs = count === 1 ? '1 PV' : `${count} PVs`;
  // Trace adds its axis and display settings once the operator changed them.
  return params.has('plot')
    ? `${pvs}, the time range and the axis settings`
    : `${pvs} and the time range`;
}
