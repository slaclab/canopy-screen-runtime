#!/usr/bin/env node
// Generator for the synthetic large screen that theme-flip.e2e.ts flips.
//
//   node e2e/fixtures/synthetic-large.mjs
//
// It writes, deterministically (a seeded PRNG, prettier-formatted output), so
// a re-run reproduces the committed files byte for byte:
//
//   drafts/synthetic-large/main.screen.json   the top screen: 428 nodes, of which
//                                           92 embed a sub-screen, 108 rules
//   drafts/synthetic-large/sub-*.screen.json  the embedded sub-screens
//   drafts/manifest.json                    upserts the `synthetic-large` entry
//   config.json                             upserts `colorScheme`, the test scheme
//
// The screen has the size and colour-role density of a large converted
// accelerator display, but nothing else from one: every name, PV and colour is
// invented here. The test scheme is a superset of canopy-default's roles plus
// the synthetic roles below, and every value differs from canopy-default's, so
// a screen that silently fell back to the bundled default is detectable.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DRAFTS = join(HERE, 'drafts');
const OUT = join(DRAFTS, 'synthetic-large');
const SEED = 0x6a7e1c05;

/** Top-screen shape: nodes (root included), embedded-display nodes, rules. */
export const NODES = 428;
export const EMBEDS = 92;
export const RULES = 108;

/**
 * Colour-role density of the reference display (a 428-widget converted
 * screen): 232 widget props that name a role, and 318 role-valued rule arms
 * spread over its 108 rules. Only the numbers are kept.
 */
export const LARGE_ROLE_DENSITY = { propRefsPerNode: 232 / 428, ruleArmRefsPerRule: 318 / 108 };

/** The canopy-default roles, in the bundled scheme's order. */
const DEFAULT_ROLES = [
  'Transparent',
  'OK',
  'MINOR',
  'MAJOR',
  'INVALID',
  'DISCONNECTED',
  'Text',
  'ActiveText',
  'Background',
  'Read_Background',
  'Write_Background',
  'Button_Background',
  'Grid',
  'Grid_Fill',
  'Display_Background',
  'On',
  'Off',
  'Header_Background',
  'Header_ForeGround',
  'Attention',
  'STOP',
];
/** canopy-default's values (light, then dark), which the test scheme must avoid. */
const DEFAULT_LIGHT = [
  '#ffffff00',
  '#24a148',
  '#f1c21b',
  '#da1e28',
  '#a56eff',
  '#6f6f6f',
  '#161616',
  '#0f62fe',
  '#ffffff',
  '#f4f4f4',
  '#edf5ff',
  '#e0e0e0',
  '#c6c6c6',
  '#c6c6c6',
  '#ffffff',
  '#24a148',
  '#0e6027',
  '#393939',
  '#ffffff',
  '#ff832b',
  '#da1e28',
];
const DEFAULT_DARK = [
  '#16161600',
  '#42be65',
  '#f1c21b',
  '#ff8389',
  '#be95ff',
  '#8d8d8d',
  '#f4f4f4',
  '#78a9ff',
  '#161616',
  '#262626',
  '#001d6c',
  '#6a6a6a',
  '#757575',
  '#2e2e2e',
  '#161616',
  '#42be65',
  '#044317',
  '#525252',
  '#f4f4f4',
  '#ff832b',
  '#ff8389',
];

/**
 * canopy-default roles added after the fixtures were first generated. Their
 * colours come from a PRNG of their own, so adding one leaves every other draw,
 * and with it every committed screen, unchanged.
 */
const LATE_ROLES = ['Grid_Fill'];
const LATE_SEED = 0x6a7e1c06;

/** Roles only the test scheme defines. SYN_Probe colours the timed node. */
export const SYNTHETIC_ROLES = ['SYN_Probe', 'SYN_Accent_A', 'SYN_Accent_B', 'SYN_Reset'];

/** Relative weights of the roles the screen uses (the reference display's mix). */
const ROLE_MIX = [
  ['Text', 187],
  ['On', 106],
  ['INVALID', 104],
  ['MAJOR', 98],
  ['Grid', 28],
  ['STOP', 10],
  ['Attention', 8],
  ['SYN_Accent_A', 6],
  ['SYN_Accent_B', 4],
  ['DISCONNECTED', 2],
  ['SYN_Reset', 1],
];

/** Sub-screen variants the 92 embeds cycle through. */
const SUB_SCREENS = ['sub-a', 'sub-b', 'sub-c', 'sub-d'];

// ── deterministic helpers ──────────────────────────────────────────────────

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(SEED);
const int = (n, r = rand) => Math.floor(r() * n);
const hex2 = (n) => n.toString(16).padStart(2, '0');
const colour = (r = rand) => `#${hex2(int(256, r))}${hex2(int(256, r))}${hex2(int(256, r))}`;
const pad = (n, w = 3) => String(n).padStart(w, '0');

