// collectScreenPVs: the PVs a rendered screen shows, read from the IR with
// the renderer's macro and embedding rules.

import { describe, expect, it, vi } from 'vitest';
import type {
  FormulaDeclaration,
  MacroDeclaration,
  PropertyValue,
  Rule,
  ScreenJSON,
  WidgetNode,
} from '@slaclab/canopy-screen-ir';
import {
  collectScreenPVs,
  embedFile,
  embedOrder,
  expandScreen,
  mappedTypes,
  nodeChannels,
  ruleChannels,
  walkMounted,
} from './collectPVs.js';
import type { ScreenPVGroup } from './collectPVs.js';

let ids = 0;

function w(
  type: string,
  props: Record<string, PropertyValue> = {},
  extra: { children?: WidgetNode[]; rules?: Rule[] } = {}
): WidgetNode {
  ids += 1;
  return {
    id: `w${ids}`,
    type,
    props,
    geometry: { x: 0, y: 0, width: 10, height: 10 },
    ...extra,
  };
}

function doc(
  id: string,
  children: WidgetNode[],
  extra: { macros?: MacroDeclaration[]; formulas?: FormulaDeclaration[]; title?: string } = {}
): ScreenJSON {
  return {
    schemaVersion: '1.0',
    kind: 'screen',
    id,
    metadata: {
      title: extra.title ?? id,
      source: { type: 'hand-authored' },
      size: { width: 100, height: 100 },
    },
    macros: extra.macros ?? [],
    ...(extra.formulas ? { formulas: extra.formulas } : {}),
    root: { ...w('absolute-canvas'), children },
  } as ScreenJSON;
}

const names = (groups: ScreenPVGroup[]) => groups.map((g) => g.pvs.map((p) => p.name));

function resolver(screens: Record<string, ScreenJSON>) {
  return vi.fn(async (ref: string) => {
    const screen = screens[ref];
    if (!screen) throw new Error(`404 ${ref}`);
    return screen;
  });
}

