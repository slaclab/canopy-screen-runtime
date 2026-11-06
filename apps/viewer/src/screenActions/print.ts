// Printing a screen. The print stylesheet (index.css, @media print) hides
// every bit of viewer chrome — tree, splitter, tab strip, header, banners —
// and shows the screen at its authored size, scaled by --canopy-print-scale.
// That variable and the page orientation are set just before the browser
// lays the page out (the `beforeprint` event), from the open screen's size,
// so a browser-menu print gets the same page as the Print action and the
// shortcut.
//
// In a split layout the print rule shows one docked tile: the one marked
// [data-printing] while the Print action runs (the tile whose bar invoked
// it), else the focused one (a browser-menu print).
//
// The page box is not knowable from script, so the fit targets the smaller
// of A4 and US Letter less 10 mm margins: whichever paper is loaded, the
// screen fits. Unlike fit-to-view, a print shrinks but never magnifies.

import { useEffect } from 'react';
import { OVERLAY_ITEM_CLASS } from '../workspace/dock/DockOverlay.js';
import { fitScale } from '../zoom.js';

const MM = 96 / 25.4; // CSS px per millimetre
const MARGIN_MM = 10;
/** Printable box of the smaller of A4 and Letter, portrait, in CSS px. */
const PAGE_SHORT = (Math.min(210, 215.9) - 2 * MARGIN_MM) * MM;
const PAGE_LONG = (Math.min(297, 279.4) - 2 * MARGIN_MM) * MM;

export const PRINT_SCALE_VAR = '--canopy-print-scale';
const PAGE_STYLE_ID = 'canopy-print-page';

export interface PrintLayout {
  orientation: 'portrait' | 'landscape';
  scale: number;
}

/**
 * The orientation and scale that fit a `width` x `height` screen on one page.
 * A print shrinks a screen larger than the page and never magnifies one.
 */
export function printLayout(width: number, height: number): PrintLayout {
  const orientation = width > height ? 'landscape' : 'portrait';
  const [pageWidth, pageHeight] =
    orientation === 'landscape' ? [PAGE_LONG, PAGE_SHORT] : [PAGE_SHORT, PAGE_LONG];
  const fit = Math.min(fitScale(pageWidth, pageHeight, width, height), 1);
  const scale = Math.floor(fit * 1000) / 1000;
  return { orientation, scale };
}

/** Apply the layout for a print: the scale variable and an @page rule. */
export function applyPrintLayout(layout: PrintLayout): void {
  document.documentElement.style.setProperty(PRINT_SCALE_VAR, String(layout.scale));
  let style = document.getElementById(PAGE_STYLE_ID);
  if (!style) {
    style = document.createElement('style');
    style.id = PAGE_STYLE_ID;
    document.head.appendChild(style);
  }
  style.textContent = `@page { size: ${layout.orientation}; margin: ${MARGIN_MM}mm; }`;
}

/** Undo applyPrintLayout. */
export function clearPrintLayout(): void {
  document.documentElement.style.removeProperty(PRINT_SCALE_VAR);
  document.getElementById(PAGE_STYLE_ID)?.remove();
}

/** The docked tile element a screen renders in (the dock overlay's item). */
const TILE_SELECTOR = `.${OVERLAY_ITEM_CLASS}`;
export const PRINTING_ATTR = 'data-printing';

/**
 * Run `print` with the docked tile holding `element` marked as the one to
 * print, and unmark it afterwards, also when `print` throws. The marker is a
 * plain DOM attribute because window.print() blocks: a React state update
 * would not commit before the page is laid out. A screen outside the dock
 * (the /s/ page) has no tile, and the print runs unmarked.
 */
export function printMarked(element: HTMLElement | null, print: () => void): void {
  const tile = element?.closest<HTMLElement>(TILE_SELECTOR) ?? null;
  tile?.setAttribute(PRINTING_ATTR, 'true');
  try {
    print();
  } finally {
    tile?.removeAttribute(PRINTING_ATTR);
  }
}

/**
 * While mounted with a size, fit every print of this document to that
 * screen. The open screen's page calls it; with none open a print keeps the
 * browser's defaults.
 */
export function usePrintFit(size: { width: number; height: number } | undefined): void {
  const width = size?.width;
  const height = size?.height;
  useEffect(() => {
    if (width === undefined || height === undefined) return;
    const before = () => applyPrintLayout(printLayout(width, height));
    window.addEventListener('beforeprint', before);
    window.addEventListener('afterprint', clearPrintLayout);
    return () => {
      window.removeEventListener('beforeprint', before);
      window.removeEventListener('afterprint', clearPrintLayout);
      clearPrintLayout();
    };
  }, [width, height]);
}
