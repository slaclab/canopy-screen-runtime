// Each writing widget through a provided WriteGate: one gate run per user
// action, no write through the PV handle, and the reset key remounting the
// widgets that keep their own selection (slider, dropdown, radio group).
// Under a gate whose writes state is disabled, every writing widget renders
// inert: aria-disabled, the reason as hover and accessible description, still
// focusable, and no interaction reaches the gate or the handle.
import type React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react';
import type { WidgetRendererProps } from '../registry/WidgetRegistry.js';
import type {
  WriteGateService,
  WriteOutcomeKind,
  WriteRequest,
  WriteRunResult,
  WritesState,
} from '../writeGate/types.js';

const puts: Record<string, Array<number | string | boolean>> = {};
let pvState: Record<string, { connected: boolean; value: number | string }> = {};

vi.mock('@slaclab/canopy-react', () => ({
  usePV: (address?: string) => ({
    address: address ?? '',
    connected: (address && pvState[address]?.connected) || false,
    value: address ? pvState[address]?.value : undefined,
    displayValue: address ? String(pvState[address]?.value ?? '') : '',
    severity: 0,
    precision: 0,
    put: (v: number | string | boolean) => {
      if (address) (puts[address] ??= []).push(v);
    },
  }),
}));

const W = await import('./CarbonWidgets.js');
const { WriteGate } = await import('../writeGate/WriteGate.js');
const { WRITES_INERT_PROP } = await import('../writeGate/inert.js');

interface Run {
  writes: WriteRequest[];
  tail?: Promise<readonly WriteRequest[]>;
  tailWrites?: readonly WriteRequest[];
}

let runs: Run[] = [];
let answer: WriteOutcomeKind | 'declined' = 'confirmed';
let confirm = false;

const gate: WriteGateService = {
  confirmWrites: () => confirm,
  run: async (writes, options): Promise<WriteRunResult> => {
    const run: Run = { writes: [...writes], tail: options?.tail };
    runs.push(run);
    if (answer === 'declined') return 'declined';
    const all = [...writes];
    if (options?.tail) {
      run.tailWrites = await options.tail;
      all.push(...run.tailWrites);
    }
    const kind = answer;
    return all.map(() => ({
      outcome: kind,
      code: null,
      status: null,
      detail: kind,
      coalesced: false,
    }));
  },
};

afterEach(cleanup);
beforeEach(() => {
  for (const k of Object.keys(puts)) delete puts[k];
  pvState = {};
  runs = [];
  answer = 'confirmed';
  confirm = false;
});

const base = {
  id: 'w-1',
  layout: { x: 0, y: 0, width: 200, height: 32 },
  props: {},
  isSelected: false,
  isEditing: false,
} as unknown as WidgetRendererProps;

function renderGated(
  C: unknown,
  props: Record<string, unknown>,
  extra: Partial<WidgetRendererProps> = {}
) {
  const Comp = C as React.FC<WidgetRendererProps>;
  return render(
    <WriteGate.Provider value={gate}>
      <Comp {...base} {...extra} props={props} />
    </WriteGate.Provider>
  );
}

const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

const written = () => runs.map((r) => r.writes);

