// Ported from the builder's src/editor/code/generateTSX.ts. The generation
// logic is unchanged; only the emitted import paths moved from the @pydm/*
// placeholders to the real @slaclab packages, with all widget buckets
// (pv wrappers, indicators, drawings, containers) collapsing into the single
// unified @slaclab/canopy-screen-widgets package.

import { isColorRole } from '@slaclab/canopy-screen-ir';
import type { ColorRole, FlatScheme } from '@slaclab/canopy-screen-ir';
import type { WidgetType } from '@slaclab/canopy-screen-widgets';
import { WIDGET_CATALOG } from '@slaclab/canopy-screen-widgets';
import type { ScreenModel, Widget } from './model.js';

// ── Colour roles (mirrors the builder's emission) ─────────────────────────────

/**
 * The light/dark values for `role`: the scheme's when it defines the role,
 * else the role's own fallbacks (`fallbackDark` defaulting to `fallback`).
 */
function roleValues(role: ColorRole, scheme: FlatScheme | undefined): [string, string] {
  const fallbackDark = role.fallbackDark ?? role.fallback;
  const i = scheme ? scheme.roles.indexOf(role.$role) : -1;
  if (!scheme || i < 0) return [role.fallback, fallbackDark];
  return [scheme.light[i] ?? role.fallback, scheme.dark[i] ?? fallbackDark];
}

/**
 * The whole role as JSON safe to sit inside a block comment and inside a JSX
 * attribute: `*\/` cannot close the comment and `>` cannot end the tag.
 */
