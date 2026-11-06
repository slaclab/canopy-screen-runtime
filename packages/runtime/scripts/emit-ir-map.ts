// Writes packages/runtime/ir-map.json from the runtime's IR type table.
//
// The JSON is checked in as the review surface for what the runtime renders;
// irMap.test.ts fails when it drifts from the code. Run from anywhere with
// Node's built-in type stripping:
//   node packages/runtime/scripts/emit-ir-map.ts
//
// The sources import their siblings as `./x.js` (the emitted name); a resolve
// hook maps a relative `.js` that does not exist onto its `.ts` source. The
// modules are imported after the hook is registered, so dynamically.

import { writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (!specifier.startsWith('.') || !specifier.endsWith('.js')) throw error;
      return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
    }
  },
});

const { serializeIrMapManifest } = await import('../src/render/irMap.ts');
const { irMetaFor } = await import('../src/render/irMeta.ts');

const target = fileURLToPath(new URL('../ir-map.json', import.meta.url));
writeFileSync(target, serializeIrMapManifest(irMetaFor));
console.log(`wrote ${target}`);
