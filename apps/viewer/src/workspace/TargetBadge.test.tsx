// TargetBadge's rows (first match wins), driven through a real badge store
// and the ServicesContext the page reads it from. The table pins the notice
// token literals ('fallback', 'unservable') and the badge text and tone each
// row shows for frames that carry no statement; the statement rows (reachable,
// writes, the `since` title) are pinned by the shared heartbeat vectors, a
// byte copy of canopy's contracts/heartbeat_vectors.json.

import '../test/memoryStorage.js';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { HareConnectionStatus, HareReachable, HareWrites } from '@slaclab/canopy-client';
import { createBackendBadgeStore } from '../backendBadge.js';
import type { BackendBadgeSeed, BackendBadgeStore } from '../backendBadge.js';
import { ServicesContext } from '../services.js';
import type { ViewerServices } from '../services.js';
import { sinceText, TargetBadge, targetBadgeView } from './TargetBadge.js';

afterEach(cleanup);

type Heartbeat = Parameters<BackendBadgeStore['setBackend']>[0];

interface Row {
  name: string;
  /** null: no store (mock or fixture mode). */
  seed: BackendBadgeSeed | null;
  chrome?: boolean;
  heartbeats?: Heartbeat[];
  statuses?: HareConnectionStatus[];
  /** null: no badge. */
  expected: { text: string; tone: 'normal' | 'warning' | 'error' | 'muted' } | null;
}

const SIM_CONFIG: BackendBadgeSeed = {
  backend: { name: 'example', label: 'Simulator', notice: null },
  binding: 'va@3',
};
const NO_CLAIM = { reachable: null, writes: null } as const;
const SIM_BEAT: Heartbeat = {
  name: 'example',
  label: 'Simulator',
  notice: null,
  binding: 'va@3',
  ...NO_CLAIM,
};

const ROWS: Row[] = [
  // Row 1: mock, fixture or chrome off -> none.
  { name: '1 mock or fixture (no store)', seed: null, expected: null },
  {
    name: '1 chrome off beats a down link with a seen label',
    seed: SIM_CONFIG,
    chrome: false,
    statuses: ['disconnected'],
    expected: null,
  },
  // Row 2: link down and a label ever seen -> Disconnected.
  {
    name: '2 config label then disconnected',
    seed: SIM_CONFIG,
    statuses: ['disconnected'],
    expected: { text: 'Disconnected', tone: 'error' },
  },
  {
    name: '2 heartbeat label then disconnected (beats a null config backend)',
    seed: { backend: null, binding: null },
    heartbeats: [SIM_BEAT],
    statuses: ['connected', 'disconnected'],
    expected: { text: 'Disconnected', tone: 'error' },
  },
  {
    name: '2 a label seen once still counts after a heartbeat clears it',
    seed: SIM_CONFIG,
    heartbeats: [{ name: 'example', label: null, notice: null, binding: null, ...NO_CLAIM }],
    statuses: ['disconnected'],
    expected: { text: 'Disconnected', tone: 'error' },
  },
  // Row 3: config backend null and no heartbeat yet -> No data connection.
  {
    name: '3 config backend null at boot',
    seed: { backend: null, binding: null },
    expected: { text: 'No data connection', tone: 'error' },
  },
  {
    name: '3 config backend null, link down, no label ever seen',
    seed: { backend: null, binding: null },
    statuses: ['disconnected'],
    expected: { text: 'No data connection', tone: 'error' },
  },
  // Row 4: label null -> none.
  { name: '4 hare page with no config block', seed: {}, expected: null },
  {
    name: '4 null config backend, then a heartbeat without a label',
    seed: { backend: null, binding: null },
    heartbeats: [{ name: 'example', label: null, notice: null, binding: null, ...NO_CLAIM }],
    statuses: ['connected'],
    expected: null,
  },
  {
    name: '4 down link with no label ever seen',
    seed: {},
    statuses: ['disconnected'],
    expected: null,
  },
  // Row 5: the label, styled by the notice token.
  {
    name: '5 plain label from config',
    seed: SIM_CONFIG,
    expected: { text: 'Simulator', tone: 'normal' },
  },
  {
    name: '5 heartbeat label after a null config backend',
    seed: { backend: null, binding: null },
    heartbeats: [SIM_BEAT],
    statuses: ['connected'],
    expected: { text: 'Simulator', tone: 'normal' },
  },
  {
    name: '5 notice fallback',
    seed: {
      backend: { name: 'example', label: 'Simulator', notice: 'fallback' },
      binding: 'fallback',
    },
    expected: { text: 'Simulator · fallback (no target record)', tone: 'warning' },
  },
  {
    name: '5 notice unservable',
    seed: { backend: null, binding: null },
    heartbeats: [
      {
        name: 'example',
        label: 'Real machine',
        notice: 'unservable',
        binding: 'unservable',
        ...NO_CLAIM,
      },
    ],
    statuses: ['connected'],
    expected: { text: 'Real machine · cannot be served', tone: 'error' },
  },
  {
    name: '5 connecting never moves the link off boot',
    seed: SIM_CONFIG,
    statuses: ['connecting', 'idle'],
    expected: { text: 'Simulator', tone: 'normal' },
  },
];

