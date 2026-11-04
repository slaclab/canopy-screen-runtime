import { useState, useCallback, useLayoutEffect, useRef } from 'react';
import {
  TextInput,
  Slider,
  Toggle,
  ProgressBar,
  Tag,
  Dropdown,
  Checkbox,
  RadioButtonGroup,
  RadioButton,
} from '@carbon/react';
import { usePV } from '@slaclab/canopy-react';
import { alarmBorderStyle } from '../alarm.js';
import { AlarmSeverity, AlarmSeverityName } from '@slaclab/canopy-client';
import type { WidgetRendererProps } from '../registry/WidgetRegistry.js';
import { useFitText } from '../shared/useFitText.js';

/** PVTextDisplay — Carbon Tag/Text showing live PV value */
export function CarbonPVTextDisplay({ layout, props, isSelected }: WidgetRendererProps) {
  const pvName = props.pvName as string | undefined;
  const pv = usePV(pvName);

  const label = props.label as string | undefined;
  const align = (props.align as 'left' | 'center' | 'right' | undefined) ?? 'left';
  const staticText = props.text as string | undefined;
  const hasPv = pvName !== undefined && pvName !== '';
  // A channel-less PyDMLabel is a static caption: show `text`, and skip the
  // alarm border (no PV, no alarm state) so it isn't drawn as a bordered field.
  const isStatic = !hasPv && staticText !== undefined;
  const alarmBorder = isStatic
    ? {}
    : alarmBorderStyle(pv.severity, (props.alarmSensitiveBorder as boolean) ?? true);
  const value = pv.connected
    ? pv.displayValue
    : !hasPv && staticText !== undefined
      ? staticText
      : '---';
  // Default ~13px matches the .carbon-pv-display__value rule (0.8125rem).
  const maxFontSize = (props.fontSize as number) ?? 13;
  const fit = (props.fitText as boolean) ?? false;
  const { ref, fontSize } = useFitText<HTMLDivElement>(
    maxFontSize,
    [label, value, layout.width, layout.height],
    undefined,
    fit
  );

  const severityTag = (() => {
    switch (pv.severity) {
      case AlarmSeverity.MINOR:
        return 'magenta' as const;
      case AlarmSeverity.MAJOR:
        return 'red' as const;
      case AlarmSeverity.INVALID:
        return 'purple' as const;
      case AlarmSeverity.DISCONNECTED:
        return 'gray' as const;
      default:
        return 'green' as const;
    }
  })();

  return (
    <div
      className={`carbon-pv-display ${isSelected ? 'carbon-pv-display--selected' : ''}`}
      style={{
        width: layout.width,
        height: layout.height,
        ...alarmBorder,
      }}
    >
      <div ref={ref} className="carbon-pv-display__content" style={{ fontSize }}>
        {label && <span className="carbon-pv-display__label">{label}</span>}
        <span
          className={
            isStatic
              ? 'carbon-pv-display__value carbon-pv-display__value--static'
              : 'carbon-pv-display__value'
          }
          style={align !== 'left' ? { textAlign: align } : undefined}
        >
          {value}
        </span>
      </div>
      {pv.connected && pv.severity !== AlarmSeverity.NO_ALARM && (
        <Tag size="sm" type={severityTag} className="carbon-pv-display__alarm-tag">
          {AlarmSeverityName[pv.severity]}
        </Tag>
      )}
    </div>
  );
}

/** PVTextInput — Carbon TextInput bound to PV */
export function CarbonPVTextInput({
  id,
  layout,
  props,
  isSelected,
  isEditing,
}: WidgetRendererProps) {
  const pv = usePV(props.pvName as string | undefined);
  const [draft, setDraft] = useState<string | null>(null);
  const alarmBorder = alarmBorderStyle(
    pv.severity,
    (props.alarmSensitiveBorder as boolean) ?? true
  );

  const handleBlur = useCallback(() => {
    if (draft !== null && pv.connected) {
      const numVal = parseFloat(draft);
      pv.put(isNaN(numVal) ? draft : numVal);
      setDraft(null);
    }
  }, [draft, pv]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') handleBlur();
      if (e.key === 'Escape') setDraft(null);
    },
    [handleBlur]
  );

  return (
    <div
      className={`carbon-pv-input ${isSelected ? 'carbon-pv-input--selected' : ''}`}
      style={{ width: layout.width, height: layout.height, ...alarmBorder }}
    >
      <TextInput
        id={`pv-input-${id}`}
        labelText={(props.label as string) ?? ''}
        hideLabel={!props.label}
        size="sm"
        value={
          draft ??
          (pv.connected
            ? typeof pv.value === 'number' && pv.enumChoices?.[pv.value] !== undefined
              ? pv.enumChoices[pv.value]
              : typeof pv.value === 'number' && pv.precision > 0
                ? pv.value.toFixed(pv.precision)
                : String(pv.value)
            : '---')
        }
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDraft(e.target.value)}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        disabled={!pv.connected && !!props.pvName}
        readOnly={isEditing}
      />
    </div>
  );
}