export function escapeRoleJSON(role: ColorRole): string {
  return JSON.stringify(role).replace(/\*\//g, '*\\/').replace(/>/g, '\\u003e');
}

/**
 * A role as `'light-dark(<light>, <dark>)' /* role: {...} *\/`. The CSS value
 * is what the ejected code renders; the comment, outside the string, carries
 * the whole role so a parser can restore it exactly.
 */
function roleExpr(role: ColorRole, scheme: FlatScheme | undefined): string {
  const [light, dark] = roleValues(role, scheme);
  return `'light-dark(${light}, ${dark})' /* role: ${escapeRoleJSON(role)} */`;
}

/** Whether `value` is, or contains at any depth, a colour role. */
function containsRole(value: unknown): boolean {
  if (isColorRole(value)) return true;
  if (Array.isArray(value)) return value.some(containsRole);
  if (value !== null && typeof value === 'object') return Object.values(value).some(containsRole);
  return false;
}

/**
 * A JS literal for a prop value: JSON, except that every role at any depth
 * becomes a role expression. `<` and `>` in strings are escaped so the literal
 * never ends the JSX tag.
 */
function literal(value: unknown, scheme: FlatScheme | undefined): string {
  if (isColorRole(value)) return roleExpr(value, scheme);
  if (Array.isArray(value)) return `[${value.map((v) => literal(v, scheme)).join(', ')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    return `{ ${entries.map(([k, v]) => `${jsonText(k)}: ${literal(v, scheme)}`).join(', ')} }`;
  }
  return jsonText(value);
}

function jsonText(value: unknown): string {
  return (JSON.stringify(value) ?? 'null').replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
}

/** Whether the screen's meta or any widget reachable from the roots holds a role. */
function screenHasRole(screen: ScreenModel): boolean {
  if (isColorRole(screen.meta.backgroundColor)) return true;
  const seen = new Set<string>();
  const walk = (ids: readonly string[]): boolean =>
    ids.some((id) => {
      if (seen.has(id)) return false;
      seen.add(id);
      const w = screen.widgets[id];
      if (!w) return false;
      return containsRole(w.props) || (w.children ? walk(w.children) : false);
    });
  return walk(screen.rootWidgetIds);
}

/**
 * Generates a human-readable TSX file from the internal screen model.
 * Uses string templates (Mitosis-style) — not AST manipulation.
 * Output is designed to look like a skilled developer wrote it by hand.
 *
 * Colour roles are emitted as `light-dark()` values with the role in a trailing
 * comment: the scheme's values when `scheme` defines the role, else the role's
 * fallbacks. A screen holding any role also gains a `mode` prop that sets the
 * Screen's color-scheme; role-free screens are emitted exactly as before.
 */
export function generateTSX(screen: ScreenModel, scheme?: FlatScheme): string {
  const hasRole = screenHasRole(screen);

  const widgets = screen.rootWidgetIds
    .map((id) => screen.widgets[id])
    .filter((w): w is Widget => Boolean(w))
    .sort((a, b) => a.zIndex - b.zIndex);

  // Collect which widget types are used
  const usedTypes = new Set<WidgetType>();
  const collectTypes = (ids: readonly string[]) => {
    for (const id of ids) {
      const w = screen.widgets[id];
      if (w) {
        usedTypes.add(w.type);
        if (w.children) collectTypes(w.children);
      }
    }
  };
  collectTypes(screen.rootWidgetIds);

  // Group used types by their import bucket from the central catalog; the
  // buckets all live in @slaclab/canopy-screen-widgets, emitted in catalog
  // order (pv wrappers + indicators, drawings, containers).
  const inBucket = (bucket: readonly string[], t: WidgetType) => bucket.includes(t);
  const pvWrappers = [...usedTypes].filter((t) => inBucket(WIDGET_CATALOG.pvWrappers, t));
  const indicators = [...usedTypes].filter((t) => inBucket(WIDGET_CATALOG.indicators, t));
  const drawings = [...usedTypes].filter((t) => inBucket(WIDGET_CATALOG.drawings, t));
  const containers = [...usedTypes].filter((t) => inBucket(WIDGET_CATALOG.containers, t));

  const imports: string[] = [];

  const widgetImports = [...pvWrappers, ...indicators, ...drawings, ...containers];
  if (widgetImports.length > 0) {
    imports.push(`import { ${widgetImports.join(', ')} } from '@slaclab/canopy-screen-widgets';`);
  }
  imports.unshift(`import { Screen } from '@slaclab/canopy-screen-runtime';`);
  imports.unshift(`import type { ScreenProps } from '@slaclab/canopy-screen-runtime';`);

  // Check if any widget uses PV
  const hasPV = widgets.some((w) => w.props.pvName);
  if (hasPV) {
    imports.unshift(`import { usePV } from '@slaclab/canopy-react';`);
  }

  // Build screen metadata
  const macroEntries = Object.entries(screen.meta.macros);
  const macrosStr =
    macroEntries.length > 0
      ? `{ ${macroEntries.map(([k, v]) => `${k}: '${v}'`).join(', ')} }`
      : '{}';

  // Screen-level formulas are author-facing data; emit them as a JSON
  // array so they round-trip losslessly through parseTSX.
  const formulasLine =
    screen.meta.formulas && screen.meta.formulas.length > 0
      ? `\n  formulas: ${JSON.stringify(screen.meta.formulas)},`
      : '';

  const bg = screen.meta.backgroundColor;
  const bgExpr = isColorRole(bg) ? roleExpr(bg, scheme) : `'${bg}'`;

  const metaBlock = `const screenMeta = {
  title: '${screen.meta.title}',
  width: ${screen.meta.width},
  height: ${screen.meta.height},
  backgroundColor: ${bgExpr},
  macros: ${macrosStr},${formulasLine}
} satisfies ScreenProps;`;

  // Build component name from title
  const componentName =
    screen.meta.title
      .replace(/[^a-zA-Z0-9\s]/g, '')
      .replace(/\s+(.)/g, (_, c: string) => c.toUpperCase())
      .replace(/^\w/, (c) => c.toUpperCase()) || 'Screen';

  // Build JSX for widgets
  const widgetJSX = widgets.map((w) => generateWidgetJSX(w, screen, scheme, 3)).join('\n');

  // Build the component. With roles, `mode` sets the Screen's color-scheme so
  // the light-dark() colours follow the viewer unless the caller pins a mode.
  const component = hasRole
    ? `export default function ${componentName}({
  macros,
  mode = 'light dark',
}: {
  macros?: Record<string, string>;
  mode?: 'light' | 'dark' | 'light dark';
}) {
  return (
    <Screen meta={screenMeta} macros={macros} mode={mode}>
${widgetJSX}
    </Screen>
  );
}`
    : `export default function ${componentName}({ macros }: { macros?: Record<string, string> }) {
  return (
    <Screen meta={screenMeta} macros={macros}>
${widgetJSX}
    </Screen>
  );
}`;

  // Assemble file
  const sections = [imports.join('\n'), '', metaBlock, '', component, ''];

  return sections.join('\n');
}

function generateWidgetJSX(
  widget: Widget,
  screen: ScreenModel,
  scheme: FlatScheme | undefined,
  indent: number
): string {
  const pad = ' '.repeat(indent * 2);
  const props = buildPropsString(widget, scheme);

  if (widget.children && widget.children.length > 0) {
    const childJSX = widget.children
      .map((id) => screen.widgets[id])
      .filter((w): w is Widget => Boolean(w))
      .sort((a, b) => a.zIndex - b.zIndex)
      .map((child) => generateWidgetJSX(child, screen, scheme, indent + 1))
      .join('\n');

    return `${pad}<${widget.type}${props}>\n${childJSX}\n${pad}</${widget.type}>`;
  }

  return `${pad}<${widget.type}${props} />`;
}

function buildPropsString(widget: Widget, scheme: FlatScheme | undefined): string {
  const parts: string[] = [];

  // Layout props
  parts.push(`x={${widget.layout.x}}`);
  parts.push(`y={${widget.layout.y}}`);
  parts.push(`w={${widget.layout.width}}`);
  parts.push(`h={${widget.layout.height}}`);

  // PV name
  if (widget.props.pvName) {
    parts.push(`pv="${widget.props.pvName}"`);
  }

  // Common props (skip defaults and layout)
  const skipKeys = new Set(['pvName', 'layoutMode']);
  const defaults: Record<string, unknown> = {
    alarmSensitiveBorder: true,
    alarmSensitiveContent: false,
    visible: true,
    opacity: 0,
    fill: false,
    orientation: 'horizontal',
    showUnits: false,
    precisionFromPV: true,
    confirmOnWrite: false,
    enabled: true,
    limitsFromPV: true,
  };

  for (const [key, value] of Object.entries(widget.props)) {
    if (skipKeys.has(key)) continue;
    if (value === undefined || value === null || value === '') continue;
    if (defaults[key] === value) continue;

    if (isColorRole(value)) {
      parts.push(`${key}={${roleExpr(value, scheme)}}`);
    } else if (typeof value === 'string') {
      parts.push(`${key}="${value}"`);
    } else if (typeof value === 'boolean') {
      parts.push(value ? key : `${key}={false}`);
    } else if (typeof value === 'number') {
      parts.push(`${key}={${value}}`);
    } else if (typeof value === 'object' && containsRole(value)) {
      parts.push(`${key}={${literal(value, scheme)}}`);
    } else if (typeof value === 'object') {
      parts.push(`${key}={${JSON.stringify(value)}}`);
    }
  }

  // Rotation
  if (widget.rotation) {
    parts.push(`rotation={${widget.rotation}}`);
  }

  // Visibility
  if (!widget.visible) {
    parts.push(`visible={false}`);
  }

  if (parts.length === 0) return '';

  // Format: if few props, inline. If many, one per line.
  if (parts.length <= 4) {
    return ' ' + parts.join(' ');
  }

  return '\n' + parts.map((p) => `        ${p}`).join('\n') + '\n      ';
}
