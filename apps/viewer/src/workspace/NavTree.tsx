// A small WAI-ARIA tree (https://www.w3.org/WAI/ARIA/apg/patterns/treeview/)
// for the workspace's sidebar. Presentational: the nodes, which branches are
// expanded and which node is selected come in as props; what a node does when
// activated or right-clicked goes out through callbacks.
//
//   rows        one row per visible node, indented by depth, with a guide line
//               per ancestor level. A branch shows a chevron that rotates when
//               it opens. A plain folder (no `onActivate`) toggles from its
//               whole row; a branch that is also an action (the data browser,
//               which lists saved views) runs the action from its row and
//               toggles from its chevron.
//   focus       roving tabindex: one row is in the tab order (the focused one,
//               else the selected one, else the first). Up/Down move through
//               visible rows, Right opens a branch or enters it, Left closes it
//               or goes to the parent, Home/End jump, Enter and Space activate
//               (a plain folder toggles), Shift+F10 / the context-menu key
//               open the row's menu.
//   labels      text only; every treeitem is named by its own label, never
//               its children.
//   shape       each row is a host-contract `.canopy-row` (text-md at the
//               control-h-xs height) with its icon and label as the recipe's
//               `__icon` and `__label`; NavTree.css adds only what is the
//               tree's own (indent, guides, chevron, colours, selection).
//   action      a node may carry one trailing button (the Tools entries'
//               '+'); it is a pointer shortcut, out of the tab order, so its
//               action must also be on the node's menu.
//   drag        a node with `onDragStart` is an HTML5 drag source from its
//               row (not the whole item, so a branch's ghost is its own row):
//               the callback writes the transfer, the row dims until dragend.
//               A pointer gesture only; keyboard and click are unchanged.
//   disabled    a disabled node never activates, but still opens its menu
//               when it has one (a saved view of a tool not served here keeps
//               its Delete).
//   modifiers   activation passes `newTab`, the browser's new-tab gesture:
//               Shift, or ⌘ on macOS / Ctrl elsewhere (openModifier), held on
//               a click or on Enter, or a middle-click (auxclick, button 1;
//               its mousedown is cancelled so the browser does not autoscroll).
//               A Ctrl-click on macOS is the context-menu click: it opens the
//               row menu and never activates.
//   marker      an icon-only, decorative glyph after the label (the Browse
//               tree's pinned star); `hoverAction` is a trailing button shown
//               on row hover or item focus only (unless `persistent`), for rows
//               without an `action` (the Browse tree's Pin star). Both are
//               pointer affordances; what they do is also on the node's menu.
//   rowClass    `rowClassName` lands on the row itself (the Browse tree's
//               top-level branch rows carry `.canopy-section-heading`).
//   editor      a node with `editor` shows it in place of its label (the
//               inline rename field): the row neither activates, opens its
//               menu nor drags from inside it, and the field owns its keys.
//   remove      `removeAction` is a second trailing hover button after
//               `hoverAction` (the × of a collection member).
//   move        a node with `onMove` moves with Alt+Up / Alt+Down; focus stays
//               on the moved row once the tree re-renders it elsewhere.
//   drop        `dropZone` makes the row a drop target for the drags it
//               `accepts` (checked from the dataTransfer's types on dragover);
//               the row is outlined while one is over it. `onDragEnd` runs
//               when a drag from the row ends, dropped or not.
//   breadcrumb  folded folder names (treeCompaction.ts) render muted before
//               the label, joined by ›, and are part of the row's name.
//   count       a number after the label (RECENT's size); it is the row's
//               description (aria-describedby), not part of its name.

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type {
  DragEvent as ReactDragEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
} from 'react';
import { ChevronRight } from '@carbon/icons-react';
import { isMac, openModifier } from '../screenActions/shortcuts.js';
import { BREADCRUMB_SEPARATOR } from './treeCompaction.js';
import './NavTree.css';

