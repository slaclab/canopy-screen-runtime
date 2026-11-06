// The header above an open screen: canopy-shell's AppHeader, the same
// 48 px dark Carbon header row (g100 in both themes) that Trace's data
// browser shows, so a screen tab and the data browser read as one
// application. Left: the product label "SCREEN", the screen's title and its
// detail (category/id and macros), led by the tab's Back/Forward buttons
// when it has a history. Right: the zoom group, then the screen actions
// (screenActions/) as icon buttons. There is no keyboard binding for
// Back/Forward: Alt+Left/Right belong to the browser.
//
// Each screen tile bar in the workspace renders one; the /s/ deep link
// renders one with the "All screens" link as its extra content.
// Every control is a plain button labelled by its native `title`: inside a
// dock tile bar a popover tooltip would be clipped by the tab container.
//
// A narrow header (a split tile, a wide sidebar) keeps every control clear of
// the others and inside the bar: ◀ ▶ never shrink, the title ellipsises, and
// once the bar is narrower than what its controls need (measured with every
// control showing) the actions move into one overflow menu behind a "More
// controls" button, then the "SCREEN" label goes, then the zoom group joins
// the actions in the menu. That menu is portalled to the body, so the tile
// bar's clipping and transform do not reach it, and stays mounted while the
// header is narrow, so the actions' shortcuts keep working.
//
// Inside a tile bar (`TileHeaderContext`, which the tile's actions provide) the header fits
// its tile instead: the "SCREEN" label is never shown (the tile's tab names the screen), and
// as the lane the tile leaves it narrows, the controls give way in this order, nothing ever
// wrapping or clipping mid-glyph: 1. the path (the detail) goes, 2. the title goes, 3. the
// zoom group becomes one "41 % ▾" menu button (Fit, 1:1 and the steps inside), 4. the actions
// move into one "⋯" menu, 5. ◀ ▶ join them there; only a lane narrower than the zoom button
// and the "⋯" puts the zoom group into the "⋯" menu too. The header reports its floor (◀ ▶,
// the zoom button and the "⋯"), which the tile keeps for it beside the tabs.

import { useContext, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Theme } from '@carbon/react';
import { OverflowMenuHorizontal } from '@carbon/icons-react';
import { AppHeader } from '@slaclab/canopy-shell';
import { ScreenActionBar } from './screenActions/ScreenActionBar.js';
import type { ScreenActionContext } from './screenActions/types.js';
import { formatPercent } from './zoom.js';
import { TileHeaderContext } from './workspace/dock/TileBar.js';
import { actionsWidth, useTileStep } from './workspace/dock/tileHeaderFit.js';
import './ScreenHeader.css';

/** The product label, styled like Trace's "TRACE". */
export const SCREEN_LABEL = 'SCREEN';

/** Room the title keeps before the zoom group and actions collapse into the menu. */
export const MIN_TITLE_PX = 64;

export interface ScreenZoom {
  /** The scale in effect (the fit result in fit mode). */
  scale: number;
  fit: boolean;
  onZoomOut(): void;
  onZoomIn(): void;
  onFit(): void;
  onActualSize(): void;
}

/** One direction of a tab's Back/Forward history. */
export interface ScreenHistoryStep {
  /** False when that stack is empty: the button shows disabled. */
  enabled: boolean;
  /** The target's title when it is open in another tab: the click switches there. */
  switchTo?: string;
  onClick(): void;
}

/** A screen tab's Back (◀) and Forward (▶) buttons. */
export interface ScreenHistory {
  back: ScreenHistoryStep;
  forward: ScreenHistoryStep;
}

export interface ScreenHeaderProps {
  title: string;
  /** Secondary text beside the title, e.g. `category/id?MACRO=value`. */
  detail?: string;
  /** Zoom controls, on a zoomable screen. */
  zoom?: ScreenZoom;
  /** Back/Forward of the screen's tab; absent (e.g. the /s/ route), no buttons. */
  history?: ScreenHistory;
  /** The action context; without one the header shows no actions. */
  actions?: ScreenActionContext;
  /** Extra content after the title (the /s/ route's "All screens" link). */
  children?: ReactNode;
}

function ZoomGroup({ zoom }: { zoom: ScreenZoom }) {
  return (
    <div className="screen-header__zoom" role="group" aria-label="Zoom">
      <button
        type="button"
        className="canopy-btn screen-header__button"
        aria-label="Zoom out"
        title="Zoom out"
        onClick={zoom.onZoomOut}
      >
        −
      </button>
      <span className="screen-header__percent" data-testid="zoom-percent" aria-live="polite">
        {formatPercent(zoom.scale)}
      </span>
      <button
        type="button"
        className="canopy-btn screen-header__button"
        aria-label="Zoom in"
        title="Zoom in"
        onClick={zoom.onZoomIn}
      >
        +
      </button>
      <button
        type="button"
        className="canopy-btn screen-header__button screen-header__button--text"
        aria-pressed={zoom.fit}
        title="Fit the whole screen in view"
        onClick={zoom.onFit}
      >
        Fit
      </button>
      <button
        type="button"
        className="canopy-btn screen-header__button screen-header__button--text"
        aria-label="Actual size"
        title="Actual size (100%)"
        onClick={zoom.onActualSize}
      >
        1:1
      </button>
    </div>
  );
}

