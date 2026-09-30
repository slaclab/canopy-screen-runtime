// relatedDisplayClass. Behaviour matches EDM's baselib/related_display.cc:
//   - look: bgColor face on a (w+1) x (h+1) footprint, EDM's raised bevel,
//     the label centred at x + w/2 with its top at y + h/2 - ascent/2, clipped
//     to the object; `icon` adds the two-window glyph; `invisible` objects
//     draw nothing but stay clickable (hotspots over schematics); colorPv
//     evaluates colour rules; with PVs, nothing is drawn until they connect
//     (a 1-px outline in the disconnected colour after 2 s);
//   - one display opens on press; several open a menu of menuLabel entries on
//     release; `pv`/`value` pairs are written first when all are connected;
//   - macros: replaceSymbols -> only the entry's symbols; else the window's
//     macros, then the entry's symbols, and on a name clash the INHERITED
//     value wins (propagateMacros 0 inherits nothing here: the viewer has no
//     application-level macros); closeAction closes this display afterwards.
// Written from that behaviour; no EDM code is copied.

import { useState } from 'react';
import type { ReactNode } from 'react';
import { resolveFont, textWidth } from '../config/fonts.js';
import { expandMacros, parseMacroString } from '../macros.js';
import { propBool, propIndexedInts, propIndexedStrings, propInt, propStr } from '../model.js';
import type { EdmPvData } from '../pv/types.js';
import { useEdmPut, useEdmPv, useEdmScreen, useExpanded, usePhase } from '../screen/context.js';
import { CentredLabel, Face, Hotspot, PopupMenu, XLines, raisedBevel } from './button.js';
import type { EdmWidgetProps } from './registry.js';
import { Unconnected } from './Rectangle.js';
import { SvgBox, TextRun, atof, atol, colorSpec, geom, idiv, pvProp } from './shared.js';

const CLS = 'relatedDisplayClass';

/** The value a related display (or message button) writes, by destination type. */
export function valueFor(pv: EdmPvData | undefined, text: string): number | string {
  switch (pv?.type) {
    case 'integer':
    case 'enum':
      return atol(text);
    case 'string':
      return text.slice(0, 39);
    default:
      return atof(text);
  }
}

