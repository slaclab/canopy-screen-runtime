// EDM classes built from Motif text and table widgets: multiLineTextUpdateClass
// and multiLineTextEntryClass (diamondlib/multiLineTextUpdate.cc),
// activeMessageBoxClass (baselib/message_box.cc), activeTableClass
// (baselib/table.cc) and activeCoefTableClass (baselib/coefTable.cc).
// Behaviour matches those files; the Motif look (shadows, margins, the
// scrollbar arrows, the unfocused I-beam) was measured on EDM screenshots.
// Written from that behaviour; no EDM code is copied.

import { useEffect, useRef, useState } from 'react';
import { firstColor } from '../config/colors.js';
import { motifShadows } from '../config/motif.js';
import type { EdmFont } from '../config/fonts.js';
import { resolveFont, textWidth } from '../config/fonts.js';
import { cFormat } from '../format.js';
import { propBool, propInt, propStr } from '../model.js';
import type { EdmPvData } from '../pv/types.js';
import { pvString } from './Textupdate.js';
import { useEdmPut, useEdmPv, useEdmScreen, useExpanded } from '../screen/context.js';
import type { EdmWidgetProps } from './registry.js';
import { TextRun, colorSpec, geom, idiv, motifOrigin, pvProp } from './shared.js';

type Px = [number, number];
const pixels = (pts: readonly Px[], ox: number, oy: number) =>
  pts.map(([a, b]) => `M${ox + a} ${oy + b}h1v1h-1z`).join('');

/** Motif's shadow band of thickness t on a w x h box: which pixels take the top/left colour. */
function shadowBand(w: number, h: number, t: number): { tl: Px[]; br: Px[] } {
  const tl: Px[] = [];
  const br: Px[] = [];
  for (let b = 0; b < h; b++) {
    for (let a = 0; a < w; a++) {
      if (a >= t && b >= t && a < w - t && b < h - t) continue;
      ((b < t && a + b <= w - 1) || (a < t && a + b <= h - 1) ? tl : br).push([a, b]);
    }
  }
  return { tl, br };
}

/** A 2-px Motif shadow: sunken = bottom shadow on the top/left. */
function MotifShadow(props: {
  x: number;
  y: number;
  w: number;
  h: number;
  top: string | undefined;
  bottom: string | undefined;
  sunken: boolean;
}) {
  const { x, y, w, h, top, bottom, sunken } = props;
  if (w <= 0 || h <= 0) return null;
  const band = shadowBand(w, h, 2);
  return (
    <>
      <path d={pixels(band.tl, x, y)} fill={sunken ? bottom : top} />
      <path d={pixels(band.br, x, y)} fill={sunken ? top : bottom} />
    </>
  );
}

// X's `fixed` font (6x13): Motif's default when an EDM font tag is unknown.
function motifFont(tag: string | undefined): EdmFont {
  const f = resolveFont(tag);
  if (!f.fallback) return f;
  const widths: Record<number, number> = {};
  for (let c = 32; c < 127; c++) widths[c] = 6;
  return {
    ...resolveFont('courier-medium-r-10.0'),
    ascent: 11,
    descent: 2,
    maxAscent: 11,
    maxDescent: 2,
    widths,
    bitmap: false,
  } as EdmFont;
}

const MLTU = 'multiLineTextUpdateClass';
const MLTE = 'multiLineTextEntryClass';
const INVALID_TYPE = '!! Invalid PV type !!';

/** The text a multi-line class shows: a char waveform's text, else EDM's complaint. */
function multiLineText(d: EdmPvData | undefined, name: string): string {
  if (!d?.connected) return `<${name}>`;
  if (d.charArray || d.type === 'array') return d.text.split('\u0000')[0].slice(0, 1000);
  return INVALID_TYPE;
}

/** Word-wrapped lines (at white space) to `width` px. */
function wrap(font: EdmFont, text: string, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/(?<=\s)/)) {
      if (line && textWidth(font, line + word) > width) {
        out.push(line);
        line = word;
      } else line += word;
    }
    out.push(line);
  }
  return out;
}

