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
- **Rules** — compiled client-side to Formula Engine `FormulaSpec`s at
  subscription time (`compileRule`): a condition/value ladder becomes ONE
  nested Python conditional expression
  (`v0 if (c0) else (v1 if (c1) else (default))`), `formula://` references are
  inlined (the Formula Engine rejects formula-of-formula bindings), macros in
  PV bindings resolve before subscribing. Outputs patch the target property
  reactively with precedence `base props < rule output`; `visible` composes by
  AND. The renderer stays service-agnostic: provide a `FormulaSubscriber` via
  `FormulaSubscriberContext` — the SDK's Formula Engine service fits through
  `createFormulaEngineSubscriber`.

Live PV data is consumed by the widgets through `@slaclab/canopy-react`
context; the composition root chooses the concrete services.