function HistoryButton({
  step,
  label,
  glyph,
}: {
  step: ScreenHistoryStep;
  label: string;
  glyph: string;
}) {
  return (
    <button
      type="button"
      className="canopy-btn screen-header__button"
      aria-label={label}
      title={step.enabled && step.switchTo !== undefined ? `Switch to ${step.switchTo}` : label}
      disabled={!step.enabled}
      onClick={step.enabled ? step.onClick : undefined}
    >
      {glyph}
    </button>
  );
}

function HistoryGroup({ history }: { history: ScreenHistory }) {
  return (
    <div className="screen-header__history" role="group" aria-label="History">
      <HistoryButton step={history.back} label="Back" glyph="◀" />
      <HistoryButton step={history.forward} label="Forward" glyph="▶" />
    </div>
  );
}

/** The "More controls" button's width: Carbon's 3rem header action (a host's is smaller). */
const TRIGGER_PX = 48;

/** What a standalone bar's parts need, measured while every control shows. */
interface Widths {
  /** ◀ ▶ and MIN_TITLE_PX for the title block: never collapsed. */
  fixed: number;
  /** The "SCREEN" label. */
  label: number;
  zoom: number;
  /** The action bar without its transient status text; 0 without actions. */
  actions: number;
}

/**
 * How far a standalone bar has collapsed, in order: nothing; the actions into the menu; the
 * "SCREEN" label hidden too; the zoom group into the menu as well.
 */
type Collapse = 'none' | 'actions' | 'label' | 'all';

/** A standalone bar's parts' widths. */
function measure(root: HTMLElement): Widths | null {
  const header = root.querySelector('.cds--header');
  if (!header) return null;
  const widths: Widths = { fixed: MIN_TITLE_PX, label: 0, zoom: 0, actions: 0 };
  for (const child of header.children) {
    if (!(child instanceof HTMLElement)) continue;
    const has = (name: string) => child.classList.contains(name);
    if (has('screen-header__info')) continue;
    if (has('cds--header__name')) widths.label = child.offsetWidth;
    else if (has('screen-header__zoom')) widths.zoom = child.offsetWidth;
    else if (has('cds--header__global')) widths.actions = actionsWidth(child);
    else widths.fixed += child.offsetWidth;
  }
  return widths.label > 0 ? widths : null;
}

/** The least standalone collapse that fits `width`. */
function collapseFor(width: number, w: Widths): Collapse {
  const withZoom = w.fixed + w.zoom;
  if (width >= withZoom + w.label + w.actions) return 'none';
  const menu = w.actions > 0 ? TRIGGER_PX : 0;
  if (width >= withZoom + w.label + menu) return 'actions';
  if (width >= withZoom + menu) return 'label';
  return 'all';
}

/**
 * How much of a standalone header goes into the overflow menu. The widths are measured while
 * every control shows and kept while some are collapsed, so the bar returns to the full
 * layout once it is wide enough again. A resize of the bar or of any of its parts (an action
 * appearing, the status text) re-checks; ResizeObserver also reports once on observe.
 */
function useCollapse(root: RefObject<HTMLDivElement | null>, collapsible: boolean): Collapse {
  const [collapse, setCollapse] = useState<Collapse>('none');
  const widths = useRef<Widths | null>(null);
  useLayoutEffect(() => {
    const el = root.current;
    // Without a ResizeObserver (an old embedder) the bar keeps the full layout.
    if (!el || !collapsible || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (collapse === 'none') widths.current = measure(el) ?? widths.current;
      // A width of 0 is no layout (jsdom, a hidden tile): nothing to collapse for.
      const width = el.clientWidth;
      const w = widths.current;
      setCollapse(width > 0 && w !== null ? collapseFor(width, w) : 'none');
    });
    observer.observe(el);
    const header = el.querySelector('.cds--header');
    for (const part of header?.children ?? []) observer.observe(part);
    return () => observer.disconnect();
  }, [root, collapsible, collapse]);
  return collapsible ? collapse : 'none';
}

// --- menus ---------------------------------------------------------------------------------

/**
 * A header button and the panel it opens, portalled to the body (so the tile bar's clipping
 * does not reach it) and painted as the dark bar. It stays open across zoom steps and actions
 * (so "Copied" shows) and closes on Escape or a press outside it. The panel stays mounted
 * while closed, so the actions' shortcuts keep working.
 */