function makeMultiLine(cls: string, entry: boolean) {
  return function MultiLine({ obj }: EdmWidgetProps) {
    const { palette, displayBg } = useEdmScreen();
    const p = obj.props;
    const g = geom(p);
    const { x, y } = motifOrigin(g.x, g.y);
    const { w, h } = g;
    const controlPv = pvProp(p, 'controlPv');
    const colourPv = pvProp(p, 'colourPv');
    const pv = useEdmPv(controlPv, `${cls}.controlPv`);
    const cpv = useEdmPv(colourPv, `${cls}.colourPv`);
    const name = useExpanded(controlPv) ?? '';
    const put = useEdmPut();
    const [editing, setEditing] = useState<string | null>(null);
    const font = resolveFont(propStr(p, 'font'));
    const bg = palette.spec(colorSpec(p, 'bgColour')) ?? '#ffffff';
    const sh = motifShadows(firstColor(bg));
    const valid = !!pv?.connected;
    // pvFactory's colour helper: rule on colourPv (else the control value),
    // alarm colours with fgAlarm; a missing PV counts as INVALID.
    let fg = palette.spec(colorSpec(p, 'fgColour'), (colourPv ? cpv : pv)?.num);
    if (propBool(p, 'fgAlarm')) {
      if (!valid) fg = palette.invalid();
      else if (pv.severity > 0) fg = palette.alarm[pv.severity] ?? fg;
    }
    const text = multiLineText(pv, name);
    const hl = entry ? 3 : 0;
    const x0 = x + hl + 7;
    const b0 = y + hl + 7 + font.maxAscent;
    const lines = wrap(font, text, w - 2 * hl - 14);
    const fhM = font.maxAscent + font.maxDescent;
    const sx = x + hl;
    const sy = y + hl;
    const sw = w - 2 * hl;
    const shh = h - 2 * hl;
    // The unfocused insertion cursor: a stippled I-beam at text position 0.
    const beam: Px[] = [];
    if (entry) {
      const top = b0 - font.maxAscent;
      const bottom = b0 + font.maxDescent - 1;
      for (let r = top; r <= bottom; r++) {
        const cols = r === top || r === bottom ? [x0 - 3, x0 - 2, x0 - 1, x0, x0 + 1] : [x0 - 1];
        for (const c of cols) if ((c - x + (r - y)) % 2 === 0) beam.push([c, r]);
      }
    }
    const writable = valid && pv.writable;
    return (
      <div
        data-edm-class={cls}
        style={{ position: 'absolute', left: x, top: y, width: w, height: h, zIndex: 1 }}
      >
        <svg
          width={w}
          height={h}
          viewBox={`${x} ${y} ${w} ${h}`}
          shapeRendering="crispEdges"
          style={{ display: 'block' }}
        >
          {hl ? <rect x={x} y={y} width={w} height={h} fill={displayBg} /> : null}
          <rect x={sx} y={sy} width={Math.max(0, sw)} height={Math.max(0, shh)} fill={bg} />
          <MotifShadow x={sx} y={sy} w={sw} h={shh} top={sh.top} bottom={sh.bottom} sunken />
          <svg
            x={sx + 2}
            y={sy + 2}
            width={Math.max(0, sw - 4)}
            height={Math.max(0, shh - 4)}
            viewBox={`${sx + 2} ${sy + 2} ${Math.max(0, sw - 4)} ${Math.max(0, shh - 4)}`}
            overflow="hidden"
          >
            {editing === null
              ? lines.map((l, i) => (
                  <TextRun key={i} font={font} text={l} x={x0} y={b0 + i * fhM} fill={fg} />
                ))
              : null}
            {beam.length && editing === null ? <path d={pixels(beam, 0, 0)} fill={fg} /> : null}
          </svg>
        </svg>
        {entry ? (
          editing !== null ? (
            <textarea
              autoFocus
              value={editing}
              onChange={(e) => setEditing(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.location === 3)) {
                  e.preventDefault();
                  put(controlPv, editing);
                  setEditing(null);
                }
              }}
              onBlur={() => {
                if (editing !== text) put(controlPv, editing);
                setEditing(null);
              }}
              style={{
                position: 'absolute',
                left: hl + 2,
                top: hl + 2,
                width: w - 2 * hl - 4,
                height: h - 2 * hl - 4,
                padding: '5px 5px',
                border: 'none',
                outline: 'none',
                resize: 'none',
                background: bg,
                color: fg,
                font: `${font.sizePx}px ${font.family}`,
                lineHeight: `${fhM}px`,
                pointerEvents: 'auto',
              }}
            />
          ) : (
            <div
              role="textbox"
              aria-readonly={!writable}
              onMouseDown={() => {
                if (writable) setEditing(text);
              }}
              style={{
                position: 'absolute',
                inset: 0,
                cursor: writable ? 'text' : 'not-allowed',
                pointerEvents: 'auto',
              }}
            />
          )
        ) : null}
      </div>
    );
  };
}

