// headerActions: the replay contract for the host header's action route. One
// describe per id family, with fakes for the handlers, the focus call and the
// toast sink; the toast rule (own outcome, else a past-tense label, every
// refusal toasted) and the refusal of an entry the tool reported disabled.

import { describe, expect, it, vi } from 'vitest';
import type { ScreenHistory } from '../../ScreenHeader.js';
import type { ScreenVerbs } from '../../screenActions/useScreenActions.js';
import {
  COLLECTIONS_UNAVAILABLE,
  dispatchHeaderAction,
  NO_BACK,
  NO_FORWARD,
  NO_SCREEN,
  NO_TOOL,
  RESET_LAYOUT_UNAVAILABLE,
  SAVE_COLLECTION_UNAVAILABLE,
  SAVE_VIEW_UNAVAILABLE,
  SEARCH_UNAVAILABLE,
  SUB_SCREENS_HIDDEN,
  SUB_SCREENS_SHOWN,
  toolDoneMessage,
  unavailableMessage,
  WENT_BACK,
  WENT_FORWARD,
  ZOOM_UNAVAILABLE,
  ZOOMED_100,
  ZOOMED_FIT,
  ZOOMED_IN,
  ZOOMED_OUT,
  type HeaderActionContext,
} from './headerActions.js';
import {
  DOWNLOAD_SCREEN_LABEL,
  MENU_COLLECTIONS,
  MENU_DOWNLOAD_SCREEN,
  MENU_RESET_LAYOUT,
  MENU_SAVE_COLLECTION,
  MENU_SHOW_SUB_SCREENS,
  MENU_ZOOM_100,
  MENU_ZOOM_FIT,
  MENU_ZOOM_IN,
  MENU_ZOOM_OUT,
  MORE_ID,
  NAV_BACK_ID,
  NAV_FORWARD_ID,
  SAVE_VIEW_ID,
  SEARCH_ID,
} from './headerComposer.js';
import type { ToolActionsReport } from '../toolActionsStore.js';

function history(back = true, forward = true): ScreenHistory {
  return {
    back: { enabled: back, onClick: vi.fn() },
    forward: { enabled: forward, onClick: vi.fn() },
  };
}

function verbs(result = true): ScreenVerbs {
  return {
    view: {
      canGoBack: false,
      canGoForward: false,
      verbs: [],
      zoom: { scale: 1, fit: false },
      download: { available: true },
    },
    invoke: vi.fn(() => result),
  };
}

const REPORT: ToolActionsReport = {
  version: 1,
  actions: [
    { id: 'import', label: 'Import…', kind: 'button' },
    { id: 'live', label: 'Live', kind: 'toggle', pressed: true },
    { id: 'export-csv', label: 'Export CSV', kind: 'button', disabled: 'No curves to export' },
    { id: 'clear', label: 'Clear', kind: 'button', disabled: false },
  ],
  links: {},
};

function baseFakes() {
  let sub = false;
  return {
    toast: vi.fn<(message: string) => void>(),
    focusViewer: vi.fn<() => void>(),
    openQuickOpen: vi.fn(() => true),
    saveView: vi.fn<() => void>(),
    openSaveCollection: vi.fn<() => void>(),
    resetLayout: vi.fn<() => void>(),
    getShowSubScreens: vi.fn(() => sub),
    setShowSubScreens: vi.fn((show: boolean) => {
      sub = show;
    }),
    openCollections: vi.fn(() => true),
    history: history(),
    screenVerbs: verbs(),
    zoom: { zoomIn: vi.fn(), zoomOut: vi.fn(), fit: vi.fn(), actual: vi.fn() },
    tool: { report: REPORT, invoke: vi.fn<(id: string) => boolean>(() => true) },
  } satisfies HeaderActionContext;
}

type Fakes = ReturnType<typeof baseFakes>;

/**
 * The fakes with `over` applied. Typed as the fakes so a test reads their
 * mocks; a test that overrides a member with null reads only the others.
 */
