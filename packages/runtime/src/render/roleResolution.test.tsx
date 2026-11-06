// Color roles in widget props resolve to CSS strings before the widget sees
// them. Assertions read the props a probe widget receives, never
// element.style: jsdom drops `light-dark()` from inline styles.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MockPVService } from '@slaclab/canopy-client';
import { PVServiceProvider } from '@slaclab/canopy-react';
import { canopyDefaultFlat } from '@slaclab/canopy-screen-ir';
import type { FlatScheme, PropertyValue, ScreenJSON, WidgetNode } from '@slaclab/canopy-screen-ir';
import { registerBuiltinWidgets, widgetRegistry } from '@slaclab/canopy-screen-widgets';
import { ScreenRenderer } from './ScreenRenderer.js';

let service: MockPVService;

beforeAll(() => {
  registerBuiltinWidgets();
  // pv-tank copies its IR props verbatim to the catalog type PVTank, which the
  // builtins leave unregistered: a probe that prints the props it receives.
  widgetRegistry.register({
    type: 'PVTank',
    label: 'Probe',
    category: 'indicator',
    icon: 'x',
    defaultLayout: { x: 0, y: 0, width: 10, height: 10 },
    defaultProps: {},
    component: ({ id, props }: { id: string; props: Record<string, unknown> }) => (
      <pre data-testid={`probe-${id}`}>{JSON.stringify(props)}</pre>
    ),
    propsSchema: [],
  });
});

