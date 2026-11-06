// The PVs a rendered screen shows, read from its IR: every widget's PV
// channels, the PVs its rules watch, and the inputs of the formulas it uses,
// with macros expanded exactly as ScreenRenderer expands them, through every
// embedded screen. A host uses it to offer "plot this screen's PVs".
//
// `expandScreen` is the one executable definition of what the renderer
// mounts: every node of every screen instance (the top screen, then each
// embedded screen in document order) with its macro-substituted base props.
// It does not descend into the children of an `embedded-display` (its embed
// expands through `file`), of an `unknown-widget` or of a type the renderer
// has no mapping for: the renderer mounts none of them. A base-hidden node
// (base props `visible: false`) is not listed and nothing under it is; a
// base-hidden embed is not expanded, but it keeps its index in the instance
// keys of its siblings. `collectScreenPVs` is its PV view.
// `__fixtures__/expand-vectors.json` pins it for the other implementations of
// the walk.
//
// One group per screen instance, each PV listed once, in the first group that
// shows it. Names that are not PVs are left out: `loc://` locals, `formula://`
// formula references (their input PVs are listed instead) and names with an
// unresolved macro. Widget actions are not read: what a button writes is not
// what the screen shows. An embedded screen that fails to load, is too deep
// or embeds itself is skipped, as the renderer would show an error box; it
// keeps its index in the instance keys of its siblings.

import { isSupportedSchemaVersion } from '@slaclab/canopy-screen-ir';
import type {
  FormulaDeclaration,
  MacroValues,
  PropertyValue,
  Rule,
  ScreenJSON,
  WidgetNode,
} from '@slaclab/canopy-screen-ir';
import {
  childMacros,
  hasMacro,
  resolveScreenMacros,
  substituteMacros,
  substituteProps,
} from '../macros.js';
import { isLocalChannel } from '../channels.js';
import { formulaName, isFormulaRef } from '../formulaRef.js';
import { irMapManifest } from './irMap.js';
import { resolveAgainstChain } from './resolveRef.js';
import type { ResolveScreen } from './ScreenRenderer.js';

/** How a PV appears on the screen; a host may rank by it. */
export type ScreenPVRole =
  /** Shown as a value: a label, meter, gauge, bar, tank, thermometer. */
  | 'readback'
  /** Plotted by a waveform or XY plot. */
  | 'plot'
  /** Written by an input: text entry, slider, spinbox, button, checkbox, menu. */
  | 'control'
  /** Shown as a state: an LED or a byte indicator. */
  | 'status'
  /** Watched by a rule (colour, visibility, ...). */
  | 'rule'
  /** An input of a formula the screen uses. */
  | 'formula'
  /** A channel of any other widget. */
  | 'other';

export interface ScreenPV {
  name: string;
  role: ScreenPVRole;
}

export interface ScreenPVGroup {
  /** The embed chain to this instance (`''` for the top screen), unique per group. */
  key: string;
  /** The screen's title. */
  title: string;
  /** The embedding node's macros (`NAME=value, ...`), '' for the top screen. */
  detail: string;
  /** 0 for the top screen, 1 for a screen it embeds, ... */
  depth: number;
  pvs: ScreenPV[];
}

export interface ExpandScreenOptions {
  /** Caller macro values, as given to ScreenRenderer. */
  macros?: Record<string, string>;
  /** Resolves embedded screens; without it they are skipped. */
  resolveScreen?: ResolveScreen;
  /** Embedding depth cap, as ScreenRenderer's (default 8). */
  maxDepth?: number;
  /** Root-relative path of the top document, as ScreenRenderer's. */
  screenPath?: string;
}

/** Options of `collectScreenPVs`: the same as `expandScreen`'s. */
export type CollectScreenPVsOptions = ExpandScreenOptions;

/** One node the renderer mounts, in one screen instance. */
export interface ExpandedNode {
  /** The instance's key (`''` for the top screen), as `ScreenPVGroup.key`. */
  instance: string;
  nodeId: string;
  type: string;
  /** Base props, macro-substituted; no rule applied. */
  props: Record<string, PropertyValue>;
  /**
   * The declaring document's resolved ref: `screenPath` (`''` without it) for
   * the top screen, the ref handed to `resolveScreen` for an embedded one.
   */
  screenRef: string;
  /** `ruleChannels` of the node's rules under its instance's macros. */
  ruleChannels: string[];
}

export interface ExpandedScreen {
  nodes: ExpandedNode[];
  groups: ScreenPVGroup[];
}

