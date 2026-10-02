// activeSymbolClass and anaSymbolClass (aniSymbolClass). Behaviour matches
// EDM's edmlib/symbol.cc and edmlib/asymbol.cc; written from that behaviour,
// no EDM code is copied.
//
//   - the symbol file's top-level groups are the states (symbolStates.ts);
//     every state's objects are live (their PVs connect), one is drawn;
//   - the value: with one control PV and no masks its value; otherwise each
//     PV's integer value masked (andMask, xorMask) and shifted (shiftCount),
//     OR-ed together; truthTable makes bit k "PV k is non-zero";
//   - the state is the first whose [minValues, maxValues) holds the value,
//     else state 0; state 0 too until every control PV (and colorPv) is
//     connected; with no control PV, state 1 for good;
//   - without useOriginalColors the members take fgColor / bgColor;
//   - anaSymbol moves the whole symbol by xPv, yPv along axisAnglePv;
//   - a 1-px outline in the disconnected colour after 2 s without a value.

import { useEffect, useState } from 'react';
import { parseColorSpec } from '../config/colors.js';
import { expandMacros } from '../macros.js';
import type { EdmObject } from '../model.js';
import { parseCInt, propBool, propIndexedStrings, propInt, propStr } from '../model.js';
import type { EdmPvData } from '../pv/types.js';
import { EdmScoped } from '../screen/EdmScreen.js';
import { useEdmPv, useEdmScreen } from '../screen/context.js';
import { useEdmDoc } from '../screen/docs.js';
import type { EdmWidgetProps } from './registry.js';
import { Unconnected } from './Rectangle.js';
import { geom, pvProp } from './shared.js';
import { symbolStates } from './symbolStates.js';
import type { SymbolOrientation } from './symbolStates.js';

/** Members' own colour tags that a symbol's fgColor / bgColor replace. */
const OVERRIDE: Record<string, [fg: string[], bg: string[]]> = {
  activeRectangleClass: [['lineColor'], ['fillColor']],
  activeCircleClass: [['lineColor'], ['fillColor']],
  activeArcClass: [['lineColor'], ['fillColor']],
  activeLineClass: [['lineColor'], ['fillColor']],
  activeBarClass: [['fgColor', 'indicatorColor'], ['bgColor']],
  activeMeterClass: [['fgColor', 'labelColor', 'scaleColor'], ['caseColor']],
  activeButtonClass: [['fgColor'], ['onColor', 'offColor']],
  activeMessageButtonClass: [['fgColor'], ['onColor', 'offColor']],
};

function recolour(o: EdmObject, fg: string | undefined, bg: string | undefined): EdmObject {
  const [fgs, bgs] = OVERRIDE[o.className] ?? [['fgColor'], ['bgColor']];
  const set: Record<string, string> = {};
  if (fg) for (const k of fgs) if (o.props[k] !== undefined) set[k] = fg;
  if (bg) for (const k of bgs) if (o.props[k] !== undefined) set[k] = bg;
  return {
    ...o,
    props: { ...o.props, ...set },
    ...(o.children ? { children: o.children.map((c) => recolour(c, fg, bg)) } : {}),
  };
}

/** The value EDM selects a state with. */
export function symbolValue(
  data: readonly (EdmPvData | undefined)[],
  truthTable: boolean,
  andMask: readonly number[],
  xorMask: readonly number[],
  shift: readonly number[]
): number {
  if (truthTable) {
    return data.reduce((v, d, k) => (d?.connected && d.num !== 0 ? v | (1 << k) : v), 0);
  }
  if (data.length === 1 && !andMask[0] && !xorMask[0] && !shift[0]) return data[0]?.num ?? 0;
  let v = 0;
  data.forEach((d, k) => {
    let u = Math.trunc(d?.num ?? 0) >>> 0;
    if (andMask[k]) u = (u & andMask[k]) >>> 0;
    u = (u ^ (xorMask[k] ?? 0)) >>> 0;
    const s = shift[k] ?? 0;
    u = s >= 0 ? (u << s) >>> 0 : u >>> -s;
    v = (v | u) >>> 0;
  });
  return v;
}