// Carbon "Launch" glyph, inlined to avoid an @carbon/icons-react dependency.
function LaunchGlyph({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="currentColor" aria-hidden="true">
      <path d="M26 28H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h10v2H6v20h20V16h2v10a2 2 0 0 1-2 2Z" />
      <path d="M20 2v2h6.586L18 12.586 19.414 14 28 5.414V12h2V2H20Z" />
    </svg>
  );
}

/** PVButton — push or toggle button writing to a Control PV */
export function CarbonPVButton({ layout, props, isEditing }: WidgetRendererProps) {
  const controlPV = usePV(props.controlPV as string | undefined);
  const readbackPV = usePV(props.readbackPV as string | undefined);
  const colorPV = usePV(props.colorPV as string | undefined);
  const visibilityPV = usePV(props.visibilityPV as string | undefined);

  const buttonType = (props.buttonType as 'push' | 'toggle') ?? 'push';
  const labelType = (props.labelType as 'literal' | 'pvState') ?? 'literal';
  // undefined (not "On"/"Off") when unauthored, so a text-less button doesn't
  // fabricate captions the source screen never had.
  const onLabel = props.onLabel as string | undefined;
  const offLabel = props.offLabel as string | undefined;
  const authoredLabel = props.label as string | undefined;
  const hasAuthoredLabel =
    (authoredLabel !== undefined && authoredLabel !== '') ||
    (onLabel !== undefined && onLabel !== '') ||
    (offLabel !== undefined && offLabel !== '');
  const invisible = props.invisible === true;
  const fontFamily = (props.fontFamily as string) || 'IBM Plex Sans, sans-serif';
  const fontSize = (props.fontSize as number) ?? 13;
  const foregroundColor = (props.foregroundColor as string) ?? '#ffffff';
  const baseBg = (props.backgroundColor as string) ?? '#0f62fe';

  // EDM/PyDM treat the state value as an INTEGER: 0.5 is OFF (trunc -> 0).
  const isOn =
    readbackPV.connected &&
    (typeof readbackPV.value === 'number'
      ? Math.trunc(readbackPV.value) !== 0
      : Boolean(readbackPV.value));

  // EDM message buttons write authored press/release values ("1", "RESET",
  // enum names) — numeric strings become numbers, anything else writes as-is.
  const writeValue = (v: unknown): number | string | undefined => {
    if (typeof v === 'number') return v;
    if (typeof v === 'string' && v !== '') {
      return Number.isFinite(Number(v)) ? Number(v) : v;
    }
    return undefined;
  };
  const pressValue = writeValue(props.pressValue);
  const releaseValue = writeValue(props.releaseValue);

  const handlePress = useCallback(() => {
    if (isEditing || !controlPV.address) return;
    if (buttonType === 'toggle') {
      controlPV.put(isOn ? 0 : 1);
    } else {
      controlPV.put(pressValue ?? 1);
    }
  }, [isEditing, controlPV, buttonType, isOn, pressValue]);

  const handleRelease = useCallback(() => {
    if (isEditing || !controlPV.address) return;
    if (buttonType !== 'toggle' && releaseValue !== undefined) {
      controlPV.put(releaseValue);
    }
  }, [isEditing, controlPV, buttonType, releaseValue]);

  // Visibility PV: hide at runtime when its value is falsy
  if (!isEditing && props.visibilityPV && visibilityPV.connected) {
    const visible =
      typeof visibilityPV.value === 'number'
        ? visibilityPV.value !== 0
        : Boolean(visibilityPV.value);
    if (!visible) return null;
  }
  // Invisible toggle: hide at runtime, dim in editor
  if (!isEditing && invisible) return null;

  // Background precedence: a live color PV wins; then EDM state colors
  // (onColor/offColor track the readback, the EDM toggle look); then the
  // authored static background.
  const stateBg =
    props.onColor || props.offColor
      ? ((isOn ? props.onColor : props.offColor) as string | undefined)
      : undefined;
  const backgroundColor =
    props.colorPV && colorPV.connected && typeof colorPV.value === 'string'
      ? colorPV.value
      : (stateBg ?? baseBg);

  let label: React.ReactNode;
  if (labelType === 'pvState') {
    // displayValue maps enum ordinals to their state strings (EDM parity).
    label = readbackPV.connected ? readbackPV.displayValue : '';
  } else if (hasAuthoredLabel) {
    label = isOn ? (onLabel ?? authoredLabel ?? '') : (offLabel ?? authoredLabel ?? '');
  } else {
    // Unlabeled: a small or showIcon button is a launcher/glyph → draw an icon;
    // anything else stays a blank press target rather than a fabricated caption.
    const isIconButton = props.showIcon === true || (layout.width <= 24 && layout.height <= 24);
    label = isIconButton ? (
      <LaunchGlyph size={Math.max(12, Math.min(layout.width, layout.height) - 6)} />
    ) : (
      ''
    );
  }

  // With a release value the press/release pair must straddle the hold
  // (EDM message-button semantics), so the writes ride mousedown/mouseup;
  // otherwise a plain click writes the press value.
  const pressHandlers =
    releaseValue !== undefined && buttonType !== 'toggle'
      ? { onMouseDown: handlePress, onMouseUp: handleRelease }
      : { onClick: handlePress };

  return (
    <button
      {...pressHandlers}
      style={{
        width: layout.width,
        height: layout.height,
        backgroundColor,
        color: foregroundColor,
        fontFamily,
        fontSize,
        border: 'none',
        borderRadius: 2,
        cursor: isEditing ? 'default' : 'pointer',
        opacity: invisible ? 0.35 : 1,
        padding: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {label}
    </button>
  );
}

/** PVSlider — Carbon Slider bound to PV */
export function CarbonPVSlider({ id, layout, props, isSelected, isEditing }: WidgetRendererProps) {
  const pv = usePV(props.pvName as string | undefined);
  const min = (props.minValue as number) ?? pv.lowerLimit ?? 0;
  const max = (props.maxValue as number) ?? pv.upperLimit ?? 100;
  const value = pv.connected ? (typeof pv.value === 'number' ? pv.value : 0) : 0;

  const handleChange = useCallback(
    ({ value: v }: { value: number }) => {
      if (!isEditing) pv.put(v);
    },
    [isEditing, pv]
  );

  return (
    <div
      className={`carbon-pv-slider ${isSelected ? 'carbon-pv-slider--selected' : ''}`}
      style={{ width: layout.width, height: layout.height }}
    >
      <Slider
        id={`pv-slider-${id}`}
        labelText=""
        hideTextInput
        min={min}
        max={max}
        value={value}
        onChange={handleChange}
        disabled={!pv.connected && !!props.pvName}
      />
    </div>
  );
}

/** PVToggle — Carbon Toggle bound to PV */
export function CarbonPVToggle({ id, layout, props, isEditing }: WidgetRendererProps) {
  const pv = usePV(props.pvName as string | undefined);
  const isOn = pv.connected && (typeof pv.value === 'number' ? pv.value !== 0 : Boolean(pv.value));

  const handleToggle = useCallback(
    (checked: boolean) => {
      if (!isEditing) pv.put(checked ? 1 : 0);
    },
    [isEditing, pv]
  );

  return (
    <div
      style={{ width: layout.width, height: layout.height, display: 'flex', alignItems: 'center' }}
    >
      <Toggle
        id={`pv-toggle-${id}`}
        labelText=""
        hideLabel
        size="sm"
        toggled={isOn}
        onToggle={handleToggle}
        labelA={(props.offLabel as string) ?? 'Off'}
        labelB={(props.onLabel as string) ?? 'On'}
        disabled={!pv.connected && !!props.pvName}
      />
    </div>
  );
}

/** PVProgressBar — Carbon ProgressBar bound to PV */
export function CarbonPVProgressBar({ layout, props, isSelected }: WidgetRendererProps) {
  const pv = usePV(props.pvName as string | undefined);
  const min = (props.minValue as number) ?? 0;
  const max = (props.maxValue as number) ?? 100;
  const value = pv.connected ? (typeof pv.value === 'number' ? pv.value : 0) : 0;
  const percent = Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));

  const status = (() => {
    if (!pv.connected) return 'error' as const;
    if (pv.severity === AlarmSeverity.MAJOR) return 'error' as const;
    return 'active' as const;
  })();

  // Carbon's ProgressBar is horizontal-only; draw a custom bottom-up fill for vertical.
  const orientation = (props.orientation as 'horizontal' | 'vertical' | undefined) ?? 'horizontal';
  if (orientation === 'vertical') {
    const fillColor =
      status === 'error'
        ? 'var(--cds-support-error, #da1e28)'
        : 'var(--cds-support-success, #0f62fe)';
    return (
      <div
        className={`carbon-pv-progress carbon-pv-progress--vertical ${isSelected ? 'carbon-pv-progress--selected' : ''}`}
        style={{
          width: layout.width,
          height: layout.height,
          display: 'flex',
          alignItems: 'flex-end',
          backgroundColor: 'var(--cds-layer-accent, #393939)',
          border: '1px solid var(--cds-border-subtle, #393939)',
          borderRadius: 2,
          overflow: 'hidden',
          boxSizing: 'border-box',
        }}
      >
        <div
          style={{
            width: '100%',
            height: `${percent}%`,
            backgroundColor: fillColor,
            transition: 'height 0.15s',
          }}
        />
      </div>
    );
  }

  return (
    <div
      className={`carbon-pv-progress ${isSelected ? 'carbon-pv-progress--selected' : ''}`}
      style={{ width: layout.width, height: layout.height }}
    >
      <ProgressBar
        label={(props.label as string) ?? ''}
        hideLabel={!props.label}
        value={percent}
        status={status}
        size="small"
      />
    </div>
  );
}

