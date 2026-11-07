---
icon: lucide/app-window
---

# Embedding the viewer in a host shell

The workspace (`/embed/`) can run as a tile of a host page, a _host shell_
that frames it in an iframe and draws the tile's header bar itself. This page
describes what the viewer expects from such a host and every message the two
exchange. Message names carry a `canopy-host-` prefix.

## Being embedded

The viewer is **host-embedded** when both hold:

- it runs in a frame (`window.parent !== window`), and
- its URL carries `?embedded=true`.

The answer is latched for the life of the page. Since the viewer's own URL
writer drops `embedded`, a positive answer is also kept in sessionStorage
(scoped to the mount), so a reload inside the frame stays embedded. A
standalone tab never sees it.

When embedded, the viewer puts the class `embedded` on `<body>`, which a host
stylesheet may key on.

## What the host takes over

Embedding turns on four capabilities (`HostCapabilities` in
`apps/viewer/src/workspace/host/hostCapabilities.ts`). A standalone page has
none of them; a deployment can set its own through `HostCapabilitiesContext`.

| Capability          | Effect                                                                                                                                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `headerOwnedByHost` | The viewer draws no header row and no target badge; it contributes its header items to the host (below). Tool frames get `&hostbar=1` in their URL, so they report their actions instead of drawing them.    |
| `compactSidebar`    | The screen browser's header is one row (search, ⋯, collapse), with no Quick open or Collections button. The tree lists Pinned (only when non-empty), the ticked collections, Tools, Screens and Recent last. |
| `homeOnFirstOpen`   | A first visit opens the configured home screen, else the first screen of the tree, instead of the data browser.                                                                                              |
| `firstOpenHint`     | The tree ends in a hint while nothing is pinned or recent.                                                                                                                                                   |

## Messages

Every message goes to `window.parent` with `targetOrigin` set to the viewer's
own origin, and the viewer accepts a message only when its `source` is
`window.parent` and its `origin` equals its own. **A cross-origin host
receives nothing and cannot drive the viewer**: the host and the viewer must
be served from one origin.

### Header bar (host-embedded only)

**`canopy-host-header-contribution`** (viewer → host)

```json
{ "type": "canopy-host-header-contribution", "version": 1, "items": [ ... ] }
```

The whole list of items the host should render in the tile's bar, sent again
on every change; never a diff. An empty list is sent on `pagehide`, so a
reloading frame leaves no stale buttons. Each item has an `id`, a `kind` and
an optional numeric `priority` (higher survives a narrow tile):

| `kind`   | Fields                                                          |
| -------- | --------------------------------------------------------------- |
| `text`   | `text`                                                          |
| `button` | `label`, `title?`, `tone?` (`default` or `accent`), `disabled?` |
| `menu`   | `label?`, `items`: `{id, label, checked?, disabled?}`           |
| `nav`    | `items`: `{id, label, active?}`                                 |
| `search` | `placeholder?`, `value?`                                        |

The viewer sends at most 12 items, 12 entries per menu or nav and 120
characters per string, after dropping malformed items and repeated
`kind:id` pairs.

**`canopy-host-header-action`** (host → viewer)

```json
{ "type": "canopy-host-header-action", "id": "more", "value": "menu:reset-layout" }
```

A click in the bar: `id` is the item's id; a menu or nav pick carries the
chosen entry's id as `value`.

### Navigation (any framed viewer)

| Message                        | Direction     | Meaning                                                                                                                                              |
| ------------------------------ | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `canopy-host-navigate-ready`   | viewer → host | The viewer's handler is installed. Sent once at mount and again in reply to every probe.                                                             |
| `canopy-host-navigate-probe`   | host → viewer | Asks for `canopy-host-navigate-ready`.                                                                                                               |
| `canopy-host-navigate` `{url}` | host → viewer | Navigate in place. `url` must be same-origin and under the viewer's mount; `?_canopyOpen=<ref>` opens that collection, any other path opens its tab. |

A tool URL `/embed/@<tool>?<query>` opens that query in a tab only when the host
hands it over: by this message, or as the first load of a frame whose parent is
same-origin (a host falls back to loading `src` until the viewer is ready). The
tab already showing the query, in any encoding, takes focus, else a new instance
opens with it; no instance's stored query changes. On a top-level load the query is ignored, because
a page URL can come from anyone and must not choose what a tool shows or overwrite
a stored instance.

`embedded`, `theme`, `mode`, `hostbar` and `_canopy*` are the viewer's own and are
never part of a tool's query, in any spelling. Only `@trace` takes a query, naming
only `pv`, `range`, `from` and `to`. A query outside that, or one an agent could
not send (at most 12 PVs and a range the Data Browser can read), or a tool at its
10 instances, or a workspace at its 50 tabs, opens nothing and shows the workspace's notice. The active tab's URL,
never a query, is what the viewer then shows, so a reload opens nothing again.

### Focus exit (any framed viewer)

**`canopy-host-focus-exit`** `{direction: "backward" | "forward"}` (viewer → host)

Two invisible tab stops bracket the workspace. Tabbing past the last control
(or Shift+Tab before the first) lands on one, which posts this message and
keeps focus; the host then moves focus to its own previous or next control.
