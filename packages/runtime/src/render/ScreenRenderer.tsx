// The Canopy screen renderer: ScreenJSON in, live screen out.
//
// Geometry model (prior art: the builder's LivePreview renderWidget walk):
// IR geometry is absolute canvas coordinates; children render nested inside
// their parent's wrapper, so the parent's absolute origin is subtracted to
// cancel the nesting offset. Z-order is the IR contract itself — array order
// of `children`, later siblings on top — which nested absolutely-positioned
// DOM siblings already honor, so no sorting or z-index is applied.
//
// Containment: every widget renders inside its own error boundary (a broken
// widget becomes a labeled red box, never a blank screen); unknown widget
// types render a labeled placeholder; embedded screens are resolved via the
// caller's `resolveScreen` with a depth cap and a ref-chain cycle guard.
//
// The renderer is service-agnostic: widgets consume live PVs through
// @slaclab/canopy-react context, rules consume Fox through the
// FormulaSubscriberContext — the composition root provides both. Each
// rendered screen (root and every embedded screen) wraps the PV context in a
// ScreenPVScope so `fox://<name>` widget channels evaluate that screen's own
// formulas with its own macros.
//
// Presentation: `renderMode` (edm | carbon) is provided to every widget —
// embedded screens included — through the widget set's RenderModeContext;
// without the prop an enclosing provider (or the 'edm' default) applies.

import { Component, createContext, useContext, useEffect, useMemo, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { SCHEMA_VERSION } from '@slaclab/canopy-screen-ir';
import type { Geometry, MacroValues, ScreenJSON, WidgetNode } from '@slaclab/canopy-screen-ir';
import type { FormulaDeclaration } from '@slaclab/canopy-screen-ir';
import {
  AssetResolverContext,
  RenderModeContext,
  widgetRegistry,
} from '@slaclab/canopy-screen-widgets';
import type { RenderMode, ResolveAsset } from '@slaclab/canopy-screen-widgets';
import { childMacros, resolveScreenMacros, substituteMacros, substituteProps } from '../macros.js';
import { applyRuleOutputs } from '../rules/applyRules.js';
import { useWidgetRules } from '../rules/useWidgetRules.js';
import { mapIRWidget } from './irMap.js';
import { ScreenPVScope } from './ScreenPVScope.js';

/** Resolves an embedded screen reference (the node's `file` prop). */
export type ResolveScreen = (ref: string) => Promise<ScreenJSON>;

export interface ScreenRendererProps {
  screen: ScreenJSON;
  /** Caller macro values; merged over the screen's declared defaults. */
  macros?: Record<string, string>;
  /** Required for `embedded-display` nodes; without it they show an error box. */
  resolveScreen?: ResolveScreen;
  /**
   * Maps asset references (image filenames) to fetchable URLs. Without it
   * filenames are used as-is, so only already-URL references render.
   */
  resolveAsset?: ResolveAsset;
  /** Embedding depth cap (default 8). */
  maxDepth?: number;
  /**
   * Presentation mode for every widget of the screen (alarm presentation,
   * text metrics; see the widget set's RENDER_PROFILES). Default: an
   * enclosing RenderModeContext, else 'edm'.
   */
  renderMode?: RenderMode;
}

interface EmbedContextValue {
  resolveScreen?: ResolveScreen;
  depth: number;
  /** Normalized refs of every screen on the embedding path (cycle guard). */
  ancestors: readonly string[];
  maxDepth: number;
}

const EmbedContext = createContext<EmbedContextValue>({ depth: 0, ancestors: [], maxDepth: 8 });

// ── Small labeled boxes (placeholder / error) ───────────────────────────────

const BOX_BASE: CSSProperties = {
  width: '100%',
  height: '100%',
  boxSizing: 'border-box',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 2,
  fontSize: 11,
  textAlign: 'center',
  overflow: 'hidden',
  padding: 4,
  userSelect: 'none',
};

function PlaceholderBox({ title, detail }: { title: string; detail?: string }) {
  return (
    <div
      data-testid="widget-placeholder"
      style={{ ...BOX_BASE, border: '1px dashed #8d8d8d', color: '#8d8d8d' }}
      title={detail ?? title}
    >
      <span>{title}</span>
      {detail && <span style={{ wordBreak: 'break-all' }}>{detail}</span>}
    </div>
  );
}

function ErrorBox({ title, detail }: { title: string; detail?: string }) {
  return (
    <div
      data-testid="widget-error"
      style={{ ...BOX_BASE, border: '1px solid #da1e28', color: '#da1e28' }}
      title={detail ?? title}
    >
      <span>⚠ {title}</span>
      {detail && <span style={{ wordBreak: 'break-all' }}>{detail}</span>}
    </div>
  );
}

// ── Per-widget error boundary ───────────────────────────────────────────────

interface BoundaryProps {
  widgetId: string;
  widgetType: string;
  children: ReactNode;
}

class WidgetErrorBoundary extends Component<BoundaryProps, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error(`widget '${this.props.widgetId}' (${this.props.widgetType}) crashed:`, error);
  }

  render() {
    if (this.state.error) {
      return (
        <ErrorBox title={`${this.props.widgetType} failed`} detail={this.state.error.message} />
      );
    }
    return this.props.children;
  }
}

