// Which fonts a display file draws with (loaded before it is shown).

import { cssFont, resolveFont } from '../config/fonts.js';
import type { EdmDocument, EdmObject } from '../model.js';
import { propStr } from '../model.js';

/**
 * CSS font shorthands of every font the document's objects use, for
 * `document.fonts.load()` before the screen is shown (so neither a screenshot
 * nor an operator ever sees the fallback font first).
 */
export function screenFonts(doc: EdmDocument): string[] {
  // Objects without a font tag draw with the default font.
  const out = new Set<string>([cssFont(resolveFont(undefined))]);
  const walk = (objs: readonly EdmObject[]) => {
    for (const o of objs) {
      const tag = propStr(o.props, 'font');
      if (tag !== undefined) out.add(cssFont(resolveFont(tag)));
      if (o.children) walk(o.children);
    }
  };
  walk(doc.objects);
  return [...out];
}
