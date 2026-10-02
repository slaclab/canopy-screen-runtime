// menuMuxClass macros (EDM baselib/menu_mux.cc, edmlib/act_win.cc): every
// multiplexor of a window contributes the macro set of its current item to
// the window's other objects, after the window's own macros (which always
// win) and in display-list order between muxes. Written from that
// behaviour; no EDM code is copied.

import { expandMacros } from '../macros.js';
import type { EdmMacros } from '../macros.js';
import type { EdmObject } from '../model.js';
import { propIndexedStrings, propStr } from '../model.js';

export const MUX_CLASS = 'menuMuxClass';
const MAX_ITEMS = 16;

export interface MuxDefinition {
  /** Item labels (symbolTag); their count is the number of items. */
  readonly labels: readonly string[];
  /** Macro set of each item: the (symbolK, valueK) pairs with both non-empty. */
  readonly sets: readonly EdmMacros[];
}

const unquote = (s: string | undefined) => (s ?? '').replace(/^"(.*)"$/, '$1');

export function muxDefinition(obj: EdmObject): MuxDefinition {
  const tags = propIndexedStrings(obj.props, 'symbolTag').map(unquote).slice(0, MAX_ITEMS);
  const labels = Array.from({ length: tags.length }, (_, i) => tags[i] ?? '');
  const names = Array.from({ length: 8 }, (_, k) =>
    propIndexedStrings(obj.props, `symbol${k}`).map(unquote)
  );
  const values = Array.from({ length: 8 }, (_, k) =>
    propIndexedStrings(obj.props, `value${k}`).map(unquote)
  );
  const sets = labels.map((_, n) => {
    const set: Record<string, string> = {};
    for (let k = 0; k < 8; k++) {
      const name = names[k][n] ?? '';
      const value = values[k][n] ?? '';
      if (name && value && !(name in set)) set[name] = value;
    }
    return set;
  });
  return { labels, sets };
}

/** The item a mux starts with: atol(initialState) without a control PV, else item 0. */
export function initialMuxItem(obj: EdmObject, macros: EdmMacros): number {
  if ((propStr(obj.props, 'controlPv') ?? '').trim()) return 0;
  const m = /^\s*([+-]?\d+)/.exec(expandMacros(propStr(obj.props, 'initialState') ?? '', macros));
  return m ? parseInt(m[1], 10) : 0;
}

/** Every mux of a window, in display-list order (inside groups too). */
export function collectMuxes(objects: readonly EdmObject[]): EdmObject[] {
  const out: EdmObject[] = [];
  const walk = (objs: readonly EdmObject[]) => {
    for (const o of objs) {
      if (o.className === MUX_CLASS) out.push(o);
      if (o.children) walk(o.children);
    }
  };
  walk(objects);
  return out;
}

/** Window macros first; then each mux's current set, the first mux winning a clash. */
export function layerMacros(window: EdmMacros, muxSets: readonly EdmMacros[]): EdmMacros {
  if (muxSets.length === 0) return window;
  const out: Record<string, string> = {};
  for (let i = muxSets.length - 1; i >= 0; i--) Object.assign(out, muxSets[i]);
  return { ...out, ...window };
}
