// CollectionsPopover: the trigger's ARIA, the Facility / Personal groups, the
// tick/untick binding, Open all, the save footer, and the close/focus rules
// (Esc, outside click, Open all) of the popover contract. Also the row text
// ("<name> · N · <when>", so same-name collections differ), the badge, the
// description clamp and "Open all (N)" / "(k of N)", the row
// menu's Rename / Delete, and Carbon's fixed floating styles without
// autoAlign's flip, with a viewport-capped width, so a narrow sidebar never
// hides the row or Open all. And the controlled open:
// openCollections() / closeCollections(), the collapsed-sidebar expand, and
// the open / onOpenChange props. A refused collection (a layout the viewer refuses) shows its
// reason, cannot be opened and offers only Delete in its menu.

import { readFileSync } from 'node:fs';
import { flushSync } from 'react-dom';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import {
  CollectionsPopover,
  SAVE_LABEL,
  closeCollections,
  openCollections,
  registerCollectionsSidebar,
  useCollectionsOpen,
  openAllLabel,
  openAllText,
  refusedText,
  rowActionsLabel,
} from './CollectionsPopover.js';
import { DELETE_LABEL, RENAME_LABEL, refusedLabel } from './CollectionMenu.js';
import { collectionSuffix } from './collections.js';
import type { CollectionsPopoverProps } from './CollectionsPopover.js';
import type { Collection } from './useCollections.js';

function collection(source: Collection['source'], id: string, name: string): Collection {
  return {
    source,
    ref: `${source}:${id}`,
    id,
    name,
    members: [{ screen: 'examples/vacuum' }],
    layout: null,
    default: source === 'facility',
  };
}

function personal(id: string, name: string, extra: Partial<Collection> = {}): Collection {
  const base = collection('personal', id, name);
  return { ...base, raw: { id, name, members: base.members }, rev: '"r1"', ...extra };
}

const INJECTOR = collection('facility', 'injector', 'Injector');
const RING = collection('facility', 'ring', 'Storage ring');
const MINE = collection('personal', 'mine', 'My shift');

function makeApi(overrides: Partial<CollectionsPopoverProps['api']> = {}) {
  return {
    enabled: true,
    collections: [INJECTOR, RING, MINE],
    shown: [INJECTOR],
    tick: vi.fn(() => Promise.resolve()),
    untick: vi.fn(() => Promise.resolve()),
    openAll: vi.fn(),
    ...overrides,
  };
}

function setup(overrides: Partial<CollectionsPopoverProps['api']> = {}) {
  const api = makeApi(overrides);
  const onSave = vi.fn();
  const utils = render(
    <div>
      <button type="button">elsewhere</button>
      <div data-testid="outside">outside</div>
      <CollectionsPopover api={api} onSave={onSave} />
    </div>
  );
  const trigger = screen.getByRole('button', { name: 'Collections' });
  return { api, onSave, trigger, ...utils };
}

