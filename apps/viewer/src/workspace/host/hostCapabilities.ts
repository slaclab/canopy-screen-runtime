// What the page hosting the workspace takes over from it, as explicit
// capabilities. Generic UI (the sidebar, the screen tree, the first visit,
// the tool frames) switches on these, never on "are we embedded".
//
//   headerOwnedByHost  the host renders the workspace's header: the viewer
//                      contributes its items to the host bar (hostBridge),
//                      draws no header row and no target badge of its own,
//                      and tells tool frames so (`&hostbar=1` in their URL)
//   compactSidebar     the sidebar header is one row (search · ⋯ · chevron,
//                      no Quick open or Collections button) and the tree uses
//                      its compact sections: Pinned only when non-empty, the
//                      ticked collections, Tools, Screens (folder chains as
//                      breadcrumbs), Recent last and collapsed
//   homeOnFirstOpen    a first visit opens the configured home screen (else
//                      the first screen of the tree) instead of the data
//                      browser
//   firstOpenHint      the tree ends in the first-open hint while nothing is
//                      pinned or recent
//
// Standalone has none of them. Inside the host shell (hostEmbed.ts) the page
// has all of them. A deployment can set its own through
// HostCapabilitiesContext; without one the page derives them from the
// embedding.

import { createContext, useContext } from 'react';
import { isHostEmbedded } from './hostEmbed.js';

export interface HostCapabilities {
  headerOwnedByHost: boolean;
  compactSidebar: boolean;
  homeOnFirstOpen: boolean;
  firstOpenHint: boolean;
}

/** A standalone page: the viewer draws its own chrome. */
export const STANDALONE_CAPABILITIES: HostCapabilities = Object.freeze({
  headerOwnedByHost: false,
  compactSidebar: false,
  homeOnFirstOpen: false,
  firstOpenHint: false,
});

/** Inside the host shell. */
export const HOST_SHELL_CAPABILITIES: HostCapabilities = Object.freeze({
  headerOwnedByHost: true,
  compactSidebar: true,
  homeOnFirstOpen: true,
  firstOpenHint: true,
});

/** The capabilities the embedding implies (latched with isHostEmbedded). */
export function embeddedCapabilities(): HostCapabilities {
  return isHostEmbedded() ? HOST_SHELL_CAPABILITIES : STANDALONE_CAPABILITIES;
}

/** Set by a deployment, or by the workspace for everything below it. */
export const HostCapabilitiesContext = createContext<HostCapabilities | null>(null);

/** The provided capabilities, else those the embedding implies. */
export function useHostCapabilities(): HostCapabilities {
  return useContext(HostCapabilitiesContext) ?? embeddedCapabilities();
}
