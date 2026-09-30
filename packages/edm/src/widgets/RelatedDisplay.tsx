// relatedDisplayClass. Look matches EDM's baselib/related_display.cc
// drawActive: bgColor box, a 1-px frame (botShadow top/left, topShadow
// bottom/right) with a 2-px raised bevel inside it, the label centred at
// x + w/2 with its top at y + h/2 - ascent/2, clipped to the object; `icon`
// adds EDM's two-window glyph. `invisible` objects draw nothing but stay
// clickable (hotspots over schematics). colorPv evaluates colour rules.
// Written from that behaviour; no EDM code is copied.

import type { ReactNode } from 'react';
import { resolveFont, textWidth } from '../config/fonts.js';
import { expandMacros, parseMacroString } from '../macros.js';
import { propBool, propIndexedInts, propIndexedStrings, propInt, propStr } from '../model.js';
import { useEdmPv, useEdmScreen, useExpanded } from '../screen/context.js';
import type { EdmWidgetProps } from './registry.js';
import { SvgBox, TextRun, colorSpec, geom, idiv } from './shared.js';

const CLS = 'relatedDisplayClass';

export function RelatedDisplay({ obj }: EdmWidgetProps) {
  const env = useEdmScreen();
  const { palette } = env;
  const p = obj.props;
  const g = geom(p);
  const cpv = useEdmPv(propStr(p, 'colorPv'), `${CLS}.colorPv`);
  const label = useExpanded(propStr(p, 'buttonLabel') ?? '') ?? '';
  const files = propIndexedStrings(p, 'displayFileName');
  const labels = propIndexedStrings(p, 'menuLabel');
  const symbols = propIndexedStrings(p, 'symbols');
  const propagate = propIndexedInts(p, 'propagateMacros');
  const closeAction = propIndexedInts(p, 'closeAction');
  const n = Math.min(propInt(p, 'numDsps', files.length), files.length);
  const targets: { file: string; label: string; i: number }[] = [];
  for (let i = 0; i < n; i++) {
    const f = files[i];
    if (f?.trim()) targets.push({ file: f.trim(), label: labels[i] ?? f, i });
  }

  const open = (t: { file: string; i: number }) => {
    const own = parseMacroString(expandMacros(symbols[t.i] ?? '', env.macros));
    const macros = (propagate[t.i] ?? 1) ? { ...env.macros, ...own } : own;
    env.openDisplay?.({
      file: expandMacros(t.file, env.macros),
      fromPath: env.path,
      macros,
      replace: (closeAction[t.i] ?? 0) !== 0,
    });
  };

  const hotspot = (
    <div
      role="link"
      data-edm-class={CLS}
      title={targets.map((t) => t.label).join('\n') || undefined}
      onClick={targets.length ? () => open(targets[0]) : undefined}
      style={{
        position: 'absolute',
        left: g.x,
        top: g.y,
        width: g.w + 1,
        height: g.h + 1,
        cursor: targets.length ? 'pointer' : 'default',
        pointerEvents: targets.length ? 'auto' : 'none',
      }}
    />
  );
  if (propBool(p, 'invisible')) return hotspot;

  const font = resolveFont(propStr(p, 'font'));
  const fg = palette.spec(colorSpec(p, 'fgColor'), cpv?.num);
  const bg = palette.spec(colorSpec(p, 'bgColor'), cpv?.num);
  const ts = palette.spec(colorSpec(p, 'topShadowColor'));
  const bs = palette.spec(colorSpec(p, 'botShadowColor'));
  const { x, y, w, h } = g;
  // Pixel rows/columns of the frame and bevel, as 1-px rectangles.
  const px = (x0: number, y0: number, x1: number, y1: number, c: string | undefined, k: string) =>
    x1 < x0 || y1 < y0 ? null : (
      <rect key={k} x={x0} y={y0} width={x1 - x0 + 1} height={y1 - y0 + 1} fill={c} />
    );
  const icon = propBool(p, 'icon');
  const asc = font.ascent;

  let text: ReactNode = null;
  if (label.trim()) {
    if (!icon) {
      const sw = textWidth(font, label);
      text = (
        <TextRun
          font={font}
          text={label}
          x={x + idiv(w, 2) - idiv(sw, 2)}
          y={y + idiv(h, 2) - idiv(asc, 2) + asc}
          fill={fg}
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
      text = (
        <>
          <IconWindows
            cx={cx}
            cy={cy - ofs}
            back={[cx + 2 * ofs, cy + ofs]}
            size={size}
            fg={fg}
            bg={bg}
          />
          <TextRun font={font} text={label} x={tX} y={tY + asc} fill={fg} />
        </>
      );
    }
  } else if (icon) {
    const min = Math.min(Math.trunc((w * 3) / 5), Math.trunc((h * 3) / 5));
    const cx = x + idiv(w, 2);
    const cy = y + idiv(h, 2);
    const ofs = Math.trunc((min * 2) / 5 + 0.5);
    const size = Math.trunc((min * 3) / 5 - 0.5);
    text = (
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
        {px(x, y, x + w, y + h, bg, 'bg')}
        {px(x, y, x + w, y, bs, 'ft')}
        {px(x, y, x, y + h, bs, 'fl')}
        {px(x, y + h, x + w, y + h, ts, 'fb')}
        {px(x + w, y, x + w, y + h, ts, 'fr')}
        {px(x + 1, y + 1, x + w - 1, y + 1, ts, 't1')}
        {px(x + 2, y + 2, x + w - 2, y + 2, ts, 't2')}
        {px(x + 1, y + 1, x + 1, y + h - 1, ts, 'l1')}
        {px(x + 2, y + 2, x + 2, y + h - 2, ts, 'l2')}
        {px(x + 1, y + h - 1, x + w - 1, y + h - 1, bs, 'b1')}
        {px(x + 2, y + h - 2, x + w - 2, y + h - 2, bs, 'b2')}
        {px(x + w - 1, y + 1, x + w - 1, y + h - 1, bs, 'r1')}
        {px(x + w - 2, y + 2, x + w - 2, y + h - 2, bs, 'r2')}
        <svg
          x={x}
          y={y}
          width={Math.max(0, w)}
          height={Math.max(0, h)}
          viewBox={`${x} ${y} ${Math.max(0, w)} ${Math.max(0, h)}`}
          overflow="hidden"
        >
          {text}
        </svg>
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
