// Clickable-area affordances and the resting outline, both drawn on a node's
// positioned wrapper.
//
// - A node whose click runs actions shows a pointer cursor; while hovered it
//   draws a layer over its box: a translucent accent fill, an accent outline
//   and, when the node carries `props.hoverLabel`, that label inside its box,
//   bottom-left unless `props.hoverLabelPlacement` names another corner or
//   `center`. The layer and the label are inert to the pointer, so clicks
//   still reach the wrapper.
// - Any node may carry `props.outlineColor` (a color, after role resolution a
//   CSS string) and `props.outlineWidth` (authored px, default 2): an outline
//   drawn just inside its box. Being plain props, both are rule targets, so a
//   rule can tint the outline from live data.
//
// Colors come from scheme roles, so both themes work: the accent is
// `ActiveText`, the label chip uses `Background` and `Text`.

import type { CSSProperties } from 'react';
import type { ColorRole, FlatScheme } from '@slaclab/canopy-screen-ir';
import { resolveRole } from '../theme/resolveRoles.js';

const ACCENT: ColorRole = { $role: 'ActiveText', fallback: '#0f62fe', fallbackDark: '#78a9ff' };
const LABEL_BACKGROUND: ColorRole = {
  $role: 'Background',
  fallback: '#ffffff',
  fallbackDark: '#161616',
};
const LABEL_TEXT: ColorRole = { $role: 'Text', fallback: '#161616', fallbackDark: '#f4f4f4' };

/** Opacity of the accent fill over a hovered node. */
const FILL_OPACITY = 0.14;
const HOVER_OUTLINE_WIDTH = 2;
const DEFAULT_OUTLINE_WIDTH = 2;

/** The resting outline `props` asks for, as wrapper style, or null for none. */
export function restingOutline(
  props: Readonly<Record<string, unknown>>
): Pick<CSSProperties, 'outline' | 'outlineOffset'> | null {
  const color = props.outlineColor;
  if (typeof color !== 'string' || color === '') return null;
  const raw = props.outlineWidth;
  const width = typeof raw === 'number' && Number.isFinite(raw) ? raw : DEFAULT_OUTLINE_WIDTH;
  if (width <= 0) return null;
  return { outline: `${width}px solid ${color}`, outlineOffset: -width };
}

/** The `hoverLabel` of `props`, or null when it has none. */
export function hoverLabel(props: Readonly<Record<string, unknown>>): string | null {
  const label = props.hoverLabel;
  return typeof label === 'string' && label !== '' ? label : null;
}

/** Where the hover label sits inside the node: flex alignment per placement. */
const PLACEMENTS = {
  'bottom-left': { alignItems: 'flex-end', justifyContent: 'flex-start' },
  'bottom-right': { alignItems: 'flex-end', justifyContent: 'flex-end' },
  'top-left': { alignItems: 'flex-start', justifyContent: 'flex-start' },
  'top-right': { alignItems: 'flex-start', justifyContent: 'flex-end' },
  center: { alignItems: 'center', justifyContent: 'center' },
} as const;

export type HoverLabelPlacement = keyof typeof PLACEMENTS;

/** The `hoverLabelPlacement` of `props`; bottom-left when absent or unknown. */
export function hoverLabelPlacement(props: Readonly<Record<string, unknown>>): HoverLabelPlacement {
  const placement = props.hoverLabelPlacement;
  return typeof placement === 'string' && Object.hasOwn(PLACEMENTS, placement)
    ? (placement as HoverLabelPlacement)
    : 'bottom-left';
}

/** Gap between the hover label and the node's edges, authored px. */
const LABEL_INSET = 6;

/** The layer a hovered clickable node draws over its box. */
export function HoverLayer({
  label,
  placement = 'bottom-left',
  flat,
}: {
  label: string | null;
  placement?: HoverLabelPlacement;
  flat: FlatScheme;
}) {
  const accent = resolveRole(ACCENT, flat);
  return (
    <div
      data-canopy-hover=""
      data-placement={placement}
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        outline: `${HOVER_OUTLINE_WIDTH}px solid ${accent}`,
        outlineOffset: -HOVER_OUTLINE_WIDTH,
        display: 'flex',
        padding: LABEL_INSET,
        boxSizing: 'border-box',
        ...PLACEMENTS[placement],
      }}
    >
      <div
        data-canopy-hover-fill=""
        style={{ position: 'absolute', inset: 0, background: accent, opacity: FILL_OPACITY }}
      />
      {label !== null && (
        <span
          style={{
            position: 'relative',
            pointerEvents: 'none',
            padding: '4px 10px',
            borderRadius: 4,
            border: `1px solid ${accent}`,
            background: resolveRole(LABEL_BACKGROUND, flat),
            color: resolveRole(LABEL_TEXT, flat),
            font: '600 16px/1.2 system-ui, sans-serif',
            whiteSpace: 'nowrap',
            boxShadow: '0 1px 4px rgba(0, 0, 0, 0.3)',
          }}
        >
          {label}
        </span>
      )}
    </div>
  );
}
