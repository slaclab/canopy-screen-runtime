import { useCallback, useLayoutEffect, useRef, useState } from 'react';

/** Smallest font-size we ever shrink to; below this text is just clipped. */
export const MIN_FONT_SIZE = 8;

/**
 * Pure shrink-to-fit step: given the element's measured overflow size, the box
 * it must fit inside, and the current font-size, return the next font-size to
 * try. Shrinks only downward and never below `min`.
 *
 * The caller measures `scrollWidth`/`scrollHeight` (content size) against
 * `clientWidth`/`clientHeight` (box size). When content overflows in either
 * axis we scale the font down proportionally to the worst-fitting axis, with a
 * small safety factor, then floor at `min`. Returns the *same* size when it
 * already fits (or is already at the floor) so callers can stop iterating.
 */
export function computeFitFontSize(args: {
  current: number;
  scrollWidth: number;
  scrollHeight: number;
  clientWidth: number;
  clientHeight: number;
  min?: number;
}): number {
  const { current, scrollWidth, scrollHeight, clientWidth, clientHeight } = args;
  const min = args.min ?? MIN_FONT_SIZE;

  if (current <= min) return min;
  if (clientWidth <= 0 || clientHeight <= 0) return current;

  const overflowsW = scrollWidth > clientWidth + 0.5;
  const overflowsH = scrollHeight > clientHeight + 0.5;
  if (!overflowsW && !overflowsH) return current;

  // Scale to the worst-fitting axis. Guard against zero content size.
  const ratioW = scrollWidth > 0 ? clientWidth / scrollWidth : 1;
  const ratioH = scrollHeight > 0 ? clientHeight / scrollHeight : 1;
  const ratio = Math.min(overflowsW ? ratioW : 1, overflowsH ? ratioH : 1);

  // 0.92 safety factor avoids oscillating just above the boundary; clamp so we
  // always make progress (shrink by at least 1px) and never drop below `min`.
  const next = Math.floor(current * ratio * 0.92);
  return Math.max(min, Math.min(current - 1, next));
}

export interface UseFitTextResult<T extends HTMLElement> {
  ref: React.RefObject<T | null>;
  fontSize: number;
}

/**
 * The box text must fit inside: the content box of the text element's parent.
 * The element's own box is no reference: a flex item sized to its text has a
 * client box equal to its content, and with a line-height at or below the
 * glyph extent its scrollHeight exceeds its clientHeight at every size, which
 * reads as overflow on every pass.
 */
function fitBox(el: HTMLElement): { width: number; height: number } {
  const box = el.parentElement;
  if (!box) return { width: el.clientWidth, height: el.clientHeight };
  const style = getComputedStyle(box);
  const px = (v: string) => parseFloat(v) || 0;
  return {
    width: box.clientWidth - px(style.paddingLeft) - px(style.paddingRight),
    height: box.clientHeight - px(style.paddingTop) - px(style.paddingBottom),
  };
}

/**
 * Shrink-to-fit hook. Returns a ref to attach to the text element and the
 * computed font-size to apply. Starts from `maxFontSize` and steps the size
 * down (via `computeFitFontSize`) until the element's content fits inside its
 * parent's content box or hits the floor.
 *
 * `deps` should include anything that changes the rendered text (label, value)
 * so the fit is recomputed. Box-size changes are picked up automatically via a
 * ResizeObserver.
 *
 * Measurement and the resulting setState happen inside the ResizeObserver
 * callback / a guarded layout pass — state is only written when the value
 * actually changes, so this never trips react-hooks/set-state-in-effect.
 */
export function useFitText<T extends HTMLElement>(
  maxFontSize: number,
  deps: ReadonlyArray<unknown> = [],
  min: number = MIN_FONT_SIZE,
  enabled: boolean = true
): UseFitTextResult<T> {
  const ref = useRef<T | null>(null);
  const [fontSize, setFontSize] = useState(maxFontSize);

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    // Iterate from the max downward each pass so growing the box (or shorter
    // text) can recover a larger size. Bounded by the integer font range.
    let size = maxFontSize;
    const box = fitBox(el);
    for (let i = 0; i < maxFontSize; i++) {
      el.style.fontSize = `${size}px`;
      const next = computeFitFontSize({
        current: size,
        scrollWidth: el.scrollWidth,
        scrollHeight: el.scrollHeight,
        clientWidth: box.width,
        clientHeight: box.height,
        min,
      });
      if (next === size) break;
      size = next;
    }
    // Only commit when it changed — keeps this off the set-state-in-effect path.
    setFontSize((prev) => (prev === size ? prev : size));
  }, [maxFontSize, min]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!enabled) return;
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    if (el.parentElement) ro.observe(el.parentElement);
    return () => ro.disconnect();
    // measure depends on maxFontSize/min; `deps` carries text changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [measure, enabled, ...deps]);

  return { ref, fontSize: enabled ? fontSize : maxFontSize };
}
