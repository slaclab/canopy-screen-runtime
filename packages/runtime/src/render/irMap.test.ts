// The checked-in ir-map.json must match what irMapManifest() computes, and
// the manifest must describe both the mapped and renderer-native IR types.

import { describe, expect, it } from 'vitest';
import { registerBuiltinWidgets, widgetRegistry } from '@slaclab/canopy-screen-widgets';
import { irMapManifest, irRuntimeType, mapIRWidget, serializeIrMapManifest } from './irMap.js';
import {
  IR_CATEGORIES,
  IR_DESCRIPTIONS,
  IR_META_OVERRIDES,
  REGISTRY_CATALOG,
  UNREGISTERED_TYPES,
  irMetaFor,
} from './irMeta.js';

import checkedIn from '../../ir-map.json' with { type: 'json' };

describe('irMapManifest', () => {
  it('matches the checked-in ir-map.json (regenerate: node packages/runtime/scripts/emit-ir-map.ts)', () => {
    // Re-serialising the parsed file keeps key and array order in the check.
    expect(`${JSON.stringify(checkedIn, null, 2)}\n`).toBe(serializeIrMapManifest(irMetaFor));
  });

  it('includes the renderer-native types, not verbatim', () => {
    const m = irMapManifest();
    expect(m['absolute-canvas']).toEqual({ consumes: ['backgroundColor'], verbatim: false });
    expect(m['embedded-display']).toEqual({ consumes: ['file', 'macros'], verbatim: false });
  });

  it('marks identity copy entries verbatim and hand-mapped entries not', () => {
    const m = irMapManifest();
    expect(m.rectangle.verbatim).toBe(true);
    expect(m['pv-gauge'].verbatim).toBe(true);
    expect(m['pv-label'].verbatim).toBe(false);
    expect(m['pv-label'].consumes).toContain('precision');
    expect(m.frame).toEqual({ consumes: [], verbatim: false });
  });

  it('has an entry for every type mapIRWidget renders, and keys sorted', () => {
    const m = irMapManifest();
    const keys = Object.keys(m);
    expect(keys).toEqual([...keys].sort());
    for (const type of keys) {
      if (type === 'absolute-canvas' || type === 'embedded-display') continue;
      expect(mapIRWidget(type, {}), type).toBeDefined();
    }
    expect(m['unknown-widget']).toBeUndefined();
  });
});

describe('ir-map.json editor metadata', () => {
  const file = checkedIn as Record<string, Record<string, unknown>>;

  it('gives every key displayName, description, category and supportsChildren', () => {
    for (const [type, entry] of Object.entries(file)) {
      expect(typeof entry.displayName, type).toBe('string');
      expect((entry.displayName as string).length, type).toBeGreaterThan(0);
      expect(typeof entry.description, type).toBe('string');
      expect(typeof entry.supportsChildren, type).toBe('boolean');
      expect(IR_CATEGORIES, type).toContain(entry.category);
    }
  });

  it('keeps display names unique across all IR types', () => {
    const names = Object.values(file).map((e) => e.displayName);
    expect(new Set(names).size).toBe(names.length);
    expect(file['pv-button'].displayName).not.toBe(file['regular-button'].displayName);
  });

  it('derives supportsChildren from the container category and Group/EmbeddedScreen', () => {
    for (const [type, entry] of Object.entries(file)) {
      const runtime = irRuntimeType(type);
      const expected =
        entry.category === 'container' || runtime === 'Group' || type === 'embedded-display';
      expect(entry.supportsChildren, type).toBe(expected);
    }
    expect(file.group.supportsChildren).toBe(true);
    expect(file['absolute-canvas'].supportsChildren).toBe(true);
    expect(file['pv-label'].supportsChildren).toBe(false);
  });

  it('authors descriptions and overrides only for IR types the map renders', () => {
    const keys = Object.keys(irMapManifest());
    for (const type of Object.keys(IR_DESCRIPTIONS)) expect(keys, type).toContain(type);
    for (const type of Object.keys(IR_META_OVERRIDES)) expect(keys, type).toContain(type);
  });

  it('refuses an IR type with no registry entry and no override', () => {
    expect(() => irMetaFor('no-such-widget')).toThrow(/no-such-widget/);
  });

  it('exposes no editor prop keys', () => {
    for (const entry of Object.values(file)) {
      expect(Object.keys(entry).sort()).toEqual([
        'category',
        'consumes',
        'description',
        'displayName',
        'supportsChildren',
        'verbatim',
      ]);
    }
  });
});

