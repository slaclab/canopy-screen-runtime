import { AlarmSeverity } from '@slaclab/canopy-client';
import type { PVData, PVService } from '@slaclab/canopy-client';
import { describe, expect, it } from 'vitest';
import { calcConnection, parseCalcList, parseCalcName } from './calc.js';
import { EdmPvLayer } from './layer.js';
import { localConnection, parseLocDeclaration } from './local.js';
import { pvServiceConnection } from './pvService.js';
import type { EdmPvConnection, EdmPvData, EdmPvListener } from './types.js';

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

/** A controllable EPICS stand-in: set() pushes updates to subscribers. */
function fakeEpics() {
  const listeners = new Map<string, Set<EdmPvListener>>();
  const values = new Map<string, EdmPvData>();
  const conn: EdmPvConnection = {
    subscribe(name, l) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)!.add(l);
      const v = values.get(name);
      if (v) l(v);
      return () => listeners.get(name)!.delete(l);
    },
  };
  return {
    conn,
    set(name: string, d: Partial<EdmPvData>) {
      const v = pv(d);
      values.set(name, v);
      listeners.get(name)?.forEach((l) => l(v));
    },
  };
}

function setup(
  calcs = 'CALC1\n\nsum\n# comment between name and expression\nA+B\n\nfault\nA=1?2:(A=2?4:0)\n'
) {
  const epics = fakeEpics();
  const layer = new EdmPvLayer().register('epics', epics.conn).register('loc', localConnection());
  layer.register('calc', calcConnection(layer, parseCalcList(calcs)));
  const watch = (name: string) => {
    const seen: EdmPvData[] = [];
    layer.subscribe(name, name, 'test', (d) => seen.push(d));
    return () => seen[seen.length - 1];
  };
  return { epics, layer, watch };
}

describe('CALC\\ PVs', () => {
  it('parses the head and arguments like EDM', () => {
    expect(parseCalcName('{A+B}(X:1, Y:2.VAL)')).toEqual({
      head: '{A+B}',
      args: ['X:1', 'Y:2.VAL'],
    });
    expect(parseCalcName('sum(CALC\\sum(a,b),c)')).toEqual({
      head: 'sum',
      args: ['CALC\\sum(a,b)', 'c'],
    });
    expect(parseCalcName('{A=2}')).toEqual({ head: '{A=2}', args: [] });
    expect(parseCalcName('{(A)}(PV)')).toEqual({ head: '{(A)}', args: ['PV'] });
    expect(parseCalcName('(X)')).toBeNull();
    expect(parseCalcName('{}(X)')).toBeNull();
  });

  it('reads calc.list: name / expression pairs, comments anywhere, first wins', () => {
    const m = parseCalcList(
      'CALC1\n#c\nfault\n#between\nA=1?2:0\n\nfault\nB\nsum\n@$(A),$(B)\nA+B\n'
    );
    expect([...m]).toEqual([
      ['fault', 'A=1?2:0'],
      ['sum', 'A+B'],
    ]);
    expect(parseCalcList('not a calc list\nx\nA\n').size).toBe(0);
  });

  it('evaluates inline and named expressions over its arguments', () => {
    const { epics, watch } = setup();
    const inline = watch('CALC\\{100*(A-B)/A}(P:A, P:B)');
    const named = watch('CALC\\sum(P:A, 5)');
    expect(inline().connected).toBe(false); // arguments not connected yet
    epics.set('P:A', { num: 4 });
    expect(inline().connected).toBe(false);
    expect(named()).toMatchObject({ connected: true, num: 9, precision: 4, type: 'double' });
    epics.set('P:B', { num: 1 });
    expect(inline()).toMatchObject({ connected: true, num: 75 });
    epics.set('P:A', { num: 2 });
    expect(inline().num).toBe(50);
  });

  it('nests CALC and LOC arguments and takes the highest argument severity', () => {
    const { epics, watch } = setup();
    const v = watch('CALC\\sum(CALC\\sum(P:A, LOC\\n=i:10), P:B)');
    epics.set('P:A', { num: 1, severity: AlarmSeverity.MINOR });
    epics.set('P:B', { num: 100, severity: AlarmSeverity.MAJOR });
    expect(v()).toMatchObject({ connected: true, num: 111, severity: AlarmSeverity.MAJOR });
    // INVALID: the expression is not evaluated; the previous value stays
    epics.set('P:B', { num: 0, severity: AlarmSeverity.INVALID });
    expect(v()).toMatchObject({ num: 111, severity: AlarmSeverity.INVALID });
    // a dropped argument disconnects the CALC
    epics.set('P:B', { connected: false });
    expect(v().connected).toBe(false);
  });

  it('keeps 0 for an expression that does not compile and stays invalid for unknown names', () => {
    const { epics, watch } = setup();
    // EDM's engine takes exactly two MAX arguments: this never evaluates
    const bad = watch('CALC\\{MAX(A,B,C)}(P:A, P:B, P:C)');
    const unknown = watch('CALC\\nosuch(P:A)');
    for (const n of ['P:A', 'P:B', 'P:C']) epics.set(n, { num: 3 });
    expect(bad()).toMatchObject({ connected: true, num: 0 });
    expect(unknown().connected).toBe(false);
    expect(watch('CALC\\{2+3}')()).toMatchObject({ connected: true, num: 5 });
  });
});