beforeEach(() => {
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

function probe(id: string, props: Record<string, PropertyValue>, rules?: WidgetNode['rules']) {
  const node: WidgetNode = {
    id,
    type: 'pv-tank',
    props,
    geometry: { x: 0, y: 0, width: 100, height: 20 },
  };
  return rules ? { ...node, rules } : node;
}

function doc(children: WidgetNode[], id = 'roles'): ScreenJSON {
  return {
    schemaVersion: '1.0',
    kind: 'screen',
    id,
    metadata: { title: 't', source: { type: 'hand-authored' }, size: { width: 300, height: 100 } },
    macros: [],
    root: {
      id: 'root',
      type: 'absolute-canvas',
      props: {},
      geometry: { x: 0, y: 0, width: 300, height: 100 },
      children,
    },
  };
}

function propsOf(id: string): Record<string, unknown> {
  return JSON.parse(screen.getByTestId(`probe-${id}`).textContent ?? '{}') as Record<
    string,
    unknown
  >;
}

function deepFreeze<T>(x: T): T {
  if (x !== null && typeof x === 'object') {
    for (const v of Object.values(x)) deepFreeze(v);
    Object.freeze(x);
  }
  return x;
}

const okIndex = canopyDefaultFlat.roles.indexOf('OK');

describe('role resolution in the renderer', () => {
  it('resolves in-scheme and out-of-scheme roles against canopy-default by default', () => {
    render(
      wrap(
        <ScreenRenderer
          screen={doc([
            probe('w', {
              foregroundColor: { $role: 'OK', fallback: '#00ff00' },
              backgroundColor: { $role: 'site.x', fallback: '#101010', fallbackDark: '#efefef' },
              borderColor: { $role: 'site.y', fallback: '#202020' },
            }),
          ])}
        />
      )
    );
    expect(propsOf('w')).toMatchObject({
      foregroundColor: `var(--cr-${okIndex}, #00ff00)`,
      backgroundColor: 'light-dark(#101010, #efefef)',
      borderColor: 'light-dark(#202020, #202020)',
    });
  });

  it('resolves against the colorScheme prop when one is given', () => {
    const scheme: FlatScheme = {
      ...canopyDefaultFlat,
      roles: ['site.x', 'OK'],
      light: ['#000001', '#000002'],
      dark: ['#000003', '#000004'],
    };
    render(
      wrap(
        <ScreenRenderer
          colorScheme={scheme}
          screen={doc([
            probe('w', {
              foregroundColor: { $role: 'OK', fallback: '#00ff00' },
              backgroundColor: { $role: 'site.x', fallback: '#101010' },
            }),
          ])}
        />
      )
    );
    expect(propsOf('w')).toMatchObject({
      foregroundColor: 'var(--cr-1, #00ff00)',
      backgroundColor: 'var(--cr-0, #101010)',
    });
  });

  it('resolves roles nested in curves[].color', () => {
    render(
      wrap(
        <ScreenRenderer
          screen={doc([
            probe('w', {
              curves: [
                { channel: 'A', color: { $role: 'OK', fallback: '#00ff00' } },
                { channel: 'B', color: '#123456' },
              ],
            }),
          ])}
        />
      )
    );
    expect(propsOf('w').curves).toEqual([
      { channel: 'A', color: `var(--cr-${okIndex}, #00ff00)` },
      { channel: 'B', color: '#123456' },
    ]);
  });

  it('leaves a frozen IR document unmutated', () => {
    const frozen = deepFreeze(
      doc([
        probe('w', {
          foregroundColor: { $role: 'OK', fallback: '#00ff00' },
          curves: [{ color: { $role: 'site.x', fallback: '#010203' } }],
        }),
      ])
    );
    const snapshot = JSON.parse(JSON.stringify(frozen)) as unknown;
    render(wrap(<ScreenRenderer screen={frozen} />));
    expect(propsOf('w').foregroundColor).toBe(`var(--cr-${okIndex}, #00ff00)`);
    expect(frozen).toEqual(snapshot);
  });

  it('a static rule with a ColorRole default resolves the role against the scheme', () => {
    render(
      wrap(
        <ScreenRenderer
          screen={doc([
            probe('w', { foregroundColor: '#ffffff' }, [
              {
                id: 'r1',
                name: 'color',
                targetProperty: 'foregroundColor',
                pvs: [],
                conditions: [],
                default: { $role: 'MAJOR', fallback: '#ff0000' },
              },
            ]),
          ])}
        />
      )
    );
    const majorIndex = canopyDefaultFlat.roles.indexOf('MAJOR');
    expect(majorIndex).toBeGreaterThanOrEqual(0);
    expect(propsOf('w').foregroundColor).toBe(`var(--cr-${majorIndex}, #ff0000)`);
  });

  it('resolves one shared embedded document per instance without cross-talk', async () => {
    // One frozen child document backs both instances (as GTL shares one
    // document across all its instances); each instance substitutes its own
    // macros and resolves roles against the top root's scheme.
    const child = deepFreeze<ScreenJSON>({
      ...doc(
        [
          probe('c', {
            label: '${N}',
            foregroundColor: { $role: 'OK', fallback: '#00ff00' },
            backgroundColor: { $role: 'site.${N}', fallback: '#101010' },
          }),
        ],
        'child'
      ),
      macros: [{ name: 'N', default: 'none' }],
    });
    const snapshot = JSON.parse(JSON.stringify(child)) as unknown;
    const resolveScreen = vi.fn().mockResolvedValue(child);
    const scheme: FlatScheme = {
      ...canopyDefaultFlat,
      roles: ['site.a', 'OK'],
      light: ['#000001', '#000002'],
      dark: ['#000003', '#000004'],
    };
    const embed = (id: string, n: string): WidgetNode => ({
      id,
      type: 'embedded-display',
      props: { file: 'child.screen.json', macros: { N: n } },
      geometry: { x: 0, y: 0, width: 100, height: 50 },
    });
    render(
      wrap(
        <ScreenRenderer
          colorScheme={scheme}
          resolveScreen={resolveScreen}
          screen={doc([embed('e1', 'a'), embed('e2', 'b')])}
        />
      )
    );
    await waitFor(() => expect(screen.getAllByTestId('probe-c')).toHaveLength(2));
    const probes = screen.getAllByTestId('probe-c');
    const seen = probes.map((p) => JSON.parse(p.textContent ?? '{}') as Record<string, unknown>);
    const byLabel = Object.fromEntries(seen.map((p) => [p.label, p]));
    expect(byLabel.a).toMatchObject({
      foregroundColor: 'var(--cr-1, #00ff00)',
      backgroundColor: 'var(--cr-0, #101010)',
    });
    expect(byLabel.b).toMatchObject({
      foregroundColor: 'var(--cr-1, #00ff00)',
      backgroundColor: 'light-dark(#101010, #101010)',
    });
    expect(child).toEqual(snapshot);
  });
});