/** One `embedded-display` of a screen instance that takes an instance index. */
export interface EmbedSlot {
  node: WidgetNode;
  /** Position among the instance's embeds: the instance key's `<index>`. */
  index: number;
  /** The authored file, as `embedFile` substitutes it. */
  file: string;
  /** The node's `macros` prop, substituted once (`childMacros` resolves the values again). */
  nodeMacros: Record<string, string> | undefined;
}

const ROLE_BY_TYPE: Record<string, ScreenPVRole> = {
  'pv-label': 'readback',
  'pv-progress-bar': 'readback',
  'pv-meter': 'readback',
  'pv-gauge': 'readback',
  'pv-tank': 'readback',
  'pv-thermometer': 'readback',
  'waveform-plot': 'plot',
  'xy-plot': 'plot',
  'pv-array-plot': 'plot',
  'pv-text-input': 'control',
  'pv-slider': 'control',
  'pv-spinbox': 'control',
  'pv-button': 'control',
  'pv-checkbox': 'control',
  'pv-enum-combobox': 'control',
  'pv-toggle': 'control',
  'pv-radio-group': 'control',
  'pv-tabs': 'control',
  'pv-led': 'status',
  'pv-byte-led': 'status',
};

// Prop keys that name a PV channel, at any depth (plot curves nest them):
// `pv`, `pvName`, `channel`, `x_channel`/`y_channel`, `y_channels` (one channel
// per array item), `readbackPV`, `controlPV`, ...
const CHANNEL_KEY = /^(pv|pvName|channel|[A-Za-z0-9]+_channels?|[a-z][A-Za-z0-9]*(Channel|PV))$/;
// Props never read for channels: actions write, rules are read separately,
// an embed's macros are values for the child, not PVs of this screen.
const SKIPPED_PROPS = new Set(['actions', 'macros', 'rules']);

const EMBED_TYPE = 'embedded-display';
const UNKNOWN_TYPE = 'unknown-widget';
const RENDERER_NATIVE_TYPES: ReadonlySet<string> = new Set(['absolute-canvas', EMBED_TYPE]);

/**
 * The IR types the renderer maps onto a widget (its `TYPE_MAP`), sorted.
 * `absolute-canvas` and `embedded-display` are drawn by the renderer itself
 * and not listed; any other type is unmapped and renders as a placeholder.
 */
export function mappedTypes(): string[] {
  return Object.keys(irMapManifest()).filter((type) => !RENDERER_NATIVE_TYPES.has(type));
}

let mappedSet: ReadonlySet<string> | undefined;

/**
 * A node the renderer draws as a placeholder: `unknown-widget`, or a type that
 * is neither mapped nor renderer-native. Never decided by the widget registry.
 */
function isUnmapped(type: string): boolean {
  mappedSet ??= new Set(mappedTypes());
  return type === UNKNOWN_TYPE || (!mappedSet.has(type) && !RENDERER_NATIVE_TYPES.has(type));
}

/** Whether the renderer mounts a node's children (see the module comment). */
function mountsChildren(type: string): boolean {
  return type !== EMBED_TYPE && !isUnmapped(type);
}

function channelsOf(value: PropertyValue, key: string | undefined, out: string[]): void {
  if (typeof value === 'string') {
    if (key !== undefined && CHANNEL_KEY.test(key)) out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) channelsOf(item as PropertyValue, key, out);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (!SKIPPED_PROPS.has(k)) channelsOf(v as PropertyValue, k, out);
    }
  }
}

/**
 * The PV channels a node's props name, in prop order: trimmed, blanks
 * dropped, `loc://` / `formula://` names and unresolved macros kept. `props` are
 * already macro-substituted. An `embedded-display`, an `unknown-widget` and an
 * unmapped type have none (the renderer mounts no widget for them).
 */
export function nodeChannels(
  nodeType: string,
  substitutedProps: Readonly<Record<string, PropertyValue>>
): string[] {
  if (nodeType === EMBED_TYPE || isUnmapped(nodeType)) return [];
  const names: string[] = [];
  for (const [key, value] of Object.entries(substitutedProps)) {
    if (!SKIPPED_PROPS.has(key)) channelsOf(value, key, names);
  }
  return names.map((name) => name.trim()).filter((name) => name !== '');
}

/**
 * The channels a node's rules watch, in rule order: each conditional rule's
 * `pvs[].name` and each formula rule's bindings, macro-substituted with the
 * node's instance macros, trimmed, blanks dropped. Not deduplicated; a
 * `formula://` name is kept as written (not expanded into its formula's inputs).
 */
