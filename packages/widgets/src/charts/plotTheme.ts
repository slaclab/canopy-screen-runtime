// Plot chrome theming shared by every ECharts widget of this package.

/**
 * Plot chrome colours as CSS `light-dark()` strings, so the browser picks the arm from
 * the page's `color-scheme` and the option never depends on the mode. The light arm is
 * the colour ECharts 6.1.0 draws by default (`tokens.color` in echarts/lib/visual/tokens),
 * so light mode renders exactly as it did before; the dark arm is the Carbon g100 token.
 */
export const PLOT_COLORS = {
  /** Title text: ECharts `primary` / g100 text-primary. */
  title: 'light-dark(#3c3c41, #f4f4f4)',
  /** Axis labels, axis names and legend text: ECharts `axisLabel`/`secondary` / g100 text-secondary. */
  text: 'light-dark(#54555a, #c6c6c6)',
  /** Axis line and ticks: ECharts `axisLine` / g100 border-strong-01. */
  axisLine: 'light-dark(#54555a, #6f6f6f)',
  /** Grid lines: ECharts `axisSplitLine` / g100 border-subtle-01. */
  splitLine: 'light-dark(#dbdee4, #393939)',
} as const;

/** Axis chrome coloured with PLOT_COLORS; callers merge their own axis settings on top. */
export function themedAxisParts(): {
  axisLine: { lineStyle: { color: string } };
  axisLabel: { color: string };
  nameTextStyle: { color: string };
  splitLine: { lineStyle: { color: string } };
} {
  return {
    axisLine: { lineStyle: { color: PLOT_COLORS.axisLine } },
    axisLabel: { color: PLOT_COLORS.text },
    nameTextStyle: { color: PLOT_COLORS.text },
    splitLine: { lineStyle: { color: PLOT_COLORS.splitLine } },
  };
}

/**
 * Hover styling pinned to the series colour. ECharts' default emphasis lifts (lightens)
 * the normal colour, and that lift fails on CSS strings such as `var()` or
 * `light-dark()`, so a hovered line or symbol would vanish without this.
 */
export function emphasisFor(color: string | undefined): Record<string, unknown> | undefined {
  if (color === undefined || color === '') return undefined;
  return { lineStyle: { color }, itemStyle: { color } };
}
