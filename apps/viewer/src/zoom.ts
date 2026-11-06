// Zoom arithmetic for the embed toolbar: the fit-to-view scale, the manual
// zoom ladder, and the percentage label. Pure functions; ZoomContext.tsx holds
// the state and ScreenPage applies the scale as a CSS transform.

/** Manual zoom rungs, ascending. `−`/`+` move between neighbours. */
export const ZOOM_LADDER: readonly number[] = [
  0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 3, 4,
];

/** Float noise below this counts as "on the rung" (0.3333 steps like 0.33). */
const RUNG_TOLERANCE = 0.005;

/**
 * The scale that shows a whole `screenWidth` x `screenHeight` panel inside an
 * `availableWidth` x `availableHeight` area: the tighter axis wins, so the
 * panel keeps its aspect ratio and fills the area, shrinking or magnifying.
 * An unmeasured area (0, as in jsdom or before layout) or a degenerate screen
 * falls back to 1.
 */
export function fitScale(
  availableWidth: number,
  availableHeight: number,
  screenWidth: number,
  screenHeight: number
): number {
  const dims = [availableWidth, availableHeight, screenWidth, screenHeight];
  if (dims.some((d) => !Number.isFinite(d) || d <= 0)) return 1;
  return Math.min(availableWidth / screenWidth, availableHeight / screenHeight);
}

/**
 * The next ladder rung above (`direction` 1) or below (-1) `current`. An
 * off-ladder scale (a fit result such as 0.47) steps to the nearest rung in
 * that direction; the ends of the ladder clamp.
 */
export function stepZoom(current: number, direction: 1 | -1): number {
  const first = ZOOM_LADDER[0]!;
  const last = ZOOM_LADDER[ZOOM_LADDER.length - 1]!;
  if (direction > 0) {
    return ZOOM_LADDER.find((rung) => rung > current + RUNG_TOLERANCE) ?? last;
  }
  return [...ZOOM_LADDER].reverse().find((rung) => rung < current - RUNG_TOLERANCE) ?? first;
}

/** Whether `scale` is a usable manual zoom (inside the ladder's range). */
export function isValidScale(scale: unknown): scale is number {
  return (
    typeof scale === 'number' &&
    Number.isFinite(scale) &&
    scale >= ZOOM_LADDER[0]! &&
    scale <= ZOOM_LADDER[ZOOM_LADDER.length - 1]!
  );
}

/** `0.4666` -> `'47%'`. */
export function formatPercent(scale: number): string {
  return `${Math.round(scale * 100)}%`;
}
