# Legacy — pre-loader materialized projection

These files implement the **pre-kyber-3fh.5 projection path**: materialized markdown emission to a target directory, instead of the current `createKbLoader` Astro Content Layer integration.

| File | Purpose |
|---|---|
| `transformer.ts` | Engine orchestrator + dispatcher |
| `targets/astro.ts` | Astro target emitter (materializes `.md` files) |
| `projectionBridge.ts` | Source ↔ emitted artifact correspondence store |
| `healthMonitor.ts` | Bridge drift detector |
| `build-manifest.ts` | Phase 1-3: seed → N-hop expand → manifest |

## Why are they here?

Only `~/Projects/kyber/scripts/regression/777westwood-astro.ts` consumes these files — it runs a byte-equivalence check between the legacy materialized output and the current loader-driven output. The kyber regression provides one more cycle of safety net while the loader-driven path settles.

## Removal

Will be removed in **v0.2.0**, after either:

1. The kyber regression test is retired (the loader-driven path has been the production path long enough that byte-equivalence checks are no longer load-bearing), OR
2. The kyber regression is rewritten to consume the engine's current API instead of the legacy internals.

**Do not add new consumers of `legacy/`.** Any new work targets `src/`.

## See also

- `Plans/please-plan-c-sparkling-tower.md` in 777westwood — the extraction plan that placed these here.
- bd issue (to be filed in this repo's tracker after extraction): "Drop legacy/ in v0.2.0".
