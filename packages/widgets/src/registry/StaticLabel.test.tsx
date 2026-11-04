// StaticLabel (IR text-label) honours the IR's alignment, font family,
// colours and authored line breaks.

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { WidgetProps } from '../types.js';
import { RenderModeContext } from '../renderMode.js';
import type { RenderMode } from '../renderMode.js';
import { widgetRegistry } from './WidgetRegistry.js';
import { registerBuiltinWidgets } from './registerBuiltins.js';

beforeAll(() => registerBuiltinWidgets());
afterEach(cleanup);

function renderLabel(props: WidgetProps, mode: RenderMode = 'edm') {
  const StaticLabel = widgetRegistry.get('StaticLabel')!.component;
  const { container } = render(
    <RenderModeContext.Provider value={mode}>
      <StaticLabel
        id="t"
        type="StaticLabel"
        layout={{ x: 0, y: 0, width: 120, height: 20 }}
        props={props}
        isSelected={false}
        isEditing={false}
      />
    </RenderModeContext.Provider>
  );
  const box = container.firstElementChild as HTMLElement;
  return { box, text: box.querySelector('span') as HTMLElement };
}

describe('StaticLabel', () => {
  it.each([
    ['center', 'center'],
    ['right', 'flex-end'],
  ] as const)('places align=%s text in the box (%s)', (align, justify) => {
    const { box, text } = renderLabel({ text: 'Value', align });
    expect(box.style.justifyContent).toBe(justify);
    expect(text.style.textAlign).toBe(align);
  });

  it('is left-aligned when the IR carries no align (the IR default)', () => {
    const { box, text } = renderLabel({ text: 'Value' });
    expect(box.style.justifyContent).toBe('flex-start');
    expect(text.style.textAlign).toBe('left');
  });

  it('honours fontFamily and the IR colours', () => {
    const { box, text } = renderLabel({
      text: 'Value',
      fontFamily: 'Courier',
      foregroundColor: '#2d2d2d',
      backgroundColor: '#dadada',
    });
    expect(text.style.fontFamily).toBe('Courier');
    expect(box.style.color).toBe('rgb(45, 45, 45)');
    expect(box.style.backgroundColor).toBe('rgb(218, 218, 218)');
  });

  it('keeps authored line breaks (EDM draws one line per newline)', () => {
    const { text } = renderLabel({ text: 'FLOW = Open-Loop\nPRESS = PID Ctrl.' });
    expect(text.style.whiteSpace).toBe('pre');
    expect(text.textContent).toBe('FLOW = Open-Loop\nPRESS = PID Ctrl.');
  });

  it('draws text flush like EDM static text in edm mode, Carbon 4px inset in carbon', () => {
    expect(renderLabel({ text: 'Value' }, 'edm').box.style.padding).toBe('0px');
    cleanup();
    expect(renderLabel({ text: 'Value' }, 'carbon').box.style.padding).toBe('0px 4px');
  });
});
