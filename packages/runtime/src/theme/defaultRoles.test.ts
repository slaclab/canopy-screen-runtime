// TEXT_ROLE and withDefaultRoles: the role each colour prop takes when a
// screen leaves it unset.

import { describe, expect, it } from 'vitest';
import { canopyDefaultFlat } from '@slaclab/canopy-screen-ir';
import type { PropertyValue } from '@slaclab/canopy-screen-ir';
import { TEXT_ROLE, withDefaultRoles } from './defaultRoles.js';

const TEXT = canopyDefaultFlat.roles.indexOf('Text');
const LIGHT = canopyDefaultFlat.light[TEXT];
const DARK = canopyDefaultFlat.dark[TEXT];

describe('TEXT_ROLE / withDefaultRoles', () => {
  it('is the Text role with canopy-default fallbacks', () => {
    expect(TEXT).toBeGreaterThanOrEqual(0);
    expect(TEXT_ROLE).toEqual({ $role: 'Text', fallback: LIGHT, fallbackDark: DARK });
  });

  it('fills only an absent foregroundColor, only on a text-label', () => {
    expect(withDefaultRoles('text-label', { text: 'x' })).toEqual({
      text: 'x',
      foregroundColor: TEXT_ROLE,
    });
    const bare: Record<string, PropertyValue> = { text: 'x' };
    expect(withDefaultRoles('text-label', bare).foregroundColor).toBe(TEXT_ROLE);
    const authored = { text: 'x', foregroundColor: '#ff0000' };
    expect(withDefaultRoles('text-label', authored)).toBe(authored);
    const role = { text: 'x', foregroundColor: { $role: 'OK', fallback: '#00ff00' } };
    expect(withDefaultRoles('text-label', role)).toBe(role);
    const other = { pv: 'A' };
    expect(withDefaultRoles('pv-label', other)).toBe(other);
  });

  it('fills the Text role on a radio group and a group box, whose captions and frames show on the canvas', () => {
    const radio: Record<string, PropertyValue> = { pv: 'A' };
    expect(withDefaultRoles('pv-radio-group', radio).foregroundColor).toBe(TEXT_ROLE);
    const box: Record<string, PropertyValue> = { title: 'T' };
    expect(withDefaultRoles('group-box', box).foregroundColor).toBe(TEXT_ROLE);
    const authored = { title: 'T', foregroundColor: '#123456' };
    expect(withDefaultRoles('group-box', authored)).toBe(authored);
  });
});
