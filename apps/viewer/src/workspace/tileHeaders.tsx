// The headers of the workspace's tiles.
//
// One tile shows its tabs in the strip and has no bar; standalone, the focused
// tab's header sits in a row above the content (the single-tile header row).
// Two or more tiles each have one bar (dock/TileBar): the tile's tabs, the
// showing one marked, each with its ×, and a grip. The right header action
// (dock/TileBar TileActions) holds the showing tab's header: a screen's own
// ScreenHeader (ScreenTileHeader: its title, zoom group and actions, which act
// on that tile whether or not it has focus), or a tool's Save view (a tool
// keeps its own in-frame header). When the host owns the header there is no
// header row: every mounted screen gets a headless ScreenTileRunner instead,
// whose verbs the host header shows.
//
// Exactly one window keydown listener runs the shortcuts (useShortcuts, bound
// by the page to the focused screen's available actions). The headers bind
// none: each sits under a ShortcutRelay for its key, through which its action
// bar hands over its runner (TileRunners), so ⌘S runs the focused tile's
// download with that bar's status text.

import { useEffect, useMemo } from 'react';
import type { CSSProperties } from 'react';
import { useHref } from 'react-router-dom';
import type { ViewerConfig } from '../config.js';
import { ScreenHeader } from '../ScreenHeader.js';
import type { ScreenHistory, ScreenZoom } from '../ScreenHeader.js';
import { ShortcutRelayContext } from '../screenActions/ScreenActionBar.js';
import type { ShortcutRelay } from '../screenActions/ScreenActionBar.js';
import type { ScreenAction, ScreenActionContext, ScreenTarget } from '../screenActions/types.js';
import { useScreenActions } from '../screenActions/useScreenActions.js';
import type { ScreenVerbRegistry } from '../screenActions/useScreenActions.js';
import { useKeyedZoom } from '../ZoomContext.js';
import type { ZoomStore } from '../ZoomContext.js';
import { stepZoom } from '../zoom.js';
import type { Report } from './mountSet.js';
import { tabDetail } from './TabStrip.js';
import { tileBarsShown } from './dock/TileBar.js';
import { urlForKey } from './workspaceUrl.js';

/** The height of the header row (Carbon's 3rem header). */
export const TILE_BAR_ROW_HEIGHT = '3rem';

/** The single-tile header row of a tool: its Save view, right-aligned. */
export const SINGLE_TILE_TOOL_ROW: CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  minBlockSize: TILE_BAR_ROW_HEIGHT,
};

/** Where the headers go for `tileCount` tiles. */
export interface BarPlacement {
  /** Every tile has its own bar (two or more tiles). */
  tileBars: boolean;
  /** The tab strip shows, as the one tile's bar. */
  strip: boolean;
  /** The focused tab's header sits in a row above the content. */
  headerRow: boolean;
}

/**
 * The bar placement: tile bars from two tiles on (tileBarsShown), else the
 * strip; the header row only with chrome, one tile and a header the viewer
 * draws itself.
 */
export function barPlacement(
  tileCount: number,
  { chrome, headerOwnedByHost }: { chrome: boolean; headerOwnedByHost: boolean }
): BarPlacement {
  const tileBars = tileBarsShown(tileCount);
  return { tileBars, strip: !tileBars, headerRow: chrome && !headerOwnedByHost && !tileBars };
}

/**
 * The runners the screen tiles' action bars hand over, by tab key, and one
 * stable relay per key to hand them over through. The workspace's shortcut
 * listener runs the focused key's.
 */
export class TileRunners {
  private readonly runners = new Map<string, (action: ScreenAction) => void>();
  private readonly relays = new Map<string, ShortcutRelay>();

  relayFor(key: string): ShortcutRelay {
    let relay = this.relays.get(key);
    if (relay === undefined) {
      relay = {
        attach: (run) => {
          this.runners.set(key, run);
          return () => {
            if (this.runners.get(key) === run) this.runners.delete(key);
          };
        },
      };
      this.relays.set(key, relay);
    }
    return relay;
  }

  run(key: string, action: ScreenAction): void {
    this.runners.get(key)?.(action);
  }
}

