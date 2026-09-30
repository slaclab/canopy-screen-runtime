// Number → text exactly as EDM prints it.
//
// cvtDoubleToString is ported from EPICS base libcom/cvtFast.c: Copyright (c)
// 2002 The University of Chicago, as Operator of Argonne National Laboratory;
// Copyright (c) 2002 The Regents of the University of California, as Operator
// of Los Alamos National Laboratory. EPICS BASE is distributed subject to the
// EPICS Open License.
//
//   cvtDoubleToString       EPICS base libcom/cvtFast.c (Textupdate default
//                           mode via pvFactory PVValue::get_string)
//   cvtDoubleToExpString    EPICS base: sprintf("%.*e")
//   expNotation             pvFactory/textupdate.cc localCvtDoubleToExpNotationString
//   cFormat                 the printf subset Text Control builds its format
//                           strings from (x_text_dsp_obj.cc: %[-][w].[p]f|e|g, %[w]d, %[w]X)

/** EPICS cvtDoubleToString. */
export function cvtDoubleToString(value: number, precision: number): string {
  if (Number.isNaN(value) || precision > 8 || value > 1e7 || value < -1e7) {
    if (precision > 8 || value > 1e16 || value < -1e16) {
      const p = Math.min(precision, 17);
      return cFormat(`%${p + 7}.${p}e`, value);
    }
    return cFormat(`%.${Math.min(precision, 3)}f`, value);
  }
  // The fast path: whole part + fraction rounded half up in fixed point.
  const neg = value < 0;
  const v = Math.abs(value);
  let whole = Math.trunc(v);
  const fplace = 10 ** precision;
  let fraction = Math.trunc((v - whole) * fplace * 10);
  fraction = Math.trunc((fraction + 5) / 10);
  if (fraction / fplace >= 1) {
    whole++;
    fraction -= fplace;
  }
  let s = (neg ? '-' : '') + String(whole);
  if (precision > 0) s += '.' + String(fraction).padStart(precision, '0');
  return s;
}

export function cvtDoubleToExpString(value: number, precision: number): string {
  return cFormat(`%.${precision}e`, value);
}

/** Engineering notation: exponent a multiple of 3, mantissa via cvtDoubleToString. */
export function expNotation(value: number, precision: number): string {
  const abs = Math.abs(value);
  if (!Number.isFinite(abs) || abs === 0) return cvtDoubleToExpString(abs, precision);
  let v = abs;
  let exp = 0;
  let sign = '+';
  if (abs < 1) {
    do {
      v *= 1000;
      exp += 3;
    } while (v < 1);
    sign = '-';
  } else {
    while (v >= 1000) {
      v *= 0.001;
      exp += 3;
    }
  }
  const e = String(exp).padStart(2, '0');
  return `${value < 0 ? '-' : ''}${cvtDoubleToString(v, precision)}e${sign}${e}`;
}

/** EPICS cvtLongToHexString: 0x + upper-case hex. */
export function cvtLongToHexString(value: number): string {
  const v = Math.trunc(value);
  return v < 0 ? `-0x${(-v).toString(16).toUpperCase()}` : `0x${v.toString(16).toUpperCase()}`;
}

/**
 * One-conversion C printf: `[prefix]%[flags][width][.prec](f|e|g|d|X|s)`.
 * Enough for every format string EDM's Text Control builds.
 */
export function cFormat(fmt: string, value: number | string): string {
  const m = /^(.*?)%([-+ 0#]*)(\d*)(?:\.(\d*))?([feEgGdiXxs])(.*)$/.exec(fmt);
  if (!m) return String(value);
  const [, pre, flags, widthS, precS, conv, post] = m;
  const left = flags.includes('-');
  const zero = flags.includes('0') && !left;
  const width = widthS ? Number(widthS) : 0;
  const prec = precS === undefined ? undefined : Number(precS || '0');
  let body: string;
  const n = typeof value === 'number' ? value : Number(value);
  switch (conv) {
    case 'f':
      body = fixed(n, prec ?? 6);
      break;
    case 'e':
    case 'E':
      body = expC(n, prec ?? 6);
      if (conv === 'E') body = body.toUpperCase();
      break;
    case 'g':
    case 'G':
      body = gC(n, prec ?? 6, flags.includes('#'));
      if (conv === 'G') body = body.toUpperCase();
      break;
    case 'd':
    case 'i':
      body = String(Math.trunc(n));
      break;
    case 'X':
      body = (Math.trunc(n) >>> 0).toString(16).toUpperCase();
      break;
    case 'x':
      body = (Math.trunc(n) >>> 0).toString(16);
      break;
    default:
      body = String(value);
      if (prec !== undefined) body = body.slice(0, prec);
  }
  if (flags.includes('+') && conv !== 's' && !body.startsWith('-')) body = '+' + body;
  if (body.length < width) {
    if (left) body = body.padEnd(width, ' ');
    else if (zero && conv !== 's') {
      const sign = /^[+-]/.test(body) ? body[0] : '';
      body = sign + body.slice(sign.length).padStart(width - sign.length, '0');
    } else body = body.padStart(width, ' ');
  }
  return pre + body + post;
}

function fixed(n: number, p: number): string {
  if (!Number.isFinite(n)) return nonFinite(n);
  return n.toFixed(Math.min(p, 100));
}

function expC(n: number, p: number): string {
  if (!Number.isFinite(n)) return nonFinite(n);
  const s = n.toExponential(Math.min(p, 100));
  // JS: 1.5e+5 → C: 1.5e+05
  return s.replace(/e([+-])(\d)$/, 'e$10$2');
}

function gC(n: number, p: number, alt: boolean): string {
  if (!Number.isFinite(n)) return nonFinite(n);
  const P = p === 0 ? 1 : p;
  if (n === 0) return alt ? (0).toFixed(P - 1) : '0';
  const X = Math.floor(Math.log10(Math.abs(Number(n.toExponential(P - 1)))));
  let s = P > X && X >= -4 ? n.toFixed(P - 1 - X) : expC(n, P - 1);
  if (!alt) {
    // %g drops trailing zeros of the fraction, and a bare point
    const [mant, exp] = s.split('e');
    const m = mant.includes('.') ? mant.replace(/0+$/, '').replace(/\.$/, '') : mant;
    s = exp === undefined ? m : `${m}e${exp}`;
  }
  return s;
}

const nonFinite = (n: number) => (Number.isNaN(n) ? 'nan' : n > 0 ? 'inf' : '-inf');
