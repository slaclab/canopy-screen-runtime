// Source-structure guard for the viewer entry. main.tsx cannot be imported in
// a test (top-level await, createRoot side effects), yet two things in it are
// order-sensitive and invisible to every behavioural test:
//
//   - the stylesheet cascade: Carbon (index.scss), then the shell's own sheet,
//     then the shell's host contract directly after it, then the widgets' sheet
//     and the viewer's own. The host contract has to follow the shell sheet it
//     re-points and precede every sheet that reads its tokens.
//   - the host-sheet fallback, which must have run before the first render so
//     the app never paints with a host marker whose tokens are undefined.
import { describe, expect, it } from 'vitest';
import source from './main.tsx?raw';

/** Source without comments, so prose mentioning a symbol never counts. */
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** Module specifier of every import statement, in source order. */
const imports = Array.from(
  code.matchAll(/^import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"];?\s*$/gm),
  (m) => m[1]
);

/** Offsets of every match of `re` (global) in the comment-free source. */
function offsets(re: RegExp): number[] {
  return Array.from(code.matchAll(re), (m) => m.index);
}

describe('viewer main.tsx structure', () => {
  it('finds the import statements', () => {
    expect(imports).toContain('react-dom/client');
    expect(imports).toContain('./index.css');
  });

  it('imports each stylesheet exactly once', () => {
    for (const sheet of [
      './index.scss',
      '@slaclab/canopy-shell/styles.css',
      '@slaclab/canopy-shell/host-contract.css',
      '@slaclab/canopy-screen-widgets/styles.css',
      './index.css',
    ]) {
      expect(
        imports.filter((i) => i === sheet),
        sheet
      ).toHaveLength(1);
    }
  });

  it('imports the host contract directly after the shell sheet and directly before the widgets sheet', () => {
    const shell = imports.indexOf('@slaclab/canopy-shell/styles.css');
    expect(shell).toBeGreaterThanOrEqual(0);
    expect(imports.slice(shell, shell + 3)).toEqual([
      '@slaclab/canopy-shell/styles.css',
      '@slaclab/canopy-shell/host-contract.css',
      '@slaclab/canopy-screen-widgets/styles.css',
    ]);
  });

  it('keeps those three imports on consecutive lines', () => {
    expect(code).toMatch(
      /^import '@slaclab\/canopy-shell\/styles\.css';\nimport '@slaclab\/canopy-shell\/host-contract\.css';\nimport '@slaclab\/canopy-screen-widgets\/styles\.css';$/m
    );
  });

  it('loads Carbon before the shell sheets and the viewer sheet after the widgets sheet', () => {
    expect(imports.indexOf('./index.scss')).toBeLessThan(
      imports.indexOf('@slaclab/canopy-shell/styles.css')
    );
    expect(imports.indexOf('./index.css')).toBeGreaterThan(
      imports.indexOf('@slaclab/canopy-screen-widgets/styles.css')
    );
  });

  it('imports applyHostSheetFallback from the shell package', () => {
    expect(code).toMatch(
      /^import\s*\{[^}]*\bapplyHostSheetFallback\b[^}]*\}\s*from\s*'@slaclab\/canopy-shell';$/m
    );
  });

  it('calls applyHostSheetFallback() once, as a top-level statement, before createRoot', () => {
    const calls = offsets(/^applyHostSheetFallback\(\);$/gm);
    expect(calls).toHaveLength(1);
    // No other call form (indented, with arguments, inside a callback).
    expect(offsets(/\bapplyHostSheetFallback\s*\(/g)).toHaveLength(1);

    const roots = offsets(/\bcreateRoot\s*\(/g);
    expect(roots).toHaveLength(1);
    expect(calls[0]).toBeLessThan(roots[0]);
  });
});
