import { AlarmSeverity } from '@slaclab/canopy-client';
import type { CSSProperties } from 'react';

/**
 * Severity → colour. `null` means "the widget's own (authored) colour": that
 * severity does not repaint it.
 */
export type AlarmPalette = Readonly<Record<AlarmSeverity, string | null>>;

/** Carbon/PyDM-flavoured tokens (CSS custom properties apps may override). */
export const CARBON_ALARM_PALETTE: AlarmPalette = {
  [AlarmSeverity.NO_ALARM]: null,
  [AlarmSeverity.MINOR]: 'var(--pydm-alarm-minor)',
  [AlarmSeverity.MAJOR]: 'var(--pydm-alarm-major)',
  [AlarmSeverity.INVALID]: 'var(--pydm-alarm-invalid)',
  [AlarmSeverity.DISCONNECTED]: 'var(--pydm-alarm-disconnected)',
};

/**
 * EDM's alarm colours, from the `alarm { ... }` block of the site colors.list
 * (edm-displays/bcs/config/colors.list) and the named colours it references:
 *
 *   disconnected : "Disconn/Invalid"  { 65535 65535 65535 }  white
 *   invalid      : "Disconn/Invalid"  { 65535 65535 65535 }  white
 *   minor        : "Monitor: MINOR"   { 65535 65535     0 }  yellow
 *   major        : "Monitor: MAJOR"   { 65535     0     0 }  red
 *   noalarm      : *                  keep the widget's own colour
 *                                     (EDM color_pkg: specialIndex = -1)
 */
export const EDM_ALARM_PALETTE: AlarmPalette = {
  [AlarmSeverity.NO_ALARM]: null,
  [AlarmSeverity.MINOR]: '#ffff00',
  [AlarmSeverity.MAJOR]: '#ff0000',
  [AlarmSeverity.INVALID]: '#ffffff',
  [AlarmSeverity.DISCONNECTED]: '#ffffff',
};

const ALARM_COLORS: Record<AlarmSeverity, string> = {
  [AlarmSeverity.NO_ALARM]: 'var(--pydm-alarm-none)',
  [AlarmSeverity.MINOR]: 'var(--pydm-alarm-minor)',
  [AlarmSeverity.MAJOR]: 'var(--pydm-alarm-major)',
  [AlarmSeverity.INVALID]: 'var(--pydm-alarm-invalid)',
  [AlarmSeverity.DISCONNECTED]: 'var(--pydm-alarm-disconnected)',
};

export function alarmColor(severity: AlarmSeverity): string {
  return ALARM_COLORS[severity] ?? ALARM_COLORS[AlarmSeverity.NO_ALARM];
}

export function alarmBorderColor(
  severity: AlarmSeverity,
  palette: AlarmPalette = CARBON_ALARM_PALETTE
): string {
  return palette[severity] ?? 'transparent';
}

export function alarmBorderStyle(
  severity: AlarmSeverity,
  sensitive: boolean,
  palette: AlarmPalette = CARBON_ALARM_PALETTE
): CSSProperties {
  if (!sensitive || severity === AlarmSeverity.NO_ALARM) return {};
  return {
    borderColor: alarmBorderColor(severity, palette),
    borderWidth: 2,
    borderStyle: 'solid',
  };
}

/**
 * Colour of alarm-sensitive content (EDM fgAlarm, PyDM alarmSensitiveContent):
 * the palette's colour for the severity, or `own` (the authored colour) when
 * the content isn't alarm-sensitive or the palette keeps it for that severity.
 */
export function alarmContentColor(
  severity: AlarmSeverity,
  sensitive: boolean,
  own: string | undefined,
  palette: AlarmPalette
): string | undefined {
  if (!sensitive) return own;
  return palette[severity] ?? own;
}