function makeCtx(over: Partial<HeaderActionContext> = {}): Fakes {
  return { ...baseFakes(), ...over } as Fakes;
}

describe('routing key', () => {
  it('routes a ⋯ entry by its value', () => {
    const ctx = makeCtx();
    dispatchHeaderAction(MORE_ID, MENU_COLLECTIONS, ctx);
    expect(ctx.openCollections).toHaveBeenCalledOnce();
  });

  it('ignores more without a value and unknown ids', () => {
    const ctx = makeCtx();
    dispatchHeaderAction(MORE_ID, undefined, ctx);
    dispatchHeaderAction('subtitle', undefined, ctx);
    dispatchHeaderAction('bogus', 'x', ctx);
    dispatchHeaderAction(MORE_ID, 'menu:bogus', ctx);
    expect(ctx.toast).not.toHaveBeenCalled();
    expect(ctx.focusViewer).not.toHaveBeenCalled();
  });

  it('uses the id, not the value, for non-more items', () => {
    const ctx = makeCtx();
    dispatchHeaderAction(SEARCH_ID, MENU_COLLECTIONS, ctx);
    expect(ctx.openQuickOpen).toHaveBeenCalledOnce();
    expect(ctx.openCollections).not.toHaveBeenCalled();
  });
});

describe('search', () => {
  it('focuses the viewer before opening Quick Open, no toast', () => {
    const order: string[] = [];
    const ctx = makeCtx({
      focusViewer: vi.fn(() => void order.push('focus')),
      openQuickOpen: vi.fn(() => (order.push('open'), true)),
    });
    dispatchHeaderAction(SEARCH_ID, undefined, ctx);
    expect(order).toEqual(['focus', 'open']);
    expect(ctx.toast).not.toHaveBeenCalled();
  });

  it('toasts when no palette is mounted', () => {
    const ctx = makeCtx({ openQuickOpen: vi.fn(() => false) });
    dispatchHeaderAction(SEARCH_ID, undefined, ctx);
    expect(ctx.toast).toHaveBeenCalledWith(SEARCH_UNAVAILABLE);
  });
});

describe('save-view', () => {
  it('focuses, then opens Save view; the dialog reports its own outcome', () => {
    const order: string[] = [];
    const ctx = makeCtx({
      focusViewer: vi.fn(() => void order.push('focus')),
      saveView: vi.fn(() => void order.push('save')),
    });
    dispatchHeaderAction(SAVE_VIEW_ID, undefined, ctx);
    expect(order).toEqual(['focus', 'save']);
    expect(ctx.toast).not.toHaveBeenCalled();
  });

  it('refuses with a toast when the focused tab cannot save', () => {
    const ctx = makeCtx({ saveView: undefined });
    dispatchHeaderAction(SAVE_VIEW_ID, undefined, ctx);
    expect(ctx.toast).toHaveBeenCalledWith(SAVE_VIEW_UNAVAILABLE);
  });
});

describe('nav-back / nav-forward', () => {
  it('steps the focused tile history and toasts a past-tense label', () => {
    const ctx = makeCtx();
    dispatchHeaderAction(NAV_BACK_ID, undefined, ctx);
    dispatchHeaderAction(NAV_FORWARD_ID, undefined, ctx);
    expect(ctx.history.back.onClick).toHaveBeenCalledOnce();
    expect(ctx.history.forward.onClick).toHaveBeenCalledOnce();
    expect(ctx.toast.mock.calls).toEqual([[WENT_BACK], [WENT_FORWARD]]);
  });

  it('refuses a disabled step', () => {
    const ctx = makeCtx({ history: history(false, false) });
    dispatchHeaderAction(NAV_BACK_ID, undefined, ctx);
    dispatchHeaderAction(NAV_FORWARD_ID, undefined, ctx);
    expect(ctx.history!.back.onClick).not.toHaveBeenCalled();
    expect(ctx.history!.forward.onClick).not.toHaveBeenCalled();
    expect(ctx.toast.mock.calls).toEqual([[NO_BACK], [NO_FORWARD]]);
  });

  it('refuses without a focused screen', () => {
    const ctx = makeCtx({ history: null });
    dispatchHeaderAction(NAV_BACK_ID, undefined, ctx);
    expect(ctx.toast).toHaveBeenCalledWith(NO_SCREEN);
  });
});

