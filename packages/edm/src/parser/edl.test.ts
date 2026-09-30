import { describe, expect, it } from 'vitest';
import {
  propBool,
  propIndexedInts,
  propIndexedStrings,
  propInt,
  propIntList,
  propStr,
  propText,
} from '../model.js';
import { parseEdl } from './edl.js';
import { getFileParser, registerFileParser } from './registry.js';

const SCREEN = `# leading comment
4 0 1
beginScreenProperties
major 4
w 800
h 650
bgColor index 8
title "SDR \\"Charge\\" Feedback"
showGrid
endScreenProperties

# (Static Text)
object activeXTextClass
beginObjectProperties
x 20
y 0
font "helvetica-medium-r-18.0"
useDisplayBg
value {
  "line one"
  "brace \\} and \\"quote\\""
}
endObjectProperties
`;

describe('parseEdl', () => {
  it('reads the version after comments, screen properties, flags and escapes', () => {
    const doc = parseEdl(SCREEN);
    expect(doc.version).toEqual([4, 0, 1]);
    expect(propInt(doc.screen, 'w', 0)).toBe(800);
    expect(propStr(doc.screen, 'bgColor')).toBe('index 8');
    expect(propStr(doc.screen, 'title')).toBe('SDR "Charge" Feedback');
    expect(propBool(doc.screen, 'showGrid')).toBe(true);
    expect(doc.issues).toEqual([]);
  });

  it('joins compound string values with newlines and unescapes them', () => {
    const [text] = parseEdl(SCREEN).objects;
    expect(text.className).toBe('activeXTextClass');
    expect(propText(text.props, 'value')).toBe('line one\nbrace } and "quote"');
    expect(propStr(text.props, 'font')).toBe('helvetica-medium-r-18.0');
    expect(propBool(text.props, 'useDisplayBg')).toBe(true);
    expect(propBool(text.props, 'fill')).toBe(false);
  });

  it('keeps class suffixes and reads sparse indexed and dynamic arrays', () => {
    const doc = parseEdl(`4 0 1
object activeXTextDspClass:noedit
beginObjectProperties
x 1
endObjectProperties
object relatedDisplayClass
beginObjectProperties
numDsps 3
displayFileName {
  0 "a.edl"
  2 "c"
}
symbols {
  2 "P=X,R=Y"
}
closeAction {
  1 1
}
endObjectProperties
object activeLineClass
beginObjectProperties
xPoints {
  0 257
  1 300
}
endObjectProperties
`);
    expect(doc.objects.map((o) => o.className)).toEqual([
      'activeXTextDspClass:noedit',
      'relatedDisplayClass',
      'activeLineClass',
    ]);
    const rd = doc.objects[1].props;
    expect(propIndexedStrings(rd, 'displayFileName')).toEqual(['a.edl', undefined, 'c']);
    expect(propIndexedStrings(rd, 'symbols')[2]).toBe('P=X,R=Y');
    expect(propIndexedInts(rd, 'closeAction')).toEqual([undefined, 1]);
    expect(propIntList(doc.objects[2].props, 'xPoints')).toEqual([257, 300]);
  });

  it('nests groups and keeps the group tags written after endGroup', () => {
    const doc = parseEdl(`4 0 1
object activeGroupClass
beginObjectProperties
x 16
w 144

beginGroup

object activeGroupClass
beginObjectProperties
x 40
beginGroup
object activeRectangleClass
beginObjectProperties
x 41
endObjectProperties
endGroup
endObjectProperties

object activeXTextClass
beginObjectProperties
x 50
endObjectProperties

endGroup

visPv "VIS:PV"
visMin "1"
endObjectProperties
`);
    const [g] = doc.objects;
    expect(g.className).toBe('activeGroupClass');
    expect(propStr(g.props, 'visPv')).toBe('VIS:PV');
    expect(g.children?.map((c) => c.className)).toEqual(['activeGroupClass', 'activeXTextClass']);
    expect(g.children?.[0].children?.[0].className).toBe('activeRectangleClass');
    // coordinates stay absolute
    expect(propInt(g.children![0].children![0].props, 'x', 0)).toBe(41);
    expect(doc.issues).toEqual([]);
  });

  it('survives template fragments, CRLF and corruption', () => {
    const doc = parseEdl(
      'object activeRectangleClass\r\nbeginObjectProperties\r\nx 5\r\nendObjectProperties\r\n' +
        '<<<<<<< HEAD\r\nobject activeLineClass\r\nbeginObjectProperties\r\nx 6\r\n'
    );
    expect(doc.version).toBeNull();
    expect(doc.screen).toEqual({});
    expect(doc.objects.map((o) => propInt(o.props, 'x', 0))).toEqual([5, 6]);
    expect(doc.issues.map((i) => i.message)).toEqual([
      'unexpected line: <<<<<<< HEAD',
      'end of file before endObjectProperties',
    ]);
  });
});

describe('file parser registry', () => {
  it('has .edl built in and takes new extensions', () => {
    expect(getFileParser('misc/sdr_fb.edl')).toBeDefined();
    expect(getFileParser('x.bob')).toBeUndefined();
    registerFileParser('bob', () => ({ version: null, screen: {}, objects: [], issues: [] }));
    expect(getFileParser('dir/x.BOB')).toBeDefined();
  });
});