export function ruleChannels(
  rules: readonly Rule[] | undefined,
  formulas: readonly FormulaDeclaration[] | undefined,
  macros: MacroValues
): string[] {
  const out: string[] = [];
  for (const rule of rules ?? []) {
    if ('formula' in rule) {
      const formula = formulas?.find((f) => f.name === rule.formula);
      for (const binding of Object.values(formula?.bindings ?? {})) {
        out.push(substituteMacros(binding, macros));
      }
    } else {
      for (const pv of rule.pvs) out.push(substituteMacros(pv.name, macros));
    }
  }
  return out.map((name) => name.trim()).filter((name) => name !== '');
}

/**
 * An embed's file as the renderer resolves it: the (already substituted)
 * `file` prop, substituted again with the declaring instance's macros;
 * `undefined` when the prop is missing, empty or not a string. The one
 * substitution ScreenRenderer and `expandScreen` share.
 */
export function embedFile(
  substitutedProps: Readonly<Record<string, unknown>>,
  macros: MacroValues
): string | undefined {
  const file = substitutedProps.file;
  return typeof file === 'string' && file !== '' ? substituteMacros(file, macros) : undefined;
}

/** An embed node's (substituted) `macros` prop, when it is an object. */
export function embedNodeMacros(
  substitutedProps: Readonly<Record<string, unknown>>
): Record<string, string> | undefined {
  const macros = substitutedProps.macros;
  return macros && typeof macros === 'object' && !Array.isArray(macros)
    ? (macros as Record<string, string>)
    : undefined;
}

/**
 * Whether a node is base-hidden: its macro-substituted base props carry
 * `visible: false` (the boolean; substitution only rewrites strings, so the
 * string `'false'` is not hidden). The renderer mounts nothing for such a
 * node. A rule that hides a node at run time does not make it base-hidden.
 */
export function isBaseHidden(substitutedProps: Readonly<Record<string, unknown>>): boolean {
  return substitutedProps.visible === false;
}

/**
 * Visit the nodes the renderer mounts in one document, in document order,
 * with their substituted base props. A base-hidden node (`isBaseHidden`) is
 * not visited and not descended into; `hidden`, when given, is called with it
 * instead (never with a node under it).
 */
export function walkMounted(
  root: WidgetNode,
  macros: MacroValues,
  visit: (node: WidgetNode, props: Record<string, PropertyValue>) => void,
  hidden?: (node: WidgetNode, props: Record<string, PropertyValue>) => void
): void {
  const walk = (node: WidgetNode, chain: readonly string[]): void => {
    if (chain.includes(node.id)) return; // aliased node, as the renderer guards
    const props = substituteProps(node.props, macros);
    if (isBaseHidden(props)) {
      hidden?.(node, props);
      return;
    }
    visit(node, props);
    if (!mountsChildren(node.type)) return;
    for (const child of node.children ?? []) walk(child, [...chain, node.id]);
  };
  walk(root, []);
}

/**
 * The embeds of one screen instance to expand, in document order: every
 * mounted `embedded-display` whose base (un-rule-patched) `file` is a
 * non-empty string. The index is taken before any load, cycle or depth
 * check, so an embed that fails keeps its siblings' keys. A base-hidden embed
 * with such a `file` reserves its index too but yields no slot (it is not
 * expanded); an embed under a base-hidden node takes no index.
 */
export function embedOrder(doc: ScreenJSON, macros: MacroValues): EmbedSlot[] {
  const slots: EmbedSlot[] = [];
  let next = 0;
  const fileOf = (node: WidgetNode, props: Record<string, PropertyValue>): string | undefined =>
    node.type === EMBED_TYPE ? embedFile(props, macros) : undefined;
  walkMounted(
    doc.root,
    macros,
    (node, props) => {
      const file = fileOf(node, props);
      if (file === undefined) return;
      slots.push({ node, index: next, file, nodeMacros: embedNodeMacros(props) });
      next += 1;
    },
    (node, props) => {
      if (fileOf(node, props) !== undefined) next += 1;
    }
  );
  return slots;
}

/** The instance key of the screen an embed loads, under its parent instance's key. */
export function embedInstanceKey(parentKey: string, index: number, nodeId: string): string {
  return `${parentKey}/${index}:${nodeId}`;
}

function macroSummary(macros: Readonly<Record<string, string>> | undefined): string {
  return Object.entries(macros ?? {})
    .map(([name, value]) => `${name}=${value}`)
    .join(', ');
}

/** One screen instance's PV list, deduplicated against `seen`. */
class GroupBuilder {
  readonly pvs: ScreenPV[] = [];
  private readonly formulasUsed = new Set<string>();
  private readonly seen: Set<string>;
  private readonly formulas: readonly FormulaDeclaration[] | undefined;
  private readonly macros: MacroValues;

  constructor(
    seen: Set<string>,
    formulas: readonly FormulaDeclaration[] | undefined,
    macros: MacroValues
  ) {
    this.seen = seen;
    this.formulas = formulas;
    this.macros = macros;
  }

