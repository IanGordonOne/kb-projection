---
project: kb-projection
task: Consolidate duplicated LogSeq primitives into a shared module
slug: kb-projection-dt7
effort: E3
phase: complete
progress: 36/36
mode: algorithm
started: 2026-07-14
updated: 2026-07-14
---

## Problem

The LogSeq primitives (path-encoding/title→file resolution, `[[wikilink]]` extraction,
HTML-entity decoding, property parsing, `slugify`) are reimplemented across `src/manifest/*`
instead of imported from the de-facto shared module `src/lib/logseqToAstro.ts`. Two copies
have genuinely diverged:

- **decodeHtml** — `manifest/audit-drift.ts:32` and `manifest/logseqMeta.ts:28` decode a
  9-entity SUPERSET (`&nbsp; &lt; &gt; &middot; &hellip;` extra) vs the canonical 4-entity
  `logseqToAstro.decodeHtml`. Both copies decode a `[[wikilink]]` title before resolution, so
  the divergence CAN produce a title-resolution mismatch (dormant today: the real graph has
  zero occurrences of the extra entities — a loaded gun, not a live bug).
- **apply-patch.ts:107 slugify** — diverges from the byte-pinned `logseqToAstro.slugify`; a
  same-named helper silently disagreeing with the canonical is a maintenance trap (harmless
  today — its one call site builds a unique `bd remember` memo key, never a route slug).

