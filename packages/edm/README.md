# @slaclab/canopy-edm

Renders legacy EDM (`.edl`) screens in the browser, faithfully: EDM's layout, fonts,
colours and alarm colouring, read straight from the `.edl` file at view time. No
conversion step. The viewer serves it at `/edl/<path>?MACRO=value`.

Plan and acceptance: `canopy-fidelity/docs/edl-direct-renderer-handoff.md`. The fidelity
harness (`canopy-fidelity/tools/edm_direct_eval.py`) diffs every render against real EDM.

## Structure

The layout follows Diamond's cs-web-lib, so the package could move upstream later:

```
.edl text ──parser registry──► EdmDocument (the "EDM object" description)
                                   │  className + tag/value pairs, verbatim; groups nest
                                   ▼
  <EdmScreen> ── widget registry ──► one component per EDM class, each in an error
       │                             boundary; unknown classes render a placeholder
       ├── EdmPalette     colors.list: statics, rule colours (84–114), alarm block
       ├── resolveFont    EDM font tag → the X11 bitmap font as a web font, plus its metrics
       └── EdmPvLayer     connection registry by PV scheme
                          (EPICS\ → Hare, LOC\ → local, CALC\ → expression engine)
```

- **Parser registry** (`registerFileParser(ext, fn)`): `.edl` is built in.
- **Widget registry** (`registerEdmWidget(className, Component)`): the kit registers
  itself with `registerEdmBuiltins()`. Class names include suffixes
  (`activeXTextDspClass:noedit`).
- **PV connections** (`new EdmPvLayer().register(scheme, connection)`): the viewer
  routes `epics` through `pvServiceConnection(HarePVService)`, `loc` through
  `localConnection()` and `calc` through `calcConnection(layer, calcs)`. The layer
  records every subscription (`subscriptions()`, plus `stats()`), which the harness
  uses to check PV parity. Writes go through `layer.put()` (Hare's REST PUT for EPICS
  channels).

## Fidelity approach

- **Geometry is EDM's.** Positions, clipping and text placement follow EDM's drawing
  code: the baseline is `y + ascent + h/2 − boxH/2` for static text and
  `y + (ascent + h)/2` for Textupdate, alignment uses integer arithmetic, and X
  wide-line rules apply to outlines.
