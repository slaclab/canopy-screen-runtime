# Canopy Screens (viewer)

The operator-facing viewer for [canopy-screens](https://github.com/slaclab/canopy-screens)
content: browse the screen manifest, deep-link into a screen, and run it live.

## Routes

| Route              | Purpose                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------ |
| `/`                | Browse/search the manifest (filter by title, category, or id)                                    |
| `/s/:category/:id` | Render one screen, in the variant chosen below; every `?NAME=value` query param is a macro value |
| `/edl/<path>`      | Render a legacy EDM `.edl` screen directly (`@slaclab/canopy-edm`); query params are EDM macros  |

`?render=edm|carbon` on a screen URL is reserved (not a macro): it selects the
render mode for that page, overriding `VITE_RENDER_MODE`. `edm` presents
alarms and text the way the legacy EDM display did — alarm-sensitive values
recoloured with EDM's alarm colours, EDM's disconnected outline, flush text —
on Carbon widget chrome; `carbon` shows severity pills and Carbon paddings.

Variants whose manifest `kind` is not `ir` (wrapper/code screens) get an
explicit "not yet viewable" card/page. Documents whose `schemaVersion` does
not match `@slaclab/canopy-screen-ir`'s `SCHEMA_VERSION` get an explicit
error page — never a blank screen. Each screen renders inside its own error
boundary, and each widget inside the screen has another one.

`/edl/<path>` fetches `<path>` and `colors.list` from the display-file
endpoint (`VITE_EDM_BASE_URL`), which searches the display tree the way EDM's
`EDMDATAFILES` does. It renders the screen at its EDM size with EDM's look.
`render`, `impl` and `look` are reserved and are never macros. EPICS PVs go
through Hare, and `LOC\` locals are scoped to the window. Related displays
open in a new tab.

## Screen variants

One screen can exist in several implementations: the EDM `.edl` drawn as EDM
draws it, a Screen IR document, a PyDM `.ui`. The manifest lists one entry
per implementation; entries sharing `category` and `id` are variants of one
screen. Two optional entry fields name them, implied by `kind` when absent
(so a manifest without them reads as one variant per screen):

| Field  | Values                                                                |
| ------ | --------------------------------------------------------------------- |
| `impl` | `edm` (`kind: "edl"`), `pydm` (`kind: "ui"`), `react` (anything else) |
| `look` | free text, e.g. `faithful` for an `.edl` drawn as EDM draws it        |

An `edm` entry's `path` is the display's path under the display-file
endpoint (the `/edl/<path>` path), not a file in the content repo. In
canopy-screens such an entry comes from a `<name>.edl.json` descriptor, and
every entry carries `impl` and `look` (`null` when none):

```json
{
  "id": "misc/sdr_fb",
  "kind": "edl",
  "impl": "edm",
  "look": "faithful",
  "title": "sdr_fb",
  "category": "edm",
  "path": "misc/sdr_fb.edl"
}
```

`/s/<category>/<id>` opens, in order:

1. the variant the link names: `?impl=<impl>[&look=<look>]`;
2. this user's own choice for the screen, kept in this browser's
   `localStorage` (Canopy API keys identify a client, not a person);
3. the site policy, per screen and then site-wide (below);
4. the first viewable variant in manifest order.

Only a link can open a variant this viewer can't show (PyDM, code screens);
the page then says why. A screen with several variants gets a header switcher:
pick a variant (rewrites the link), **Always open this** (keep it as your
choice) or **Use site default** (forget it). `impl` and `look` are never
macros. The browse page shows one card per screen, listing its variants.

**Site policy.** Canopy's magpie config store holds it: the config named
`screen-variants` of app `canopy-viewer` (the newest, if several), or the
one whose slug is `VITE_SCREEN_POLICY_SLUG`. Its `data`:

```json
{
  "default": { "impl": "edm", "look": "faithful" },
  "screens": { "edm/bcs/BCS_HEE": { "impl": "react" } }
}
```

Create or change it with `POST/PUT {canopy}/magpie/v1/configs/canopy-viewer[/<slug>]`
and a write key. A policy that can't be read (Canopy down, no database, no
such config) is no policy: screens open on their first viewable variant. The viewer reads
the policy once per page load, so a changed policy applies on reload. It
looks among the first 100 `canopy-viewer` configs matching the name; with
more than that, pin the slug.

## Configuration (`.env.local`)

| Variable                  | Default                            | Meaning                                                                                                                                                        |
| ------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VITE_SCREENS_BASE_URL`   | `''` (same origin)                 | Base URL serving a canopy-screens checkout (`manifest.json` + `screens/**`)                                                                                    |
| `VITE_PV_MODE`            | `mock`                             | `mock` = simulated PVs, rules inert · `hare` = live Canopy                                                                                                     |
| `VITE_CANOPY_BASE_URL`    | —                                  | Canopy API base (hare mode), e.g. `https://canopy.example.org`                                                                                                 |
| `VITE_CANOPY_API_KEY`     | —                                  | API key (hare mode)                                                                                                                                            |
| `VITE_RENDER_MODE`        | `edm`                              | Default render mode: `edm` (legacy alarm/text presentation) · `carbon`                                                                                         |
| `VITE_EDM_BASE_URL`       | `/displays/v1/edm`                 | Display-file endpoint behind `/edl/<path>` and edm variants: Canopy's display tree named `edm` (`{base}/files/<path>`, `{base}/config/colors.list`)            |
| `VITE_EDM_API_KEY`        | see meaning                        | `X-API-Key` for that endpoint. Default: the Canopy key when the endpoint is Canopy's (under `VITE_CANOPY_BASE_URL`, or relative when that is unset), else none |
| `VITE_SCREEN_POLICY`      | `magpie` in hare mode, else `none` | Where the site's choice of variant comes from                                                                                                                  |
| `VITE_SCREEN_POLICY_SLUG` | —                                  | Magpie slug of the policy config (default: find it by name)                                                                                                    |

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
