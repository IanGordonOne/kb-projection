# Changelog

## v0.2.0 — 2026-04-28

### Removed

- `legacy/` subdirectory (transformer, targets/astro, projectionBridge, healthMonitor, build-manifest). Pre-loader materialized projection path retired. The `kyber/scripts/regression/777westwood-astro.ts` byte-equivalence test (the only consumer) was retired in the same cycle.

### Changed

- `src/filters/redact.ts` — refactored to be source-clean. Engine now ships only `none` (no-op) as a built-in mode; site-specific patterns are supplied by the host via `createKbLoader({ redactRulesByMode: ... })`. See [kbp-vc3](https://github.com/IanGordonOne/kb-projection/issues) for context.
- `src/filters/index.ts` — exports `RedactRule` + `RedactRules` types.
- `src/manifest/schema.ts` — `RedactMode` is now `string` (host-keyed); `REDACT_MODE_VALUES` contains only the engine's built-in modes.
- `src/manifest/validate.ts` — drops enum enforcement on redact mode; only requires non-empty string. Mode validity is host-known.
- `src/manifest/audit-drift.ts` — `filter-redact-mode-unknown` is now opt-in via `knownRedactModes` option.

### Added

- `kb-projection-vc3` — public visibility flip (private → public).

## v0.1.0 — 2026-04-28

Initial extraction from `~/.claude/USER/skills/_KNOWLEDGE/_KNOWLEDGE_PROJECT/Tools/` (PAI USER skill tree).

### Added

- `src/lib/logseqToAstro.ts` — pure transforms (kyber-3fh.5)
- `src/lib/loader.ts` — `createKbLoader` factory (kyber-3fh.5 / kyber-3fh.15 refactor)
- `src/filters/` — per-entry manifest filter pipeline (kyber-3fh.13 perky-tarsier)
- `src/manifest/` — schema, validate, audit-drift, patch + apply-patch, preview, propose-placement, logseq-meta (kyber-3fh.5–.13)
- `bin/` — CLI shims for the manifest editor tools
- `legacy/` — pre-loader materialized projection path (deprecated)

### Migrated from

- `@kyber/logseq-to-astro` (the prior `lib/` subpackage name)

### Notes

- Tests use `bun:test`. Use `bun test` (not `node`).
- Astro is a peer dependency; only `Loader` types are referenced. Marked optional for non-loader consumers.
- Legacy materialized projection path (`legacy/`) is preserved only for `kyber/scripts/regression/777westwood-astro.ts`. Will be removed in v0.2.0 once that regression is retired.