describe('screen:<verb> and menu:download-screen', () => {
  it('invokes the verb; its own notify reports, so no toast here', () => {
    const ctx = makeCtx();
    dispatchHeaderAction('screen:reload', undefined, ctx);
    dispatchHeaderAction('screen:copy-link', undefined, ctx);
    expect(ctx.screenVerbs.invoke).toHaveBeenNthCalledWith(1, 'reload');
    expect(ctx.screenVerbs.invoke).toHaveBeenNthCalledWith(2, 'copy-link');
    expect(ctx.toast).not.toHaveBeenCalled();
  });

  it('routes Download screen to the download verb', () => {
    const ctx = makeCtx();
    dispatchHeaderAction(MORE_ID, MENU_DOWNLOAD_SCREEN, ctx);
    expect(ctx.screenVerbs.invoke).toHaveBeenCalledWith('download');
  });

  it('toasts an unavailable verb by its label', () => {
    const ctx = makeCtx({ screenVerbs: verbs(false) });
    dispatchHeaderAction('screen:export-png', undefined, ctx);
    dispatchHeaderAction(MORE_ID, MENU_DOWNLOAD_SCREEN, ctx);
    expect(ctx.toast.mock.calls).toEqual([
      [unavailableMessage('Export PNG')],
      [unavailableMessage(DOWNLOAD_SCREEN_LABEL)],
    ]);
  });

  it('refuses without a focused screen', () => {
    const ctx = makeCtx({ screenVerbs: null });
    dispatchHeaderAction('screen:print', undefined, ctx);
    expect(ctx.toast).toHaveBeenCalledWith(NO_SCREEN);
  });
});

describe('menu:zoom-*', () => {
  it.each([
    [MENU_ZOOM_IN, 'zoomIn', ZOOMED_IN],
    [MENU_ZOOM_OUT, 'zoomOut', ZOOMED_OUT],
    [MENU_ZOOM_FIT, 'fit', ZOOMED_FIT],
    [MENU_ZOOM_100, 'actual', ZOOMED_100],
  ] as const)('%s calls %s and toasts', (entry, method, message) => {
    const ctx = makeCtx();
    dispatchHeaderAction(MORE_ID, entry, ctx);
    expect(ctx.zoom[method]).toHaveBeenCalledOnce();
    expect(ctx.toast).toHaveBeenCalledWith(message);
  });

  it('refuses without zoom controls', () => {
    const ctx = makeCtx({ zoom: null });
    dispatchHeaderAction(MORE_ID, MENU_ZOOM_IN, ctx);
    expect(ctx.toast).toHaveBeenCalledWith(ZOOM_UNAVAILABLE);
  });
});

