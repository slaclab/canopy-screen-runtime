// The write gate as the operator sees it: real widgets under a real gate over
// a fake Hare backend. One dialog per click across widget kinds, decline,
// binding change, the summary toast, and the DOM contract the run drivers
// read (canopy-write-dialog / -confirm / -decline / -toast + data-outcome).
import '../test/memoryStorage.js';
import { useState } from 'react';
import type React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react';
import type {
  HareHeartbeatState,
  HareWrites,
  WriteOutcome,
  WriteOutcomeKind,
} from '@slaclab/canopy-client';

let pvState: Record<string, { connected: boolean; value: number | string }> = {};
const directPuts: Array<[string, unknown]> = [];

vi.mock('@slaclab/canopy-react', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  usePV: (address?: string) => ({
    address: address ?? '',
    connected: (address && pvState[address]?.connected) || false,
    value: address ? pvState[address]?.value : undefined,
    displayValue: address ? String(pvState[address]?.value ?? '') : '',
    severity: 0,
    precision: 0,
    put: (v: unknown) => {
      if (address) directPuts.push([address, v]);
    },
  }),
}));

const W = await import('@slaclab/canopy-screen-widgets');
const { createWriteGate } = await import('./gate.js');
const { ScreenWriteGateProvider } = await import('./WriteGateView.js');
const { armAgentGuard, GUARD_NOTICE } = await import('./guard.js');
type WriteBackend = import('./gate.js').WriteBackend;
type ScreenWriteGate = import('./gate.js').ScreenWriteGate;

function outcome(kind: WriteOutcomeKind, detail: string = kind, coalesced = false): WriteOutcome {
  return { outcome: kind, code: null, status: null, detail, coalesced };
}

let confirm = true;
let hb: HareHeartbeatState = { seen: true, binding: 'va@1' };
/** The socket's write statement; null is a legacy frame. */
let said: HareWrites | null = null;
let answers: WriteOutcome[] = [];
let sent: Array<[string, unknown]> = [];
let sentConfirmed: boolean[] = [];
const hbListeners = new Set<(s: HareHeartbeatState) => void>();

const backend: WriteBackend = {
  heartbeat: () => hb,
  linkUp: () => true,
  submit: async (pv, value, options) => {
    sent.push([pv, value]);
    sentConfirmed.push(options.confirmed === true);
    return answers.shift() ?? outcome('confirmed', 'written');
  },
  onHeartbeat: (l) => {
    hbListeners.add(l);
    return () => hbListeners.delete(l);
  },
  confirmWrites: () => confirm,
  machineLabel: () => 'VA simulator',
  writes: () => ({ writes: said, seen: said !== null }),
};