function renderRow(row: Row) {
  const store = row.seed === null ? null : createBackendBadgeStore(row.seed);
  const services = { backend: store ?? undefined } as unknown as ViewerServices;
  const utils = render(
    <ServicesContext.Provider value={services}>
      <TargetBadge chrome={row.chrome ?? true} />
    </ServicesContext.Provider>
  );
  act(() => {
    for (const beat of row.heartbeats ?? []) store?.setBackend(beat);
    for (const status of row.statuses ?? []) store?.setStatus(status);
  });
  return { ...utils, store };
}

describe('TargetBadge precedence', () => {
  it.each(ROWS)('$name', (row) => {
    const { container, store } = renderRow(row);
    const badge = container.querySelector('.target-badge');
    if (row.expected === null) {
      expect(badge).toBeNull();
      expect(container.textContent).toBe('');
    } else {
      expect(badge).not.toBeNull();
      expect(badge!.textContent).toBe(row.expected.text);
      expect(badge!.getAttribute('data-tone')).toBe(row.expected.tone);
      expect(badge!.classList.contains(`target-badge--${row.expected.tone}`)).toBe(true);
    }
    // The pure view agrees with what was rendered.
    expect(targetBadgeView(store?.getSnapshot() ?? null, row.chrome ?? true)).toEqual(row.expected);
  });

  // The paint is the `.target-badge` rule in workspace.css, so a host
  // stylesheet can restyle the badge; an inline style would outrank it.
  it('badge carries no inline paint', () => {
    for (const row of ROWS.filter((r) => r.expected !== null)) {
      const { container } = renderRow(row);
      const badge = container.querySelector('.target-badge');
      expect(badge).not.toBeNull();
      expect(badge!.hasAttribute('style')).toBe(false);
      cleanup();
    }
  });

  it('renders nothing without a ServicesContext provider', () => {
    const { container } = render(<TargetBadge />);
    expect(container.textContent).toBe('');
  });

  it('follows the store live: label, then Disconnected, then the label again', () => {
    const { store } = renderRow({ name: 'live', seed: SIM_CONFIG, expected: null });
    expect(screen.getByRole('status').textContent).toBe('Simulator');
    act(() => store!.setStatus('disconnected'));
    expect(screen.getByRole('status').textContent).toBe('Disconnected');
    act(() => store!.setStatus('connected'));
    expect(screen.getByRole('status').textContent).toBe('Simulator');
  });
});

interface VectorFrame {
  type: 'heartbeat';
  timestamp: number;
  backend: string | null;
  label: string | null;
  notice: Heartbeat['notice'];
  binding: string | null;
  reachable?: HareReachable | null;
  writes?: HareWrites | null;
}

interface FrameExpected {
  badge: string;
  tone: string;
  since_text: string | null;
  title_reason?: string | null;
}

interface FrameCase {
  case: string;
  frame: VectorFrame;
  expected: FrameExpected;
}

interface SinceCase {
  case: string;
  since: number;
  timestamp: number;
  tz: string;
  expected: string;
}

type SequenceStep =
  | { event: 'frame'; frame: VectorFrame; expected: FrameExpected }
  | { event: 'close'; expected: FrameExpected };

interface Sequence {
  id: string;
  steps: SequenceStep[];
}

interface HeartbeatVectors {
  legacy_frame: FrameCase;
  reachable_frames: FrameCase[];
  writes_frames: FrameCase[];
  since_text_cases: SinceCase[];
  sequences: Sequence[];
}

const VECTORS_PATH = createRequire(import.meta.url).resolve(
  '../../e2e/fixtures/contracts/heartbeat_vectors.json'
);
const VECTORS = JSON.parse(readFileSync(VECTORS_PATH, 'utf8')) as HeartbeatVectors;
/** The zone every frame's and sequence's `since_text` is computed in. */
const FRAME_TZ = 'UTC';

/** A frame as the SDK hands it on (missing statement fields read as null). */
function backendOf(frame: VectorFrame): Heartbeat {
  return {
    name: frame.backend,
    label: frame.label,
    notice: frame.notice,
    binding: frame.binding,
    reachable: frame.reachable ?? null,
    writes: frame.writes ?? null,
  };
}