describe('workspace ⋯ entries', () => {
  it('reset-layout runs the handler, which offers its own undo toast', () => {
    const ctx = makeCtx();
    dispatchHeaderAction(MORE_ID, MENU_RESET_LAYOUT, ctx);
    expect(ctx.resetLayout).toHaveBeenCalledOnce();
    expect(ctx.toast).not.toHaveBeenCalled();
  });

  it('reset-layout refuses when disabled', () => {
    const ctx = makeCtx({ resetLayout: undefined });
    dispatchHeaderAction(MORE_ID, MENU_RESET_LAYOUT, ctx);
    expect(ctx.toast).toHaveBeenCalledWith(RESET_LAYOUT_UNAVAILABLE);
  });

  it('save-collection focuses and opens the dialog', () => {
    const ctx = makeCtx();
    dispatchHeaderAction(MORE_ID, MENU_SAVE_COLLECTION, ctx);
    expect(ctx.focusViewer).toHaveBeenCalledOnce();
    expect(ctx.openSaveCollection).toHaveBeenCalledOnce();
    expect(ctx.toast).not.toHaveBeenCalled();
  });

  it('save-collection refuses when collections are off', () => {
    const ctx = makeCtx({ openSaveCollection: undefined });
    dispatchHeaderAction(MORE_ID, MENU_SAVE_COLLECTION, ctx);
    expect(ctx.toast).toHaveBeenCalledWith(SAVE_COLLECTION_UNAVAILABLE);
  });

  it('show-sub-screens toggles the store and toasts the new state', () => {
    const ctx = makeCtx();
    dispatchHeaderAction(MORE_ID, MENU_SHOW_SUB_SCREENS, ctx);
    dispatchHeaderAction(MORE_ID, MENU_SHOW_SUB_SCREENS, ctx);
    expect(ctx.setShowSubScreens.mock.calls).toEqual([[true], [false]]);
    expect(ctx.toast.mock.calls).toEqual([[SUB_SCREENS_SHOWN], [SUB_SCREENS_HIDDEN]]);
  });

  it('collections opens the popover; refuses when not mounted', () => {
    const ok = makeCtx();
    dispatchHeaderAction(MORE_ID, MENU_COLLECTIONS, ok);
    expect(ok.openCollections).toHaveBeenCalledOnce();
    expect(ok.toast).not.toHaveBeenCalled();

    const none = makeCtx({ openCollections: vi.fn(() => false) });
    dispatchHeaderAction(MORE_ID, MENU_COLLECTIONS, none);
    expect(none.toast).toHaveBeenCalledWith(COLLECTIONS_UNAVAILABLE);
  });
});

describe('tool:<id>', () => {
  it('invokes an enabled entry and toasts a past-tense label', () => {
    const ctx = makeCtx();
    dispatchHeaderAction(MORE_ID, 'tool:import', ctx);
    dispatchHeaderAction(MORE_ID, 'tool:clear', ctx);
    expect(ctx.tool.invoke.mock.calls).toEqual([['import'], ['clear']]);
    expect(ctx.toast.mock.calls).toEqual([
      [toolDoneMessage('Import…', 'button')],
      [toolDoneMessage('Clear', 'button')],
    ]);
  });

  it('toasts a toggle by its new state', () => {
    const ctx = makeCtx();
    dispatchHeaderAction(MORE_ID, 'tool:live', ctx);
    expect(ctx.toast).toHaveBeenCalledWith('Live off');
  });

  it('a disabled entry toasts the reported reason and never reaches the tool', () => {
    const ctx = makeCtx();
    dispatchHeaderAction(MORE_ID, 'tool:export-csv', ctx);
    expect(ctx.tool.invoke).not.toHaveBeenCalled();
    expect(ctx.toast).toHaveBeenCalledWith('No curves to export');
  });

  it('an id absent from the report is never invoked', () => {
    const ctx = makeCtx();
    dispatchHeaderAction(MORE_ID, 'tool:nope', ctx);
    const noReport = makeCtx({ tool: { report: null, invoke: vi.fn(() => true) } });
    dispatchHeaderAction(MORE_ID, 'tool:import', noReport);
    expect(ctx.tool.invoke).not.toHaveBeenCalled();
    expect(noReport.tool!.invoke).not.toHaveBeenCalled();
  });

  it('toasts when the tab has no frame', () => {
    const ctx = makeCtx({ tool: { report: REPORT, invoke: vi.fn(() => false) } });
    dispatchHeaderAction(MORE_ID, 'tool:import', ctx);
    expect(ctx.toast).toHaveBeenCalledWith(unavailableMessage('Import…'));
  });

  it('refuses without a focused tool', () => {
    const ctx = makeCtx({ tool: null });
    dispatchHeaderAction(MORE_ID, 'tool:import', ctx);
    expect(ctx.toast).toHaveBeenCalledWith(NO_TOOL);
  });
});
