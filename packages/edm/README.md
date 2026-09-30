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
       ├── resolveFont    EDM font tag → web font + the X11 bitmap metrics EDM used
       └── EdmPvLayer     connection registry by PV scheme (EPICS\ → Hare, LOC\ → local)
```

- **Parser registry** (`registerFileParser(ext, fn)`): `.edl` is built in.
- **Widget registry** (`registerEdmWidget(className, Component)`): the kit registers
  itself with `registerEdmBuiltins()`. Class names include suffixes
  (`activeXTextDspClass:noedit`).
- **PV connections** (`new EdmPvLayer().register(scheme, connection)`): the viewer
  routes `epics` through `pvServiceConnection(HarePVService)` and `loc` through
  `localConnection()`. The layer records every subscription (`subscriptions()`, plus
  `stats()`), which the harness uses to check PV parity.

## Fidelity approach

- **Geometry is EDM's.** Positions, clipping and text placement follow EDM's drawing
  code: the baseline is `y + ascent + h/2 − boxH/2` for static text and
  `y + (ascent + h)/2` for Textupdate, alignment uses integer arithmetic, and X
  wide-line rules apply to outlines.
- **Glyph positions are EDM's.** `xFontMetrics.generated.ts` holds ascent, descent and
  per-glyph advances of the Adobe 75 dpi bitmap fonts that `fonts.list` names. It was
  dumped with `xlsfonts -lll` from the harness's EDM image (see
  `scripts/gen-font-metrics.mjs`). Every glyph sits at its X advance. Only the glyph
  shapes come from the web font: Arimo, Tinos or Cousine, the metric-compatible
  Liberation clones in `styles.css`.
- **Colours** convert 16-bit to 8-bit with X's high-byte rule, which was checked
  against EDM screenshots. Motif text-field bevels use Motif's shadow-colour
  calculation.
- **Number formatting** ports EPICS `cvtDoubleToString` and C `printf` semantics.

## Implemented classes (M0)

| Class                             | Notes                                                                                                                                                        |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| activeXTextClass                  | multi-line, alignment, autoSize, border, useDisplayBg, alarmPv rule/alarm colours, visPv                                                                     |
| activeXTextDspClass (+ `:noedit`) | EDM formats (float/gfloat/exponential/decimal/hex/string), PREC rules, showUnits, Motif text-field look, alarm border, colorPv; display only (writes are M1) |
| TextupdateClass                   | display modes, fill, alarm line, colorPv, `<pv>` when disconnected                                                                                           |
| relatedDisplayClass               | bevel, label, icon, `invisible` hotspots, opens targets in a new tab with symbols/propagateMacros                                                            |
| activeRectangleClass              | fill, wide/dashed outlines, alarm/rule colours, invisible                                                                                                    |
| activeLineClass                   | polyline/polygon, fill, arrows, dash, alarm/rule colours                                                                                                     |
| activeGroupClass                  | members in order; group visPv                                                                                                                                |

Every other class renders a visible `data-testid="widget-placeholder"` box that names
it. `CALC\` channels are recorded but not evaluated yet (M1).

## Provenance and licences

- **EDM** (slaclab/edm) is GPL-2.0-or-later. Its sources were read to confirm
  behaviour (formulas, defaults, drawing order). This package re-implements that
  behaviour and copies no EDM code. Each widget's header names the EDM file its
  behaviour matches.
- **EPICS base** number conversion (`cvtFast.c`) is ported in `src/format.ts`, under the
  EPICS Open License.
- **JLab wedm** (MIT) served as a reference only. None of its code is included yet. Any
  file that later ports wedm logic must keep wedm's MIT notice.
- **Font metrics** are data from the X11 Adobe bitmap fonts: © 1984, 1987 Adobe Systems;
  © 1988, 1991 Digital Equipment Corporation. Their notice is in the generated file.
- **Web fonts** Arimo, Tinos and Cousine come from Fontsource, under the SIL OFL 1.1.
