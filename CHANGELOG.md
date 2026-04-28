# Changelog

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
