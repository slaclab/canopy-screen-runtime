import { AlarmSeverity } from '@slaclab/canopy-client';
import { describe, expect, it } from 'vitest';
import { EdmPalette, firstColor, parseColorSpec } from './colors.js';
import { cssFont, resolveFont, textWidth } from './fonts.js';
import { motifShadows } from './motif.js';

const COLORS = `4 0 0

blinkms=750
max=0x10000

alias trace0 red-21

static 0   "Disconn/Invalid"  { 65535 65535 65535 }    #0 white
static 8   "grey-8"           { 34181 34181 34181 }    #
static 14  "black-14"         {     0     0     0 }
static 20  "Monitor: MAJOR"   { 65535     0     0 }
static 21  "red-21"           { 57568     0     0 }
static 35  "Monitor: MINOR"   { 65535 65535     0 }
static 41  "orange-41"        { 57568 39578 21588 }    # a "quoted" comment
static 80  "invisible"        {     0     0     0 }
static 81  "red-blink"        { 65535     0     0 32762     0     0 }

rule 84 alarm {
 = -1 	: "orange-41"
 = 2 	: "Monitor: MAJOR"
 = 1 	: "Monitor: MINOR"
}
rule 99 tri {
 >=1 && < 3 : "red-21"
 > 4  : "invisible"
 default : "grey-8"
}

alarm {
  disconnected : "Disconn/Invalid"
  invalid      : "Disconn/Invalid"
  minor        : "Monitor: MINOR"
  major        : "Monitor: MAJOR"
  noalarm      : *
}
`;

describe('EdmPalette', () => {
  const p = EdmPalette.parse(COLORS);

  it('reads statics with the high-byte 16→8 bit mapping, blink and aliases', () => {
    expect(p.css(8)).toBe('#858585');
    expect(p.css(41)).toBe('#e09a54');
    expect(p.statics.get(81)?.blinkCss).toBe('#7f0000');
    expect(p.cssByName('trace0')).toBe('#e00000');
    expect(p.blinkMs).toBe(750);
    expect(p.issues).toEqual([]);
  });

  it('gives blinking statics a custom property the screen switches', () => {
    expect(p.css(81)).toBe('var(--edm-blink-81, #ff0000)');
    expect(firstColor(p.css(81))).toBe('#ff0000');
    expect(p.blinking()).toContainEqual({ prop: '--edm-blink-81', on: '#ff0000', off: '#7f0000' });
  });

  it('evaluates rules: first match wins, else the first result', () => {
    expect(p.css(84, 2)).toBe('#ff0000');
    expect(p.css(84, 1)).toBe('#ffff00');
    expect(p.css(84, 7)).toBe('#e09a54'); // no match -> first result
    expect(p.css(84)).toBe('#e09a54'); // no value -> static fallback
    expect(p.css(99, 2)).toBe('#e00000');
    expect(p.css(99, 3)).toBe('#858585');
    expect(p.isInvisible({ kind: 'index', index: 99 }, 5)).toBe(true);
    expect(p.isInvisible({ kind: 'index', index: 99 }, 1)).toBe(false);
  });

  it('reads the alarm block; noalarm keeps the widget colour', () => {
    expect(p.alarm[AlarmSeverity.MAJOR]).toBe('#ff0000');
    expect(p.alarm[AlarmSeverity.MINOR]).toBe('#ffff00');
    expect(p.alarm[AlarmSeverity.DISCONNECTED]).toBe('#ffffff');
    expect(p.alarm[AlarmSeverity.NO_ALARM]).toBeNull();
  });

  it('paints undefined indices in the invalid colour', () => {
    expect(p.css(200)).toBe('#ffffff');
  });
});

describe('parseColorSpec', () => {
  it('reads index and rgb specs', () => {
    expect(parseColorSpec('index 14')).toEqual({ kind: 'index', index: 14 });
    expect(parseColorSpec('rgb 65535 32896 0')).toEqual({ kind: 'rgb', css: '#ff8000' });
    expect(parseColorSpec('nonsense')).toBeUndefined();
  });
});

describe('fonts', () => {
  it('maps EDM tags to web fonts with the X bitmap metrics', () => {
    const f = resolveFont('helvetica-bold-r-14.0');
    // the X bitmap font itself as a pixel-outline web font, then the outline clone
    expect(f.family).toBe(
      "'edm helvetica-bold-r-14.0', Arimo, 'Liberation Sans', Helvetica, Arial, sans-serif"
    );
    expect(f.bitmap).toBe(true);
    expect(cssFont(f)).toMatch(/^bold 14px 'edm helvetica-bold-r-14\.0', Arimo/);
    expect(f.weight).toBe('bold');
    expect(f.style).toBe('normal');
    expect([f.sizePx, f.ascent, f.descent, f.maxAscent]).toEqual([14, 13, 3, 14]);
    expect(f.fallback).toBe(false);
    // Adobe helvetica medium 12: "SIOC" advances
    expect(textWidth(resolveFont('helvetica-medium-r-12.0'), 'SIOC')).toBe(
      [...'SIOC'].reduce(
        (w, c) => w + resolveFont('helvetica-medium-r-12.0').widths[c.charCodeAt(0)],
        0
      )
    );
    expect(resolveFont('courier-medium-r-12.0').family).toMatch(
      /^'edm courier-medium-r-12\.0', Cousine/
    );
    // a size the X server scales has no bitmap font: outline family only
    expect(resolveFont('helvetica-medium-r-72.0').bitmap).toBe(false);
    expect(resolveFont('helvetica-medium-r-72.0').family).toMatch(/^Arimo/);
    expect(resolveFont('courier-medium-r-12.0').widths[65]).toBe(7);
  });

  it('falls back like EDM for fonts the X server lacks', () => {
    const f = resolveFont('utopia-bold-r-18.0');
    expect(f.fallback).toBe(true);
    expect(f.resolvedTag).toBe('helvetica-bold-r-18.0');
    expect(resolveFont(undefined).tag).toBe('helvetica-medium-r-10.0');
  });
});

describe('motifShadows', () => {
  it('matches the bevels EDM text fields show', () => {
    expect(motifShadows('#ffffff')).toEqual({ top: '#cccccc', bottom: '#999999' });
    const mid = motifShadows('#c8c8c8');
    expect(mid.top).toBe('#e8e8e8');
    expect(parseInt(mid.bottom.slice(1, 3), 16)).toBeGreaterThanOrEqual(0x6e);
    expect(parseInt(mid.bottom.slice(1, 3), 16)).toBeLessThanOrEqual(0x6f);
  });
});
