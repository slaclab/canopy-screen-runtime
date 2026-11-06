// Write-inert rendering: a widget whose machine write is not accepted now
// renders inert, stays focusable, and shows the reason as its hover and its
// accessible description.

import { useId, useLayoutEffect } from 'react';
import type { ReactNode, RefObject } from 'react';
import type { GatedWrite } from './useGatedWrite.js';

/**
 * The reserved prop a host sets on a widget whose click actions are
 * write-inert: the reason, as a string. The widget renders inert with it even
 * when its own channel is live (a button that carries only actions).
 */
export const WRITES_INERT_PROP = 'writesInert';

/**
 * Why a widget's own machine write is inert, or null while it is live. A
 * widget with no channel bound (address `''`) writes nothing, so it is never
 * inert on its own account.
 */
export function ownInertReason(gated: GatedWrite, address: string): string | null {
  return gated.disabled && address !== '' ? (gated.reason ?? '') : null;
}

/** The host-set inert reason of `props`, or null. */
export function hostInertReason(props: Readonly<Record<string, unknown>>): string | null {
  const reason = props[WRITES_INERT_PROP];
  return typeof reason === 'string' ? reason : null;
}

/** The attributes of a write-inert focusable element. */
export interface InertAttrs {
  'aria-disabled'?: 'true';
  'aria-describedby'?: string;
  title?: string;
}

/**
 * A write-inert widget: `aria-disabled`, the reason as hover (`title`) and as
 * the accessible description (`aria-describedby` to a hidden node, `note`).
 * It stays focusable: inert never uses the HTML `disabled` attribute.
 */
export interface Inert {
  inert: boolean;
  reason: string | null;
  /** For the focusable element. Empty while live. */
  attrs: InertAttrs;
  /** The hover alone, for the widget's outer box. Empty while live. */
  hover: { title?: string };
  /** The description node; render it outside the focusable element. */
  note: ReactNode;
}

export function useInert(reason: string | null): Inert {
  const id = useId();
  if (reason === null) {
    return { inert: false, reason: null, attrs: {}, hover: {}, note: null };
  }
  return {
    inert: true,
    reason,
    attrs: { 'aria-disabled': 'true', 'aria-describedby': id, title: reason },
    hover: { title: reason },
    note: (
      <span id={id} hidden>
        {reason}
      </span>
    ),
  };
}

/**
 * Applies `inert`'s attributes to the element `selector` finds inside `ref`,
 * for a library control that does not pass them to its focusable element. A
 * value the library rewrote since is left as the library set it.
 */
export function useInertOnInner(
  ref: RefObject<HTMLElement | null>,
  selector: string,
  inert: Inert
) {
  useLayoutEffect(() => {
    const el = ref.current?.querySelector(selector);
    if (!el || !inert.inert) return;
    const applied = Object.entries(inert.attrs) as [string, string][];
    const before = applied.map(([name]) => [name, el.getAttribute(name)] as const);
    for (const [name, value] of applied) el.setAttribute(name, value);
    return () => {
      for (const [i, [name, prev]] of before.entries()) {
        if (el.getAttribute(name) !== applied[i]![1]) continue;
        if (prev === null) el.removeAttribute(name);
        else el.setAttribute(name, prev);
      }
    };
  });
}