- **Glyphs are EDM's.** `fonts/` holds the Adobe 75 dpi X11 bitmap fonts that
  `fonts.list` names, converted to WOFF2 with one square outline per lit pixel
  (`scripts/gen-bitmap-fonts.py`; 96 faces, about 360 KiB, loaded per screen on
  demand). At the font's pixel size and an integer device pixel ratio the text is
  the same pixels EDM draws. `xFontMetrics.generated.ts` holds ascent, descent and
  per-glyph advances of the same fonts (`scripts/gen-font-metrics.mjs`, from
  `xlsfonts -lll` in the harness's EDM image); every glyph sits at its X advance.
  Arimo, Tinos and Cousine (the metric-compatible Liberation clones) are the fallback
  when a bitmap face is missing or still loading.
- **X11 rasterisation rules** are followed for lines and bevels: a width-1
  `XDrawLine` leaves its far end pixel unpainted, `XDrawRectangle` covers
  (w+1) × (h+1), wide lines straddle their coordinate the way the X server does.
- **Connection behaviour is EDM's.** A PV-driven object draws nothing until its PVs
  connect; after 2 s it shows the outline in the disconnected colour; once it has
  been live, a dropped PV repaints it in the disconnected colour (`usePhase`).
- **Colours** convert 16-bit to 8-bit with X's high-byte rule, which was checked
  against EDM screenshots. Motif text-field bevels use Motif's shadow-colour
  calculation.
- **Number formatting** ports EPICS `cvtDoubleToString` and C `printf` semantics.

One thing is deliberately not reproduced: when a dynamic object updates, EDM repaints
the region 5 px around it with only the objects that intersect the object's own box,
which erases the edges of close neighbours (a missing bevel row, a clipped alarm
border) until the next full expose. The renderer draws every object whole.

## Implemented classes

M0 (the six most common classes and groups):

| Class                             | Notes                                                                                                                                         |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| activeXTextClass                  | multi-line, alignment, autoSize, border, useDisplayBg, alarmPv rule/alarm colours, visPv                                                      |
| activeXTextDspClass (+ `:noedit`) | EDM formats, PREC rules, showUnits, Motif text-field look, alarm border, colorPv, nullPv/nullColor; `editable` controls edit in place (below) |
| TextupdateClass                   | display modes, fill, alarm line, colorPv, `<pv>` when disconnected                                                                            |
| relatedDisplayClass               | bevel, label, icon, `invisible` hotspots; one target opens on press, several open a menu; pv/value writes; macro precedence; closeAction      |
| activeRectangleClass              | fill, wide/dashed outlines, alarm/rule colours, invisible                                                                                     |
| activeLineClass                   | polyline/polygon, fill, arrows, dash, alarm/rule colours                                                                                      |
| activeGroupClass                  | members in order; group visPv                                                                                                                 |

M1 (the next twelve classes by corpus use, plus writes and pseudo-PVs):

| Class                    | Notes                                                                                                           |
| ------------------------ | --------------------------------------------------------------------------------------------------------------- |
| activeExitButtonClass    | flat or `3d`; closes the display (the viewer closes the tab, or goes back)                                      |
| shellCmdClass            | drawn exactly, inert: a browser cannot run commands; the tooltip lists them                                     |
| activeMessageButtonClass | push/toggle, press/release values converted by PV type, password, flat mode                                     |
| activeButtonClass        | state from controlPv/indicatorPv (enum or bit), on/off/inconsistent colours, pvState labels, toggle/push writes |
| activeMenuButtonClass    | state label, option bump, popup on release, writes the index                                                    |
| activeChoiceButtonClass  | one button per state, EDM's gap layout, a press writes the index                                                |
| activeCircleClass        | fill and outline, alarm/rule colours, visPv                                                                     |
| activeArcClass           | start/total angle, chord or pie fill                                                                            |
| ByteClass                | bit cells with EDM's float32 boundaries, endianness, shift, alarm colour                                        |
| activeBarClass           | origin, limits from the PV, label, scale with ticks, border, alarm colours                                      |
| activeMotifSliderClass   | label/limits/value rows, Motif scale look, drag and increment writes                                            |
| TextentryClass           | Textupdate look with in-place editing                                                                           |

Every other class renders a visible `data-testid="widget-placeholder"` box that names
it.

### Pseudo-PVs

- **`LOC\`** (`src/pv/local.ts`): EDM's initialiser grammar (`=d:1.5`, `=i:3`,
  `=s:text`, `=e:1,a,b`), shared per page by name, first initialiser wins.
- **`CALC\`** (`src/pv/calc.ts`, `src/pv/calcExpr.ts`): inline `CALC\{expr}(args)` and
  named entries of `calc.list`. The engine follows the calc code EDM actually links,
  its private 3.14-era copy of EPICS postfix/calcPerform (arguments A..L, two-argument
  MIN/MAX, `%` as fmod), not the current EPICS base grammar. Severity is the highest
  among the arguments; an INVALID argument holds the previous value.

### Writes and interaction

Buttons, menus, choice buttons, sliders and editable text write through
`EdmPvLayer.put()`. Text Control and Textentry edit in place: click, type, Enter to
write, Escape to cancel, with EDM's validation by PV type and display limits. EDM's
own entry dialogs (keypad, calendar, file selector) are not reproduced. A control
whose PV is not writable shows the not-allowed cursor.

## Provenance and licences

- **EDM** (slaclab/edm) is GPL-2.0-or-later. Its sources were read to confirm
  behaviour (formulas, defaults, drawing order). This package re-implements that
  behaviour and copies no EDM code. Each widget's header names the EDM file its
  behaviour matches.
- **EPICS base** code is ported under the EPICS Open License: number conversion
  (`cvtFast.c`) in `src/format.ts`, and the calc expression compiler and evaluator
  (`postfix.c`, `calcPerform.c`) in `src/pv/calcExpr.ts`, adjusted to the semantics of
  the older copy EDM carries.
- **JLab wedm** (MIT) served as a reference only. None of its code is included yet. Any
  file that later ports wedm logic must keep wedm's MIT notice.
- **Bitmap fonts and metrics** come from the X11 Adobe 75 dpi fonts: © 1984–1989, 1994
  Adobe Systems; © 1988, 1994 Digital Equipment Corporation. Their notice permits
  modification and redistribution; it ships as `fonts/COPYING` and in the generated
  files.
- **Fallback web fonts** Arimo, Tinos and Cousine come from Fontsource, under the SIL
  OFL 1.1.
