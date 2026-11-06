import { describe, expect, it } from 'vitest';
import { isSubScreen } from '../screenList.js';
import {
  BREADCRUMB_SEPARATOR,
  compactChains,
  compactedLabel,
  type CompactableNode,
} from './treeCompaction.js';

// A tree in ScreenTree's shape: one folder per category and per id segment,
// ids `folder:/<path>`, screens as leaves, folders sorted by name before
// leaves. Hidden sub-screens are filtered out before the tree is built, so
// "visible" means "present in the tree" — exactly what ScreenTree hands over.
interface Node extends CompactableNode {
  children?: readonly Node[];
  kind: 'folder' | 'screen';
}

function treeOf(screens: readonly string[], showSubScreens: boolean): Node[] {
  interface F {
    folders: Map<string, F>;
    leaves: string[];
  }
  const root: F = { folders: new Map(), leaves: [] };
  for (const screen of screens) {
    const [category, ...rest] = screen.split('/');
    if (!showSubScreens && isSubScreen(rest.join('/'))) continue;
    let folder = root;
    for (const segment of [category!, ...rest.slice(0, -1)]) {
      let next = folder.folders.get(segment);
      if (!next) {
        next = { folders: new Map(), leaves: [] };
        folder.folders.set(segment, next);
      }
      folder = next;
    }
    folder.leaves.push(screen);
  }
  const nodes = (folder: F, path: string): Node[] => [
    ...[...folder.folders.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, child]): Node => {
        const here = `${path}/${name}`;
        return { id: `folder:${here}`, label: name, kind: 'folder', children: nodes(child, here) };
      }),
    ...[...folder.leaves].sort().map(
      (screen): Node => ({
        id: `screen:${screen}`,
        label: screen.split('/').pop()!,
        kind: 'screen',
      })
    ),
  ];
  return nodes(root, '');
}

/** One line per row, indented by depth, with the compacted label. */
function outline(
  tree: readonly (CompactableNode & { breadcrumb?: readonly string[] })[]
): string[] {
  const out: string[] = [];
  const walk = (
    nodes: readonly (CompactableNode & { breadcrumb?: readonly string[] })[],
    depth: number
  ) => {
    for (const node of nodes) {
      out.push(`${'  '.repeat(depth)}${compactedLabel(node)}${node.children ? '/' : ''}`);
      if (node.children) walk(node.children, depth + 1);
    }
  };
  walk(tree, 0);
  return out;
}

// The MCA library shape: BTS and GTB each have one top-level screen plus
// embedded pieces; GTL has two top-level screens.
const MCA = [
  'bts/BTSView',
  'bts/embedded/magnet',
  'bts/embedded/vacuum',
  'gtb/GTBView',
  'gtb/embedded/bpm',
  'gtl/GTLView',
  'gtl/GTLOverview',
];

describe('compactChains', () => {
  it('folds bts and gtb into breadcrumb rows when sub-screens are hidden', () => {
    expect(outline(compactChains(treeOf(MCA, false)))).toEqual([
      'bts › BTSView',
      'gtb › GTBView',
      'gtl/',
      '  GTLOverview',
      '  GTLView',
    ]);
  });

  it('keeps bts and gtb as folders when sub-screens are shown', () => {
    expect(outline(compactChains(treeOf(MCA, true)))).toEqual([
      'bts/',
      '  embedded/',
      '    magnet',
      '    vacuum',
      '  BTSView',
      'gtb/',
      '  embedded › bpm',
      '  GTBView',
      'gtl/',
      '  GTLOverview',
      '  GTLView',
    ]);
  });

  it('never compacts a folder holding two screens', () => {
    const tree = compactChains(treeOf(['gtl/GTLView', 'gtl/GTLOverview'], false));
    expect(tree).toHaveLength(1);
    expect(tree[0]!.id).toBe('folder:/gtl');
    expect(tree[0]!.breadcrumb).toBeUndefined();
    expect(tree[0]!.children!.map((node) => node.id)).toEqual([
      'screen:gtl/GTLOverview',
      'screen:gtl/GTLView',
    ]);
  });

  it('compacts a three-deep single chain to one row', () => {
    const tree = compactChains(treeOf(['a/b/c/Deep'], false));
    expect(outline(tree)).toEqual(['a › b › c › Deep']);
    expect(tree[0]!.breadcrumb).toEqual(['a', 'b', 'c']);
    expect(tree[0]!.label).toBe('Deep');
  });

  it('a row ending at a screen keeps the screen node (id, kind, props)', () => {
    const [row] = compactChains(treeOf(['bts/BTSView', 'bts/embedded/x'], false));
    expect(row).toMatchObject({ id: 'screen:bts/BTSView', kind: 'screen', label: 'BTSView' });
    expect(row!.children).toBeUndefined();
    expect(row!.breadcrumb).toEqual(['bts']);
  });

  it("a chain ending at a branching folder takes the leaf folder's existing id", () => {
    const tree = compactChains(treeOf(['a/b/c/One', 'a/b/c/Two'], false));
    expect(outline(tree)).toEqual(['a › b › c/', '  One', '  Two']);
    expect(tree[0]!.id).toBe('folder:/a/b/c');
    expect(tree[0]!.label).toBe('c');
    expect(tree[0]!.breadcrumb).toEqual(['a', 'b']);
  });

  it('stops at the first folder with two visible children and compacts below it', () => {
    const tree = compactChains(treeOf(['a/b/One', 'a/c/d/Two'], false));
    expect(outline(tree)).toEqual(['a/', '  b › One', '  c › d › Two']);
    expect(tree[0]!.id).toBe('folder:/a');
  });

  it('leaves top-level screens and empty folders untouched, and does not mutate the input', () => {
    const input: Node[] = [
      { id: 'folder:/empty', label: 'empty', kind: 'folder', children: [] },
      { id: 'screen:Top', label: 'Top', kind: 'screen' },
    ];
    const snapshot = JSON.stringify(input);
    const out = compactChains(input);
    expect(out).toEqual(input);
    expect(JSON.stringify(input)).toBe(snapshot);
    const chained = treeOf(['bts/BTSView'], false);
    const before = JSON.stringify(chained);
    compactChains(chained);
    expect(JSON.stringify(chained)).toBe(before);
  });

  it('joins with the › separator', () => {
    expect(BREADCRUMB_SEPARATOR).toBe(' › ');
    expect(compactedLabel({ label: 'Leaf' })).toBe('Leaf');
    expect(compactedLabel({ label: 'Leaf', breadcrumb: ['a', 'b'] })).toBe('a › b › Leaf');
  });
});