function openPopover(trigger: HTMLElement) {
  fireEvent.click(trigger);
  expect(trigger.getAttribute('aria-expanded')).toBe('true');
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('CollectionsPopover', () => {
  it('renders nothing when the feature is off', () => {
    const { container } = render(
      <CollectionsPopover api={makeApi({ enabled: false })} onSave={vi.fn()} />
    );
    expect(container.innerHTML).toBe('');
  });

  it('starts closed, with a trigger whose aria-controls names the content', () => {
    const { trigger } = setup();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    const controls = trigger.getAttribute('aria-controls');
    expect(controls).toBeTruthy();
    expect(document.getElementById(controls!)).not.toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('starts closed again on every mount (open state is never persisted)', () => {
    const first = setup();
    openPopover(first.trigger);
    first.unmount();
    const { trigger } = setup();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('groups collections under Facility and Personal, checked by the shown selection', () => {
    const { trigger } = setup();
    openPopover(trigger);
    const facility = screen.getByRole('group', { name: 'Facility' });
    const personal = screen.getByRole('group', { name: 'Personal' });
    const facilityBoxes = within(facility).getAllByRole('checkbox') as HTMLInputElement[];
    expect(facilityBoxes.map((b) => b.labels?.[0]?.textContent)).toEqual([
      'Injector',
      'Storage ring',
    ]);
    expect(facilityBoxes.map((b) => b.checked)).toEqual([true, false]);
    const personalBox = within(personal).getByRole('checkbox', { name: 'My shift' });
    expect((personalBox as HTMLInputElement).checked).toBe(false);
  });

  it('omits an empty group', () => {
    const { trigger } = setup({ collections: [INJECTOR], shown: [] });
    openPopover(trigger);
    expect(screen.getByRole('group', { name: 'Facility' })).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Personal' })).toBeNull();
  });

  it('has no filter box and no chips', () => {
    const { trigger } = setup();
    openPopover(trigger);
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('ticks an unchecked collection and unticks a checked one', () => {
    const { api, trigger } = setup();
    openPopover(trigger);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Storage ring' }));
    expect(api.tick).toHaveBeenCalledWith('facility:ring');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Injector' }));
    expect(api.untick).toHaveBeenCalledWith('facility:injector');
  });

  it('names each Open all button after its collection and orders checkbox before it', () => {
    const { trigger } = setup();
    openPopover(trigger);
    const box = screen.getByRole('checkbox', { name: 'Storage ring' });
    const button = screen.getByRole('button', { name: openAllLabel(RING) });
    expect(openAllLabel(RING)).toBe('Open all Storage ring');
    // Tab order follows the DOM: checkbox, then Open all, then the next row.
    expect(box.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const next = screen.getByRole('checkbox', { name: 'My shift' });
    expect(button.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Nothing in a row takes the controls out of the tab sequence.
    expect(box.getAttribute('tabindex')).not.toBe('-1');
    expect(button.getAttribute('tabindex')).not.toBe('-1');
  });

  it('moves focus into the list when it opens', () => {
    const { trigger } = setup();
    openPopover(trigger);
    expect(document.activeElement).toBe(screen.getByRole('checkbox', { name: 'Injector' }));
  });

  it('Open all opens the collection, closes the popover and returns focus', () => {
    const { api, trigger } = setup();
    openPopover(trigger);
    fireEvent.click(screen.getByRole('button', { name: 'Open all My shift' }));
    expect(api.openAll).toHaveBeenCalledWith(MINE);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('Esc closes the popover and returns focus to the trigger', () => {
    const { trigger } = setup();
    openPopover(trigger);
    const box = screen.getByRole('checkbox', { name: 'Storage ring' });
    box.focus();
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
  });

  it('an outside click closes the popover and returns focus to the trigger', () => {
    vi.useFakeTimers();
    const { trigger } = setup();
    openPopover(trigger);
    const outside = screen.getByTestId('outside');
    act(() => {
      (document.activeElement as HTMLElement | null)?.blur();
      fireEvent.mouseDown(outside);
      fireEvent.click(outside);
    });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    act(() => {
      vi.runAllTimers();
    });
    expect(document.activeElement).toBe(trigger);
  });

  it('leaves focus on another control that took it', () => {
    vi.useFakeTimers();
    const { trigger } = setup();
    openPopover(trigger);
    const elsewhere = screen.getByRole('button', { name: 'elsewhere' });
    act(() => {
      elsewhere.focus();
      fireEvent.click(elsewhere);
    });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    act(() => {
      vi.runAllTimers();
    });
    expect(document.activeElement).toBe(elsewhere);
  });

  it('the trigger toggles the popover', () => {
    const { trigger } = setup();
    openPopover(trigger);
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('the footer asks for the save dialog and closes the popover', () => {
    const { onSave, trigger } = setup();
    openPopover(trigger);
    fireEvent.click(screen.getByRole('button', { name: SAVE_LABEL }));
    expect(SAVE_LABEL).toBe('Save open tabs as collection…');
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('shows the save footer even without collections', () => {
    const { trigger } = setup({ collections: [], shown: [] });
    openPopover(trigger);
    expect(screen.getByText('No collections.')).toBeTruthy();
    expect(screen.getByRole('button', { name: SAVE_LABEL })).toBeTruthy();
  });
});

describe('CollectionsPopover.css', () => {
  // Read from disk: vitest blanks `.css` imports.
  const css = readFileSync(
    createRequire(import.meta.url).resolve('./CollectionsPopover.css'),
    'utf8'
  ).replace(/\/\*[\s\S]*?\*\//g, '');

  it('takes every font-size from the --canopy-text-* tokens', () => {
    const sizes = [...css.matchAll(/font-size\s*:([^;}]*)/g)].map((m) => m[1].trim());
    expect(sizes.length).toBeGreaterThan(0);
    for (const size of sizes) expect(size).toMatch(/^var\(--canopy-text-(md|sm)\)$/);
  });

  it('carries no hex colour literal', () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it('sizes rows from --canopy-control-h-xs', () => {
    expect(css).toMatch(/\.collections-popover__row\s*{[^}]*var\(--canopy-control-h-xs\)/);
  });
});

describe('CollectionsPopover rows', () => {
  const NOW = new Date();
  const earlier = new Date(NOW.getTime() - 3 * 24 * 3600 * 1000).toISOString();

  it('gives two same-name collections different suffixes', () => {
    const a = personal('shift', 'Shift', { updated: NOW.toISOString() });
    const b = personal('shift-2', 'Shift', {
      updated: earlier,
      members: [{ screen: 'examples/vacuum' }, { screen: 'examples/rf' }],
    });
    const { trigger } = setup({ collections: [a, b], shown: [] });
    openPopover(trigger);
    const rows = [...document.querySelectorAll<HTMLElement>('.collections-popover__row')];
    expect(rows).toHaveLength(2);
    const suffixes = rows.map(
      (row) => row.querySelector('.collections-popover__suffix')?.textContent ?? ''
    );
    expect(suffixes[0]).toBe(`\u00b7 ${collectionSuffix(a)}`);
    expect(suffixes[1]).toBe(`\u00b7 ${collectionSuffix(b)}`);
    expect(suffixes[0]).not.toBe(suffixes[1]);
    expect(suffixes[0]).toMatch(/^\u00b7 1 \u00b7 Today /);
    // The full "<name> · N · <when>" is the row's tooltip.
    expect(rows[1].querySelector('.collections-popover__label')?.getAttribute('title')).toBe(
      `Shift \u00b7 ${collectionSuffix(b)}`
    );
    // The checkbox keeps the plain name as its accessible name.
    expect(within(rows[0]).getByRole('checkbox', { name: 'Shift' })).toBeTruthy();
  });

  it('clamps the description to two lines with the full text in title', () => {
    const text = 'Every vacuum gauge in the arc, '.repeat(8).trim();
    const { trigger } = setup({
      collections: [{ ...INJECTOR, description: text }, RING],
      shown: [],
    });
    openPopover(trigger);
    const desc = document.querySelectorAll<HTMLElement>('.collections-popover__description');
    expect(desc).toHaveLength(1);
    expect(desc[0].classList.contains('collections-popover__description--clamp')).toBe(true);
    expect(desc[0].getAttribute('title')).toBe(text);
    expect(desc[0].textContent).toBe(text);
  });

  it('shows "Open all (N)", or "(k of N)" when some members cannot open here', () => {
    const three = {
      ...RING,
      members: [{ screen: 'a/b' }, { screen: 'a/c' }, { screen: 'a/d' }],
    };
    const openAllCount = vi.fn((c: Collection) =>
      c.ref === RING.ref ? { opened: 2, total: 3 } : { opened: 1, total: 1 }
    );
    const { trigger } = setup({ collections: [INJECTOR, three], shown: [], openAllCount });
    openPopover(trigger);
    expect(screen.getByRole('button', { name: openAllLabel(INJECTOR) }).textContent).toBe(
      'Open all (1)'
    );
    expect(screen.getByRole('button', { name: openAllLabel(RING) }).textContent).toBe(
      'Open all (2 of 3)'
    );
    expect(openAllText({ opened: 0, total: 0 }, 0)).toBe('Open all (0)');
  });

  it('counts every member while the plan is not known yet', () => {
    const { trigger } = setup({ openAllCount: () => null });
    openPopover(trigger);
    expect(screen.getByRole('button', { name: openAllLabel(MINE) }).textContent).toBe(
      'Open all (1)'
    );
    // Without openAllCount at all, the same.
    cleanup();
    const again = setup();
    openPopover(again.trigger);
    expect(screen.getByRole('button', { name: openAllLabel(INJECTOR) }).textContent).toBe(
      'Open all (1)'
    );
  });

  it('a personal and a facility row differ by badge', () => {
    const { trigger } = setup();
    openPopover(trigger);
    const facilityRow = document.querySelector('[data-collection-ref="facility:injector"]')!;
    const personalRow = document.querySelector('[data-collection-ref="personal:mine"]')!;
    const fb = facilityRow.querySelector('.collection-badge');
    const pb = personalRow.querySelector('.collection-badge');
    expect(fb?.getAttribute('data-source')).toBe('facility');
    expect(pb?.getAttribute('data-source')).toBe('personal');
    expect(fb?.getAttribute('title')).not.toBe(pb?.getAttribute('title'));
  });
});

describe('CollectionsPopover row menu', () => {
  function editApi() {
    const undo = vi.fn(() => Promise.resolve({ ok: true as const }));
    return {
      edit: vi.fn(() => Promise.resolve({ ok: true as const, collection: null, undo })),
      deleteCollection: vi.fn(() => Promise.resolve({ ok: true as const, missing: false, undo })),
      holdCollection: vi.fn(),
    };
  }

  it('offers the menu on an editable personal row only', () => {
    const shift = personal('shift', 'Shift');
    const { trigger } = setup({ collections: [INJECTOR, shift], shown: [], ...editApi() });
    openPopover(trigger);
    expect(screen.getByRole('button', { name: rowActionsLabel(shift) })).toBeTruthy();
    expect(screen.queryByRole('button', { name: rowActionsLabel(INJECTOR) })).toBeNull();
  });

  it('offers no menu without the edit gestures', () => {
    const shift = personal('shift', 'Shift');
    const { trigger } = setup({ collections: [shift], shown: [] });
    openPopover(trigger);
    expect(screen.queryByRole('button', { name: rowActionsLabel(shift) })).toBeNull();
  });

  it('Rename opens the inline field, holds the collection and commits one edit', async () => {
    const shift = personal('shift', 'Shift');
    const gestures = editApi();
    const { trigger } = setup({ collections: [shift], shown: [], ...gestures });
    openPopover(trigger);
    fireEvent.click(screen.getByRole('button', { name: rowActionsLabel(shift) }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    // By label, not role: the field sits in Carbon's floating content, whose
    // inline styles jsdom cannot lay out.
    const field = screen.getByLabelText('Rename “Shift”');
    expect(gestures.holdCollection).toHaveBeenCalledWith('personal:shift');
    // The popover stays open while the field is in it.
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    fireEvent.change(field, { target: { value: 'Night shift' } });
    await act(async () => {
      fireEvent.keyDown(field, { key: 'Enter' });
      await Promise.resolve();
    });
    expect(gestures.holdCollection).toHaveBeenLastCalledWith(null);
    expect(gestures.edit).toHaveBeenCalledTimes(1);
    const change = (gestures.edit.mock.calls[0] as unknown[])[1] as (
      raw: Record<string, unknown>
    ) => Record<string, unknown>;
    expect(change({ id: 'shift', name: 'Shift', members: [] }).name).toBe('Night shift');
    expect(document.querySelector('.collection-rename')).toBeNull();
  });

  it('Esc in the rename field cancels without closing the popover', async () => {
    const shift = personal('shift', 'Shift');
    const gestures = editApi();
    const { trigger } = setup({ collections: [shift], shown: [], ...gestures });
    openPopover(trigger);
    fireEvent.click(screen.getByRole('button', { name: rowActionsLabel(shift) }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    // By label, not role: the field sits in Carbon's floating content, whose
    // inline styles jsdom cannot lay out.
    const field = screen.getByLabelText('Rename “Shift”');
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(gestures.edit).not.toHaveBeenCalled();
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelector('.collection-rename')).toBeNull();
  });

  // In a browser a click runs a microtask checkpoint after each
  // listener, so React has already unmounted the clicked menu item when
  // Carbon's window click listener asks whether the click was inside the
  // popover. The document listener below flushes React at that point, as the
  // browser does; a keyboard Enter never reaches that window listener.
  it('Rename by mouse opens the focused field and keeps the popover open', async () => {
    const shift = personal('shift', 'Shift');
    const gestures = editApi();
    const { trigger } = setup({ collections: [shift], shown: [], ...gestures });
    openPopover(trigger);
    fireEvent.click(screen.getByRole('button', { name: rowActionsLabel(shift) }));
    const item = await screen.findByRole('menuitem', { name: 'Rename' });
    const checkpoint = () => flushSync(() => {});
    document.addEventListener('click', checkpoint);
    try {
      act(() => {
        fireEvent.mouseDown(item);
        item.focus();
        fireEvent.mouseUp(item);
        fireEvent.click(item);
      });
    } finally {
      document.removeEventListener('click', checkpoint);
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const field = screen.getByLabelText('Rename “Shift”');
    expect(document.activeElement).toBe(field);
    expect(gestures.holdCollection).toHaveBeenLastCalledWith('personal:shift');
  });

  it('closing the popover mid-rename releases the hold', async () => {
    const shift = personal('shift', 'Shift');
    const gestures = editApi();
    const { trigger } = setup({ collections: [shift], shown: [], ...gestures });
    openPopover(trigger);
    fireEvent.click(screen.getByRole('button', { name: rowActionsLabel(shift) }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }));
    expect(gestures.holdCollection).toHaveBeenLastCalledWith('personal:shift');
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(gestures.holdCollection).toHaveBeenLastCalledWith(null);
    expect(gestures.edit).not.toHaveBeenCalled();
  });

  it('Delete deletes the collection at once', async () => {
    const shift = personal('shift', 'Shift');
    const gestures = editApi();
    const { trigger } = setup({ collections: [shift], shown: [], ...gestures });
    openPopover(trigger);
    fireEvent.click(screen.getByRole('button', { name: rowActionsLabel(shift) }));
    await act(async () => {
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
      await Promise.resolve();
    });
    expect(gestures.deleteCollection).toHaveBeenCalledWith(shift);
  });
});

describe('CollectionsPopover refused collections', () => {
  const REASON = 'layout: member_missing: every member is placed in a tile';

  function editApi() {
    const undo = vi.fn(() => Promise.resolve({ ok: true as const }));
    return {
      edit: vi.fn(() => Promise.resolve({ ok: true as const, collection: null, undo })),
      deleteCollection: vi.fn(() => Promise.resolve({ ok: true as const, missing: false, undo })),
      holdCollection: vi.fn(),
    };
  }

  it('shows the reason in the row and cannot be opened', () => {
    const old = personal('part-grid', 'Partial ring grid', { refused: REASON });
    const { trigger, api } = setup({ collections: [INJECTOR, old], shown: [] });
    openPopover(trigger);
    const row = document.querySelector('[data-collection-ref="personal:part-grid"]')!;
    expect(within(row as HTMLElement).getByTestId('collection-refused').textContent).toBe(
      refusedText(REASON)
    );
    const open = screen.getByRole('button', { name: openAllLabel(old) }) as HTMLButtonElement;
    expect(open.disabled).toBe(true);
    expect(open.title).toBe(refusedText(REASON));
    fireEvent.click(open);
    expect(api.openAll).not.toHaveBeenCalled();
    // A collection that opens shows no reason.
    expect(screen.getAllByTestId('collection-refused')).toHaveLength(1);
  });

  it('names the reason in its menu and offers Delete, never Rename', async () => {
    const old = personal('part-grid', 'Partial ring grid', { refused: REASON });
    const gestures = editApi();
    const { trigger } = setup({ collections: [old], shown: [], ...gestures });
    openPopover(trigger);
    fireEvent.click(screen.getByRole('button', { name: rowActionsLabel(old) }));
    const reason = await screen.findByRole('menuitem', { name: refusedLabel(REASON) });
    expect(reason.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByRole('menuitem', { name: DELETE_LABEL })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: RENAME_LABEL })).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole('menuitem', { name: DELETE_LABEL }));
      await Promise.resolve();
    });
    expect(gestures.deleteCollection).toHaveBeenCalledTimes(1);
  });
});

describe('CollectionsPopover placement', () => {
  it('uses Carbon fixed floating styles (no portal)', () => {
    const { trigger } = setup();
    openPopover(trigger);
    const root = screen.getByTestId('collections-popover');
    expect(root.classList.contains('cds--popover--auto-align')).toBe(true);
    // The content stays inside the popover's own DOM.
    expect(root.contains(screen.getByRole('checkbox', { name: 'Injector' }))).toBe(true);
  });

  // In a 180 px sidebar, autoAlign's flip measures overflow against
  // the clipping `aside`, found that no placement fits it, and settled on the
  // centred `bottom`, so the content spanned x -145..221 on the deploy. The
  // geometry below is that repro (1200 x 840 viewport, 180 px aside, ~366 px
  // content). jsdom has no layout, so the rects and sizes are stubbed, and the
  // transformed pane stands in for the containing block that makes the aside a
  // clipping ancestor of the fixed content on the deployed page.
  it('keeps bottom-start and a left edge >= 0 in a 180 px sidebar', async () => {
    const rect = (x: number, y: number, width: number, height: number) =>
      ({
        x,
        y,
        left: x,
        top: y,
        width,
        height,
        right: x + width,
        bottom: y + height,
        toJSON() {},
      }) as DOMRect;
    const size = (el: Element, width: number, height: number) => {
      Object.defineProperty(el, 'clientWidth', { configurable: true, value: width });
      Object.defineProperty(el, 'clientHeight', { configurable: true, value: height });
      Object.defineProperty(el, 'offsetWidth', { configurable: true, value: width });
      Object.defineProperty(el, 'offsetHeight', { configurable: true, value: height });
    };
    const restore: (() => void)[] = [];
    const stub = (el: Element, r: DOMRect) => {
      const spy = vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(r);
      restore.push(() => spy.mockRestore());
    };
    const html = document.documentElement;
    size(html, 1200, 840);
    const inner = { w: window.innerWidth, h: window.innerHeight };
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 840 });
    try {
      render(
        <aside
          className="workspace__sidebar"
          style={{ display: 'block', overflow: 'hidden', width: '180px', height: '800px' }}
        >
          <div data-testid="pane" style={{ transform: 'translateZ(0)' }}>
            <CollectionsPopover api={makeApi()} onSave={vi.fn()} />
          </div>
        </aside>
      );
      const aside = document.querySelector('aside')!;
      size(aside, 180, 800);
      stub(aside, rect(0, 40, 180, 800));
      const pane = screen.getByTestId('pane');
      size(pane, 180, 800);
      stub(pane, rect(0, 40, 180, 800));
      const root = screen.getByTestId('collections-popover');
      stub(root, rect(8, 48, 60, 32));
      const trigger = screen.getByRole('button', { name: 'Collections' });
      stub(trigger, rect(8, 48, 60, 32));
      const content = root.querySelector('.cds--popover-content')!;
      size(content, 366, 320);
      stub(content, rect(0, 0, 366, 320));
      openPopover(trigger);
      await act(async () => {
        for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
      });
      const style = (content as HTMLElement).style;
      const shift = /translate\(\s*(-?[\d.]+)px/.exec(style.transform);
      const left = parseFloat(style.left || '0') + (shift ? parseFloat(shift[1]) : 0);
      expect(style.transform || style.left).toBeTruthy();
      expect(left).toBeGreaterThanOrEqual(0);
      expect(root.classList.contains('cds--popover--bottom-start')).toBe(true);
      expect(root.classList.contains('cds--popover--bottom')).toBe(false);
    } finally {
      restore.forEach((undo) => undo());
      delete (html as unknown as Record<string, unknown>).clientWidth;
      delete (html as unknown as Record<string, unknown>).clientHeight;
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: inner.w });
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: inner.h });
    }
  });
});

describe('CollectionsPopover.css', () => {
  const css = readFileSync(
    createRequire(import.meta.url).resolve('./CollectionsPopover.css'),
    'utf8'
  ).replace(/\/\*[\s\S]*?\*\//g, '');

  it('caps the width at the viewport and never scrolls sideways', () => {
    expect(css).toMatch(/max-inline-size:[^;]*calc\(100vw - 1rem\)/);
    expect(css).toMatch(/\.collections-popover__body\s*{[^}]*overflow-x:\s*hidden/);
  });

  it('clamps the description to two lines', () => {
    expect(css).toMatch(
      /\.collections-popover__description--clamp\s*{[^}]*-webkit-line-clamp:\s*2/
    );
  });

  it('ellipsises the name', () => {
    expect(css).toMatch(/\.collections-popover__name\s*{[^}]*text-overflow:\s*ellipsis/);
  });
});

describe('CollectionsPopover rows: same name, minute and count', () => {
  const AT = new Date(2026, 9, 17, 14, 2, 10).toISOString();
  const AT_LATER = new Date(2026, 9, 17, 14, 2, 30).toISOString();

  it('reads two colliding collections apart in suffix, title and button names', () => {
    const first = personal('rv-dup', 'rv-dup', { updated: AT });
    const second = personal('rv-dup-2', 'rv-dup', { updated: AT_LATER });
    const shown = [INJECTOR, first, second];
    const undo = vi.fn(() => Promise.resolve({ ok: true as const }));
    const { trigger } = setup({
      collections: shown,
      shown: [],
      edit: vi.fn(() => Promise.resolve({ ok: true as const, collection: null, undo })),
      deleteCollection: vi.fn(() => Promise.resolve({ ok: true as const, missing: false, undo })),
      holdCollection: vi.fn(),
    });
    openPopover(trigger);
    const row = (c: Collection) =>
      document.querySelector<HTMLElement>(`[data-collection-ref="${c.ref}"]`)!;
    const suffix = (c: Collection) =>
      row(c).querySelector('.collections-popover__suffix')?.textContent ?? '';
    const title = (c: Collection) =>
      row(c).querySelector('.collections-popover__label')?.getAttribute('title') ?? '';

    expect(suffix(first)).toMatch(/ · rv-dup$/);
    expect(suffix(second)).toMatch(/ · rv-dup-2$/);
    expect(suffix(first)).not.toBe(suffix(second));
    expect(title(first)).not.toBe(title(second));
    expect(title(second)).toMatch(/^rv-dup · 1 · .* · rv-dup-2$/);

    const openA = openAllLabel(first, shown);
    const openB = openAllLabel(second, shown);
    expect(openA).not.toBe(openB);
    expect(within(row(first)).getByRole('button', { name: openA })).toBeTruthy();
    expect(within(row(second)).getByRole('button', { name: openB })).toBeTruthy();
    const actA = rowActionsLabel(first, shown);
    const actB = rowActionsLabel(second, shown);
    expect(actA).not.toBe(actB);
    expect(within(row(first)).getByRole('button', { name: actA })).toBeTruthy();
    expect(within(row(second)).getByRole('button', { name: actB })).toBeTruthy();

    // A row that collides with nothing keeps its plain text and names.
    expect(suffix(INJECTOR)).toBe(`· ${collectionSuffix(INJECTOR)}`);
    expect(openAllLabel(INJECTOR, shown)).toBe('Open all Injector');
    expect(within(row(INJECTOR)).getByRole('button', { name: 'Open all Injector' })).toBeTruthy();
  });
});

// Controlled open: the host's ⋯ entry and the sidebar ⋯ entry open the
// same popover through openCollections(); a collapsed sidebar expands first,
// since a popover inside the 0 px aside is invisible.
describe('CollectionsPopover controlled open', () => {
  /** A stand-in for the sidebar: registers its collapse state and expand. */
  function FakeSidebar({ initial, children }: { initial: boolean; children: ReactNode }) {
    const [collapsed, setCollapsed] = useState(initial);
    useEffect(
      () =>
        registerCollectionsSidebar({
          collapsed: () => collapsed,
          expand: () => setCollapsed(false),
        }),
      [collapsed]
    );
    return (
      <aside data-testid="fake-aside" data-collapsed={collapsed ? '' : undefined}>
        {children}
      </aside>
    );
  }

  it('returns false when no popover is mounted', () => {
    expect(openCollections()).toBe(false);
  });

  it('returns false when the mounted popover is disabled', () => {
    render(<CollectionsPopover api={makeApi({ enabled: false })} onSave={vi.fn()} />);
    expect(openCollections()).toBe(false);
  });

  it('opening through the API renders the popover once', () => {
    const { trigger } = setup();
    let opened = false;
    act(() => {
      opened = openCollections();
    });
    expect(opened).toBe(true);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getAllByRole('group', { name: 'Collections' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: SAVE_LABEL })).toHaveLength(1);
    expect(screen.getAllByRole('checkbox')).toHaveLength(3);
    // A second call while open keeps the one popover open.
    act(() => {
      openCollections();
    });
    expect(screen.getAllByRole('button', { name: SAVE_LABEL })).toHaveLength(1);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
  });

  it('a collapsed sidebar expands first and the popover is visible', () => {
    render(
      <FakeSidebar initial={true}>
        <CollectionsPopover api={makeApi()} onSave={vi.fn()} />
      </FakeSidebar>
    );
    const aside = screen.getByTestId('fake-aside');
    expect(aside.hasAttribute('data-collapsed')).toBe(true);
    act(() => {
      openCollections();
    });
    expect(aside.hasAttribute('data-collapsed')).toBe(false);
    const trigger = screen.getByRole('button', { name: 'Collections' });
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('button', { name: SAVE_LABEL })).toBeTruthy();
  });

  it('an expanded sidebar is left alone', () => {
    const expand = vi.fn();
    const off = registerCollectionsSidebar({ collapsed: () => false, expand });
    setup();
    act(() => {
      openCollections();
    });
    expect(expand).not.toHaveBeenCalled();
    off();
  });

  it('unregistering the sidebar stops the expand', () => {
    const expand = vi.fn();
    const off = registerCollectionsSidebar({ collapsed: () => true, expand });
    off();
    setup();
    act(() => {
      openCollections();
    });
    expect(expand).not.toHaveBeenCalled();
  });

  it('closing resets: Esc, closeCollections and a later open start fresh', () => {
    const { trigger } = setup();
    act(() => {
      openCollections();
    });
    fireEvent.keyDown(screen.getByRole('button', { name: SAVE_LABEL }), { key: 'Escape' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    act(() => {
      openCollections();
    });
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    act(() => {
      closeCollections();
    });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('an unmount while open resets, so the next mount starts closed', () => {
    const first = setup();
    act(() => {
      openCollections();
    });
    first.unmount();
    const { trigger } = setup();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('useCollectionsOpen reflects the open state for another entry point', () => {
    function Entry() {
      const open = useCollectionsOpen();
      return <span data-testid="entry">{open ? 'open' : 'closed'}</span>;
    }
    const { trigger } = setup();
    render(<Entry />);
    expect(screen.getByTestId('entry').textContent).toBe('closed');
    fireEvent.click(trigger);
    expect(screen.getByTestId('entry').textContent).toBe('open');
    fireEvent.click(trigger);
    expect(screen.getByTestId('entry').textContent).toBe('closed');
  });

  it('a controlled popover follows its open prop and reports through onOpenChange', () => {
    const onOpenChange = vi.fn();
    function Host() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            host open
          </button>
          <CollectionsPopover
            api={makeApi()}
            onSave={vi.fn()}
            open={open}
            onOpenChange={(next) => {
              onOpenChange(next);
              setOpen(next);
            }}
          />
        </>
      );
    }
    render(<Host />);
    const trigger = screen.getByRole('button', { name: 'Collections' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'host open' }));
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getAllByRole('button', { name: SAVE_LABEL })).toHaveLength(1);
    fireEvent.click(trigger);
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(trigger);
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
  });

  it('a controlled popover ignores the store', () => {
    render(<CollectionsPopover api={makeApi()} onSave={vi.fn()} open={false} />);
    act(() => {
      openCollections();
    });
    const trigger = screen.getByRole('button', { name: 'Collections' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('the standalone trigger still notifies onOpenChange when uncontrolled', () => {
    const onOpenChange = vi.fn();
    render(<CollectionsPopover api={makeApi()} onSave={vi.fn()} onOpenChange={onOpenChange} />);
    const trigger = screen.getByRole('button', { name: 'Collections' });
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
  });
});
