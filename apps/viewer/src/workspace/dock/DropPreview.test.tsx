// The drop preview. Pinned here: an edge (split) and an add-as-tab target (with its
// insertion marker) paint the drop placeholder at the zone, and a dock-edge
// strip (outer target) paints it over the whole new strip; border targets, which no pointer
// zone makes, and a refused or self-drop (no result) paint nothing;
// one rect element glides between zones; the preview clears on drop, dragend, leaving the
// dock and Escape, and comes back on the next result; it never takes pointer events.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import {
  DROP_PREVIEW_CLASS,
  DROP_PREVIEW_MARKER_CLASS,
  DROP_PREVIEW_PLACEHOLDER_CLASS,
  DROP_PREVIEW_RECT_CLASS,
  DropPreview,
  previewKind,
  type DropPreviewKind,
} from './DropPreview.js';
import type { Target, ResultRect } from '@slaclab/canopy-dock-engine';

afterEach(cleanup);

const RECT = { x: 10, y: 20, width: 300, height: 200 };
const result = (marker: ResultRect['marker'] = null): ResultRect => ({ rect: { ...RECT }, marker });

const TARGETS: Array<[string, Target, DropPreviewKind]> = [
  ['an edge', { tile: 'a', edge: 'left' }, 'split'],
  ['the centre', { tile: 'a', zone: 'centre' }, 'tab'],
  ['a tab gap', { tile: 'a', zone: 'tab', index: 1 }, 'tab'],
  ['a dock-edge strip', { outer: 'bottom' }, 'strip'],
];

const rectOf = (container: HTMLElement) =>
  container.querySelector<HTMLElement>(`.${DROP_PREVIEW_RECT_CLASS}`);
const markerOf = (container: HTMLElement) =>
  container.querySelector<HTMLElement>(`.${DROP_PREVIEW_MARKER_CLASS}`);

describe('previewKind', () => {
  it.each(TARGETS)('maps %s to its style', (_, target, kind) => {
    expect(previewKind(target)).toBe(kind);
  });

  it('has no style for border targets', () => {
    expect(previewKind({ border: { tile: 'a', side: 'right' } })).toBeNull();
  });
});

describe('DropPreview: zones', () => {
  it('paints nothing for a border target', () => {
    const { container } = render(
      <DropPreview target={{ border: { tile: 'a', side: 'right' } }} result={result()} />
    );
    expect(rectOf(container)).toBeNull();
  });

  it('paints a strip with the placeholder and no marker', () => {
    const { container } = render(
      <DropPreview target={{ outer: 'bottom' }} result={result({ x: 0, y: 0, height: 30 })} />
    );
    expect(rectOf(container)!.querySelector(`.${DROP_PREVIEW_PLACEHOLDER_CLASS}`)).not.toBeNull();
    expect(markerOf(container)).toBeNull();
  });

  it('keeps one rect element while the zone changes, so it can glide', () => {
    const { container, rerender } = render(
      <DropPreview target={{ tile: 'a', edge: 'left' }} result={result()} />
    );
    const first = rectOf(container)!;
    const moved: ResultRect = { rect: { x: 160, y: 20, width: 150, height: 200 }, marker: null };
    rerender(<DropPreview target={{ tile: 'a', edge: 'right' }} result={moved} />);
    expect(rectOf(container)).toBe(first);
    expect(first.style.left).toBe('160px');
    rerender(<DropPreview target={{ tile: 'a', zone: 'centre' }} result={result()} />);
    expect(rectOf(container)).toBe(first);
    expect(first.dataset.kind).toBe('tab');
  });
});

