// createDock is the single place the viewer constructs a dockview. These tests
// pin the options the rest of the dock relies on: the canopy
// theme with absolute overlay mounting, floating groups off, and the package
// marked loaded so dockview-core prints no core-direct warning. jsdom's
// missing ResizeObserver comes from src/test/setup.ts.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDockview, markDockviewPackageLoaded } from 'dockview-core';
import { createDock } from './createDock.js';

// ESM namespaces cannot be spied on; wrap both entry points in pass-through
// mocks so the real dock is still built and the real warning check runs.
vi.mock('dockview-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('dockview-core')>();
  return {
    ...actual,
    createDockview: vi.fn(actual.createDockview),
    markDockviewPackageLoaded: vi.fn(actual.markDockviewPackageLoaded),
  };
});

const require = createRequire(import.meta.url);
const roots: HTMLElement[] = [];

function mountRoot(): HTMLElement {
  const root = document.createElement('div');
  document.body.appendChild(root);
  roots.push(root);
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  for (const root of roots.splice(0)) root.remove();
});

describe('createDock', () => {
  it('constructs in jsdom without the core-direct warning', () => {
    const warn = vi.spyOn(console, 'warn');
    const api = createDock(mountRoot());
    expect(api).toBeDefined();
    expect(api.panels).toEqual([]);
    const coreDirect = warn.mock.calls.filter((args) =>
      args.some((a) => typeof a === 'string' && a.includes('dockview-core'))
    );
    expect(coreDirect).toEqual([]);
    api.dispose();
  });

  it('marks the package loaded before creating the dock', () => {
    const mark = vi.mocked(markDockviewPackageLoaded);
    const create = vi.mocked(createDockview);
    const api = createDock(mountRoot());
    expect(mark).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(mark.mock.invocationCallOrder[0]).toBeLessThan(create.mock.invocationCallOrder[0]);
    api.dispose();
  });

  it('passes the canopy theme and disables floating groups', () => {
    const create = vi.mocked(createDockview);
    const root = mountRoot();
    const api = createDock(root);
    const [element, options] = create.mock.calls[0];
    expect(element).toBe(root);
    expect(options.disableFloatingGroups).toBe(true);
    expect(options.theme).toEqual({
      name: 'canopy',
      className: 'canopy-dock',
      dndOverlayMounting: 'absolute',
    });
    expect(typeof options.createComponent).toBe('function');
    expect(root.querySelector('.canopy-dock')).not.toBeNull();
    api.dispose();
  });

  it('adds placeholder panels the viewer can mount into', () => {
    const api = createDock(mountRoot());
    const panel = api.addPanel({ id: 'screen:a', component: 'placeholder' });
    expect(api.panels.map((p) => p.id)).toEqual(['screen:a']);
    expect(panel.view.content.element).toBeInstanceOf(HTMLElement);
    api.dispose();
  });

  it('imports the package stylesheet', () => {
    const source = readFileSync(require.resolve('./createDock.ts'), 'utf8');
    expect(source).toContain("import 'dockview-core/dist/styles/dockview.css';");
    expect(require.resolve('dockview-core/dist/styles/dockview.css')).toMatch(/dockview\.css$/);
  });

  it('depends on dockview-core 7.0.2 exactly, which brings no second React copy', () => {
    const viewerPkg = JSON.parse(
      readFileSync(require.resolve('../../../package.json'), 'utf8')
    ) as {
      dependencies: Record<string, string>;
    };
    expect(viewerPkg.dependencies['dockview-core']).toBe('7.0.2');
    const pkg = JSON.parse(readFileSync(require.resolve('dockview-core/package.json'), 'utf8')) as {
      version: string;
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    expect(pkg.version).toBe('7.0.2');
    expect(pkg.dependencies ?? {}).toEqual({});
    expect(pkg.peerDependencies ?? {}).toEqual({});
  });

  it('is the only module that calls createDockview', () => {
    const src = join(dirname(require.resolve('../../../package.json')), 'src');
    const callers = (readdirSync(src, { recursive: true }) as string[])
      .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
      .filter((f) => /\bcreateDockview\s*\(/.test(readFileSync(join(src, f), 'utf8')))
      .map((f) => f.split('\\').join('/'));
    expect(callers).toEqual(['workspace/dock/createDock.ts']);
  });
});
