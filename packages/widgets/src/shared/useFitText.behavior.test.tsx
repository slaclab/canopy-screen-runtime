import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { useFitText } from './useFitText.js';

// jsdom does no layout, so stub the box metrics the hook measures: a fixed
// 100×20 box whose content is 10px wide per px of the element's inline
// font-size. Anything above 10px overflows horizontally.
const METRICS = ['clientWidth', 'clientHeight', 'scrollWidth', 'scrollHeight'] as const;
const originals = new Map<string, PropertyDescriptor | undefined>();
const fontPx = (el: HTMLElement) => parseFloat(el.style.fontSize) || 0;

beforeAll(() => {
  for (const key of METRICS) {
    originals.set(key, Object.getOwnPropertyDescriptor(HTMLElement.prototype, key));
  }
  const stub = (key: string, get: (this: HTMLElement) => number) =>
    Object.defineProperty(HTMLElement.prototype, key, { configurable: true, get });
  stub('clientWidth', () => 100);
  stub('clientHeight', () => 20);
  stub('scrollWidth', function () {
    return fontPx(this) * 10;
  });
  stub('scrollHeight', () => 20);
});

afterAll(() => {
  for (const key of METRICS) {
    const original = originals.get(key);
    if (original) Object.defineProperty(HTMLElement.prototype, key, original);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key];
  }
});

afterEach(cleanup);

function Probe({ max, enabled }: { max: number; enabled: boolean }) {
  const { ref, fontSize } = useFitText<HTMLSpanElement>(max, [], undefined, enabled);
  return (
    <span ref={ref} data-testid="probe" style={{ fontSize }}>
      text
    </span>
  );
}

describe('useFitText enabled flag', () => {
  it('shrinks overflowing text when enabled', () => {
    const { getByTestId } = render(<Probe max={48} enabled />);
    expect(fontPx(getByTestId('probe'))).toBeLessThanOrEqual(10);
  });

  it('applies maxFontSize literally when disabled', () => {
    const { getByTestId } = render(<Probe max={48} enabled={false} />);
    expect(fontPx(getByTestId('probe'))).toBe(48);
  });

  it('switches between literal and fitted sizes when toggled', () => {
    const { getByTestId, rerender } = render(<Probe max={48} enabled />);
    expect(fontPx(getByTestId('probe'))).toBeLessThanOrEqual(10);

    rerender(<Probe max={48} enabled={false} />);
    expect(fontPx(getByTestId('probe'))).toBe(48);

    rerender(<Probe max={48} enabled />);
    expect(fontPx(getByTestId('probe'))).toBeLessThanOrEqual(10);
  });
});