describe('text input', () => {
  it('runs the draft once on Enter, as a number when it parses', async () => {
    pvState['SIM:SP'] = { connected: true, value: 1 };
    const { container } = renderGated(W.CarbonPVTextInput, { pvName: 'SIM:SP' });
    const input = container.querySelector('input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '2.5' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await flush();
    expect(written()).toEqual([[{ pv: 'SIM:SP', value: 2.5, entered: '2.5' }]]);
    expect(puts).toEqual({});
  });

  it('runs a non-numeric draft as a string on blur', async () => {
    pvState['SIM:SP'] = { connected: true, value: 'A' };
    const { container } = renderGated(W.CarbonPVTextInput, { pvName: 'SIM:SP' });
    const input = container.querySelector('input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'RESET' } });
    fireEvent.blur(input);
    await flush();
    expect(written()).toEqual([[{ pv: 'SIM:SP', value: 'RESET' }]]);
  });

  it('runs nothing after Escape', async () => {
    pvState['SIM:SP'] = { connected: true, value: 1 };
    const { container } = renderGated(W.CarbonPVTextInput, { pvName: 'SIM:SP' });
    const input = container.querySelector('input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '9' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    fireEvent.blur(input);
    await flush();
    expect(runs).toHaveLength(0);
  });

  it('refuses an empty and a non-numeric draft on a numeric PV before any run', async () => {
    pvState['SIM:SP'] = { connected: true, value: 1 };
    const { container } = renderGated(W.CarbonPVTextInput, { pvName: 'SIM:SP' });
    const input = container.querySelector('input') as HTMLInputElement;
    const message = () => container.querySelector('.cds--form-requirement')?.textContent ?? null;
    const invalid = () => container.querySelector('[data-invalid="true"]') !== null;

    fireEvent.change(input, { target: { value: '' } });
    expect(message()).toBe('Enter a number');
    expect(invalid()).toBe(true);
    fireEvent.keyDown(input, { key: 'Enter' });
    await flush();
    expect(runs).toHaveLength(0);
    expect(input.value).toBe(''); // the draft stays, with its reason

    fireEvent.change(input, { target: { value: 'abc' } });
    expect(message()).toBe('Not a number');
    fireEvent.keyDown(input, { key: 'Enter' });
    await flush();
    expect(runs).toHaveLength(0);

    fireEvent.change(input, { target: { value: '1e3' } });
    expect(message()).toBeNull();
    expect(invalid()).toBe(false);
    fireEvent.keyDown(input, { key: 'Enter' });
    await flush();
    expect(written()).toEqual([[{ pv: 'SIM:SP', value: 1000, entered: '1e3' }]]);
    expect(puts).toEqual({});
  });

  it('drops a refused draft on blur, writing nothing', async () => {
    pvState['SIM:SP'] = { connected: true, value: 1 };
    const { container } = renderGated(W.CarbonPVTextInput, { pvName: 'SIM:SP' });
    const input = container.querySelector('input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '12abc' } });
    fireEvent.blur(input);
    await flush();
    expect(runs).toHaveLength(0);
    expect(input.value).toBe('1');
    expect(container.querySelector('.cds--form-requirement')).toBeNull();
  });
});

describe('toggle', () => {
  it('runs 1 when switched on', async () => {
    pvState['SIM:EN'] = { connected: true, value: 0 };
    renderGated(W.CarbonPVToggle, { pvName: 'SIM:EN' });
    fireEvent.click(screen.getByRole('switch'));
    await flush();
    expect(written()).toEqual([[{ pv: 'SIM:EN', value: 1 }]]);
    expect(puts).toEqual({});
  });

  it('runs nothing in the editor', async () => {
    pvState['SIM:EN'] = { connected: true, value: 0 };
    renderGated(W.CarbonPVToggle, { pvName: 'SIM:EN' }, { isEditing: true });
    fireEvent.click(screen.getByRole('switch'));
    await flush();
    expect(runs).toHaveLength(0);
  });
});

describe('checkbox', () => {
  it('runs 1 when checked', async () => {
    pvState['SIM:CB'] = { connected: true, value: 0 };
    renderGated(W.CarbonPVCheckbox, { pvName: 'SIM:CB', label: 'cb' });
    fireEvent.click(screen.getByRole('checkbox'));
    await flush();
    expect(written()).toEqual([[{ pv: 'SIM:CB', value: 1 }]]);
    expect(puts).toEqual({});
  });
});

describe('dropdown', () => {
  function choose(item: string) {
    fireEvent.click(screen.getByRole('combobox'));
    fireEvent.click(screen.getByRole('option', { name: item }));
  }

  it('runs the chosen item', async () => {
    pvState['SIM:MODE'] = { connected: true, value: 'A' };
    renderGated(W.CarbonPVDropdown, { pvName: 'SIM:MODE', customItems: ['A', 'B'] });
    choose('B');
    await flush();
    expect(written()).toEqual([[{ pv: 'SIM:MODE', value: 'B' }]]);
    expect(puts).toEqual({});
  });

  it('does not leave a declined choice on screen', async () => {
    answer = 'declined';
    pvState['SIM:MODE'] = { connected: true, value: 'A' };
    renderGated(W.CarbonPVDropdown, { pvName: 'SIM:MODE', customItems: ['A', 'B'] });
    choose('B');
    expect(screen.getByRole('combobox').textContent).toContain('B');
    await flush();
    expect(screen.getByRole('combobox').textContent).not.toContain('B');
    expect(screen.getByRole('combobox').textContent).toContain('A');
  });
});

describe('radio group', () => {
  it('runs the selected ordinal', async () => {
    pvState['SIM:SEL'] = { connected: true, value: 0 };
    renderGated(W.CarbonPVRadioGroup, { pvName: 'SIM:SEL', items: ['Off', 'On'] });
    fireEvent.click(screen.getByLabelText('On'));
    await flush();
    expect(written()).toEqual([[{ pv: 'SIM:SEL', value: 1 }]]);
    expect(puts).toEqual({});
  });

  it('does not leave a refused selection on screen', async () => {
    answer = 'refused';
    pvState['SIM:SEL'] = { connected: true, value: 0 };
    renderGated(W.CarbonPVRadioGroup, { pvName: 'SIM:SEL', items: ['Off', 'On'] });
    fireEvent.click(screen.getByLabelText('On'));
    await flush();
    expect((screen.getByLabelText('On') as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText('Off') as HTMLInputElement).checked).toBe(true);
  });
});

describe('slider', () => {
  const ARROW_RIGHT = { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39, which: 39 };

  function thumb() {
    return screen.getByRole('slider');
  }

  it('commits once on key-up, not on every step', async () => {
    pvState['SIM:SL'] = { connected: true, value: 10 };
    renderGated(W.CarbonPVSlider, { pvName: 'SIM:SL', minValue: 0, maxValue: 100 });
    fireEvent.keyDown(thumb(), ARROW_RIGHT);
    fireEvent.keyDown(thumb(), ARROW_RIGHT);
    await flush();
    expect(runs).toHaveLength(0); // local value while stepping
    expect(thumb().getAttribute('aria-valuenow')).toBe('12');
    fireEvent.keyUp(thumb(), ARROW_RIGHT);
    await flush();
    expect(written()).toEqual([[{ pv: 'SIM:SL', value: 12 }]]);
    expect(puts).toEqual({});
  });

  it('commits on drag stop', async () => {
    pvState['SIM:SL'] = { connected: true, value: 10 };
    const { container } = renderGated(W.CarbonPVSlider, {
      pvName: 'SIM:SL',
      minValue: 0,
      maxValue: 100,
    });
    const track = container.querySelector('.cds--slider') as HTMLElement;
    track.getBoundingClientRect = () =>
      ({ left: 0, width: 100, right: 100, top: 0, bottom: 10, height: 10, x: 0, y: 0 }) as DOMRect;
    fireEvent.mouseDown(track, { clientX: 40 });
    fireEvent.mouseMove(document, { clientX: 60 });
    await flush();
    expect(runs).toHaveLength(0);
    fireEvent.mouseUp(document, { clientX: 60 });
    await flush();
    expect(runs).toHaveLength(1);
    expect(runs[0].writes).toHaveLength(1);
    expect(runs[0].writes[0].pv).toBe('SIM:SL');
    expect(runs[0].writes[0].value).not.toBe(10);
  });

  it('writes nothing when the value is unchanged', async () => {
    pvState['SIM:SL'] = { connected: true, value: 10 };
    renderGated(W.CarbonPVSlider, { pvName: 'SIM:SL', minValue: 0, maxValue: 100 });
    fireEvent.keyUp(thumb(), ARROW_RIGHT);
    fireEvent.keyDown(thumb(), ARROW_RIGHT);
    fireEvent.keyDown(thumb(), { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37, which: 37 });
    await flush();
    fireEvent.keyUp(thumb(), ARROW_RIGHT);
    await flush();
    expect(runs).toHaveLength(0);
    expect(puts).toEqual({});
  });

  it('returns to the PV value after a non-confirmed outcome', async () => {
    answer = 'declined';
    pvState['SIM:SL'] = { connected: true, value: 10 };
    renderGated(W.CarbonPVSlider, { pvName: 'SIM:SL', minValue: 0, maxValue: 100 });
    fireEvent.keyDown(thumb(), ARROW_RIGHT);
    await flush();
    fireEvent.keyUp(thumb(), ARROW_RIGHT);
    await flush();
    expect(runs).toHaveLength(1);
    expect(thumb().getAttribute('aria-valuenow')).toBe('10');
  });

  it('writes nothing in the editor', async () => {
    pvState['SIM:SL'] = { connected: true, value: 10 };
    renderGated(
      W.CarbonPVSlider,
      { pvName: 'SIM:SL', minValue: 0, maxValue: 100 },
      { isEditing: true }
    );
    fireEvent.keyDown(thumb(), ARROW_RIGHT);
    await flush();
    fireEvent.keyUp(thumb(), ARROW_RIGHT);
    await flush();
    expect(runs).toHaveLength(0);
  });
});

describe('button', () => {
  function button(props: Record<string, unknown>) {
    const { container } = renderGated(W.CarbonPVButton, props);
    return container.querySelector('button') as HTMLButtonElement;
  }

  it('runs the press value once per click', async () => {
    fireEvent.click(button({ controlPV: 'SIM:CMD', pressValue: '2' }));
    await flush();
    expect(written()).toEqual([[{ pv: 'SIM:CMD', value: 2 }]]);
    expect(puts).toEqual({});
  });

  it('runs the toggled value for a toggle button', async () => {
    pvState['SIM:ST'] = { connected: true, value: 1 };
    fireEvent.click(button({ controlPV: 'SIM:CTRL', readbackPV: 'SIM:ST', buttonType: 'toggle' }));
    await flush();
    expect(written()).toEqual([[{ pv: 'SIM:CTRL', value: 0 }]]);
  });

  it('confirm on: runs [press, release] at pointerdown as one pulse', async () => {
    confirm = true;
    const btn = button({ controlPV: 'SIM:CMD', pressValue: '1', releaseValue: '0' });
    fireEvent.pointerDown(btn);
    await flush();
    expect(written()).toEqual([
      [
        { pv: 'SIM:CMD', value: 1 },
        { pv: 'SIM:CMD', value: 0, release: true },
      ],
    ]);
    fireEvent.pointerUp(window);
    await flush();
    expect(runs).toHaveLength(1);
    expect(puts).toEqual({});
  });

  it('confirm off: runs the press at pointerdown and appends the release at pointerup', async () => {
    const btn = button({ controlPV: 'SIM:CMD', pressValue: '1', releaseValue: '0' });
    fireEvent.pointerDown(btn);
    await flush();
    expect(written()).toEqual([[{ pv: 'SIM:CMD', value: 1 }]]);
    expect(runs[0].tailWrites).toBeUndefined();
    fireEvent.pointerUp(window);
    await flush();
    expect(runs).toHaveLength(1);
    expect(runs[0].tailWrites).toEqual([{ pv: 'SIM:CMD', value: 0, release: true }]);
    expect(puts).toEqual({});
  });

  it('confirm off: appends the release when the button unmounts mid-hold', async () => {
    const { container, unmount } = renderGated(W.CarbonPVButton, {
      controlPV: 'SIM:CMD',
      pressValue: '1',
      releaseValue: '0',
    });
    fireEvent.pointerDown(container.querySelector('button') as HTMLButtonElement);
    await flush();
    unmount();
    await flush();
    expect(runs[0].tailWrites).toEqual([{ pv: 'SIM:CMD', value: 0, release: true }]);
  });

  it('ignores a secondary-button pointerdown', async () => {
    const btn = button({ controlPV: 'SIM:CMD', pressValue: '1', releaseValue: '0' });
    // jsdom has no PointerEvent, so the init dict's `button` is dropped.
    const ev = createEvent.pointerDown(btn);
    Object.defineProperty(ev, 'button', { value: 2 });
    fireEvent(btn, ev);
    await flush();
    expect(runs).toHaveLength(0);
  });

  it('runs nothing in the editor', async () => {
    const { container } = renderGated(
      W.CarbonPVButton,
      { controlPV: 'SIM:CMD', pressValue: '1', releaseValue: '0' },
      { isEditing: true }
    );
    fireEvent.pointerDown(container.querySelector('button') as HTMLButtonElement);
    await flush();
    expect(runs).toHaveLength(0);
  });

  it('a loc:// control passes through the instance path, not the gate', async () => {
    fireEvent.click(button({ controlPV: 'loc://flag', pressValue: '1' }));
    await flush();
    expect(runs).toHaveLength(0);
    expect(puts['loc://flag']).toEqual([1]);
  });
});

// ── Inert while the machine does not accept writes ─────────────────────────

const REASON = 'Simulator is kept read-only for this login';
const LOCKED: WritesState = Object.freeze({ disabled: true, reason: REASON });
const LIVE: WritesState = Object.freeze({ disabled: false, reason: null });

/** The shared gate with a writes state the test sets; `set()` notifies subscribers. */
function statedGate(initial: WritesState) {
  let current = initial;
  const listeners = new Set<() => void>();
  const stated: WriteGateService = {
    ...gate,
    writes: () => current,
    subscribeWrites(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const set = (next: WritesState) =>
    act(() => {
      current = next;
      for (const l of [...listeners]) l();
    });
  return { gate: stated, set };
}

function renderStated(C: unknown, props: Record<string, unknown>, initial: WritesState = LOCKED) {
  const Comp = C as React.FC<WidgetRendererProps>;
  const stated = statedGate(initial);
  const utils = render(
    <WriteGate.Provider value={stated.gate}>
      <Comp {...base} props={props} />
    </WriteGate.Provider>
  );
  return { ...utils, set: stated.set };
}

/** The text of the node `el` names as its description. */
function description(el: Element): string | null {
  const ids = el.getAttribute('aria-describedby');
  if (ids === null) return null;
  return ids
    .split(/\s+/)
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ');
}

/** `el` is inert with the reason, and still a focus stop. */
function expectInert(el: Element, reason = REASON) {
  expect(el.getAttribute('aria-disabled')).toBe('true');
  expect(el.getAttribute('title')).toBe(reason);
  expect(description(el)).toBe(reason);
  expect(el.hasAttribute('disabled')).toBe(false);
  (el as HTMLElement).focus();
  expect(document.activeElement).toBe(el);
}

function expectLive(el: Element) {
  expect(el.getAttribute('aria-disabled')).not.toBe('true');
  expect(el.getAttribute('aria-describedby') ?? '').not.toMatch(/\S/);
}

describe('inert while writes are not accepted', () => {
  it('text input: aria-disabled, read-only, and Enter or blur runs nothing', async () => {
    pvState['SIM:SP'] = { connected: true, value: 1 };
    const { container } = renderStated(W.CarbonPVTextInput, { pvName: 'SIM:SP' });
    const input = container.querySelector('input') as HTMLInputElement;
    expectInert(input);
    expect(input.readOnly).toBe(true);
    fireEvent.change(input, { target: { value: '7' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.blur(input);
    await flush();
    expect(runs).toHaveLength(0);
    expect(puts).toEqual({});
  });

  it('toggle: a click runs nothing', async () => {
    pvState['SIM:EN'] = { connected: true, value: 0 };
    renderStated(W.CarbonPVToggle, { pvName: 'SIM:EN' });
    const sw = screen.getByRole('switch');
    expectInert(sw);
    fireEvent.click(sw);
    await flush();
    expect(runs).toHaveLength(0);
    expect(sw.getAttribute('aria-checked')).toBe('false');
  });

  it('checkbox: a click runs nothing', async () => {
    pvState['SIM:CB'] = { connected: true, value: 0 };
    renderStated(W.CarbonPVCheckbox, { pvName: 'SIM:CB', label: 'cb' });
    const cb = screen.getByRole('checkbox') as HTMLInputElement;
    expect(cb.getAttribute('aria-disabled')).toBe('true');
    expect(description(cb)).toBe(REASON);
    expect(cb.hasAttribute('disabled')).toBe(false);
    // Carbon draws the box on the label, which carries the hover.
    expect(document.body.querySelector('label')?.getAttribute('title')).toBe(REASON);
    fireEvent.click(cb);
    await flush();
    expect(runs).toHaveLength(0);
  });

  it('dropdown: the field button is inert and a choice runs nothing', async () => {
    pvState['SIM:MODE'] = { connected: true, value: 'A' };
    renderStated(W.CarbonPVDropdown, { pvName: 'SIM:MODE', customItems: ['A', 'B'] });
    const field = screen.getByRole('combobox');
    expectInert(field);
    fireEvent.click(field);
    expect(screen.queryByRole('option', { name: 'B' })).toBeNull();
    await flush();
    expect(runs).toHaveLength(0);
  });

  it('radio group: every option is inert and a click runs nothing', async () => {
    pvState['SIM:SEL'] = { connected: true, value: 0 };
    renderStated(W.CarbonPVRadioGroup, { pvName: 'SIM:SEL', items: ['Off', 'On'] });
    const on = screen.getByLabelText('On') as HTMLInputElement;
    expectInert(on);
    expectInert(screen.getByLabelText('Off'));
    fireEvent.click(on);
    await flush();
    expect(runs).toHaveLength(0);
    expect((screen.getByLabelText('Off') as HTMLInputElement).checked).toBe(true);
  });

  it('slider: its box is the inert focus stop and a key step runs nothing', async () => {
    pvState['SIM:SL'] = { connected: true, value: 10 };
    const { container } = renderStated(W.CarbonPVSlider, {
      pvName: 'SIM:SL',
      minValue: 0,
      maxValue: 100,
    });
    const box = container.querySelector('.carbon-pv-slider') as HTMLElement;
    expectInert(box);
    expect(box.tabIndex).toBe(0);
    const right = { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39, which: 39 };
    fireEvent.keyDown(screen.getByRole('slider'), right);
    fireEvent.keyUp(screen.getByRole('slider'), right);
    await flush();
    expect(runs).toHaveLength(0);
  });

  it('button: click, pointerdown and Enter run nothing', async () => {
    const { container } = renderStated(W.CarbonPVButton, {
      controlPV: 'SIM:CMD',
      label: 'HCM 01',
      pressValue: '1',
    });
    const btn = container.querySelector('button') as HTMLButtonElement;
    expectInert(btn);
    // The description is not part of the name.
    expect(btn.textContent).toBe('HCM 01');
    fireEvent.click(btn);
    fireEvent.keyDown(btn, { key: 'Enter' });
    fireEvent.pointerDown(btn);
    await flush();
    expect(runs).toHaveLength(0);
    expect(puts).toEqual({});
  });

  it('a momentary button: pointerdown runs nothing', async () => {
    const { container } = renderStated(W.CarbonPVButton, {
      controlPV: 'SIM:CMD',
      pressValue: '1',
      releaseValue: '0',
    });
    const btn = container.querySelector('button') as HTMLButtonElement;
    expectInert(btn);
    fireEvent.pointerDown(btn);
    fireEvent.pointerUp(window);
    await flush();
    expect(runs).toHaveLength(0);
  });

  it('a host-set inert reason makes a channel-less button inert', async () => {
    const { container } = renderStated(
      W.CarbonPVButton,
      { label: 'Open', [WRITES_INERT_PROP]: 'Writes are locked for Probe' },
      LIVE
    );
    expectInert(
      container.querySelector('button') as HTMLButtonElement,
      'Writes are locked for Probe'
    );
  });

  it('a button with no control channel stays live under the disabled gate', () => {
    const { container } = renderStated(W.CarbonPVButton, { label: 'Open' });
    expectLive(container.querySelector('button') as HTMLButtonElement);
  });

  it('a loc:// control stays live and writes through the handle', async () => {
    const { container } = renderStated(W.CarbonPVButton, {
      controlPV: 'loc://flag',
      pressValue: '1',
    });
    const btn = container.querySelector('button') as HTMLButtonElement;
    expectLive(btn);
    fireEvent.click(btn);
    await flush();
    expect(runs).toHaveLength(0);
    expect(puts['loc://flag']).toEqual([1]);
  });

  it('goes live on the state that says so, and inert again on the next', async () => {
    pvState['SIM:EN'] = { connected: true, value: 0 };
    const { set } = renderStated(W.CarbonPVToggle, { pvName: 'SIM:EN' });
    expectInert(screen.getByRole('switch'));
    set(LIVE);
    const sw = screen.getByRole('switch');
    expectLive(sw);
    expect(sw.hasAttribute('title')).toBe(false);
    fireEvent.click(sw);
    await flush();
    expect(written()).toEqual([[{ pv: 'SIM:EN', value: 1 }]]);
    set(Object.freeze({ disabled: true, reason: 'applying the new write state' }));
    expectInert(screen.getByRole('switch'), 'applying the new write state');
  });

  it('the dropdown field drops the reason when writes come back', () => {
    pvState['SIM:MODE'] = { connected: true, value: 'A' };
    const { set } = renderStated(W.CarbonPVDropdown, { pvName: 'SIM:MODE', customItems: ['A'] });
    set(LIVE);
    const field = screen.getByRole('combobox');
    expect(field.getAttribute('aria-disabled')).toBeNull();
    expect(field.getAttribute('title')).not.toBe(REASON);
    expect(field.getAttribute('aria-describedby')).toBeNull();
  });

  it('a gate without a writes state, and no provider, render nothing inert', () => {
    pvState['SIM:EN'] = { connected: true, value: 0 };
    const { container } = renderGated(W.CarbonPVToggle, { pvName: 'SIM:EN' });
    const Btn = W.CarbonPVButton as React.FC<WidgetRendererProps>;
    const bare = render(<Btn {...base} props={{ controlPV: 'SIM:CMD' }} />);
    expect(container.querySelector('[aria-disabled="true"]')).toBeNull();
    expect(bare.container.querySelector('[aria-disabled="true"]')).toBeNull();
  });
});
