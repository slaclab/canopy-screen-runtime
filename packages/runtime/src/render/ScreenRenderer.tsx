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
// @slaclab/canopy-react context, rules consume the Formula Engine through the
// FormulaSubscriberContext — the composition root provides both. Each
// rendered screen (root and every embedded screen) wraps the PV context in a
// ScreenPVScope so `formula://<name>` widget channels evaluate that screen's own
// formulas with its own macros.
//
// Presentation: `renderMode` (edm | carbon) is provided to every widget —
// embedded screens included — through the widget set's RenderModeContext;
// without the prop an enclosing provider (or the 'edm' default) applies.

import {
  Component,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { CSSProperties, ReactNode } from 'react';
import {
  canopyDefaultFlat,
  isSupportedSchemaVersion,
  readActions,
  SUPPORTED_SCHEMA_VERSIONS,
} from '@slaclab/canopy-screen-ir';
import type { Action, ColorRole, FlatScheme } from '@slaclab/canopy-screen-ir';
import type {
  Geometry,
  MacroValues,
  PropertyValue,
  ScreenJSON,
  WidgetNode,
} from '@slaclab/canopy-screen-ir';
import type { FormulaDeclaration } from '@slaclab/canopy-screen-ir';
import {
  AssetResolverContext,
  PVServiceContext,
  RenderModeContext,
  WRITES_INERT_PROP,
  useWriteGate,
  widgetRegistry,
} from '@slaclab/canopy-screen-widgets';
import type { RenderMode, ResolveAsset, WriteGateService } from '@slaclab/canopy-screen-widgets';
import { isGateBypass } from '../channels.js';
import { childMacros, resolveScreenMacros, substituteMacros, substituteProps } from '../macros.js';
import { applyRuleOutputs } from '../rules/applyRules.js';
import { useWidgetRulesState } from '../rules/useWidgetRules.js';
import { ActionHostContext } from '../actions/ActionHostContext.js';
import { dispatchActions } from '../actions/dispatch.js';
import { usePVLinkState } from '../pv/usePVLinkState.js';
import type { PVLinkState } from '../pv/usePVLinkState.js';
import { combineLinkStates, drawsCue, nodeLinkChannels, ruleLinkState } from './linkState.js';
import { HoverLayer, hoverLabel, hoverLabelPlacement, restingOutline } from './hover.js';
import { mapIRWidget } from './irMap.js';
import { ScreenPVScope } from './ScreenPVScope.js';
import { resolveRole, resolveRoles } from '../theme/resolveRoles.js';
import { withDefaultRoles } from '../theme/defaultRoles.js';
import { SchemeContext } from '../theme/schemeContext.js';
import { getMode, subscribe as subscribeMode } from '../theme/modeStore.js';
import { useSchemeStyleSheet } from '../theme/schemeStyleSheet.js';
import { rebaseThroughEmbed, resolveAgainstChain } from './resolveRef.js';
import {
  embedFile,
  embedInstanceKey,
  embedNodeMacros,
  embedOrder,
  isBaseHidden,
} from './collectPVs.js';

/**
 * Resolves an embedded screen reference. The runtime passes the node's `file`
 * prop already resolved against its declaring document (see `screenPath`).
 */
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
  /**
   * Root-relative path of this document. Embedded refs are resolved against
   * the document that declares them and handed to `resolveScreen` in
   * root-relative form. Omitted, paths come out relative to this document's
   * directory, which is what a top-document-relative resolver expects.
   */
  screenPath?: string;
  /**
   * Flat color scheme that color roles in props resolve against (default:
   * `canopyDefaultFlat`). Read by this top root only; embedded screens
   * inherit it.
   */
  colorScheme?: FlatScheme;
}

interface EmbedContextValue {
  resolveScreen?: ResolveScreen;
  depth: number;
  /** Path of the top document the embed chain is folded from. */
  topScreenPath?: string;
  /** Authored refs of every embedded screen on the path, outermost first. */
  chain: readonly string[];
  /** Resolved paths of every screen on the embedding path (cycle guard). */
  ancestors: readonly string[];
  maxDepth: number;
  /**
   * This screen instance's key (`''` for the top screen): the
   * `expandScreen` / `collectScreenPVs` instance key of the same screen.
   */
  instanceKey: string;
  /**
   * This instance's indexed embeds (`embedOrder`, from base props, so a rule
   * never shifts a key): node -> its index in the child instance key.
   */
  embedIndex: ReadonlyMap<WidgetNode, number>;
}

const NO_EMBEDS: ReadonlyMap<WidgetNode, number> = new Map();

const EmbedContext = createContext<EmbedContextValue>({
  depth: 0,
  chain: [],
  ancestors: [],
  maxDepth: 8,
  instanceKey: '',
  embedIndex: NO_EMBEDS,
});

