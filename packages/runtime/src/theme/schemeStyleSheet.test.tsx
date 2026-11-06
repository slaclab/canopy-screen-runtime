// The per-scheme <style>: one per (document, flatHash), ref-counted, removed
// on an idle callback only when still unused; scoped by quoted attribute
// selectors so two schemes in one document never collide. jsdom has no
// cascade for custom properties, so "keeps its own values" is checked by
// matching each root against the sheet's rules; the real cascade is proven in
// a browser by the s-theme e2e.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MockPVService } from '@slaclab/canopy-client';
import { PVServiceProvider } from '@slaclab/canopy-react';
import { canopyDefaultFlat } from '@slaclab/canopy-screen-ir';
import type { FlatScheme, ScreenJSON } from '@slaclab/canopy-screen-ir';
import { registerBuiltinWidgets } from '@slaclab/canopy-screen-widgets';
import { ScreenRenderer } from '../render/ScreenRenderer.js';
import { schemeCss, useSchemeStyleSheet } from './schemeStyleSheet.js';

const other: FlatScheme = {
  roles: ['Transparent', 'OK', 'MINOR', 'MAJOR', 'INVALID', 'DISCONNECTED'],
  light: ['#ffffff00', '#00ff00', '#ffff00', '#ff0000', '#ff00ff', '#888888'],
  dark: ['#00000000', '#008800', '#888800', '#880000', '#880088', '#444444'],
  meta: { id: 'other', sha256: null, flatHash: 'abc123', served: 'other', errors: [] },
};

const doc: ScreenJSON = {
  schemaVersion: '1.0',
  kind: 'screen',
  id: 's',
  metadata: { title: 's', source: { type: 'hand-authored' }, size: { width: 10, height: 10 } },
  macros: [],
  root: {
    id: 'r',
    type: 'text-label',
    props: { text: 'x' },
    geometry: { x: 0, y: 0, width: 10, height: 10 },
  },
};

let service: MockPVService;

beforeAll(() => {
  registerBuiltinWidgets();
});

beforeEach(() => {
  service = new MockPVService();
  service.connect();
});

afterEach(async () => {
  cleanup();
  service.disconnect();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  // Let any pending deferred removal run so tests start from an empty head.
  await new Promise((r) => setTimeout(r, 5));
});

function wrap(children: ReactNode) {
  return <PVServiceProvider service={service}>{children}</PVServiceProvider>;
}

function sheets(): HTMLStyleElement[] {
  return [...document.head.querySelectorAll<HTMLStyleElement>('style[data-canopy-scheme]')];
}

function Holder({ flat }: { flat: FlatScheme }) {
  useSchemeStyleSheet(flat);
  return null;
}

/** The value `el` gets for `prop` from the scheme sheets, by selector match. */
function sheetValue(el: Element, prop: string): string {
  let value = '';
  for (const style of sheets()) {
    for (const rule of [...(style.sheet?.cssRules ?? [])] as CSSStyleRule[]) {
      if (el.matches(rule.selectorText)) value = rule.style.getPropertyValue(prop).trim();
    }
  }
  return value;
}

