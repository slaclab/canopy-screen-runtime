// The live-data cue of one rendered node: which of its channels reach the
// machine, and whether what it shows is current.
//
// `machineBound` (the same definition the expand vectors record): the node has a non-`loc://` prop channel (`formula://` included) or a
// rule whose channels include a non-`loc://` name. Only a machine-bound node
// carries `data-pv-state`. `channels` is every prop channel the node
// subscribes, as subscribed (macros expanded, `loc://` and `formula://` as
// written); a node with any carries them as `data-pv`.

import type { FormulaDeclaration, MacroValues, WidgetNode } from '@slaclab/canopy-screen-ir';
import type { PropertyValue } from '@slaclab/canopy-screen-ir';
import { nodeChannels, ruleChannels } from './collectPVs.js';
import { linkChannels } from '../pv/usePVLinkState.js';
import type { PVLinkState } from '../pv/usePVLinkState.js';
import type { WidgetRulesState } from '../rules/useWidgetRules.js';

export interface NodeLinkChannels {
  /** Every prop channel of the node, unique, in prop order (`loc://` and `formula://` kept). */
  channels: string[];
  /** The node's own prop channels that reach the machine (`loc://` dropped). */
  propChannels: string[];
  /** Some rule of the node watches a non-`loc://` channel. */
  ruleBound: boolean;
  /** `propChannels` non-empty or `ruleBound`. */
  machineBound: boolean;
}

/** The machine channels of `node`, from its macro-substituted base props and its rules. */
export function nodeLinkChannels(
  node: Pick<WidgetNode, 'type' | 'rules'>,
  substitutedProps: Readonly<Record<string, PropertyValue>>,
  formulas: readonly FormulaDeclaration[] | undefined,
  macros: MacroValues
): NodeLinkChannels {
  const named = nodeChannels(node.type, substitutedProps);
  const channels = [...new Set(named)];
  const propChannels = linkChannels(named);
  const ruleBound = linkChannels(ruleChannels(node.rules, formulas, macros)).length > 0;
  return { channels, propChannels, ruleBound, machineBound: propChannels.length > 0 || ruleBound };
}

/**
 * The link state of a node's rules: `pending` until a live rule delivers a
 * result or an error, `disconnected` while stale or when no result has come
 * (a non-retryable error alone, rules that never compiled, no
 * FormulaSubscriber), `connected` on a current result.
 */
export function ruleLinkState(
  rules: Pick<WidgetRulesState, 'settled' | 'stale' | 'delivered'>
): PVLinkState {
  if (!rules.settled) return 'pending';
  if (rules.stale) return 'disconnected';
  return rules.delivered ? 'connected' : 'disconnected';
}

/**
 * One node's state from its prop channels' and its rules' states (null =
 * that side has no machine channel). Prop channels lead: a pending prop side
 * keeps the node pending, a pending rule side does not hold back a settled
 * prop side; sides that disagree read `partial`.
 */
export function combineLinkStates(
  prop: PVLinkState | null,
  rule: PVLinkState | null
): PVLinkState | null {
  if (prop === null) return rule;
  if (rule === null || prop === 'pending' || rule === 'pending') return prop;
  return prop === rule ? prop : 'partial';
}

/** Whether a state draws the cue (the inset dashed outline). */
export function drawsCue(state: PVLinkState | null | undefined): boolean {
  return state === 'partial' || state === 'disconnected';
}