/** PVLed — Custom LED indicator (no Carbon equivalent) */
export function CarbonPVLed({ layout, props }: WidgetRendererProps) {
  const pv = usePV(props.pvName as string | undefined);
  const isOn = pv.connected && (typeof pv.value === 'number' ? pv.value !== 0 : Boolean(pv.value));
  const onColor = (props.onColor as string) ?? '#24a148';
  const offColor = (props.offColor as string) ?? '#525252';
  const color = isOn ? onColor : offColor;
  const size = Math.min(layout.width, layout.height);

  return (
    <div
      className="carbon-pv-led"
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        backgroundColor: color,
        boxShadow: isOn
          ? `0 0 ${size / 2}px ${color}80, inset 0 -2px 4px rgba(0,0,0,0.3)`
          : 'inset 0 2px 4px rgba(0,0,0,0.4)',
        transition: 'background-color 0.2s, box-shadow 0.2s',
        border: `1px solid rgba(255,255,255,0.1)`,
      }}
    >
      {/* Highlight reflection */}
      <div
        style={{
          width: size * 0.35,
          height: size * 0.35,
          borderRadius: '50%',
          background: `radial-gradient(circle, rgba(255,255,255,${isOn ? 0.4 : 0.15}) 0%, transparent 70%)`,
          position: 'relative',
          top: size * 0.12,
          left: size * 0.15,
        }}
      />
    </div>
  );
}