/** The indexed embeds of one screen instance, keyed by node. */
function embedIndexOf(screen: ScreenJSON, macros: MacroValues): ReadonlyMap<WidgetNode, number> {
  const slots = embedOrder(screen, macros);
  if (slots.length === 0) return NO_EMBEDS;
  return new Map(slots.map((slot) => [slot.node, slot.index]));
}

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

/**
 * The colour of the cue a `partial` / `disconnected` node draws (an inset
 * dashed outline): the scheme's DISCONNECTED role.
 */
const CUE_COLOR: ColorRole = { $role: 'DISCONNECTED', fallback: '#da1e28' };

/**
 * The wrapper attributes of every node: `data-node-id`, `data-instance` (the
 * screen instance's key, `''` for the top screen), on a node with prop
 * channels `data-pv` (the channels as subscribed, space-separated) and, on a
 * machine-bound node only, `data-pv-state`.
 */
function wrapperAttributes(
  nodeId: string,
  instance: string,
  channels: readonly string[],
  pvState: PVLinkState | null
): Record<string, string> {
  const attrs: Record<string, string> = { 'data-node-id': nodeId, 'data-instance': instance };
  if (channels.length > 0) attrs['data-pv'] = channels.join(' ');
  if (pvState !== null) attrs['data-pv-state'] = pvState;
  return attrs;
}

/** Whether an action list holds a write that goes to the machine. */
function hasMachineWrite(actions: readonly Action[], macros: MacroValues): boolean {
  return actions.some(
    (a) => a.type === 'write_pv' && !isGateBypass(substituteMacros(a.pvName, macros))
  );
}

const NO_SUBSCRIPTION = () => {};

/**
 * Why the gate does not accept machine writes now, or null while it does —
 * always null with no gate, or a gate that makes no statement.
 */
