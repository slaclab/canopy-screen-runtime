// How a text-showing widget formats a numeric PV value. Pure, so the rule is
// tested without rendering.
//
// PyDM semantics: the PV's precision applies unless the widget sets
// `precisionFromPV: false` and authors a `precision`. A converter that read
// an authored precision from the source display writes that flag. Phoebus
// spells "use the PV" as precision -1, which is no authored precision here
// either.

import type { PVData } from '@slaclab/canopy-client';

type PVText = Pick<PVData, 'value' | 'displayValue' | 'units' | 'precision' | 'enumChoices'>;

/** The largest digit count `Number.prototype.toFixed` accepts. */
const MAX_DECIMALS = 100;

/**
 * The decimals the widget's props ask for, or `undefined` when the PV's own
 * precision applies: `precisionFromPV` is not `false`, or the `precision` is
 * missing or not a whole number from 0 to 100.
 */
export function widgetPrecision(props: Record<string, unknown>): number | undefined {
  if (props.precisionFromPV !== false) return undefined;
  const precision = props.precision;
  return typeof precision === 'number' &&
    Number.isInteger(precision) &&
    precision >= 0 &&
    precision <= MAX_DECIMALS
    ? precision
    : undefined;
}

function enumLabel(pv: PVText): string | undefined {
  return typeof pv.value === 'number' ? pv.enumChoices?.[pv.value] : undefined;
}

/**
 * A connected PV's text as a display shows it: a number with the widget's
 * precision and the PV's units, else the PV's own `displayValue` (enum
 * labels, strings, and every number the widget leaves to the PV).
 */
export function displayText(pv: PVText, props: Record<string, unknown>): string {
  const decimals = widgetPrecision(props);
  if (decimals === undefined || typeof pv.value !== 'number' || enumLabel(pv) !== undefined) {
    return pv.displayValue;
  }
  const text = pv.value.toFixed(decimals);
  return pv.units ? `${text} ${pv.units}` : text;
}

/**
 * A connected PV's text as an entry field shows it, without units: an enum's
 * label, a number with the widget's precision, else with the PV's precision
 * when it states one, else the raw value.
 */
export function entryText(pv: PVText, props: Record<string, unknown>): string {
  const label = enumLabel(pv);
  if (label !== undefined) return label;
  if (typeof pv.value !== 'number') return String(pv.value);
  const decimals = widgetPrecision(props) ?? (pv.precision > 0 ? pv.precision : undefined);
  return decimals === undefined ? String(pv.value) : pv.value.toFixed(decimals);
}