export const MultiLineTextUpdate = makeMultiLine(MLTU, false);
export const MultiLineTextEntry = makeMultiLine(MLTE, true);

// Motif scrollbar arrows, row by row (R trough, F background, L light, D dark).
const ARROWS: Record<'up' | 'down' | 'left' | 'right', string[]> = {
  up: [
    'RRRRRLRRRRR',
    'RRRRLLDRRRR',
    'RRRRLLDRRRR',
    'RRRLLFDDRRR',
    'RRRLLFDDRRR',
    'RRLLFFFDDRR',
    'RRLLFFFDDRR',
    'RLLFFFFFDDR',
    'RLLFFFFFDDR',
    'LLDDDDDDDDD',
    'LDDDDDDDDDD',
  ],
  down: [
    'LLLLLLLLLLL',
    'LLLLLLLLLDD',
    'RLLFFFFFDDR',
    'RLLFFFFFDDR',
    'RRLLFFFDDRR',
    'RRLLFFFDDRR',
    'RRRLLFDDRRR',
    'RRRLLFDDRRR',
    'RRRRLDDRRRR',
    'RRRRLDDRRRR',
    'RRRRRDRRRRR',
  ],
  left: [
    'RRRRRRRRRLL',
    'RRRRRRRLLLD',
    'RRRRRLLLLDD',
    'RRRLLLLFFDD',
    'RLLLLFFFFDD',
    'LLLFFFFFFDD',
    'RDDDDFFFFDD',
    'RRRDDDDFFDD',
    'RRRRRDDDDDD',
    'RRRRRRRDDDD',
    'RRRRRRRRRDD',
  ],
  right: [
    'LLRRRRRRRRR',
    'LLLLRRRRRRR',
    'LLLLLLRRRRR',
    'LLFFLLLLRRR',
    'LLFFFFLLLLR',
    'LLFFFFFFDDD',
    'LLFFFFDDDDR',
    'LLFFDDDDRRR',
    'LLDDDDRRRRR',
    'LDDDRRRRRRR',
    'LDRRRRRRRRR',
  ],
};
const TROUGH = '#a8a9a9';

function Arrow(props: {
  x: number;
  y: number;
  dir: keyof typeof ARROWS;
  face: string | undefined;
  light: string | undefined;
  dark: string | undefined;
}) {
  const by: Record<string, Px[]> = { R: [], F: [], L: [], D: [] };
  ARROWS[props.dir].forEach((row, r) => [...row].forEach((c, k) => by[c].push([k, r])));
  const fill: Record<string, string | undefined> = {
    R: TROUGH,
    F: props.face,
    L: props.light,
    D: props.dark,
  };
  return (
    <>
      {Object.entries(by).map(([k, pts]) => (
        <path key={k} d={pixels(pts, props.x, props.y)} fill={fill[k]} />
      ))}
    </>
  );
}

/** A Motif scrollbar (15 px thick) with everything visible: border, trough, arrows, slider. */
function ScrollBar(props: {
  x: number;
  y: number;
  len: number;
  vertical: boolean;
  face: string | undefined;
  top: string | undefined;
  bottom: string | undefined;
}) {
  const { x, y, len, vertical, face, top, bottom } = props;
  const [w, h] = vertical ? [15, len] : [len, 15];
  const inner = len - 4;
  const slider = inner - 2 * 11 - 2;
  return (
    <>
      <rect x={x} y={y} width={w} height={h} fill={TROUGH} />
      <MotifShadow x={x} y={y} w={w} h={h} top={top} bottom={bottom} sunken />
      {vertical ? (
        <>
          <Arrow x={x + 2} y={y + 2} dir="up" face={face} light={top} dark={bottom} />
          <Arrow x={x + 2} y={y + h - 13} dir="down" face={face} light={top} dark={bottom} />
          <rect x={x + 2} y={y + 14} width={11} height={Math.max(0, slider)} fill={face} />
          <MotifShadow
            x={x + 2}
            y={y + 14}
            w={11}
            h={slider}
            top={top}
            bottom={bottom}
            sunken={false}
          />
        </>
      ) : (
        <>
          <Arrow x={x + 2} y={y + 2} dir="left" face={face} light={top} dark={bottom} />
          <Arrow x={x + w - 13} y={y + 2} dir="right" face={face} light={top} dark={bottom} />
          <rect x={x + 14} y={y + 2} width={Math.max(0, slider)} height={11} fill={face} />
          <MotifShadow
            x={x + 14}
            y={y + 2}
            w={slider}
            h={11}
            top={top}
            bottom={bottom}
            sunken={false}
          />
        </>
      )}
    </>
  );
}

