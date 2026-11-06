// The screen matcher shared by Quick open and the sidebar filter, and the rule
// for which manifest screens are searchable at all. Both are pinned by the
// shared vectors file, a byte copy of canopy's
// tests/canopy_mcp/fixtures/collections/match-vectors.json (match.test.ts runs
// every case).
//
// Words: a label or keyword is split on non-alphanumerics, then at
// lower->Upper, Upper->Upper+lower and letter<->digit boundaries, and each
// part is lower-cased (GTLView -> gtl, view; SR01C -> sr, 01, c).
//
// A query is lower-cased and split on whitespace into tokens; no tokens match
// nothing. An entry matches when every token is a prefix of some word of its
// label or a keyword, or of the joined words of that label or keyword.
// Matches are ordered by: all tokens matched in the label first; then the
// first token prefixing the first label word; then more label words prefixed
// by some token; then list order.

import type { ManifestScreen } from '../api.js';
import { isSubScreen } from '../screenList.js';

/** What the matcher reads from an entry. */
export interface Matchable {
  label: string;
  keywords?: readonly string[];
}

/**
 * The rank of a match, compared element by element, lower first:
 * [all tokens in the label ? 0 : 1, first token prefixes first label word ? 0 : 1,
 * minus the number of label words some token prefixes].
 */
export type MatchRank = readonly [number, number, number];

const BOUNDARY =
  /(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])|(?<=[A-Za-z])(?=[0-9])|(?<=[0-9])(?=[A-Za-z])/;

/** The lower-case words of a label or keyword. */
export function words(text: string): string[] {
  const out: string[] = [];
  for (const chunk of text.split(/[^A-Za-z0-9]+/)) {
    if (chunk === '') continue;
    for (const part of chunk.split(BOUNDARY)) {
      if (part !== '') out.push(part.toLowerCase());
    }
  }
  return out;
}

function tokens(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t !== '');
}

/** True when `token` prefixes one of `parts` or their joined string. */
function hits(token: string, parts: readonly string[]): boolean {
  return parts.some((w) => w.startsWith(token)) || parts.join('').startsWith(token);
}

/** The rank of `entry` for `query`, or null when it does not match. */
export function matchEntry(query: string, entry: Matchable): MatchRank | null {
  const ts = tokens(query);
  if (ts.length === 0) return null;
  const label = words(entry.label);
  const keywords = (entry.keywords ?? []).map(words);
  let allInLabel = true;
  for (const t of ts) {
    if (hits(t, label)) continue;
    allInLabel = false;
    if (!keywords.some((k) => hits(t, k))) return null;
  }
  const first = label.length > 0 && label[0]!.startsWith(ts[0]!);
  const prefixed = label.filter((w) => ts.some((t) => w.startsWith(t))).length;
  return [allInLabel ? 0 : 1, first ? 0 : 1, -prefixed];
}

function compare(a: MatchRank, b: MatchRank): number {
  for (let i = 0; i < a.length; i++) {
    const d = a[i]! - b[i]!;
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * The entries matching `query`, best first; ties keep list order. A blank
 * query matches nothing — a caller that lists everything on an empty query
 * does so itself.
 */
export function rankEntries<E extends Matchable>(entries: readonly E[], query: string): E[] {
  const ranked: { entry: E; rank: MatchRank; index: number }[] = [];
  entries.forEach((entry, index) => {
    const rank = matchEntry(query, entry);
    if (rank) ranked.push({ entry, rank, index });
  });
  ranked.sort((a, b) => compare(a.rank, b.rank) || a.index - b.index);
  return ranked.map((r) => r.entry);
}

/**
 * Whether a manifest screen is searchable: an `ir` screen outside the `@`
 * categories, and not a sub-screen unless sub-screens are shown.
 */
export function searchable(
  entry: Pick<ManifestScreen, 'id' | 'category' | 'kind'>,
  options: { showSubScreens: boolean }
): boolean {
  if (entry.kind !== 'ir' || entry.category.startsWith('@')) return false;
  return options.showSubScreens || !isSubScreen(entry.id);
}