describe('DropPreview: painting', () => {
  it.each(TARGETS)('paints %s at the result rect in its own style', (_, target, kind) => {
    const { container } = render(<DropPreview target={target} result={result()} />);
    const rect = rectOf(container)!;
    expect(rect).not.toBeNull();
    expect(rect.dataset.kind).toBe(kind);
    expect(rect.classList.contains(`${DROP_PREVIEW_RECT_CLASS}--${kind}`)).toBe(true);
    expect({
      top: rect.style.top,
      left: rect.style.left,
      width: rect.style.width,
      height: rect.style.height,
    }).toEqual({ top: '20px', left: '10px', width: '300px', height: '200px' });
  });

  it('paints the insertion marker for an add-as-tab result', () => {
    const { container } = render(
      <DropPreview
        target={{ tile: 'a', zone: 'tab', index: 1 }}
        result={result({ x: 120, y: 20, height: 28 })}
      />
    );
    const marker = markerOf(container)!;
    expect(marker).not.toBeNull();
    expect({ top: marker.style.top, left: marker.style.left, height: marker.style.height }).toEqual(
      { top: '20px', left: '120px', height: '28px' }
    );
  });

  it('paints no marker when the result has none', () => {
    const { container } = render(
      <DropPreview target={{ tile: 'a', zone: 'centre' }} result={result(null)} />
    );
    expect(markerOf(container)).toBeNull();
  });

  it('paints no marker for a non-tab style even if one is passed', () => {
    const { container } = render(
      <DropPreview target={{ tile: 'a', edge: 'top' }} result={result({ x: 1, y: 2, height: 3 })} />
    );
    expect(markerOf(container)).toBeNull();
  });

  it('paints nothing for a self-drop or refused drop (no result)', () => {
    const { container } = render(
      <DropPreview target={{ tile: 'a', edge: 'left' }} result={null} />
    );
    expect(rectOf(container)).toBeNull();
    expect(markerOf(container)).toBeNull();
  });

  it('paints nothing with no target', () => {
    const { container } = render(<DropPreview target={null} result={result()} />);
    expect(rectOf(container)).toBeNull();
  });

  it('writes no inline pointer-events or stacking style', () => {
    const { container } = render(
      <DropPreview
        target={{ tile: 'a', zone: 'tab', index: 0 }}
        result={result({ x: 1, y: 2, height: 3 })}
      />
    );
    for (const el of container.querySelectorAll<HTMLElement>('*')) {
      expect(el.style.pointerEvents).toBe('');
      expect(el.style.zIndex).toBe('');
      expect(el.style.transform).toBe('');
    }
    expect(container.querySelector(`.${DROP_PREVIEW_CLASS}`)?.getAttribute('aria-hidden')).toBe(
      'true'
    );
  });
});

