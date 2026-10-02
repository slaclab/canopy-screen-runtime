import { AlarmSeverity } from '@slaclab/canopy-client';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { EdmPalette } from '../config/colors.js';
import { resolveFont, textWidth } from '../config/fonts.js';
import { parseEdl } from '../parser/edl.js';
import { calcConnection } from '../pv/calc.js';
import { EdmPvLayer } from '../pv/layer.js';
import { localConnection } from '../pv/local.js';
import type { EdmPvConnection, EdmPvData, EdmPvListener } from '../pv/types.js';
import { EdmScreen } from '../screen/EdmScreen.js';
import { raisedBevel } from './button.js';
import { registerEdmBuiltins } from './builtins.js';
import { choiceLayout } from './MenuChoice.js';
import { byteBoundaries } from './Shapes.js';
import { mmvMarker } from './Slac.js';
import { slacBarExtent } from './SlacBar.js';
import { messageValue } from './Buttons.js';
import { textControlWrite, textEntryWrite } from './XTextDsp.js';

const PALETTE = EdmPalette.parse(`4 0 0
static 0 "Disconn/Invalid" { 65535 65535 65535 }
static 1 "top" { 60652 60652 60652 }
static 4 "grey-4" { 48059 48059 48059 }
static 11 "bot" { 23130 23130 23130 }
static 14 "black-14" { 0 0 0 }
static 15 "green" { 0 65535 0 }
static 18 "null" { 0 41120 0 }
static 20 "Monitor: MAJOR" { 65535 0 0 }
static 25 "blue" { 0 0 65535 }
static 35 "Monitor: MINOR" { 65535 65535 0 }
alarm { disconnected : "Disconn/Invalid" invalid : "Disconn/Invalid" minor : "Monitor: MINOR" major : "Monitor: MAJOR" noalarm : * }
`);

const pv = (over: Partial<EdmPvData>): EdmPvData => ({
  connected: true,
  type: 'double',
  num: 0,
  text: '',
  severity: AlarmSeverity.NO_ALARM,
  units: '',
  precision: 2,
  enumChoices: [],
  lowerLimit: 0,
  upperLimit: 10,
  writable: true,
  ...over,
});

const ENUM = (num: number, choices = ['Off', 'On', 'Auto']) =>
  pv({ type: 'enum', num, text: choices[num] ?? '', enumChoices: choices, precision: null });

function fakeEpics(initial: Record<string, EdmPvData>) {
  const listeners = new Map<string, Set<EdmPvListener>>();
  const values = new Map(Object.entries(initial));
  const puts: [string, number | string][] = [];
  const conn: EdmPvConnection = {
    subscribe(name, l) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)!.add(l);
      const v = values.get(name);
      if (v) l(v);
      return () => listeners.get(name)!.delete(l);
    },
    put(name, value) {
      puts.push([name, value]);
    },
  };
  const set = (name: string, d: EdmPvData) => {
    values.set(name, d);
    act(() => listeners.get(name)?.forEach((l) => l(d)));
  };
  return { conn, puts, set };
}

function show(objects: string, initial: Record<string, EdmPvData> = {}) {
  const epics = fakeEpics(initial);
  const layer = new EdmPvLayer().register('epics', epics.conn).register('loc', localConnection());
  layer.register('calc', calcConnection(layer, new Map()));
  const closeDisplay = vi.fn();
  const openDisplay = vi.fn();
  render(
    <EdmScreen
      doc={parseEdl(
        `4 0 1\nbeginScreenProperties\nw 400\nh 300\nbgColor index 4\nfgColor index 14\nendScreenProperties\n${objects}`
      )}
      palette={PALETTE}
      pv={layer}
      macros={{ P: 'DEV', KEEP: 'inherited' }}
      path="dir/test.edl"
      openDisplay={openDisplay}
      closeDisplay={closeDisplay}
    />
  );
  return { ...epics, layer, closeDisplay, openDisplay };
}

const obj = (cls: string, props: string) =>
  `object ${cls}\nbeginObjectProperties\nx 10\ny 20\nw 80\nh 30\n${props}\nendObjectProperties\n`;
