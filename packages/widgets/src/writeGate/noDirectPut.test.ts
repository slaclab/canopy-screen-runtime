// Static guard: in this package only the write hook calls a PV handle's put.
// Every other write goes through useGatedWrite, so a provided WriteGate sees it.
// (The cross-package scan — runtime and viewer — lives with the viewer's gate.)
import { describe, expect, it } from 'vitest';

declare global {
  interface ImportMeta {
    glob(
      pattern: string | string[],
      options: { query: string; import: string; eager: true }
    ): Record<string, string>;
  }
}

const sources = import.meta.glob(['../**/*.ts', '../**/*.tsx'], {
  query: '?raw',
  import: 'default',
  eager: true,
});

// Vite keys same-directory matches as './<file>'.
const HOOK = './useGatedWrite.ts';
const SELF = './noDirectPut.test.ts';
const PUT_CALL = new RegExp(String.raw`\.\s*put\s*\(`);

describe('no direct .put( in packages/widgets', () => {
  it('scans the package sources, the hook among them', () => {
    expect(Object.keys(sources)).toContain(HOOK);
    expect(Object.keys(sources)).toContain('../pv-wrappers/CarbonWidgets.tsx');
    expect(PUT_CALL.test(sources[HOOK])).toBe(true);
  });

  it('finds .put( nowhere outside the hook', () => {
    const offenders: string[] = [];
    for (const [file, text] of Object.entries(sources)) {
      if (file === HOOK || file === SELF) continue;
      text.split('\n').forEach((line, i) => {
        if (PUT_CALL.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
