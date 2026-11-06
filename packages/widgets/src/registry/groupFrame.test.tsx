// A titled Group (a converted group-box) draws its frame and title in the
// foreground it is given; an untitled Group stays an invisible container.

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { widgetRegistry } from './WidgetRegistry.js';
import { registerBuiltinWidgets } from './registerBuiltins.js';
import type { WidgetRendererProps } from './WidgetRegistry.js';

beforeAll(() => registerBuiltinWidgets());
afterEach(cleanup);

function renderGroup(props: WidgetRendererProps['props'], isEditing = false) {
  const def = widgetRegistry.get('Group');
  if (!def) throw new Error('Group is not registered');
  const Group = def.component;
  return render(
    <Group
      id="g"
      type="Group"
      layout={{ x: 0, y: 0, width: 200, height: 100 }}
      props={props}
      isSelected={false}
      isEditing={isEditing}
    >
      <span>child</span>
    </Group>
  );
}

describe('Group frame', () => {
  it('draws the title and the frame in the foreground colour', () => {
    const { container } = renderGroup({ label: 'LLRF 1', foregroundColor: 'var(--cr-3, #000)' });
    const title = screen.getByText('LLRF 1');
    expect(title.style.color).toBe('var(--cr-3, #000)');
    const frame = container.querySelector('fieldset') as HTMLElement;
    expect(frame).not.toBeNull();
    expect(frame.style.borderColor).toBe('var(--cr-3, #000)');
    expect(screen.getByText('child')).toBeTruthy();
  });

  it('inherits the text colour when no foreground is given', () => {
    const { container } = renderGroup({ label: 'Sub-systems' });
    const frame = container.querySelector('fieldset') as HTMLElement;
    expect(frame.style.borderColor).toBe('currentcolor');
    expect(screen.getByText('Sub-systems').style.color).toBe('');
  });

  it('draws no frame for an untitled group at runtime', () => {
    const { container } = renderGroup({});
    expect(container.querySelector('fieldset')).toBeNull();
  });
});
