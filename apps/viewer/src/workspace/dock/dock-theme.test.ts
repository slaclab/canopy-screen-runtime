// @vitest-environment node
// The dock's theme: one `.canopy-dock` block mapping every `--dv-*` variable
// dockview-core 7.0.2 reads outside its built-in theme blocks to a bare host contract token
// or to `transparent`/`none`, and nothing else. dockview never paints a drop target (the
// bridge prevents every overlay; DropPreview paints the preview): its drop-target variables
// are off and no rule paces its anchor. Nothing on the dock root may make it a stacking
// context, and dockview's tab container is never overridden.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const stripComments = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '');

// Read from disk: vitest blanks `.css` imports, `?raw` included.
const css = stripComments(readFileSync(require.resolve('./dock-theme.css'), 'utf8'));
const vendor = stripComments(
  readFileSync(require.resolve('dockview-core/dist/styles/dockview.css'), 'utf8')
);

/** The host contract names the bar chrome may use. */
const CONTRACT = [
  'bg-panel',
  'border',
  'text-primary',
  'text-secondary',
  'accent',
  'accent-tint',
  'radius-sm',
  'text-sm',
  'text-lg',
];
const TOKEN = `var\\(--canopy-(?:${CONTRACT.join('|')})\\)`;
/** A bare token, transparent or none. */
const ALLOWED_VALUE = new RegExp(`^(?:${TOKEN}|transparent|none)$`);
const FORBIDDEN = ['z-index', 'transform', 'contain', 'filter', 'isolation'];

/** dockview's drop-target variables: off, since it never paints a drop target. */
const DROP_TARGET_OFF: Record<string, RegExp> = {
  '--dv-drag-over-background-color': /^transparent$/,
  '--dv-drag-over-border-color': /^transparent$/,
  '--dv-drag-over-border': /^none$/,
};

/** Every rule of the file as selector and its declarations. */
const rules = css
  .split('}')
  .map((rule) => rule.split('{'))
  .filter(([selector]) => selector!.trim() !== '')
  .map(([selector, body = '']) => ({
    selector: selector!.trim(),
    declarations: [...body.matchAll(/([\w-]+)\s*:\s*([^;]+);/g)].map((found) => ({
      property: found[1]!,
      value: found[2]!.trim(),
    })),
  }));

/** The `--dv-*` names the installed stylesheet reads outside its `.dockview-theme-*` blocks. */
function consumedOutsideThemes(text: string): Set<string> {
  const read = new Set<string>();
  const selectors: string[] = [];
  let body = '';
  for (const char of text) {
    if (char === '{') {
      selectors.push(body.trim());
      body = '';
    } else if (char === '}') {
      if (!selectors.some((selector) => selector.includes('.dockview-theme-'))) {
        for (const found of body.matchAll(/var\(\s*(--dv-[\w-]+)/g)) read.add(found[1]!);
      }
      selectors.pop();
      body = '';
    } else {
      body += char;
    }
  }
  return read;
}

describe('dock theme', () => {
  it('is the .canopy-dock block alone: no rule reaches a dockview drop target', () => {
    expect(rules.map((rule) => rule.selector)).toEqual(['.canopy-dock']);
    expect(css).not.toMatch(/\.dv-drop-target/);
  });

  it("switches dockview's drop target off: the preview is DropPreview's", () => {
    const declared = new Map(rules[0]!.declarations.map((d) => [d.property, d.value]));
    for (const [property, value] of Object.entries(DROP_TARGET_OFF)) {
      expect(declared.get(property), property).toMatch(value);
    }
  });

  it('sets exactly the --dv-* variables dockview 7.0.2 reads outside its theme blocks', () => {
    const consumed = consumedOutsideThemes(vendor);
    expect(consumed.size).toBeGreaterThanOrEqual(40);
    const set = rules[0]!.declarations.map((declaration) => declaration.property);
    expect(new Set(set).size).toBe(set.length);
    expect([...set].sort()).toEqual([...consumed].sort());
  });

  it('leaves the palette constants unset', () => {
    for (const { property } of rules[0]!.declarations) {
      expect(property).not.toMatch(/^--dv-(?:color-|tab-group-color-|tab-group-line-height$)/);
    }
  });

  it('gives every variable a contract value, transparent or none', () => {
    for (const { property, value } of rules[0]!.declarations) {
      expect(property).toMatch(/^--dv-/);
      expect(value, property).toMatch(ALLOWED_VALUE);
    }
  });

  it('sets no stacking or containment property', () => {
    const declared = rules.flatMap((rule) =>
      rule.declarations.map((declaration) => declaration.property)
    );
    for (const property of FORBIDDEN) expect(declared).not.toContain(property);
    // A property at declaration start, not a custom property such as --dv-overlay-z-index.
    expect(css).not.toMatch(new RegExp(`(?:^|[;{\\s])(?:${FORBIDDEN.join('|')})\\s*:`, 'm'));
  });

  it('does not override dockview’s tab container', () => {
    expect(css).not.toMatch(/\.dv-(?:tabs-and-actions-container|tabs-container|tab)\b/);
  });
});
