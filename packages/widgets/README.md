# `@slaclab/canopy-screen-widgets`

The Canopy screen widget set: Carbon-based live PV widgets, drawing
primitives, and the widget registry — extracted from
[canopy-screen-builder](https://github.com/slaclab/canopy-screen-builder)
(`src/widgets/**`) so the builder and the runtime render the same components.

Unification contract: `registerBuiltinWidgets()` registers the **live**
Carbon component (`CarbonPVTextDisplay`, `CarbonPVSlider`, ...) as the single
component for each PV widget type. `WidgetRendererProps` keeps the builder's
`isSelected` / `isEditing` props in the signature; they are tolerated no-ops
here. Live PV data comes from `usePV` (`@slaclab/canopy-react`) — wrap your
tree in `PVServiceProvider`.

```ts
import {
  registerBuiltinWidgets,
  widgetRegistry,
  WIDGET_CATALOG,
} from '@slaclab/canopy-screen-widgets';
import '@slaclab/canopy-screen-widgets/styles.css'; // once per app

registerBuiltinWidgets();
const def = widgetRegistry.get('PVTextDisplay');
```

`styles.css` also defines the `--pydm-alarm-*` / `--pydm-selection` color
tokens the alarm helpers reference; apps may override them. Carbon's own
styles must be loaded by the app. `LineWidget` is a render-only adaptation
(vertex editing stays in the builder).

The widget styles take their colours and fonts from the host theme contract
of `@slaclab/canopy-shell`, with no fallbacks in `styles.css`: a host loads
`@slaclab/canopy-shell/host-contract.css` (or defines the same names) before
`styles.css`. The names the widgets read are `--canopy-bg-field`,
`--canopy-border`, `--canopy-text-primary`, `--canopy-text-secondary`,
`--canopy-font-ui` and `--canopy-font-mono`. The few literal colours that
remain are prop defaults, each marked `canopy-allow-literal`.
