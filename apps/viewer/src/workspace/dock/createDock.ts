// The single place the viewer constructs a dockview. dockview
// owns empty placeholders, geometry and gestures; the viewer mounts every
// panel itself in an overlay layer, so each panel's content is a bare div.
// Drops are decided by the dock bridge (useDockBridge), never by dockview.
import {
  createDockview,
  markDockviewPackageLoaded,
  type DockviewApi,
  type DockviewTheme,
  type IContentRenderer,
} from 'dockview-core';
import 'dockview-core/dist/styles/dockview.css';

/** One custom theme for every colour scheme; never swapped on a theme flip. */
export const CANOPY_DOCK_THEME: DockviewTheme = {
  name: 'canopy',
  className: 'canopy-dock',
  dndOverlayMounting: 'absolute',
};

function placeholder(): IContentRenderer {
  const element = document.createElement('div');
  element.className = 'canopy-dock-placeholder';
  return { element, init() {} };
}

export function createDock(root: HTMLElement): DockviewApi {
  // Silences dockview-core's "do not use core directly" warning; the viewer
  // supplies the drag subscriptions the wrapper package would (useDockBridge).
  markDockviewPackageLoaded();
  return createDockview(root, {
    disableFloatingGroups: true,
    // Native HTML5 drags only: the bridge's capture listeners decide every drop.
    dndStrategy: 'html5',
    theme: CANOPY_DOCK_THEME,
    createComponent: placeholder,
  });
}