describe('irMeta mirrors the live @slaclab/canopy-screen-widgets registry', () => {
  registerBuiltinWidgets();

  it('matches the registry label and category of every mirrored runtime type', () => {
    for (const [type, mirrored] of Object.entries(REGISTRY_CATALOG)) {
      const def = widgetRegistry.get(type as Parameters<typeof widgetRegistry.get>[0]);
      expect(def, type).toBeDefined();
      expect({ label: def?.label, category: def?.category }, type).toEqual(mirrored);
    }
  });

  it('lists as unregistered exactly the runtime types the registry lacks', () => {
    for (const type of UNREGISTERED_TYPES) expect(widgetRegistry.get(type), type).toBeUndefined();
  });

  it('takes each IR type label and category from the registry unless overridden', () => {
    const file = checkedIn as Record<string, Record<string, unknown>>;
    for (const [type, entry] of Object.entries(file)) {
      const runtime = irRuntimeType(type);
      const def = runtime ? widgetRegistry.get(runtime) : undefined;
      const override = IR_META_OVERRIDES[type];
      if (def) {
        // Registered types keep the registry category; only the name may be overridden.
        expect(override?.category, type).toBeUndefined();
        expect(entry.category, type).toBe(def.category);
        expect(entry.displayName, type).toBe(override?.label ?? def.label);
      } else {
        expect(override?.label, type).toBeDefined();
        expect(override?.category, type).toBeDefined();
      }
    }
  });
});

describe('mapIRWidget contract', () => {
  it('carries foregroundColor and backgroundColor from pv-label into PVTextDisplay', () => {
    const m = mapIRWidget('pv-label', {
      pv: 'X',
      foregroundColor: '#ff0000',
      backgroundColor: '#00ff00',
    });
    expect(m?.type).toBe('PVTextDisplay');
    expect(m?.props).toMatchObject({
      pvName: 'X',
      foregroundColor: '#ff0000',
      backgroundColor: '#00ff00',
    });
    expect(irMapManifest()['pv-label'].consumes).toEqual(
      expect.arrayContaining(['foregroundColor', 'backgroundColor'])
    );
  });

  it('carries title and foregroundColor from group-box into Group', () => {
    const m = mapIRWidget('group-box', { title: 'LLRF 1', foregroundColor: '#123456' });
    expect(m?.type).toBe('Group');
    expect(m?.props).toMatchObject({ label: 'LLRF 1', foregroundColor: '#123456' });
  });

  it('carries precision and precisionFromPV from pv-text-input into PVTextInput', () => {
    const m = mapIRWidget('pv-text-input', { pv: 'X', precision: 3, precisionFromPV: true });
    expect(m?.type).toBe('PVTextInput');
    expect(m?.props).toMatchObject({ pvName: 'X', precision: 3, precisionFromPV: true });
    expect(irMapManifest()['pv-text-input'].consumes).toEqual(
      expect.arrayContaining(['precision', 'precisionFromPV'])
    );
  });

  it('puts transparent and the state images on pv-button', () => {
    const m = mapIRWidget('pv-button', {
      pv: 'X',
      transparent: true,
      onImage: 'a.png',
      offImage: 'b.png',
    });
    expect(m?.type).toBe('PVButton');
    expect(m?.props).toMatchObject({
      controlPV: 'X',
      transparent: true,
      onImage: 'a.png',
      offImage: 'b.png',
    });
    const consumes = irMapManifest()['pv-button'].consumes;
    expect(consumes).toEqual(expect.arrayContaining(['transparent', 'onImage', 'offImage']));
  });

  it('drops non-boolean transparent and non-string images instead of passing them through', () => {
    const m = mapIRWidget('pv-button', { pv: 'X', transparent: 'yes', onImage: 3 });
    expect(m?.props).not.toHaveProperty('transparent');
    expect(m?.props).not.toHaveProperty('onImage');
  });

  it('puts transparent on regular-button', () => {
    const m = mapIRWidget('regular-button', { label: 'Go', transparent: true });
    expect(m?.type).toBe('PVButton');
    expect(m?.props).toMatchObject({ label: 'Go', transparent: true });
    expect(irMapManifest()['regular-button'].consumes).toContain('transparent');
    expect(mapIRWidget('regular-button', { label: 'Go' })?.props).not.toHaveProperty('transparent');
  });

  it('maps xy-plot onto XYPlot, carrying curves and axes', () => {
    const curves = [
      {
        name: 'orbit',
        x_channel: 'BPM:X',
        y_channel: 'BPM:Y',
        color: '#0000ff',
        lineWidth: 2,
        traceType: 'line',
        symbol: 'none',
        symbolSize: 10,
        lineStyle: 1,
        yAxisName: 'y0',
      },
    ];
    const xAxis = { name: 'x', label: 'X', autoRange: false, minRange: 0, maxRange: 100 };
    const yAxes = [{ name: 'y0', label: 'mm', autoRange: false, minRange: 0, maxRange: 100 }];
    const m = mapIRWidget('xy-plot', {
      title: 'Orbit',
      curves,
      xAxis,
      yAxes,
      showLegend: true,
    });
    expect(m?.type).toBe('XYPlot');
    expect(m?.props).toEqual({ title: 'Orbit', curves, xAxis, yAxes, showLegend: true });
    expect(irMapManifest()['xy-plot']).toEqual({
      consumes: ['title', 'curves', 'xAxis', 'yAxes', 'showLegend'],
      verbatim: false,
    });
  });
});

