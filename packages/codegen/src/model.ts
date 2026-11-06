// The codegen input model — the subset of the Screen Builder's editor model
// that generateTSX consumes. The builder's full ScreenModel/Widget types are
// structurally assignable to these, so the builder can call generateTSX
// without conversion; standalone consumers construct the subset directly.

import type { ColorRole, FormulaDeclaration } from '@slaclab/canopy-screen-ir';
import type { AbsoluteLayout, WidgetProps, WidgetType } from '@slaclab/canopy-screen-widgets';

/** A colour: a CSS colour string, or a scheme role with its fallbacks. */
export type ColorValue = string | ColorRole;

/** The WidgetProps keys that hold a colour. */
type ColorKey =
  | 'foregroundColor'
  | 'backgroundColor'
  | 'borderColor'
  | 'onColor'
  | 'offColor'
  | 'lineColor'
  | 'fillColor';

/** One plot curve; only its colour is typed here, the rest passes through. */
export interface CurveProps {
  readonly color?: ColorValue;
  readonly [key: string]: unknown;
}

/**
 * WidgetProps with every colour field widened to ColorValue, plus plot curves
 * whose colours may be roles. Codegen-local: the widgets package's WidgetProps
 * keeps its string colours.
 */
export type CodegenWidgetProps = {
  [K in keyof WidgetProps]: K extends ColorKey ? ColorValue | undefined : WidgetProps[K];
} & {
  curves?: readonly CurveProps[];
};

export interface Widget {
  readonly id: string;
  readonly type: WidgetType;
  readonly layout: AbsoluteLayout;
  readonly props: CodegenWidgetProps;
  readonly zIndex: number;
  readonly visible: boolean;
  readonly rotation: number;
  /** Child widget ids, for containers. */
  readonly children?: readonly string[];
}

export interface ScreenMeta {
  readonly title: string;
  readonly width: number;
  readonly height: number;
  readonly backgroundColor: ColorValue;
  readonly macros: Readonly<Record<string, string>>;
  /** Screen-level formulas; emitted as JSON so they round-trip via parseTSX. */
  formulas?: readonly FormulaDeclaration[];
}

export interface ScreenModel {
  readonly meta: ScreenMeta;
  readonly widgets: Readonly<Record<string, Widget>>;
  readonly rootWidgetIds: readonly string[];
}

/** A minimal empty screen, mirroring the builder's defaults. */
export function createDefaultScreen(): {
  meta: {
    title: string;
    width: number;
    height: number;
    backgroundColor: ColorValue;
    macros: Record<string, string>;
    formulas?: FormulaDeclaration[];
  };
  widgets: Record<string, Widget>;
  rootWidgetIds: string[];
} {
  return {
    meta: {
      title: 'New Screen',
      width: 800,
      height: 600,
      backgroundColor: '#262626',
      macros: {},
    },
    widgets: {},
    rootWidgetIds: [],
  };
}
