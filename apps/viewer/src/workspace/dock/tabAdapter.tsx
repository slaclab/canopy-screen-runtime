// The portal adapters that mount React chrome into dockview's elements,
// and the drag-start helper every drag the dock starts itself goes through.
//
// One bar per tile. The tile bar is mounted as the group's **prefix** header action, and the
// showing tab's header controls plus the window-menu slot as its **right** header action, so
// a tile has exactly one bar however many tabs it holds. Each header renderer registers its
// element in a `PortalRegistry` (slot `bar` or `actions`, keyed by tile id = group id), and
// `TileBarPortals` (rendered once inside the viewer's React tree) portals the caller's React
// into each registered element. `dispose` unregisters, which removes the portal: dockview
// disposes and rebuilds every group on `fromJSON`/Reset.
//
// dockview's own per-panel tabs and its void container (a group-drag surface) are hidden by
// the bar renderer with inline styles on the header it is attached to — never by a stylesheet
// rule on dockview's classes. The bar's own grip is the tile's drag handle. The hidden tab
// strip also loses its tab/tablist semantics, so every `role=tab` in a dock is a tile bar's.
//
// Drag sources: `dataTransfer.getData` is empty during `dragover`, so every drag the
// docks start themselves — tile-bar tabs, the tile grip, strip tabs — records its `Source` in
// module state through `dockDragStart` at `dragstart`, and the bridge reads it back with
// `dockDragSource()` while it hit-tests. The transfer carries `DOCK_SOURCE_MIME` only so a
// drag of ours is told apart from a foreign one by its types. The record is cleared at
// `dragend` (or by the bridge through `clearDockDrag`); `onDockDragStart` lets the bridge
// raise its drag shield from the same hook.
//
// This module never constructs a dockview; `createDock.ts` and the page are its callers.
import { useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { IDockviewGroupPanel, IGroupHeaderProps, IHeaderActionsRenderer } from 'dockview-core';
import type { Source } from '@slaclab/canopy-dock-engine';

/** Elements inside the bar that act on a click and so must never start a drag. */
export const TILE_BAR_INTERACTIVE = 'button, select, input, textarea, a, [role="button"]';

// --- drag sources -------------------------------------------------------------------

/** The transfer type a drag of the dock's own carries (JSON of its `Source`). */
export const DOCK_SOURCE_MIME = 'application/x-canopy-dock-source';

let currentSource: Source | null = null;
let disarmEnd: (() => void) | null = null;
const startListeners = new Set<(source: Source) => void>();

function sourceText(source: Source): string {
  if ('tab' in source) return source.tab;
  if ('tile' in source) return source.tile;
  return source.new;
}

/**
 * Starts a drag of the dock's own: records `source` for the bridge, writes the transfer and
 * notifies `onDockDragStart` listeners. Called from the `dragstart` of tile-bar tabs, the
 * tile grip and strip tabs.
 */
export function dockDragStart(source: Source, dataTransfer: DataTransfer | null): void {
  currentSource = source;
  if (dataTransfer) {
    dataTransfer.setData(DOCK_SOURCE_MIME, JSON.stringify(source));
    dataTransfer.setData('text/plain', sourceText(source));
    dataTransfer.effectAllowed = 'move';
  }
  disarmEnd?.();
  if (typeof document !== 'undefined') {
    const onEnd = () => clearDockDrag();
    document.addEventListener('dragend', onEnd, true);
    disarmEnd = () => {
      document.removeEventListener('dragend', onEnd, true);
      disarmEnd = null;
    };
  }
  for (const listener of [...startListeners]) listener(source);
}

/** The source of the dock's own drag in progress, or null. */
export function dockDragSource(): Source | null {
  return currentSource;
}

/** Forgets the drag in progress (run at `dragend`; the bridge may call it after a drop). */
export function clearDockDrag(): void {
  currentSource = null;
  disarmEnd?.();
}

/** Subscribes to every `dockDragStart`; returns the unsubscribe. */
export function onDockDragStart(listener: (source: Source) => void): () => void {
  startListeners.add(listener);
  return () => {
    startListeners.delete(listener);
  };
}

// --- the portal registry ------------------------------------------------------------

type Listener = () => void;

interface PortalEntry {
  /** Unique per renderer instance. */
  readonly rendererId: string;
  /** The element dockview owns; the React content is portalled into it. */
  readonly element: HTMLElement;
}

/** A set of mounted renderers, as an external store for React. */
export class PortalRegistry<E extends PortalEntry> {
  private entries: readonly E[] = [];
  private readonly listeners = new Set<Listener>();

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): readonly E[] => this.entries;

  set(entry: E): void {
    const rest = this.entries.filter((e) => e.rendererId !== entry.rendererId);
    this.entries = [...rest, entry];
    this.emit();
  }

  remove(rendererId: string): void {
    if (!this.entries.some((e) => e.rendererId === rendererId)) return;
    this.entries = this.entries.filter((e) => e.rendererId !== rendererId);
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

export interface TileBarPortalsProps<E extends PortalEntry> {
  registry: PortalRegistry<E>;
  /** Renders the content for one entry (the caller supplies state and actions). */
  renderBar: (entry: E) => ReactNode;
}

/** Portals one rendering into each registered element. Render once, inside the viewer's tree. */
export function TileBarPortals<E extends PortalEntry>({
  registry,
  renderBar,
}: TileBarPortalsProps<E>) {
  const entries = useSyncExternalStore(
    registry.subscribe,
    registry.getSnapshot,
    registry.getSnapshot
  );
  return (
    <>{entries.map((entry) => createPortal(renderBar(entry), entry.element, entry.rendererId))}</>
  );
}

let nextRendererId = 0;

// --- one bar per tile: the group header actions ----------------------------------------

/** One tab of a tile as dockview holds it. */
export interface TileHeaderTab {
  readonly key: string;
  readonly title: string;
}

/** One mounted header renderer of a tile. */
export interface TileHeaderEntry extends PortalEntry {
  /** `bar` = the prefix action (the tile bar); `actions` = the right header actions. */
  readonly slot: 'bar' | 'actions';
  /** The tile id, which is the dockview group id. */
  readonly tile: string;
  /** The group's panels in order (the tile's tabs, as dockview renders them). */
  readonly tabs: readonly TileHeaderTab[];
  /** The group's active panel (the showing tab), or null while it has none. */
  readonly showing: string | null;
  /** Shows `key` in the group: dockview's half of a tab click (the reducer is told apart). */
  readonly activate: (key: string) => void;
}

export type TileHeaderRegistry = PortalRegistry<TileHeaderEntry>;

/** The header-action mount of the tile bar, for `TileBarPortals`. */
export function createTileHeaderRegistry(): TileHeaderRegistry {
  return new PortalRegistry<TileHeaderEntry>();
}

const HIDDEN_TAB_ATTRIBUTES = ['role', 'aria-orientation'];
const TAB_ATTRIBUTES = ['role', 'tabindex', 'aria-selected', 'aria-controls'];

/** Writes one inline style only when it differs, so the header observer sees no echo. */
function setStyle(element: HTMLElement, name: 'flex' | 'minWidth' | 'display', value: string) {
  if (element.style[name] !== value) element.style[name] = value;
}

/**
 * Hides dockview's own tab strip and void container in the header holding `element` (the
 * prefix action) and lets the prefix and right-action containers share the header. Inline
 * styles only; idempotent.
 */
export function hideDockviewTabs(element: HTMLElement): void {
  const prefix = element.parentElement;
  const header = prefix?.parentElement;
  if (!prefix || !header) return;
  setStyle(prefix, 'flex', '1 1 auto');
  setStyle(prefix, 'minWidth', '0');
  setStyle(prefix, 'display', 'flex');
  for (const child of header.children) {
    if (!(child instanceof HTMLElement) || child === prefix) continue;
    const list = child.classList.contains('dv-tabs-container')
      ? child
      : child.querySelector<HTMLElement>('.dv-tabs-container');
    if (list || child.classList.contains('dv-void-container')) {
      setStyle(child, 'display', 'none');
      if (child.getAttribute('aria-hidden') !== 'true') child.setAttribute('aria-hidden', 'true');
      for (const name of HIDDEN_TAB_ATTRIBUTES) {
        if (list?.hasAttribute(name)) list.removeAttribute(name);
      }
      for (const tab of child.querySelectorAll('.dv-tab')) {
        for (const name of TAB_ATTRIBUTES) {
          if (tab.hasAttribute(name)) tab.removeAttribute(name);
        }
      }
    } else if (child.classList.contains('dv-right-actions-container')) {
      setStyle(child, 'flex', '0 1 auto');
      setStyle(child, 'minWidth', '0');
    }
  }
}

class TileHeaderRenderer implements IHeaderActionsRenderer {
  readonly element: HTMLElement;
  private readonly rendererId = `tile-header-${++nextRendererId}`;
  private readonly disposers: (() => void)[] = [];
  private panelSubscriptions: { dispose(): void }[] = [];
  private observer: MutationObserver | null = null;
  private disposed = false;
  private group: IDockviewGroupPanel | null = null;
  private readonly registry: TileHeaderRegistry;
  private readonly slot: 'bar' | 'actions';

  constructor(registry: TileHeaderRegistry, slot: 'bar' | 'actions') {
    this.registry = registry;
    this.slot = slot;
    this.element = document.createElement('div');
    this.element.className =
      slot === 'bar' ? 'canopy-tile-bar-host' : 'canopy-tile-bar-host canopy-tile-actions-host';
  }

  init(params: IGroupHeaderProps): void {
    const { group } = params;
    this.group = group;
    const subscriptions = [
      group.model.onDidAddPanel(() => this.refresh()),
      group.model.onDidRemovePanel(() => this.refresh()),
      group.model.onDidActivePanelChange(() => this.refresh()),
      params.containerApi.onDidLayoutChange(() => this.hide()),
    ];
    for (const subscription of subscriptions) this.disposers.push(() => subscription.dispose());
    this.refresh();
    // dockview attaches the element to the header right after init.
    queueMicrotask(() => this.hide());
  }

  dispose(): void {
    this.disposed = true;
    this.observer?.disconnect();
    this.observer = null;
    for (const subscription of this.panelSubscriptions.splice(0)) subscription.dispose();
    for (const dispose of this.disposers.splice(0)) dispose();
    this.registry.remove(this.rendererId);
  }

  private refresh(): void {
    const group = this.group;
    if (this.disposed || !group) return;
    for (const subscription of this.panelSubscriptions.splice(0)) subscription.dispose();
    this.panelSubscriptions = group.panels.map((panel) =>
      panel.api.onDidTitleChange(() => this.register())
    );
    this.register();
    this.hide();
  }

  private register(): void {
    const group = this.group;
    if (this.disposed || !group) return;
    this.registry.set({
      rendererId: this.rendererId,
      element: this.element,
      slot: this.slot,
      tile: group.id,
      tabs: group.panels.map((panel) => ({ key: panel.id, title: panel.title ?? panel.id })),
      showing: group.activePanel?.id ?? null,
      activate: (key) => {
        const panel = group.panels.find((p) => p.id === key);
        if (panel && group.activePanel !== panel) panel.api.setActive();
      },
    });
  }

  /** The bar slot hides dockview's tabs, and keeps them hidden when dockview rebuilds them. */
  private hide(): void {
    if (this.disposed || this.slot !== 'bar') return;
    hideDockviewTabs(this.element);
    const header = this.element.parentElement?.parentElement;
    if (!header || this.observer || typeof MutationObserver === 'undefined') return;
    this.observer = new MutationObserver(() => {
      if (!this.disposed) hideDockviewTabs(this.element);
    });
    this.observer.observe(header, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['role', 'tabindex', 'style'],
    });
  }
}

/** The dockview options that mount the tile bar and its right-hand actions on every group. */
export function createTileHeaderActions(registry: TileHeaderRegistry): {
  createPrefixHeaderActionComponent: (group: IDockviewGroupPanel) => IHeaderActionsRenderer;
  createRightHeaderActionComponent: (group: IDockviewGroupPanel) => IHeaderActionsRenderer;
} {
  return {
    createPrefixHeaderActionComponent: () => new TileHeaderRenderer(registry, 'bar'),
    createRightHeaderActionComponent: () => new TileHeaderRenderer(registry, 'actions'),
  };
}