export interface ScreenTileHeaderProps {
  /** The screen tab's key. */
  tileKey: string;
  /** Its title: what its screen reported, else the strip's. */
  title: string;
  /** What its screen reported (scale, open screen). */
  report: Report | undefined;
  zoomStore: ZoomStore;
  config?: Readonly<Partial<ViewerConfig>>;
  plotInDataBrowser?: (screen: ScreenTarget) => void;
  /** Where its action bar hands over its runner (the workspace owns the shortcuts). */
  relay: ShortcutRelay;
  /** Its tab's ◀ ▶ (Back/Forward). */
  history?: ScreenHistory;
}

/**
 * One screen tile's ScreenHeader: that key's zoom (read and written in the
 * shared ZoomStore), and actions whose context is that tile's own screen,
 * zoom and link, so a click acts on this tile whatever has focus. The
 * action bar binds no listener of its own: it sits under the key's relay.
 */
export function ScreenTileHeader({
  tileKey,
  title,
  report,
  zoomStore,
  config,
  plotInDataBrowser,
  relay,
  history,
}: ScreenTileHeaderProps) {
  const { mode, scale: manualScale, setFit, setManual } = useKeyedZoom(zoomStore, tileKey);
  const scale = report?.scale ?? (mode === 'manual' ? manualScale : 1);
  const fit = mode === 'fit';
  // The URL that reopens this tab: the workspace URL naming it.
  const href = useHref(urlForKey(tileKey));
  const target = report?.screen ?? null;
  const actions = useMemo<ScreenActionContext | undefined>(
    () =>
      target
        ? {
            screen: target,
            zoom: { scale, fit },
            config,
            link: new URL(href, window.location.href).href,
            plotInDataBrowser,
          }
        : undefined,
    [target, scale, fit, config, href, plotInDataBrowser]
  );
  const zoom: ScreenZoom = {
    scale,
    fit,
    onZoomOut: () => setManual(stepZoom(scale, -1)),
    onZoomIn: () => setManual(stepZoom(scale, 1)),
    onFit: setFit,
    onActualSize: () => setManual(1),
  };
  return (
    <ShortcutRelayContext.Provider value={relay}>
      <ScreenHeader
        title={title}
        detail={tabDetail(tileKey)}
        zoom={zoom}
        history={history}
        actions={actions}
      />
    </ShortcutRelayContext.Provider>
  );
}

export interface ScreenTileRunnerProps {
  tileKey: string;
  report: Report | undefined;
  zoomStore: ZoomStore;
  config?: Readonly<Partial<ViewerConfig>>;
  plotInDataBrowser?: (screen: ScreenTarget) => void;
  history?: ScreenHistory;
  /** The key's relay while no bar holds the runner; null while one does. */
  relay: ShortcutRelay | null;
  /** Where outcomes go: the toast column. */
  notify: (text: string, error: boolean) => void;
  /** Where its verbs are published for the host header. */
  verbs: ScreenVerbRegistry;
}

/**
 * One screen tile's headless action runner, while the host owns the header: the same
 * context ScreenTileHeader builds, run through useScreenActions. While the
 * tile has no bar (one tile) it holds the key's relay, so the workspace's ⌘S
 * / ⌘I / ⌘P reach it; its outcomes go to the toast column; its verb view and
 * invoke are published under its key either way.
 */
export function ScreenTileRunner({
  tileKey,
  report,
  zoomStore,
  config,
  plotInDataBrowser,
  history,
  relay,
  notify,
  verbs,
}: ScreenTileRunnerProps) {
  const { mode, scale: manualScale } = useKeyedZoom(zoomStore, tileKey);
  const scale = report?.scale ?? (mode === 'manual' ? manualScale : 1);
  const href = useHref(urlForKey(tileKey));
  const link = useMemo(() => new URL(href, window.location.href).href, [href]);
  const { view, invoke } = useScreenActions({
    screen: report?.screen ?? null,
    zoom: { scale, fit: mode === 'fit' },
    config,
    link,
    plotInDataBrowser,
    history,
    relay,
    notify,
  });
  useEffect(() => {
    verbs.set(tileKey, { view, invoke });
  }, [verbs, tileKey, view, invoke]);
  useEffect(() => () => verbs.set(tileKey, undefined), [verbs, tileKey]);
  return null;
}
