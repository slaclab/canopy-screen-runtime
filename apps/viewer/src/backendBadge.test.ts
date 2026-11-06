// The backend badge store: one per hare-mode page, seeded from config.json's
// `backend` / `binding` block and fed by the Hare connection status and the
// heartbeat identity (onBackendChange). `link` stays 'boot' until the first
// connected or disconnected status; 'connecting' never changes it. The live
// socket's statement (reachable, writes, frame timestamp) is held per socket
// and cleared when it closes.

import './test/memoryStorage.js';
import { createElement } from 'react';
import type { ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createBackendBadgeStore } from './backendBadge.js';
import { ServicesContext, useBackendBadge } from './services.js';
import type { ViewerServices } from './services.js';

const SIM = {
  name: 'example',
  label: 'Simulator',
  notice: null,
  binding: 'va@3',
  reachable: null,
  writes: null,
} as const;
const DOWN = { state: 'no', since: 1760699400, reason: null } as const;
const LOCKED = {
  state: 'locked',
  reason: 'Simulator is kept read-only for this login',
  cause: 'ceiling',
} as const;

describe('createBackendBadgeStore', () => {
  it('starts at boot with nothing known when unseeded', () => {
    const store = createBackendBadgeStore();
    expect(store.getSnapshot()).toEqual({
      label: null,
      notice: null,
      binding: null,
      link: 'boot',
      labelSeen: false,
      configBackendNull: false,
      heartbeat: false,
      lastBinding: null,
      reachable: null,
      writes: null,
      timestamp: null,
    });
  });

  it('seeds label, notice and binding from the config block; a config label counts as seen', () => {
    const store = createBackendBadgeStore({
      backend: { name: 'example', label: 'Simulator', notice: 'fallback' },
      binding: 'fallback',
    });
    expect(store.getSnapshot()).toMatchObject({
      label: 'Simulator',
      notice: 'fallback',
      binding: 'fallback',
      link: 'boot',
      labelSeen: true,
      configBackendNull: false,
      heartbeat: false,
      lastBinding: 'fallback',
    });
  });

  it('records a config backend served as null (DATA unreachable)', () => {
    const store = createBackendBadgeStore({ backend: null, binding: null });
    expect(store.getSnapshot()).toMatchObject({
      label: null,
      binding: null,
      labelSeen: false,
      configBackendNull: true,
    });
  });

  it('treats an absent config block (older server) as unknown, not null', () => {
    expect(createBackendBadgeStore({}).getSnapshot().configBackendNull).toBe(false);
  });

  it('keeps link at boot through idle and connecting, then follows connected / disconnected', () => {
    const store = createBackendBadgeStore();
    store.setStatus('idle');
    store.setStatus('connecting');
    expect(store.getSnapshot().link).toBe('boot');
    store.setStatus('connected');
    expect(store.getSnapshot().link).toBe('up');
    store.setStatus('connecting');
    expect(store.getSnapshot().link).toBe('up');
    store.setStatus('disconnected');
    expect(store.getSnapshot().link).toBe('down');
    store.setStatus('connecting');
    store.setStatus('idle');
    expect(store.getSnapshot().link).toBe('down');
    store.setStatus('connected');
    expect(store.getSnapshot().link).toBe('up');
  });

  it('goes straight from boot to down on a first disconnected status', () => {
    const store = createBackendBadgeStore();
    store.setStatus('disconnected');
    expect(store.getSnapshot().link).toBe('down');
  });

  it('takes the heartbeat identity and marks a heartbeat seen', () => {
    const store = createBackendBadgeStore({ backend: null, binding: null });
    store.setBackend(SIM);
    expect(store.getSnapshot()).toMatchObject({
      label: 'Simulator',
      notice: null,
      binding: 'va@3',
      labelSeen: true,
      configBackendNull: true,
      heartbeat: true,
      lastBinding: 'va@3',
    });
  });

  it('remembers a label once seen and the last non-null binding', () => {
    const store = createBackendBadgeStore();
    store.setBackend(SIM);
    store.setBackend({ ...SIM, label: null, notice: 'unservable', binding: null });
    expect(store.getSnapshot()).toMatchObject({
      label: null,
      notice: 'unservable',
      binding: null,
      labelSeen: true,
      lastBinding: 'va@3',
    });
    store.setBackend({ ...SIM, binding: 'va@4' });
    expect(store.getSnapshot().lastBinding).toBe('va@4');
  });

  it('notifies on change only and keeps the snapshot identity otherwise', () => {
    const store = createBackendBadgeStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    const before = store.getSnapshot();
    store.setStatus('connecting');
    store.setStatus('idle');
    expect(listener).not.toHaveBeenCalled();
    expect(store.getSnapshot()).toBe(before);

    store.setStatus('connected');
    expect(listener).toHaveBeenCalledTimes(1);
    const up = store.getSnapshot();
    expect(up).not.toBe(before);
    store.setStatus('connected');
    expect(listener).toHaveBeenCalledTimes(1);

    store.setBackend(SIM);
    expect(listener).toHaveBeenCalledTimes(2);
    store.setBackend({ ...SIM });
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    store.setStatus('disconnected');
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('takes the statement and the frame timestamp from a heartbeat', () => {
    const store = createBackendBadgeStore();
    store.setBackend({ ...SIM, reachable: DOWN, writes: LOCKED }, 1760700000);
    expect(store.getSnapshot()).toMatchObject({
      reachable: DOWN,
      writes: LOCKED,
      timestamp: 1760700000,
    });
  });

  it('reads a heartbeat without the statement fields as no claim', () => {
    const store = createBackendBadgeStore();
    const legacy = { name: 'example', label: 'Simulator', notice: null, binding: 'va@3' };
    store.setBackend(legacy as unknown as Parameters<typeof store.setBackend>[0]);
    expect(store.getSnapshot()).toMatchObject({ reachable: null, writes: null, timestamp: null });
  });

  it('keeps the last timestamp when a heartbeat gives none', () => {
    const store = createBackendBadgeStore();
    store.setBackend(SIM, 1760700000);
    store.setBackend({ ...SIM, writes: LOCKED });
    expect(store.getSnapshot().timestamp).toBe(1760700000);
  });

  it('clears the statement when the socket closes, and only then', () => {
    const store = createBackendBadgeStore();
    store.setStatus('connected');
    store.setBackend({ ...SIM, reachable: DOWN, writes: LOCKED }, 1760700000);
    store.setStatus('connecting');
    store.setStatus('idle');
    expect(store.getSnapshot().writes).toEqual(LOCKED);
    store.setStatus('disconnected');
    expect(store.getSnapshot()).toMatchObject({
      link: 'down',
      reachable: null,
      writes: null,
      timestamp: null,
      label: 'Simulator',
    });
    // A new socket's open restores nothing; its first heartbeat does.
    store.setStatus('connected');
    expect(store.getSnapshot()).toMatchObject({ link: 'up', reachable: null, writes: null });
  });

  it('notifies on a statement or timestamp change, not on an equal statement', () => {
    const store = createBackendBadgeStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.setBackend({ ...SIM, writes: LOCKED }, 1760700000);
    expect(listener).toHaveBeenCalledTimes(1);
    const held = store.getSnapshot();
    store.setBackend({ ...SIM, writes: { ...LOCKED } }, 1760700000);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).toBe(held);

    store.setBackend({ ...SIM, writes: { ...LOCKED, state: 'off' } }, 1760700000);
    expect(listener).toHaveBeenCalledTimes(2);
    store.setBackend({ ...SIM, writes: { ...LOCKED, state: 'off' }, reachable: DOWN }, 1760700000);
    expect(listener).toHaveBeenCalledTimes(3);
    store.setBackend(
      { ...SIM, writes: { ...LOCKED, state: 'off' }, reachable: { ...DOWN } },
      1760700300
    );
    expect(listener).toHaveBeenCalledTimes(4);
    expect(store.getSnapshot().timestamp).toBe(1760700300);
  });

  it('never hands out a snapshot a later change mutates', () => {
    const store = createBackendBadgeStore();
    const before = store.getSnapshot();
    store.setBackend(SIM);
    expect(before.label).toBeNull();
    expect(Object.isFrozen(store.getSnapshot())).toBe(true);
  });
});

describe('useBackendBadge', () => {
  function servicesWith(backend?: ViewerServices['backend']): ViewerServices {
    return { backend } as unknown as ViewerServices;
  }

  function wrapperFor(services: ViewerServices) {
    return ({ children }: { children: ReactNode }) =>
      createElement(ServicesContext.Provider, { value: services }, children);
  }

  it('returns null without a ServicesContext provider', () => {
    const { result } = renderHook(() => useBackendBadge());
    expect(result.current).toBeNull();
  });

  it('returns null when the services carry no backend (mock and fixture mode)', () => {
    const { result } = renderHook(() => useBackendBadge(), { wrapper: wrapperFor(servicesWith()) });
    expect(result.current).toBeNull();
  });

  it('returns the live snapshot and re-renders on a change', () => {
    const store = createBackendBadgeStore({
      backend: { name: 'example', label: 'Simulator', notice: null },
      binding: 'va@3',
    });
    const { result } = renderHook(() => useBackendBadge(), {
      wrapper: wrapperFor(servicesWith(store)),
    });
    expect(result.current).toMatchObject({ label: 'Simulator', link: 'boot' });
    act(() => store.setStatus('disconnected'));
    expect(result.current).toMatchObject({ label: 'Simulator', link: 'down', labelSeen: true });
  });
});