// ── Widget node rendering ───────────────────────────────────────────────────

interface NodeViewProps {
  node: WidgetNode;
  macros: MacroValues;
  formulas: readonly FormulaDeclaration[] | undefined;
  /** Parent's absolute origin, subtracted to cancel the nesting offset. */
  parentOrigin?: { x: number; y: number };
  /** Widget-id chain from the root (defensive cycle guard for aliased nodes). */
  idChain: readonly string[];
}

// EDM/PyDM mouse semantics: graphics and static text NEVER intercept clicks,
// and container rectangles are hit-transparent outside their children —
// converted screens routinely draw frame/underline graphics OVER buttons
// (document order = z-order), and without this the topmost drawing swallows
// every real click (e.g. tab-selector rows under their decorative underline).
// Interactive wrappers set pointerEvents 'auto' explicitly so they stay
// clickable inside a pointer-transparent container.
const POINTER_TRANSPARENT_TYPES = new Set([
  // drawings + static content (no children, never interactive)
  'rectangle',
  'ellipse',
  'arc',
  'line',
  'polygon',
  'text-label',
  'image-view',
  // containers: the wrapper is transparent, the children re-enable themselves
  'group',
  'frame',
  'group-box',
  'qwidget-container',
  'scroll-area',
  'tabs',
]);

function positionStyle(
  geometry: Geometry,
  parentOrigin: { x: number; y: number } | undefined,
  nodeType: string
): CSSProperties {
  return {
    position: 'absolute',
    left: geometry.x - (parentOrigin?.x ?? 0),
    top: geometry.y - (parentOrigin?.y ?? 0),
    width: geometry.width,
    height: geometry.height,
    pointerEvents: POINTER_TRANSPARENT_TYPES.has(nodeType) ? 'none' : 'auto',
  };
}

function renderChildren(
  node: WidgetNode,
  macros: MacroValues,
  formulas: readonly FormulaDeclaration[] | undefined,
  idChain: readonly string[]
): ReactNode[] | undefined {
  if (!node.children || node.children.length === 0) return undefined;
  const origin = { x: node.geometry.x, y: node.geometry.y };
  // IR z-order = array order; DOM order preserves it.
  return node.children.map((child) => (
    <WidgetNodeView
      key={child.id}
      node={child}
      macros={macros}
      formulas={formulas}
      parentOrigin={origin}
      idChain={idChain}
    />
  ));
}