describe('pv-array-plot', () => {
  it('maps to PVArrayPlot with its curves, axes, mode and a numeric scale', () => {
    const curves = [{ name: 'X', color: '#00f', y_channels: ['BPM:1:X', 'BPM:2:X'] }];
    const m = mapIRWidget('pv-array-plot', {
      title: 'Orbit',
      curves,
      yAxes: [{ label: 'µm' }],
      xLabels: ['BPM'],
      mode: 'bar',
      scale: 1e6,
    });
    expect(m?.type).toBe('PVArrayPlot');
    expect(m?.props).toEqual({
      title: 'Orbit',
      curves,
      yAxes: [{ label: 'µm' }],
      xLabels: ['BPM'],
      mode: 'bar',
      scale: 1e6,
    });
  });

  it('coerces a numeric-string scale and drops a non-string mode', () => {
    const m = mapIRWidget('pv-array-plot', { scale: '1e6', mode: 3, curves: [] });
    expect(m?.props.scale).toBe(1e6);
    expect(m?.props).not.toHaveProperty('mode');
  });

  it('is in the manifest, not verbatim, with its consumed props', () => {
    expect(irMapManifest()['pv-array-plot']).toEqual({
      consumes: ['title', 'curves', 'yAxes', 'xLabels', 'mode', 'scale'],
      verbatim: false,
    });
  });
});

// IR → widget prop mapping details that carry semantics beyond renaming.

describe('pv-label precision source', () => {
  it('defaults precisionFromPV to false for formula:// formula channels', () => {
    const mapped = mapIRWidget('pv-label', { pv: 'formula://f-001', precision: 3 });
    expect(mapped?.props).toMatchObject({
      pvName: 'formula://f-001',
      precision: 3,
      precisionFromPV: false,
    });
  });

  it('leaves plain PV channels and explicit IR values alone', () => {
    expect(mapIRWidget('pv-label', { pv: 'DEV:X', precision: 3 })?.props).not.toHaveProperty(
      'precisionFromPV'
    );
    expect(
      mapIRWidget('pv-label', { pv: 'formula://f-001', precision: 3, precisionFromPV: true })?.props
        .precisionFromPV
    ).toBe(true);
  });
});

describe('IR appearance props reach the widgets', () => {
  const appearance = {
    foregroundColor: '#2d2d2d',
    backgroundColor: '#dadada',
    fontSize: 12,
    fontFamily: 'Helvetica',
  };

  it.each(['pv-label', 'text-label', 'pv-text-input'])('%s carries its colours and font', (t) => {
    expect(mapIRWidget(t, { pv: 'DEV:X', text: 'x', ...appearance })?.props).toMatchObject(
      appearance
    );
  });

  it.each(['related-display-button', 'regular-button', 'shell-command-button', 'pv-button'])(
    '%s carries its face and caption colours',
    (t) => {
      expect(
        mapIRWidget(t, { label: 'Go', foregroundColor: '#000000', backgroundColor: '#c8c8c8' })
          ?.props
      ).toMatchObject({ foregroundColor: '#000000', backgroundColor: '#c8c8c8' });
    }
  );

  it('keeps text-label alignment for StaticLabel', () => {
    expect(mapIRWidget('text-label', { text: 'x', align: 'right' })?.props.align).toBe('right');
  });
});
