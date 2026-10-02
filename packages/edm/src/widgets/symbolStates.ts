// How EDM's symbol classes turn a symbol file into states (edmlib/symbol.cc):
// each top-level group is a state; its members are moved so the group's box
// starts at the symbol's x, y; then resized to the symbol's w x h (each box
// scaled about x, y with half-up rounding; lines rescale their points) and
// rotated or flipped about the box centre. Written from that behaviour; no
// EDM code is copied.

import type { EdmBlock, EdmDocument, EdmObject, EdmProps } from '../model.js';
import { propInt, propIntList, propNum } from '../model.js';

export interface SymbolStates {
  readonly states: readonly (readonly EdmObject[])[];
  readonly w: number;
  readonly h: number;
  /** False when the file was missing or its first object was not a group. */
  readonly ok: boolean;
}

type Box = { x: number; y: number; w: number; h: number };

const box = (o: EdmObject): Box => ({
  x: propInt(o.props, 'x', 0),
  y: propInt(o.props, 'y', 0),
  w: propInt(o.props, 'w', 0),
  h: propInt(o.props, 'h', 0),
});

function withProps(o: EdmObject, set: Record<string, string | EdmBlock>): EdmObject {
  return { ...o, props: { ...o.props, ...set } as EdmProps };
}

const pointsBlock = (vs: readonly number[]): EdmBlock => ({
  lines: vs.map((v, i) => `${i} ${v}`),
});

/** Move an object (and its points and members) by dx, dy. */
export function moveObject(o: EdmObject, dx: number, dy: number): EdmObject {
  const b = box(o);
  const set: Record<string, string | EdmBlock> = { x: `${b.x + dx}`, y: `${b.y + dy}` };
  if (o.props.xPoints)
    set.xPoints = pointsBlock(propIntList(o.props, 'xPoints').map((v) => v + dx));
  if (o.props.yPoints)
    set.yPoints = pointsBlock(propIntList(o.props, 'yPoints').map((v) => v + dy));
  const out = withProps(o, set);
  return o.children ? { ...out, children: o.children.map((c) => moveObject(c, dx, dy)) } : out;
}

/** Scale an object's box about (x0, y0): new = x0 + trunc((c - x0) * s + 0.5), size trunc(size * s + 0.5). */
export function resizeObject(
  o: EdmObject,
  x0: number,
  y0: number,
  sx: number,
  sy: number
): EdmObject {
  const b = box(o);
  const nx = x0 + Math.trunc((b.x - x0) * sx + 0.5);
  const ny = y0 + Math.trunc((b.y - y0) * sy + 0.5);
  const nw = Math.trunc(b.w * sx + 0.5);
  const nh = Math.trunc(b.h * sy + 0.5);
  const set: Record<string, string | EdmBlock> = { x: `${nx}`, y: `${ny}`, w: `${nw}`, h: `${nh}` };
  if (o.props.xPoints) {
    const fx = b.w ? nw / b.w : 1;
    set.xPoints = pointsBlock(
      propIntList(o.props, 'xPoints').map((v) => nx + Math.trunc((v - b.x) * fx + 0.5))
    );
  }
  if (o.props.yPoints) {
    const fy = b.h ? nh / b.h : 1;
    set.yPoints = pointsBlock(
      propIntList(o.props, 'yPoints').map((v) => ny + Math.trunc((v - b.y) * fy + 0.5))
    );
  }
  const out = withProps(o, set);
  return o.children
    ? { ...out, children: o.children.map((c) => resizeObject(c, x0, y0, sx, sy)) }
    : out;
}

export type SymbolOrientation = 'original' | 'rotateCW' | 'rotateCCW' | 'FlipV' | 'FlipH';

