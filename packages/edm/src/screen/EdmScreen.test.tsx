import { AlarmSeverity } from '@slaclab/canopy-client';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { EdmPalette } from '../config/colors.js';
import { resolveFont } from '../config/fonts.js';
import { parseEdl } from '../parser/edl.js';
import { EdmPvLayer } from '../pv/layer.js';
import { localConnection } from '../pv/local.js';
import type { EdmPvConnection, EdmPvData } from '../pv/types.js';
import { registerEdmBuiltins } from '../widgets/builtins.js';
import { registerEdmWidget } from '../widgets/registry.js';
import { EdmScreen } from './EdmScreen.js';

const PALETTE = EdmPalette.parse(`4 0 0
static 4 "grey-4" { 48059 48059 48059 }
static 14 "black-14" { 0 0 0 }
static 15 "green" { 0 65535 0 }
static 20 "Monitor: MAJOR" { 65535 0 0 }
static 35 "Monitor: MINOR" { 65535 65535 0 }
static 0 "Disconn/Invalid" { 65535 65535 65535 }
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
  ...over,
});

function fakeEpics(values: Record<string, EdmPvData>): EdmPvConnection {
  return {
    subscribe(name, listener) {
      listener(values[name] ?? pv({ connected: false }));
      return () => {};
    },
  };
}

function show(edl: string, values: Record<string, EdmPvData> = {}, macros = {}) {
  const layer = new EdmPvLayer()
    .register('epics', fakeEpics(values))
    .register('loc', localConnection());
  const openDisplay = vi.fn();
  render(
    <EdmScreen
      doc={parseEdl(edl)}
      palette={PALETTE}
      pv={layer}
      macros={macros}
      path="misc/test.edl"
      openDisplay={openDisplay}
    />
  );
  return { layer, openDisplay };
}

const HEAD = `4 0 1
beginScreenProperties
w 300
h 200
bgColor index 4
endScreenProperties
`;

const obj = (cls: string, props: string) =>
  `object ${cls}\nbeginObjectProperties\n${props}\nendObjectProperties\n`;

beforeAll(() => registerEdmBuiltins());
afterEach(cleanup);

describe('EdmScreen', () => {
  it('is exactly w x h on the display background', () => {
    show(HEAD);
    const root = screen.getByTestId('screen-root');
    expect(root.style.width).toBe('300px');
    expect(root.style.height).toBe('200px');
    expect(root.style.background).toBe('rgb(187, 187, 187)');
  });

  it('shows a placeholder for unknown classes and isolates a failing widget', () => {
    registerEdmWidget('explodingClass', () => {
      throw new Error('boom');
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    show(HEAD + obj('activeMeterClass', 'x 1\ny 2\nw 30\nh 20') + obj('explodingClass', 'x 5'));
    expect(screen.getByTestId('widget-placeholder').textContent).toBe('activeMeterClass');
    expect(screen.getByTestId('widget-error').getAttribute('data-edm-class')).toBe(
      'explodingClass'
    );
  });

  it('places static text glyphs at the X advances, baseline centred like EDM', () => {
    show(
      HEAD +
        obj(
          'activeXTextClass',
          'x 10\ny 20\nw 100\nh 30\nfont "helvetica-medium-r-12.0"\nfgColor index 14\nbgColor index 4\nuseDisplayBg\nvalue {\n  "AB"\n}'
        )
    );
    const t = document.querySelector('text')!;
    const f = resolveFont('helvetica-medium-r-12.0');
    expect(t.textContent).toBe('AB');
    expect(t.getAttribute('x')).toBe(`10 ${10 + f.widths[65]}`);
    // y + ascent + h/2 - (ascent + descent)/2
    expect(t.getAttribute('y')).toBe(String(20 + 11 + 15 - 7));
  });

  it('prints Textupdate values with PREC and EGU, and <pv> when disconnected', () => {
    show(
      HEAD +
        obj('TextupdateClass', 'x 0\ny 0\nw 100\nh 20\ncontrolPv "$(D):A"\nfgColor index 14') +
        obj('TextupdateClass', 'x 0\ny 30\nw 100\nh 20\ncontrolPv "GONE"\nfgColor index 14'),
      { 'DEV:A': pv({ num: 9.771, units: 'u' }) },
      { D: 'DEV' }
    );
    expect([...document.querySelectorAll('text')].map((t) => t.textContent)).toEqual([
      '9.77 u',
      '<GONE>',
    ]);
  });

  it('formats Text Control integers with %d and doubles with its own precision', () => {
    show(
      HEAD +
        obj('activeXTextDspClass', 'x 0\ny 0\nw 80\nh 20\ncontrolPv "I"\nshowUnits') +
        obj('activeXTextDspClass:noedit', 'x 0\ny 30\nw 80\nh 20\ncontrolPv "D"\nprecision 1'),
      {
        I: pv({ type: 'integer', num: 42, precision: null, units: 'mA' }),
        D: pv({ num: 3.14159, precision: 4 }),
      }
    );
    expect([...document.querySelectorAll('text')].map((t) => t.textContent)).toEqual([
      '42 mA',
      '3.1',
    ]);
  });

  it('hides objects by visPv and colours alarm-sensitive text', () => {
    show(
      HEAD +
        obj(
          'activeXTextClass',
          'x 0\ny 0\nw 50\nh 20\nvisPv "V"\nvisMin "1"\nvisMax "2"\nvalue { "shown" }'
        ) +
        obj(
          'activeXTextClass',
          'x 0\ny 0\nw 50\nh 20\nvisPv "V"\nvisMin "1"\nvisMax "2"\nvisInvert\nvalue { "hidden" }'
        ) +
        obj(
          'activeXTextClass',
          'x 0\ny 30\nw 50\nh 20\nfgColor index 14\nfgAlarm\nalarmPv "A"\nvalue { "alarm" }'
        ),
      { V: pv({ num: 1 }), A: pv({ severity: AlarmSeverity.MAJOR }) }
    );
    const texts = [...document.querySelectorAll('text')];
    expect(texts.map((t) => t.textContent)).toEqual(['shown', 'alarm']);
    expect(texts[1].getAttribute('fill')).toBe('#ff0000');
  });

  it('opens related displays with symbols merged into the macros; invisible ones stay clickable', () => {
    const { openDisplay, layer } = show(
      HEAD +
        obj(
          'relatedDisplayClass',
          'x 5\ny 5\nw 40\nh 20\ninvisible\nnumDsps 1\ndisplayFileName {\n  0 "detail"\n}\nsymbols {\n  0 "P=$(D):X,Q=1"\n}'
        ),
      {},
      { D: 'DEV', KEEP: 'k' }
    );
    fireEvent.click(screen.getByRole('link'));
    expect(openDisplay).toHaveBeenCalledWith({
      file: 'detail',
      fromPath: 'misc/test.edl',
      macros: { D: 'DEV', KEEP: 'k', P: 'DEV:X', Q: '1' },
      replace: false,
    });
    expect(document.querySelector('rect')).toBeNull();
    expect(layer.subscriptions()).toEqual([]);
  });

  it('keeps the members of a hidden group subscribed, like EDM', () => {
    const { layer } = show(
      HEAD +
        `object activeGroupClass\nbeginObjectProperties\nx 0\nbeginGroup\n` +
        obj('TextupdateClass', 'x 0\ny 0\nw 50\nh 20\ncontrolPv "INNER"') +
        `endGroup\nvisPv "LOC\\\\show=i:0"\nvisMin "1"\nvisMax "2"\nendObjectProperties\n`,
      { INNER: pv({ num: 1 }) }
    );
    expect(
      layer
        .subscriptions()
        .map((s) => s.by)
        .sort()
    ).toEqual(['TextupdateClass.controlPv', 'activeGroupClass.visPv']);
    const group = document.querySelector<HTMLElement>('[data-edm-class=activeGroupClass]')!;
    expect(group.style.display).toBe('none');
  });

  it('records every subscription with its class and property, served or not', () => {
    const { layer } = show(
      HEAD +
        obj('TextupdateClass', 'x 0\ny 0\nw 10\nh 10\ncontrolPv "$(D):A"\ncolorPv "LOC\\\\c=i:1"') +
        obj('activeXTextDspClass', 'x 0\ny 0\nw 10\nh 10\ncontrolPv "CALC\\\\{A+1}(X)"'),
      {},
      { D: 'DEV' }
    );
    expect(layer.subscriptions().map((s) => [s.expanded, s.scheme, s.by, s.served])).toEqual([
      ['DEV:A', 'epics', 'TextupdateClass.controlPv', true],
      ['LOC\\c=i:1', 'loc', 'TextupdateClass.colorPv', true],
      ['CALC\\{A+1}(X)', 'calc', 'activeXTextDspClass.controlPv', false],
    ]);
    expect(layer.stats()).toMatchObject({ pvs: 3, connected: 1 });
  });
});