const MSG = 'activeMessageBoxClass';

export function MessageBox({ obj }: EdmWidgetProps) {
  const { palette } = useEdmScreen();
  const p = obj.props;
  const g = geom(p);
  const { x, y } = motifOrigin(g.x, g.y);
  const { w, h } = g;
  const indicatorPv = pvProp(p, 'indicatorPv');
  const pv = useEdmPv(indicatorPv, `${MSG}.indicatorPv`);
  const [text, setText] = useState('');
  const seen = useRef(0);
  const last = useRef<EdmPvData | undefined>(undefined);
  useEffect(() => {
    if (!pv?.connected || pv === last.current) return;
    last.current = pv;
    // EDM drops the first value after the first connection.
    if (seen.current++ === 0) return;
    const s = pvString(pv).slice(0, 38).replace(/\\n$/, '\n');
    setText((t) => (t + s).slice(-2 * Math.max(propInt(p, 'bufferSize', 1000), 1000) + 80));
  }, [pv, p]);

  const tagFont = resolveFont(propStr(p, 'font'));
  const F = motifFont(propStr(p, 'font'));
  const tH = tagFont.fallback ? 10 : tagFont.ascent + tagFont.descent;
  const lH = F.ascent + F.descent;
  const bw = textWidth(F, 'Clear') + 8;
  const bh = lH + 8;
  const formH = bh + 16;
  const FH = h - tH + lH + 2;
  const sy = y + formH + 13;
  const SWh = h - tH - 40;
  const second = palette.spec(colorSpec(p, '2ndBgColor'));
  const ts = palette.spec(colorSpec(p, 'topShadowColor'));
  const bs = palette.spec(colorSpec(p, 'botShadowColor'));
  const bg = palette.spec(colorSpec(p, 'bgColor'));
  const fg = pv?.connected ? palette.spec(colorSpec(p, 'fgColor')) : '#000000';
  const fhM = F.maxAscent + F.maxDescent;
  const W = w + 2;
  return (
    <div
      data-edm-class={MSG}
      style={{ position: 'absolute', left: x, top: y, width: W, height: FH, zIndex: 1 }}
    >
      <svg
        width={W}
        height={FH}
        viewBox={`${x} ${y} ${W} ${FH}`}
        shapeRendering="crispEdges"
        style={{ display: 'block' }}
      >
        <rect x={x} y={y} width={W} height={FH} fill={second} />
        {/* etched-out frame: a raised 1-px ring around a sunken one */}
        <rect x={x} y={y} width={W - 1} height={1} fill={ts} />
        <rect x={x} y={y} width={1} height={FH - 1} fill={ts} />
        <rect x={x} y={y + FH - 1} width={W} height={1} fill={bs} />
        <rect x={x + W - 1} y={y} width={1} height={FH} fill={bs} />
        <rect x={x + 1} y={y + 1} width={W - 3} height={1} fill={bs} />
        <rect x={x + 1} y={y + 1} width={1} height={FH - 3} fill={bs} />
        <rect x={x + 1} y={y + FH - 2} width={W - 2} height={1} fill={ts} />
        <rect x={x + W - 2} y={y + 1} width={1} height={FH - 2} fill={ts} />
        {/* Clear button */}
        <MotifShadow
          x={x + w - 11 - bw}
          y={y + 13}
          w={bw}
          h={bh}
          top={ts}
          bottom={bs}
          sunken={false}
        />
        <TextRun
          font={F}
          text="Clear"
          x={x + w - 11 - bw + 4}
          y={y + 13 + 4 + F.ascent}
          fill={palette.spec(colorSpec(p, 'fgColor'))}
        />
        {/* separator */}
        <rect x={x + 2} y={y + formH + 8} width={w - 2} height={1} fill={bs} />
        <rect x={x + 2} y={y + formH + 9} width={w - 2} height={1} fill={ts} />
        <rect x={x + w - 11} y={y + formH + 9} width={1} height={1} fill="#c5c5c5" />
        {/* text area */}
        <rect x={x + 7} y={sy + 2} width={w - 31} height={Math.max(0, SWh - 23)} fill={bg} />
        <MotifShadow x={x + 7} y={sy + 2} w={w - 31} h={SWh - 23} top={ts} bottom={bs} sunken />
        <svg
          x={x + 9}
          y={sy + 4}
          width={Math.max(0, w - 35)}
          height={Math.max(0, SWh - 27)}
          viewBox={`${x + 9} ${sy + 4} ${Math.max(0, w - 35)} ${Math.max(0, SWh - 27)}`}
          overflow="hidden"
        >
          {text.split('\n').map((l, i) => (
            <TextRun
              key={i}
              font={F}
              text={l}
              x={x + 14}
              y={sy + 9 + F.maxAscent + i * fhM}
              fill={fg}
            />
          ))}
        </svg>
        <ScrollBar
          x={x + w - 18}
          y={sy}
          len={SWh - 19}
          vertical
          face={second}
          top={ts}
          bottom={bs}
        />
        <ScrollBar
          x={x + 5}
          y={sy + SWh - 15}
          len={w - 27}
          vertical={false}
          face={second}
          top={ts}
          bottom={bs}
        />
      </svg>
      <div
        role="button"
        aria-label="Clear"
        onMouseDown={(e) => {
          if (e.button === 0) setText('');
        }}
        style={{
          position: 'absolute',
          left: w - 11 - bw,
          top: 13,
          width: bw,
          height: bh,
          pointerEvents: 'auto',
        }}
      />
    </div>
  );
}

