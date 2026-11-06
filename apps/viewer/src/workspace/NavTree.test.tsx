// NavTree's activation modifiers (the browser tab model): a plain
// click navigates, Shift-, ⌘-on-macOS / Ctrl-elsewhere- and middle-click ask
// for a new tab, and a Ctrl-click on macOS is the context-menu click.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { NavNode } from './NavTree.js';
import { NavTree } from './NavTree.js';
import { openModifier } from '../screenActions/shortcuts.js';

afterEach(() => {
  cleanup();
});

type Tree = typeof NavTree;

function leaf(overrides: Partial<NavNode> = {}) {
  const onActivate = vi.fn();
  const onMenu = vi.fn();
  const node: NavNode = { id: 'a', label: 'Alpha', onActivate, onMenu, ...overrides };
  return { node, onActivate, onMenu };
}

function renderTree(Component: Tree, nodes: NavNode[]) {
  render(
    <Component
      label="Screens"
      nodes={nodes}
      expanded={new Set()}
      onExpandedChange={() => {}}
      idPrefix="t-"
    />
  );
  const item = screen.getByRole('treeitem', { name: 'Alpha' });
  const row = item.querySelector('.nav-tree__row') as HTMLElement;
  return { item, row };
}

describe('openModifier', () => {
  const ev = (ctrlKey: boolean, metaKey: boolean) => ({ ctrlKey, metaKey });

  it('is ⌘ alone on macOS', () => {
    expect(openModifier(ev(false, true), true)).toBe(true);
    expect(openModifier(ev(true, false), true)).toBe(false);
    expect(openModifier(ev(true, true), true)).toBe(false);
    expect(openModifier(ev(false, false), true)).toBe(false);
  });

  it('is Ctrl alone elsewhere', () => {
    expect(openModifier(ev(true, false), false)).toBe(true);
    expect(openModifier(ev(false, true), false)).toBe(false);
    expect(openModifier(ev(true, true), false)).toBe(false);
    expect(openModifier(ev(false, false), false)).toBe(false);
  });
});

describe('NavTree activation (non-Mac)', () => {
  it('a plain click navigates the active tab', () => {
    const { node, onActivate } = leaf();
    const { row } = renderTree(NavTree, [node]);
    fireEvent.click(row);
    expect(onActivate).toHaveBeenCalledWith({ newTab: false });
  });

  it('Shift-click opens a new tab', () => {
    const { node, onActivate } = leaf();
    const { row } = renderTree(NavTree, [node]);
    fireEvent.click(row, { shiftKey: true });
    expect(onActivate).toHaveBeenCalledWith({ newTab: true });
  });

  it('Ctrl-click opens a new tab', () => {
    const { node, onActivate } = leaf();
    const { row } = renderTree(NavTree, [node]);
    fireEvent.click(row, { ctrlKey: true });
    expect(onActivate).toHaveBeenCalledWith({ newTab: true });
  });

  it('⌘-click is not the open modifier off macOS', () => {
    const { node, onActivate } = leaf();
    const { row } = renderTree(NavTree, [node]);
    fireEvent.click(row, { metaKey: true });
    expect(onActivate).toHaveBeenCalledWith({ newTab: false });
  });

  it('Ctrl+Enter and Shift+Enter open a new tab; Enter navigates', () => {
    const { node, onActivate } = leaf();
    const { item } = renderTree(NavTree, [node]);
    fireEvent.keyDown(item, { key: 'Enter' });
    fireEvent.keyDown(item, { key: 'Enter', ctrlKey: true });
    fireEvent.keyDown(item, { key: 'Enter', shiftKey: true });
    expect(onActivate.mock.calls).toEqual([
      [{ newTab: false }],
      [{ newTab: true }],
      [{ newTab: true }],
    ]);
  });

  it('a middle-click opens a new tab and its mousedown is cancelled', () => {
    const { node, onActivate } = leaf();
    const { row } = renderTree(NavTree, [node]);
    const down = fireEvent.mouseDown(row, { button: 1 });
    expect(down).toBe(false); // preventDefault: no autoscroll
    fireEvent(row, new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }));
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(onActivate).toHaveBeenCalledWith({ newTab: true });
  });

  it('a left mousedown is not cancelled and a right auxclick does not activate', () => {
    const { node, onActivate } = leaf();
    const { row } = renderTree(NavTree, [node]);
    expect(fireEvent.mouseDown(row, { button: 0 })).toBe(true);
    fireEvent(row, new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 2 }));
    expect(onActivate).not.toHaveBeenCalled();
  });

  it('a middle-click on a disabled row does nothing', () => {
    const { node, onActivate } = leaf({ disabled: true });
    const { row } = renderTree(NavTree, [node]);
    fireEvent(row, new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }));
    expect(onActivate).not.toHaveBeenCalled();
  });

  it('right-click opens the row menu, not a tab', () => {
    const { node, onActivate, onMenu } = leaf();
    const { row } = renderTree(NavTree, [node]);
    fireEvent.contextMenu(row, { clientX: 10, clientY: 20 });
    expect(onMenu).toHaveBeenCalledWith(10, 20);
    expect(onActivate).not.toHaveBeenCalled();
  });
});

describe('NavTree activation (Mac)', () => {
  async function loadMacTree(): Promise<Tree> {
    vi.resetModules();
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
    const mod = await import('./NavTree.js');
    return mod.NavTree;
  }

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('⌘-click opens a new tab', async () => {
    const MacTree = await loadMacTree();
    const { node, onActivate } = leaf();
    const { row } = renderTree(MacTree, [node]);
    fireEvent.click(row, { metaKey: true });
    expect(onActivate).toHaveBeenCalledWith({ newTab: true });
  });

  it('⌘+Enter opens a new tab', async () => {
    const MacTree = await loadMacTree();
    const { node, onActivate } = leaf();
    const { item } = renderTree(MacTree, [node]);
    fireEvent.keyDown(item, { key: 'Enter', metaKey: true });
    expect(onActivate).toHaveBeenCalledWith({ newTab: true });
  });

  it('Mac ctrl-click opens the menu, not a tab', async () => {
    const MacTree = await loadMacTree();
    const { node, onActivate, onMenu } = leaf();
    const { row } = renderTree(MacTree, [node]);
    // macOS turns a Ctrl-click into a contextmenu event; a click may follow.
    fireEvent.contextMenu(row, { ctrlKey: true, clientX: 5, clientY: 6 });
    fireEvent.click(row, { ctrlKey: true });
    expect(onMenu).toHaveBeenCalledWith(5, 6);
    expect(onActivate).not.toHaveBeenCalled();
  });
});