function HeaderMenu({
  className,
  label,
  title,
  menuLabel,
  testId,
  children,
  trigger: content,
}: {
  className: string;
  label: string;
  title: string;
  menuLabel: string;
  testId: string;
  children: ReactNode;
  trigger: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState({ top: 0, right: 0 });
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menu.current?.contains(target) || trigger.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const toggle = () => {
    if (!open && trigger.current) {
      // Right-aligned under the trigger, just below the bar.
      const rect = trigger.current.getBoundingClientRect();
      const bar = trigger.current.closest('.screen-header')?.getBoundingClientRect() ?? rect;
      const right = document.documentElement.clientWidth - rect.right;
      setPlace({ top: bar.bottom, right: Math.max(0, right) });
    }
    setOpen(!open);
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={className}
        aria-label={label}
        title={title}
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={id}
        onClick={toggle}
      >
        {content}
      </button>
      {createPortal(
        <Theme
          theme="g100"
          id={id}
          ref={menu}
          className="screen-header__overflow"
          role="group"
          aria-label={menuLabel}
          data-testid={testId}
          hidden={!open}
          style={{ top: place.top, right: place.right }}
        >
          {children}
        </Theme>,
        document.body
      )}
    </>
  );
}

/** The narrow header's "More controls" menu: ◀ ▶, the zoom group and the actions it holds. */
function OverflowControls({
  zoom,
  actions,
  history,
}: {
  zoom?: ScreenZoom;
  actions?: ScreenActionContext;
  history?: ScreenHistory;
}) {
  return (
    <HeaderMenu
      className="cds--header__action screen-header__more"
      label="More controls"
      title="More controls"
      menuLabel="Screen controls"
      testId="screen-header-overflow"
      trigger={<OverflowMenuHorizontal size={20} aria-hidden="true" />}
    >
      {history && <HistoryGroup history={history} />}
      {zoom && <ZoomGroup zoom={zoom} />}
      {actions && (
        <div className="screen-header__overflow-actions">
          <ScreenActionBar ctx={actions} />
        </div>
      )}
    </HeaderMenu>
  );
}

/** The tile header's compact zoom: "41 % ▾", opening the zoom group (steps, Fit, 1:1). */
function ZoomMenu({ zoom }: { zoom: ScreenZoom }) {
  const percent = formatPercent(zoom.scale);
  return (
    <HeaderMenu
      className="canopy-btn screen-header__zoom-menu"
      label={`Zoom ${percent}`}
      title={`Zoom ${percent}: steps, Fit, 1:1`}
      menuLabel="Zoom controls"
      testId="screen-header-zoom-menu"
      trigger={
        <>
          <span className="screen-header__percent" data-testid="zoom-percent">
            {percent}
          </span>
          <span aria-hidden="true">▾</span>
        </>
      }
    >
      <ZoomGroup zoom={zoom} />
    </HeaderMenu>
  );
}

export function ScreenHeader({
  title,
  detail,
  zoom,
  history,
  actions,
  children,
}: ScreenHeaderProps) {
  const root = useRef<HTMLDivElement>(null);
  const fit = useContext(TileHeaderContext);
  const has = { detail: Boolean(detail), zoom: zoom !== undefined, actions: actions !== undefined };
  const collapse = useCollapse(root, fit === null && (has.zoom || has.actions));
  const step = useTileStep(root, fit, has);

  let showDetail = true;
  let showTitle = true;
  let barZoom: ReactNode = zoom && <ZoomGroup zoom={zoom} />;
  let bar: ReactNode;
  let barHistory = history;
  let label = collapse === 'none' || collapse === 'actions';
  if (fit !== null) {
    label = false;
    showDetail = step === 0;
    showTitle = step <= 1;
    if (zoom && step >= 3) barZoom = step <= 5 ? <ZoomMenu zoom={zoom} /> : null;
    if (step >= 5) barHistory = undefined;
    const menuActions = step >= 4 ? actions : undefined;
    const menuHistory = step >= 5 ? history : undefined;
    const menuZoom = step >= 6 ? zoom : undefined;
    if (menuActions || menuHistory || menuZoom)
      bar = <OverflowControls zoom={menuZoom} actions={menuActions} history={menuHistory} />;
    else bar = actions && <ScreenActionBar ctx={actions} />;
  } else {
    const menuZoom = collapse === 'all' ? zoom : undefined;
    if (menuZoom) barZoom = null;
    if (collapse === 'none') bar = actions && <ScreenActionBar ctx={actions} />;
    else if (actions || menuZoom) bar = <OverflowControls zoom={menuZoom} actions={actions} />;
  }
  return (
    <div
      className={
        'screen-header' +
        (label ? '' : ' screen-header--no-label') +
        (fit !== null ? ' screen-header--tile' : '')
      }
      data-testid="screen-header"
      data-step={fit !== null ? step : undefined}
      ref={root}
    >
      {/* shell 0.2 defaults to a page-themed bar with a red "SLAC" prefix and
          a skip link to #main-content; these props keep the dark label-only
          bar, and a screen tile has no #main-content to skip to. */}
      <AppHeader
        productName={SCREEN_LABEL}
        theme="g100"
        prefix=""
        brandColor={false}
        skipToContent={false}
        actions={bar}
      >
        {barHistory && <HistoryGroup history={barHistory} />}
        <div className="screen-header__info">
          {showTitle && (
            <span
              className="screen-header__title"
              title={detail ? `${title} (${detail})` : title}
              data-testid="screen-header-title"
            >
              <span className="screen-header__title-text">{title}</span>
              {detail && showDetail && <span className="screen-header__detail">{detail}</span>}
            </span>
          )}
          {children}
        </div>
        {barZoom}
      </AppHeader>
    </div>
  );
}
