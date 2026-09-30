// Primitives shared by EDM's button-like classes (related display, exit,
// shell command, message button, button, menu button, choice button): X line
// rasterisation, the 3-D bevels, the centred label and the hover ring.
//
// EDM draws these with XDrawLine on a width-1 GC. The X server paints such a
// line from its smaller coordinate up to, but not including, its larger end
// (checked against EDM screenshots: the (x+w-2, y+h-2) pixel of a raised
// button stays face-coloured), so every line here is "start .. end-1".

import { useState } from 'react';
import type { CSSProperties, MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import type { EdmFont } from '../config/fonts.js';
import { textWidth } from '../config/fonts.js';
import { useEdmScreen } from '../screen/context.js';
import { TextRun, idiv } from './shared.js';

/** An XDrawLine between two points on one row or column, in colour `c`. */
export type XLine = readonly [
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  c: string | undefined,
];

/** The pixels X paints for axis-aligned width-1 lines, as 1-px rectangles. */
export function XLines({ lines }: { lines: readonly XLine[] }) {
  return (
    <>
      {lines.map(([x1, y1, x2, y2, c], i) => {
        if (!c) return null;
        if (y1 === y2) {
          const a = Math.min(x1, x2);
          const n = Math.abs(x2 - x1);
          return n > 0 ? <rect key={i} x={a} y={y1} width={n} height={1} fill={c} /> : null;
        }
        const a = Math.min(y1, y2);
        const n = Math.abs(y2 - y1);
        return n > 0 ? <rect key={i} x={x1} y={a} width={1} height={n} fill={c} /> : null;
      })}
    </>
  );
}

/**
 * EDM's standard raised button bevel on a (w+1) x (h+1) footprint: a 1-px
 * outer ring in the *opposite* sense (bottom shadow on top/left, top shadow
 * on bottom/right) and two raised rings inside it.
 */
export function raisedBevel(
  x: number,
  y: number,
  w: number,
  h: number,
  top: string | undefined,
  bot: string | undefined
): XLine[] {
  const R = x + w;
  const B = y + h;
  return [
    [x, y, R, y, bot],
    [x, y, x, B, bot],
    [x, B, R, B, top],
    [R, y, R, B, top],
    [x + 1, y + 1, R - 1, y + 1, top],
    [x + 2, y + 2, R - 2, y + 2, top],
    [x + 1, y + 1, x + 1, B - 1, top],
    [x + 2, y + 2, x + 2, B - 2, top],
    [x + 1, B - 1, R - 1, B - 1, bot],
    [x + 2, B - 2, R - 2, B - 2, bot],
    [R - 1, y + 1, R - 1, B - 1, bot],
    [R - 2, y + 2, R - 2, B - 2, bot],
  ];
}

/** The face EDM paints under a button: XFillRectangle + XDrawRectangle in one colour. */
export function Face({
  x,
  y,
  w,
  h,
  color,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  color: string | undefined;
}) {
  return <rect x={x} y={y} width={w + 1} height={h + 1} fill={color} />;
}

/**
 * drawText(…, XmALIGNMENT_CENTER): one line centred on tX, its top at tY
 * (baseline tY + ascent), clipped to `clip` (x, y, w, h).
 */
export function CentredLabel({
  font,
  text,
  tX,
  tY,
  fill,
  clip,
}: {
  font: EdmFont;
  text: string;
  tX: number;
  tY: number;
  fill: string | undefined;
  clip: readonly [number, number, number, number];
}) {
  if (!text) return null;
  const [cx, cy, cw, ch] = clip;
  if (cw <= 0 || ch <= 0) return null;
  return (
    <svg x={cx} y={cy} width={cw} height={ch} viewBox={`${cx} ${cy} ${cw} ${ch}`} overflow="hidden">
      <TextRun
        font={font}
        text={text}
        x={tX - idiv(textWidth(font, text), 2)}
        y={tY + font.ascent}
        fill={fill}
      />
    </svg>
  );
}

export interface HotspotProps {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly cls: string;
  /** False: the object draws but takes no pointer input (EDM requests no focus). */
  readonly active?: boolean;
  /** EDM's "no" cursor: the control PV refuses writes. */
  readonly denied?: boolean;
  readonly title?: string;
  readonly cursor?: CSSProperties['cursor'];
  readonly onPress?: (e: ReactMouseEvent) => void;
  readonly onRelease?: (e: ReactMouseEvent) => void;
  readonly children?: ReactNode;
}

/**
 * The pointer target of a button-like object. EDM's hit test is the strict
 * interior (x < px < x+w); on hover it draws a 2-px rectangle in the
 * display's foreground colour just outside the object.
 */
export function Hotspot({
  x,
  y,
  w,
  h,
  cls,
  active = true,
  denied,
  title,
  cursor,
  onPress,
  onRelease,
  children,
}: HotspotProps) {
  const { displayFg } = useEdmScreen();
  const [hover, setHover] = useState(false);
  if (!active) return null;
  return (
    <>
      {hover ? (
        <div
          data-edm-hover={cls}
          style={{
            position: 'absolute',
            left: x - 3,
            top: y - 3,
            width: w + 6,
            height: h + 6,
            boxSizing: 'border-box',
            border: `2px solid ${displayFg}`,
            pointerEvents: 'none',
          }}
        />
      ) : null}
      <div
        role="button"
        data-edm-class={cls}
        title={title}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onMouseDown={onPress}
        onMouseUp={onRelease}
        onContextMenu={(e) => e.preventDefault()}
        style={{
          position: 'absolute',
          left: x + 1,
          top: y + 1,
          width: Math.max(0, w - 1),
          height: Math.max(0, h - 1),
          cursor: denied ? 'not-allowed' : (cursor ?? 'default'),
          pointerEvents: 'auto',
        }}
      >
        {children}
      </div>
    </>
  );
}

export interface MenuItem {
  readonly label: string;
  readonly onSelect: () => void;
}

/**
 * A Motif-style popup menu at a pointer position (menu button states, related
 * display and shell command lists). Fixed-positioned so the display's clip
 * does not cut it; any click outside closes it.
 */
export function PopupMenu({
  at,
  items,
  onClose,
}: {
  at: { x: number; y: number };
  items: readonly MenuItem[];
  onClose: () => void;
}) {
  return (
    <>
      <div
        onMouseDown={onClose}
        onContextMenu={(e) => e.preventDefault()}
        style={{ position: 'fixed', inset: 0, zIndex: 1000, pointerEvents: 'auto' }}
      />
      <div
        role="menu"
        data-edm-menu=""
        style={{
          position: 'fixed',
          left: at.x,
          top: at.y,
          zIndex: 1001,
          background: '#c8c8c8',
          borderStyle: 'solid',
          borderWidth: 2,
          borderColor: '#ececec #5a5a5a #5a5a5a #ececec',
          font: "12px Arimo, 'Liberation Sans', Helvetica, Arial, sans-serif",
          color: '#000000',
          pointerEvents: 'auto',
          cursor: 'default',
          whiteSpace: 'pre',
        }}
      >
        {items.map((it, i) => (
          <div
            key={i}
            role="menuitem"
            onMouseDown={(e) => e.stopPropagation()}
            onMouseUp={() => {
              onClose();
              it.onSelect();
            }}
            style={{ padding: '3px 10px', minHeight: 14 }}
            onMouseEnter={(e) => (e.currentTarget.style.background = '#d8d8d8')}
            onMouseLeave={(e) => (e.currentTarget.style.background = '')}
          >
            {it.label || ' '}
          </div>
        ))}
      </div>
    </>
  );
}
