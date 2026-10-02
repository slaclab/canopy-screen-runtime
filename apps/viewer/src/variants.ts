// Screen variants: one logical screen (category + id) can exist in several
// implementations — an EDM .edl drawn faithfully by @slaclab/canopy-edm, a
// PyDM .ui, a Screen IR document rendered by React. The manifest lists one
// entry per implementation; entries sharing category and id are variants of
// the same screen. Which one /s/<category>/<id> shows is decided here:
//
//   1. the link: ?impl=<impl>[&look=<look>]
//   2. this user's choice for the screen (preferences.ts)
//   3. the site policy (Canopy's magpie store, policy.ts): per screen, then
//      the site-wide default
//   4. the first viewable variant in manifest order
//
// Steps 2-4 only ever pick a viewable variant; a link may name any variant
// (the page then says why it can't be shown).

import type { ManifestScreen } from './api.js';

export type ScreenImpl = 'edm' | 'pydm' | 'react';

/** A variant named by implementation and, optionally, look. */
export interface VariantPick {
  readonly impl: string;
  readonly look?: string;
}

export interface ScreenVariant {
  readonly impl: string;
  /** '' when the manifest names no look. */
  readonly look: string;
  readonly entry: ManifestScreen;
}

export interface LogicalScreen {
  /** `${category}/${id}`: the key of the per-screen policy and preferences. */
  readonly key: string;
  readonly category: string;
  readonly id: string;
  readonly variants: readonly ScreenVariant[];
}

/** The site policy: magpie config `screen-variants` of app `canopy-viewer` (see policy.ts). */
export interface ScreenPolicy {
  /** Preferred wherever a screen has a matching viewable variant. */
  readonly default?: VariantPick;
  /** Per screen, keyed `${category}/${id}`; wins over `default`. */
  readonly screens: Readonly<Record<string, VariantPick>>;
}

export const EMPTY_POLICY: ScreenPolicy = { screens: {} };

/** Implementation of a manifest entry: its `impl`, else implied by its kind. */
export function implOf(entry: ManifestScreen): string {
  if (entry.impl) return entry.impl;
  if (entry.kind === 'edl') return 'edm';
  if (entry.kind === 'ui') return 'pydm';
  return 'react';
}

/** Why a variant can't be shown here, or null if it can. */
export function notViewable(v: ScreenVariant): { title: string; detail: string } | null {
  const { entry } = v;
  if (v.impl === 'edm') return null;
  if (v.impl === 'react') {
    if (entry.kind === 'ir') return null;
    return {
      title: `Screen '${entry.title}' is a ${entry.kind} screen`,
      detail: 'Only IR screens (.screen.json) are viewable in this version.',
    };
  }
  if (v.impl === 'pydm') {
    return {
      title: `Screen '${entry.title}' is a PyDM screen`,
      detail: 'PyDM (.ui) screens are not viewable in this version.',
    };
  }
  return {
    title: `Screen '${entry.title}' is a '${v.impl}' screen`,
    detail: 'This viewer does not know that implementation.',
  };
}

const IMPL_LABELS: Record<string, string> = { edm: 'EDM', pydm: 'PyDM', react: 'Screen IR' };

/** "EDM · faithful", "Screen IR". */
export function variantLabel(v: ScreenVariant): string {
  const impl = IMPL_LABELS[v.impl] ?? v.impl;
  return v.look ? `${impl} · ${v.look}` : impl;
}

/** Group manifest entries into logical screens (first-appearance order, variants in manifest order). */
export function groupScreens(entries: readonly ManifestScreen[]): LogicalScreen[] {
  const byKey = new Map<string, ScreenVariant[]>();
  const order: LogicalScreen[] = [];
  for (const entry of entries) {
    const key = `${entry.category}/${entry.id}`;
    let variants = byKey.get(key);
    if (!variants) {
      variants = [];
      byKey.set(key, variants);
      order.push({ key, category: entry.category, id: entry.id, variants });
    }
    variants.push({ impl: implOf(entry), look: entry.look ?? '', entry });
  }
  return order;
}

export function findScreen(
  entries: readonly ManifestScreen[],
  category: string | undefined,
  id: string | undefined
): LogicalScreen | undefined {
  return groupScreens(entries).find((s) => s.category === category && s.id === id);
}

/** The variant a pick names: same impl, and same look when the pick has one. */
export function matchVariant(
  variants: readonly ScreenVariant[],
  pick: VariantPick | null | undefined
): ScreenVariant | undefined {
  if (!pick?.impl) return undefined;
  return variants.find((v) => v.impl === pick.impl && (!pick.look || v.look === pick.look));
}

export type VariantSource = 'link' | 'user' | 'site' | 'listed';

export interface VariantChoice {
  /** undefined: the link named a variant the screen doesn't have. */
  readonly variant: ScreenVariant | undefined;
  readonly source: VariantSource;
}

export function chooseVariant(
  screen: LogicalScreen,
  {
    link,
    user,
    policy = EMPTY_POLICY,
  }: { link?: VariantPick | null; user?: VariantPick | null; policy?: ScreenPolicy }
): VariantChoice {
  if (link?.impl) return { variant: matchVariant(screen.variants, link), source: 'link' };
  const viewable = screen.variants.filter((v) => !notViewable(v));
  const mine = matchVariant(viewable, user);
  if (mine) return { variant: mine, source: 'user' };
  const site =
    matchVariant(viewable, policy.screens[screen.key]) ?? matchVariant(viewable, policy.default);
  if (site) return { variant: site, source: 'site' };
  return { variant: viewable[0] ?? screen.variants[0], source: 'listed' };
}

function pickOf(value: unknown): VariantPick | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { impl, look } = value as { impl?: unknown; look?: unknown };
  if (typeof impl !== 'string' || !impl) return undefined;
  return typeof look === 'string' && look ? { impl, look } : { impl };
}

/**
 * A policy from a magpie config's `data`. Magpie stores it opaquely, so
 * anything malformed is dropped rather than trusted:
 *
 *   { "default": { "impl": "edm", "look": "faithful" },
 *     "screens": { "examples/vacuum-system": { "impl": "react" } } }
 */
export function parsePolicy(data: unknown): ScreenPolicy {
  if (!data || typeof data !== 'object') return EMPTY_POLICY;
  const raw = data as { default?: unknown; screens?: unknown };
  const screens: Record<string, VariantPick> = {};
  if (raw.screens && typeof raw.screens === 'object') {
    for (const [key, value] of Object.entries(raw.screens)) {
      const pick = pickOf(value);
      if (pick) screens[key] = pick;
    }
  }
  const def = pickOf(raw.default);
  return def ? { default: def, screens } : { screens };
}