/** One cell of EDM's tables: text, column, alignment. */
interface Column {
  readonly cells: readonly string[];
  readonly header: 'l' | 'c' | 'r';
  readonly body: 'l' | 'c' | 'r';
}

/** The table layout EDM's table classes share: columns with 1-px borders, alternating rows. */
function TableGrid(props: {
  x: number;
  y: number;
  w: number;
  h: number;
  font: EdmFont;
  columns: readonly Column[];
  fg: string | undefined;
  bg: string | undefined;
  odd: string | undefined;
  even: string | undefined;
  top: string | undefined;
  bottom: string | undefined;
}) {
  const { x, y, w, h, font, columns, fg, bg, odd, even, top, bottom } = props;
  const fhL = font.ascent + font.descent;
  const ch = fhL + 4;
  const widths = columns.map((c) => Math.max(...c.cells.map((t) => textWidth(font, t) + 4), 4) + 2);
  const mainW = widths.reduce((a, b) => a + b, 0);
  const gx = mainW < w ? x + 2 + idiv(w - mainW, 2) : x + 2;
  const gy = y + 2;
  const lefts = widths.map((_, k) => gx + widths.slice(0, k).reduce((a, b) => a + b, 0));
  const parts = columns.map((col, k) => {
    const cw = widths[k];
    const left = lefts[k];
    return (
      <g key={k}>
        <rect x={left} y={gy} width={cw} height={col.cells.length * ch + 2} fill={fg} />
        {col.cells.map((t, r) => {
          const tw = textWidth(font, t);
          const al = r === 0 ? col.header : col.body;
          const cellX = left + 1;
          const cellW = cw - 2;
          const tx =
            al === 'r'
              ? cellX + cellW - 2 - tw
              : al === 'c'
                ? cellX + 2 + idiv(cellW - 4 - tw, 2)
                : cellX + 2;
          const top0 = gy + 1 + r * ch;
          return (
            <g key={r}>
              <rect x={cellX} y={top0} width={cellW} height={ch} fill={r % 2 ? even : odd} />
              <TextRun
                font={font}
                text={t}
                x={tx}
                y={top0 + idiv(ch - fhL, 2) + font.ascent}
                fill={fg}
              />
            </g>
          );
        })}
      </g>
    );
  });
  return (
    <svg
      width={w}
      height={h}
      viewBox={`${x} ${y} ${w} ${h}`}
      shapeRendering="crispEdges"
      style={{ position: 'absolute', left: x, top: y, zIndex: 1 }}
    >
      <rect x={x} y={y} width={w} height={h} fill={bg} />
      <svg
        x={x + 2}
        y={y + 2}
        width={Math.max(0, w - 4)}
        height={Math.max(0, h - 4)}
        viewBox={`${x + 2} ${y + 2} ${Math.max(0, w - 4)} ${Math.max(0, h - 4)}`}
        overflow="hidden"
      >
        {parts}
      </svg>
      <MotifShadow x={x} y={y} w={w} h={h} top={top} bottom={bottom} sunken />
    </svg>
  );
}

