---
icon: lucide/layout-dashboard
---

# The dock

The viewer's workspace is a dock of **tiles**. Each tile holds one or more
screens as **tabs** and shows one of them at a time. Drag a tab or a whole
tile to rearrange; where you let go decides what happens.

## Tiles and tabs

- Every tile has a **bar**: a grip on the left, then one tab per screen,
  each with its own **×**. The showing tab is marked.
- Click a tab to show it. Drag a tab to move that one screen; drag the
  **grip** to move the whole tile with all its tabs.
- With a single tile there is no tile bar: the **tab strip** above the dock
  is that tile's bar and accepts drops the same way.
- Keyboard: the bar is one tab stop. ←/→ (wrapping), Home and End show
  another tab; Delete or Backspace closes the showing tab; Enter or ↓ moves
  into the screen.

## Drop places

While you drag, the part of the tile under the pointer lights up: the half
the item will land in, the whole tile when it will become a tab, or the new
strip along the dock's edge. Every point of a tile is a drop place, and the
places are the same whichever tile you drag from:

<figure markdown="span">
<svg viewBox="0 0 520 330" width="520" role="img" aria-label="Two tiles side by side. The right tile shows its drop places: 1 its header row, 2 the dock-edge strips along the dock's left, right and bottom and just under the top headers, 3 its left and right edges, 31 % of the tile deep, 4 its top and bottom edges, 31 % deep, 5 its centre." style="max-width:100%;height:auto;font-family:inherit;font-size:13px">
  <rect x="10" y="10" width="500" height="280" fill="none" stroke="currentColor" stroke-opacity=".5"/>
  <!-- left tile -->
  <rect x="10" y="10" width="244" height="26" fill="currentColor" fill-opacity=".08"/>
  <text x="132" y="170" text-anchor="middle" fill="currentColor" fill-opacity=".6">another tile</text>
  <!-- right tile: 1 header row -->
  <rect x="266" y="10" width="244" height="26" fill="#4589ff" fill-opacity=".45"/>
  <rect x="274" y="15" width="60" height="16" rx="2" fill="none" stroke="currentColor" stroke-opacity=".5"/>
  <!-- 3 left and right edges (they win at the corners) -->
  <rect x="266" y="36" width="76" height="254" fill="#42be65" fill-opacity=".4"/>
  <rect x="434" y="36" width="76" height="254" fill="#42be65" fill-opacity=".4"/>
  <!-- 4 top and bottom edges -->
  <rect x="342" y="36" width="92" height="79" fill="#08bdba" fill-opacity=".35"/>
  <rect x="342" y="211" width="92" height="79" fill="#08bdba" fill-opacity=".35"/>
  <!-- 5 centre -->
  <rect x="342" y="115" width="92" height="96" fill="#a56eff" fill-opacity=".35"/>
  <!-- 2 dock-edge strips: left, right, bottom, and just under the top headers -->
  <g fill="#ff832b" fill-opacity=".55">
    <rect x="10" y="36" width="12" height="254"/>
    <rect x="498" y="36" width="12" height="254"/>
    <rect x="22" y="278" width="476" height="12"/>
    <rect x="22" y="36" width="476" height="12"/>
  </g>
  <rect x="266" y="10" width="244" height="280" fill="none" stroke="currentColor" stroke-opacity=".5"/>
  <line x1="260" y1="10" x2="260" y2="290" stroke="currentColor" stroke-opacity=".7"/>
  <g fill="currentColor" font-weight="600" text-anchor="middle">
    <text x="440" y="28">1</text>
    <text x="132" y="47">2</text>
    <text x="304" y="168">3</text>
    <text x="472" y="168">3</text>
    <text x="388" y="88">4</text>
    <text x="388" y="258">4</text>
    <text x="388" y="168">5</text>
  </g>
  <g fill="currentColor" font-size="12">
    <text x="10" y="312">1 header row · 2 dock edge · 3 left/right edge · 4 top/bottom edge · 5 centre</text>
  </g>
</svg>
<figcaption>The drop places of the right-hand tile (not to scale).</figcaption>
</figure>

| #   | Place                  | Where                                                                                                           | Result                                                                 |
| --- | ---------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 1   | **Header row**         | The tile's tabs and the toolbar beside them (with one tile, the strip). Always wins.                            | Added as a tab at the marker (right of the tabs: at the end).          |
| 2   | **Dock edge**          | The outermost 48 px of the dock on the left, right and bottom, and the first 48 px under the top row's headers. | A new tile a third of the dock deep, across its whole width or height. |
| 3   | **Left or right edge** | 31 % of the tile deep, at least 80 px. Wins at the corners.                                                     | The tile splits into two halves; the item takes that half.             |
| 4   | **Top or bottom edge** | The same, along the tile's height.                                                                              | As above.                                                              |
| 5   | **Centre**             | The rest of the tile.                                                                                           | Added as a tab of that tile, and shown.                                |

- The item lands exactly where the highlight was. When you move a whole
  tile (or a tile's only tab), its old space goes to a neighbour first; if
  that neighbour is the tile you drop on, the result is that much larger.
- A tile too narrow (or too low) to halve into two 40 px tiles has no left
  and right (or top and bottom) edges; those points count as the rest of
  the tile.
- A moved whole tile keeps its tabs and the one it was showing.
- Dropping something where it already is shows no highlight and does
  nothing.

## The tile header

A tile's header holds its tabs and the showing screen's toolbar. The tabs
come first: each is 96 to 220 px wide, and when they do not fit they
scroll sideways. As the tile narrows, the toolbar gives way in this order:
the screen's path, then its title, then the zoom controls fold into one
**41 % ▾** button (Fit, 1:1 and the steps inside), then the action buttons
move into one **⋯** menu, and last ◀ ▶ join them there.

## The 40 px floor

No tile ever gets smaller than **40 px** wide or high.

## The ☰ window menu

The window-wide actions live in one menu, **☰**, at the right end of the
bar of the top-right tile (with one tile, at the right end of the strip).
Open it with a click or **⌥M** (Alt+M on Windows and Linux). It holds:

- **Reset layout**: every tile as an equal column, tabs kept. Needs two
  tiles.
- **Save open tabs as collection…**: when collections are available.
- **Recently closed**: what was closed, newest first; pick one to bring it
  back.
- **Close all**.
- **Docs** and **Report a bug** for the focused tool, when it provides them.

## Closing and the way back

- **A tab**: its ×, or Delete/Backspace on the bar. The next tab is shown.
- **A tile**: close its last tab; a neighbour takes its space.
- **Close others** and **Close to the right** (a tab's right-click menu in
  the strip, or Shift+F10) act within that tab's tile.
- **Close all**: from the ☰ menu.

Nothing closed is lost:

- Every close shows a toast, _Closed N tabs · Undo_.
- **⌘⇧T** (Ctrl+Shift+T) reopens the newest closed group.
- **☰ → Recently closed** lists older ones.

A reopened tab goes back into its tile at its place; a reopened tile goes
back beside the neighbour that took its space. If that is gone, it opens
as a tab of the focused tile.

Saved layouts (how a collection arranges its screens in the dock) are
described in Canopy's
[collections how-to](https://slaclab.github.io/canopy/how_to/collections/).
