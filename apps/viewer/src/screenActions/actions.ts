// The screen actions, in header order. Each entry declares what it needs from
// the context (isAvailable) and what it does (run); ScreenActionBar renders
// and binds whatever is available. To add an action, add an entry here.

import { ChartLineData, Download, Image, Link, Printer, Renew } from '@carbon/icons-react';
import { captureElementPng } from './capture.js';
import { copyText } from './clipboard.js';
import { fileStem, saveBlob, timestamp } from './files.js';
import { applyPrintLayout, clearPrintLayout, printLayout, printMarked } from './print.js';
import type { ScreenAction, ScreenActionContext } from './types.js';

/** Re-fetch the screen and remount it, which reconnects its PVs. */
export const reloadAction: ScreenAction = {
  id: 'reload',
  label: 'Reload screen',
  icon: Renew,
  isAvailable: (ctx) => typeof ctx.screen.reload === 'function',
  run: (ctx) => ctx.screen.reload?.(),
};

/** Save the screen document exactly as served, as `<id>.screen.json`. */
export const downloadAction: ScreenAction = {
  id: 'download',
  label: 'Download screen',
  icon: Download,
  shortcut: 's',
  isAvailable: (ctx) => ctx.screen.documentUrl !== '',
  run: async (ctx) => {
    const response = await fetch(ctx.screen.documentUrl, { cache: 'no-cache' });
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText} fetching the screen`);
    }
    const body = await response.blob();
    const blob = body.type ? body : new Blob([body], { type: 'application/json' });
    saveBlob(blob, `${fileStem(ctx.screen.id)}.screen.json`);
  },
};

/** A PNG of the screen at its current zoom, `<id>-<YYYYmmdd-HHMMSS>.png`. */
export const exportPngAction: ScreenAction = {
  id: 'export-png',
  label: 'Export PNG',
  icon: Image,
  shortcut: 'i',
  isAvailable: (ctx) => ctx.screen.element !== null,
  run: async (ctx) => {
    const element = ctx.screen.element;
    if (!element) return;
    const stamp = timestamp();
    const blob = await captureElementPng(element);
    saveBlob(blob, `${fileStem(ctx.screen.id)}-${stamp}.png`);
  },
};

/** Print the screen alone, fitted to the page (see print.ts). */
export const printAction: ScreenAction = {
  id: 'print',
  label: 'Print',
  icon: Printer,
  shortcut: 'p',
  isAvailable: (ctx) => ctx.screen.element !== null && typeof window.print === 'function',
  run: (ctx) => {
    // beforeprint applies the same layout; applying it here as well keeps
    // the page right where that event does not fire before printing.
    const size = ctx.screen.size;
    if (size) applyPrintLayout(printLayout(size.width, size.height));
    try {
      // Mark this screen's own tile, so a split layout prints it.
      printMarked(ctx.screen.element, () => window.print());
    } finally {
      if (size) clearPrintLayout();
    }
  },
};

/** Pick PVs of the screen and open them in the data browser (the host's chooser). */
export const plotAction: ScreenAction = {
  id: 'plot-data-browser',
  label: 'Plot in Data Browser',
  icon: ChartLineData,
  isAvailable: (ctx) =>
    typeof ctx.plotInDataBrowser === 'function' && typeof ctx.screen.collectPVs === 'function',
  run: (ctx) => ctx.plotInDataBrowser?.(ctx.screen),
};

/** Copy a URL that reopens exactly this screen with its macros. */
export const copyLinkAction: ScreenAction = {
  id: 'copy-link',
  label: 'Copy link',
  icon: Link,
  isAvailable: (ctx) => typeof ctx.link === 'string' && ctx.link !== '',
  run: async (ctx) => {
    if (!ctx.link) return;
    await copyText(ctx.link);
    return { message: 'Copied' };
  },
};

export const SCREEN_ACTIONS: readonly ScreenAction[] = [
  plotAction,
  reloadAction,
  downloadAction,
  exportPngAction,
  printAction,
  copyLinkAction,
];

/** The actions of `actions` available in `ctx`, in order. */
export function availableActions(
  ctx: ScreenActionContext,
  actions: readonly ScreenAction[] = SCREEN_ACTIONS
): ScreenAction[] {
  return actions.filter((action) => {
    try {
      return action.isAvailable(ctx);
    } catch {
      return false;
    }
  });
}
