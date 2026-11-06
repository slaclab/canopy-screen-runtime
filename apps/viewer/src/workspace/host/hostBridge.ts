// The viewer's half of the host shell's tile header-bar contract
// (docs/host-embedding.md).
//
// When the host owns the header the viewer renders no top bar of its own; it
// describes its controls to the host, which renders them in the tile's bar
// and posts a click back as a `canopy-host-header-action`.
//
// `contribute(items)` is a whole replace, never a diff: the host renders only
// what the last contribution says. It is sanitised here to the host's item
// schema first. The host caps the raw list at 12 BEFORE it drops duplicates
// and malformed items, so an unknown or repeated item early in the list would
// push a real item off the end unseen; dropping those here and capping
// afterwards keeps what the host shows equal to what the viewer meant.
//
// Both halves are no-ops unless the viewer is host-embedded (hostEmbed.ts).
// Every message goes to window.parent at location.origin and is taken only
// from window.parent at location.origin, so a cross-origin host gets nothing.

import { isHostEmbedded } from './hostEmbed.js';

/** Version stamped on every contribution message (the host's header contract version). */
export const HEADER_CONTRACT_VERSION = 1;
export const CONTRIBUTION_TYPE = 'canopy-host-header-contribution';
export const ACTION_TYPE = 'canopy-host-header-action';

/** The host's caps: items per contribution, entries per menu or nav, characters per string. */
export const MAX_ITEMS = 12;
export const MAX_ENTRIES = 12;
export const MAX_TEXT = 120;

export interface HeaderNavEntry {
  id: string;
  label: string;
  active?: boolean;
}

export interface HeaderMenuEntry {
  id: string;
  label: string;
  checked?: boolean;
  disabled?: boolean;
}

interface ItemBase {
  id: string;
  priority?: number;
}

export interface HeaderTextItem extends ItemBase {
  kind: 'text';
  text: string;
}

export interface HeaderButtonItem extends ItemBase {
  kind: 'button';
  label: string;
  title?: string;
  tone?: 'default' | 'accent';
  disabled?: boolean;
}

export interface HeaderMenuItem extends ItemBase {
  kind: 'menu';
  label?: string;
  items: HeaderMenuEntry[];
}

export interface HeaderNavItem extends ItemBase {
  kind: 'nav';
  items: HeaderNavEntry[];
}

export interface HeaderSearchItem extends ItemBase {
  kind: 'search';
  placeholder?: string;
  value?: string;
}

export type HeaderItem =
  | HeaderTextItem
  | HeaderButtonItem
  | HeaderMenuItem
  | HeaderNavItem
  | HeaderSearchItem;

export type HeaderActionCallback = (id: string, value: string | undefined) => void;

function clip(s: string): string {
  return s.slice(0, MAX_TEXT);
}

function isStr(v: unknown): v is string {
  return typeof v === 'string';
}

type Loose = Record<string, unknown>;

function entriesOf(raw: unknown): Loose[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (n): n is Loose =>
      !!n && typeof n === 'object' && isStr((n as Loose).id) && isStr((n as Loose).label)
  );
}