The rest is DRY debt: the 5-encoding title→file resolver (3 copies), `WIKILINK_RE` +
`extractWikilinks` (3 copies in manifest/subgraph, plus obsidian's inline variants), and the
property readers. Nothing enforces the copies stay in sync.

## Vision

One canonical `logseq-primitives` surface holds each primitive exactly once; `src/manifest/*`
and `src/lib/*` import it rather than reimplementing it. `decodeHtml` behaves identically on
every code path, so a `[[wikilink]]` title resolves the same whether the manifest or the lib
path touches it — and a regression test locks that equivalence closed. The consolidation is
invisible at the seams: all 155 existing tests still pass, byte-for-byte.

## Out of Scope

- **transformBody byte-pin.** `logseqToAstro.transformBody` and `obsidian.cleanLogseqBody`'s
  duplicated cleaning core stay duplicated ON PURPOSE — transformBody is pinned byte-for-byte
  by the 777westwood Astro regression and must not be refactored until that regression can be
  re-run. Only the pure leaf helpers it *calls* (decodeHtml, slugify) are relocated, and only
  because relocation is byte-identical.
- **Graph-walk / hop-expansion unification (audit finding #2).** `subgraph.selectSubgraph`
  (weighted co-citation + hub-demotion + boundary) and `audit-drift` hop-expansion (unweighted
  N-hop candidate collection) are genuinely different algorithms; forcing a shared BFS core
  adds abstraction and real behavior-change risk for little DRY payoff. Deferred to a follow-up
  bead — it is not in the audit's resolved priority order (B > A > C/D/E) and is not a live bug.
- **logseqMeta `extractProperty`/`extractTags`.** These scan the whole file for an arbitrary
  `key::` (block or page property), which is semantically distinct from `parseProperties`'
  leading-block-only parse. Not folded in (would change scan behavior); only their internal
  wikilink call is pointed at the shared helper.

## Constraints

- bun/bunx only; TypeScript only; zero runtime deps in the primitives module (host sites
  install `logseqToAstro` as a `file:` dep without dragging in the engine).
- `logseqToAstro.ts` is the package main export (`package.json` `"."`); its public API
  (exported names) must not break — re-export relocated helpers from it.
- `manifest/validate.ts#resolveEntryFile` is imported by `audit-drift.ts`; keep its name/signature.
- Consolidate `decodeHtml` to the SUPERSET (strictly more correct) — safe for the byte-pin
  because the pinned fixture contains none of the extra entities.

## Goal

Extract the shared LogSeq primitives into `src/lib/logseq-primitives.ts` as the single source
of truth, make `src/manifest/*` and `src/lib/*` import them (deleting every in-file copy of
decodeHtml / the 5-encoding resolver / WIKILINK_RE / extractWikilinks), unify `decodeHtml` to
one superset implementation with a regression guard test, and remove the `apply-patch.slugify`
name collision — with all 155 existing tests still green.

## Criteria

- [x] ISC-1: `src/lib/logseq-primitives.ts` exists and exports `WIKILINK_RE`.
- [x] ISC-2: primitives module exports `decodeHtml` (the 9-entity superset).
- [x] ISC-3: primitives module exports `escapeHtml`.
- [x] ISC-4: primitives module exports `slugify` (byte-identical to the current logseqToAstro one).
- [x] ISC-5: primitives module exports `parseProperties`.
- [x] ISC-6: primitives module exports `stripLeadingPropertyBlock`.
- [x] ISC-7: primitives module exports `logseqFilenameCandidates(title)` returning the 5 encodings.
- [x] ISC-8: primitives module exports `resolveTitleToPage(pagesDir, title, file?)`.
- [x] ISC-9: primitives module exports `extractWikilinks(content)` returning deduped, decoded, length-filtered titles.
- [x] ISC-10: `logseqToAstro.ts` re-exports decodeHtml/escapeHtml/slugify/parseProperties/stripLeadingPropertyBlock/WIKILINK_RE from the primitives module (no second definition).
- [x] ISC-11: `logseqToAstro.decodeHtml` now resolves to the superset (single definition project-wide).
- [x] ISC-12: `logseqToAstro.resolveLogseqPath` delegates to `resolveTitleToPage` (no inline 5-encoding array left in the function).
- [x] ISC-13: `logseqToAstro.ts` no longer contains a literal `%3A`/`%3F`/`%22` encoding array outside the primitives module.
- [x] ISC-14: `manifest/audit-drift.ts` no longer defines a local `decodeHtml`.
- [x] ISC-15: `manifest/audit-drift.ts` no longer defines a local `WIKILINK_RE`.
- [x] ISC-16: `manifest/audit-drift.ts` no longer defines a local `extractWikilinks`; it imports the shared one.
- [x] ISC-17: `manifest/audit-drift.ts` no longer defines a local `resolveTitleToFile`.
- [x] ISC-18: `manifest/logseqMeta.ts` no longer defines a local `decodeHtml`.
- [x] ISC-19: `manifest/logseqMeta.ts` no longer defines a local `WIKILINK_RE`.
- [x] ISC-20: `manifest/logseqMeta.ts` no longer defines a local `extractWikilinksFromString`; uses the shared extractor.
- [x] ISC-21: `manifest/logseqMeta.ts` no longer defines a local `resolveTitleToFile`.
- [x] ISC-22: `manifest/validate.ts#resolveEntryFile` delegates to `resolveTitleToPage` (no inline 5-encoding array).
- [x] ISC-23: `manifest/validate.ts#resolveEntryFile` keeps its exported name + `(graphPath, entry)` signature.
- [x] ISC-24: `src/lib/subgraph.ts` imports `WIKILINK_RE` from the shared module (no local const).
- [x] ISC-25: `manifest/apply-patch.ts` local `slugify` is renamed to `memoryKeySlug` (genuinely-different function; kills the false-duplicate name collision).
- [x] ISC-26: no `decodeHtml` function *definition* remains anywhere under `src/manifest/`.
- [x] ISC-27: exactly one `decodeHtml` function definition exists project-wide (in the primitives module).
- [x] ISC-28: exactly one 5-encoding candidate array exists project-wide (in the primitives module).
- [x] ISC-29: `tsc --noEmit` passes clean.
- [x] ISC-30: `bun test` reports 155+ pass, 0 fail (no regression).
- [x] ISC-31: a new regression test asserts a title containing `&lt;` resolves identically across the manifest path and the lib path.
- [x] ISC-32: the new equivalence test passes.
- [x] ISC-33: Anti: `logseqToAstro.transformBody`'s transform body (steps 1–7) is byte-unchanged — only its leaf helper *imports* move.
- [x] ISC-34: Anti: no public export removed from `logseqToAstro.ts` or `manifest/*` (existing importers keep resolving).
- [x] ISC-35: the "Zero-dep — matches _KNOWLEDGE_PROJECT/Tools style" re-inline convention comments in manifest files are replaced with a rule pointing at the shared primitives module (retire the latent root cause).
- [x] ISC-36: a recurrence-guard test asserts each consolidated primitive (`decodeHtml`, the 5-encoding array) has exactly one definition under `src/`, and it passes.

## Test Strategy

| isc | type | check | threshold | tool |
|-----|------|-------|-----------|------|
| 1–9 | structure | grep export names in primitives module | present | Grep |
| 10–13 | refactor | grep for removed inline defs / re-export line | absent/present | Grep |
| 14–28 | dedup | grep counts of function defs / encoding arrays | exact count | Bash grep -c |
| 29 | typecheck | `tsc --noEmit` exit 0 | clean | Bash |
| 30,32 | regression | `bun test` pass count | ≥155 pass, 0 fail | Bash |
| 31 | test-exists | grep the new test name | present | Grep |
| 33 | byte-pin | git diff of transformBody body region shows only import-line churn | no logic change | Bash git diff |
| 34 | api | existing test suite still imports & passes | green | Bash |

## Features

| name | satisfies | depends_on | parallelizable |
|------|-----------|------------|----------------|
| primitives-module | ISC-1..9,27,28 | — | no |
| logseqToAstro-rewire | ISC-10..13,33 | primitives-module | no |
| manifest-rewire | ISC-14..23,26 | primitives-module | no |
| subgraph-rewire | ISC-24 | primitives-module | yes |
| slugify-collision | ISC-25 | — | yes |
| equivalence-guard-test | ISC-31,32 | manifest-rewire | no |
| verify-green | ISC-29,30,34 | all | no |

## Decisions

- 2026-07-14: Canonical `decodeHtml` = the 9-entity superset (manifest copies), not the
  4-entity lib copy. Superset is strictly more correct and byte-safe for the 777westwood pin
  (fixture has none of the extra entities). Locks audit finding B closed.
- 2026-07-14: Scope excludes graph-walk unification (audit #2) and property-reader merge
  (audit E) — see Out of Scope. Filing a follow-up bead for #2.
- 2026-07-14: Relocating decodeHtml/slugify out of logseqToAstro and re-importing them is
  byte-identical (same source), so transformBody's pinned output is unchanged; the existing
  logseqToAstro test suite is the byte-pin proxy that proves it.

## Changelog

- conjectured: the audit's headline risk was the drifted `decodeHtml` (finding B) and DRY debt.
  refuted_by: RootCauseAnalysis Five-Whys — the drift was *prescribed* by an inherited
  "self-contained zero-dep Tool" convention carried over from a scriptless skill-tree origin;
  removing the code without retiring the convention regenerates the exact same drift.
  learned: a consolidation that doesn't kill the enabling convention + add an enforcement guard
  is temporary. criterion_now: added ISC-35 (retire convention comments) + ISC-36 (recurrence
  guard test asserting one definition per primitive).

## Verification

- ISC-1..9: Grep — `logseq-primitives.ts` exports WIKILINK_RE, decodeHtml, escapeHtml, slugify,
  parseProperties, stripLeadingPropertyBlock, logseqFilenameCandidates, resolveTitleToPage,
  extractWikilinks. Unit-tested in `test/lib/logseq-primitives.test.ts` (14 tests).
- ISC-10,11: `astro.decodeHtml === decodeHtml` etc. asserted by the re-export-identity test.
- ISC-12,13,22,28: Grep — `%3A/%3F/%22` array exists in exactly one file (logseq-primitives.ts);
  resolveLogseqPath + resolveEntryFile are one-line delegations.
- ISC-14..21,26,27: Grep — zero local `decodeHtml`/`WIKILINK_RE`/`extractWikilinks*`/
  `resolveTitleToFile` defs under src/manifest/; exactly one `function decodeHtml` project-wide.
- ISC-23: `resolveEntryFile(graphPath, entry)` signature unchanged; audit-drift still imports it.
- ISC-24: Grep — subgraph.ts imports WIKILINK_RE from logseq-primitives, no local const.
- ISC-25: Grep — `memoryKeySlug` defined + called; no `function slugify` in apply-patch.
- ISC-29: `tsc --noEmit` exit 0. ISC-30,32: `bun test` → 169 pass / 0 fail (155 baseline + 14 new).
- ISC-31: finding-B equivalence test resolves `[[A &lt; B]]` to the same on-disk file via the
  manifest path (extractWikilinks + resolveEntryFile) and the lib path (decodeHtml +
  resolveLogseqPath) — both non-null, `manifestResolved === libResolved`.
- ISC-33: `git diff` of logseqToAstro.ts shows no line inside transformBody changed (only the
  import block + def relocation above it); the logseqToAstro test suite (the byte-pin proxy) passes.
- ISC-34: whole-tree grep — no importer of any deleted symbol (all were non-exported); 169 tests
  green confirms every subpath export still resolves. Independent code-reviewer agent: no bugs.
- ISC-35: Grep — the three "_KNOWLEDGE_PROJECT/Tools style" comments replaced with import rules.
- ISC-36: recurrence-guard test asserts one decodeHtml def + one 5-encoding array under src/; passes.
