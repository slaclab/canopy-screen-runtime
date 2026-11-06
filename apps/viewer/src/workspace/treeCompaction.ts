// Folder-chain compaction for the screen tree's compact sections.
//
// A folder that holds exactly one visible child adds a row and a click
// without adding a choice: `bts` holding only `BTSView` (its embedded pieces
// hidden) is one screen behind a folder. compactChains() folds every such
// chain into one breadcrumb row — `bts › BTSView` — where the folded folder
// names are carried as `breadcrumb` (rendered muted, joined by ›) and the row
// is otherwise the node the chain ends at: a screen keeps its id, icon and
// star; a folder with two or more visible children keeps its id (the "leaf
// folder"), so the remembered collapsed state already stored under that id
// applies unchanged and no stored state needs migrating. A chain stops at any
// folder with two or more visible children.
//
// "Visible" is "present in the tree": the caller filters hidden sub-screens
// out before building it, as ScreenTree does. The function is pure — the
// input is never mutated.

/** What compaction needs of a tree node: a branch is a node with `children`. */
export interface CompactableNode {
  id: string;
  label: string;
  children?: readonly CompactableNode[];
}

/** A node after compaction: `breadcrumb` names the folders folded into it. */
export type Compacted<T extends CompactableNode> = T & {
  /** Outermost first; absent when nothing was folded. */
  readonly breadcrumb?: readonly string[];
};

/** Joins breadcrumb segments and the row's own label. */
export const BREADCRUMB_SEPARATOR = ' › ';

/** The row's full text: `a › b › label`, or just the label. */
export function compactedLabel(node: { label: string; breadcrumb?: readonly string[] }): string {
  return node.breadcrumb && node.breadcrumb.length > 0
    ? [...node.breadcrumb, node.label].join(BREADCRUMB_SEPARATOR)
    : node.label;
}

/** Folds every single-child folder chain in `tree` into one breadcrumb row. */
export function compactChains<T extends CompactableNode>(tree: readonly T[]): Compacted<T>[] {
  return tree.map((node) => compactNode(node));
}

function compactNode<T extends CompactableNode>(start: T): Compacted<T> {
  const folded: string[] = [];
  let node = start;
  while (node.children && node.children.length === 1) {
    folded.push(node.label);
    node = node.children[0] as T;
  }
  const out: Compacted<T> = node.children
    ? { ...node, children: compactChains(node.children as readonly T[]) }
    : { ...node };
  return folded.length > 0 ? { ...out, breadcrumb: folded } : out;
}