describe('schemeStyleSheet', () => {
  it('inserts one sheet for two roots of one document', () => {
    const { getAllByTestId } = render(
      wrap(
        <>
          <ScreenRenderer screen={doc} />
          <ScreenRenderer screen={doc} />
        </>
      )
    );
    expect(getAllByTestId('screen-root')).toHaveLength(2);
    expect(sheets()).toHaveLength(1);
    expect(sheets()[0].dataset.canopyScheme).toBe(canopyDefaultFlat.meta.flatHash);
  });

  it('keeps the sheet across an unmount/remount in the same tick', async () => {
    vi.useFakeTimers();
    const first = render(<Holder flat={other} />);
    const el = sheets()[0];
    first.unmount();
    render(<Holder flat={other} />);
    await act(async () => {
      vi.runAllTimers();
    });
    expect(sheets()).toEqual([el]);
    expect(el.isConnected).toBe(true);
  });

  it('removes the sheet after idle once the last user unmounts', () => {
    const idle: Array<() => void> = [];
    vi.stubGlobal('requestIdleCallback', (cb: () => void) => idle.push(cb));
    const a = render(<Holder flat={other} />);
    const b = render(<Holder flat={other} />);
    a.unmount();
    expect(idle).toHaveLength(0);
    b.unmount();
    expect(sheets()).toHaveLength(1);
    expect(idle).toHaveLength(1);
    idle[0]();
    expect(sheets()).toHaveLength(0);
  });

  it('falls back to setTimeout when requestIdleCallback is absent', () => {
    vi.stubGlobal('requestIdleCallback', undefined);
    vi.useFakeTimers();
    const view = render(<Holder flat={other} />);
    view.unmount();
    expect(sheets()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sheets()).toHaveLength(0);
  });

  it('uses only quoted .canopy-screen[data-scheme][data-theme] selectors, never :root', () => {
    render(<Holder flat={canopyDefaultFlat} />);
    const style = sheets()[0];
    expect(style.textContent).not.toContain(':root');
    const rules = [...(style.sheet?.cssRules ?? [])] as CSSStyleRule[];
    expect(rules).toHaveLength(2);
    const hash = canopyDefaultFlat.meta.flatHash;
    expect(rules.map((r) => r.selectorText.replace(/'/g, '"'))).toEqual([
      `.canopy-screen[data-scheme="${hash}"][data-theme="light"]`,
      `.canopy-screen[data-scheme="${hash}"][data-theme="dark"]`,
    ]);
    // Exactly one compound selector each: no ancestor or descendant part.
    for (const r of rules) expect(r.selectorText).not.toMatch(/\s|,|>/);
  });

  it('lets a digit-leading flatHash selector parse through querySelector', () => {
    const hash = canopyDefaultFlat.meta.flatHash;
    expect(hash).toMatch(/^\d/);
    const { getByTestId } = render(wrap(<ScreenRenderer screen={doc} />));
    const root = getByTestId('screen-root');
    expect(
      document.querySelector(`.canopy-screen[data-scheme="${hash}"][data-theme="light"]`)
    ).toBe(root);
  });

  it('keeps each root on its own scheme values when two schemes share a document', () => {
    const { getAllByTestId } = render(
      wrap(
        <>
          <ScreenRenderer screen={doc} />
          <ScreenRenderer screen={doc} colorScheme={other} />
        </>
      )
    );
    const [defaultRoot, otherRoot] = getAllByTestId('screen-root');
    expect(sheets()).toHaveLength(2);
    const ok = canopyDefaultFlat.roles.indexOf('OK');
    expect(sheetValue(defaultRoot, `--cr-${ok}`)).toBe(canopyDefaultFlat.light[ok]);
    expect(sheetValue(otherRoot, '--cr-1')).toBe('#00ff00');
    expect(sheetValue(otherRoot, '--pydm-alarm-none')).toBe('var(--cr-1)');
  });

  it('aliases the five --pydm-alarm-* vars to their roles in both modes', () => {
    const css = schemeCss(canopyDefaultFlat);
    const idx = (role: string) => canopyDefaultFlat.roles.indexOf(role);
    const [light, dark] = css.split('\n');
    for (const block of [light, dark]) {
      expect(block).toContain(`--pydm-alarm-none:var(--cr-${idx('OK')})`);
      expect(block).toContain(`--pydm-alarm-minor:var(--cr-${idx('MINOR')})`);
      expect(block).toContain(`--pydm-alarm-major:var(--cr-${idx('MAJOR')})`);
      expect(block).toContain(`--pydm-alarm-invalid:var(--cr-${idx('INVALID')})`);
      expect(block).toContain(`--pydm-alarm-disconnected:var(--cr-${idx('DISCONNECTED')})`);
    }
    expect(light).toContain(`--cr-${idx('MAJOR')}:${canopyDefaultFlat.light[idx('MAJOR')]}`);
    expect(dark).toContain(`--cr-${idx('MAJOR')}:${canopyDefaultFlat.dark[idx('MAJOR')]}`);
  });

  it('aliases the display background var to its role in both modes', () => {
    const css = schemeCss(canopyDefaultFlat);
    const idx = (role: string) => canopyDefaultFlat.roles.indexOf(role);
    expect(idx('Display_Background')).toBeGreaterThanOrEqual(0);
    const [light, dark] = css.split('\n');
    for (const block of [light, dark]) {
      expect(block).toContain(`--pydm-display-background:var(--cr-${idx('Display_Background')})`);
    }
  });

  it('omits an alias whose role the scheme lacks', () => {
    const css = schemeCss({
      ...other,
      roles: ['Transparent', 'OK'],
      light: ['#000', '#111'],
      dark: ['#000', '#111'],
    });
    expect(css).toContain('--pydm-alarm-none:var(--cr-1)');
    expect(css).not.toContain('--pydm-alarm-major');
    expect(css).not.toContain('--pydm-display-background');
  });
});
