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
import type { EdmDisplaySource } from '../loader/source.js';
import type { EdmPvLayer } from '../pv/layer.js';
import { EdmObjectView } from '../widgets/registry.js';
import { EdmScreenContext, useEdmScreen } from './context.js';
import type { EdmOpenDisplayRequest, EdmScreenEnv } from './context.js';
import { useBlinkPhase } from './blink.js';
import { docCache } from './docs.js';

export { screenFonts } from './fonts.js';

export interface EdmScreenProps {
  readonly doc: EdmDocument;
  readonly palette: EdmPalette;
  readonly pv: EdmPvLayer;
  readonly macros?: EdmMacros;
  /** Path of the file under the display root (relative lookups, window title). */
  readonly path: string;
  readonly openDisplay?: (req: EdmOpenDisplayRequest) => void;
  readonly closeDisplay?: () => void;
  /** Where embedded displays, symbol files and images come from (none: they show as missing). */
  readonly source?: EdmDisplaySource;
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

function screenColors(doc: EdmDocument, palette: EdmPalette): { bg: string; fg: string } {
  return {
    bg: palette.spec(parseColorSpec(propStr(doc.screen, 'bgColor'))) ?? '#c8c8c8',
    fg: palette.spec(parseColorSpec(propStr(doc.screen, 'fgColor'))) ?? '#000000',
  };
}

export function EdmScreen({
  doc,
  palette,
  pv,
  macros = {},
  path,
  openDisplay,
  closeDisplay,
  source,
}: EdmScreenProps) {
  const { w, h } = screenSize(doc);
  const { bg, fg } = screenColors(doc, palette);
  const docs = useMemo(() => (source ? docCache(source) : undefined), [source]);
  // Blinking colours are custom properties set here, so a blink restyles the
  // screen without re-rendering a single object.
  const blinking = useMemo(() => palette.blinking(), [palette]);
  const phase = useBlinkPhase(palette.blinkMs, blinking.length > 0);
  const blinkVars = Object.fromEntries(blinking.map((b) => [b.prop, phase ? b.off : b.on]));
  const env: EdmScreenEnv = useMemo(
    () => ({
      palette,
      pv,
      macros,
      path,
      displayBg: bg,
      displayFg: fg,
      openDisplay,
      closeDisplay,
      source,
      docs,
      scope: '',
      ancestors: [],
    }),
    [palette, pv, macros, path, bg, fg, openDisplay, closeDisplay, source, docs]
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
          ...blinkVars,
        }}
      >
        {doc.objects.map((o, i) => (
          <EdmObjectView key={i} obj={o} />
        ))}
      </div>
    </EdmScreenContext.Provider>
  );
}

/**
 * Objects of another display file drawn inside this screen (an embedded
 * display, a symbol state), with that file's macros, path (for relative
 * lookups) and display colours. Their PV subscriptions are recorded under
 * `scope`. The caller positions and clips the container.
 */
export function EdmSubScreen({
  doc,
  path,
  macros,
  objects,
  scope,
}: {
  readonly doc: EdmDocument;
  readonly path: string;
  readonly macros: EdmMacros;
  readonly objects: readonly EdmObject[];
  readonly scope: string;
}) {
  const parent = useEdmScreen();
  const { bg, fg } = screenColors(doc, parent.palette);
  const env: EdmScreenEnv = useMemo(
    () => ({
      ...parent,
      macros,
      path,
      displayBg: bg,
      displayFg: fg,
      scope,
      ancestors: [...parent.ancestors, parent.path],
    }),
    [parent, macros, path, bg, fg, scope]
  );
  return (
    <EdmScreenContext.Provider value={env}>
      {objects.map((o, i) => (
        <EdmObjectView key={i} obj={o} />
      ))}
    </EdmScreenContext.Provider>
  );
}