export interface NavNode {
  /** Unique within the tree; also the expansion key. */
  id: string;
  label: string;
  /** Rendered before the label (16 px). */
  icon?: ReactNode;
  /** Children make the node a branch. */
  children?: readonly NavNode[];
  disabled?: boolean;
  /** Tooltip. */
  title?: string;
  /** Extra class on the treeitem. */
  className?: string;
  /** Extra attributes on the treeitem (data-* hooks). */
  data?: Readonly<Record<`data-${string}`, string>>;
  /** Extra class on the row element (the `.canopy-row`). */
  rowClassName?: string;
  /**
   * What activating the node does. Absent on a branch: the row toggles it.
   * Absent on a leaf: the leaf does nothing (a disabled one, say).
   */
  onActivate?: (modifiers: NavActivation) => void;
  /** Right-click or the keyboard menu key, at a viewport position. */
  onMenu?: (x: number, y: number) => void;
  /** A trailing button in the row. */
  action?: NavNodeAction;
  /** An icon-only decorative marker after the label (16 px). */
  marker?: ReactNode;
  /** Folded folder names shown muted before the label (`a › b › label`), outermost first. */
  breadcrumb?: readonly string[];
  /** A count shown after the label (a section heading's size); it describes the row. */
  count?: number;
  /** A trailing button shown on row hover or item focus (always when `persistent`). */
  hoverAction?: NavNodeAction & { persistent?: boolean };
  /** Makes the row a drag source: `dragstart` with the transfer to write. */
  onDragStart?: (dataTransfer: DataTransfer | null) => void;
  /** A drag from the row ended (dropped or cancelled). */
  onDragEnd?: () => void;
  /** Shown in place of the label (an inline field). */
  editor?: ReactNode;
  /** A second trailing hover button, after `hoverAction`. */
  removeAction?: NavNodeAction;
  /** Alt+Up (-1) / Alt+Down (+1) on the focused row. */
  onMove?: (delta: -1 | 1) => void;
  /** Makes the row a drop target for the drags it accepts. */
  dropZone?: NavDropZone;
}

export interface NavDropZone {
  /** Whether a drag carrying this transfer may drop here (types only, on dragover). */
  accepts: (dataTransfer: DataTransfer | null) => boolean;
  onDrop: (dataTransfer: DataTransfer | null) => void;
}

/** What was held when a node was activated. */
export interface NavActivation {
  /** Shift, the platform's open modifier, or a middle-click: open in a new tab. */
  newTab: boolean;
}

/** Whether a click or key event asks for a new tab (Shift or the open modifier). */
function wantsNewTab(event: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }): boolean {
  return event.shiftKey || openModifier(event, isMac);
}

export interface NavNodeAction {
  /** Accessible name. */
  label: string;
  /** Tooltip (say why, when disabled). */
  title?: string;
  /** The glyph (16 px). */
  icon: ReactNode;
  disabled?: boolean;
  onClick: () => void;
}

/** Folded folder names: muted, before the label. */
const BREADCRUMB_STYLE = { color: 'var(--cds-text-secondary, inherit)' } as const;

/** A heading's count: muted, after the label. */
const COUNT_STYLE = {
  flex: 'none',
  paddingInlineStart: '0.25rem',
  color: 'var(--cds-text-secondary, inherit)',
  fontWeight: 'normal',
} as const;

const ACTION_STYLE = {
  marginLeft: 'auto',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  flex: 'none',
  width: '1.25rem',
  height: '1.25rem',
  padding: 0,
  border: 0,
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
} as const;

export interface NavTreeProps {
  /** Accessible name of the tree. */
  label: string;
  nodes: readonly NavNode[];
  /** Ids of the expanded branches. */
  expanded: ReadonlySet<string>;
  onExpandedChange: (id: string, expanded: boolean) => void;
  /** The selected node's id (aria-selected), if any. */
  selectedId?: string | null;
  /** DOM id prefix for the rows (`<prefix><node id>`). */
  idPrefix: string;
}

interface Row {
  node: NavNode;
  depth: number;
  parent: string | null;
  branch: boolean;
  open: boolean;
}

function visibleRows(
  nodes: readonly NavNode[],
  expanded: ReadonlySet<string>,
  depth = 0,
  parent: string | null = null,
  out: Row[] = []
): Row[] {
  for (const node of nodes) {
    const branch = (node.children?.length ?? 0) > 0;
    const open = branch && expanded.has(node.id);
    out.push({ node, depth, parent, branch, open });
    if (open) visibleRows(node.children!, expanded, depth + 1, node.id, out);
  }
  return out;
}