describe('DropPreview: clearing', () => {
  const setup = (dockRoot: HTMLElement | null = null) => {
    const onClear = vi.fn();
    const target: Target = { tile: 'a', edge: 'left' };
    const first = result();
    const view = render(
      <DropPreview target={target} result={first} dockRoot={dockRoot} onClear={onClear} />
    );
    const rerender = (next: ResultRect | null) =>
      view.rerender(
        <DropPreview target={target} result={next} dockRoot={dockRoot} onClear={onClear} />
      );
    return { ...view, onClear, first, rerender };
  };

  it.each([
    ['drop', () => fireEvent.drop(document)],
    ['dragend', () => fireEvent.dragEnd(document)],
    ['Escape', () => fireEvent.keyDown(document, { key: 'Escape' })],
    ['a drop inside the page', () => fireEvent.drop(document.body)],
  ])('clears on %s', (_, fire) => {
    const { container, onClear } = setup();
    expect(rectOf(container)).not.toBeNull();
    act(() => fire());
    expect(rectOf(container)).toBeNull();
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('does not clear on another key', () => {
    const { container, onClear } = setup();
    act(() => void fireEvent.keyDown(document, { key: 'a' }));
    expect(rectOf(container)).not.toBeNull();
    expect(onClear).not.toHaveBeenCalled();
  });

  it('stays clear on a re-render with the same result, and repaints on the next one', () => {
    const { container, first, rerender } = setup();
    act(() => void fireEvent.dragEnd(document));
    rerender(first);
    expect(rectOf(container)).toBeNull();
    rerender(result());
    expect(rectOf(container)).not.toBeNull();
  });

  describe('leaving the dock', () => {
    // jsdom has no DragEvent, so fireEvent.dragLeave drops relatedTarget and the pointer;
    // a browser's DragEvent is a MouseEvent, which carries both.
    const leave = (from: HTMLElement, init: MouseEventInit) =>
      from.dispatchEvent(new MouseEvent('dragleave', { bubbles: true, ...init }));
    const made: HTMLElement[] = [];
    const dock = () => {
      const root = document.createElement('div');
      made.push(root);
      const child = document.createElement('div');
      root.appendChild(child);
      document.body.appendChild(root);
      root.getBoundingClientRect = () =>
        ({
          left: 0,
          top: 0,
          right: 500,
          bottom: 400,
          width: 500,
          height: 400,
          x: 0,
          y: 0,
        }) as DOMRect;
      return { root, child };
    };
    afterEach(() => {
      for (const el of made.splice(0)) el.remove();
    });

    it('clears when the drag leaves to outside the dock', () => {
      const { root, child } = dock();
      const outside = document.createElement('div');
      made.push(outside);
      document.body.appendChild(outside);
      const { container, onClear } = setup(root);
      act(() => void leave(child, { relatedTarget: outside }));
      expect(rectOf(container)).toBeNull();
      expect(onClear).toHaveBeenCalledTimes(1);
    });

    it('does not clear when the drag moves between elements inside the dock', () => {
      const { root, child } = dock();
      const { container, onClear } = setup(root);
      act(() => void leave(child, { relatedTarget: root }));
      act(() => void leave(root, { relatedTarget: child }));
      expect(rectOf(container)).not.toBeNull();
      expect(onClear).not.toHaveBeenCalled();
    });

    it('with no related target, clears only when the pointer is outside the dock', () => {
      const { root, child } = dock();
      const { container } = setup(root);
      act(() => void leave(child, { clientX: 100, clientY: 100 }));
      expect(rectOf(container)).not.toBeNull();
      act(() => void leave(child, { clientX: 600, clientY: 100 }));
      expect(rectOf(container)).toBeNull();
    });

    it('stops listening once unmounted', () => {
      const { root, child } = dock();
      const { onClear, unmount } = setup(root);
      unmount();
      leave(child, { relatedTarget: null, clientX: 900, clientY: 900 });
      fireEvent.dragEnd(document);
      expect(onClear).not.toHaveBeenCalled();
    });
  });

  it('does not report a clear when nothing is painted', () => {
    const onClear = vi.fn();
    render(<DropPreview target={null} result={null} onClear={onClear} />);
    fireEvent.dragEnd(document);
    expect(onClear).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------
// The stylesheet, read from disk: vitest blanks `.css` imports.

const require = createRequire(import.meta.url);
const css = readFileSync(require.resolve('./dock.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const rules = css
  .split('}')
  .map((rule) => rule.split('{'))
  .filter(([selector]) => selector!.trim() !== '')
  .map(([selector, body = '']) => ({
    selector: selector!.trim(),
    declarations: [...body.matchAll(/([\w-]+)\s*:\s*([^;]+);/g)].map(
      (found) => `${found[1]}: ${found[2]!.trim()}`
    ),
  }));
const rule = (selector: string) => rules.find((r) => r.selector === selector);

describe('dock.css: the drop preview styles', () => {
  it('never lets the preview take pointer events', () => {
    for (const cls of [DROP_PREVIEW_CLASS, DROP_PREVIEW_RECT_CLASS, DROP_PREVIEW_MARKER_CLASS])
      expect(rule(`.${cls}`)?.declarations).toContain('pointer-events: none');
  });

  it('fills the positioned parent so result rects land in its coordinate space', () => {
    const root = rule(`.${DROP_PREVIEW_CLASS}`)!.declarations;
    expect(root).toContain('position: absolute');
    expect(root).toContain('inset: 0');
    expect(rule(`.${DROP_PREVIEW_RECT_CLASS}`)?.declarations).toContain('box-sizing: border-box');
  });

  it('paints the drop placeholder: 4 px inset, 8 px radius, the contract fill, 2 px stroke', () => {
    const placeholder = rule(`.${DROP_PREVIEW_PLACEHOLDER_CLASS}`)!.declarations;
    expect(placeholder).toEqual(
      expect.arrayContaining([
        'inset: 4px',
        'border-radius: 8px',
        'background-color: color-mix(in srgb, var(--canopy-accent) 20%, transparent)',
        'border: 2px solid var(--canopy-accent)',
      ])
    );
  });

  it('glides between zones over 0.25 s on geometry alone', () => {
    const body = css.slice(css.indexOf(`.${DROP_PREVIEW_RECT_CLASS} {`));
    const transition = body.slice(
      body.indexOf('transition:'),
      body.indexOf(';', body.indexOf('transition:'))
    );
    for (const property of ['top', 'left', 'width', 'height'])
      expect(transition).toMatch(new RegExp(`\\b${property} 0\\.25s`));
  });
});
