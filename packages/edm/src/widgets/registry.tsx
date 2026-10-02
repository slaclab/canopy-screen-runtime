// Widget registry: EDM class name → component. A class without a component
// renders a visible placeholder; a component that throws renders an error box
// in its own geometry. Neither ever unmounts the rest of the screen.

import { Component } from 'react';
import type { ComponentType, ErrorInfo, ReactNode } from 'react';
import type { EdmObject } from '../model.js';
import { propInt } from '../model.js';

export interface EdmWidgetProps {
  readonly obj: EdmObject;
}

export type EdmWidgetComponent = ComponentType<EdmWidgetProps>;

const widgets = new Map<string, { readonly component: EdmWidgetComponent }>();

/** Register (or replace) the component for an EDM class, e.g. `activeXTextDspClass:noedit`. */
export function registerEdmWidget(className: string, component: EdmWidgetComponent): void {
  widgets.set(className, { component });
}

export function getEdmWidget(className: string): EdmWidgetComponent | undefined {
  return widgets.get(className)?.component;
}

export function registeredEdmClasses(): string[] {
  return [...widgets.keys()].sort();
}

export function EdmObjectView({ obj }: EdmWidgetProps) {
  const entry = widgets.get(obj.className);
  const Widget = entry ? entry.component : Placeholder;
  return (
    <WidgetBoundary obj={obj}>
      <Widget obj={obj} />
    </WidgetBoundary>
  );
}

function boxStyle(obj: EdmObject) {
  return {
    position: 'absolute' as const,
    left: propInt(obj.props, 'x', 0),
    top: propInt(obj.props, 'y', 0),
    width: Math.max(1, propInt(obj.props, 'w', 0)),
    height: Math.max(1, propInt(obj.props, 'h', 0)),
    boxSizing: 'border-box' as const,
    pointerEvents: 'none' as const,
  };
}

/** A class the kit does not implement yet: a dashed outline naming the class. */
export function Placeholder({ obj }: EdmWidgetProps) {
  return (
    <div
      data-testid="widget-placeholder"
      data-edm-class={obj.className}
      title={`EDM ${obj.className} (not implemented yet)`}
      style={{
        ...boxStyle(obj),
        outline: '1px dashed #c000c0',
        outlineOffset: -1,
        overflow: 'hidden',
        font: '9px Arimo, sans-serif',
        color: '#c000c0',
        lineHeight: '10px',
        padding: 1,
      }}
    >
      {obj.className}
    </div>
  );
}

/**
 * Classes that appear in .edl files but that EDM itself does not register
 * (activeVsBarClass: no library provides it). EDM skips such an object, so
 * nothing is drawn; the marker keeps it countable without being a placeholder.
 */
export function Unregistered({ obj }: EdmWidgetProps) {
  return <div data-edm-unregistered={obj.className} hidden />;
}

interface BoundaryState {
  error: Error | null;
}

export class WidgetBoundary extends Component<
  { obj: EdmObject; children: ReactNode },
  BoundaryState
> {
  state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`EDM ${this.props.obj.className} (line ${this.props.obj.line}):`, error, info);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const { obj } = this.props;
    return (
      <div
        data-testid="widget-error"
        data-edm-class={obj.className}
        title={`${obj.className}: ${error.message}`}
        style={{ ...boxStyle(obj), outline: '1px solid #ff0000', outlineOffset: -1 }}
      />
    );
  }
}
