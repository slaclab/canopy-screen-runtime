// Static guard across packages/widgets, packages/runtime and apps/viewer: no
// `.put(` on a PV handle or service outside the write paths that are allowed
// to call it, so every machine write goes through a provided write gate.
//
// Allowed, by the name of the top-level function the call sits in (never by
// file, and never dispatchActions):
//   useGatedWrite         the widgets' write hook (its pass-through)
//   ScreenPVService       the screen PV scope's forwarder (every non-formula:// name)
//   dispatchLocalWrite    dispatchActions' local / ungated write
// Test files are not scanned (they call put on local services).
import { describe, expect, it } from 'vitest';

const sources: Record<string, string> = import.meta.glob(
  [
    '../../../../packages/widgets/src/**/*.{ts,tsx}',
    '../../../../packages/runtime/src/**/*.{ts,tsx}',
    '../**/*.{ts,tsx}',
    '!../../../../packages/*/src/**/*.test.{ts,tsx}',
    '!../**/*.test.{ts,tsx}',
  ],
  { query: '?raw', import: 'default', eager: true }
);

const ALLOWED_FUNCTIONS: ReadonlySet<string> = new Set([
  'useGatedWrite',
  'ScreenPVService',
  'dispatchLocalWrite',
]);

const PUT_CALL = /\.\s*put\s*\(/;
const TOP_LEVEL_DECL =
  /^(?:export\s+)?(?:default\s+)?(?:(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)|(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*))/;

/** Whether a line is a comment line (`//`, `/*`, ` *`), which calls nothing. */
function isComment(line: string): boolean {
  const t = line.trimStart();
  return t.startsWith('//') || t.startsWith('/*') || t.startsWith('*');
}

/**
 * Every `.put(` in `text` outside an allowed top-level function, as
 * `<file>:<line>: <text>`. The enclosing function is the last top-level
 * declaration (column 0) before the line, until its closing `}` at column 0.
 */
function putOffenders(file: string, text: string): string[] {
  const offenders: string[] = [];
  let current: string | null = null;
  text.split('\n').forEach((line, i) => {
    const decl = TOP_LEVEL_DECL.exec(line);
    if (decl) current = decl[1] ?? decl[2] ?? decl[3] ?? null;
    if (!isComment(line) && PUT_CALL.test(line)) {
      if (current === null || !ALLOWED_FUNCTIONS.has(current)) {
        offenders.push(`${file}:${i + 1}: ${line.trim()}`);
      }
    }
    if (/^\}/.test(line)) current = null;
  });
  return offenders;
}

describe('no .put( outside the gated write paths', () => {
  it('scans all three trees, test files excluded', () => {
    const files = Object.keys(sources);
    const has = (suffix: string) => files.some((f) => f.endsWith(suffix));
    expect(has('packages/widgets/src/writeGate/useGatedWrite.ts')).toBe(true);
    expect(has('packages/widgets/src/pv-wrappers/CarbonWidgets.tsx')).toBe(true);
    expect(has('packages/runtime/src/actions/dispatch.ts')).toBe(true);
    expect(has('packages/runtime/src/screenPV.ts')).toBe(true);
    expect(has('packages/runtime/src/render/ScreenRenderer.tsx')).toBe(true);
    expect(has('../services.ts')).toBe(true);
    expect(has('./gate.ts')).toBe(true);
    expect(files.some((f) => /\.test\.tsx?$/.test(f))).toBe(false);
  });

  it('sees the allowed calls where they are', () => {
    const calls = (suffix: string) => {
      const [file, text] = Object.entries(sources).find(([f]) => f.endsWith(suffix))!;
      return { file, n: text.split('\n').filter((l) => PUT_CALL.test(l)).length };
    };
    expect(calls('writeGate/useGatedWrite.ts').n).toBeGreaterThan(0);
    expect(calls('runtime/src/screenPV.ts').n).toBe(1);
    expect(calls('actions/dispatch.ts').n).toBe(1);
  });

  it('finds .put( nowhere else', () => {
    const offenders = Object.entries(sources).flatMap(([file, text]) => putOffenders(file, text));
    expect(offenders).toEqual([]);
  });
});

describe('putOffenders', () => {
  it('flags a put inside dispatchActions, whatever the file', () => {
    const src = [
      'export async function dispatchActions(actions, ctx) {',
      '  await ctx.pvService.put(pv, value);',
      '}',
    ].join('\n');
    expect(putOffenders('dispatch.ts', src)).toEqual([
      'dispatch.ts:2: await ctx.pvService.put(pv, value);',
    ]);
  });

  it('allows the named helpers, and only inside them', () => {
    const src = [
      'export async function dispatchLocalWrite(ctx, pv, value) {',
      '  await ctx.pvService.put(pv, value);',
      '}',
      'svc.put(1);',
      'const helper = () => svc. put (2);',
      'export class ScreenPVService {',
      '  forward(n, v) { return this.parent.put(n, v); }',
      '}',
    ].join('\n');
    expect(putOffenders('x.ts', src)).toEqual([
      'x.ts:4: svc.put(1);',
      'x.ts:5: const helper = () => svc. put (2);',
    ]);
  });

  it('ignores comment lines and put definitions', () => {
    const src = [
      '// ctx.pvService.put(pv, value) used to run here',
      '/** handle.put(v) */',
      'class LocalStore {',
      '  put(pv, value) {}',
      '}',
    ].join('\n');
    expect(putOffenders('y.ts', src)).toEqual([]);
  });
});