describe('collectScreenPVs on one screen', () => {
  it("lists a pv-array-plot's y_channels in order, once each, as plot PVs", async () => {
    const screen = doc('top', [
      w('pv-array-plot', {
        mode: 'bar',
        scale: 1e6,
        curves: [
          { name: 'X', y_channels: ['${S}:BPM:1:X', '${S}:BPM:2:X', 'loc://skip', ''] },
          { name: 'Y', y_channels: ['${S}:BPM:1:Y', '${S}:BPM:1:X'] },
        ],
      }),
      w('pv-label', { pv: 'SR:BPM:2:X' }),
    ]);
    const groups = await collectScreenPVs(screen, { macros: { S: 'SR' } });
    expect(groups[0]!.pvs).toEqual([
      { name: 'SR:BPM:1:X', role: 'plot' },
      { name: 'SR:BPM:2:X', role: 'plot' },
      { name: 'SR:BPM:1:Y', role: 'plot' },
    ]);
  });

  it('lists every widget channel once, in document order, with its role', async () => {
    const screen = doc('top', [
      w('pv-label', { pv: '${P}:CURRENT' }),
      w(
        'group',
        {},
        {
          children: [
            w('pv-button', { pv: '${P}:RESET', readbackPV: '${P}:STATE' }),
            w('pv-led', { pv: '${P}:OK' }),
          ],
        }
      ),
      w('waveform-plot', { curves: [{ y_channel: 'WF:A', color: '#f00' }] }),
      w('xy-plot', { curves: [{ x_channel: 'BPM:X', y_channel: 'BPM:Y' }] }),
      w('pv-slider', { pv: '${P}:CURRENT', limitsFromPV: true }),
      w('pv-meter', { pvName: 'METER:1' }),
    ]);
    const groups = await collectScreenPVs(screen, { macros: { P: 'GTL:QF1' } });
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ key: '', title: 'top', detail: '', depth: 0 });
    expect(groups[0]!.pvs).toEqual([
      { name: 'GTL:QF1:CURRENT', role: 'readback' },
      { name: 'GTL:QF1:RESET', role: 'control' },
      { name: 'GTL:QF1:STATE', role: 'control' },
      { name: 'GTL:QF1:OK', role: 'status' },
      { name: 'WF:A', role: 'plot' },
      { name: 'BPM:X', role: 'plot' },
      { name: 'BPM:Y', role: 'plot' },
      { name: 'METER:1', role: 'readback' },
    ]);
  });

  it('skips loc://, unresolved macros, blanks, actions and unknown widgets', async () => {
    const screen = doc('top', [
      w('pv-label', { pv: 'loc://tab<VDouble>(0)' }),
      w('pv-label', { pv: '${MISSING}:X' }),
      w('pv-label', { pv: '  ' }),
      w('regular-button', {
        text: 'Go',
        actions: [{ type: 'write_pv', pvName: 'WRITE:ONLY', value: '1' }],
      }),
      w('unknown-widget', { originalClass: 'Foo', originalProps: { channel: 'HIDDEN:PV' } }),
      w('text-label', { text: 'A:B looks like a PV' }),
      w('pv-label', { pv: ' KEPT:PV ' }),
    ]);
    expect(names(await collectScreenPVs(screen))).toEqual([['KEPT:PV']]);
  });

  it('uses the screen defaults under the caller macros', async () => {
    const screen = doc('top', [w('pv-label', { pv: '${P}${R}VAL' })], {
      macros: [
        { name: 'P', default: 'ALS:' },
        { name: 'R', default: 'KNOB:' },
      ],
    });
    expect(names(await collectScreenPVs(screen))).toEqual([['ALS:KNOB:VAL']]);
    expect(names(await collectScreenPVs(screen, { macros: { R: 'X:' } }))).toEqual([['ALS:X:VAL']]);
  });

  it('lists the PVs rules watch, and formula inputs in place of formula:// names', async () => {
    const formulas: FormulaDeclaration[] = [
      { name: 'paddles', expression: '{0} <= 0', bindings: { '0': '${P}:Paddles' } },
      { name: 'sum', expression: '{a}+{b}', bindings: { a: 'IN:A', b: 'formula://paddles' } },
      { name: 'unused', expression: '{0}', bindings: { '0': 'NEVER:SHOWN' } },
    ];
    const conditional: Rule = {
      id: 'r1',
      name: 'colour',
      targetProperty: 'foregroundColor',
      default: null,
      pvs: [
        { name: '${P}:Alarm', trigger: true },
        { name: 'loc://x', trigger: true },
      ],
      conditions: [{ expression: '{0} > 0', value: '#f00' }],
    };
    const formulaRule: Rule = {
      id: 'r2',
      name: 'vis',
      targetProperty: 'visible',
      default: true,
      formula: 'paddles',
    };
    const screen = doc(
      'top',
      [
        w('text-label', { text: 'x' }, { rules: [conditional, formulaRule] }),
        w('pv-label', { pv: 'formula://sum' }),
      ],
      { formulas, macros: [{ name: 'P', default: 'CCD' }] }
    );
    expect((await collectScreenPVs(screen))[0]!.pvs).toEqual([
      { name: 'CCD:Alarm', role: 'rule' },
      { name: 'CCD:Paddles', role: 'formula' },
      { name: 'IN:A', role: 'formula' },
    ]);
  });
});

