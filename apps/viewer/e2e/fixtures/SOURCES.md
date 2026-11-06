# Fixture sources

Three fixture sets here are byte copies of canopy's contract fixtures. canopy
owns them; the copies are never edited here (`.prettierignore` keeps them
unformatted, and some are deliberately malformed).

| Copy           | Source in canopy                        | canopy commit |
| -------------- | --------------------------------------- | ------------- |
| `workspace/`   | `tests/canopy_mcp/fixtures/workspace`   | `16c325ed`    |
| `collections/` | `tests/canopy_mcp/fixtures/collections` | `16c325ed`    |
| `contracts/`   | `src/canopy/contracts` (heartbeat only) | `5cbfbe49`    |

The commit is the last one that changed the source directory when the copy
was taken.

## Check and refresh

```bash
# Compare every copied file with a canopy checkout (exit 1 on a difference):
CANOPY_SRC=../canopy pnpm --filter viewer run check:fixtures

# Refresh one set: replace the directory with canopy's, then update the commit above.
rm -r apps/viewer/e2e/fixtures/workspace
cp -R ../canopy/tests/canopy_mcp/fixtures/workspace apps/viewer/e2e/fixtures/workspace
```

Without `$CANOPY_SRC` the check compares nothing and exits 0.