function makeSymbol(cls: string, maxPvs: number) {
  return function SymbolWidget({ obj }: EdmWidgetProps) {
    const env = useEdmScreen();
    const { palette } = env;
    const p = obj.props;
    const g = geom(p);
    const numPvs = Math.min(maxPvs, Math.max(0, propInt(p, 'numPvs', 0)));
    const names = propIndexedStrings(p, 'controlPvs');
    const controls = Array.from({ length: numPvs }, (_, k) => (names[k] ?? '').trim());
    const haveControls = numPvs >= 1 && controls.every((c) => c && !c.startsWith('#'));
    // Hooks in a fixed number: up to eight control PVs.
    const data: (EdmPvData | undefined)[] = [];
    for (let k = 0; k < 8; k++) {
      // eslint-disable-next-line react-hooks/rules-of-hooks
      data.push(useEdmPv(haveControls ? controls[k] : undefined, `${cls}.controlPvs`));
    }
    const colorPv = pvProp(p, 'colorPv');
    const cpv = useEdmPv(colorPv, `${cls}.colorPv`);
    const xd = useEdmPv(cls === 'anaSymbolClass' ? pvProp(p, 'xPv') : undefined, `${cls}.xPv`);
    const yd = useEdmPv(cls === 'anaSymbolClass' ? pvProp(p, 'yPv') : undefined, `${cls}.yPv`);
    const ad = useEdmPv(
      cls === 'anaSymbolClass' ? pvProp(p, 'axisAnglePv') : undefined,
      `${cls}.axisAnglePv`
    );
    const [late, setLate] = useState(false);
    useEffect(() => {
      const t = setTimeout(() => setLate(true), 2000);
      return () => clearTimeout(t);
    }, []);

    // The file name expands with the window's own macros only.
    const file = expandMacros(propStr(p, 'file') ?? '', env.windowMacros ?? env.macros).trim();
    const doc = useEdmDoc(file || undefined);
    const ready = doc.status === 'ready';
    const orientation = (propStr(p, 'orientation') ?? 'original') as SymbolOrientation;
    const states = symbolStates(
      ready ? doc.doc : null,
      g,
      propInt(p, 'numStates', 0),
      propBool(p, 'useOriginalSize'),
      orientation
    );
    if (doc.status === 'loading') return <div data-testid="embed-loading" hidden />;

    const ctl = data.slice(0, numPvs);
    const active = haveControls && ctl.every((d) => d?.connected) && (!colorPv || !!cpv?.connected);
    const anyValue = !haveControls || ctl.some((d) => d !== undefined);
    const num = (k: string) =>
      propIndexedStrings(p, k).map((s) => (s === undefined ? 0 : (parseCInt(s) ?? 0)) >>> 0);
    const nums = (k: string) => propIndexedStrings(p, k).map((s) => Number(s ?? 0) || 0);
    let state: number;
    const n = states.states.length;
    if (!haveControls) state = 1;
    else if (!active) state = 0;
    else {
      const v = symbolValue(
        ctl,
        propBool(p, 'truthTable'),
        num('andMask'),
        num('xorMask'),
        propIndexedStrings(p, 'shiftCount').map((s) => parseCInt(s ?? '0') ?? 0)
      );
      const mins = nums('minValues');
      const maxs = nums('maxValues');
      state = 0;
      for (let i = 0; i < n; i++) {
        if ((mins[i] ?? 0) <= v && v < (maxs[i] ?? 0)) {
          state = i;
          break;
        }
      }
    }
    const outline =
      late && haveControls && !ctl.some((d) => d?.connected) ? (
        <Unconnected x={g.x} y={g.y} w={states.w} h={states.h} color={palette.disconnected()} />
      ) : null;
    let members = states.states;
    if (!propBool(p, 'useOriginalColors')) {
      const spec = (k: string) => {
        const v = propStr(p, k);
        return v && parseColorSpec(v) ? v : undefined;
      };
      const fg = spec('fgColor');
      const bg = spec('bgColor');
      members = members.map((s) => s.map((o) => recolour(o, fg, bg)));
    }
    // anaSymbol: moved by x/y along the axis angle.
    let dx = 0;
    let dy = 0;
    if (cls === 'anaSymbolClass' && (xd || yd || ad)) {
      const X = Math.trunc(xd?.num ?? 0);
      const Y = Math.trunc(yd?.num ?? 0);
      const a = ((ad?.num ?? 0) * Math.PI) / 180;
      dx = Math.trunc(X * Math.cos(a) + Y * Math.sin(a));
      dy = Math.trunc(Y * Math.cos(a) - X * Math.sin(a));
    }
    const scope = `${env.scope ? `${env.scope}>` : ''}symbol:${ready ? doc.path : file}`;
    return (
      <>
        {outline}
        <div
          data-edm-class={cls}
          style={{ position: 'absolute', left: dx, top: dy, width: 0, height: 0 }}
        >
          {members.map((objects, i) => (
            <div key={i} style={{ display: i === state && anyValue ? 'contents' : 'none' }}>
              <EdmScoped scope={scope} objects={objects} />
            </div>
          ))}
        </div>
      </>
    );
  };
}

export const ActiveSymbol = makeSymbol('activeSymbolClass', 5);
export const AnaSymbol = makeSymbol('anaSymbolClass', 8);