function WidgetNodeView({ node, macros, formulas, parentOrigin, idChain }: NodeViewProps) {
  // Rules compile with the owning screen's macros and patch the node's
  // effective props/geometry/visibility (base < rule; `visible` ANDs).
  const outputs = useWidgetRules(node.rules, formulas, macros);

  if (idChain.includes(node.id)) {
    console.warn(`widget '${node.id}' appears in its own ancestor chain; skipping (cycle)`);
    return null;
  }
  const chain = [...idChain, node.id];

  const irProps = substituteProps(node.props, macros);
  const effective = applyRuleOutputs(irProps, node.geometry, node.rules, outputs);
  if (!effective.visible) return null;

  const style = positionStyle(effective.geometry, parentOrigin, node.type);

  // Carrier props the wrapper applies (parity with the builder's preview).
  const rotation = typeof effective.props.rotation === 'number' ? effective.props.rotation : 0;
  const transparency = Math.min(100, Math.max(0, Number(effective.props.opacity ?? 0) || 0));
  if (rotation) style.transform = `rotate(${rotation}deg)`;
  style.opacity = 1 - transparency / 100;

  // The IR root container: a chrome-less positioned box; children only.
  // The converter carries the EDM screen background on the canvas so the page
  // matches the legacy display's field color instead of the app theme.
  if (node.type === 'absolute-canvas') {
    if (typeof effective.props.backgroundColor === 'string') {
      style.backgroundColor = effective.props.backgroundColor;
    }
    return <div style={style}>{renderChildren(node, macros, formulas, chain)}</div>;
  }

  if (node.type === 'embedded-display') {
    return (
      <div style={style}>
        <WidgetErrorBoundary widgetId={node.id} widgetType={node.type}>
          <EmbeddedScreenNode
            file={typeof effective.props.file === 'string' ? effective.props.file : undefined}
            nodeMacros={
              effective.props.macros && typeof effective.props.macros === 'object'
                ? (effective.props.macros as Record<string, string>)
                : undefined
            }
            parentMacros={macros}
          />
        </WidgetErrorBoundary>
      </div>
    );
  }

  const mapped =
    node.type === 'unknown-widget' ? undefined : mapIRWidget(node.type, effective.props);
  const definition = mapped ? widgetRegistry.get(mapped.type) : undefined;

  if (!mapped || !definition) {
    const original =
      typeof effective.props.originalClass === 'string' ? effective.props.originalClass : node.type;
    return (
      <div style={style}>
        <PlaceholderBox title="Unknown widget" detail={original} />
      </div>
    );
  }

  const WidgetComponent = definition.component;
  const children = renderChildren(node, macros, formulas, chain);

  return (
    <div style={style}>
      <WidgetErrorBoundary widgetId={node.id} widgetType={node.type}>
        <WidgetComponent
          id={node.id}
          type={mapped.type}
          layout={{
            x: effective.geometry.x,
            y: effective.geometry.y,
            width: effective.geometry.width,
            height: effective.geometry.height,
          }}
          props={mapped.props}
          isSelected={false}
          isEditing={false}
        >
          {children}
        </WidgetComponent>
      </WidgetErrorBoundary>
    </div>
  );
}

// ── Embedded screens ────────────────────────────────────────────────────────

type EmbedState = { status: 'error'; message: string } | { status: 'ready'; screen: ScreenJSON };

function EmbeddedScreenNode({
  file,
  nodeMacros,
  parentMacros,
}: {
  file: string | undefined;
  nodeMacros: Record<string, string> | undefined;
  parentMacros: MacroValues;
}) {
  const embed = useContext(EmbedContext);
  const ref = file ? substituteMacros(file, parentMacros) : undefined;
  // Resolution state is tagged with the ref it belongs to; a ref change
  // makes it stale, so "loading" is derived rather than reset in the effect.
  const [resolved, setResolved] = useState<{ ref: string; state: EmbedState } | null>(null);

  const { resolveScreen, depth, ancestors, maxDepth } = embed;
  const cycle = ref !== undefined && ancestors.includes(ref);
  const blocked = !ref || !resolveScreen || cycle || depth >= maxDepth;

  useEffect(() => {
    if (blocked || !ref || !resolveScreen) return;
    let cancelled = false;
    resolveScreen(ref).then(
      (screen) => {
        if (!cancelled) setResolved({ ref, state: { status: 'ready', screen } });
      },
      (err: unknown) => {
        if (!cancelled)
          setResolved({
            ref,
            state: { status: 'error', message: err instanceof Error ? err.message : String(err) },
          });
      }
    );
    return () => {
      cancelled = true;
    };
  }, [ref, resolveScreen, blocked]);

  if (!ref) return <ErrorBox title="Embedded screen" detail="missing 'file' reference" />;
  if (!resolveScreen)
    return <ErrorBox title="Embedded screen" detail="no resolveScreen provided" />;
  if (cycle) return <ErrorBox title="Embedded screen cycle" detail={ref} />;
  if (depth >= maxDepth)
    return <ErrorBox title="Embedding too deep" detail={`depth limit ${maxDepth} at ${ref}`} />;

  const state = resolved && resolved.ref === ref ? resolved.state : null;
  if (state === null) return <div data-testid="embed-loading" />;
  if (state.status === 'error')
    return <ErrorBox title={`Failed to load ${ref}`} detail={state.message} />;

  const child = state.screen;
  if (child.schemaVersion !== SCHEMA_VERSION) {
    return (
      <ErrorBox
        title="Schema version mismatch"
        detail={`${ref} declares ${String(child.schemaVersion)}, runtime speaks ${SCHEMA_VERSION}`}
      />
    );
  }

  return (
    <EmbeddedScreenView
      screen={child}
      screenRef={ref}
      nodeMacros={nodeMacros}
      parentMacros={parentMacros}
      embed={embed}
    />
  );
}

