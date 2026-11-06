// The expand() test vectors: `expandScreen` run over the cases in
// `__fixtures__/expand-cases.json`, serialised as `expand-vectors.json`.
//
// This harness is test-only and is not part of the published package.
// Regenerate the vector file (run in packages/runtime):
//   pnpm exec vitest run -u src/render/expandVectors.test.ts
//
// The vector file is the shared definition of the walk for the other
// implementations: slaclab/canopy-sdk-js keeps a byte copy at
// `packages/screen-ir/test-vectors/expand.json`, and slaclab/canopy tests
// `src/canopy_mcp/screens.py` against its copy at
// `tests/canopy_mcp/fixtures/expand-vectors.json`. Every consumer runs a case
// with the same harness:
//
// - A case's documents are keyed by draft id (`demo/Overview`); a document's
//   file is `screens/<key>.screen.json`.
// - `screenPath` a key: the top is on the cycle path; `expandScreen` gets
//   `screenPath = 'screens/<key>.screen.json'` and hands the resolver
//   root-relative refs. `screenPath` null (the viewer's mode): no
//   `screenPath`; the resolver gets refs relative to the top document's
//   directory and joins them to `dirname('screens/<top>.screen.json')` first.
// - The harness never interprets a leading `/` itself (the runtime strips
//   it). A path that climbs above the root, does not start with `screens/`,
//   names no document, holds text that is not JSON (`docsRaw`) or declares an
//   unsupported `schemaVersion` is an unloadable embed.
// - A resolved path maps back to a key by stripping `screens/` and
//   `.screen.json`; a node's `screen` is the key of its declaring document.
// - `machineBound`: the node has a non-`loc://` prop channel (`formula://`
//   included) or a non-`loc://` rule channel.
// - `pvs`: every PV `collectScreenPVs` lists, sorted, once each.
//
// Keys, embeds and PVs follow base props: a rule that retargets an embed's
// `file` renders another screen under the same key, but the vectors (like
// `collectScreenPVs`) list the base file's.

import type { PropertyValue, ScreenJSON } from '@slaclab/canopy-screen-ir';
import { isLocalChannel } from '../src/channels.js';
import { expandScreen, mappedTypes, nodeChannels } from '../src/render/collectPVs.js';
import { resolveAgainstChain } from '../src/render/resolveRef.js';

/** One case of `expand-cases.json`. */
export interface ExpandCase {
  name: string;
  /** The top's key when the top is on the cycle path; null for the viewer's mode. */
  screenPath: string | null;
  /** Documents by key. */
  docs: Record<string, unknown>;
  /** Raw document texts by key (not JSON: an unloadable embed). */
  docsRaw: Record<string, string>;
  /** Keys of `docs` that fail the sdk's `validate()` (e.g. an unsupported schemaVersion). */
  invalidDocs: string[];
  /** The top document's key. */
  top: string;
  /** Caller macros. */
  macros: Record<string, string>;
}

export interface ExpandVectorNode {
  screen: string;
  instance: string;
  nodeId: string;
  type: string;
  props: Record<string, PropertyValue>;
  ruleChannels: string[];
  machineBound: boolean;
}

export interface ExpandVectorCase extends ExpandCase {
  expect: { nodes: ExpandVectorNode[]; pvs: string[] };
}

const ROOT = 'screens/';
const SUFFIX = '.screen.json';

function fileOf(key: string): string {
  return `${ROOT}${key}${SUFFIX}`;
}

/** The key of a resolved root-relative path, or undefined outside `screens/`. */
function keyOf(path: string): string | undefined {
  if (!path.startsWith(ROOT) || !path.endsWith(SUFFIX)) return undefined;
  return path.slice(ROOT.length, path.length - SUFFIX.length);
}

/** Run one case with the harness rules of the module comment. */
async function runCase(c: ExpandCase): Promise<ExpandVectorCase['expect']> {
  const topFile = fileOf(c.top);
  // Root-relative path of a ref as `expandScreen` hands it to the resolver.
  const pathOf = (ref: string): string =>
    c.screenPath === null ? resolveAgainstChain(topFile, [], ref) : ref;

  const resolveScreen = async (ref: string): Promise<ScreenJSON> => {
    const key = keyOf(pathOf(ref));
    if (key !== undefined && Object.hasOwn(c.docsRaw, key)) {
      return JSON.parse(c.docsRaw[key]!) as ScreenJSON;
    }
    if (key !== undefined && Object.hasOwn(c.docs, key)) return c.docs[key] as ScreenJSON;
    throw new Error(`unloadable: ${ref}`);
  };
  const top = c.docs[c.top] as ScreenJSON;
  const { nodes, groups } = await expandScreen(top, {
    macros: c.macros,
    resolveScreen,
    ...(c.screenPath === null ? {} : { screenPath: fileOf(c.screenPath) }),
  });

  return {
    nodes: nodes.map((node) => {
      const screen = node.instance === '' ? c.top : keyOf(pathOf(node.screenRef));
      if (screen === undefined) throw new Error(`no key for ${node.screenRef}`);
      const channels = [...nodeChannels(node.type, node.props), ...node.ruleChannels];
      return {
        screen,
        instance: node.instance,
        nodeId: node.nodeId,
        type: node.type,
        props: node.props,
        ruleChannels: node.ruleChannels,
        machineBound: channels.some((name) => !isLocalChannel(name)),
      };
    }),
    pvs: [...new Set(groups.flatMap((g) => g.pvs.map((pv) => pv.name)))].sort(),
  };
}

/**
 * The exact text of `expand-vectors.json`: the runtime's mapped types and
 * every case with its expected nodes and PVs (2-space JSON, one trailing
 * newline).
 */
export async function serializeExpandVectors(cases: readonly ExpandCase[]): Promise<string> {
  const out: ExpandVectorCase[] = [];
  for (const c of cases) {
    out.push({
      name: c.name,
      screenPath: c.screenPath,
      docs: c.docs,
      docsRaw: c.docsRaw,
      invalidDocs: c.invalidDocs,
      top: c.top,
      macros: c.macros,
      expect: await runCase(c),
    });
  }
  return `${JSON.stringify({ mappedTypes: mappedTypes(), cases: out }, null, 2)}\n`;
}
