// activeRampButtonClass and activeUpdownButtonClass. Behaviour matches EDM's
// baselib/rampButton.cc and baselib/updownButton.cc; both are drawn like the
// message button (face in bgColor, outline, EDM's 3-ring bevel, raised or,
// while active, sunken; a centred label of at most 39 characters):
//   - ramp button: a press starts ramping controlPv toward finalValuePv
//     (rampRate units per minute, one step every updateRate s, clamped to
//     0.1..10 s; each step from the monitored readback; clamped to the
//     display limits); a press while ramping stops it. rampStateValuePv is
//     written 1 / 0; the button stays sunken while ramping;
//   - up/down button: a line at y + 9 marks a 10-px menu strip; a press
//     below it steps controlPv by fineValue (button 3 up, button 1 down),
//     then every `rate` s by coarseValue while held (first after 500 ms); a
//     release in the strip opens the Save / Restore menu (savedValuePv); the
//     label gets " *" while the control equals the saved value;
//   - both: colorPv rules on bgColor and fgColor, visPv, the face turns the
//     disconnected colour when a PV drops; nothing is drawn until the PVs
//     connect (a 1-px outline after 2 s).
// Written from that behaviour; no EDM code is copied.

import { useEffect, useRef, useState } from 'react';
import { resolveFont } from '../config/fonts.js';
import { propBool, propNum, propStr } from '../model.js';
import type { EdmPvData } from '../pv/types.js';
import { useEdmPut, useEdmPv, useEdmScreen, useExpanded, usePhase } from '../screen/context.js';
import { CentredLabel, Hotspot, PopupMenu, XLines, raisedBevel } from './button.js';
import type { XLine } from './button.js';
import type { EdmWidgetProps } from './registry.js';
import { Unconnected } from './Rectangle.js';
import { SvgBox, XRectOutline, atof, colorSpec, geom, idiv, pvProp, useVis } from './shared.js';

/** The pressed look: the outer ring alone (bottom shadow top/left, top shadow bottom/right). */
function sunken(
  x: number,
  y: number,
  w: number,
  h: number,
  top: string | undefined,
  bot: string | undefined
): XLine[] {
  return raisedBevel(x, y, w, h, top, bot).slice(0, 4);
}