function EmbeddedScreenView({
  screen,
  screenRef,
  nodeMacros,
  parentMacros,
  embed,
}: {
  screen: ScreenJSON;
  screenRef: string;
  nodeMacros: Record<string, string> | undefined;
  parentMacros: MacroValues;
  embed: EmbedContextValue;
}) {
  // Parent macros ⊕ node overrides (values resolved against the parent),
  // with the child's own declared defaults as the weakest layer. Memoized on
  // the serialized node macros — the props bag is re-built by the parent's
  // render, but rule subscriptions downstream need a stable identity.
  const nodeMacrosKey = JSON.stringify(nodeMacros ?? null);
  const macros = useMemo(
    () => resolveScreenMacros(screen, childMacros(parentMacros, nodeMacros)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- nodeMacrosKey stands in for nodeMacros
    [screen, parentMacros, nodeMacrosKey]
  );
  const childEmbed = useMemo<EmbedContextValue>(
    () => ({
      resolveScreen: embed.resolveScreen,
      depth: embed.depth + 1,
      ancestors: [...embed.ancestors, screenRef],
      maxDepth: embed.maxDepth,
    }),
    [embed, screenRef]
  );

  return (
    <EmbedContext.Provider value={childEmbed}>
      <div
        data-testid="embedded-screen"
        data-screen-id={screen.id}
        style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }}
      >
        <ScreenPVScope formulas={screen.formulas} macros={macros}>
          <WidgetNodeView
            node={screen.root}
            macros={macros}
            formulas={screen.formulas}
            idChain={[]}
          />
        </ScreenPVScope>
      </div>
    </EmbedContext.Provider>
  );
}

// ── Top-level renderer ──────────────────────────────────────────────────────

/**
 * Render a Screen IR document.
 *
 * Macro semantics: the screen's declared defaults, overridden by the caller's
 * `macros`, substituted across ALL string props (`${NAME}` and legacy
 * `$(NAME)`); embedded screens receive the parent's effective macros plus the
 * embedding node's overrides. Unresolved macros stay visible verbatim.
 */
export function ScreenRenderer({
  screen,
  macros,
  resolveScreen,
  resolveAsset,
  maxDepth = 8,
  renderMode,
}: ScreenRendererProps) {
  const inheritedMode = useContext(RenderModeContext);
  const mode = renderMode ?? inheritedMode;
  const effectiveMacros = useMemo(() => resolveScreenMacros(screen, macros), [screen, macros]);
  const embed = useMemo<EmbedContextValue>(
    () => ({ resolveScreen, depth: 0, ancestors: [], maxDepth }),
    [resolveScreen, maxDepth]
  );

  const tree = (
    <RenderModeContext.Provider value={mode}>
      <EmbedContext.Provider value={embed}>
        <div
          data-testid="screen-root"
          data-screen-id={screen.id}
          data-render-mode={mode}
          style={{
            position: 'relative',
            width: screen.metadata.size.width,
            height: screen.metadata.size.height,
            overflow: 'hidden',
          }}
        >
          <ScreenPVScope formulas={screen.formulas} macros={effectiveMacros}>
            <WidgetNodeView
              node={screen.root}
              macros={effectiveMacros}
              formulas={screen.formulas}
              idChain={[]}
            />
          </ScreenPVScope>
        </div>
      </EmbedContext.Provider>
    </RenderModeContext.Provider>
  );

  // Without a resolver the context's identity default applies.
  if (!resolveAsset) return tree;
  return <AssetResolverContext.Provider value={resolveAsset}>{tree}</AssetResolverContext.Provider>;
}
