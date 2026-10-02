// activeRadioButtonClass. Behaviour matches EDM's baselib/radio_button.cc: a
// Motif radio box (one XmToggleButton per enum state) in a bulletin board of
// w x h, which clips entries that do not fit:
//   - entry i is fh + 8 px tall; a square indicator (fh - 3 px, Motif's
//     2-px shadow, raised when unset and sunken when set) with its interior
//     in buttonColor, or selectColor plus a check mark when set; the state
//     string beside it;
//   - the set entry's label (and check) use fgColor with alarm and
//     disconnected colours, the others the static fgColor;
//   - the control PV must be an enum: otherwise, and until it connects, the
//     unconnected outline (after 2 s); clicking another entry writes its index.
// The Motif metrics were measured on EDM screenshots (helvetica 12); written
// from that behaviour, no EDM code is copied.

import { resolveFont } from '../config/fonts.js';
import { propBool, propStr } from '../model.js';
import { useEdmPut, useEdmPv, useEdmScreen, usePhase } from '../screen/context.js';
import type { EdmWidgetProps } from './registry.js';
import { Unconnected } from './Rectangle.js';
import { TextRun, colorSpec, edmColor, geom, idiv, motifOrigin, pvProp } from './shared.js';

const CLS = 'activeRadioButtonClass';

const CHECK = ['......#', '.....##', '.##.##.', '#####..', '.####..', '..##...', '...#...'];

/** Motif XmeDrawShadows: which ring pixels of a w x h box take the top/left colour. */
export function motifShadowPixels(
  w: number,
  h: number,
  t: number
): { topLeft: [number, number][]; bottomRight: [number, number][] } {
  const topLeft: [number, number][] = [];
  const bottomRight: [number, number][] = [];
  for (let b = 0; b < h; b++) {
    for (let a = 0; a < w; a++) {
      if (Math.min(a, b, w - 1 - a, h - 1 - b) >= t) continue;
      const tl = (b < t && a <= w - 1 - b) || (a < t && b <= h - 1 - a);
      (tl ? topLeft : bottomRight).push([a, b]);
    }
  }
  return { topLeft, bottomRight };
}

const pixels = (pts: [number, number][], ox: number, oy: number) =>
  pts.map(([a, b]) => `M${ox + a} ${oy + b}h1v1h-1z`).join('');

export function RadioBox({ obj }: EdmWidgetProps) {
  const { palette } = useEdmScreen();
  const p = obj.props;
  const g = geom(p);
  const controlPv = pvProp(p, 'controlPv');
  const raw = useEdmPv(controlPv, `${CLS}.controlPv`);
  const put = useEdmPut();
  // Only an enum PV is accepted; anything else counts as never connected.
  const pv = raw && raw.type !== 'enum' && raw.connected ? { ...raw, connected: false } : raw;
  const phase = usePhase([pv]);
  if (!controlPv) return null;
  if (phase !== 'init' || !pv) {
    return phase === 'unconnected' ? <Unconnected {...g} color={palette.disconnected()} /> : null;
  }

  const { x, y } = motifOrigin(g.x, g.y);
  const { w, h } = g;
  const font = resolveFont(propStr(p, 'font'));
  const fh = font.ascent + font.descent;
  const ind = fh - 1;
  const box = ind - 2;
  const pitch = fh + 8;
  const indTop = 5 + idiv(fh - ind, 2);
  const textX = 3 + ind + 4;
  const value = Math.trunc(pv.num);
  const fgStatic = palette.spec(colorSpec(p, 'fgColor'));
  const fgSel = pv.connected
    ? edmColor(palette, colorSpec(p, 'fgColor'), {
        data: pv,
        alarmSensitive: propBool(p, 'fgAlarm'),
      })
    : palette.disconnected();
  const bg = palette.spec(colorSpec(p, 'bgColor'));
  const ts = palette.spec(colorSpec(p, 'topShadowColor'));
  const bs = palette.spec(colorSpec(p, 'botShadowColor'));
  const button = palette.spec(colorSpec(p, 'buttonColor'));
  const select = palette.spec(colorSpec(p, 'selectColor'));
  const ring = motifShadowPixels(box, box, 2);
  const writable = pv.connected && pv.writable;

  return (
    <div
      data-edm-class={CLS}
      role="radiogroup"
      style={{
        position: 'absolute',
        left: x,
        top: y,
        width: w,
        height: h,
        overflow: 'hidden',
        zIndex: 1,
        pointerEvents: 'auto',
      }}
    >
      <svg width={w} height={h} shapeRendering="crispEdges" style={{ display: 'block' }}>
        <rect x={0} y={0} width={w} height={h} fill={bg} />
        {pv.enumChoices.map((label, i) => {
          const on = i === value;
          const top = pitch * i;
          const iy = top + indTop;
          return (
            <g key={i}>
              <path d={pixels(ring.topLeft, 3, iy)} fill={on ? bs : ts} />
              <path d={pixels(ring.bottomRight, 3, iy)} fill={on ? ts : bs} />
              <rect x={5} y={iy + 2} width={box - 4} height={box - 4} fill={on ? select : button} />
              {on ? (
                <path
                  d={CHECK.flatMap((row, r) =>
                    [...row].map((c, k) => (c === '#' ? `M${5 + k} ${iy + 2 + r}h1v1h-1z` : ''))
                  ).join('')}
                  fill={fgSel}
                />
              ) : null}
              <TextRun
                font={font}
                text={label}
                x={textX}
                y={top + 4 + font.ascent}
                fill={on ? fgSel : fgStatic}
              />
            </g>
          );
        })}
      </svg>
      {pv.enumChoices.map((label, i) => (
        <div
          key={i}
          role="radio"
          aria-checked={i === value}
          aria-label={label}
          onMouseDown={(e) => {
            if (e.button !== 0 || !writable || i === value) return;
            put(controlPv, i);
          }}
          style={{
            position: 'absolute',
            left: 0,
            top: pitch * i,
            width: w,
            height: pitch,
            cursor: writable ? 'default' : 'not-allowed',
          }}
        />
      ))}
    </div>
  );
}
