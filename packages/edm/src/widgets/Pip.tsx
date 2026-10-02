// activePipClass (embedded display). Behaviour matches EDM's baselib/pip.cc
// with edmlib/act_win.cc; written from that behaviour, no EDM code copied.
//
//   - displaySource: stringPV (the default) opens the file named by filePv's
//     value as text (a number becomes e.g. "7.62 u", which names no file);
//     file opens `file`; menu opens displayFileName[i] for i = filePv's value
//     (-1 first writes 0), with that entry's symbols: after the window's
//     macros (which win a clash), after the application's macros
//     (propagateMacros 0), or alone (replaceSymbols). stringPV and file give
//     the child exactly the window's macros. The child is its own window
//     (its own $(!W), menu multiplexors, PVs).
//   - the frame is a sub-window above the parent's drawing, in the child
//     screen's background colour; the child (its own w x h) sits at the top
//     left, centred when smaller with `center`; `setSize` shrinks the frame to
//     the child plus sizeOfs. A missing file gives a 50 x 50 empty screen in
//     colour 0, so the frame turns that colour. Nothing is drawn before the
//     child opens; with a filePv still unconnected after 5 s, an outline.
//   - a file already open further up the chain, or nesting deeper than 8, is
//     refused (EDM's own guard is weaker).

import { useEffect, useRef, useState } from 'react';
import { expandMacros, parseMacroString } from '../macros.js';
import type { EdmMacros } from '../macros.js';
import type { EdmDocument } from '../model.js';
import { propBool, propIndexedInts, propIndexedStrings, propInt, propStr } from '../model.js';
import type { EdmPvData } from '../pv/types.js';
import { cFormat } from '../format.js';
import { EdmWindow, screenColors, screenSize } from '../screen/EdmScreen.js';
import { useEdmPut, useEdmPv, useEdmScreen, useExpanded } from '../screen/context.js';
import { useEdmDoc } from '../screen/docs.js';
import type { EdmWidgetProps } from './registry.js';
import { Unconnected } from './Rectangle.js';
import { geom, motifOrigin, pvProp } from './shared.js';

const CLS = 'activePipClass';
const MAX_DEPTH = 8;
const EMPTY_DOC: EdmDocument = { version: [4, 0, 1], screen: {}, objects: [], issues: [] };

/** A PV value as EDM's pip reads a file name from it (stringPV mode). */
export function pipFileName(d: EdmPvData): string {
  let s: string;
  if (d.type === 'enum' || d.type === 'string') s = d.text;
  else if (d.type === 'array') s = d.text;
  else if (d.type === 'integer') s = `${Math.trunc(d.num)}${d.units ? ` ${d.units}` : ''}`;
  else s = `${cFormat(`%.${d.precision ?? 0}f`, d.num)}${d.units ? ` ${d.units}` : ''}`;
  return s.slice(0, 39);
}

/** After `n` ms (EDM's pip waits 5 s before showing an unconnected filePv). */
function useAfter(ms: number): boolean {
  const [done, setDone] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setDone(true), ms);
    return () => clearTimeout(t);
  }, [ms]);
  return done;
}

