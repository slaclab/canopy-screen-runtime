// Images: activePngClass (pnglib/png.cc), the GIF class
// cfcf6c8a_dbeb_11d2_8a97_00104b8742df (giflib/gif.cc) and
// TwoDProfileMonitorClass (videowidget/TwoDProfileMonitor.cc). Behaviour
// matches those files; written from that behaviour, no EDM code is copied.
//
//   - PNG and GIF: the file is found on the display search path (".png" /
//     ".gif" added when the name has no extension), drawn 1:1 at x, y at its
//     own size (the w/h tags are ignored), opaque: transparent pixels show the
//     display's background colour, not what lies underneath. A missing file
//     draws nothing. GIF: the global colour table only, every component's
//     lowest bit cleared, and the LAST table entry is the transparent one
//     (the file's declared transparent index is ignored).
//   - TwoDProfileMonitor: a black w x h image from the start; a waveform of
//     grey levels (nBitsPerPixel significant bits) fitted into it with its
//     aspect kept, centred, nearest-neighbour sampled; width (and height) from
//     dataWidth or, with pvBasedDataSize, from PVs; implausible sizes leave the
//     previous image.

import { useEffect, useRef, useState } from 'react';
import { firstColor } from '../config/colors.js';
import { propInt, propStr } from '../model.js';
import { useEdmPv, useEdmScreen, useExpanded } from '../screen/context.js';
import { decodeGif } from './gif.js';
import type { GifImage } from './gif.js';
import type { EdmWidgetProps } from './registry.js';
import { geom, pvProp } from './shared.js';

/** EDM adds the class's extension when the name has none after its last '/'. */
export function imageName(file: string, ext: string): string {
  const base = file.slice(file.lastIndexOf('/') + 1);
  return base.includes('.') ? file : `${file}${ext}`;
}

/** The URL of an image named by an object, found from the displayed screen as EDM does. */
function useImageUrl(file: string | undefined, ext: string): string | null {
  const { source, ancestors, path } = useEdmScreen();
  const name = useExpanded(file ?? '')?.trim() ?? '';
  if (!name || !source) return null;
  return source.url(imageName(name, ext), ancestors[0] ?? path);
}

export function PngImage({ obj }: EdmWidgetProps) {
  const { displayBg } = useEdmScreen();
  const { x, y } = geom(obj.props);
  const url = useImageUrl(propStr(obj.props, 'file'), '.png');
  const [failed, setFailed] = useState<string | null>(null);
  if (!url || failed === url) return null;
  return (
    <div
      data-edm-class="activePngClass"
      style={{
        position: 'absolute',
        left: x,
        top: y,
        lineHeight: 0,
        background: displayBg,
        pointerEvents: 'none',
      }}
    >
      <img
        src={url}
        alt=""
        onError={() => setFailed(url)}
        style={{ display: 'block', imageRendering: 'pixelated' }}
      />
    </div>
  );
}

function rgbOf(css: string): [number, number, number] {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(firstColor(css));
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [0, 0, 0];
}

export function GifImageView({ obj }: EdmWidgetProps) {
  const { displayBg } = useEdmScreen();
  const { x, y } = geom(obj.props);
  const url = useImageUrl(propStr(obj.props, 'file'), '.gif');
  const [img, setImg] = useState<{ url: string; gif: GifImage } | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    fetch(url)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((b) => decodeGif(new Uint8Array(b)))
      .then(
        (gif) => !cancelled && gif.palette.length > 0 && setImg({ url, gif }),
        () => {}
      );
    return () => {
      cancelled = true;
    };
  }, [url]);
  const gif = img && img.url === url ? img.gif : null;
  useEffect(() => {
    const c = canvas.current;
    const ctx = c?.getContext('2d');
    if (!gif || !ctx) return;
    const bg = rgbOf(displayBg);
    const last = gif.palette.length - 1;
    const data = ctx.createImageData(gif.width, gif.height);
    for (let i = 0; i < gif.indices.length; i++) {
      const k = gif.indices[i];
      const [r, g, b] = k === last ? bg : (gif.palette[k] ?? [0, 0, 0]).map((v) => v & 0xfe);
      data.data.set([r, g, b, 255], i * 4);
    }
    ctx.putImageData(data, 0, 0);
  }, [gif, displayBg]);
  if (!gif) return null;
  return (
    <canvas
      ref={canvas}
      data-edm-class="cfcf6c8a_dbeb_11d2_8a97_00104b8742df"
      width={gif.width}
      height={gif.height}
      style={{ position: 'absolute', left: x, top: y, pointerEvents: 'none' }}
    />
  );
}