const COLORS =
  'fgColor index 14\nbgColor index 4\nonColor index 15\noffColor index 4\ninconsistentColor index 25\nselectColor index 25\ntopShadowColor index 1\nbotShadowColor index 11\nfont "helvetica-medium-r-12.0"';
const texts = () => [...document.querySelectorAll('text')].map((t) => t.textContent);
const button = (cls: string) =>
  document.querySelector<HTMLElement>(`[role=button][data-edm-class="${cls}"]`)!;
const fills = () => [...document.querySelectorAll('rect')].map((r) => r.getAttribute('fill'));

beforeAll(() => registerEdmBuiltins());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('button primitives', () => {
  it("bevel lines leave X's far end pixel unpainted", () => {
    render(
      <svg>
        <g data-testid="g">{null}</g>
      </svg>
    );
    const lines = raisedBevel(0, 0, 10, 6, 'T', 'B');
    expect(lines).toHaveLength(12);
    // outer ring inverted: bottom shadow on the top edge, top shadow on the bottom edge
    expect(lines[0]).toEqual([0, 0, 10, 0, 'B']);
    expect(lines[2]).toEqual([0, 6, 10, 6, 'T']);
    // inner rings raised
    expect(lines[4]).toEqual([1, 1, 9, 1, 'T']);
    expect(lines[9]).toEqual([2, 4, 8, 4, 'B']);
  });

  it('lays out choice buttons with 3-px gaps, remainders in the outer gaps', () => {
    expect(choiceLayout(0, 100, 3)).toMatchObject({ pos: [0, 34, 69], size: 31 });
    expect(choiceLayout(5, 60, 2)).toMatchObject({ pos: [5, 37], size: 28 });
    expect(choiceLayout(0, 50, 0).pos).toEqual([]);
  });

  it('splits byte cells in float32 like EDM', () => {
    expect(byteBoundaries(0, 32, 8)).toEqual([0, 4, 8, 12, 16, 20, 24, 28, 32]);
    expect(byteBoundaries(10, 10, 3)).toEqual([10, 13, 16, 20]);
    expect(byteBoundaries(0, 31, 7)[7]).toBe(30); // float32 rounding loses the last pixel
  });
});

describe('exit, shell command, message button, button', () => {
  it('exit button: flat without 3d, literal label, closes on press', () => {
    const { closeDisplay } = show(obj('activeExitButtonClass', `${COLORS}\nlabel "Exit $(P)"`));
    expect(texts()).toEqual(['Exit $(P)']);
    expect(document.querySelectorAll('svg rect')).toHaveLength(1); // face only, no bevel
    fireEvent.mouseDown(button('activeExitButtonClass'));
    expect(closeDisplay).toHaveBeenCalledOnce();
  });

  it('shell command: bevelled, inert, lists its commands', () => {
    show(
      obj(
        'shellCmdClass',
        `${COLORS}\nbuttonLabel "Run $(P)"\nnumCmds 2\ncommandLabel {\n  0 "one"\n}\ncommand {\n  0 "xterm -e $(P)"\n  1 "ls"\n}`
      )
    );
    expect(texts()).toEqual(['Run DEV']);
    const b = button('shellCmdClass');
    expect(b.title).toContain('one: xterm -e DEV');
    expect(b.title).toContain('ls');
    expect(b.style.cursor).toBe('not-allowed');
  });

  it('message button: local pressed state, values converted by PV type', () => {
    const { puts } = show(
      obj(
        'activeMessageButtonClass',
        `${COLORS}\ncontrolPv "$(P):CMD"\npressValue "On"\nreleaseValue "Off"\nonLabel "pressed"\noffLabel "released"\n3d`
      ),
      { 'DEV:CMD': ENUM(0) }
    );
    expect(texts()).toEqual(['released']);
    const b = button('activeMessageButtonClass');
    fireEvent.mouseDown(b, { button: 0 });
    expect(texts()).toEqual(['pressed']);
    fireEvent.mouseUp(b);
    expect(texts()).toEqual(['released']);
    expect(puts).toEqual([
      ['DEV:CMD', 1],
      ['DEV:CMD', 0],
    ]);
    expect(messageValue(pv({ type: 'integer' }), '7.9', false)).toBe(7);
    expect(messageValue(pv({}), '2.5', false)).toBe(2.5);
    expect(messageValue(ENUM(0), 'Nope', false)).toBeNull();
    expect(messageValue(ENUM(0), '2', true)).toBe(2);
    expect(messageValue(pv({ type: 'string' }), '', false)).toBeNull();
  });

  it('button: PV-driven state, pvState labels, toggle writes, inconsistent colour', () => {
    const { puts, set } = show(
      obj('activeButtonClass', `${COLORS}\ncontrolPv "C"\nindicatorPv "R"\n3d`),
      { C: ENUM(0), R: ENUM(0) }
    );
    expect(texts()).toEqual(['Off']);
    expect(fills()[0]).toBe('#bbbbbb'); // offColor
    fireEvent.mouseDown(button('activeButtonClass'), { button: 0 });
    expect(puts).toEqual([['C', 1]]);
    set('C', ENUM(1));
    expect(fills()[0]).toBe('#0000ff'); // control != indicator
    set('R', ENUM(1));
    expect(fills()[0]).toBe('#00ff00');
    expect(texts()).toEqual(['On']);
  });

  it('button: a non-enum PV without a bit position never initialises', () => {
    vi.useFakeTimers();
    show(obj('activeButtonClass', `${COLORS}\ncontrolPv "C"`), { C: pv({ num: 1 }) });
    expect(document.querySelector('svg')).toBeNull();
    act(() => vi.advanceTimersByTime(2100));
    // the unconnected look: a 1-px outline in the disconnected colour
    expect(document.querySelector('svg path')?.getAttribute('fill')).toBe('#ffffff');
  });
});