function sanitizeOne(it: Loose): HeaderItem | null {
  const id = it.id as string;
  const base: ItemBase = typeof it.priority === 'number' ? { id, priority: it.priority } : { id };
  switch (it.kind) {
    case 'text':
      return isStr(it.text) ? { ...base, kind: 'text', text: clip(it.text) } : null;
    case 'button': {
      if (!isStr(it.label)) return null;
      const out: HeaderButtonItem = { ...base, kind: 'button', label: clip(it.label) };
      if (isStr(it.title)) out.title = clip(it.title);
      if (it.tone === 'accent' || it.tone === 'default') out.tone = it.tone;
      if (typeof it.disabled === 'boolean') out.disabled = it.disabled;
      return out;
    }
    case 'menu': {
      const items = entriesOf(it.items)
        .slice(0, MAX_ENTRIES)
        .map((n) => {
          const e: HeaderMenuEntry = { id: n.id as string, label: clip(n.label as string) };
          // Absent stays absent: an entry without `checked` is a plain action.
          if (typeof n.checked === 'boolean') e.checked = n.checked;
          if (n.disabled === true) e.disabled = true;
          return e;
        });
      if (!items.length) return null;
      const out: HeaderMenuItem = { ...base, kind: 'menu', items };
      if (isStr(it.label)) out.label = clip(it.label);
      return out;
    }
    case 'nav': {
      const items = entriesOf(it.items)
        .slice(0, MAX_ENTRIES)
        .map((n) => {
          const e: HeaderNavEntry = { id: n.id as string, label: clip(n.label as string) };
          if (n.active === true) e.active = true;
          return e;
        });
      return items.length ? { ...base, kind: 'nav', items } : null;
    }
    case 'search': {
      const out: HeaderSearchItem = { ...base, kind: 'search' };
      if (isStr(it.placeholder)) out.placeholder = clip(it.placeholder);
      if (isStr(it.value)) out.value = clip(it.value);
      return out;
    }
    default:
      return null;
  }
}

/**
 * Clamp a contribution to the host's schema: unknown kinds, malformed items and
 * repeated `kind:id` keys are dropped (the first wins), then the first 12
 * items are kept, menus and navs keep their first 12 entries, and every string
 * is cut at 120 characters.
 */
export function sanitizeHeaderItems(raw: readonly unknown[]): HeaderItem[] {
  const out: HeaderItem[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (out.length >= MAX_ITEMS) break;
    if (!item || typeof item !== 'object') continue;
    const it = item as Loose;
    if (!isStr(it.id)) continue;
    const clean = sanitizeOne(it);
    if (!clean) continue;
    const key = `${clean.kind}:${clean.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  return out;
}

function post(items: HeaderItem[]): void {
  try {
    window.parent.postMessage(
      { type: CONTRIBUTION_TYPE, version: HEADER_CONTRACT_VERSION, items },
      window.location.origin
    );
  } catch {
    /* cross-origin host: not ours, drop */
  }
}

let pagehideWired = false;

function onPagehide(): void {
  // A reloading or navigating frame must not leave stale buttons in the bar.
  post([]);
}

function wirePagehide(): void {
  if (pagehideWired) return;
  pagehideWired = true;
  window.addEventListener('pagehide', onPagehide);
}

/**
 * Send (replace) the viewer's tile-bar contribution. Call again with the WHOLE
 * list whenever anything in it changes. No-op unless host-embedded.
 */
export function contribute(items: readonly HeaderItem[]): void {
  if (!isHostEmbedded()) return;
  wirePagehide();
  post(sanitizeHeaderItems(items));
}

/**
 * Subscribe to the host's header actions. The callback receives the clicked
 * item's id and, for a menu (or nav) pick, the entry id as `value` — exactly
 * as the host posts them: a button is `(id, undefined)`, a ⋯ entry is
 * `('more', '<entry id>')`. Only messages from `window.parent` at our own
 * origin count. Returns the unsubscribe; a no-op subscription standalone.
 */
export function onAction(callback: HeaderActionCallback): () => void {
  if (!isHostEmbedded()) return () => {};
  const listener = (event: MessageEvent): void => {
    if (event.origin !== window.location.origin) return;
    if (event.source !== window.parent) return;
    const data = event.data as Loose | null;
    if (!data || typeof data !== 'object' || data.type !== ACTION_TYPE || !isStr(data.id)) return;
    callback(data.id, isStr(data.value) ? data.value : undefined);
  };
  window.addEventListener('message', listener);
  return () => window.removeEventListener('message', listener);
}

/** Test-only: drop the pagehide listener so the next contribute wires it again. */
export function resetHostBridgeForTests(): void {
  window.removeEventListener('pagehide', onPagehide);
  pagehideWired = false;
}