const TABLE = 'activeTableClass';

/**
 * activeTableClass reads a table from a file on the EDM host whose name is
 * the PV's value; a browser cannot, so it shows EDM's message for an
 * unreadable file (all the golden screens show exactly that).
 */
export function Table({ obj }: EdmWidgetProps) {
  const { palette } = useEdmScreen();
  const p = obj.props;
  const g = geom(p);
  const { x, y } = motifOrigin(g.x, g.y);
  const pv = useEdmPv(pvProp(p, 'pv'), `${TABLE}.pv`);
  const name = pv?.connected ? pvString(pv).slice(0, 38).trim() : '';
  const c = (k: string) => palette.spec(colorSpec(p, k));
  if (!name) {
    return (
      <svg
        width={g.w}
        height={g.h}
        style={{ position: 'absolute', left: x, top: y, zIndex: 1, display: 'block' }}
      >
        <rect width={g.w} height={g.h} fill={c('bgColor')} />
      </svg>
    );
  }
  return (
    <TableGrid
      x={x}
      y={y}
      w={g.w}
      h={g.h}
      font={motifFont(propStr(p, 'font'))}
      columns={[{ cells: [`File [${name}] could not be opened`], header: 'l', body: 'l' }]}
      fg={c('fgColor')}
      bg={c('bgColor')}
      odd={c('oddColBgColor')}
      even={c('evenColBgColor')}
      top={c('topShadowColor')}
      bottom={c('botShadowColor')}
    />
  );
}

const COEF = 'activeCoefTableClass';

/** activeCoefTableClass: an array PV as label / value rows. */
export function CoefTable({ obj }: EdmWidgetProps) {
  const { palette } = useEdmScreen();
  const p = obj.props;
  const g = geom(p);
  const { x, y } = motifOrigin(g.x, g.y);
  const pv = useEdmPv(pvProp(p, 'pv'), `${COEF}.pv`);
  const labelsS = useExpanded(propStr(p, 'labels') ?? '') ?? '';
  const format = useExpanded(propStr(p, 'format') ?? '') ?? '';
  const c = (k: string) => palette.spec(colorSpec(p, k));
  if (!pv?.connected || pv.type === 'string' || pv.charArray) return null;
  const values = pv.values ?? [pv.num];
  const max = Math.min(values.length, 1000);
  const first = Math.min(Math.max(propInt(p, 'firstElement', 0), 0), Math.max(max - 1, 0));
  const labels = labelsS.split(',').filter((t) => t !== '');
  let num = propInt(p, 'numElements', 0);
  if (num === 0) num = labels.length || max;
  const rowsL: string[] = [];
  const rowsV: string[] = [];
  for (let i = first, k = 0; i < Math.min(first + num, max); i++, k++) {
    rowsL.push(labels[k] ?? `Coef ${i}`);
    const v = values[i];
    rowsV.push(
      pv.type === 'enum'
        ? 'Unsupported type'
        : format
          ? cFormat(format, v).slice(0, 255)
          : pv.type === 'integer'
            ? `${Math.trunc(v)}`
            : cFormat('%g', v)
    );
  }
  return (
    <TableGrid
      x={x}
      y={y}
      w={g.w}
      h={g.h}
      font={motifFont(propStr(p, 'font'))}
      columns={[
        { cells: rowsL, header: 'r', body: 'r' },
        { cells: rowsV, header: 'l', body: 'l' },
      ]}
      fg={c('fgColor')}
      bg={c('bgColor')}
      odd={c('oddColBgColor')}
      even={c('evenColBgColor')}
      top={c('topShadowColor')}
      bottom={c('botShadowColor')}
    />
  );
}