const MIX_TOTAL = ROLE_MIX.reduce((s, [, w]) => s + w, 0);
function pickRole() {
  let r = int(MIX_TOTAL);
  for (const [name, w] of ROLE_MIX) {
    if (r < w) return name;
    r -= w;
  }
  return ROLE_MIX[0][0];
}

/** A role reference whose fallbacks never match the scheme's values. */
function role(name, scheme) {
  for (;;) {
    const fallback = colour();
    const fallbackDark = colour();
    const i = scheme.roles.indexOf(name);
    if (fallback !== scheme.light[i] && fallbackDark !== scheme.dark[i]) {
      return { $role: name, fallback, fallbackDark };
    }
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(`synthetic-large: ${message}`);
}

// ── the test scheme ────────────────────────────────────────────────────────

function buildScheme() {
  const roles = [...DEFAULT_ROLES, ...SYNTHETIC_ROLES];
  const light = [];
  const dark = [];
  const lateRand = mulberry32(LATE_SEED);
  roles.forEach((name, i) => {
    const r = LATE_ROLES.includes(name) ? lateRand : rand;
    for (;;) {
      let l = colour(r);
      let d = colour(r);
      // Transparent keeps a (non-ff) alpha, as canopy-default's does.
      if (i === 0) {
        l += '00';
        d += '00';
      }
      if (l !== d && l !== DEFAULT_LIGHT[i] && d !== DEFAULT_DARK[i]) {
        light.push(l);
        dark.push(d);
        return;
      }
    }
  });
  const body = JSON.stringify({ roles, light, dark });
  const hash = createHash('sha256').update(body).digest('hex');
  return {
    roles,
    light,
    dark,
    meta: {
      id: 'synthetic-e2e',
      sha256: hash,
      flatHash: hash,
      served: 'synthetic-e2e',
      errors: [],
    },
  };
}

// ── screens ────────────────────────────────────────────────────────────────

function screenDoc(id, title, width, height, children, macros = []) {
  return {
    schemaVersion: '1.1',
    kind: 'screen',
    id,
    metadata: {
      title,
      source: { type: 'hand-authored' },
      size: { width, height },
    },
    macros,
    root: {
      id: `${id}-root`,
      type: 'absolute-canvas',
      props: { width, height },
      geometry: { x: 0, y: 0, width, height },
      children,
    },
  };
}

function subScreen(name, scheme) {
  const children = [
    {
      id: `${name}-frame`,
      type: 'rectangle',
      props: { lineColor: role(pickRole(), scheme), lineWidth: 1, fill: false },
      geometry: { x: 0, y: 0, width: 150, height: 60 },
    },
    {
      id: `${name}-value`,
      type: 'pv-label',
      props: { pv: '${D}:VAL', foregroundColor: role(pickRole(), scheme) },
      geometry: { x: 4, y: 4, width: 100, height: 22 },
    },
    {
      id: `${name}-led`,
      type: 'pv-led',
      props: { pv: '${D}:STAT', onColor: role('On', scheme), offColor: role('Grid', scheme) },
      geometry: { x: 110, y: 4, width: 22, height: 22 },
    },
    {
      id: `${name}-tag`,
      type: 'text-label',
      props: { text: name.toUpperCase(), foregroundColor: role('Text', scheme), fontSize: 11 },
      geometry: { x: 4, y: 32, width: 140, height: 20 },
    },
  ];
  return screenDoc(name, `Synthetic ${name}`, 150, 60, children, [
    { name: 'D', default: 'SYN:D000' },
  ]);
}

/** A rule over one synthetic PV whose arms (default + conditions) are roles. */
function rule(n, target, arms, scheme) {
  const values = Array.from({ length: arms }, () => role(pickRole(), scheme));
  return {
    id: `r-${pad(n)}`,
    name: `synthetic rule ${n}`,
    targetProperty: target,
    default: values[0],
    pvs: [{ name: `SYN:R${pad(n)}:STAT`, trigger: true }],
    conditions: values.slice(1).map((value, k) => ({ expression: `{0} > ${arms - 2 - k}`, value })),
  };
}

function mainScreen(scheme) {
  const width = 1600;
  const height = 1000;
  const children = [];

  // The timed node: a synthetic role only the served scheme defines.
  children.push({
    id: 'flip-probe',
    type: 'text-label',
    props: { text: 'FLIP-PROBE', foregroundColor: role('SYN_Probe', scheme), fontSize: 14 },
    geometry: { x: 10, y: 10, width: 160, height: 24 },
  });

  // 92 embeds on a 6-wide grid down the right half.
  for (let i = 0; i < EMBEDS; i++) {
    children.push({
      id: `e-${pad(i)}`,
      type: 'embedded-display',
      props: {
        file: `${SUB_SCREENS[i % SUB_SCREENS.length]}.screen.json`,
        macros: { D: `SYN:D${pad(i)}` },
      },
      geometry: { x: 640 + (i % 6) * 156, y: 10 + Math.floor(i / 6) * 64, width: 150, height: 60 },
    });
  }

  // The remaining widgets: labels, values, LEDs and frames on the left half.
  const fillers = NODES - 1 - 1 - EMBEDS;
  const propRefs = Math.round(LARGE_ROLE_DENSITY.propRefsPerNode * NODES) - 1; // the probe is one
  const armRefs = Math.round(LARGE_ROLE_DENSITY.ruleArmRefsPerRule * RULES);
  // Every rule has 3 role arms, except enough with 2 to land on armRefs exactly.
  const twoArm = 3 * RULES - armRefs;
  assert(twoArm >= 0 && twoArm <= RULES, `cannot spread ${armRefs} arms over ${RULES} rules`);

  const kinds = ['text-label', 'pv-label', 'pv-led', 'rectangle'];
  let refsLeft = propRefs;
  let rulesMade = 0;
  for (let i = 0; i < fillers; i++) {
    const kind = kinds[i % kinds.length];
    // Spread the role props evenly; the last fillers take what is left.
    const coloured = refsLeft > 0 && (refsLeft >= fillers - i || int(fillers) < propRefs);
    const geometry = {
      x: 10 + (i % 10) * 62,
      y: 44 + Math.floor(i / 10) * 28,
      width: 58,
      height: 22,
    };
    const node = { id: `w-${pad(i)}`, type: kind, props: {}, geometry };
    let target;
    switch (kind) {
      case 'text-label':
        node.props = { text: `S${pad(i)}`, fontSize: 11 };
        if (coloured) node.props.foregroundColor = role(pickRole(), scheme);
        target = 'foregroundColor';
        break;
      case 'pv-label':
        node.props = { pv: `SYN:W${pad(i)}:VAL` };
        if (coloured) node.props.foregroundColor = role(pickRole(), scheme);
        target = 'backgroundColor';
        break;
      case 'pv-led':
        node.props = { pv: `SYN:W${pad(i)}:STAT`, offColor: '#525252' };
        if (coloured) node.props.onColor = role(pickRole(), scheme);
        target = 'offColor';
        break;
      default:
        node.props = { lineWidth: 1, fill: false };
        if (coloured) node.props.lineColor = role(pickRole(), scheme);
        target = 'lineColor';
    }
    if (coloured) refsLeft -= 1;
    // One rule on every third filler until all are placed.
    if (rulesMade < RULES && i % 3 === 0) {
      node.rules = [rule(rulesMade, target, rulesMade < twoArm ? 2 : 3, scheme)];
      rulesMade += 1;
    }
    children.push(node);
  }
  assert(refsLeft === 0, `${refsLeft} role props left unplaced`);
  assert(rulesMade === RULES, `placed ${rulesMade} rules, want ${RULES}`);

  const doc = screenDoc('synthetic-large', 'Synthetic large', width, height, children);
  const shape = count(doc.root);
  assert(shape.nodes === NODES, `${shape.nodes} nodes, want ${NODES}`);
  assert(shape.embeds === EMBEDS, `${shape.embeds} embeds, want ${EMBEDS}`);
  assert(shape.rules === RULES, `${shape.rules} rules, want ${RULES}`);
  return doc;
}

/** Nodes, embeds and rules of a node tree (the root included). */
export function count(node) {
  const out = {
    nodes: 1,
    embeds: node.type === 'embedded-display' ? 1 : 0,
    rules: node.rules?.length ?? 0,
  };
  for (const child of node.children ?? []) {
    const c = count(child);
    out.nodes += c.nodes;
    out.embeds += c.embeds;
    out.rules += c.rules;
  }
  return out;
}

// ── output ─────────────────────────────────────────────────────────────────

async function formatter() {
  const prettier = await import('prettier');
  const options = (await prettier.resolveConfig(join(HERE, 'config.json'))) ?? {};
  return (path, value) =>
    prettier.format(JSON.stringify(value, null, 2), { ...options, filepath: path, parser: 'json' });
}

async function main() {
  const format = await formatter();
  const write = async (path, value) => writeFileSync(path, await format(path, value));

  const scheme = buildScheme();

  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  for (const name of SUB_SCREENS) {
    await write(join(OUT, `${name}.screen.json`), subScreen(name, scheme));
  }
  await write(join(OUT, 'main.screen.json'), mainScreen(scheme));

  const manifestPath = join(DRAFTS, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const entry = {
    id: 'synthetic-large',
    kind: 'ir',
    title: 'Synthetic large',
    category: 'drafts',
    path: 'synthetic-large/main.screen.json',
    schemaVersion: '1.1',
  };
  const at = manifest.screens.findIndex((s) => s.id === entry.id);
  if (at >= 0) manifest.screens[at] = entry;
  else manifest.screens.push(entry);
  await write(manifestPath, manifest);

  const configPath = join(HERE, 'config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  config.colorScheme = scheme;
  await write(configPath, config);

  console.log(`wrote ${readdirSync(OUT).length} screens to ${OUT}, scheme ${scheme.meta.flatHash}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