describe('collectScreenPVs through embedded screens', () => {
  const bpm = doc('bpm', [w('pv-label', { pv: '${BPM_X}' }), w('pv-label', { pv: '${BPM_Y}' })], {
    title: 'BPM',
  });
  const tv = doc('tv', [w('pv-led', { pv: '${paddle_in}' }), w('pv-label', { pv: 'SHARED:PV' })], {
    title: 'TV',
  });

  function gtl(): ScreenJSON {
    return doc(
      'gtl',
      [
        w('pv-label', { pv: 'SHARED:PV' }),
        w('embedded-display', {
          file: 'embedded/_bpm.screen.json',
          macros: { BPM_X: '${L}:BPM1:X', BPM_Y: '${L}:BPM1:Y' },
        }),
        w('embedded-display', {
          file: 'embedded/_tv.screen.json',
          macros: { TV: 'TV1', paddle_in: 'irm:007:B23Out' },
        }),
        w('embedded-display', {
          file: 'embedded/_bpm.screen.json',
          macros: { BPM_X: '${L}:BPM2:X', BPM_Y: '${L}:BPM2:Y' },
        }),
      ],
      { title: 'GTL', macros: [{ name: 'L', default: 'GTL' }] }
    );
  }

  it('gives each instance its group, with its macros expanded, in document order', async () => {
    const resolveScreen = resolver({
      'embedded/_bpm.screen.json': bpm,
      'embedded/_tv.screen.json': tv,
    });
    const groups = await collectScreenPVs(gtl(), { resolveScreen });
    expect(groups.map((g) => [g.title, g.depth, g.detail])).toEqual([
      ['GTL', 0, ''],
      ['BPM', 1, 'BPM_X=GTL:BPM1:X, BPM_Y=GTL:BPM1:Y'],
      ['TV', 1, 'TV=TV1, paddle_in=irm:007:B23Out'],
      ['BPM', 1, 'BPM_X=GTL:BPM2:X, BPM_Y=GTL:BPM2:Y'],
    ]);
    // SHARED:PV is listed once, in the first group that shows it.
    expect(names(groups)).toEqual([
      ['SHARED:PV'],
      ['GTL:BPM1:X', 'GTL:BPM1:Y'],
      ['irm:007:B23Out'],
      ['GTL:BPM2:X', 'GTL:BPM2:Y'],
    ]);
    expect(new Set(groups.map((g) => g.key)).size).toBe(groups.length);
  });

  it('resolves nested refs against the declaring document and passes macros down', async () => {
    const inner = doc('inner', [w('pv-label', { pv: '${DEV}:${SIG}' })], { title: 'inner' });
    const middle = doc(
      'middle',
      [w('embedded-display', { file: '../parts/inner.screen.json', macros: { SIG: 'RB' } })],
      { title: 'middle' }
    );
    const top = doc('top', [
      w('embedded-display', { file: 'sub/middle.screen.json', macros: { DEV: 'Q${N}' } }),
    ]);
    const resolveScreen = resolver({
      'sub/middle.screen.json': middle,
      'parts/inner.screen.json': inner,
    });
    const groups = await collectScreenPVs(top, { resolveScreen, macros: { N: '7' } });
    expect(groups.map((g) => [g.title, g.depth])).toEqual([
      ['top', 0],
      ['middle', 1],
      ['inner', 2],
    ]);
    expect(names(groups)[2]).toEqual(['Q7:RB']);
  });

  it('substitutes macros in an embed file reference', async () => {
    const top = doc('top', [w('embedded-display', { file: '${KIND}.screen.json' })], {
      macros: [{ name: 'KIND', default: 'bpm' }],
    });
    const resolveScreen = resolver({ 'bpm.screen.json': bpm });
    await collectScreenPVs(top, { resolveScreen });
    expect(resolveScreen).toHaveBeenCalledWith('bpm.screen.json');
  });

  it('skips embeds that fail, embed themselves, are too deep or speak another schema', async () => {
    const loop = doc('loop', [
      w('pv-label', { pv: 'LOOP:PV' }),
      w('embedded-display', { file: 'loop.screen.json' }),
    ]);
    const other = { ...doc('other', [w('pv-label', { pv: 'OTHER:PV' })]), schemaVersion: '9.0' };
    const top = doc('top', [
      w('embedded-display', { file: 'missing.screen.json' }),
      w('embedded-display', { file: 'loop.screen.json' }),
      w('embedded-display', { file: 'other.screen.json' }),
      w('embedded-display', {}),
    ]);
    const resolveScreen = resolver({
      'loop.screen.json': loop,
      'other.screen.json': other as ScreenJSON,
    });
    const groups = await collectScreenPVs(top, { resolveScreen });
    // The loop is listed once: its self-embed is the cycle the renderer refuses.
    expect(groups.map((g) => g.title)).toEqual(['top', 'loop']);
    expect(names(groups)).toEqual([[], ['LOOP:PV']]);

    const shallow = await collectScreenPVs(top, { resolveScreen, maxDepth: 0 });
    expect(shallow.map((g) => g.title)).toEqual(['top']);
  });

  it('collects across 1.0 and 1.1 documents embedded in both directions', async () => {
    const v11 = (d: ScreenJSON) => ({ ...d, schemaVersion: '1.1' }) as ScreenJSON;
    const leaf10 = doc('leaf10', [w('pv-label', { pv: 'LEAF10:PV' })]);
    const mid11 = v11(
      doc('mid11', [
        w('pv-label', { pv: 'MID11:PV' }),
        w('embedded-display', { file: 'leaf10.screen.json' }),
      ])
    );
    const top10 = doc('top10', [w('embedded-display', { file: 'mid11.screen.json' })]);
    const resolveScreen = resolver({
      'mid11.screen.json': mid11,
      'leaf10.screen.json': leaf10,
    });
    const groups = await collectScreenPVs(top10, { resolveScreen });
    expect(groups.map((g) => g.title)).toEqual(['top10', 'mid11', 'leaf10']);
    expect(names(groups)).toEqual([[], ['MID11:PV'], ['LEAF10:PV']]);

    const top11 = v11(doc('top11', [w('embedded-display', { file: 'leaf10.screen.json' })]));
    const fromNew = await collectScreenPVs(top11, { resolveScreen });
    expect(names(fromNew)).toEqual([[], ['LEAF10:PV']]);
  });

  it('skips an embed that declares an unsupported 1.2', async () => {
    const future = { ...doc('future', [w('pv-label', { pv: 'FUTURE:PV' })]), schemaVersion: '1.2' };
    const top = doc('top', [w('embedded-display', { file: 'future.screen.json' })]);
    const resolveScreen = resolver({ 'future.screen.json': future as ScreenJSON });
    const groups = await collectScreenPVs(top, { resolveScreen });
    expect(groups.map((g) => g.title)).toEqual(['top']);
  });

  it('lists only the top screen without a resolver', async () => {
    expect((await collectScreenPVs(gtl())).map((g) => g.title)).toEqual(['GTL']);
  });

  it('asks the resolver once per embedded instance', async () => {
    const resolveScreen = resolver({
      'embedded/_bpm.screen.json': bpm,
      'embedded/_tv.screen.json': tv,
    });
    await collectScreenPVs(gtl(), { resolveScreen });
    expect(resolveScreen).toHaveBeenCalledTimes(3);
  });
});