describe('menu and choice buttons', () => {
  it('menu button: shows the state, opens on release, writes the index', () => {
    const { puts } = show(obj('activeMenuButtonClass', `${COLORS}\ncontrolPv "M"`), { M: ENUM(2) });
    expect(texts()).toEqual(['Auto']);
    const b = button('activeMenuButtonClass');
    fireEvent.mouseDown(b, { button: 0 });
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.mouseUp(b, { button: 0 });
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual([
      'Off',
      'On',
      'Auto',
    ]);
    fireEvent.mouseUp(screen.getAllByRole('menuitem')[1]);
    expect(puts).toEqual([['M', 1]]);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('menu button: "?" for an out-of-range state', () => {
    show(obj('activeMenuButtonClass', `${COLORS}\ncontrolPv "M"`), { M: ENUM(7) });
    expect(texts()).toEqual(['?']);
  });

  it('choice button: one label per state, a press writes the segment index', () => {
    const { puts } = show(
      obj('activeChoiceButtonClass', `${COLORS}\ncontrolPv "M"\norientation "horizontal"`),
      { M: ENUM(1) }
    );
    expect(texts()).toEqual(['Off', 'On', 'Auto']);
    const b = button('activeChoiceButtonClass');
    b.getBoundingClientRect = () => ({ left: 0, top: 0 }) as DOMRect;
    fireEvent.mouseDown(b, { button: 0, clientX: 70, clientY: 5 });
    expect(puts).toEqual([['M', 2]]);
  });
});

describe('connection phase', () => {
  it('draws nothing, then the unconnected box after 2 s, then the object', () => {
    vi.useFakeTimers();
    const { set } = show(
      obj('activeRectangleClass', 'lineColor index 14\nfill\nfillColor index 15\nalarmPv "A"')
    );
    expect(document.querySelector('svg')).toBeNull();
    act(() => vi.advanceTimersByTime(1900));
    expect(document.querySelector('svg')).toBeNull();
    act(() => vi.advanceTimersByTime(200));
    expect(document.querySelector('svg path')?.getAttribute('fill')).toBe('#ffffff');
    set('A', pv({ num: 1 }));
    expect(fills()).toContain('#00ff00');
    // once initialised, a drop repaints the shape in the disconnected colour
    set('A', pv({ connected: false }));
    expect(fills()).toContain('#ffffff');
    expect(fills()).not.toContain('#00ff00');
  });

  it('shows the unconnected box of a member even when its group is hidden', () => {
    vi.useFakeTimers();
    show(
      `object activeGroupClass\nbeginObjectProperties\nx 0\ny 0\nw 100\nh 100\n\nbeginGroup\n\n${obj(
        'activeRectangleClass',
        'lineColor index 14\nalarmPv "A"'
      )}${obj('activeRectangleClass', 'lineColor index 14')}endGroup\n\nvisPv "G"\nvisMin "1"\nvisMax "2"\nendObjectProperties\n`,
      { G: pv({ num: 0 }) }
    );
    act(() => vi.advanceTimersByTime(2100));
    const group = document.querySelector<HTMLElement>('[data-edm-class="activeGroupClass"]')!;
    expect(group.style.visibility).toBe('hidden');
    // the member without PVs inherits the hidden state; the unconnected one opts out
    expect([...group.querySelectorAll('svg')].map((e) => e.style.visibility)).toEqual([
      'visible',
      '',
    ]);
  });
});

describe('text control editing and null colour', () => {
  it('validates typed text by PV type and rejects values outside the display limits', () => {
    const p = parseEdl(`4 0 1\n${obj('activeXTextDspClass', 'clipToDspLimits')}`).objects[0].props;
    expect(textControlWrite(p, pv({}), ' 2.5 ')).toBe(2.5);
    expect(textControlWrite(p, pv({}), '2.5 mA')).toBeNull();
    expect(textControlWrite(p, pv({}), '11')).toBeNull(); // outside 0..10: rejected, not clamped
    expect(textControlWrite(p, pv({ type: 'integer' }), '0x0A')).toBe(10);
    expect(textControlWrite(p, pv({ type: 'integer' }), '1.5')).toBeNull();
    expect(textControlWrite(p, pv({ type: 'string' }), 'any text')).toBe('any text');
    expect(textEntryWrite(undefined, pv({}), '3.2 u')).toBe(3.2);
    expect(textEntryWrite('hex', pv({}), 'ff')).toBe(255);
    expect(textEntryWrite(undefined, ENUM(0), 'On')).toBe('On');
  });

  it('edits in place: Enter writes, the null PV recolours the text', () => {
    const { puts } = show(
      obj(
        'activeXTextDspClass',
        `${COLORS}\ncontrolPv "V"\nnullPv "N"\nnullColor index 18\neditable\nprecision 1`
      ),
      { V: pv({ num: 3 }), N: pv({ num: 3 }) }
    );
    expect(texts()).toEqual(['3.0']);
    expect(document.querySelector('text')?.getAttribute('fill')).toBe('#00a000');
    fireEvent.mouseDown(button('activeXTextDspClass'), { button: 0 });
    const input = document.querySelector<HTMLInputElement>('input[data-edm-edit]')!;
    fireEvent.change(input, { target: { value: 'abc' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(puts).toEqual([]); // not a legal number: nothing written
    fireEvent.mouseDown(button('activeXTextDspClass'), { button: 0 });
    const again = document.querySelector<HTMLInputElement>('input[data-edm-edit]')!;
    fireEvent.change(again, { target: { value: '4.25' } });
    fireEvent.keyDown(again, { key: 'Enter' });
    expect(puts).toEqual([['V', 4.25]]);
  });

  it('prints hex for double channels as EDM does, and waveforms as their first element', () => {
    show(
      obj('activeXTextDspClass', `${COLORS}\ncontrolPv "H"\nformat "hex"\nuseHexPrefix`) +
        obj('activeXTextDspClass', `${COLORS}\ncontrolPv "D"\nprecision 1`),
      { H: pv({ num: 10.73 }), D: pv({ num: 7.624 }) }
    );
    expect(texts()).toEqual(['0xA', '7.6']);
  });

  it('motif field: the alarm border is a 2-px window border outside the widget', () => {
    show(
      obj('activeXTextDspClass', `${COLORS}\ncontrolPv "V"\nmotifWidget\nfgAlarm\nuseAlarmBorder`),
      { V: pv({ num: 3, severity: AlarmSeverity.MAJOR }) }
    );
    const border = document.querySelector('rect')!;
    expect(border.getAttribute('fill')).toBe('#ff0000');
    // the field is as tall as Motif makes it for the font (19 here), not the object's h
    expect([border.getAttribute('width'), border.getAttribute('height')]).toEqual(['84', '23']);
  });

  it('is display-only without `editable`', () => {
    show(obj('activeXTextDspClass', `${COLORS}\ncontrolPv "V"`), { V: pv({ num: 3 }) });
    expect(document.querySelector('[role=button]')).toBeNull();
  });
});

describe('related display', () => {
  const RD = (extra: string) =>
    obj(
      'relatedDisplayClass',
      `${COLORS}\nbuttonLabel "go"\nnumDsps 2\ndisplayFileName {\n  0 "a"\n  1 "b"\n}\nmenuLabel {\n  0 "First"\n  1 "Second"\n}\nsymbols {\n  0 "KEEP=mine,X=1"\n  1 "KEEP=mine"\n}\n${extra}`
    );

  it('opens a menu for several targets; inherited macros win over symbols', () => {
    const { openDisplay } = show(RD(''));
    const b = button('relatedDisplayClass');
    fireEvent.mouseDown(b, { button: 0 });
    expect(openDisplay).not.toHaveBeenCalled();
    fireEvent.mouseUp(b, { button: 0 });
    fireEvent.mouseUp(screen.getByText('First'));
    expect(openDisplay).toHaveBeenCalledWith({
      file: 'a',
      fromPath: 'dir/test.edl',
      macros: { P: 'DEV', KEEP: 'inherited', X: '1' },
      replace: false,
    });
  });

  it('icon buttons halve heights and ascents as C ints (no rounding up)', () => {
    show(
      obj(
        'relatedDisplayClass',
        `${COLORS}\nbuttonLabel "go"\nnumDsps 1\ndisplayFileName {\n  0 "a"\n}\nicon`
      )
    );
    // helvetica 12: ascent 11. top = y + h/2 - 11/2 = 20 + 15 - 5; baseline = top + ascent.
    expect(document.querySelector('text')?.getAttribute('y')).toBe('41');
  });

  it('replaceSymbols passes only the entry symbols', () => {
    const { openDisplay } = show(RD('replaceSymbols {\n  1 1\n}\ncloseAction {\n  1 1\n}'));
    const b = button('relatedDisplayClass');
    fireEvent.mouseUp(b, { button: 0 });
    fireEvent.mouseUp(screen.getByText('Second'));
    expect(openDisplay.mock.calls[0][0]).toMatchObject({
      file: 'b',
      macros: { KEEP: 'mine' },
      replace: true,
    });
  });
});

describe('graphics', () => {
  it('rectangle: a zero-height outline is the line X draws', () => {
    show(
      'object activeRectangleClass\nbeginObjectProperties\nx 10\ny 20\nw 80\nh 0\nlineColor index 14\nendObjectProperties\n'
    );
    expect(document.querySelector('svg path')?.getAttribute('d')).toBe('M10 20H91V21H10Z');
  });

  it('static text: autoSize keeps the centre of the box sized to the raw string', () => {
    show(
      obj(
        'activeXTextClass',
        `${COLORS}\nfontAlign "center"\nuseDisplayBg\nautoSize\nvalue {\n  "$(P) and $(KEEP)"\n}`
      )
    );
    const font = resolveFont('helvetica-medium-r-12.0');
    const loaded = textWidth(font, '$(P) and $(KEEP)');
    const shown = textWidth(font, 'DEV and inherited');
    const svg = screen.getByText('DEV and inherited').closest('svg')!;
    expect(svg.style.left).toBe(`${10 - Math.trunc(shown / 2) + Math.trunc(loaded / 2)}px`);
    expect(svg.getAttribute('width')).toBe(String(shown));
  });

  it("lines: width 1 is X's band around the path, width 0 the thin line with both ends", () => {
    const line = (extra: string) =>
      obj(
        'activeLineClass',
        `lineColor index 14\nfillColor index 4\nnumPoints 2\nxPoints {\n  0 10\n  1 30\n}\nyPoints {\n  0 20\n  1 20\n}\n${extra}`
      );
    show(line('') + line('lineWidth 0'));
    const [band, thin] = [...document.querySelectorAll('polyline')];
    expect(band.getAttribute('points')).toBe('10.46875,20.46875 30.46875,20.46875');
    expect(band.getAttribute('stroke-linecap')).toBe('butt');
    expect(thin.getAttribute('points')).toBe('10.5,20.5 30.5,20.5');
    expect(thin.getAttribute('stroke-linecap')).toBe('square');
  });

  it('byte: cells by bit, on cells in the alarm colour', () => {
    show(
      obj(
        'ByteClass',
        'controlPv "B"\nlineColor index 14\nonColor index 15\noffColor index 4\nnumBits 4'
      ),
      { B: pv({ type: 'integer', num: 0b1010, precision: null, severity: AlarmSeverity.MAJOR }) }
    );
    expect(fills().slice(0, 4)).toEqual(['#ff0000', '#bbbbbb', '#ff0000', '#bbbbbb']);
  });

  it('arc: angles in 1/64 degree, counter-clockwise, only the curve stroked', () => {
    show(
      obj(
        'activeArcClass',
        'lineColor index 14\nfill\nfillColor index 15\nfillMode "pie"\nstartAngle 0\ntotalAngle 90'
      )
    );
    const [fill, stroke] = [...document.querySelectorAll('path')].map((p) => p.getAttribute('d')!);
    // ellipse inscribed in (10,20,80,30): centre (50.5, 35.5), radii 40 x 15
    expect(stroke).toBe('M90.5 35.5A40 15 0 0 0 50.5 20.5');
    expect(fill).toBe('M50.5 35.5L90.5 35.5A40 15 0 0 0 50.5 20.5Z');
  });

  it('bar: grows from the origin in proportion to the value', () => {
    show(
      obj(
        'activeBarClass',
        'indicatorColor index 15\nfgColor index 14\nbgColor index 4\nindicatorPv "V"\nmin "0"\nmax "10"'
      ),
      { V: pv({ num: 5 }) }
    );
    const bar = [...document.querySelectorAll('rect')].find(
      (r) => r.getAttribute('fill') === '#00ff00'
    )!;
    // area = the whole 80-px object: 5/10 -> rint(40 + 0.5) = 40 (half to even), +1 for the outline
    expect([bar.getAttribute('x'), bar.getAttribute('width')]).toEqual(['10', '41']);
  });

  it('motif slider: limits and value from the PV, saved value from its PV, steps on a trough click', () => {
    const { puts, layer } = show(
      obj(
        'activeMotifSliderClass',
        `${COLORS}\n2ndBgColor index 4\ncontrolPv "V"\nsavedValuePv "S"\nlimitsFromDb\nshowLimits\nshowValue\nshowSavedValue\nincrement 0.5`
      ),
      { V: pv({ num: 2.5 }), S: pv({ num: 4 }) }
    );
    expect(texts()).toEqual(['0', '10', '2.50', '4.00']);
    expect(layer.subscriptions().map((x) => x.by)).toContain('activeMotifSliderClass.savedValuePv');
    const slider = screen.getByRole('slider');
    slider.getBoundingClientRect = () => ({ left: 0, right: 78, top: 0, bottom: 14 }) as DOMRect;
    fireEvent.mouseDown(slider, { button: 0, clientX: 70, clientY: 5 });
    expect(puts).toEqual([['V', 3]]);
  });
});

describe('SLAC widgets', () => {
  it('slac bar: origin-relative extents, half up, clamped at the range ends', () => {
    // gasjets: range -10..2 from -10, L 99, v 1.103 -> 92 px
    expect(slacBarExtent(1.103, -10, 2, -10, 99)).toEqual({ oL: 0, start: 0, ext: 92 });
    // xorbitBSY: -1..1 from 0, L 350, value above the range -> the far half
    expect(slacBarExtent(5, -1, 1, 0, 350)).toEqual({ oL: 175, start: 175, ext: 175 });
    // below the origin: grows toward readMin
    expect(slacBarExtent(-0.5, -1, 1, 0, 350)).toEqual({ oL: 175, start: 87, ext: 88 });
  });

  it('mmv: 60-degree pie markers with X pixel rules', () => {
    // HorizTop, r 12: half-widths per row from the round side down to the tip
    const px = mmvMarker(0, 50, 12, 460, 12);
    const rows = new Map<number, number[]>();
    for (const [x, y] of px) rows.set(y, [...(rows.get(y) ?? []), x]);
    const half = [...rows.keys()].sort((a, b) => a - b).map((y) => (rows.get(y)!.length - 1) / 2);
    expect(half).toEqual([0, 4, 5, 5, 4, 4, 3, 2, 2, 1, 1, 0]);
  });
});
