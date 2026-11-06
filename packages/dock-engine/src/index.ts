// The dock engine's public surface: the seven engine modules. The case runner
// (`./cases`) reads files with node:fs and is exported separately.
export * from './layout.js';
export * from './geometry.js';
export * from './drop.js';
export * from './open.js';
export * from './close.js';
export * from './hitTest.js';
export * from './resultRect.js';
// hitTest.ts declares the drop vocabulary again, structurally identical; drop.ts's names win.
export type { Side, Source, Target } from './drop.js';
