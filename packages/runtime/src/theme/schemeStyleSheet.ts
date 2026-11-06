// The per-scheme stylesheet: one <style> per (document, flatHash) holding the
// scheme's `--cr-<i>` role values and the widgets' `--pydm-*` role aliases,
// scoped to `.canopy-screen[data-scheme="<flatHash>"][data-theme="light|dark"]`. Nothing
// is written on `:root`, so two screens on two schemes in one document keep
// their own values. Screens using one scheme share the element by reference
// count; when the count reaches 0, removal waits for an idle callback and only
// happens if the count is still 0, so an unmount/remount in one tick reuses it.

import { useInsertionEffect } from 'react';
import type { FlatScheme } from '@slaclab/canopy-screen-ir';

/** The custom properties the widgets read, and the role each aliases. */
const ROLE_VARS: ReadonlyArray<readonly [string, string]> = [
  ['--pydm-alarm-none', 'OK'],
  ['--pydm-alarm-minor', 'MINOR'],
  ['--pydm-alarm-major', 'MAJOR'],
  ['--pydm-alarm-invalid', 'INVALID'],
  ['--pydm-alarm-disconnected', 'DISCONNECTED'],
  ['--pydm-display-background', 'Display_Background'],
];

/** Colour values that cannot break out of a declaration block. */
const SAFE_VALUE = /^[#a-zA-Z0-9(),.%\s-]+$/;

/** A CSS double-quoted string body: escapes the quote, backslash and newlines. */
function quoteCss(value: string): string {
  return value.replace(/["\\\n\r\f]/g, (c) => `\\${c.charCodeAt(0).toString(16)} `);
}

function block(flat: FlatScheme, mode: 'light' | 'dark'): string {
  const values = mode === 'light' ? flat.light : flat.dark;
  const decls: string[] = [];
  values.forEach((value, i) => {
    if (typeof value === 'string' && SAFE_VALUE.test(value)) decls.push(`--cr-${i}:${value}`);
  });
  for (const [name, role] of ROLE_VARS) {
    const i = flat.roles.indexOf(role);
    if (i >= 0) decls.push(`${name}:var(--cr-${i})`);
  }
  const selector = `.canopy-screen[data-scheme="${quoteCss(flat.meta.flatHash)}"][data-theme="${mode}"]`;
  return `${selector}{${decls.join(';')}}`;
}

/** The stylesheet text for `flat`: a light block and a dark block. */
export function schemeCss(flat: FlatScheme): string {
  return `${block(flat, 'light')}\n${block(flat, 'dark')}`;
}

interface SheetEntry {
  readonly el: HTMLStyleElement;
  count: number;
}

const registry = new WeakMap<Document, Map<string, SheetEntry>>();

function scheduleIdle(cb: () => void): void {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void) => unknown })
    .requestIdleCallback;
  if (typeof ric === 'function') ric.call(globalThis, cb);
  else setTimeout(cb, 1);
}

function acquire(doc: Document, flat: FlatScheme): () => void {
  let sheets = registry.get(doc);
  if (!sheets) {
    sheets = new Map();
    registry.set(doc, sheets);
  }
  const key = flat.meta.flatHash;
  let entry = sheets.get(key);
  if (!entry) {
    const el = doc.createElement('style');
    el.dataset.canopyScheme = key;
    el.textContent = schemeCss(flat);
    doc.head.appendChild(el);
    entry = { el, count: 0 };
    sheets.set(key, entry);
  }
  entry.count += 1;
  const held = entry;
  const map = sheets;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    held.count -= 1;
    if (held.count > 0) return;
    scheduleIdle(() => {
      if (held.count === 0 && map.get(key) === held) {
        map.delete(key);
        held.el.remove();
      }
    });
  };
}

/**
 * Keeps the stylesheet for `flat` in the current document while the calling
 * component is mounted. Inserted in `useInsertionEffect`, so the rules exist
 * before any layout effect or paint.
 */
export function useSchemeStyleSheet(flat: FlatScheme): void {
  useInsertionEffect(() => {
    const doc = globalThis.document;
    if (!doc) return undefined;
    return acquire(doc, flat);
  }, [flat]);
}
