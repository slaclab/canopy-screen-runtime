// A minimal GIF reader for EDM's GIF image class: the logical screen size,
// the global colour table and the first image's colour indices (LZW decoded,
// de-interlaced). EDM ignores local colour tables, animation and the declared
// transparent index, so this reader does too.

export interface GifImage {
  readonly width: number;
  readonly height: number;
  /** Global colour table as [r, g, b] (empty when the file has none). */
  readonly palette: readonly (readonly [number, number, number])[];
  /** Colour index per pixel of the first image, row-major over width x height. */
  readonly indices: Uint8Array;
}

export function decodeGif(buf: Uint8Array): GifImage {
  const sig = String.fromCharCode(...buf.slice(0, 6));
  if (sig !== 'GIF87a' && sig !== 'GIF89a') throw new Error('not a GIF');
  const u16 = (o: number) => buf[o] | (buf[o + 1] << 8);
  const width = u16(6);
  const height = u16(8);
  const packed = buf[10];
  let p = 13;
  const palette: [number, number, number][] = [];
  if (packed & 0x80) {
    const n = 1 << ((packed & 7) + 1);
    for (let i = 0; i < n; i++, p += 3) palette.push([buf[p], buf[p + 1], buf[p + 2]]);
  }
  const indices = new Uint8Array(width * height);
  while (p < buf.length) {
    const block = buf[p++];
    if (block === 0x3b) break;
    if (block === 0x21) {
      p++; // label
      while (p < buf.length && buf[p] !== 0) p += buf[p] + 1;
      p++;
      continue;
    }
    if (block !== 0x2c) break;
    const iw = u16(p + 4);
    const ih = u16(p + 6);
    const ipacked = buf[p + 8];
    p += 9;
    if (ipacked & 0x80) p += 3 * (1 << ((ipacked & 7) + 1));
    const minCode = buf[p++];
    const data: number[] = [];
    while (p < buf.length && buf[p] !== 0) {
      const len = buf[p++];
      for (let i = 0; i < len; i++) data.push(buf[p + i]);
      p += len;
    }
    const pixels = lzw(data, minCode, iw * ih);
    // The image is taken to cover the logical screen from its top-left.
    const rows = ipacked & 0x40 ? interlaceOrder(ih) : [...Array(ih).keys()];
    for (let r = 0; r < ih && r < height; r++) {
      const dest = rows[r];
      if (dest >= height) continue;
      for (let c = 0; c < iw && c < width; c++) indices[dest * width + c] = pixels[r * iw + c] ?? 0;
    }
    break; // only the first image
  }
  return { width, height, palette, indices };
}

function interlaceOrder(h: number): number[] {
  const out: number[] = [];
  for (const [start, step] of [
    [0, 8],
    [4, 8],
    [2, 4],
    [1, 2],
  ]) {
    for (let r = start; r < h; r += step) out.push(r);
  }
  return out;
}

function lzw(data: readonly number[], minCode: number, count: number): Uint8Array {
  const out = new Uint8Array(count);
  const clear = 1 << minCode;
  const end = clear + 1;
  let size = minCode + 1;
  let prefix = new Int32Array(4096);
  let suffix = new Uint8Array(4096);
  const stack = new Uint8Array(4097);
  let next = end + 1;
  let old = -1;
  let first = 0;
  let bits = 0;
  let acc = 0;
  let o = 0;
  let i = 0;
  for (let c = 0; c < clear; c++) {
    prefix[c] = -1;
    suffix[c] = c;
  }
  while (o < count) {
    while (bits < size && i < data.length) {
      acc |= data[i++] << bits;
      bits += 8;
    }
    if (bits < size) break;
    const code = acc & ((1 << size) - 1);
    acc >>>= size;
    bits -= size;
    if (code === clear) {
      size = minCode + 1;
      next = end + 1;
      old = -1;
      prefix = new Int32Array(4096);
      suffix = new Uint8Array(4096);
      for (let c = 0; c < clear; c++) {
        prefix[c] = -1;
        suffix[c] = c;
      }
      continue;
    }
    if (code === end) break;
    let sp = 0;
    let cur = code;
    if (old === -1) {
      out[o++] = suffix[code];
      old = code;
      first = suffix[code];
      continue;
    }
    if (code >= next) {
      stack[sp++] = first;
      cur = old;
    }
    while (cur >= clear && sp < 4096) {
      stack[sp++] = suffix[cur];
      cur = prefix[cur];
    }
    first = suffix[cur];
    stack[sp++] = first;
    while (sp > 0 && o < count) out[o++] = stack[--sp];
    if (next < 4096) {
      prefix[next] = old;
      suffix[next] = first;
      next++;
      if (next === 1 << size && size < 12) size++;
    }
    old = code;
  }
  return out;
}
