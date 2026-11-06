// A PNG of a screen as displayed. Trace exports its plots through ECharts'
// own getDataURL; a screen is a DOM tree of widgets (SVG plots, canvases,
// images, Carbon controls), so it is rasterised with modern-screenshot, which
// clones the subtree into an SVG foreignObject with its computed styles,
// inlines the fonts it uses, images and canvases (as bitmaps), and draws that
// onto a canvas. The element passed is the box that already carries the
// current zoom, so the image has the on-screen size; `pixelRatio` adds
// device pixels on top (2 on a HiDPI display) for a sharp image.

import { domToBlob } from 'modern-screenshot';

export async function captureElementPng(
  element: HTMLElement,
  pixelRatio: number = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1
): Promise<Blob> {
  const blob = await domToBlob(element, { type: 'image/png', scale: pixelRatio });
  if (blob.size === 0) throw new Error('The screen rendered to an empty image');
  return blob;
}