/** PVDropdown — Carbon Dropdown bound to PV */
export function CarbonPVDropdown({ id, layout, props, isEditing }: WidgetRendererProps) {
  const pv = usePV(props.pvName as string | undefined);
  const items = (props.customItems as string[]) ?? ['Option 1', 'Option 2', 'Option 3'];

  return (
    <div style={{ width: layout.width, height: layout.height }}>
      <Dropdown
        id={`pv-dropdown-${id}`}
        titleText=""
        label={pv.connected ? String(pv.value) : 'Select...'}
        items={items}
        itemToString={(item: string) => item}
        size="sm"
        disabled={!pv.connected && !!props.pvName}
        onChange={({ selectedItem }: { selectedItem: string | null }) => {
          if (!isEditing && selectedItem) pv.put(selectedItem);
        }}
      />
    </div>
  );
}

/** PVRadioGroup — Carbon RadioButtonGroup bound to a PV, writing the selected ordinal (PyDMEnumButton) */
export function CarbonPVRadioGroup({ id, layout, props, isEditing }: WidgetRendererProps) {
  const pv = usePV(props.pvName as string | undefined);
  const items = (props.customItems as string[] | undefined) ??
    (props.items as string[] | undefined) ??
    pv.enumChoices ?? ['Option 1', 'Option 2'];

  const orientation = (props.orientation as 'horizontal' | 'vertical' | undefined) ?? 'vertical';

  // Fit-to-geometry: EDM radio boxes are far smaller than Carbon's native
  // control sizing, so measure the rendered group and scale it down into the
  // authored rect rather than clipping options away (losing options is
  // missing-info; small-but-complete matches the EDM look).
  const innerRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(1);
  const itemsKey = items.join('|');
  useLayoutEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    const naturalWidth = el.scrollWidth;
    const naturalHeight = el.scrollHeight;
    if (!naturalWidth || !naturalHeight) return; // jsdom / not laid out yet
    const fit = Math.min(1, layout.width / naturalWidth, layout.height / naturalHeight);
    setScale(fit < 0.999 ? fit : 1);
  }, [layout.width, layout.height, orientation, itemsKey]);

  // The live value may be the enum ordinal (number) or label (string); -1 = none.
  let selectedIndex = -1;
  if (pv.connected) {
    if (typeof pv.value === 'number') {
      selectedIndex = pv.value;
    } else if (typeof pv.value === 'string') {
      selectedIndex = items.indexOf(pv.value);
    }
  }

  const handleChange = useCallback(
    (selection: string | number | undefined) => {
      if (isEditing || typeof selection !== 'number') return;
      pv.put(selection);
    },
    [isEditing, pv]
  );

  return (
    <div style={{ width: layout.width, height: layout.height, overflow: 'hidden' }}>
      <div
        ref={innerRef}
        style={{
          display: 'inline-block',
          transform: scale < 1 ? `scale(${scale})` : undefined,
          transformOrigin: 'top left',
        }}
      >
        <RadioButtonGroup
          name={`pv-radio-${id}`}
          orientation={orientation}
          valueSelected={selectedIndex >= 0 ? selectedIndex : undefined}
          onChange={handleChange}
          disabled={!pv.connected && !!props.pvName}
          readOnly={isEditing}
        >
          {items.map((item, index) => (
            <RadioButton
              key={`${id}-${index}`}
              id={`pv-radio-${id}-${index}`}
              labelText={item}
              value={index}
            />
          ))}
        </RadioButtonGroup>
      </div>
    </div>
  );
}

