// Render mode: how the widget set presents what a screen's IR does not
// dictate — alarm presentation today, legacy chrome later.
//
// One switch, one table. Widgets never branch on the mode name; they read the
// profile's fields, so a new mode (e.g. an EDM-faithful "legacy chrome"
// theme) is a new row in RENDER_PROFILES plus whatever fields it needs.
//
//   edm     (default) the legacy screen's semantics on Carbon chrome: alarm-
//           sensitive text is recoloured with EDM's colors.list alarm colours
//           (no pills), alarm borders only where the IR asks for them, EDM's
//           disconnected outline, EDM text metrics (flush, left by default).
//   carbon  the Carbon presentation: severity pills, alarm borders on by
//           default, '---' placeholders, Carbon paddings/alignment.
//
// The viewer selects the mode (URL `?render=`, VITE_RENDER_MODE) and the
// screen runtime provides it through RenderModeContext.

import { createContext, useContext } from 'react';
import { CARBON_ALARM_PALETTE, EDM_ALARM_PALETTE } from './alarm.js';
import type { AlarmPalette } from './alarm.js';

export const RENDER_MODES = ['edm', 'carbon'] as const;
export type RenderMode = (typeof RENDER_MODES)[number];
export const DEFAULT_RENDER_MODE: RenderMode = 'edm';

/** A RenderMode from untrusted input (URL, env); undefined when unrecognised. */
export function parseRenderMode(value: unknown): RenderMode | undefined {
  return typeof value === 'string' && (RENDER_MODES as readonly string[]).includes(value)
    ? (value as RenderMode)
    : undefined;
}

export interface RenderProfile {
  readonly mode: RenderMode;
  /**
   * How a PV readout shows its alarm severity: `colour` recolours
   * alarm-sensitive content only (EDM fgAlarm; non-sensitive readouts ignore
   * severity), `pill` adds a severity tag to any alarming readout.
   */
  readonly alarmContent: 'colour' | 'pill';
  /** Severity colours for alarm-sensitive content and alarm borders. */
  readonly alarmPalette: AlarmPalette;
  /** `alarmSensitiveBorder` for widgets that don't set it. */
  readonly alarmBorderDefault: boolean;
  /**
   * A disconnected PV readout: `outline` = EDM's empty box outlined in the
   * palette's disconnected colour; `placeholder` = '---'.
   */
  readonly disconnected: 'outline' | 'placeholder';
  /**
   * Horizontal inset (px) of text drawn on an authored or display background
   * (labels, IR-coloured readouts); null keeps each widget's Carbon padding.
   */
  readonly textInset: number | null;
  /**
   * Horizontal padding (px) inside a Carbon field (uncoloured readout, text
   * input); null keeps Carbon's (8px readout, 16px input — which leaves ~8px
   * of text in a typical 40px EDM entry).
   */
  readonly fieldInset: number | null;
  /** Value alignment of a readout without `align`; null = the stylesheet's. */
  readonly readoutAlign: 'left' | null;
}

export const RENDER_PROFILES: Readonly<Record<RenderMode, RenderProfile>> = {
  edm: {
    mode: 'edm',
    alarmContent: 'colour',
    alarmPalette: EDM_ALARM_PALETTE,
    // The IR's alarmBorder defaults to false and EDM text widgets have no
    // alarm border unless authored (textupdate lineAlarm).
    alarmBorderDefault: false,
    disconnected: 'outline',
    // EDM draws text at the widget's x (left) / x+w-width (right), vertically
    // centred: no inset (x_text_obj.cc, textupdate.cc).
    textInset: 0,
    // EDM text entries keep a few px of margin inside their box.
    fieldInset: 4,
    // IR / EDM default alignment.
    readoutAlign: 'left',
  },
  carbon: {
    mode: 'carbon',
    alarmContent: 'pill',
    alarmPalette: CARBON_ALARM_PALETTE,
    alarmBorderDefault: true,
    disconnected: 'placeholder',
    textInset: null,
    fieldInset: null,
    readoutAlign: null,
  },
};

export const RenderModeContext = createContext<RenderMode>(DEFAULT_RENDER_MODE);

export function useRenderMode(): RenderMode {
  return useContext(RenderModeContext);
}

export function useRenderProfile(): RenderProfile {
  return RENDER_PROFILES[useContext(RenderModeContext)];
}
