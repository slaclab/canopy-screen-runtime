# Canopy Screens (viewer)

The operator-facing viewer for [canopy-screens](https://github.com/slaclab/canopy-screens)
content: browse the screen manifest, deep-link into a screen, and run it live.

## Routes

| Route              | Purpose                                                                |
| ------------------ | ---------------------------------------------------------------------- |
| `/`                | Browse/search the manifest (filter by title, category, or id)          |
| `/s/:category/:id` | Render one IR screen; every `?NAME=value` query param is a macro value |

`?render=edm|carbon` on a screen URL is reserved (not a macro): it selects the
render mode for that page, overriding `VITE_RENDER_MODE`. `edm` presents
alarms and text the way the legacy EDM display did — alarm-sensitive values
recoloured with EDM's alarm colours, EDM's disconnected outline, flush text —
on Carbon widget chrome; `carbon` shows severity pills and Carbon paddings.

Screens whose manifest `kind` is not `ir` (wrapper/code screens) get an
explicit "not yet viewable" card/page. Documents whose `schemaVersion` does
not match `@slaclab/canopy-screen-ir`'s `SCHEMA_VERSION` get an explicit
error page — never a blank screen. Each screen renders inside its own error
boundary, and each widget inside the screen has another one.

## Configuration (`.env.local`)

| Variable                | Default            | Meaning                                                                     |
| ----------------------- | ------------------ | --------------------------------------------------------------------------- |
| `VITE_SCREENS_BASE_URL` | `''` (same origin) | Base URL serving a canopy-screens checkout (`manifest.json` + `screens/**`) |
| `VITE_PV_MODE`          | `mock`             | `mock` = simulated PVs, rules inert · `hare` = live Canopy                  |
| `VITE_CANOPY_BASE_URL`  | —                  | Canopy API base (hare mode), e.g. `https://canopy.example.org`              |
| `VITE_CANOPY_API_KEY`   | —                  | API key (hare mode)                                                         |
| `VITE_RENDER_MODE`      | `edm`              | Default render mode: `edm` (legacy alarm/text presentation) · `carbon`      |

`src/services.ts` is the composition root: `mock` builds a `MockPVService`
(no Fox — rules stay at their base values), `hare` builds `HarePVService`
plus `FoxFormulaService` wrapped in the runtime's formula-subscriber adapter.

## Local dev against a canopy-screens checkout (smoke test)

```bash
# 1. serve the content repo (any static server with CORS works)
cd ../canopy-screens        # your checkout of slaclab/canopy-screens
npx serve --cors -l 8123 .

# 2. point the viewer at it
cd ../canopy-screen-runtime
echo "VITE_SCREENS_BASE_URL=http://localhost:8123" > apps/viewer/.env.local

# 3. run the viewer (from the workspace root)
pnpm --filter viewer dev
```

Then open the printed URL: the browse page lists `Vacuum System`, and the
deep link `/s/examples/vacuum-system?PREFIX=XX00:9` renders the screen with
mock data and the `PREFIX` macro overridden. (This flow is manual; the same
paths are covered by the vitest component tests in `src/App.test.tsx`.)