describe('expandScreen: the nodes the renderer mounts', () => {
  it('lists no base-hidden node, nothing under one, and expands no base-hidden embed', async () => {
    const rule = {
      id: 'r1',
      name: 'r1',
      targetProperty: 'color',
      default: '#000',
      pvs: [{ name: 'HID:RULE', trigger: true }],
      conditions: [{ expression: '{0} == 1', value: '#f00' }],
    } as unknown as Rule;
    const e1 = w('embedded-display', { file: 'e1.screen.json', visible: false });
    const e2 = w('embedded-display', { file: 'e2.screen.json' });
    const e3 = w('embedded-display', { file: 'e3.screen.json' });
    const top = doc('top', [
      e1,
      w('group', { visible: false }, { children: [e2, w('pv-label', { pv: 'HID:UNDER' })] }),
      w('pv-label', { pv: 'HID:OWN', visible: false }, { rules: [rule] }),
      e3,
    ]);
    const resolveScreen = resolver({
      'e1.screen.json': doc('e1', [w('pv-label', { pv: 'E1:PV' })]),
      'e2.screen.json': doc('e2', [w('pv-label', { pv: 'E2:PV' })]),
      'e3.screen.json': doc('e3', [w('pv-label', { pv: 'E3:PV' })]),
    });
    const { nodes, groups } = await expandScreen(top, { resolveScreen });

    expect(resolveScreen.mock.calls.map(([ref]) => ref)).toEqual(['e3.screen.json']);
    expect(nodes.map((n) => [n.instance, n.type])).toEqual([
      ['', 'absolute-canvas'],
      ['', 'embedded-display'],
      [`/1:${e3.id}`, 'absolute-canvas'],
      [`/1:${e3.id}`, 'pv-label'],
    ]);
    expect(nodes[1]!.nodeId).toBe(e3.id);
    expect(groups.map((g) => g.key)).toEqual(['', `/1:${e3.id}`]);
    expect(names(groups)).toEqual([[], ['E3:PV']]);
  });

  it('does not descend into embeds, unknown widgets or unmapped types, and drops their PVs', async () => {
    const top = doc('top', [
      w('embedded-display', { file: '' }, { children: [w('pv-label', { pv: 'UNDER:EMBED' })] }),
      w(
        'unknown-widget',
        { originalClass: 'Foo' },
        { children: [w('pv-label', { pv: 'UNDER:UNKNOWN' })] }
      ),
      w(
        'no-such-type',
        { pv: 'UNMAPPED:OWN' },
        { children: [w('pv-label', { pv: 'UNDER:UNMAPPED' })] }
      ),
      w('group', {}, { children: [w('pv-label', { pv: 'UNDER:GROUP' })] }),
    ]);
    const { nodes, groups } = await expandScreen(top);
    expect(nodes.map((n) => n.type)).toEqual([
      'absolute-canvas',
      'embedded-display',
      'unknown-widget',
      'no-such-type',
      'group',
      'pv-label',
    ]);
    expect(names(groups)).toEqual([['UNDER:GROUP']]);
  });

  it('gives each node its instance, base props and declaring document', async () => {
    const child = doc('child', [w('pv-label', { pv: '${D}:RB' })]);
    const embed = w('embedded-display', { file: 'sub/child.screen.json', macros: { D: 'Q1' } });
    const top = doc('top', [w('embedded-display', { file: 'gone.screen.json' }), embed]);
    const resolveScreen = resolver({ 'screens/sub/child.screen.json': child });
    const { nodes } = await expandScreen(top, {
      resolveScreen,
      screenPath: 'screens/top.screen.json',
    });
    const leaf = nodes[nodes.length - 1]!;
    // The failed first embed keeps index 0, so this instance is index 1.
    expect(leaf).toEqual({
      instance: `/1:${embed.id}`,
      nodeId: child.root.children![0]!.id,
      type: 'pv-label',
      props: { pv: 'Q1:RB' },
      screenRef: 'screens/sub/child.screen.json',
      ruleChannels: [],
    });
    expect(nodes[0]!.screenRef).toBe('screens/top.screen.json');
    const viewer = await expandScreen(top, {
      resolveScreen: resolver({ 'sub/child.screen.json': child }),
    });
    expect(viewer.nodes[0]!.screenRef).toBe('');
    expect(viewer.nodes[viewer.nodes.length - 1]!.screenRef).toBe('sub/child.screen.json');
  });

  it('substitutes an embed file twice, as the renderer does', async () => {
    const child = doc('child', [w('pv-label', { pv: 'C:PV' })]);
    const top = doc('top', [w('embedded-display', { file: '${F}' })], {
      macros: [{ name: 'F', default: 'x' }],
    });
    const resolveScreen = resolver({ 'leaf.screen.json': child });
    await expandScreen(top, { resolveScreen, macros: { F: '${L}.screen.json', L: 'leaf' } });
    expect(resolveScreen).toHaveBeenCalledWith('leaf.screen.json');
  });
});