beforeEach(() => {
  // Carbon's modal observes its body; jsdom has no ResizeObserver.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  pvState = {};
  directPuts.length = 0;
  confirm = true;
  hb = { seen: true, binding: 'va@1' };
  said = null;
  answers = [];
  sent = [];
  sentConfirmed = [];
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const base = {
  id: 'w-1',
  layout: { x: 0, y: 0, width: 200, height: 32 },
  props: {},
  isSelected: false,
  isEditing: false,
};

let gate: ScreenWriteGate;

function renderWidget(C: unknown, props: Record<string, unknown>) {
  const Comp = C as React.FC<typeof base>;
  gate = createWriteGate(backend, { screen: 'sr/overview', rev: null });
  return render(
    <ScreenWriteGateProvider gate={gate}>
      <Comp {...base} props={props} />
    </ScreenWriteGateProvider>
  );
}

const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

const dialogs = () => document.querySelectorAll('[data-testid="canopy-write-dialog"]');
const toasts = () =>
  [...document.querySelectorAll('[data-testid="canopy-write-toast"]')].map((t) => [
    t.getAttribute('data-outcome'),
    t.textContent,
  ]);

async function answer(button: 'canopy-write-confirm' | 'canopy-write-decline') {
  fireEvent.click(screen.getByTestId(button));
  await flush();
}

/** One click (or keypress) of each widget kind that writes. */
const KINDS: Array<{
  name: string;
  render(): void;
  act(): void;
  writes: Array<[string, unknown]>;
}> = [
  {
    name: 'text input (Enter)',
    render: () => {
      pvState['SIM:SP'] = { connected: true, value: 1 };
      renderWidget(W.CarbonPVTextInput, { pvName: 'SIM:SP' });
    },
    act: () => {
      const input = document.querySelector('input') as HTMLInputElement;
      fireEvent.change(input, { target: { value: '2.5' } });
      fireEvent.keyDown(input, { key: 'Enter' });
    },
    writes: [['SIM:SP', 2.5]],
  },
  {
    name: 'push button',
    render: () => renderWidget(W.CarbonPVButton, { controlPV: 'SIM:CMD', pressValue: '2' }),
    act: () => fireEvent.click(document.querySelector('button') as HTMLButtonElement),
    writes: [['SIM:CMD', 2]],
  },
  {
    name: 'toggle',
    render: () => {
      pvState['SIM:EN'] = { connected: true, value: 0 };
      renderWidget(W.CarbonPVToggle, { pvName: 'SIM:EN' });
    },
    act: () => fireEvent.click(screen.getByRole('switch')),
    writes: [['SIM:EN', 1]],
  },
  {
    name: 'checkbox',
    render: () => {
      pvState['SIM:CB'] = { connected: true, value: 0 };
      renderWidget(W.CarbonPVCheckbox, { pvName: 'SIM:CB', label: 'cb' });
    },
    act: () => fireEvent.click(screen.getByRole('checkbox')),
    writes: [['SIM:CB', 1]],
  },
  {
    name: 'momentary button (pulse)',
    render: () =>
      renderWidget(W.CarbonPVButton, { controlPV: 'SIM:PULSE', pressValue: 1, releaseValue: 0 }),
    act: () => {
      const btn = document.querySelector('button') as HTMLButtonElement;
      const down = createEvent.pointerDown(btn);
      Object.defineProperty(down, 'button', { value: 0 });
      Object.defineProperty(down, 'pointerId', { value: 1 });
      fireEvent(btn, down);
    },
    writes: [
      ['SIM:PULSE', 1],
      ['SIM:PULSE', 0],
    ],
  },
];

describe('one dialog per click across widget kinds', () => {
  for (const kind of KINDS) {
    it(`${kind.name}: one dialog naming the PV and value, then the writes`, async () => {
      kind.render();
      kind.act();
      await flush();
      expect(dialogs()).toHaveLength(1);
      const dialog = dialogs()[0] as HTMLElement;
      for (const [pv, value] of kind.writes) {
        expect(dialog.textContent).toContain(pv);
        expect(dialog.textContent).toContain(String(value));
      }
      expect(dialog.textContent).toContain('VA simulator');
      expect(sent).toEqual([]);
      await answer('canopy-write-confirm');
      expect(dialogs()).toHaveLength(0);
      expect(sent).toEqual(kind.writes);
      expect(directPuts).toEqual([]);
      expect(toasts()).toEqual([['confirmed', 'written']]);
    });
  }
});

describe('the dialog', () => {
  // The dialog opens inside the event that asked for it (a text input's Enter
  // keydown). The browser then delivers that key's keypress to whatever holds
  // focus, and Enter on a focused button clicks it: with Carbon's default
  // initial focus (the close button) the dialog declined itself. Initial focus
  // must land on something no key activates.
  for (const kind of KINDS) {
    it(`${kind.name}: opens with focus on no button, so the opening key cannot answer it`, async () => {
      kind.render();
      kind.act();
      await flush();
      const dialog = dialogs()[0] as HTMLElement;
      const focused = document.activeElement as HTMLElement | null;
      expect(focused).not.toBeNull();
      expect(dialog.contains(focused)).toBe(true);
      expect(focused?.closest('button, a, input, select, textarea, [role="button"]')).toBeNull();
    });
  }

  // Carbon's sm size is what the host's control height applies to.
  it('draws both footer buttons at the sm size', async () => {
    KINDS[1].render();
    KINDS[1].act();
    await flush();
    for (const id of ['canopy-write-decline', 'canopy-write-confirm']) {
      expect(screen.getByTestId(id).classList.contains('cds--btn--sm')).toBe(true);
    }
  });

  it('decline sends nothing and shows no toast', async () => {
    KINDS[1].render();
    KINDS[1].act();
    await flush();
    await answer('canopy-write-decline');
    expect(dialogs()).toHaveLength(0);
    expect(sent).toEqual([]);
    expect(toasts()).toEqual([]);
  });

  it('closes on a binding change: nothing sent, "target changed" toasted', async () => {
    KINDS[1].render();
    KINDS[1].act();
    await flush();
    expect(dialogs()).toHaveLength(1);
    await act(async () => {
      hb = { seen: true, binding: 'va@2' };
      for (const l of [...hbListeners]) l(hb);
    });
    await flush();
    expect(dialogs()).toHaveLength(0);
    expect(sent).toEqual([]);
    expect(toasts()).toEqual([
      ['target_changed', 'the control target or its write state changed; nothing written'],
    ]);
  });

  it('stays one dialog while a second click waits its turn', async () => {
    KINDS[1].render();
    KINDS[1].act();
    KINDS[1].act();
    await flush();
    expect(dialogs()).toHaveLength(1);
    await answer('canopy-write-confirm');
    expect(dialogs()).toHaveLength(1);
    await answer('canopy-write-confirm');
    expect(sent).toEqual([
      ['SIM:CMD', 2],
      ['SIM:CMD', 2],
    ]);
  });

  it('shows no dialog with confirmWrites off', async () => {
    confirm = false;
    KINDS[1].render();
    KINDS[1].act();
    await flush();
    expect(dialogs()).toHaveLength(0);
    expect(sent).toEqual([['SIM:CMD', 2]]);
    expect(sentConfirmed).toEqual([false]);
    expect(toasts()).toEqual([['confirmed', 'written']]);
  });

  it('under asked: a dialog with confirmWrites off, and the confirmed writes say so', async () => {
    confirm = false;
    said = { state: 'asked', reason: null, cause: 'asked' };
    KINDS[4].render();
    KINDS[4].act();
    await flush();
    expect(dialogs()).toHaveLength(1);
    expect(sent).toEqual([]);
    await answer('canopy-write-confirm');
    expect(sent).toEqual(KINDS[4].writes);
    expect(sentConfirmed).toEqual([true, true]);
    expect(toasts()).toEqual([['confirmed', 'written']]);
  });

  it("under held: the widget is inert with the hold's reason; a click opens nothing", async () => {
    const reason = 'writes are held while a watchdog flag is open';
    said = { state: 'held', reason, cause: 'session_held' };
    KINDS[1].render();
    const button = document.querySelector('button') as HTMLButtonElement;
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.getAttribute('title')).toBe(reason);
    KINDS[1].act();
    await flush();
    expect(dialogs()).toHaveLength(0);
    expect(sent).toEqual([]);
  });

  it('drops a waiting click when the screen unmounts', async () => {
    KINDS[1].render();
    KINDS[1].act();
    await flush();
    cleanup();
    gate.dispose();
    await flush();
    expect(sent).toEqual([]);
  });

  it('shows the parsed value beside the text it was typed as', async () => {
    pvState['SIM:SP'] = { connected: true, value: 1 };
    renderWidget(W.CarbonPVTextInput, { pvName: 'SIM:SP' });
    const input = document.querySelector('input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '1e3' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await flush();
    expect(dialogs()).toHaveLength(1);
    expect(screen.getByTestId('canopy-write-dialog').textContent).toContain('1000 (entered "1e3")');
    await answer('canopy-write-confirm');
    expect(sent).toEqual([['SIM:SP', 1000]]);
  });

  it('shows only the value when it reads as it was typed', async () => {
    KINDS[0].render();
    KINDS[0].act();
    await flush();
    const cell = screen.getByTestId('canopy-write-dialog').textContent ?? '';
    expect(cell).toContain('2.5');
    expect(cell).not.toContain('entered');
  });

  it('opens no dialog for a draft the field refuses', async () => {
    pvState['SIM:SP'] = { connected: true, value: 1 };
    renderWidget(W.CarbonPVTextInput, { pvName: 'SIM:SP' });
    const input = document.querySelector('input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'abc' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await flush();
    expect(dialogs()).toHaveLength(0);
    expect(document.querySelector('.cds--form-requirement')?.textContent).toBe('Not a number');
    expect(sent).toEqual([]);
  });
});

describe('the input guard (an agent just changed the screen)', () => {
  for (const kind of KINDS) {
    it(`${kind.name}: a click while armed sends nothing, opens no dialog, and shows the notice`, async () => {
      for (const c of [true, false]) {
        cleanup();
        sent = [];
        confirm = c;
        kind.render();
        const arm = armAgentGuard();
        try {
          kind.act();
          await flush();
        } finally {
          arm.drop();
        }
        fireEvent.pointerUp(window, { pointerId: 1 });
        await flush();
        expect(dialogs()).toHaveLength(0);
        expect(sent).toEqual([]);
        expect(directPuts).toEqual([]);
        expect(toasts()).toEqual([['guarded', GUARD_NOTICE]]);
        const notice = screen.getByTestId('canopy-write-toast').closest('.cds--toast-notification');
        expect(notice?.className).toContain('warning');
      }
    });
  }

  it('a momentary press held before the arm still releases on pointerup', async () => {
    confirm = false;
    KINDS[4].render();
    KINDS[4].act();
    await flush();
    expect(sent).toEqual([['SIM:PULSE', 1]]);
    const arm = armAgentGuard();
    try {
      const up = createEvent.pointerUp(window);
      Object.defineProperty(up, 'pointerId', { value: 1 });
      fireEvent(window, up);
      await flush();
      expect(sent).toEqual([
        ['SIM:PULSE', 1],
        ['SIM:PULSE', 0],
      ]);
      expect(toasts()).toEqual([['confirmed', 'written']]);
    } finally {
      arm.drop();
    }
  });
});

describe('the summary toast', () => {
  it('shows the first non-confirmed detail with its outcome', async () => {
    confirm = false;
    answers = [outcome('refused', 'the write was refused; nothing written')];
    KINDS[1].render();
    KINDS[1].act();
    await flush();
    expect(toasts()).toEqual([['refused', 'the write was refused; nothing written']]);
  });

  it('shows no toast for a coalesced result', async () => {
    confirm = false;
    answers = [outcome('confirmed', 'written', true)];
    KINDS[1].render();
    KINDS[1].act();
    await flush();
    expect(sent).toHaveLength(1);
    expect(toasts()).toEqual([]);
  });

  it('closes when its close button is pressed', async () => {
    confirm = false;
    answers = [outcome('refused', 'no')];
    KINDS[1].render();
    KINDS[1].act();
    await flush();
    const toast = document.querySelector('[data-testid="canopy-write-toast"]') as HTMLElement;
    const root = toast.closest('.cds--toast-notification') as HTMLElement;
    fireEvent.click(root.querySelector('button') as HTMLButtonElement);
    await flush();
    expect(toasts()).toEqual([]);
  });

  it('leaves on its own unless the pointer is over it', async () => {
    vi.useFakeTimers();
    const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
    try {
      confirm = false;
      answers = [outcome('refused', 'no')];
      KINDS[1].render();
      KINDS[1].act();
      await advance(0);
      expect(toasts()).toEqual([['refused', 'no']]);

      const item = document.querySelector('.canopy-write-toasts__item') as HTMLElement;
      fireEvent.mouseEnter(item);
      await advance(8000);
      expect(toasts()).toEqual([['refused', 'no']]);

      fireEvent.mouseLeave(item);
      await advance(7999);
      expect(toasts()).toEqual([['refused', 'no']]);
      await advance(1);
      expect(toasts()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sits at the bottom-left of the viewport', async () => {
    confirm = false;
    answers = [outcome('refused', 'no')];
    KINDS[1].render();
    KINDS[1].act();
    await flush();
    const column = document.querySelector('.canopy-write-toasts') as HTMLElement;
    expect(column.style.left).toBe('1rem');
    expect(column.style.bottom).toBe('1rem');
    expect(column.style.right).toBe('');
  });
});

describe('without a gate (mock and fixture mode)', () => {
  it('renders nothing and the widget writes straight through', async () => {
    const Button = W.CarbonPVButton as unknown as React.FC<typeof base>;
    render(
      <ScreenWriteGateProvider gate={null}>
        <Button {...base} props={{ controlPV: 'SIM:CMD', pressValue: '2' }} />
      </ScreenWriteGateProvider>
    );
    fireEvent.click(document.querySelector('button') as HTMLButtonElement);
    await flush();
    expect(dialogs()).toHaveLength(0);
    expect(directPuts).toEqual([['SIM:CMD', 2]]);
  });
});

// ---------------------------------------------------------------------------
// The workspace's shared toast column: every docked
// screen's toasts go into one viewport-level column, each named by its tab
// title; the dialog stays with its screen.

const { WriteToastColumn, WriteToastHostContext, pinLiveToasts } = await import('./toastHost.js');

interface ScreenSpec {
  title: string;
  pv: string;
  gate: ScreenWriteGate;
  hidden?: boolean;
}

let lives: Array<[string, boolean]> = [];

/** A stand-in workspace: screens (hidden = vacated: invisible and inert) and the column. */
function Workspace({ screens, column = true }: { screens: ScreenSpec[]; column?: boolean }) {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const Btn = W.CarbonPVButton as unknown as React.FC<typeof base>;
  return (
    <>
      {screens.map((s) => (
        <div
          key={s.title}
          className="screen"
          data-title={s.title}
          aria-hidden={s.hidden ? true : undefined}
          inert={s.hidden ?? false}
          style={s.hidden ? { visibility: 'hidden' } : undefined}
        >
          <WriteToastHostContext.Provider
            value={
              column
                ? {
                    element,
                    title: s.title,
                    onLive: (live: boolean) => lives.push([s.title, live]),
                  }
                : null
            }
          >
            <ScreenWriteGateProvider gate={s.gate}>
              <Btn {...base} props={{ controlPV: s.pv, pressValue: '2' }} />
            </ScreenWriteGateProvider>
          </WriteToastHostContext.Provider>
        </div>
      ))}
      {column && <WriteToastColumn onElement={setElement} />}
    </>
  );
}

function twoScreens(hiddenA = false): ScreenSpec[] {
  return [
    {
      title: 'Orbit A',
      pv: 'SIM:A',
      gate: gateA ?? (gateA = createWriteGate(backend, { screen: 'sr/a', rev: null })),
      hidden: hiddenA,
    },
    {
      title: 'Orbit B',
      pv: 'SIM:B',
      gate: gateB ?? (gateB = createWriteGate(backend, { screen: 'sr/b', rev: null })),
    },
  ];
}

let gateA: ScreenWriteGate | undefined;
let gateB: ScreenWriteGate | undefined;

function activateBoth() {
  gateA!.activate();
  gateB!.activate();
}

const clickIn = (title: string) =>
  fireEvent.click(
    document.querySelector(`.screen[data-title="${title}"] button`) as HTMLButtonElement
  );
const column = () =>
  document.querySelector('[data-testid="canopy-write-toast-column"]') as HTMLElement;

describe('the shared toast column (workspace)', () => {
  beforeEach(() => {
    gateA = undefined;
    gateB = undefined;
    lives = [];
  });
  afterEach(() => {
    gateA?.dispose();
    gateB?.dispose();
  });

  it('renders two gates into one column, one group per screen, without overlap in DOM order', async () => {
    confirm = false;
    answers = [outcome('refused', 'the write was refused; nothing written')];
    render(<Workspace screens={twoScreens()} />);
    activateBoth();
    clickIn('Orbit A');
    await flush();
    clickIn('Orbit B');
    await flush();
    expect(sent).toEqual([
      ['SIM:A', 2],
      ['SIM:B', 2],
    ]);
    // One stack in the document: the column. No screen keeps its own.
    expect(document.querySelectorAll('.canopy-write-toasts')).toHaveLength(1);
    const col = column();
    expect(col.style.position).toBe('fixed');
    const inColumn = [...col.querySelectorAll('[data-testid="canopy-write-toast"]')];
    expect(inColumn).toHaveLength(2);
    expect(toasts()).toEqual([
      ['refused', 'the write was refused; nothing written'],
      ['confirmed', 'written'],
    ]);
    // Each toast sits in its own screen's group; neither contains the other.
    const groups = [...col.children] as HTMLElement[];
    expect(groups.map((g) => g.getAttribute('data-screen-title'))).toEqual(['Orbit A', 'Orbit B']);
    expect(groups[0]!.contains(inColumn[1]!)).toBe(false);
    expect(groups[1]!.contains(inColumn[0]!)).toBe(false);
    const [a, b] = inColumn.map((t) => t.closest('.cds--toast-notification') as HTMLElement);
    expect(a!.contains(b!) || b!.contains(a!)).toBe(false);
    // Nothing of a toast stays inside a screen.
    for (const s of document.querySelectorAll('.screen')) {
      expect(s.querySelector('[data-testid="canopy-write-toast"]')).toBeNull();
    }
  });

  it("prefixes each toast with its screen's tab title, outside the contract element", async () => {
    confirm = false;
    answers = [outcome('refused', 'no')];
    render(<Workspace screens={twoScreens()} />);
    activateBoth();
    clickIn('Orbit B');
    await flush();
    const text = column().querySelector('[data-testid="canopy-write-toast"]') as HTMLElement;
    expect(text.textContent).toBe('no');
    const toast = text.closest('.cds--toast-notification') as HTMLElement;
    const prefix = toast.querySelector('[data-testid="canopy-write-toast-screen"]') as HTMLElement;
    expect(prefix).not.toBeNull();
    expect(prefix.textContent).toBe('Orbit B');
    expect(text.contains(prefix)).toBe(false);
    expect(prefix.contains(text)).toBe(false);
    // The prefix precedes the summary.
    expect(prefix.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('without a host renders the inline stack as before: in the screen, fixed, no prefix', async () => {
    confirm = false;
    answers = [outcome('refused', 'no')];
    render(<Workspace screens={twoScreens()} column={false} />);
    activateBoth();
    clickIn('Orbit A');
    await flush();
    expect(column()).toBeNull();
    const stack = document.querySelector(
      '.screen[data-title="Orbit A"] .canopy-write-toasts'
    ) as HTMLElement;
    expect(stack).not.toBeNull();
    expect(stack.style.position).toBe('fixed');
    expect(stack.style.left).toBe('1rem');
    expect(stack.style.bottom).toBe('1rem');
    expect(toasts()).toEqual([['refused', 'no']]);
    expect(document.querySelector('[data-testid="canopy-write-toast-screen"]')).toBeNull();
  });

  it('keeps a toast visible and operable when its screen is hidden, and reports it live', async () => {
    confirm = false;
    answers = [outcome('refused', 'no')];
    const view = render(<Workspace screens={twoScreens()} />);
    activateBoth();
    clickIn('Orbit A');
    await flush();
    expect(lives).toContainEqual(['Orbit A', true]);
    view.rerender(<Workspace screens={twoScreens(true)} />);
    await flush();
    const text = column().querySelector('[data-testid="canopy-write-toast"]') as HTMLElement;
    expect(text.textContent).toBe('no');
    expect(text.closest('[inert]')).toBeNull();
    expect(text.closest('[aria-hidden="true"]')).toBeNull();
    // Closing it still reaches the hidden screen's gate.
    const toast = text.closest('.cds--toast-notification') as HTMLElement;
    fireEvent.click(toast.querySelector('button') as HTMLButtonElement);
    await flush();
    expect(toasts()).toEqual([]);
    expect(lives.at(-1)).toEqual(['Orbit A', false]);
  });

  it('a vacated screen keeps its open dialog hidden and inert, sends nothing, and it is still pending on re-dock', async () => {
    const view = render(<Workspace screens={twoScreens()} />);
    activateBoth();
    clickIn('Orbit A');
    await flush();
    expect(dialogs()).toHaveLength(1);
    view.rerender(<Workspace screens={twoScreens(true)} />);
    await flush();
    const dialog = dialogs()[0] as HTMLElement;
    // The dialog stays a child of its screen, so it inherits the vacate.
    const screenEl = dialog.closest('.screen') as HTMLElement;
    expect(screenEl.getAttribute('data-title')).toBe('Orbit A');
    expect(dialog.closest('[inert]')).toBe(screenEl);
    expect(dialog.closest('[aria-hidden="true"]')).toBe(screenEl);
    expect(screenEl.style.visibility).toBe('hidden');
    expect(column().contains(dialog)).toBe(false);
    expect(sent).toEqual([]);
    view.rerender(<Workspace screens={twoScreens(false)} />);
    await flush();
    expect(dialogs()).toHaveLength(1);
    expect((dialogs()[0] as HTMLElement).closest('[inert]')).toBeNull();
    expect(sent).toEqual([]);
    await answer('canopy-write-confirm');
    expect(sent).toEqual([['SIM:A', 2]]);
  });
});

describe('pinLiveToasts', () => {
  const isScreen = (key: string) => !key.startsWith('@');

  it('keeps an evicted screen with a live toast mounted, in strip order', () => {
    expect(pinLiveToasts(['a', 'd'], ['a', 'b', 'c', 'd'], ['c'], isScreen)).toEqual([
      'a',
      'c',
      'd',
    ]);
  });

  it('ignores closed keys and non-screens, and is the mount set unchanged with no live toast', () => {
    expect(pinLiveToasts(['a'], ['a', '@trace'], ['gone', '@trace'], isScreen)).toEqual(['a']);
    expect(pinLiveToasts(['a', 'b'], ['a', 'b', 'c'], [], isScreen)).toEqual(['a', 'b']);
  });
});
