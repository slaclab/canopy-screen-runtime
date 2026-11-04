# `@slaclab/canopy-screen-runtime`

Renders canonical Screen IR documents (`@slaclab/canopy-screen-ir`) as live
React screens.

```tsx
import { ScreenRenderer } from '@slaclab/canopy-screen-runtime';

<ScreenRenderer
  screen={screenJson}
  macros={{ PREFIX: 'DEMO:VAC1' }}
  resolveScreen={(ref) => fetch(base + ref).then((r) => r.json())}
/>;
```

What the renderer does:

- **Geometry** — absolute IR coordinates; children nest inside their parent
  with the parent origin subtracted; z-order is `children` array order.
- **Macros** — screen-declared defaults ⊕ caller values, substituted across
  ALL string props (`${NAME}` canonical, `$(NAME)` legacy); embedded screens
  get parent macros ⊕ the node's `macros` overrides (child defaults weakest).
  Unresolved macros stay visible verbatim.
- **Widgets** — instantiated through the `@slaclab/canopy-screen-widgets`
  registry via an IR→registry mapping; unknown/unregistered types become
  labeled placeholder boxes; every widget sits in its own error boundary.
- **Embedded screens** — resolved through the caller's `resolveScreen`, with
  a depth cap and a ref-chain cycle guard; schema-version-gated.
- **Rules** — compiled client-side to Fox `FormulaSpec`s at subscription time
  (`compileRule`): a condition/value ladder becomes ONE nested Python
  conditional expression (`v0 if (c0) else (v1 if (c1) else (default))`),
  `fox://` references are inlined (Fox rejects formula-of-formula bindings),
  macros in PV bindings resolve before subscribing. Outputs patch the target
  property reactively with precedence `base props < rule output`; `visible`
  composes by AND. The renderer stays service-agnostic: provide a
  `FormulaSubscriber` via `FormulaSubscriberContext` — the SDK's
  `FoxFormulaService` fits through `createFoxFormulaSubscriber`.
- **Formula channels** — a widget channel prop bound to `fox://<name>` (a
  converted EDM `CALC\` / PyDM `calc://` channel) reads the rendering
  screen's `formulas[]` entry, its bindings macro-resolved with that screen's
  effective macros (embedded screens use their own formulas and macros). Each
  screen wraps the PV context in a `ScreenPVService` that evaluates the
  formula through the same `FormulaSubscriber` as rules and feeds widgets
  value, severity and connected state; other addresses pass through to the
  enclosing PV service. Formula channels are read-only (writes are rejected);
  unknown names, non-scalar kinds and Fox errors show as disconnected with a
  console warning. Without Fox (mock mode) they stay disconnected, except
  formulas over `loc://` locals only, which evaluate in the page.

Live PV data is consumed by the widgets through `@slaclab/canopy-react`
context; the composition root chooses the concrete services.