/** Rotate or flip an object about (xo, yo): boxes, line points, arc angles, members. */
export function orientObject(
  o: EdmObject,
  how: SymbolOrientation,
  xo: number,
  yo: number
): EdmObject {
  if (how === 'original') return o;
  const b = box(o);
  let nb: Box;
  let pt: (px: number, py: number) => [number, number];
  if (how === 'rotateCW') {
    nb = { x: xo + yo - b.y - b.h, y: yo - xo + b.x, w: b.h, h: b.w };
    pt = (px, py) => [xo + yo - py, yo - xo + px];
  } else if (how === 'rotateCCW') {
    nb = { x: xo - yo + b.y, y: xo + yo - b.x - b.w, w: b.h, h: b.w };
    pt = (px, py) => [xo - yo + py, xo + yo - px];
  } else if (how === 'FlipH') {
    nb = { ...b, x: 2 * xo - b.x - b.w };
    pt = (px, py) => [2 * xo - px, py];
  } else {
    nb = { ...b, y: 2 * yo - b.y - b.h };
    pt = (px, py) => [px, 2 * yo - py];
  }
  const set: Record<string, string | EdmBlock> = {
    x: `${nb.x}`,
    y: `${nb.y}`,
    w: `${nb.w}`,
    h: `${nb.h}`,
  };
  if (o.props.xPoints && o.props.yPoints) {
    const xs = propIntList(o.props, 'xPoints');
    const ys = propIntList(o.props, 'yPoints');
    const ps = xs.map((px, i) => pt(px, ys[i] ?? 0));
    set.xPoints = pointsBlock(ps.map((q) => q[0]));
    set.yPoints = pointsBlock(ps.map((q) => q[1]));
  }
  if (o.className === 'activeArcClass') {
    const start = propNum(o.props, 'startAngle', 0);
    const total = propNum(o.props, 'totalAngle', 180);
    const ns =
      how === 'rotateCW'
        ? start - 90
        : how === 'rotateCCW'
          ? start + 90
          : how === 'FlipH'
            ? 180 - start - total
            : -start - total;
    set.startAngle = `${ns}`;
  }
  const out = withProps(o, set);
  return o.children
    ? { ...out, children: o.children.map((c) => orientObject(c, how, xo, yo)) }
    : out;
}

/** The states of a symbol file placed at the symbol's box. */
export function symbolStates(
  doc: EdmDocument | null,
  at: Box,
  numStates: number,
  useOriginalSize: boolean,
  orientation: SymbolOrientation
): SymbolStates {
  const n = Math.min(64, Math.max(1, numStates));
  if (!doc) return { states: [], w: at.w, h: at.h, ok: false };
  const states: EdmObject[][] = [];
  let maxW = 0;
  let maxH = 0;
  let ok = true;
  for (let i = 0; i < n; i++) {
    const grp = doc.objects[i];
    if (!grp) {
      if (i === 0) ok = false;
      else states.push([]); // one extra empty state
      break;
    }
    if (grp.className !== 'activeGroupClass') {
      if (i === 0) ok = false;
      break;
    }
    const gb = box(grp);
    maxW = Math.max(maxW, gb.w);
    maxH = Math.max(maxH, gb.h);
    states.push((grp.children ?? []).map((c) => moveObject(c, at.x - gb.x, at.y - gb.y)));
  }
  if (!ok) return { states, w: at.w, h: at.h, ok };
  let w = maxW;
  let h = maxH;
  let out: EdmObject[][] = states;
  if (!useOriginalSize && (at.w !== maxW || at.h !== maxH) && maxW > 0 && maxH > 0) {
    const sx = at.w / maxW;
    const sy = at.h / maxH;
    out = out.map((s) => s.map((c) => resizeObject(c, at.x, at.y, sx, sy)));
    w = at.w;
    h = at.h;
  }
  if (orientation !== 'original') {
    const xo = at.x + Math.trunc(w / 2);
    const yo = at.y + Math.trunc(h / 2);
    out = out.map((s) => s.map((c) => orientObject(c, orientation, xo, yo)));
    if (orientation === 'rotateCW' || orientation === 'rotateCCW') [w, h] = [h, w];
  }
  return { states: out, w, h, ok };
}
