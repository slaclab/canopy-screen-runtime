// Places one overlay element over its tile. dockview owns an empty placeholder
// per tab key; this hook copies the content rect of the placeholder's group (the
// `.dv-content-container`, i.e. the tile below its bar) onto the overlay element as inline
// top/left/width/height, relative to the overlay layer (the element's parent).
//
// Triggers: dockview's layout change, active-group change and active-panel change, a
// `fromJSON` rebuild (onDidLayoutFromJSON), a window resize, and a ResizeObserver on the
// group's content container (continuous sash drags emit no per-frame dockview event).
//
// Every layout change of the holder (a drop, a tab switch, a restore) reaches the dock as a
// `fromJSON` (applyLayout.ts), which disposes every group and builds new content containers.
// The rebuild event re-places and re-targets at once, so an item never sits at the old
// tile's rect or watches a detached node; as a second line, an observer callback that finds
// its node detached re-targets too. Otherwise the observer's callback only re-applies
// geometry and re-targeting happens on the settle events, so observe()'s own initial
// callback cannot recurse. No synthetic `resize` is dispatched anywhere.
//
// Tabs: every tab of a tile has a placeholder panel in the tile's group, and only
// the showing tab is the group's active panel. A key with no placeholder, or whose
// placeholder is not its group's active panel (a hidden tab), is marked
// `data-placed="false"` and its inline geometry cleared: it stays mounted but takes no
// input and is never left at a stale rect.
import { useLayoutEffect, useState } from 'react';
import type { DockviewApi } from 'dockview-core';

/** dockview-core 7.0.2's class for a group's content area (components/panel/content.js). */
export const CONTENT_CONTAINER = '.dv-content-container';

/** The minimal api surface the hook reads; a real `DockviewApi` satisfies it. */
export type TileRectApi = Pick<
  DockviewApi,
  | 'getPanel'
  | 'onDidLayoutChange'
  | 'onDidActiveGroupChange'
  | 'onDidActivePanelChange'
  | 'onDidLayoutFromJSON'
>;

/** The content container of `key`'s tile, or null when the key is not shown in a tile. */
export function tileContent(api: TileRectApi, key: string): HTMLElement | null {
  const panel = api.getPanel(key);
  const group = panel?.group;
  if (!panel || !group || group.activePanel !== panel) return null;
  return group.element.querySelector<HTMLElement>(CONTENT_CONTAINER);
}

/** Copies `key`'s tile content rect onto `el`, or marks it unplaced. */
export function applyTileRect(api: TileRectApi, key: string, el: HTMLElement): void {
  const content = tileContent(api, key);
  if (!content) {
    el.style.top = '';
    el.style.left = '';
    el.style.width = '';
    el.style.height = '';
    el.dataset.placed = 'false';
    return;
  }
  const base = (el.parentElement ?? el).getBoundingClientRect();
  const rect = content.getBoundingClientRect();
  el.style.top = `${Math.round(rect.top - base.top)}px`;
  el.style.left = `${Math.round(rect.left - base.left)}px`;
  el.style.width = `${Math.round(rect.width)}px`;
  el.style.height = `${Math.round(rect.height)}px`;
  el.dataset.placed = 'true';
}

/**
 * Returns a callback ref for the overlay element of `key`. A new element (React remounting
 * the wrapper) re-binds every subscription to it; a null api leaves the element untouched.
 */
export function useTileRect(
  api: TileRectApi | null,
  key: string
): (el: HTMLElement | null) => void {
  const [el, setEl] = useState<HTMLElement | null>(null);

  useLayoutEffect(() => {
    if (!api || !el) return;
    const apply = (): void => applyTileRect(api, key, el);

    let observed: HTMLElement | null = null;
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            // A rebuild detached the watched node: follow the tile to its new container.
            if (observed && !observed.isConnected) sync();
            else apply();
          });
    const rewire = (): void => {
      const target = tileContent(api, key);
      if (target === observed) return;
      observer?.disconnect();
      observed = target;
      if (target) observer?.observe(target);
    };
    const sync = (): void => {
      apply();
      rewire();
    };

    sync();
    const subscriptions = [
      api.onDidLayoutChange(sync),
      api.onDidActiveGroupChange(sync),
      api.onDidActivePanelChange(sync),
      api.onDidLayoutFromJSON(sync),
    ];
    window.addEventListener('resize', sync);
    return () => {
      window.removeEventListener('resize', sync);
      for (const subscription of subscriptions) subscription.dispose();
      observer?.disconnect();
    };
  }, [api, key, el]);

  return setEl;
}