function feed(store: BackendBadgeStore, frame: VectorFrame): void {
  store.setStatus('connected');
  store.setBackend(backendOf(frame), frame.timestamp);
}

function viewAfter(frames: VectorFrame[]) {
  const store = createBackendBadgeStore();
  for (const frame of frames) feed(store, frame);
  return targetBadgeView(store.getSnapshot(), true, FRAME_TZ);
}

function expectFrame(view: ReturnType<typeof targetBadgeView>, expected: FrameExpected) {
  expect(view).not.toBeNull();
  expect(view!.text).toBe(expected.badge);
  expect(view!.tone).toBe(expected.tone);
  if (expected.since_text !== null) {
    expect(view!.title).toBe(expected.since_text);
  } else if (expected.title_reason != null) {
    expect(view!.title).toBe(expected.title_reason);
  } else if (expected.title_reason === null) {
    expect(view!.title).toBeUndefined();
  } else {
    expect(view!.title ?? '').not.toMatch(/^not answering since/);
  }
}

const SIM_FRAME: VectorFrame = VECTORS.legacy_frame.frame;

function withStatement(reachable: HareReachable | null, writes: HareWrites | null): VectorFrame {
  return { ...SIM_FRAME, reachable, writes };
}

const DOWN: HareReachable = { state: 'no', since: SIM_FRAME.timestamp - 600, reason: null };

describe('TargetBadge statement rows (heartbeat vectors)', () => {
  it('a recorded legacy frame shows the same badge as a frame with no statement', () => {
    const { frame, expected } = VECTORS.legacy_frame;
    expect(frame).not.toHaveProperty('reachable');
    expect(frame).not.toHaveProperty('writes');
    const view = viewAfter([frame]);
    expect(view).toEqual({ text: expected.badge, tone: expected.tone });
    expect(view).toEqual({ text: 'Simulator', tone: 'normal' });
  });

  it.each(VECTORS.reachable_frames)('reachable frame $case', ({ frame, expected }) => {
    expectFrame(viewAfter([frame]), expected);
  });

  it('reachable no: "Simulator · not answering", error, the since phrase in the title', () => {
    const frame = VECTORS.reachable_frames.find((c) => c.case === 'no')!.frame;
    expect(viewAfter([frame])).toEqual({
      text: 'Simulator · not answering',
      tone: 'error',
      title: 'not answering since 11:10 (10 min)',
    });
  });

  it('an unknown frame with a reason carries the reason in the title', () => {
    const frame = VECTORS.reachable_frames.find((c) => c.case === 'unknown-with-reason')!.frame;
    expect(viewAfter([frame])).toEqual({
      text: 'Simulator',
      tone: 'normal',
      title: 'this connector has no name server to ask',
    });
  });

  it.each(VECTORS.writes_frames)('writes frame $case', ({ frame, expected }) => {
    expectFrame(viewAfter([frame]), expected);
  });

  it.each([
    ['asked', 'asked', 'Simulator', 'normal'],
    ['held', 'session_held', 'Simulator · writes held', 'warning'],
    ['locked', 'ceiling', 'Simulator · writes locked', 'muted'],
    ['off', 'narrowing', 'Simulator · writes off', 'warning'],
    ['applying', 'applying', 'Simulator · writes on · applying…', 'muted'],
    ['applying', 'switching', 'Simulator · switching target…', 'muted'],
  ])('writes %s (cause %s) reads "%s", %s', (state, cause, text, tone) => {
    expect(viewAfter([withStatement(null, { state, reason: null, cause })])).toEqual({
      text,
      tone,
    });
  });

  it('an unknown writes word reads as not on: the locked row', () => {
    const view = viewAfter([withStatement(null, { state: 'paused', reason: null, cause: null })]);
    expect(view).toEqual({ text: 'Simulator · writes locked', tone: 'muted' });
  });

  it('reachable no with writes applying, and with cause switching: error tone', () => {
    const applying = {
      state: 'applying',
      reason: 'applying the new write state',
      cause: 'applying',
    };
    const switching = {
      state: 'applying',
      reason: 'the control target is changing',
      cause: 'switching',
    };
    expect(viewAfter([withStatement(DOWN, applying)])).toMatchObject({
      text: 'Simulator · not answering · writes on · applying…',
      tone: 'error',
    });
    expect(viewAfter([withStatement(DOWN, switching)])).toMatchObject({
      text: 'Simulator · not answering · switching target…',
      tone: 'error',
    });
  });

  it('reachable no without a since, or before any frame timestamp, has no title', () => {
    expect(viewAfter([withStatement({ state: 'no', since: null, reason: null }, null)])).toEqual({
      text: 'Simulator · not answering',
      tone: 'error',
    });
    const store = createBackendBadgeStore();
    store.setBackend(backendOf(withStatement(DOWN, null)));
    expect(targetBadgeView(store.getSnapshot(), true, FRAME_TZ)).toEqual({
      text: 'Simulator · not answering',
      tone: 'error',
    });
  });

  it.each(VECTORS.since_text_cases)('since phrase $case', (c) => {
    expect(sinceText(c.since, c.timestamp, c.tz)).toBe(c.expected);
  });

  it('the duration is the frame timestamp minus since, never the page clock', () => {
    const store = createBackendBadgeStore();
    feed(store, withStatement(DOWN, null));
    const before = targetBadgeView(store.getSnapshot(), true, FRAME_TZ)!.title;
    const now = Date.now;
    Date.now = () => now() + 3_600_000;
    try {
      expect(targetBadgeView(store.getSnapshot(), true, FRAME_TZ)!.title).toBe(before);
    } finally {
      Date.now = now;
    }
    feed(store, { ...withStatement(DOWN, null), timestamp: SIM_FRAME.timestamp + 300 });
    expect(targetBadgeView(store.getSnapshot(), true, FRAME_TZ)!.title).toBe(
      'not answering since 11:10 (15 min)'
    );
  });

  it('the vectors carry the outage sequences', () => {
    const ids = VECTORS.sequences.map((s) => s.id);
    for (const id of [
      'flip-off-during-an-outage',
      'flip-on-during-an-outage',
      'switch-during-an-outage',
    ]) {
      expect(ids).toContain(id);
    }
  });

  describe.each(VECTORS.sequences)('sequence $id', (sequence) => {
    it('replays to its badge strings', () => {
      const store = createBackendBadgeStore();
      sequence.steps.forEach((step, index) => {
        if (step.event === 'close') store.setStatus('disconnected');
        else feed(store, step.frame);
        const view = targetBadgeView(store.getSnapshot(), true, FRAME_TZ);
        try {
          expectFrame(view, step.expected);
        } catch (error) {
          throw new Error(`step ${index} (${step.event}): ${(error as Error).message}`, {
            cause: error,
          });
        }
      });
    });
  });
});