/** Display limits as EDM takes them: the PV's per field (limitsFromDb or a missing tag), else the tags. */
function limits(p: EdmWidgetProps['obj']['props'], d: EdmPvData | undefined): [number, number] {
  const fromDb = propBool(p, 'limitsFromDb');
  const tag = (k: string) => (propStr(p, k) === undefined ? null : propNum(p, k, 0));
  const lo =
    fromDb || tag('scaleMin') === null ? (d?.connected ? d.lowerLimit : 0) : tag('scaleMin')!;
  const hi =
    fromDb || tag('scaleMax') === null ? (d?.connected ? d.upperLimit : 10) : tag('scaleMax')!;
  return [lo, hi];
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** The shared look: face, outline, bevel, extra lines, label. */
function ButtonFace(props: {
  obj: EdmWidgetProps['obj'];
  pressed: boolean;
  label: string;
  colorValue: number | undefined;
  down: boolean;
  extra?: [number, number, number, number][];
}) {
  const { palette } = useEdmScreen();
  const p = props.obj.props;
  const { x, y, w, h } = geom(p);
  const face = props.down
    ? palette.disconnected()
    : palette.spec(colorSpec(p, 'bgColor'), props.colorValue);
  const fg = palette.spec(colorSpec(p, 'fgColor'), props.colorValue);
  const ts = palette.spec(colorSpec(p, 'topShadowColor'));
  const bs = palette.spec(colorSpec(p, 'botShadowColor'));
  const is3d = propBool(p, '3d');
  const font = resolveFont(propStr(p, 'font'));
  return (
    <SvgBox x={x} y={y} w={w + 1} h={h + 1} clip>
      <rect x={x} y={y} width={w} height={h} fill={face} />
      <XRectOutline x={x} y={y} w={w} h={h} lineWidth={1} color={is3d ? face : bs} />
      {is3d ? <XLines lines={(props.pressed ? sunken : raisedBevel)(x, y, w, h, ts, bs)} /> : null}
      {props.extra ? <XLines lines={props.extra.map(([a, b, c, d]) => [a, b, c, d, fg])} /> : null}
      <CentredLabel
        font={font}
        text={props.label}
        tX={x + idiv(w, 2)}
        tY={y + idiv(h, 2) - idiv(font.ascent, 2)}
        fill={fg}
        clip={[x, y, w, h]}
      />
    </SvgBox>
  );
}

const RAMP = 'activeRampButtonClass';

export function RampButton({ obj }: EdmWidgetProps) {
  const { palette } = useEdmScreen();
  const p = obj.props;
  const g = geom(p);
  const controlPv = pvProp(p, 'controlPv');
  const finalPv = pvProp(p, 'finalValuePv');
  const statePv = pvProp(p, 'rampStateValuePv');
  const colorPv = pvProp(p, 'colorPv');
  const ctl = useEdmPv(controlPv, `${RAMP}.controlPv`);
  const fin = useEdmPv(finalPv, `${RAMP}.finalValuePv`);
  const st = useEdmPv(statePv, `${RAMP}.rampStateValuePv`);
  const cpv = useEdmPv(colorPv, `${RAMP}.colorPv`);
  const { visible, data: vis, defined: hasVis } = useVis(p, RAMP);
  const label = (useExpanded(propStr(p, 'label') ?? '') ?? '').slice(0, 39);
  const put = useEdmPut();
  const defined = [
    ...(controlPv ? [ctl] : []),
    ...(finalPv ? [fin] : []),
    ...(statePv ? [st] : []),
    ...(colorPv ? [cpv] : []),
    ...(hasVis ? [vis] : []),
  ];
  const phase = usePhase(defined);
  const [ramping, setRamping] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef<{ ctl?: EdmPvData; fin?: EdmPvData }>({});
  useEffect(() => {
    latest.current = { ctl, fin };
  }, [ctl, fin]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );

  const writable = !!ctl?.connected && ctl.writable;
  const stop = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setRamping(false);
    put(statePv, 0);
  };
  const start = () => {
    const [lo, hi] = limits(p, ctl);
    const target = fin?.num ?? 0;
    const from = clamp(ctl?.num ?? 0, lo, hi);
    if (target === from) return;
    const up = target > from;
    const rate = clamp(propNum(p, 'updateRate', 0), 0.1, 10);
    const stepSize = Math.abs((propNum(p, 'rampRate', 0) / 60) * rate);
    const period = Math.max(100, Math.trunc(1000 * rate));
    setRamping(true);
    put(statePv, 1);
    let last = Date.now();
    const tick = () => {
      const now = Date.now();
      const adjust = clamp((now - last) / 1000 / rate, 0.9, 1.1);
      last = now;
      let v = (latest.current.ctl?.num ?? 0) + (up ? 1 : -1) * stepSize * adjust;
      let done = false;
      if (up ? v >= target : v <= target) {
        v = target;
        done = true;
      }
      if (v <= lo) {
        v = lo;
        done = true;
      } else if (v >= hi) {
        v = hi;
        done = true;
      }
      put(controlPv, v);
      if (done) stop();
      else timer.current = setTimeout(tick, period);
    };
    timer.current = setTimeout(tick, period);
  };

  const hotspot = (
    <Hotspot
      {...g}
      cls={RAMP}
      active={!!controlPv && !!finalPv && visible !== false}
      denied={!writable}
      onPress={(e) => {
        if ((e.button !== 0 && e.button !== 2) || !writable || visible !== true) return;
        if (phase !== 'init') return;
        if (ramping) stop();
        else start();
      }}
    />
  );
  if (phase !== 'init') {
    return (
      <>
        {phase === 'unconnected' ? <Unconnected {...g} color={palette.disconnected()} /> : null}
        {hotspot}
      </>
    );
  }
  const specs = ['bgColor', 'fgColor'].map((k) => colorSpec(p, k));
  const hidden = !hasVis && !!colorPv && specs.some((s) => palette.isInvisible(s, cpv?.num));
  if (propBool(p, 'invisible') || !visible || hidden) return hotspot;
  return (
    <>
      <ButtonFace
        obj={obj}
        pressed={ramping}
        label={label}
        colorValue={cpv?.num}
        down={defined.some((d) => d && !d.connected)}
      />
      {hotspot}
    </>
  );
}

const UPDOWN = 'activeUpdownButtonClass';

