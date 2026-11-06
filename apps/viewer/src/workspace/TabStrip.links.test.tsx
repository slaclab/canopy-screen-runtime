// A tool's own reported links (its canopy:tool-actions report), "Docs" and
// "Report a bug", open the focused tool's URLs in a new browser tab from the
// ☰ window menu: a tab's context menu is Chrome's per-tab close set only, for
// every tab, host-embedded or not, and "Reset layout" and "Save open tabs as
// collection…" are window menu entries too. The ☰
// offers each link the focused tool's report carries, and none for a tool
// that reported no link or no report at all.

import '../test/memoryStorage.js';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CLOSE_OTHERS, CLOSE_TAB, CLOSE_TO_RIGHT, TabStrip } from './TabStrip.js';
import type { TabStripTab } from './TabStrip.js';
import {
  REPORT_BUG,
  RESET_LAYOUT,
  SAVE_AS_COLLECTION,
  TOOL_DOCS,
  WINDOW_MENU,
  WindowMenu,
} from './dock/WindowMenu.js';
import { createToolActionsStore, parseToolActions } from './toolActionsStore.js';
import type { ToolActionsStore } from './toolActionsStore.js';

const TABS: TabStripTab[] = [
  { key: 'ops/main', title: 'Main' },
  { key: '@trace', title: 'Trace' },
  { key: '@correlation', title: 'Correlation' },
  { key: '@waveform', title: 'Waveform' },
  { key: '@trace/2', title: 'Trace 2' },
];

const DOCS = 'https://docs.example.org/trace/';
const BUG = 'https://github.com/example/react-trace/issues/new';

const originalScroll = Element.prototype.scrollIntoView;
let openSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn() as unknown as Element['scrollIntoView'];
  openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
});

afterEach(() => {
  cleanup();
  Element.prototype.scrollIntoView = originalScroll;
  openSpy.mockRestore();
});

function report(links: Record<string, unknown>) {
  const parsed = parseToolActions({
    type: 'canopy:tool-actions',
    version: 1,
    actions: [],
    links,
  });
  if (!parsed) throw new Error('fixture is not a tool-actions report');
  return parsed;
}

function storeWith(entries: Record<string, Record<string, unknown>>): ToolActionsStore {
  const store = createToolActionsStore();
  for (const [key, links] of Object.entries(entries)) store.set(key, report(links));
  return store;
}

function renderStrip() {
  render(
    <TabStrip
      tabs={TABS}
      activeKey="ops/main"
      onFocus={vi.fn()}
      onClose={vi.fn()}
      onCloseOthers={vi.fn()}
      onCloseToRight={vi.fn()}
    />
  );
}

/** The ☰ as the page mounts it, with the links of `key`'s report in `store`. */
function WindowMenuOf({ store, focused }: { store: ToolActionsStore; focused: string }) {
  const [open, setOpen] = useState(false);
  return (
    <WindowMenu
      open={open}
      onOpenChange={setOpen}
      tabCount={TABS.length}
      onReset={vi.fn()}
      onSaveAsCollection={vi.fn()}
      toolLinks={store.get(focused)?.links}
    />
  );
}

async function openWindowMenu(store: ToolActionsStore, focused: string): Promise<string[]> {
  render(<WindowMenuOf store={store} focused={focused} />);
  fireEvent.click(screen.getByRole('button', { name: WINDOW_MENU }));
  await screen.findAllByRole('menuitem');
  return screen.getAllByRole('menuitem').map((m) => m.getAttribute('title') ?? m.textContent ?? '');
}

function openMenu(key: string) {
  const tab = screen.getAllByRole('tab').find((t) => t.getAttribute('data-tab-key') === key)!;
  fireEvent.contextMenu(tab, { clientX: 10, clientY: 20 });
}

function labels(): string[] {
  return screen.getAllByRole('menuitem').map((m) => m.textContent ?? '');
}

