// The EDM window: exactly w × h (screen properties), display background,
// objects in file order, everything outside the window clipped (EDM parks
// hidden objects far off-screen; the canvas never grows). Files without w/h
// (template fragments) are sized from their content.

import { useCallback, useMemo, useState } from 'react';
import { parseColorSpec } from '../config/colors.js';
import type { EdmPalette } from '../config/colors.js';
import type { EdmMacros } from '../macros.js';
import type { EdmDocument, EdmObject } from '../model.js';
import { propInt, propStr } from '../model.js';
import type { EdmDisplaySource } from '../loader/source.js';
import type { EdmPvLayer } from '../pv/layer.js';
import { EdmObjectView } from '../widgets/registry.js';
import { EdmFreeze, EdmScreenContext, useEdmScreen } from './context.js';
import type { EdmMuxState, EdmOpenDisplayRequest, EdmScreenEnv } from './context.js';
import { useBlinkPhase } from './blink.js';
import { docCache } from './docs.js';
import { collectMuxes, initialMuxItem, layerMacros, muxDefinition } from './mux.js';

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

/** A display's screen background and foreground colours. */
export function screenColors(doc: EdmDocument, palette: EdmPalette): { bg: string; fg: string } {
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
  const { bg } = screenColors(doc, palette);
  const docs = useMemo(() => (source ? docCache(source) : undefined), [source]);
  const [freeze] = useState(() => new EdmFreeze());
  // Blinking colours are custom properties set here, so a blink restyles the
  // screen without re-rendering a single object.
  const blinking = useMemo(() => palette.blinking(), [palette]);
  const phase = useBlinkPhase(palette.blinkMs, blinking.length > 0);
  const blinkVars = Object.fromEntries(blinking.map((b) => [b.prop, phase ? b.off : b.on]));
  const base: EdmScreenEnv = useMemo(
    () => ({
      palette,
      pv,
      macros,
      path,
      displayBg: bg,
      displayFg: bg,
      openDisplay,
      closeDisplay,
      source,
      docs,
      scope: '',
      ancestors: [],
      freeze,
      appMacros: macros,
    }),
    [palette, pv, macros, path, bg, openDisplay, closeDisplay, source, docs, freeze]
  );
  return (
    <EdmScreenContext.Provider value={base}>
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
        <EdmWindow doc={doc} path={path} macros={macros} scope="" ancestors={[]} />
      </div>
    </EdmScreenContext.Provider>
  );
}

/**
 * One EDM window's objects: the displayed screen, or a display embedded in
 * it (its own macros, path for lookups, display colours and menu
 * multiplexors). Its PV subscriptions are recorded under `scope`.
 */
export function EdmWindow({
  doc,
  path,
  macros,
  scope,
  ancestors,
}: {
  readonly doc: EdmDocument;
  readonly path: string;
  readonly macros: EdmMacros;
  readonly scope: string;
  readonly ancestors: readonly string[];
}) {
  const parent = useEdmScreen();
  const { bg, fg } = screenColors(doc, parent.palette);
  const muxes = useMemo(() => collectMuxes(doc.objects), [doc]);
  const [chosen, setChosen] = useState<ReadonlyMap<EdmObject, number>>(new Map());
  const current = useCallback(
    (o: EdmObject) => chosen.get(o) ?? initialMuxItem(o, macros),
    [chosen, macros]
  );
  const select = useCallback(
    (o: EdmObject, item: number) => setChosen((m) => new Map(m).set(o, item)),
    []
  );
  const layered = useMemo(() => {
    const sets = muxes.map((m) => {
      const def = muxDefinition(m);
      const n = def.sets.length;
      return n ? def.sets[Math.min(Math.max(current(m), 0), n - 1)] : {};
    });
    return layerMacros(macros, sets);
  }, [muxes, macros, current]);
  const mux: EdmMuxState = useMemo(() => ({ current, select }), [current, select]);
  const env: EdmScreenEnv = useMemo(
    () => ({
      ...parent,
      macros: layered,
      windowMacros: macros,
      path,
      displayBg: bg,
      displayFg: fg,
      scope,
      ancestors,
      mux,
    }),
    [parent, layered, macros, path, bg, fg, scope, ancestors, mux]
  );
  return (
    <EdmScreenContext.Provider value={env}>
      {doc.objects.map((o, i) => (
        <EdmObjectView key={i} obj={o} />
      ))}
    </EdmScreenContext.Provider>
  );
}

/**
 * Objects drawn with this window's environment but recorded under another PV
 * scope (the states of a symbol file).
 */
export function EdmScoped({
  scope,
  objects,
}: {
  readonly scope: string;
  readonly objects: readonly EdmObject[];
}) {
  const parent = useEdmScreen();
  const env = useMemo(() => ({ ...parent, scope }), [parent, scope]);
  return (
    <EdmScreenContext.Provider value={env}>
      {objects.map((o, i) => (
        <EdmObjectView key={i} obj={o} />
      ))}
    </EdmScreenContext.Provider>
  );
}