export function UpdownButton({ obj }: EdmWidgetProps) {
  const { palette } = useEdmScreen();
  const p = obj.props;
  const g = geom(p);
  const { x, y, w } = g;
  const controlPv = pvProp(p, 'controlPv');
  const savedPv = pvProp(p, 'savedValuePv');
  const colorPv = pvProp(p, 'colorPv');
  const ctl = useEdmPv(controlPv, `${UPDOWN}.controlPv`);
  const saved = useEdmPv(savedPv, `${UPDOWN}.savedValuePv`);
  const cpv = useEdmPv(colorPv, `${UPDOWN}.colorPv`);
  const { visible, data: vis, defined: hasVis } = useVis(p, UPDOWN);
  const label = (useExpanded(propStr(p, 'label') ?? '') ?? '').slice(0, 39);
  const coarse = atof(useExpanded(propStr(p, 'coarseValue') ?? '') ?? '');
  const fine = atof(useExpanded(propStr(p, 'fineValue') ?? '') ?? '');
  const put = useEdmPut();
  const defined = [
    ...(controlPv ? [ctl] : []),
    ...(colorPv ? [cpv] : []),
    ...(hasVis ? [vis] : []),
  ];
  const phase = usePhase(defined);
  const [pressed, setPressed] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const repeat = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef<EdmPvData | undefined>(undefined);
  useEffect(() => {
    latest.current = ctl;
  }, [ctl]);
  useEffect(
    () => () => {
      if (repeat.current) clearTimeout(repeat.current);
    },
    []
  );

  const writable = !!ctl?.connected && ctl.writable;
  const [lo, hi] = limits(p, ctl);
  const cancel = () => {
    if (repeat.current) clearTimeout(repeat.current);
    repeat.current = null;
  };
  const isSaved = !!saved?.connected && !!ctl?.connected && ctl.num === saved.num;

  const hotspot = (
    <>
      <Hotspot
        {...g}
        cls={UPDOWN}
        active={!!controlPv && visible !== false}
        denied={!writable}
        cursor="ns-resize"
        onPress={(e) => {
          if ((e.button !== 0 && e.button !== 2) || !writable || visible !== true) return;
          const top = e.currentTarget.getBoundingClientRect().top - 1;
          if (e.clientY - top < 10) return;
          const sign = e.button === 2 ? 1 : -1;
          setPressed(true);
          put(controlPv, clamp((ctl?.num ?? 0) + sign * fine, lo, hi));
          const period = Math.max(50, Math.trunc(1000 * propNum(p, 'rate', 0)));
          const again = () => {
            put(controlPv, clamp((latest.current?.num ?? 0) + sign * coarse, lo, hi));
            repeat.current = setTimeout(again, period);
          };
          repeat.current = setTimeout(again, 500);
        }}
        onRelease={(e) => {
          cancel();
          setPressed(false);
          if (!writable || visible !== true) return;
          const top = e.currentTarget.getBoundingClientRect().top - 1;
          if (e.clientY - top < 10) setMenu({ x: e.clientX, y: e.clientY });
        }}
      />
      {menu ? (
        <PopupMenu
          at={menu}
          onClose={() => setMenu(null)}
          items={[
            {
              label: 'Save',
              onSelect: () => {
                if (saved?.connected) put(savedPv, ctl?.num ?? 0);
              },
            },
            {
              label: 'Restore',
              onSelect: () => {
                if (saved?.connected) put(controlPv, clamp(saved.num, lo, hi));
              },
            },
          ]}
        />
      ) : null}
    </>
  );
  if (phase !== 'init') {
    return (
      <>
        {phase === 'unconnected' ? <Unconnected {...g} color={palette.disconnected()} /> : null}
        {hotspot}
      </>
    );
  }
  const specs = ['bgColor', 'fgColor'].map((k) => colorSpec(p, k));
  const hidden = !hasVis && !!colorPv && specs.some((s) => palette.isInvisible(s, cpv?.num));
  if (propBool(p, 'invisible') || !visible || hidden) return hotspot;
  return (
    <>
      <ButtonFace
        obj={obj}
        pressed={pressed}
        label={isSaved ? `${label} *` : label}
        colorValue={cpv?.num}
        down={defined.some((d) => d && !d.connected)}
        extra={[[x + 5, y + 9, x + w - 5, y + 9]]}
      />
      {hotspot}
    </>
  );
}
