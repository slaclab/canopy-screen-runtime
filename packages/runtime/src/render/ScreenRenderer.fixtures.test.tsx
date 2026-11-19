// Acceptance: every IR fixture renders under the runtime with mock PV data.
// Fixtures come from the builder/screen-ir conformance corpus:
//  - p1_widgets.screen.json      (edl-converter golden output)
//  - formula-driven.screen.json  (formula arm + formula:// refs)
//  - simple.screen.json          (importer fixture: containers, unknown widget)
//  - vacuum-system.screen.json   (example: rules, embedded display, macros)

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MockPVService } from '@slaclab/canopy-client';
import { PVServiceProvider } from '@slaclab/canopy-react';
import { registerBuiltinWidgets } from '@slaclab/canopy-screen-widgets';
import type { ScreenJSON } from '@slaclab/canopy-screen-ir';
import { ScreenRenderer } from './ScreenRenderer.js';

import p1 from '../../test/fixtures/p1_widgets.screen.json' with { type: 'json' };
import formulaDriven from '../../test/fixtures/formula-driven.screen.json' with { type: 'json' };
import simple from '../../test/fixtures/simple.screen.json' with { type: 'json' };
import vacuum from '../../test/fixtures/vacuum-system.screen.json' with { type: 'json' };

let service: MockPVService;

beforeAll(() => {
  registerBuiltinWidgets();
});

beforeEach(() => {
  // Real timers: the embedded-screen tests await resolveScreen promises via
  // waitFor. MockPVService's simulation intervals are cleared by disconnect.
  service = new MockPVService();
  service.connect();
});

afterEach(() => {
  cleanup();
  service.disconnect();
});

function wrap(children: ReactNode) {
  return <PVServiceProvider service={service}>{children}</PVServiceProvider>;
}

describe('ScreenRenderer — fixture corpus', () => {
  it('renders the edl-converter golden fixture (p1_widgets)', () => {
    const { container } = render(wrap(<ScreenRenderer screen={p1 as unknown as ScreenJSON} />));

    expect(screen.getByTestId('screen-root').dataset.screenId).toBe('screen');
    // related-display-button degrades to a labeled button.
    expect(screen.getByText('Open')).toBeTruthy();
    // Nothing crashed.
    expect(container.querySelectorAll('[data-testid="widget-error"]')).toHaveLength(0);
  });

  it('renders the formula-driven fixture with rules inert (no subscriber)', () => {
    const { container } = render(
      wrap(<ScreenRenderer screen={formulaDriven as unknown as ScreenJSON} />)
    );
    expect(screen.getByTestId('screen-root').dataset.screenId).toBe('formula-driven');
    expect(container.querySelectorAll('[data-testid="widget-error"]')).toHaveLength(0);
  });

  it('renders the importer fixture (simple): containers, labels, unknown widget placeholder', () => {
    const { container } = render(wrap(<ScreenRenderer screen={simple as unknown as ScreenJSON} />));

    // StaticLabel and nested group-box child button.
    expect(screen.getByText('Status')).toBeTruthy();
    expect(screen.getByText('Go')).toBeTruthy();
    // unknown-widget renders a labeled placeholder, never a crash.
    const placeholder = screen.getByTestId('widget-placeholder');
    expect(placeholder.textContent).toContain('activeRectangleClass');
    expect(container.querySelectorAll('[data-testid="widget-error"]')).toHaveLength(0);
  });

  it('renders the vacuum example, resolving its embedded display with chained macros', async () => {
    const motorScreen: ScreenJSON = {
      schemaVersion: '1.0',
      kind: 'template',
      id: 'motor-control',
      metadata: {
        title: 'Motor',
        source: { type: 'hand-authored' },
        size: { width: 400, height: 200 },
      },
      macros: [{ name: 'MOTOR' }],
      root: {
        id: 'm-001',
        type: 'absolute-canvas',
        props: {},
        geometry: { x: 0, y: 0, width: 400, height: 200 },
        children: [
          {
            id: 'm-002',
            type: 'text-label',
            props: { text: 'Motor ${MOTOR}' },
            geometry: { x: 0, y: 0, width: 200, height: 20 },
          },
        ],
      },
    };
    const resolveScreen = vi.fn().mockResolvedValue(motorScreen);

    render(
      wrap(
        <ScreenRenderer screen={vacuum as unknown as ScreenJSON} resolveScreen={resolveScreen} />
      )
    );

    expect(resolveScreen).toHaveBeenCalledWith('motor-control.screen.json');
    // Embedded node macros { MOTOR: "${PREFIX}:M1" } resolve against the
    // parent's PREFIX default DEMO:VAC1 before flowing into the child.
    await waitFor(() => {
      expect(screen.getByText('Motor DEMO:VAC1:M1')).toBeTruthy();
    });
    expect(screen.getByTestId('embedded-screen').dataset.screenId).toBe('motor-control');
  });

  it('substitutes caller macro overrides across props (vacuum with PREFIX override)', async () => {
    const resolveScreen = vi.fn().mockResolvedValue({
      schemaVersion: '1.0',
      kind: 'screen',
      id: 'sub',
      metadata: { title: 's', source: { type: 'hand-authored' }, size: { width: 10, height: 10 } },
      macros: [{ name: 'MOTOR', default: 'unset' }],
      root: {
        id: 's-root',
        type: 'text-label',
        props: { text: '${MOTOR}' },
        geometry: { x: 0, y: 0, width: 10, height: 10 },
      },
    } satisfies ScreenJSON);

    render(
      wrap(
        <ScreenRenderer
          screen={vacuum as unknown as ScreenJSON}
          macros={{ PREFIX: 'XX00:9' }}
          resolveScreen={resolveScreen}
        />
      )
    );

    await waitFor(() => {
      expect(screen.getByText('XX00:9:M1')).toBeTruthy();
    });
  });
});