const TWOD = 'TwoDProfileMonitorClass';

/** Grey levels of a TwoDProfileMonitor frame in a w x h buffer (null: keep the previous image). */
export function profileImage(
  values: readonly number[],
  width: number,
  height: number,
  nbits: number,
  w: number,
  h: number
): Uint8ClampedArray<ArrayBuffer> | null {
  if (width < 1 || width > 10000 || height < 0 || height > 10000) return null;
  const out = new Uint8ClampedArray(new ArrayBuffer(Math.max(0, w * h * 4)));
  for (let i = 3; i < out.length; i += 4) out[i] = 255;
  const srcW = width;
  const srcH = height > 0 ? height : Math.floor(values.length / width);
  if (srcH <= 0 || w <= 0 || h <= 0) return out;
  const asp = srcW / srcH;
  let dW: number;
  let dH: number;
  if (Math.trunc(h * asp) <= w) {
    dH = h;
    dW = Math.trunc(h * asp);
  } else {
    dW = w;
    dH = Math.trunc(w / asp);
  }
  const ox = Math.min(Math.max(Math.trunc((w - dW) * 0.5), 0), w);
  const oy = Math.min(Math.max(Math.trunc((h - dH) * 0.5), 0), h);
  const sxInc = srcW / dW;
  const syInc = srcH / dH;
  const maxIdx = srcW * srcH - 1;
  const shift = Math.max(0, nbits - 8);
  let ay = 0;
  for (let r = oy; r < Math.min(oy + dH, h); r++, ay += syInc) {
    let ax = 0;
    for (let c = ox; c < Math.min(ox + dW, w); c++, ax += sxInc) {
      const idx = Math.min(Math.floor(ax) + Math.floor(ay) * srcW, maxIdx);
      let d = values[idx] ?? 0;
      if (d < 0) d += 2 ** nbits;
      const g = Math.min(255, Math.trunc(d) >> shift);
      out.set([g, g, g], (r * w + c) * 4);
    }
  }
  return out;
}

export function TwoDProfileMonitor({ obj }: EdmWidgetProps) {
  const p = obj.props;
  const { x, y, w, h } = geom(p);
  const pvBased = propInt(p, 'pvBasedDataSize', 0) !== 0;
  const dataPv = pvProp(p, 'dataPvStr');
  const widthPv = pvBased && dataPv ? pvProp(p, 'widthPvStr') : undefined;
  const heightPv = widthPv ? pvProp(p, 'heightPvStr') : undefined;
  const data = useEdmPv(dataPv, `${TWOD}.dataPvStr`);
  const wd = useEdmPv(widthPv, `${TWOD}.widthPvStr`);
  const hd = useEdmPv(heightPv, `${TWOD}.heightPvStr`);
  const canvas = useRef<HTMLCanvasElement>(null);
  const width = pvBased ? (wd?.connected ? Math.trunc(wd.num) : 0) : propInt(p, 'dataWidth', -1);
  const height = pvBased && hd?.connected ? Math.trunc(hd.num) : 0;
  const nbits = propInt(p, 'nBitsPerPixel', 8);
  const values = data?.connected ? data.values : undefined;
  useEffect(() => {
    const ctx = canvas.current?.getContext('2d');
    if (!ctx || w <= 0 || h <= 0) return;
    if (!values) {
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, w, h);
      return;
    }
    const px = profileImage(values, width, height, nbits, w, h);
    if (px) ctx.putImageData(new ImageData(px, w, h), 0, 0);
  }, [values, width, height, nbits, w, h]);
  return (
    <canvas
      ref={canvas}
      data-edm-class={TWOD}
      width={Math.max(0, w)}
      height={Math.max(0, h)}
      style={{
        position: 'absolute',
        left: x,
        top: y,
        background: '#000000',
        pointerEvents: 'none',
      }}
    />
  );
}