describe('LOC\\ PVs', () => {
  it('reads initialisers positionally: type, one skipped character, value', () => {
    expect(parseLocDeclaration('i:5')).toMatchObject({ type: 'integer', num: 5 });
    expect(parseLocDeclaration('i,7')).toMatchObject({ type: 'integer', num: 7 });
    expect(parseLocDeclaration('d:2.5')).toMatchObject({ type: 'double', num: 2.5, precision: 4 });
    expect(parseLocDeclaration('s:hello')).toMatchObject({ type: 'string', text: 'hello' });
    expect(parseLocDeclaration('e:1,Hide,Show')).toMatchObject({
      type: 'enum',
      num: 1,
      text: 'Show',
      enumChoices: ['Hide', 'Show'],
    });
    // EDM quirk: no type letter -> a text PV holding what follows character 2
    expect(parseLocDeclaration('0')).toMatchObject({ type: 'string', text: '', num: 0 });
    expect(parseLocDeclaration('1')).toMatchObject({ type: 'string', text: '', num: 0 });
    expect(parseLocDeclaration('123')).toMatchObject({ type: 'string', text: '3', num: 3 });
  });

  it('shares a name, keeps the first initialiser, and is invalid until initialised', () => {
    const { watch, layer } = setup();
    const bare = watch('LOC\\x');
    expect(bare().connected).toBe(false);
    const first = watch('LOC\\x=i:3');
    expect(bare()).toMatchObject({ connected: true, num: 3 });
    watch('LOC\\x=i:9');
    expect(first().num).toBe(3);
    layer.put('LOC\\x', 7);
    expect(bare().num).toBe(7);
    layer.put('LOC\\x=i:0', 2.5);
    expect(first()).toMatchObject({ text: '2.5', num: 2 });
  });
});

describe('EPICS channels through a PVService', () => {
  const read = (value: unknown, meta?: object): EdmPvData => {
    let got: EdmPvData | undefined;
    const service = {
      subscribe: (_name: string, cb: (d: PVData) => void) => {
        cb({ connected: true, value, severity: AlarmSeverity.NO_ALARM } as PVData);
        return () => {};
      },
      put: () => {},
      getMeta: () => meta,
    } as unknown as PVService;
    pvServiceConnection(service).subscribe('X', (d) => (got = d));
    return got!;
  };

  it('reads a numeric waveform as its first element, like EDM text widgets', () => {
    expect(read([7.5, 1, 2], { valueKind: 'waveform', precision: 2 })).toMatchObject({
      type: 'double',
      num: 7.5,
    });
    expect(read([], { valueKind: 'waveform', precision: null })).toMatchObject({
      type: 'integer',
      num: 0,
    });
  });

  it('tells integers from doubles by the channel precision', () => {
    expect(read(3, { valueKind: 'scalar', precision: null }).type).toBe('integer');
    expect(read(3, { valueKind: 'scalar', precision: 0 }).type).toBe('double');
    expect(read('abc').type).toBe('string');
  });
});