/** PVCheckbox — Carbon Checkbox bound to PV (writes 1/0) */
export function CarbonPVCheckbox({ id, layout, props, isEditing }: WidgetRendererProps) {
  const pv = usePV(props.pvName as string | undefined);
  const isChecked =
    pv.connected && (typeof pv.value === 'number' ? pv.value !== 0 : Boolean(pv.value));

  const handleChange = useCallback(
    (_: unknown, { checked }: { checked: boolean }) => {
      if (!isEditing) pv.put(checked ? 1 : 0);
    },
    [isEditing, pv]
  );

  return (
    <div
      style={{ width: layout.width, height: layout.height, display: 'flex', alignItems: 'center' }}
    >
      <Checkbox
        id={`pv-checkbox-${id}`}
        labelText={(props.label as string) ?? ''}
        checked={isChecked}
        onChange={handleChange}
        disabled={!pv.connected && !!props.pvName}
        readOnly={isEditing}
      />
    </div>
  );
}

/** PVByteIndicator — a row of LED dots, one per bit of the PV value */
export function CarbonPVByteIndicator({ layout, props }: WidgetRendererProps) {
  const pv = usePV(props.pvName as string | undefined);
  const value = pv.connected && typeof pv.value === 'number' ? pv.value : 0;
  const numBits = Math.max(1, (props.numBits as number) ?? 8);
  const startBit = (props.startBit as number) ?? 0;
  const bigEndian = (props.bigEndian as boolean) ?? false;
  const onColor = (props.onColor as string) ?? '#24a148';
  const offColor = (props.offColor as string) ?? '#525252';

  // Each cell is a square sized to the row height; lay them out left→right.
  const size = Math.min(layout.height, layout.width / numBits);

  const bits = Array.from({ length: numBits }, (_, i) => {
    // Bit 0 is the LSB. bigEndian renders the high bit first (leftmost).
    const bitIndex = bigEndian ? numBits - 1 - i : i;
    return (value >> (startBit + bitIndex)) & 1;
  });

  return (
    <div
      className="carbon-pv-byte"
      style={{
        width: layout.width,
        height: layout.height,
        display: 'flex',
        gap: 2,
        alignItems: 'center',
      }}
    >
      {bits.map((on, i) => {
        const color = on ? onColor : offColor;
        return (
          <div
            key={i}
            style={{
              width: size,
              height: size,
              borderRadius: '50%',
              backgroundColor: color,
              boxShadow: on
                ? `0 0 ${size / 3}px ${color}80, inset 0 -1px 2px rgba(0,0,0,0.3)`
                : 'inset 0 1px 2px rgba(0,0,0,0.4)',
              border: '1px solid rgba(255,255,255,0.1)',
              flex: '0 0 auto',
            }}
          />
        );
      })}
    </div>
  );
}