export function Pip({ obj }: EdmWidgetProps) {
  const env = useEdmScreen();
  const { palette } = env;
  const p = obj.props;
  const g = geom(p);
  const mode = (propStr(p, 'displaySource') ?? 'stringPV').replace(/"/g, '');
  const numDsps = Math.min(100, Math.max(0, propInt(p, 'numDsps', 0)));
  const filePvRaw = pvProp(p, 'filePv');
  const usesPv = mode === 'stringPV' ? !!filePvRaw : mode === 'menu' && !!filePvRaw && numDsps > 0;
  const filePv = usesPv ? filePvRaw : undefined;
  const labelPv = usesPv && mode === 'menu' ? pvProp(p, 'labelPv') : undefined;
  const fpv = useEdmPv(filePv, `${CLS}.filePv`);
  useEdmPv(labelPv, `${CLS}.labelPv`);
  const fileTag = useExpanded(propStr(p, 'file') ?? '') ?? '';
  const put = useEdmPut();
  const late = useAfter(5000);
  const wroteZero = useRef(false);
  const [childW] = useState(() => `w${Math.random().toString(36).slice(2, 8)}`);

  // Which file, with which macros.
  const windowMacros = env.windowMacros ?? env.macros;
  const own: EdmMacros = { ...windowMacros, '!W': childW };
  let file = '';
  let macros: EdmMacros = own;
  let entry = -1;
  if (mode === 'file') file = fileTag.trim();
  else if (mode === 'stringPV') file = fpv?.connected ? pipFileName(fpv).trim() : '';
  else if (mode === 'menu' && fpv?.connected) {
    let i = Math.trunc(fpv.num);
    if (i < -1) i = 0;
    if (i >= 0 && i < numDsps) entry = i;
  }
  const names = propIndexedStrings(p, 'displayFileName');
  const labels = propIndexedStrings(p, 'menuLabel');
  const symbols = propIndexedStrings(p, 'symbols');
  const replace = propIndexedInts(p, 'replaceSymbols');
  const propagate = propIndexedInts(p, 'propagateMacros');
  if (entry >= 0) {
    file = expandMacros(names[entry] ?? '', env.macros).trim();
    const sym = parseMacroString(expandMacros(symbols[entry] ?? '', env.macros));
    if (replace[entry]) macros = { ...sym, '!W': childW };
    else {
      const inherit = (propagate[entry] ?? 1) ? windowMacros : (env.appMacros ?? windowMacros);
      macros = { ...sym, ...inherit, '!W': childW };
    }
  }
  const menuValue = mode === 'menu' && fpv?.connected ? Math.trunc(fpv.num) : null;
  useEffect(() => {
    // The first value -1 is answered by writing 0 (which then opens entry 0).
    if (menuValue === -1 && !wroteZero.current) {
      wroteZero.current = true;
      put(filePv, 0);
    }
  }, [menuValue, filePv, put]);
  const label = entry >= 0 ? (labels[entry] ?? '') : null;
  useEffect(() => {
    if (label !== null && labelPv) put(labelPv, label);
  }, [label, labelPv, put]);

  const depth = env.ancestors.length + 1;
  const state = useEdmDoc(file && depth <= MAX_DEPTH ? file : undefined);

  if (state.status === 'none') {
    return usesPv && late && !fpv?.connected ? (
      <Unconnected {...g} color={palette.disconnected()} />
    ) : null;
  }
  if (state.status === 'loading') return <div data-testid="embed-loading" hidden />;
  const missing = state.status === 'missing';
  const childPath = missing ? `${file} (missing)` : state.path;
  if (!missing && (childPath === env.path || env.ancestors.includes(childPath))) return null;
  const doc = missing ? EMPTY_DOC : state.doc;
  const { w: cw, h: ch } = missing ? { w: 50, h: 50 } : screenSize(doc);
  const bg = missing ? palette.css(0) : screenColors(doc, palette).bg;

  let fw = g.w;
  let fh = g.h;
  let ox = 0;
  let oy = 0;
  if (propBool(p, 'setSize')) {
    const ofs = propInt(p, 'sizeOfs', 0);
    if (cw + ofs <= fw) fw = cw + ofs;
    if (ch + ofs <= fh) fh = ch + ofs;
  } else if (propBool(p, 'center')) {
    if (fw > cw) ox = Math.trunc((fw - cw) / 2);
    if (fh > ch) oy = Math.trunc((fh - ch) / 2);
  }
  const scope = `${env.scope ? `${env.scope}>` : ''}${childPath}`;
  // The frame is a Motif widget: kept inside the drawing area's margins.
  const at = motifOrigin(g.x, g.y);
  return (
    <div
      data-edm-class={CLS}
      data-edm-file={childPath}
      style={{
        position: 'absolute',
        left: at.x,
        top: at.y,
        width: Math.max(0, fw),
        height: Math.max(0, fh),
        overflow: 'hidden',
        background: bg,
        zIndex: 1,
      }}
    >
      <div
        style={{
          position: 'absolute',
          left: ox,
          top: oy,
          width: cw,
          height: ch,
          overflow: 'hidden',
        }}
      >
        {missing ? null : (
          <EdmWindow
            doc={doc}
            path={childPath}
            macros={macros}
            scope={scope}
            ancestors={[...env.ancestors, env.path]}
          />
        )}
      </div>
    </div>
  );
}
