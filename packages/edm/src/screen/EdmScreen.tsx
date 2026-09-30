// The EDM window: exactly w × h (screen properties), display background,
// objects in file order, everything outside the window clipped (EDM parks
// hidden objects far off-screen; the canvas never grows). Files without w/h
// (template fragments) are sized from their content.

import { useMemo } from 'react';
import { parseColorSpec } from '../config/colors.js';
import type { EdmPalette } from '../config/colors.js';
import type { EdmMacros } from '../macros.js';
import type { EdmDocument, EdmObject } from '../model.js';
import { propInt, propStr } from '../model.js';
import type { EdmPvLayer } from '../pv/layer.js';
import { EdmObjectView } from '../widgets/registry.js';
import { EdmScreenContext } from './context.js';
import type { EdmOpenDisplayRequest, EdmScreenEnv } from './context.js';

export interface EdmScreenProps {
  readonly doc: EdmDocument;
  readonly palette: EdmPalette;
  readonly pv: EdmPvLayer;
  readonly macros?: EdmMacros;
  /** Path of the file under the display root (relative lookups, window title). */
  readonly path: string;
  readonly openDisplay?: (req: EdmOpenDisplayRequest) => void;
}

export function screenSize(doc: EdmDocument): { w: number; h: number } {
  let w = propInt(doc.screen, 'w', 0);
  let h = propInt(doc.screen, 'h', 0);
  if (w > 0 && h > 0) return { w, h };
  const walk = (objs: readonly EdmObject[]) => {
    for (const o of objs) {
      const r = propInt(o.props, 'x', 0) + propInt(o.props, 'w', 0) + 1;
      const b = propInt(o.props, 'y', 0) + propInt(o.props, 'h', 0) + 1;
      if (r < 100000) w = Math.max(w, r);
      if (b < 100000) h = Math.max(h, b);
      if (o.children) walk(o.children);
    }
  };
  if (w <= 0 || h <= 0) walk(doc.objects);
  return { w: Math.max(1, w), h: Math.max(1, h) };
}

export function EdmScreen({ doc, palette, pv, macros = {}, path, openDisplay }: EdmScreenProps) {
  const { w, h } = screenSize(doc);
  const bg = palette.spec(parseColorSpec(propStr(doc.screen, 'bgColor'))) ?? '#c8c8c8';
  const env: EdmScreenEnv = useMemo(
    () => ({ palette, pv, macros, path, displayBg: bg, openDisplay }),
    [palette, pv, macros, path, bg, openDisplay]
  );
  return (
    <EdmScreenContext.Provider value={env}>
      <div
        data-testid="screen-root"
        data-edm-path={path}
        style={{
          position: 'relative',
          width: w,
          height: h,
          overflow: 'hidden',
          background: bg,
          // EDM text is drawn on an unscaled pixel grid.
          fontSynthesis: 'none',
          userSelect: 'none',
        }}
      >
        {doc.objects.map((o, i) => (
          <EdmObjectView key={i} obj={o} />
        ))}
      </div>
    </EdmScreenContext.Provider>
  );
}
