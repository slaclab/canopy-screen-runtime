# Canopy Screens (viewer)

The operator-facing viewer for [canopy-screens](https://github.com/slaclab/canopy-screens)
content: browse the screen manifest, deep-link into a screen, and run it live.

## Routes

| Route              | Purpose                                                                    |
| ------------------ | -------------------------------------------------------------------------- |
| `/`                | Redirects to `/embed/` (query kept)                                        |
| `/embed/...`       | The workspace: screen tree, tabs and docked tiles, alone or inside a host  |
| `/s/:category/:id` | Render one IR screen with its header; every `?NAME=value` param is a macro |

Screens whose manifest `kind` is not `ir` (wrapper/code screens) get an
explicit "not yet viewable" card/page. Documents whose `schemaVersion` does
not match `@slaclab/canopy-screen-ir`'s `SCHEMA_VERSION` get an explicit
error page — never a blank screen. Each screen renders inside its own error
boundary, and each widget inside the screen has another one.

`?render=edm|carbon` on a screen URL is reserved (not a macro): it selects the
render mode for that page, overriding `renderMode` in `config.json`. `edm`
presents alarms and text the way the legacy EDM display did — alarm-sensitive
values recoloured with EDM's alarm colours, EDM's disconnected outline, flush
text — on Carbon widget chrome; `carbon` shows severity pills and Carbon
paddings.

## Configuration (`config.json`)

The viewer reads its configuration at runtime from `config.json`, fetched
relative to the page (`document.baseURI`), so one build (`base: './'`) serves
under any mount path. Nothing is baked in at build time. In a deployment
`canopy_mcp` serves this file; there is no Canopy base URL and no API key in
it — the viewer talks to the origin that serves it.

| Key             | Default | Meaning                                                                                                  |
| --------------- | ------- | -------------------------------------------------------------------------------------------------------- |
| `pvMode`        | `hare`  | `mock` = simulated PVs, rules inert · `hare` = live Canopy. A missing or unknown value means `hare`      |
| `renderMode`    | `edm`   | `edm` (alarms and text as the legacy EDM display drew them) · `carbon` (severity pills, Carbon paddings) |
| `screensPath`   | `.`     | Where the canopy-screens content (`manifest.json` + `screens/**`) lives, relative to the app             |
| `themes`        | `{}`    | Theme id → `light` \| `dark`; other values are ignored                                                   |
| `trace`         | absent  | `{ "path", "query" }` of the Trace data browser page; absent disables the Trace tab                      |
| `correlation`   | absent  | `{ "path", "query" }` of the correlation plot page; absent disables its tabs                             |
| `waveform`      | absent  | `{ "path", "query" }` of the waveform plot page; absent disables its tabs                                |
| `views`         | absent  | `{ "path": "views" }` where the server keeps saved data browser views; absent hides them                 |
| `collections`   | absent  | `{ "path": "collections" }` where the server keeps collections; absent hides them                        |
| `colorScheme`   | bundled | Flattened color scheme (screen-ir `FlatScheme`); an invalid value falls back to the bundled default      |
| `backend`       | absent  | Hare mode: the data backend's identity `{ name, label, notice }`, or `null` when it was unreachable      |
| `binding`       | absent  | Hare mode: the data backend's binding id, or `null`. Seeds the backend badge with `backend`              |
| `confirmWrites` | `true`  | Hare mode: ask before each machine write; only a literal `false` turns it off; `asked` asks anyway       |
| `workspace`     | absent  | `{ "path", "protocol" }` of the server's shared workspace routes; absent makes no workspace request      |
| `home`          | absent  | `{ "screen" }`: the library screen an embedded workspace opens on its first visit                        |

The parse rules for each key are in the header of `src/config.ts`.

```json
{ "pvMode": "hare", "screensPath": "screens", "themes": { "vacuum-system": "dark" } }
```

When `config.json` is missing or does not parse (e.g. under `vite dev`, where
no `canopy_mcp` is running), the viewer falls back to
`{ "pvMode": "mock", "screensPath": ".", "themes": {} }`.

`src/services.ts` is the composition root: `mock` builds a `MockPVService`
(no Formula Engine — rules stay at their base values), `hare` builds
`HarePVService` plus the SDK's Formula Engine service wrapped in the runtime's
formula-subscriber adapter.

## Embedding

A host page frames the workspace at `/embed/` (same origin as the host). It
sets the theme two ways:

- `?theme=<id>` on the frame URL: the theme the frame loads with. It stays in
  force after in-frame navigation drops it from the URL.
- A message from the parent window, `{ "type": "canopy:theme", "theme": "<id>" }`,
  which wins over the URL. Messages from any other window or origin are
  ignored.

An id resolves to light or dark through `config.themes`, then through its own
name (`light` or `*-light` is light, anything else dark).

Browser storage (open tabs, dock layout, zoom, screen-tree state, sidebar
width) is keyed by the mount path, so two mounts on one origin never share a
record. A host that serves several users under one mount stamps a per-user
scope on the framed page's root element,
`<html data-canopy-storage-scope="<scope>">`, and every key gains `--<scope>`;
a scoped page never reads the unscoped keys.

## Local dev against a canopy-screens checkout (smoke test)

```bash
# 1. serve the content repo (any static server with CORS works)
cd ../canopy-screens        # your checkout of slaclab/canopy-screens
npx serve --cors -l 8123 .

# 2. point the viewer at it (mock PVs; served from apps/viewer/public/)
cd ../canopy-screen-runtime
mkdir -p apps/viewer/public
echo '{"pvMode": "mock", "screensPath": "http://localhost:8123"}' > apps/viewer/public/config.json

# 3. run the viewer (from the workspace root)
pnpm --filter viewer dev
```

Then open the printed URL: the workspace's screen tree lists `Vacuum System`, and the
deep link `/s/examples/vacuum-system?PREFIX=XX00:9` renders the screen with
mock data and the `PREFIX` macro overridden. (This flow is manual; the same
paths are covered by the vitest component tests in `src/App.test.tsx`.)
