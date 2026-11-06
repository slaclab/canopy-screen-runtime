# expand() test vectors

`expand-cases.json` holds the cases; `expand-vectors.json` is what `expandScreen`
computes over them (harness: `test/expandVectors.ts`). Regenerate the vectors
after a deliberate change to the walk (run in `packages/runtime`):

    pnpm exec vitest run -u src/render/expandVectors.test.ts