const INDENT_REM = 1;

export function NavTree({
  label,
  nodes,
  expanded,
  onExpandedChange,
  selectedId = null,
  idPrefix,
}: NavTreeProps) {
  const rows = useMemo(() => visibleRows(nodes, expanded), [nodes, expanded]);
  const rowById = useMemo(() => new Map(rows.map((r) => [r.node.id, r])), [rows]);
  const [focusId, setFocusId] = useState<string | null>(null);
  /** The node whose row is being dragged (dimmed), if any. */
  const [draggingId, setDraggingId] = useState<string | null>(null);
  /** The row a drop-zone drag is over, if any. */
  const [dropId, setDropId] = useState<string | null>(null);
  const treeRef = useRef<HTMLUListElement>(null);
  /** The row moved with Alt+Up/Down: refocused when a re-render dropped its focus. */
  const moved = useRef<string | null>(null);

  useLayoutEffect(() => {
    const id = moved.current;
    if (id === null) return;
    const doc = treeRef.current?.ownerDocument;
    const el = doc?.getElementById(`${idPrefix}${encodeURIComponent(id)}`);
    if (!doc || !el) return;
    const active = doc.activeElement;
    if (active === el) return;
    // The re-render moved the row and dropped its focus: put it back, once.
    if (active === null || active === doc.body) el.focus();
    moved.current = null;
  });

  // The row in the tab order: the focused one if still visible, else the
  // selected one, else the first.
  const tabId =
    (focusId !== null && rows.some((r) => r.node.id === focusId) && focusId) ||
    (selectedId !== null && rows.some((r) => r.node.id === selectedId) && selectedId) ||
    rows[0]?.node.id ||
    null;

  const domId = useCallback((id: string) => `${idPrefix}${encodeURIComponent(id)}`, [idPrefix]);

  const focusRow = useCallback(
    (id: string) => {
      setFocusId(id);
      const el = treeRef.current?.ownerDocument.getElementById(domId(id));
      el?.focus();
    },
    [domId]
  );

  const activate = (row: Row, newTab = false) => {
    if (row.node.disabled) return;
    if (row.node.onActivate) row.node.onActivate({ newTab });
    else if (row.branch) onExpandedChange(row.node.id, !row.open);
  };

  const openMenu = (row: Row, x: number, y: number) => {
    if (!row.node.onMenu) return;
    row.node.onMenu(x, y);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>, row: Row) => {
    const index = rows.indexOf(row);
    if (row.node.onMove && event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault();
      event.stopPropagation();
      moved.current = row.node.id;
      row.node.onMove(event.key === 'ArrowUp' ? -1 : 1);
      return;
    }
    let handled = true;
    switch (event.key) {
      case 'ArrowDown':
        if (index < rows.length - 1) focusRow(rows[index + 1]!.node.id);
        break;
      case 'ArrowUp':
        if (index > 0) focusRow(rows[index - 1]!.node.id);
        break;
      case 'Home':
        if (rows.length > 0) focusRow(rows[0]!.node.id);
        break;
      case 'End':
        if (rows.length > 0) focusRow(rows[rows.length - 1]!.node.id);
        break;
      case 'ArrowRight':
        if (row.branch && !row.open) onExpandedChange(row.node.id, true);
        else if (row.branch && row.open) focusRow(rows[index + 1]!.node.id);
        break;
      case 'ArrowLeft':
        if (row.branch && row.open) onExpandedChange(row.node.id, false);
        else if (row.parent !== null) focusRow(row.parent);
        break;
      case 'Enter':
      case ' ':
        activate(row, wantsNewTab(event));
        break;
      case 'ContextMenu':
        menuFromKeyboard(event, row);
        break;
      case 'F10':
        if (event.shiftKey) menuFromKeyboard(event, row);
        else handled = false;
        break;
      default:
        handled = false;
    }
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  const menuFromKeyboard = (event: ReactKeyboardEvent<HTMLElement>, row: Row) => {
    const rect = event.currentTarget.getBoundingClientRect();
    openMenu(row, rect.left + 16, rect.top + rect.height);
  };

  const renderNodes = (list: readonly NavNode[], depth: number) =>
    list.map((node) => {
      const row = rowById.get(node.id);
      if (!row) return null;
      const labelId = `${domId(node.id)}__label`;
      const countId = `${domId(node.id)}__count`;
      const selected = selectedId === node.id;
      const classes = [
        'nav-tree__item',
        row.branch ? 'nav-tree__item--branch' : 'nav-tree__item--leaf',
        node.disabled ? 'nav-tree__item--disabled' : '',
        node.className ?? '',
      ]
        .filter(Boolean)
        .join(' ');
      const toggle = (event: ReactMouseEvent) => {
        event.stopPropagation();
        setFocusId(node.id);
        onExpandedChange(node.id, !row.open);
      };
      const editing = node.editor !== undefined;
      const dragSource = node.onDragStart !== undefined && !node.disabled && !editing;
      const zone = node.dropZone;
      const rowClasses = [
        'canopy-row',
        'nav-tree__row',
        node.rowClassName ?? '',
        selected ? 'nav-tree__row--selected' : '',
        draggingId === node.id ? 'nav-tree__row--dragging' : '',
        dropId === node.id ? 'nav-tree__row--drop-target' : '',
      ]
        .filter(Boolean)
        .join(' ');
      return (
        <li
          key={node.id}
          id={domId(node.id)}
          role="treeitem"
          className={classes}
          aria-labelledby={labelId}
          aria-describedby={node.count !== undefined ? countId : undefined}
          aria-level={depth + 1}
          aria-expanded={row.branch ? row.open : undefined}
          aria-selected={selected}
          aria-disabled={node.disabled ? true : undefined}
          tabIndex={tabId === node.id ? 0 : -1}
          title={node.title}
          onKeyDown={(event) => {
            if (event.target === event.currentTarget) onKeyDown(event, row);
          }}
          onFocus={(event) => {
            if (event.target !== event.currentTarget) return;
            setFocusId(node.id);
            if (moved.current !== node.id) moved.current = null;
          }}
          {...node.data}
        >
          <div
            className={rowClasses}
            style={{
              paddingLeft: `${depth * INDENT_REM + 0.25}rem`,
              ...(dropId === node.id
                ? { boxShadow: 'inset 0 0 0 2px var(--canopy-focus, currentColor)' }
                : {}),
            }}
            draggable={dragSource || undefined}
            onDragStart={
              dragSource
                ? (event: ReactDragEvent) => {
                    event.stopPropagation();
                    node.onDragStart!(event.dataTransfer ?? null);
                    setDraggingId(node.id);
                  }
                : undefined
            }
            onDragEnd={
              dragSource
                ? () => {
                    setDraggingId(null);
                    node.onDragEnd?.();
                  }
                : undefined
            }
            onDragOver={
              zone
                ? (event: ReactDragEvent) => {
                    if (!zone.accepts(event.dataTransfer ?? null)) return;
                    event.preventDefault();
                    event.stopPropagation();
                    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
                    if (dropId !== node.id) setDropId(node.id);
                  }
                : undefined
            }
            onDragLeave={
              zone
                ? () => {
                    if (dropId === node.id) setDropId(null);
                  }
                : undefined
            }
            onDrop={
              zone
                ? (event: ReactDragEvent) => {
                    setDropId(null);
                    if (!zone.accepts(event.dataTransfer ?? null)) return;
                    event.preventDefault();
                    event.stopPropagation();
                    zone.onDrop(event.dataTransfer ?? null);
                  }
                : undefined
            }
            onClick={(event) => {
              event.stopPropagation();
              if (editing) return;
              setFocusId(node.id);
              // A Ctrl-click on macOS is the context-menu click: the
              // contextmenu event opens the menu, so it never navigates too.
              if (isMac && event.ctrlKey && !event.metaKey) return;
              activate(row, wantsNewTab(event));
            }}
            onMouseDown={(event) => {
              // A middle press would start the browser's autoscroll.
              if (event.button === 1) event.preventDefault();
            }}
            onAuxClick={(event) => {
              if (event.button !== 1) return;
              event.preventDefault();
              event.stopPropagation();
              if (node.disabled || !node.onActivate) return;
              setFocusId(node.id);
              activate(row, true);
            }}
            onContextMenu={(event) => {
              if (editing) return;
              event.preventDefault();
              event.stopPropagation();
              openMenu(row, event.clientX, event.clientY);
            }}
          >
            {Array.from({ length: depth }, (_, level) => (
              <span
                key={level}
                className="nav-tree__guide"
                aria-hidden="true"
                style={{ left: `${level * INDENT_REM + 0.75}rem` }}
              />
            ))}
            {row.branch ? (
              <span
                className={'nav-tree__chevron' + (row.open ? ' nav-tree__chevron--open' : '')}
                aria-hidden="true"
                onClick={node.onActivate ? toggle : undefined}
                data-testid="nav-tree-chevron"
              >
                <ChevronRight size={16} />
              </span>
            ) : (
              <span className="nav-tree__chevron nav-tree__chevron--none" aria-hidden="true" />
            )}
            {node.icon && (
              <span className="canopy-row__icon nav-tree__icon" aria-hidden="true">
                {node.icon}
              </span>
            )}
            {editing ? (
              <span
                className="canopy-row__label nav-tree__label nav-tree__label--editing"
                id={labelId}
                aria-label={node.label}
                style={{ display: 'flex', overflow: 'visible' }}
              >
                {node.editor}
              </span>
            ) : (
              <span className="canopy-row__label nav-tree__label" id={labelId}>
                {node.breadcrumb && node.breadcrumb.length > 0 && (
                  <span className="nav-tree__breadcrumb" style={BREADCRUMB_STYLE}>
                    {[...node.breadcrumb, ''].join(BREADCRUMB_SEPARATOR)}
                  </span>
                )}
                {node.label}
              </span>
            )}
            {node.count !== undefined && (
              <span className="nav-tree__count" id={countId} style={COUNT_STYLE}>
                {node.count}
              </span>
            )}
            {node.marker && (
              <span className="nav-tree__marker" aria-hidden="true">
                {node.marker}
              </span>
            )}
            {node.action && (
              <button
                type="button"
                className="nav-tree__action"
                aria-label={node.action.label}
                title={node.action.title ?? node.action.label}
                // aria-disabled, not disabled: a click still lands here and
                // never falls through to the row's own action.
                aria-disabled={node.action.disabled ? true : undefined}
                tabIndex={-1}
                style={
                  node.action.disabled
                    ? { ...ACTION_STYLE, cursor: 'not-allowed', opacity: 0.4 }
                    : ACTION_STYLE
                }
                onClick={(event) => {
                  event.stopPropagation();
                  if (!node.action!.disabled) node.action!.onClick();
                }}
              >
                {node.action.icon}
              </button>
            )}
            {!node.action && node.hoverAction && (
              <button
                type="button"
                className={
                  'nav-tree__action nav-tree__action--hover' +
                  (node.hoverAction.persistent ? ' nav-tree__action--persistent' : '')
                }
                aria-label={node.hoverAction.label}
                title={node.hoverAction.title ?? node.hoverAction.label}
                aria-disabled={node.hoverAction.disabled ? true : undefined}
                tabIndex={-1}
                style={ACTION_STYLE}
                onClick={(event) => {
                  event.stopPropagation();
                  if (!node.hoverAction!.disabled) node.hoverAction!.onClick();
                }}
              >
                {node.hoverAction.icon}
              </button>
            )}
            {!editing && node.removeAction && (
              <button
                type="button"
                className="nav-tree__action nav-tree__action--hover nav-tree__action--remove"
                aria-label={node.removeAction.label}
                title={node.removeAction.title ?? node.removeAction.label}
                aria-disabled={node.removeAction.disabled ? true : undefined}
                tabIndex={-1}
                style={
                  !node.action && node.hoverAction
                    ? { ...ACTION_STYLE, marginLeft: 0 }
                    : ACTION_STYLE
                }
                onClick={(event) => {
                  event.stopPropagation();
                  if (!node.removeAction!.disabled) node.removeAction!.onClick();
                }}
              >
                {node.removeAction.icon}
              </button>
            )}
          </div>
          {row.open && (
            <ul role="group" className="nav-tree__group">
              {renderNodes(node.children!, depth + 1)}
            </ul>
          )}
        </li>
      );
    });

  return (
    <ul ref={treeRef} role="tree" aria-label={label} className="nav-tree">
      {renderNodes(nodes, 0)}
    </ul>
  );
}