function useWritesInertReason(gate: WriteGateService | null): string | null {
  const subscribe = useCallback(
    (listener: () => void) => gate?.subscribeWrites?.(listener) ?? NO_SUBSCRIPTION,
    [gate]
  );
  const snapshot = useCallback(() => {
    const writes = gate?.writes?.();
    return writes?.disabled ? (writes.reason ?? '') : null;
  }, [gate]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

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

/** Test seam: called with the node on every render of a mounted (not base-hidden) node. */
let widgetRenderProbe: ((node: WidgetNode) => void) | null = null;

/**
 * Installs (or, with `null`, removes) a function every mounted node's view
 * calls on each render. A no-op when unset; render-count tests use it.
 */
export function __setWidgetRenderProbe(fn: ((node: WidgetNode) => void) | null): void {
  widgetRenderProbe = fn;
}

/**
 * A node of the screen. A base-hidden node (`isBaseHidden`, the test
 * `walkMounted` uses) renders nothing and runs none of the mounted view's
 * hooks: no PV subscription, no rule compiled or subscribed, no children.
 */
function WidgetNodeView(props: NodeViewProps) {
  const { node, macros } = props;
  // Memoized so a node whose props and macros are unchanged keeps one props
  // identity.
  const baseProps = useMemo(() => substituteProps(node.props, macros), [node.props, macros]);
  if (isBaseHidden(baseProps)) return null;
  return <MountedNodeView {...props} baseProps={baseProps} />;
}

interface MountedNodeViewProps extends NodeViewProps {
  /** The node's macro-substituted base props. */
  baseProps: Record<string, PropertyValue>;
}

function MountedNodeView({
  node,
  macros,
  formulas,
  parentOrigin,
  idChain,
  baseProps,
}: MountedNodeViewProps) {
  widgetRenderProbe?.(node);
  // Rules compile with the owning screen's macros and patch the node's
  // effective props/geometry/visibility (base < rule; `visible` ANDs).
  const rulesLink = useWidgetRulesState(node.rules, formulas, macros);
  const outputs = rulesLink.outputs;
  // Action wiring inputs; read before the early returns (rules of hooks).
  const embed = useContext(EmbedContext);
  const host = useContext(ActionHostContext);
  const pvService = useContext(PVServiceContext);
  // The screen's write gate (the viewer's, per screen), or null: machine
  // writes of a click's actions then go straight through pvService.
  const gate = useWriteGate();
  const writesInert = useWritesInertReason(gate);
  const [hovered, setHovered] = useState(false);
  // Color roles -> CSS strings over the substituted props, with the type's
  // default roles filled in first. Memoized so a node whose props, macros and
  // scheme are unchanged keeps one props identity.
  const flat = useContext(SchemeContext);
  const irProps = useMemo(
    () => resolveRoles(withDefaultRoles(node.type, baseProps), flat),
    [node.type, baseProps, flat]
  );
  // Live-data cue: the link state of the node's machine channels, from base
  // (un-rule-patched) props and the rules' own delivery state.
  const linkChannels = useMemo(
    () => nodeLinkChannels(node, baseProps, formulas, macros),
    [node, baseProps, formulas, macros]
  );
  const propLink = usePVLinkState(linkChannels.propChannels);
  const pvState = combineLinkStates(
    propLink,
    linkChannels.ruleBound ? ruleLinkState(rulesLink) : null
  );

  if (idChain.includes(node.id)) {
    console.warn(`widget '${node.id}' appears in its own ancestor chain; skipping (cycle)`);
    return null;
  }
  const chain = [...idChain, node.id];

  const effective = applyRuleOutputs(irProps, node.geometry, node.rules, outputs);
  if (!effective.visible) return null;

  const style = positionStyle(effective.geometry, parentOrigin, node.type);
  const attrs = wrapperAttributes(node.id, embed.instanceKey, linkChannels.channels, pvState);

  // Widget actions (reserved `props.actions`, macro-substituted): a click on
  // the positioned wrapper runs them. Clicks from the inner widget bubble up.
  // A list with a machine write is inert while the gate refuses machine
  // writes: no click handler, so nothing in it runs (no navigation, no
  // toast); the reason is its hover and reaches the widget for its button.
  const actions = readActions(effective.props);
  const inertReason = writesInert !== null && hasMachineWrite(actions, macros) ? writesInert : null;
  if (inertReason !== null) {
    attrs['aria-disabled'] = 'true';
    attrs.title = inertReason;
  }
  let onClick: (() => void) | undefined;
  if (actions.length > 0) style.pointerEvents = 'auto';
  // A clickable node: pointer cursor, and a highlight layer while hovered.
  // The link cue outranks the hover outline, which outranks the resting one.
  const clickable = actions.length > 0 && inertReason === null;
  const showHover = clickable && hovered;
  const resting = restingOutline(effective.props);
  if (drawsCue(pvState)) {
    style.outline = `1px dashed ${resolveRole(CUE_COLOR, flat)}`;
    style.outlineOffset = -1;
  } else if (resting !== null && !showHover) {
    Object.assign(style, resting);
  }
  const hoverHandlers = clickable
    ? { onMouseEnter: () => setHovered(true), onMouseLeave: () => setHovered(false) }
    : undefined;
  if (clickable) style.cursor = 'pointer';
  const hoverLayer = showHover ? (
    <HoverLayer
      label={hoverLabel(effective.props)}
      placement={hoverLabelPlacement(effective.props)}
      flat={flat}
    />
  ) : null;
  if (actions.length > 0 && inertReason === null) {
    onClick = () => {
      void dispatchActions(actions, {
        ...host,
        macros,
        pvService: pvService ?? {
          put: (pv: string) =>
            console.warn(`[canopy-screen-runtime] no PV service; write to '${pv}' ignored`),
        },
        // Relative display files resolve against the declaring document.
        resolveManifest: (file) =>
          host.resolveManifest(resolveAgainstChain(embed.topScreenPath, embed.chain, file)),
        gate,
      }).catch((err: unknown) => {
        host.showError(err instanceof Error ? err.message : String(err));
      });
    };
  }

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
    return (
      <div {...attrs} {...hoverHandlers} style={style} onClick={onClick}>
        {renderChildren(node, macros, formulas, chain)}
        {hoverLayer}
      </div>
    );
  }

  if (node.type === 'embedded-display') {
    return (
      <div {...attrs} {...hoverHandlers} style={style} onClick={onClick}>
        <WidgetErrorBoundary widgetId={node.id} widgetType={node.type}>
          <EmbeddedScreenNode
            node={node}
            authored={embedFile(effective.props, macros)}
            nodeMacros={embedNodeMacros(effective.props)}
            parentMacros={macros}
          />
        </WidgetErrorBoundary>
        {hoverLayer}
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
      <div {...attrs} {...hoverHandlers} style={style} onClick={onClick}>
        <PlaceholderBox title="Unknown widget" detail={original} />
        {hoverLayer}
      </div>
    );
  }

  const WidgetComponent = definition.component;
  const children = renderChildren(node, macros, formulas, chain);

  return (
    <div {...attrs} {...hoverHandlers} style={style} onClick={onClick}>
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
          props={
            inertReason === null
              ? mapped.props
              : { ...mapped.props, [WRITES_INERT_PROP]: inertReason }
          }
          isSelected={false}
          isEditing={false}
        >
          {children}
        </WidgetComponent>
      </WidgetErrorBoundary>
      {hoverLayer}
    </div>
  );
}

// ── Embedded screens ────────────────────────────────────────────────────────

type EmbedState = { status: 'error'; message: string } | { status: 'ready'; screen: ScreenJSON };

function EmbeddedScreenNode({
  node,
  authored,
  nodeMacros,
  parentMacros,
}: {
  node: WidgetNode;
  /** The `file` prop as `embedFile` substitutes it (shared with `expandScreen`). */
  authored: string | undefined;
  nodeMacros: Record<string, string> | undefined;
  parentMacros: MacroValues;
}) {
  const embed = useContext(EmbedContext);
  const { resolveScreen, depth, ancestors, maxDepth, topScreenPath, chain } = embed;
  // The key comes from the base props' embed order; a rule that retargets
  // `file` renders the retargeted screen under the same key. An embed whose
  // base `file` is empty takes no index (`expandScreen` never expands it).
  const index = embed.embedIndex.get(node);
  const instanceKey =
    index === undefined
      ? `${embed.instanceKey}/-:${node.id}`
      : embedInstanceKey(embed.instanceKey, index, node.id);
  // Resolve against the declaring document, not the top one.
  const ref =
    authored !== undefined ? resolveAgainstChain(topScreenPath, chain, authored) : undefined;
  // Resolution state is tagged with the ref it belongs to; a ref change
  // makes it stale, so "loading" is derived rather than reset in the effect.
  const [resolved, setResolved] = useState<{ ref: string; state: EmbedState } | null>(null);

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
  if (!isSupportedSchemaVersion(child.schemaVersion)) {
    return (
      <ErrorBox
        title="Schema version mismatch"
        detail={`${ref} declares ${String(child.schemaVersion)}, runtime speaks ${SUPPORTED_SCHEMA_VERSIONS.join(', ')}`}
      />
    );
  }

  return (
    <EmbeddedScreenView
      screen={child}
      screenRef={ref}
      instanceKey={instanceKey}
      authoredRef={authored ?? ref}
      nodeMacros={nodeMacros}
      parentMacros={parentMacros}
      embed={embed}
    />
  );
}

function EmbeddedScreenView({
  screen,
  screenRef,
  instanceKey,
  authoredRef,
  nodeMacros,
  parentMacros,
  embed,
}: {
  screen: ScreenJSON;
  screenRef: string;
  instanceKey: string;
  authoredRef: string;
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
      topScreenPath: embed.topScreenPath,
      chain: [...embed.chain, authoredRef],
      ancestors: [...embed.ancestors, screenRef],
      maxDepth: embed.maxDepth,
      instanceKey,
      embedIndex: embedIndexOf(screen, macros),
    }),
    [embed, screenRef, authoredRef, instanceKey, screen, macros]
  );
  // Asset refs inside this document are relative to it: fold only this
  // embed's own link and hand the result to the parent's resolver, so nested
  // embeds compose link by link up to the top-level resolver.
  const parentResolve = useContext(AssetResolverContext);
  const resolveAsset = useMemo<ResolveAsset>(
    () => (ref) => parentResolve(rebaseThroughEmbed(authoredRef, ref)),
    [parentResolve, authoredRef]
  );

  return (
    <AssetResolverContext.Provider value={resolveAsset}>
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
    </AssetResolverContext.Provider>
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
  screenPath,
  colorScheme = canopyDefaultFlat,
  renderMode,
}: ScreenRendererProps) {
  const inheritedMode = useContext(RenderModeContext);
  const mode = renderMode ?? inheritedMode;
  const effectiveMacros = useMemo(() => resolveScreenMacros(screen, macros), [screen, macros]);
  const embed = useMemo<EmbedContextValue>(
    () => ({
      resolveScreen,
      depth: 0,
      topScreenPath: screenPath,
      chain: [],
      // The top document is on the path too, so a screen embedding itself is a cycle.
      ancestors: screenPath ? [resolveAgainstChain(undefined, [], screenPath)] : [],
      maxDepth,
      instanceKey: '',
      embedIndex: embedIndexOf(screen, effectiveMacros),
    }),
    [resolveScreen, maxDepth, screenPath, screen, effectiveMacros]
  );

  // The scheme's stylesheet, scoped to this root by data-scheme; the mode is
  // mirrored onto data-theme imperatively, so a mode flip renders nothing.
  useSchemeStyleSheet(colorScheme);
  const rootRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return undefined;
    const apply = () => {
      const theme = getMode();
      el.dataset.theme = theme;
      el.style.colorScheme = theme;
    };
    apply();
    return subscribeMode(apply);
  }, []);

  const tree = (
    <RenderModeContext.Provider value={mode}>
      <SchemeContext.Provider value={colorScheme}>
        <EmbedContext.Provider value={embed}>
          <div
            ref={rootRef}
            className="canopy-screen"
            data-testid="screen-root"
            data-screen-id={screen.id}
            data-scheme={colorScheme.meta.flatHash}
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
      </SchemeContext.Provider>
    </RenderModeContext.Provider>
  );

  // Without a resolver the context's identity default applies.
  if (!resolveAsset) return tree;
  return <AssetResolverContext.Provider value={resolveAsset}>{tree}</AssetResolverContext.Provider>;
}