  add(raw: string, role: ScreenPVRole): void {
    const name = raw.trim();
    if (name === '' || isLocalChannel(name) || hasMacro(name)) return;
    if (isFormulaRef(name)) {
      this.useFormula(formulaName(name));
      return;
    }
    if (this.seen.has(name)) return;
    this.seen.add(name);
    this.pvs.push({ name, role });
  }

  /** The inputs of the named formula (and of formulas it references). */
  useFormula(name: string): void {
    if (this.formulasUsed.has(name)) return;
    this.formulasUsed.add(name);
    const formula = this.formulas?.find((f) => f.name === name);
    for (const binding of Object.values(formula?.bindings ?? {})) {
      this.add(substituteMacros(binding, this.macros), 'formula');
    }
  }

  /** The PVs of `ruleChannels`, with a formula's inputs expanded through `formula://` names. */
  rules(rules: readonly Rule[] | undefined): void {
    for (const rule of rules ?? []) {
      if ('formula' in rule) {
        this.useFormula(rule.formula);
      } else {
        for (const pv of rule.pvs) this.add(substituteMacros(pv.name, this.macros), 'rule');
      }
    }
  }
}

interface Instance {
  screen: ScreenJSON;
  macros: MacroValues;
  depth: number;
  key: string;
  detail: string;
  /** Resolved ref of this document (`screenPath`, or `''`, for the top). */
  screenRef: string;
  /** Authored refs of the embedded screens down to this one. */
  chain: readonly string[];
  /** Resolved paths of every screen on the path (cycle guard). */
  ancestors: readonly string[];
}

/**
 * Every node the renderer mounts for `screen` with `options`, per screen
 * instance, and the PV groups `collectScreenPVs` returns (see the module
 * comment).
 */
export async function expandScreen(
  screen: ScreenJSON,
  options: ExpandScreenOptions = {}
): Promise<ExpandedScreen> {
  const { resolveScreen, maxDepth = 8, screenPath } = options;
  const seen = new Set<string>();
  const groups: ScreenPVGroup[] = [];
  const nodes: ExpandedNode[] = [];

  async function visit(instance: Instance): Promise<void> {
    const { screen: doc, macros } = instance;
    const group = new GroupBuilder(seen, doc.formulas, macros);

    walkMounted(doc.root, macros, (node, props) => {
      nodes.push({
        instance: instance.key,
        nodeId: node.id,
        type: node.type,
        props,
        screenRef: instance.screenRef,
        ruleChannels: ruleChannels(node.rules, doc.formulas, macros),
      });
      const role = ROLE_BY_TYPE[node.type] ?? 'other';
      for (const name of nodeChannels(node.type, props)) group.add(name, role);
      group.rules(node.rules);
    });

    groups.push({
      key: instance.key,
      title: doc.metadata.title,
      detail: instance.detail,
      depth: instance.depth,
      pvs: group.pvs,
    });

    // Load this instance's embeds together, then visit them in document
    // order so groups and first occurrences follow the screen.
    if (!resolveScreen || instance.depth + 1 > maxDepth) return;
    const children = await Promise.all(
      embedOrder(doc, macros).map(async (slot): Promise<Instance | null> => {
        const ref = resolveAgainstChain(screenPath, instance.chain, slot.file);
        if (instance.ancestors.includes(ref)) return null;
        let child: ScreenJSON;
        try {
          child = await resolveScreen(ref);
        } catch {
          return null;
        }
        if (!isSupportedSchemaVersion(child.schemaVersion)) return null;
        return {
          screen: child,
          macros: resolveScreenMacros(child, childMacros(macros, slot.nodeMacros)),
          depth: instance.depth + 1,
          key: embedInstanceKey(instance.key, slot.index, slot.node.id),
          detail: macroSummary(slot.nodeMacros),
          screenRef: ref,
          chain: [...instance.chain, slot.file],
          ancestors: [...instance.ancestors, ref],
        };
      })
    );
    for (const child of children) {
      if (child !== null) await visit(child);
    }
  }

  await visit({
    screen,
    macros: resolveScreenMacros(screen, options.macros),
    depth: 0,
    key: '',
    detail: '',
    screenRef: screenPath ?? '',
    chain: [],
    ancestors: screenPath ? [resolveAgainstChain(undefined, [], screenPath)] : [],
  });
  return { nodes, groups };
}

/**
 * The PVs of `screen` as rendered with `options`, grouped per screen
 * instance (see the module comment).
 */
export async function collectScreenPVs(
  screen: ScreenJSON,
  options: CollectScreenPVsOptions = {}
): Promise<ScreenPVGroup[]> {
  return (await expandScreen(screen, options)).groups;
}
