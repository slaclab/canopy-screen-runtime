// The host-contract fallback check: with the gate on (<html
// data-canopy-host>) and no host sheet loaded, every --canopy-<name> in every
// zone must compute to that zone's literal from the shell's tokens.json. The
// gated per-zone blocks of host-contract.css read
// `var(--canopy-host-<name>, <zone literal>)`, so an unset host value falls
// back to the literal; this spec proves the generated fallbacks and the token
// table agree, for all four zones (the apps themselves render only two each).
//
// The page is a bare page.setContent: the built sheet the viewer ships
// (@slaclab/canopy-shell/host-contract.css) inlined in a <style>, the gate
// attribute and one div per zone. No host fixture, no app, no server route.
// Files are read with node:fs and createRequire (never `?raw`, never a bare
// JSON import: Node 26 rejects it in this ESM package).

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test } from '@playwright/test';
import type { ContractTokens } from '@slaclab/canopy-shell/fixtures/host/runner.mjs';

const require = createRequire(import.meta.url);
const read = (file: string): string =>
  readFileSync(require.resolve(`@slaclab/canopy-shell/${file}`), 'utf8');

const contractCss = read('host-contract.css');
const tokens = JSON.parse(read('tokens.json')) as ContractTokens;
const ZONES = ['white', 'g10', 'g90', 'g100'] as const;
const names = Object.keys(tokens.names);

const pageHtml = `<!doctype html>
<html data-canopy-host>
  <head><style>${contractCss}</style></head>
  <body>
    ${ZONES.map((zone) => `<div class="cds--${zone}" data-zone="${zone}"></div>`).join('\n    ')}
  </body>
</html>`;

test.describe('host contract fallbacks', () => {
  test.describe.configure({ timeout: 30_000 });

  test('the token table names four zones and a non-empty contract', () => {
    expect(tokens.zones).toEqual([...ZONES]);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      for (const zone of ZONES) {
        expect(typeof tokens.names[name]!.literals[zone], `${name} has a ${zone} literal`).toBe(
          'string'
        );
      }
    }
  });

  for (const zone of ZONES) {
    test(`every --canopy-<name> in .cds--${zone} equals its tokens.json literal`, async ({
      page,
    }) => {
      await page.setContent(pageHtml);

      const gated = await page.evaluate(() =>
        document.documentElement.hasAttribute('data-canopy-host')
      );
      expect(gated, 'the gate attribute is on <html>').toBe(true);

      const actual = await page.evaluate(
        ({ zone, names }) => {
          const el = document.querySelector(`[data-zone="${zone}"]`);
          if (!el) throw new Error(`no .cds--${zone} element`);
          const style = getComputedStyle(el);
          return Object.fromEntries(
            names.map((name) => [name, style.getPropertyValue(`--canopy-${name}`).trim()])
          );
        },
        { zone, names }
      );

      const expected = Object.fromEntries(
        names.map((name) => [name, tokens.names[name]!.literals[zone]!.trim()])
      );
      // One map per zone, so a failure lists every mismatching name at once.
      expect(actual).toEqual(expected);
    });
  }
});