export function RelatedDisplay({ obj }: EdmWidgetProps) {
  const env = useEdmScreen();
  const { palette } = env;
  const p = obj.props;
  const g = geom(p);
  const colorPv = pvProp(p, 'colorPv');
  const cpv = useEdmPv(colorPv, `${CLS}.colorPv`);
  const pvNames = propIndexedStrings(p, 'pv');
  const values = propIndexedStrings(p, 'value');
  const numPvs = Math.min(4, propInt(p, 'numPvs', 0));
  // EDM allows 4 destination PVs; hooks need a fixed count.
  const dest = [
    useEdmPv(numPvs > 0 ? pvNames[0] : undefined, `${CLS}.pv`),
    useEdmPv(numPvs > 1 ? pvNames[1] : undefined, `${CLS}.pv`),
    useEdmPv(numPvs > 2 ? pvNames[2] : undefined, `${CLS}.pv`),
    useEdmPv(numPvs > 3 ? pvNames[3] : undefined, `${CLS}.pv`),
  ];
  const put = useEdmPut();
  const label = useExpanded(propStr(p, 'buttonLabel') ?? '') ?? '';
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  const files = propIndexedStrings(p, 'displayFileName');
  const labels = propIndexedStrings(p, 'menuLabel');
  const symbols = propIndexedStrings(p, 'symbols');
  const propagate = propIndexedInts(p, 'propagateMacros');
  const replace = propIndexedInts(p, 'replaceSymbols');
  const closeAction = propIndexedInts(p, 'closeAction');
  const closeDisplay = propIndexedInts(p, 'closeDisplay');
  const n = Math.min(propInt(p, 'numDsps', files.length), 24);
  const targets: { file: string; label: string; i: number }[] = [];
  for (let i = 0; i < n; i++) {
    const f = files[i];
    if (f?.trim()) {
      targets.push({ file: f.trim(), label: expandMacros(labels[i] ?? '', env.macros), i });
    }
  }

  const used = dest.slice(0, numPvs).filter((_, i) => pvNames[i]?.trim());
  const defined = [...(colorPv ? [cpv] : []), ...used];
  const phase = usePhase(defined);

  const open = (t: { file: string; i: number }) => {
    // Destination PVs are written at the start of every open, when all are connected.
    if (used.length && used.every((d) => d?.connected)) {
      for (let i = 0; i < numPvs; i++) {
        if (pvNames[i]?.trim()) {
          put(pvNames[i], valueFor(dest[i], expandMacros(values[i] ?? '', env.macros)));
        }
      }
    }
    const own = parseMacroString(expandMacros(symbols[t.i] ?? '', env.macros));
    let macros: Record<string, string>;
    if (replace[t.i]) macros = own;
    else if (propagate[t.i] ?? 1) macros = { ...own, ...env.macros };
    else macros = own;
    const close = (closeAction[t.i] ?? closeDisplay[t.i] ?? 0) !== 0;
    env.openDisplay?.({
      file: expandMacros(t.file, env.macros),
      fromPath: env.path,
      macros,
      replace: close,
    });
  };

  const swap = propBool(p, 'swapButtons');
  const isButton1 = (button: number) => (swap ? button === 2 : button === 0);
  const hotspot = (
    <>
      <Hotspot
        {...g}
        cls={CLS}
        active={targets.length > 0}
        cursor="pointer"
        title={targets.map((t) => t.label || t.file).join('\n')}
        onPress={(e) => {
          if (isButton1(e.button) && targets.length === 1) open(targets[0]);
        }}
        onRelease={(e) => {
          if (isButton1(e.button) && targets.length > 1) setMenu({ x: e.clientX, y: e.clientY });
        }}
      />
      {menu ? (
        <PopupMenu
          at={menu}
          onClose={() => setMenu(null)}
          items={targets.map((t) => ({ label: t.label, onSelect: () => open(t) }))}
        />
      ) : null}
    </>
  );

  if (phase !== 'init') {
    return (
      <>
        {phase === 'unconnected' ? <Unconnected {...g} color={palette.disconnected()} /> : null}
        {hotspot}
      </>
    );
  }
  if (propBool(p, 'invisible')) return hotspot;

  const font = resolveFont(propStr(p, 'font'));
  const fg = palette.spec(colorSpec(p, 'fgColor'), cpv?.num);
  const bg = palette.spec(colorSpec(p, 'bgColor'), cpv?.num);
  const ts = palette.spec(colorSpec(p, 'topShadowColor'));
  const bs = palette.spec(colorSpec(p, 'botShadowColor'));
  const { x, y, w, h } = g;
  const icon = propBool(p, 'icon');
  const asc = font.ascent;

  let content: ReactNode = null;
  if (label.trim()) {
    if (!icon) {
      content = (
        <CentredLabel
          font={font}
          text={label.slice(0, 39)}
          tX={x + idiv(w, 2)}
          tY={y + idiv(h, 2) - idiv(asc, 2)}
          fill={fg}
          clip={[x, y, w, h]}
        />
      );
    } else {
      const sw = textWidth(font, label) + Math.trunc(1.2 * asc + 0.5);
      const tX =
        x + Math.trunc(w / 2 + 0.5) - Math.trunc(sw / 2 + 0.5) + Math.trunc(1.2 * asc + 0.5);
      const tY = y + Math.trunc(h / 2 + 0.5) - Math.trunc(asc / 2 + 0.5);
      const ofs = Math.trunc(asc * 0.1 + 0.5);
      const size = Math.trunc(asc - 2 * ofs + 0.5);
      const cx = tX - Math.trunc(1.5 * asc + 0.5);
      const cy = tY + ofs;
      content = (
        <svg
          x={x}
          y={y}
          width={Math.max(0, w)}
          height={Math.max(0, h)}
          viewBox={`${x} ${y} ${Math.max(0, w)} ${Math.max(0, h)}`}
          overflow="hidden"
        >
          <IconWindows
            cx={cx}
            cy={cy - ofs}
            back={[cx + 2 * ofs, cy + ofs]}
            size={size}
            fg={fg}
            bg={bg}
          />
          <TextRun font={font} text={label} x={tX} y={tY + asc} fill={fg} />
        </svg>
      );
    }
  } else if (icon) {
    const min = Math.min(Math.trunc((w * 3) / 5), Math.trunc((h * 3) / 5));
    const cx = x + idiv(w, 2);
    const cy = y + idiv(h, 2);
    const ofs = Math.trunc((min * 2) / 5 + 0.5);
    const size = Math.trunc((min * 3) / 5 - 0.5);
    content = (
      <IconWindows
        cx={cx - ofs}
        cy={cy - ofs}
        back={[cx + ofs - size, cy + ofs - size]}
        size={size}
        fg={fg}
        bg={bg}
      />
    );
  }

  return (
    <>
      <SvgBox x={x} y={y} w={w + 1} h={h + 1} clip>
        <Face {...g} color={bg} />
        <XLines lines={raisedBevel(x, y, w, h, ts, bs)} />
        {content}
      </SvgBox>
      {hotspot}
    </>
  );
}

/** EDM's related-display icon: a back window outline and a filled front window. */
function IconWindows({
  cx,
  cy,
  back,
  size,
  fg,
  bg,
}: {
  cx: number;
  cy: number;
  back: [number, number];
  size: number;
  fg?: string;
  bg?: string;
}) {
  return (
    <>
      <rect
        x={back[0] + 0.5}
        y={back[1] + 0.5}
        width={size}
        height={size}
        fill="none"
        stroke={fg}
      />
      <rect x={cx} y={cy} width={size} height={size} fill={bg} />
      <rect x={cx + 0.5} y={cy + 0.5} width={size} height={size} fill="none" stroke={fg} />
    </>
  );
}
