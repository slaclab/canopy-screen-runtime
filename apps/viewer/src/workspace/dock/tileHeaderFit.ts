// How a screen header inside a dock tile bar fits the lane the tile leaves it:
// the step it collapses to (tileStep), the floor it keeps beside the tabs
// (tileFloor), and the hook that measures the header and reports both
// (useTileStep). ScreenHeader renders the step; the tile's actions provide the
// TileHeaderContext it reads.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { TileHeaderFit } from './TileBar.js';

/** The action bar's width without its transient status text. */
export function actionsWidth(global: HTMLElement): number {
  const status = global.querySelector<HTMLElement>('.screen-actions__status');
  return global.offsetWidth - (status?.offsetWidth ?? 0);
}

/** The title's least width before it goes (it ellipsizes down to this). */
export const TILE_TITLE_MIN_PX = 64;
/** The title block's padding, and the gap before the path. */
const INFO_PAD_PX = 12;
const DETAIL_GAP_PX = 8;

/**
 * A tile header's step as its lane narrows: 0 all shows; 1 the path goes; 2 the title goes;
 * 3 the zoom group becomes its menu button; 4 the actions go into "⋯"; 5 ◀ ▶ join them;
 * 6 the zoom group joins them too.
 */
export type TileStep = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** What a tile header's parts need; each is measured while it shows and kept otherwise. */
export interface TileWidths {
  history: number;
  title: number;
  detail: number;
  zoom: number;
  actions: number;
}

/** The least step at which a tile header fits `width`. */
export function tileStep(
  width: number,
  w: TileWidths,
  fit: TileHeaderFit,
  has: { detail: boolean; zoom: boolean; actions: boolean }
): TileStep {
  const zoomButton = has.zoom ? fit.zoomButtonPx : 0;
  const actions = has.actions ? w.actions : 0;
  const zoom = has.zoom ? w.zoom : 0;
  const name = INFO_PAD_PX + Math.min(w.title, TILE_TITLE_MIN_PX);
  const path = INFO_PAD_PX + w.title + DETAIL_GAP_PX + w.detail;
  if (has.detail && width >= w.history + path + zoom + actions) return 0;
  if (width >= w.history + name + zoom + actions) return 1;
  if (width >= w.history + zoom + actions) return 2;
  if (width >= w.history + zoomButton + actions) return 3;
  if (width >= w.history + zoomButton + fit.triggerPx) return 4;
  if (width >= zoomButton + fit.triggerPx) return 5;
  return 6;
}

/** The tile header's floor: what it keeps in the bar at step 4 (◀ ▶, zoom button, "⋯"). */
export function tileFloor(w: TileWidths, fit: TileHeaderFit, has: { zoom: boolean }): number {
  return w.history + (has.zoom ? fit.zoomButtonPx : 0) + fit.triggerPx;
}

/** Reads the parts of a tile header that show now into `w`, keeping the others. */
function measureTile(root: HTMLElement, w: TileWidths): TileWidths {
  const next = { ...w };
  const header = root.querySelector('.cds--header');
  for (const child of header?.children ?? []) {
    if (!(child instanceof HTMLElement)) continue;
    const has = (name: string) => child.classList.contains(name);
    if (has('screen-header__history')) next.history = child.offsetWidth;
    else if (has('screen-header__zoom')) next.zoom = child.offsetWidth;
    else if (has('cds--header__global') && child.querySelector('[data-screen-action]')) {
      next.actions = actionsWidth(child);
    } else if (has('screen-header__info')) {
      const title = child.querySelector<HTMLElement>('.screen-header__title-text');
      const detail = child.querySelector<HTMLElement>('.screen-header__detail');
      if (title) next.title = title.offsetWidth;
      if (detail) next.detail = detail.offsetWidth;
    }
  }
  return next;
}

/**
 * The tile header's step, from the width of the lane the tile gives it. Every part is
 * measured while it shows and kept once it has gone, so the header comes back as the lane
 * widens. It reports its floor to the tile, which keeps that much beside the tabs.
 */
export function useTileStep(
  root: RefObject<HTMLDivElement | null>,
  fit: TileHeaderFit | null,
  has: { detail: boolean; zoom: boolean; actions: boolean }
): TileStep {
  const [step, setStep] = useState<TileStep>(0);
  const widths = useRef<TileWidths>({ history: 0, title: 0, detail: 0, zoom: 0, actions: 0 });
  const { detail, zoom, actions } = has;
  useLayoutEffect(() => {
    const el = root.current;
    if (!el || fit === null || typeof ResizeObserver === 'undefined') return;
    const flags = { detail, zoom, actions };
    const observer = new ResizeObserver(() => {
      widths.current = measureTile(el, widths.current);
      const w = widths.current;
      fit.reportNeed?.(tileFloor(w, fit, flags));
      // A width of 0 is no layout (jsdom, a hidden tile): nothing to collapse for.
      const width = el.clientWidth;
      setStep(width > 0 ? tileStep(width, w, fit, flags) : 0);
    });
    observer.observe(el);
    const header = el.querySelector('.cds--header');
    for (const part of header?.children ?? []) observer.observe(part);
    return () => observer.disconnect();
  }, [root, fit, step, detail, zoom, actions]);
  // Gone: the tile needs to keep no room for this header.
  useEffect(() => {
    if (fit === null) return;
    return () => fit.reportNeed?.(0);
  }, [fit]);
  return fit === null ? 0 : step;
}
