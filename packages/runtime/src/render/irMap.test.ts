// IR → widget prop mapping details that carry semantics beyond renaming.

import { describe, expect, it } from 'vitest';
import { mapIRWidget } from './irMap.js';

describe('pv-label precision source', () => {
  it('defaults precisionFromPV to false for fox:// formula channels', () => {
    const mapped = mapIRWidget('pv-label', { pv: 'fox://f-001', precision: 3 });
    expect(mapped?.props).toMatchObject({
      pvName: 'fox://f-001',
      precision: 3,
      precisionFromPV: false,
    });
  });

  it('leaves plain PV channels and explicit IR values alone', () => {
    expect(mapIRWidget('pv-label', { pv: 'DEV:X', precision: 3 })?.props).not.toHaveProperty(
      'precisionFromPV'
    );
    expect(
      mapIRWidget('pv-label', { pv: 'fox://f-001', precision: 3, precisionFromPV: true })?.props
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
