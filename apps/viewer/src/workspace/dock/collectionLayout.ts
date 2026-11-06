// Pure conversions between the dock layout and a collection's layout. No dockview
// instance, no DOM and no storage; the dockview serializer is applyLayout.ts.
import { isTile, normalizeCollection } from '@slaclab/canopy-dock-engine';
import type {
  CollectionLayout,
  CollectionSplit,
  CollectionTile,
  Layout,
} from '@slaclab/canopy-dock-engine';

/**
 * The compact UTF-8 JSON size cap of a collection layout. Must equal CANOPY's
 * `MAX_LAYOUT_BYTES` in `src/canopy_mcp/collections.py`, which refuses a larger layout.
 */
export const MAX_LAYOUT_BYTES = 32 * 1024;

// --- collection layouts --------------------------------------------------------
//
// A collection's layout is the dock engine's collection form (`CollectionLayout`):
// tiles `{tabs, showing?, size?}` whose keys are member indexes (or tab keys
// once a collection is opened), splits `{split, items, size?}`, sizes
// positive weights. Only the byte cap bounds it; there is no depth cap.
//
//   mapCollection(layout, map)   every key through `map`; a key it does not
//              map (undefined), or one an earlier tab already took, is
//              dropped, a tile left without tabs goes, a `showing` that went
//              is cleared. When nothing was dropped the tree keeps its shape
//              and weights; when something was, the result is normalised
//              (normalizeCollection: one-item splits collapsed, same-direction
//              splits flattened, weights as fractions). Either way a `showing`
//              equal to `tabs[0]` is left out, as the form defaults it. Null
//              when no tile is left. Opening a collection (member index ->
//              tab key, skipped members unmapped), an edit (reorder's
//              permutation, a removal's renumbering) and Save (tab key ->
//              member index) all go through it.
//   collectionOfDock(layout, indexOf)  the dock's layout in collection form,
//              for Save: tile ids and `from` dropped, each tab key through
//              `indexOf` (mapCollection), sizes kept as weights. A one-tile
//              dock is a one-tile layout.

/** The dock form a collection tile can come from: its tile id and `from` are ignored. */
type AnyTile<K> = CollectionTile<K> & { tile?: string; from?: string };

/**
 * `layout` with every key through `map` (see the section header); null when
 * no tile is left. Never mutates its input.
 */
export function mapCollection<A, B>(
  layout: CollectionLayout<A> | Layout<A>,
  map: (key: A) => B | undefined
): CollectionLayout<B> | null {
  const taken = new Set<B>();
  let dropped = false;
  const visit = (node: CollectionLayout<A> | Layout<A>): CollectionLayout<B> | null => {
    if (!isTile(node as CollectionLayout<A>)) {
      const split = node as CollectionSplit<A>;
      const items = split.items
        .map(visit)
        .filter((item): item is CollectionLayout<B> => item !== null);
      if (items.length < split.items.length) dropped = true;
      if (items.length === 0) return null;
      const out: CollectionSplit<B> = { split: split.split, items };
      if (split.size !== undefined) out.size = split.size;
      return out;
    }
    const tile = node as AnyTile<A>;
    const tabs: B[] = [];
    let showing: B | undefined;
    for (const key of tile.tabs) {
      const mapped = map(key);
      if (mapped === undefined || taken.has(mapped)) {
        dropped = true;
        continue;
      }
      taken.add(mapped);
      tabs.push(mapped);
      if (key === tile.showing) showing = mapped;
    }
    if (tabs.length === 0) return null;
    const out: CollectionTile<B> = { tabs };
    if (showing !== undefined) out.showing = showing;
    if (tile.size !== undefined) out.size = tile.size;
    return out;
  };
  const mapped = visit(layout);
  if (mapped === null) return null;
  return withoutDefaultShowing(dropped ? normalizeCollection(mapped) : mapped);
}

/** A fresh tree without the `showing` that only repeats `tabs[0]`. */
function withoutDefaultShowing<K>(node: CollectionLayout<K>): CollectionLayout<K> {
  if (!isTile(node)) return { ...node, items: node.items.map(withoutDefaultShowing) };
  if (node.showing === undefined || node.showing !== node.tabs[0]) return node;
  const out = { ...node };
  delete out.showing;
  return out;
}

/** The dock's layout in collection form (see the section header); null: nothing maps. */
export function collectionOfDock(
  layout: Layout,
  indexOf: (key: string) => number | undefined
): CollectionLayout<number> | null {
  return mapCollection(layout, indexOf);
}
