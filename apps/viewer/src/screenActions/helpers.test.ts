// The pure helpers behind the screen actions: file names, shortcut matching
// and the print fit.

import { afterEach, describe, expect, it } from 'vitest';
import { fileStem, timestamp } from './files.js';
import { formatShortcut, primaryShortcutKey } from './shortcuts.js';
import { PRINT_SCALE_VAR, applyPrintLayout, clearPrintLayout, printLayout } from './print.js';

describe('file names', () => {
  it('stamps local time as YYYYmmdd-HHMMSS', () => {
    expect(timestamp(new Date(2026, 0, 2, 3, 4, 5))).toBe('20260102-030405');
  });

  it('turns a screen id into a safe file stem', () => {
    expect(fileStem('BTSView')).toBe('BTSView');
    expect(fileStem('CBXFEL/Landing')).toBe('CBXFEL_Landing');
    expect(fileStem('a\\b:c*?')).toBe('a_b_c__');
    expect(fileStem('..hidden')).toBe('hidden');
    expect(fileStem('tab\there')).toBe('tab_here');
    expect(fileStem('')).toBe('screen');
  });
});

describe('shortcuts', () => {
  const key = (init: Partial<Parameters<typeof primaryShortcutKey>[0]>) => ({
    key: 's',
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...init,
  });

  it('formats ⌘ on macOS and Ctrl+ elsewhere', () => {
    expect(formatShortcut('s', true)).toBe('⌘S');
    expect(formatShortcut('p', false)).toBe('Ctrl+P');
  });

  it('matches the primary modifier of the platform only', () => {
    expect(primaryShortcutKey(key({ metaKey: true }), true)).toBe('s');
    expect(primaryShortcutKey(key({ ctrlKey: true }), true)).toBeNull();
    expect(primaryShortcutKey(key({ ctrlKey: true }), false)).toBe('s');
    expect(primaryShortcutKey(key({ metaKey: true }), false)).toBeNull();
    expect(primaryShortcutKey(key({}), false)).toBeNull();
  });

  it('lets Shift and Alt combinations through', () => {
    expect(primaryShortcutKey(key({ ctrlKey: true, shiftKey: true }), false)).toBeNull();
    expect(primaryShortcutKey(key({ ctrlKey: true, altKey: true }), false)).toBeNull();
  });

  it('prefers the physical key over a remapped character', () => {
    expect(primaryShortcutKey(key({ ctrlKey: true, key: 'ß', code: 'KeyP' }), false)).toBe('p');
    expect(primaryShortcutKey(key({ ctrlKey: true, key: 'I', code: '' }), false)).toBe('i');
  });
});

describe('print layout', () => {
  afterEach(clearPrintLayout);

  it('prints a wide screen landscape and a tall one portrait', () => {
    expect(printLayout(1600, 900).orientation).toBe('landscape');
    expect(printLayout(600, 900).orientation).toBe('portrait');
    expect(printLayout(500, 500).orientation).toBe('portrait');
  });

  it('shrinks a screen larger than the page to fit both axes', () => {
    // Landscape page: about 980 x 718 CSS px (A4/Letter less 10 mm margins).
    expect(printLayout(1960, 700).scale).toBeCloseTo(0.5, 2);
    expect(printLayout(1400, 1960).scale).toBeCloseTo(0.5, 2);
    const { scale } = printLayout(3000, 2000);
    expect(3000 * scale).toBeLessThanOrEqual(981);
    expect(2000 * scale).toBeLessThanOrEqual(719);
  });

  it('never magnifies a screen smaller than the page', () => {
    expect(printLayout(300, 200).scale).toBe(1);
  });

  it('sets the scale variable and an @page rule, and clears both', () => {
    applyPrintLayout({ orientation: 'landscape', scale: 0.75 });
    expect(document.documentElement.style.getPropertyValue(PRINT_SCALE_VAR)).toBe('0.75');
    expect(document.getElementById('canopy-print-page')?.textContent).toContain('size: landscape');
    applyPrintLayout({ orientation: 'portrait', scale: 0.5 });
    expect(document.querySelectorAll('#canopy-print-page')).toHaveLength(1);
    clearPrintLayout();
    expect(document.documentElement.style.getPropertyValue(PRINT_SCALE_VAR)).toBe('');
    expect(document.getElementById('canopy-print-page')).toBeNull();
  });
});