describe('TargetBadge statement rendering', () => {
  function renderFrames(frames: VectorFrame[]) {
    const store = createBackendBadgeStore();
    const services = { backend: store } as unknown as ViewerServices;
    const utils = render(
      <ServicesContext.Provider value={services}>
        <TargetBadge />
      </ServicesContext.Provider>
    );
    act(() => {
      for (const frame of frames) feed(store, frame);
    });
    return { ...utils, store };
  }

  it('renders the not-answering row with its since phrase as the title', () => {
    const { container, store } = renderFrames([withStatement(DOWN, null)]);
    const badge = container.querySelector('.target-badge')!;
    expect(badge.textContent).toBe('Simulator · not answering');
    expect(badge.getAttribute('data-tone')).toBe('error');
    expect(badge.getAttribute('title')).toBe(targetBadgeView(store.getSnapshot())!.title);
    expect(badge.getAttribute('title')).toMatch(/^not answering since \d\d:\d\d \(10 min\)$/);
  });

  it('renders an unknown reason as the title and the muted tone as a class', () => {
    const { container } = renderFrames([
      withStatement(
        { state: 'unknown', since: null, reason: 'this connector has no name server to ask' },
        { state: 'locked', reason: null, cause: null }
      ),
    ]);
    const badge = container.querySelector('.target-badge')!;
    expect(badge.textContent).toBe('Simulator · writes locked');
    expect(badge.getAttribute('title')).toBe('this connector has no name server to ask');
    expect(badge.getAttribute('data-tone')).toBe('muted');
    expect(badge.classList.contains('target-badge--muted')).toBe(true);
    expect(badge.hasAttribute('style')).toBe(false);
  });

  it('a legacy frame renders no title', () => {
    const { container } = renderFrames([VECTORS.legacy_frame.frame]);
    const badge = container.querySelector('.target-badge')!;
    expect(badge.textContent).toBe('Simulator');
    expect(badge.hasAttribute('title')).toBe(false);
  });

  it('stays the one live region through statement changes and a close', () => {
    const { container, store } = renderFrames([withStatement(DOWN, null)]);
    const liveRegions = () => container.querySelectorAll('[role="status"], [aria-live]');
    expect(liveRegions().length).toBe(1);
    act(() => feed(store, withStatement(null, { state: 'off', reason: null, cause: null })));
    expect(liveRegions().length).toBe(1);
    expect(screen.getByRole('status').textContent).toBe('Simulator · writes off');
    act(() => store.setStatus('disconnected'));
    expect(liveRegions().length).toBe(1);
    expect(screen.getByRole('status').textContent).toBe('Disconnected');
    expect(screen.getByRole('status').hasAttribute('title')).toBe(false);
  });
});
