// The screen action contract. A ScreenAction is one entry in a declarative
// list (actions.ts): the header renders every action whose isAvailable(ctx)
// holds, as an icon button whose tooltip is its label (and shortcut), and
// binds its shortcut. Adding an action is adding one entry; an action whose
// prerequisites are missing from the context hides itself, so no host or
// deployment needs a special case.

import type { CarbonIconType } from '@carbon/icons-react';
import type { ScreenPVGroup } from '@slaclab/canopy-screen-runtime';
import type { ViewerConfig } from '../config.js';

/** The open screen an action works on, as the page that renders it sees it. */
export interface ScreenTarget {
  category: string;
  id: string;
  title: string;
  macros: Readonly<Record<string, string>>;
  /**
   * The element that shows the screen as displayed (at the current zoom), or
   * null before it is on the page.
   */
  element: HTMLElement | null;
  /** Absolute URL of the screen document (the IR .screen.json) as served. */
  documentUrl: string;
  /** The authored size, from the document's metadata. */
  size?: { width: number; height: number };
  /** Re-fetch the document and remount the screen, reconnecting its PVs. */
  reload?: () => void;
  /**
   * The PVs the screen shows, embedded screens included, grouped per screen
   * instance (collectScreenPVs).
   */
  collectPVs?: () => Promise<ScreenPVGroup[]>;
}

/** Everything an action may read. */
export interface ScreenActionContext {
  screen: ScreenTarget;
  /** The scale in effect and whether it is the fit-to-view scale. */
  zoom: { scale: number; fit: boolean };
  /** The viewer config, when the host has one. */
  config?: Readonly<Partial<ViewerConfig>>;
  /** Absolute URL that reopens exactly this screen with its macros. */
  link?: string;
  /**
   * Let the operator pick PVs of `screen` and plot them in the data browser;
   * offered by a host that has one (the workspace with a Trace tab).
   */
  plotInDataBrowser?: (screen: ScreenTarget) => void;
}

/** What a finished action wants the operator to see briefly ("Copied"). */
export interface ScreenActionFeedback {
  message: string;
}

export interface ScreenAction {
  /** Stable id (React key and test hook). */
  id: string;
  /** Button label and tooltip text. */
  label: string;
  icon: CarbonIconType;
  /**
   * A letter bound to the platform's primary modifier (⌘ on macOS, Ctrl
   * elsewhere): 's' is ⌘S / Ctrl+S.
   */
  shortcut?: string;
  isAvailable(ctx: ScreenActionContext): boolean;
  run(ctx: ScreenActionContext): void | Promise<void | ScreenActionFeedback>;
}
