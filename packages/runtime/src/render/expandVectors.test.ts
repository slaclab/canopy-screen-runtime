// The expand() vector file is exactly what `expandScreen` computes over the
// checked-in cases, and every case document is what the sdk's validate()
// says it is. The harness lives in test/expandVectors.ts. Regenerate the file
// (run in packages/runtime):
//   pnpm exec vitest run -u src/render/expandVectors.test.ts

import { describe, expect, it } from 'vitest';
import { validate } from '@slaclab/canopy-screen-ir';
import { serializeExpandVectors } from '../../test/expandVectors.js';
import type { ExpandCase, ExpandVectorCase } from '../../test/expandVectors.js';

import casesFile from './__fixtures__/expand-cases.json' with { type: 'json' };

const cases = (casesFile as unknown as { cases: ExpandCase[] }).cases;

describe('expand vectors', () => {
  it('match the checked-in expand-vectors.json byte for byte', async () => {
    await expect(await serializeExpandVectors(cases)).toMatchFileSnapshot(
      './__fixtures__/expand-vectors.json'
    );
  });

  it.each(cases.map((c) => [c.name, c] as const))(
    'validate(): %s — valid docs pass, invalidDocs fail',
    (_name, c) => {
      expect(Object.hasOwn(c.docs, c.top)).toBe(true);
      for (const key of c.invalidDocs) expect(Object.hasOwn(c.docs, key), key).toBe(true);
      for (const [key, doc] of Object.entries(c.docs)) {
        if (c.invalidDocs.includes(key)) {
          expect(validate(doc), key).not.toEqual([]);
        } else {
          expect(validate(doc), key).toEqual([]);
        }
      }
    }
  );

  it('cover the cases the contract names', async () => {
    const out = JSON.parse(await serializeExpandVectors(cases)) as {
      mappedTypes: string[];
      cases: ExpandVectorCase[];
    };
    expect(out.mappedTypes).toContain('pv-array-plot');
    expect(out.mappedTypes).not.toContain('embedded-display');
    const byName = (part: string) => {
      const found = out.cases.find((c) => c.name.includes(part));
      if (!found) throw new Error(`no case named like ${part}`);
      return found.expect;
    };
    expect(out.cases.some((c) => c.screenPath === null)).toBe(true);
    expect(out.cases.some((c) => c.screenPath !== null)).toBe(true);

    // Depth 8: ten documents, nine instances.
    expect(byName('depth 8').pvs).toEqual(Array.from({ length: 9 }, (_, i) => `DEEP:${i}`));

    // A cycle through two spellings of one file expands it twice.
    const twice = byName('two spellings').nodes.filter((n) => n.nodeId === 't2');
    expect(twice.map((n) => n.screen)).toEqual(['linac/B', 'linac/B']);

    // Unloadable embeds keep their index.
    const unloadable = byName('unloadable embeds');
    expect(new Set(unloadable.nodes.map((n) => n.instance))).toEqual(new Set(['', '/5:u7']));
    expect(unloadable.pvs).toEqual(['OK:PV']);

    // Node set = mounted nodes only.
    const mounted = byName('node set').nodes.map((n) => n.nodeId);
    expect(mounted).not.toContain('v2');
    expect(mounted).not.toContain('v4');
    expect(mounted).not.toContain('v6');
    expect(mounted).toContain('v8');

    // machineBound: loc:// only is not; formula://, rule-only and formula rules are.
    const ch = byName('channels').nodes;
    const bound = Object.fromEntries(ch.map((n) => [n.nodeId, n.machineBound]));
    expect(bound).toMatchObject({
      c1: false,
      c2: true,
      c6: true,
      c7: false,
      c8: true,
      c9: false,
      c10: true,
    });
    expect(byName('channels').pvs).not.toContain('CH:WRITE');
    expect(byName('channels').pvs).not.toContain('NOT:A:PV');

    // A rule retargeting an embed's file: PVs follow base props.
    expect(byName('retargeting').pvs).toEqual(['A:PV', 'SEL']);

    // Hidden nodes: a base-hidden embed keeps its index and is not expanded;
    // a hidden container and everything under it is not listed.
    const hidden = byName('hidden nodes');
    expect(new Set(hidden.nodes.map((n) => n.instance))).toEqual(new Set(['', '/1:E3']));
    const hiddenIds = hidden.nodes.map((n) => n.nodeId);
    for (const id of ['E1', 'HC', 'E2', 'H1', 'H2']) expect(hiddenIds).not.toContain(id);
    expect(hiddenIds).toContain('E3');
    expect(hidden.pvs).toEqual(['HID:E3']);
  });
});