describe('tool links in the window menu', () => {
  it.each([
    ['@trace', 'Trace'],
    ['@correlation', 'Correlation'],
    ['@waveform', 'Waveform'],
  ])('offers Docs and Report a bug for %s when its report carries both', async (key) => {
    const items = await openWindowMenu(storeWith({ [key]: { docs: DOCS, bug: BUG } }), key);
    expect(items).toContain(TOOL_DOCS);
    expect(items).toContain(REPORT_BUG);
  });

  it('opens the focused tool’s own docs URL in a new tab', async () => {
    await openWindowMenu(storeWith({ '@trace': { docs: DOCS, bug: BUG } }), '@trace');
    fireEvent.click(screen.getByRole('menuitem', { name: TOOL_DOCS }));
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(openSpy).toHaveBeenCalledWith(DOCS, '_blank', 'noopener,noreferrer');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('opens the focused tool’s own bug URL in a new tab', async () => {
    await openWindowMenu(storeWith({ '@waveform': { docs: DOCS, bug: BUG } }), '@waveform');
    fireEvent.click(screen.getByRole('menuitem', { name: REPORT_BUG }));
    expect(openSpy).toHaveBeenCalledWith(BUG, '_blank', 'noopener,noreferrer');
  });

  it('uses the links of the focused instance, not of another instance', async () => {
    const other = 'https://docs.example.org/other/';
    await openWindowMenu(
      storeWith({ '@trace': { docs: DOCS }, '@trace/2': { docs: other } }),
      '@trace/2'
    );
    fireEvent.click(screen.getByRole('menuitem', { name: TOOL_DOCS }));
    expect(openSpy).toHaveBeenCalledWith(other, '_blank', 'noopener,noreferrer');
  });

  it('offers only the link the report carries', async () => {
    const items = await openWindowMenu(storeWith({ '@correlation': { bug: BUG } }), '@correlation');
    expect(items).toContain(REPORT_BUG);
    expect(items).not.toContain(TOOL_DOCS);
  });

  it('offers neither entry when the report has no links', async () => {
    const items = await openWindowMenu(storeWith({ '@trace': {} }), '@trace');
    expect(items).not.toContain(TOOL_DOCS);
    expect(items).not.toContain(REPORT_BUG);
  });

  it('offers neither entry before the tool reported anything', async () => {
    const items = await openWindowMenu(storeWith({}), '@trace');
    expect(items).not.toContain(TOOL_DOCS);
    expect(items).not.toContain(REPORT_BUG);
  });

  it('drops a non-http link the way the tool-actions parser does', async () => {
    const items = await openWindowMenu(
      storeWith({ '@trace': { docs: 'javascript:alert(1)' } }),
      '@trace'
    );
    expect(items).not.toContain(TOOL_DOCS);
  });

  it('keeps Reset layout and Save as collection beside the links', async () => {
    const items = await openWindowMenu(storeWith({ '@trace': { docs: DOCS, bug: BUG } }), '@trace');
    expect(items).toEqual([RESET_LAYOUT, SAVE_AS_COLLECTION, TOOL_DOCS, REPORT_BUG]);
  });
});

describe('the tab strip context menu', () => {
  const CLOSE_SET = [CLOSE_TAB, CLOSE_OTHERS, CLOSE_TO_RIGHT];

  it.each(TABS.map((t) => [t.key]))(
    'is the per-tab close set on %s, with no link, reset or save entry',
    (key) => {
      renderStrip();
      openMenu(key);
      expect(labels()).toEqual(CLOSE_SET);
    }
  );

  it('offers no link even when a tool reported both', () => {
    storeWith({ '@trace': { docs: DOCS, bug: BUG } });
    renderStrip();
    openMenu('@trace');
    expect(labels()).not.toContain(TOOL_DOCS);
    expect(labels()).not.toContain(REPORT_BUG);
    expect(openSpy).not.toHaveBeenCalled();
  });
});