/** PVMeter — semicircular needle gauge (EDM activeMeterClass parity). */
export function CarbonPVMeter({ layout, props }: WidgetRendererProps) {
  const pv = usePV(props.pvName as string | undefined);
  const min = typeof props.min === 'number' ? props.min : pv.lowerLimit || 0;
  const max = typeof props.max === 'number' ? props.max : pv.upperLimit || 1;
  const span = max - min || 1;
  const raw = typeof pv.value === 'number' ? pv.value : min;
  const frac = Math.min(1, Math.max(0, (raw - min) / span));
  // Needle sweeps 180deg across the top half: fraction 0 -> left, 1 -> right.
  const angle = Math.PI * (1 - frac);
  const w = layout.width;
  const h = layout.height;
  const cx = w / 2;
  const cy = h * 0.72;
  const r = Math.min(w / 2, cy) - 6;
  const nx = cx + r * 0.9 * Math.cos(angle);
  const ny = cy - r * 0.9 * Math.sin(angle);
  const showValue = (props.showValue as boolean) ?? true;
  const label = props.label as string | undefined;
  const alarmBorder = alarmBorderStyle(
    pv.severity,
    (props.alarmSensitiveBorder as boolean) ?? true
  );
  return (
    <div style={{ width: w, height: h, position: 'relative', ...alarmBorder }}>
      <svg width={w} height={h} aria-label={label ?? 'meter'}>
        <path
          d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`}
          fill="none"
          stroke="var(--cds-border-subtle, #8d8d8d)"
          strokeWidth={2}
        />
        {[0, 0.25, 0.5, 0.75, 1].map((t) => {
          const a = Math.PI * (1 - t);
          return (
            <line
              key={t}
              x1={cx + (r - 5) * Math.cos(a)}
              y1={cy - (r - 5) * Math.sin(a)}
              x2={cx + r * Math.cos(a)}
              y2={cy - r * Math.sin(a)}
              stroke="var(--cds-border-subtle, #8d8d8d)"
              strokeWidth={1}
            />
          );
        })}
        <line
          x1={cx}
          y1={cy}
          x2={nx}
          y2={ny}
          stroke={pv.connected ? 'var(--cds-support-success, #24a148)' : '#8d8d8d'}
          strokeWidth={2}
        />
        <circle cx={cx} cy={cy} r={3} fill="var(--cds-text-primary, #161616)" />
      </svg>
      <div
        style={{
          position: 'absolute',
          bottom: 0,
          width: '100%',
          textAlign: 'center',
          fontSize: Math.max(9, Math.min(12, h * 0.14)),
          lineHeight: 1.1,
        }}
      >
        {showValue && <span>{pv.connected ? pv.displayValue : '---'}</span>}
        {label && <div>{label}</div>}
      </div>
    </div>
  );
}