describe('the channel helpers', () => {
  it('nodeChannels reads prop channels only, trimmed, keeping loc:// and formula://', () => {
    expect(
      nodeChannels('pv-label', {
        pv: ' A:B ',
        readbackPV: 'loc://x',
        controlPV: 'formula://f',
        channel: '',
        actions: [{ type: 'write_pv', pvName: 'W' }],
        rules: { pv: 'R' },
        text: 'NOT:A:PV',
      })
    ).toEqual(['A:B', 'loc://x', 'formula://f']);
    expect(nodeChannels('unknown-widget', { pv: 'X' })).toEqual([]);
    expect(nodeChannels('embedded-display', { pv: 'X' })).toEqual([]);
    expect(nodeChannels('no-such-type', { pv: 'X' })).toEqual([]);
  });

  it('ruleChannels lists rule PVs and formula bindings per rule, undeduplicated', () => {
    const rules: Rule[] = [
      {
        id: 'a',
        name: 'a',
        targetProperty: 'visible',
        default: true,
        pvs: [
          { name: '${P}:X', trigger: true },
          { name: 'loc://l', trigger: false },
        ],
        conditions: [],
      },
      { id: 'b', name: 'b', targetProperty: 'visible', default: true, formula: 'f' },
    ];
    const formulas: FormulaDeclaration[] = [
      { name: 'f', expression: '{0}+{1}', bindings: { '0': '${P}:X', '1': 'formula://g' } },
    ];
    expect(ruleChannels(rules, formulas, { P: 'S' })).toEqual([
      'S:X',
      'loc://l',
      'S:X',
      'formula://g',
    ]);
    expect(ruleChannels(undefined, formulas, {})).toEqual([]);
  });

  it('embedOrder indexes the embeds with a base file, in document order', () => {
    const a = w('embedded-display', { file: 'a.screen.json' });
    const empty = w('embedded-display', { file: '' });
    const b = w('embedded-display', { file: '$(K).screen.json' });
    const nested = w('group', {}, { children: [b] });
    const slots = embedOrder(doc('top', [a, empty, nested]), { K: 'b' });
    expect(slots.map((s) => [s.node, s.index, s.file])).toEqual([
      [a, 0, 'a.screen.json'],
      [b, 1, 'b.screen.json'],
    ]);
    expect(embedFile({ file: 7 }, {})).toBeUndefined();
  });

  it('embedOrder reserves the index of a base-hidden embed and takes none under a hidden node', () => {
    const e1 = w('embedded-display', { file: 'e1.screen.json', visible: false });
    const noFile = w('embedded-display', { file: '', visible: false });
    const e2 = w('embedded-display', { file: 'e2.screen.json' });
    const hiddenGroup = w('group', { visible: false }, { children: [e2] });
    const e3 = w('embedded-display', { file: 'e3.screen.json' });
    const slots = embedOrder(doc('top', [e1, noFile, hiddenGroup, e3]), {});
    expect(slots.map((s) => [s.node, s.index, s.file])).toEqual([[e3, 1, 'e3.screen.json']]);
  });

  it('walkMounted skips a base-hidden node and everything under it', () => {
    const under = w('pv-label', { pv: 'UNDER' });
    const hidden = w('group', { visible: false }, { children: [under] });
    const hiddenLeaf = w('pv-label', { pv: 'LEAF', visible: false });
    const stringFalse = w('pv-label', { pv: '$(P):S', visible: 'false' });
    const macroFalse = w('pv-label', { pv: 'M', visible: '$(V)' });
    const shown = w('group', { visible: true }, { children: [w('pv-label', { pv: 'IN' })] });
    const top = doc('top', [hidden, hiddenLeaf, stringFalse, macroFalse, shown]);

    const visited: [WidgetNode, Record<string, PropertyValue>][] = [];
    const skipped: WidgetNode[] = [];
    walkMounted(
      top.root,
      { P: 'X', V: 'false' },
      (node, props) => visited.push([node, props]),
      (node) => skipped.push(node)
    );
    expect(visited.map(([node]) => node)).toEqual([
      top.root,
      stringFalse,
      macroFalse,
      shown,
      shown.children![0],
    ]);
    // Visited with substituted props; a substituted string is never the boolean.
    expect(visited[1]![1]).toEqual({ pv: 'X:S', visible: 'false' });
    expect(visited[2]![1]).toEqual({ pv: 'M', visible: 'false' });
    // The hidden callback sees the hidden nodes themselves, not what is under them.
    expect(skipped).toEqual([hidden, hiddenLeaf]);
    // The callback is optional.
    expect(() => walkMounted(top.root, {}, () => {})).not.toThrow();
  });

  it('walkMounted visits nothing for a base-hidden root', () => {
    const visit = vi.fn();
    walkMounted(
      { ...w('absolute-canvas', { visible: false }), children: [w('pv-label')] },
      {},
      visit
    );
    expect(visit).not.toHaveBeenCalled();
  });

  it('mappedTypes is the renderer map without its native types', () => {
    const types = mappedTypes();
    expect(types).toContain('pv-array-plot');
    expect(types).not.toContain('embedded-display');
    expect(types).not.toContain('absolute-canvas');
    expect(types).not.toContain('unknown-widget');
    expect(types).toEqual([...types].sort());
  });
});
