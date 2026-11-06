# canopy-screen-runtime

Runs the screens built with
[canopy-screen-builder](https://github.com/slaclab/canopy-screen-builder):
Screen IR, React renderer, widget set, and the operator-facing viewer.

Content (the screens themselves) lives in
[canopy-screens](https://github.com/slaclab/canopy-screens); live data comes
from [Canopy](https://github.com/slaclab/Canopy) through the
[canopy-sdk-js](https://github.com/slaclab/canopy-sdk-js) packages.

## Workspace

| Package                                              | Purpose                                                                                                               |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| [`@slaclab/canopy-screen-widgets`](packages/widgets) | Carbon PV widgets, drawing primitives, and the widget registry shared by builder and runtime                          |
| [`@slaclab/canopy-screen-runtime`](packages/runtime) | `ScreenRenderer` — macros, embedded screens, per-widget containment, and widget rules compiled for the Formula Engine |
| [`@slaclab/canopy-screen-codegen`](packages/codegen) | `generateTSX` — ejectable React code from screen models (generation direction only)                                   |
| [`viewer`](apps/viewer)                              | **Canopy Screens** — browse `/` and deep-link `/s/:category/:id?MACRO=value` over canopy-screens content              |

The Screen IR contract, `@slaclab/canopy-screen-ir`, and the client, React and
shell packages are [canopy-sdk-js](https://github.com/slaclab/canopy-sdk-js)
packages (see **SDK dependencies** below).

## Development

Requires [pnpm](https://pnpm.io) (see `packageManager` in package.json).

```bash
pnpm install        # see the TEMPORARY overrides note below
pnpm build          # tsc builds every package, vite builds the viewer
pnpm test           # vitest across the workspace
pnpm lint           # eslint
pnpm format:check   # prettier
pnpm typecheck      # tsc --noEmit everywhere (includes tests)
pnpm dev            # = pnpm --filter viewer dev
```

Packages of this workspace read each other from source: `@slaclab/canopy-screen-widgets`
and `@slaclab/canopy-screen-runtime` name their entry under the `canopy-source` export
condition, and the tests, the type check, the dev server and the viewer's bundle ask
for it. `pnpm build` produces what ships — the package tarballs and the viewer bundle
the browser tests serve — and nothing else depends on it, so an edit in one package
is seen by every sibling at once.

The viewer's [README](apps/viewer/README.md) documents pointing
`VITE_SCREENS_BASE_URL` at a locally served canopy-screens checkout for the
end-to-end smoke test.

## SDK dependencies: published vs linked (local dev)

The `@slaclab/canopy-client` / `canopy-react` / `canopy-shell` /
`canopy-screen-ir` packages are on the public npm registry (0.3.0 and later).
There are two supported ways to install:

- **Published mode** (CI, consumers): plain `pnpm install`; no token or
  `.npmrc` is needed.
- **Linked mode** (SDK co-development, the fidelity loop): add an
  `overrides` block to `pnpm-workspace.yaml` pointing `link:` at a sibling
  `../canopy-sdk-js` checkout (build it first: `pnpm install && pnpm build`
  there):

  ```yaml
  overrides:
    '@slaclab/canopy-client': link:../canopy-sdk-js/packages/client
    '@slaclab/canopy-react': link:../canopy-sdk-js/packages/react
    '@slaclab/canopy-shell': link:../canopy-sdk-js/packages/shell
    '@slaclab/canopy-screen-ir': link:../canopy-sdk-js/packages/screen-ir
  ```

  Widget/runtime changes then propagate live instead of freezing at the
  published tarballs. The viewer's vite config pins react/carbon
  deduplication for the linked copies.

The overrides block is a local working-copy setting: do not commit it (CI
has no sibling checkout and must install published versions), and revert
it before pushing. `canopy-screens` uses the same pattern for
`@slaclab/canopy-screen-ir` (as a direct `link:` dependency).

## Documentation

`docs/` is a [zensical](https://zensical.org) site published by the
`gh-pages` workflow (`uv run zensical serve` locally, with
[uv](https://docs.astral.sh/uv/)).
