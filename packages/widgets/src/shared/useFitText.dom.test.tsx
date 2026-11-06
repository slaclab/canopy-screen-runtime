// useFitText against a laid-out DOM: the text fits its PARENT's content box.
// jsdom has no layout, so element metrics are stubbed per element: the text
// span reports a content width proportional to its font size, and a glyph
// extent one pixel taller than its own client box at every size, as a
// blockified flex item whose line-height equals its font size does.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { useFitText } from './useFitText.js';

function Label({ text, maxFontSize }: { text: string; maxFontSize: number }) {
  const { ref, fontSize } = useFitText<HTMLSpanElement>(maxFontSize, [text]);
  return (
    <div data-testid="box" style={{ padding: '0 1px' }}>
      <span ref={ref} data-testid="text" style={{ fontSize }}>
        {text}
      </span>
    </div>
  );
}

/** Stubs layout: the box is `boxW` x `boxH`; the text is `charW` x font size per character. */
function stubLayout(boxW: number, boxH: number, charW: number) {
  const size = (el: Element) => parseFloat((el as HTMLElement).style.fontSize) || 0;
  const isText = (el: Element) => (el as HTMLElement).dataset.testid === 'text';
  const isBox = (el: Element) => (el as HTMLElement).dataset.testid === 'box';
  const textWidth = (el: Element) => (el.textContent ?? '').length * charW * size(el);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    if (isBox(this)) return boxW;
    return isText(this) ? Math.min(textWidth(this), boxW) : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    if (isBox(this)) return boxH;
    return isText(this) ? size(this) : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    return isText(this) ? textWidth(this) : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    return isText(this) ? size(this) + 1 : 0;
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('useFitText in a box', () => {
  it('keeps the authored size when the text fits the parent box', () => {
    // 'Facility overview' (17 chars) at 18 px x 0.55 = 168 px wide, 19 px tall: fits 300 x 26.
    stubLayout(300, 26, 0.55);
    render(<Label text="Facility overview" maxFontSize={18} />);
    expect(screen.getByTestId('text').style.fontSize).toBe('18px');
  });

  it('shrinks when the text is wider than the parent box, less its padding', () => {
    // 168 px of text in a 100 px box (98 px after padding): shrinks, stays above the floor.
    stubLayout(100, 26, 0.55);
    render(<Label text="Facility overview" maxFontSize={18} />);
    const size = parseFloat(screen.getByTestId('text').style.fontSize);
    expect(size).toBeLessThan(18);
    expect(size).toBeGreaterThan(8);
    expect(17 * 0.55 * size).toBeLessThanOrEqual(98);
  });

  it('shrinks when the text is taller than the parent box', () => {
    stubLayout(300, 12, 0.55);
    render(<Label text="Facility overview" maxFontSize={18} />);
    expect(parseFloat(screen.getByTestId('text').style.fontSize)).toBeLessThanOrEqual(11);
  });
});
