// Every package of this workspace is read from its source by the siblings that
// import it: the package names its entry under the `canopy-source` export condition,
// and each consumer's resolver asks for that condition — Vite for the tests,
// the dev server and the bundle, tsc for the type check. Built output is what
// gets published; no test or type check depends on it.
// The condition is named for this workspace: `source` is a convention of published
// packages that ship their TypeScript under it, and a resolver asking for it would read
// those packages' sources as well.
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fs.realpathSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
);

/** Each sibling package and its directory. */
const SIBLINGS: Record<string, string> = {
  '@slaclab/canopy-screen-widgets': 'packages/widgets',
  '@slaclab/canopy-screen-runtime': 'packages/runtime',
};

/** Each consumer, its resolver config, and the siblings it imports. */
const CONSUMERS: Record<string, { config: string; imports: string[] }> = {
  'packages/runtime': { config: 'vitest.config.ts', imports: ['@slaclab/canopy-screen-widgets'] },
  'packages/codegen': { config: 'vitest.config.ts', imports: ['@slaclab/canopy-screen-widgets'] },
  'apps/viewer': {
    config: 'vite.config.ts',
    imports: ['@slaclab/canopy-screen-widgets', '@slaclab/canopy-screen-runtime'],
  },
};

/** Where Node resolves `specifier` from `dir`, with `conditions` on top of its defaults. */
function resolveFrom(dir: string, specifier: string, conditions: string[] = []): string {
  const url = execFileSync(
    process.execPath,
    [
      ...conditions.map((c) => `--conditions=${c}`),
      '--input-type=module',
      '-e',
      `console.log(import.meta.resolve(${JSON.stringify(specifier)}))`,
    ],
    { cwd: path.join(root, dir), encoding: 'utf8' }
  ).trim();
  return path.relative(root, realpathOfExisting(fileURLToPath(url)));
}

/**
 * `file` with its deepest existing ancestor's symlinks resolved. Node leaves a
 * resolved path that does not exist (an unbuilt `dist`) on the symlinked
 * `node_modules` route; this puts it back under the package's own directory.
 */
function realpathOfExisting(file: string): string {
  let existing = file;
  while (!fs.existsSync(existing)) existing = path.dirname(existing);
  return path.join(fs.realpathSync(existing), path.relative(existing, file));
}

type ConfigEnv = {
  mode: string;
  command: 'serve' | 'build';
  isSsrBuild: boolean;
  isPreview: boolean;
};
type ResolverConfig = { resolve?: { conditions?: string[] } };

/** The conditions a consumer's Vite config asks for under Vitest and for the bundle. */
async function conditionsOf(
  dir: string,
  config: string
): Promise<{ test: string[]; build: string[] }> {
  const mod = (await import(pathToFileURL(path.join(root, dir, config)).href)) as {
    default: ResolverConfig | ((env: ConfigEnv) => ResolverConfig);
  };
  const inMode = (mode: string, command: 'serve' | 'build'): string[] => {
    const cfg =
      typeof mod.default === 'function'
        ? mod.default({ mode, command, isSsrBuild: false, isPreview: false })
        : mod.default;
    return cfg.resolve?.conditions ?? [];
  };
  return { test: inMode('test', 'serve'), build: inMode('production', 'build') };
}

function manifest(dir: string): {
  exports: Record<string, Record<string, string>>;
  publishConfig: { exports?: Record<string, Record<string, string>> };
} {
  return JSON.parse(fs.readFileSync(path.join(root, dir, 'package.json'), 'utf8'));
}

describe('workspace siblings resolve from source', () => {
  for (const [consumer, { config, imports }] of Object.entries(CONSUMERS)) {
    for (const name of imports) {
      it(`${consumer} reads ${name} from its source under the canopy-source condition`, () => {
        expect(resolveFrom(consumer, name, ['canopy-source'])).toBe(
          path.join(SIBLINGS[name]!, 'src', 'index.ts')
        );
      });
      it(`${consumer} reads ${name} from its built entry otherwise`, () => {
        expect(resolveFrom(consumer, name)).toBe(path.join(SIBLINGS[name]!, 'dist', 'index.js'));
      });
    }
    it(`${consumer}'s resolver asks for the canopy-source condition first`, async () => {
      const { test, build } = await conditionsOf(consumer, config);
      expect(test[0]).toBe('canopy-source');
      expect(test).not.toContain('browser');
      expect(build[0]).toBe('canopy-source');
    });
  }

  it('the type check asks for the canopy-source condition once, in the base config', () => {
    const base = JSON.parse(fs.readFileSync(path.join(root, 'tsconfig.base.json'), 'utf8'));
    expect(base.compilerOptions.customConditions).toEqual(['canopy-source']);
    for (const consumer of Object.keys(CONSUMERS)) {
      const own = JSON.parse(fs.readFileSync(path.join(root, consumer, 'tsconfig.json'), 'utf8'));
      expect(own.extends).toBe(path.relative(consumer, 'tsconfig.base.json'));
      expect(own.compilerOptions).not.toHaveProperty('customConditions');
    }
  });

  for (const [name, dir] of Object.entries(SIBLINGS)) {
    it(`${name} names its source entry first and publishes without it`, () => {
      const pkg = manifest(dir);
      expect(Object.keys(pkg.exports['.']!)[0]).toBe('canopy-source');
      expect(pkg.exports['.']!['canopy-source']).toBe('./src/index.ts');
      const published = pkg.publishConfig.exports;
      expect(published).toBeDefined();
      expect(Object.keys(published!)).toEqual(Object.keys(pkg.exports));
      expect(published!['.']).toEqual({ types: './dist/index.d.ts', import: './dist/index.js' });
    });
  }
});
