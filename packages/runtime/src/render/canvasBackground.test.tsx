// The absolute-canvas root paints its backgroundColor prop. After role
// resolution that prop is a resolved CSS string, so a converted
// `Display_Background` role paints as its scheme variable and an out-of-scheme
// role as `light-dark(...)`. jsdom drops `light-dark()` from element.style, so
// the assertions record the string handed to the canvas's style setter rather
// than reading it back; the per-mode paint is covered by the e2e suite.

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MockPVService } from '@slaclab/canopy-client';
import { PVServiceProvider } from '@slaclab/canopy-react';
import { canopyDefaultFlat } from '@slaclab/canopy-screen-ir';
import type { PropertyValue, ScreenJSON } from '@slaclab/canopy-screen-ir';
import { registerBuiltinWidgets } from '@slaclab/canopy-screen-widgets';
import { ScreenRenderer } from './ScreenRenderer.js';

let service: MockPVService;
let restoreSetter: (() => void) | undefined;
let assigned: Array<{ style: CSSStyleDeclaration; value: string }>;

beforeAll(() => {
  registerBuiltinWidgets();
});

beforeEach(() => {
  service = new MockPVService();
  service.connect();
  assigned = [];
  const proto = CSSStyleDeclaration.prototype;
  const original = Object.getOwnPropertyDescriptor(proto, 'backgroundColor');
  if (!original?.set) throw new Error('jsdom has no backgroundColor setter on the prototype');
  Object.defineProperty(proto, 'backgroundColor', {
    ...original,
    set(this: CSSStyleDeclaration, value: string) {
      assigned.push({ style: this, value });
      original.set!.call(this, value);
    },
  });
  restoreSetter = () => Object.defineProperty(proto, 'backgroundColor', original);
});

afterEach(() => {
  cleanup();
  service.disconnect();
  restoreSetter?.();
  restoreSetter = undefined;
});

function wrap(children: ReactNode) {
  return <PVServiceProvider service={service}>{children}</PVServiceProvider>;
}

function doc(backgroundColor: PropertyValue): ScreenJSON {
  return {
    schemaVersion: '1.0',
    kind: 'screen',
    id: 'canvas-bg',
    metadata: { title: 't', source: { type: 'hand-authored' }, size: { width: 300, height: 100 } },
    macros: [],
    root: {
      id: 'root',
      type: 'absolute-canvas',
      props: { backgroundColor },
      geometry: { x: 0, y: 0, width: 300, height: 100 },
      children: [],
    },
  };
}

function canvas(): HTMLElement {
  const el = screen.getByTestId('screen-root').firstElementChild;
  if (!(el instanceof HTMLElement)) throw new Error('no canvas element under screen-root');
  return el;
}

/** The backgroundColor strings handed to the canvas element's style. */
function canvasBackgrounds(): string[] {
  const style = canvas().style;
  return assigned.filter((a) => a.style === style).map((a) => a.value);
}

const displayBackground = canopyDefaultFlat.roles.indexOf('Display_Background');

describe('absolute-canvas background', () => {
  it('paints a converted Display_Background role as its scheme variable', () => {
    expect(displayBackground).toBeGreaterThanOrEqual(0);
    render(
      wrap(<ScreenRenderer screen={doc({ $role: 'Display_Background', fallback: '#ffffff' })} />)
    );
    const expected = `var(--cr-${displayBackground}, #ffffff)`;
    expect(canvasBackgrounds()).toEqual([expected]);
    expect(canvas().style.backgroundColor).toBe(expected);
  });

  it('paints an out-of-scheme role as light-dark() of its fallbacks', () => {
    render(
      wrap(
        <ScreenRenderer
          screen={doc({ $role: 'site.panel', fallback: '#101010', fallbackDark: '#efefef' })}
        />
      )
    );
    expect(canvasBackgrounds()).toEqual(['light-dark(#101010, #efefef)']);
  });

  it('paints an out-of-scheme role without fallbackDark with its fallback in both modes', () => {
    render(wrap(<ScreenRenderer screen={doc({ $role: 'site.panel', fallback: '#101010' })} />));
    expect(canvasBackgrounds()).toEqual(['light-dark(#101010, #101010)']);
  });

  it('paints a literal background unchanged', () => {
    render(wrap(<ScreenRenderer screen={doc('#123456')} />));
    expect(canvasBackgrounds()).toEqual(['#123456']);
    expect(canvas().style.backgroundColor).toBe('rgb(18, 52, 86)');
  });
});
