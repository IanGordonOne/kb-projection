# 6ji.8 P0 — Feasibility GATE probe: do grounding signals survive projection, and is each finding deterministically region-attributable?

**Bead:** kb-projection-6ji.8.1 (P0 of 6ji.8 — per-region citation-recall, files-canonical)
**Date:** 2026-07-15
**Verdict:** **GO** (with one mandatory design consequence — a synthetic ROOT region is required)

This is a feasibility gate, not an implementation. A throwaway probe imported the REAL
functions (`projectSourcePage`, `transformBody` via it, `parseRegions`, `regionSpan`,
`hashRegionBody`) and ran them against **all 8 real grounded pages** in
`~/Logseq/MyGraph/pages` (discovered by `citation-recall::`, not a hand-picked sample).

## The ONE question, answered

1. **Do grounding signals survive projection intact?** — **YES.** Band markers and
   `[^key]` refs are byte-for-byte preserved by `projectSourcePage()` on every page
   (8/8 `survived: YES`). `transformBody` never touches `_(…)_` spans, `[^key]` inline
   refs, or the `- Citations` block.
2. **Is each finding deterministically attributable to a region?** — **YES, but only
   with a synthetic root.** With the region model as-is, 316 of 360 findings (88%) land
   OUTSIDE every parsed region, because findings live under top-level LogSeq
   source-group bullets, not markdown headings — and `parseRegions` only emits regions
   for headings/fences. Once a whole-body synthetic root region exists, every finding
   attributes to exactly one region deterministically (line-index containment via
   `regionSpan`).

## Probe commands

```bash
# scratchpad probe (removed after this doc was written)
bun scratchpad/probe.ts
#   - reads every *.md whose frontmatter matches /^\s*citation-recall::\s*[0-9]/m
#   - counts _(band)_ and [^ref] BEFORE and AFTER projectSourcePage()
#   - runs parseRegions() on the projected content
#   - attributes each band-bearing line to its innermost region via regionSpan()
#   - resolves [^key] -> `finding:: <uuid>` from the projected Citations block
```

Signal survival is measured against the RAW source (both pre/post carry the same
Citations block; `projectSourcePage` strips only the leading `key:: value` page-property
block, which contains no findings).

## Aggregate results (8 grounded pages)

| Page (truncated) | bands | refs | regions | in-region | outside-all | survived | ref→uuid |
|---|---:|---:|---:|---:|---:|:---:|---:|
| AI Agent Memory Empowered by Knowledge Graphs | 16 | 16 | 1 | 0 | **16** | YES | 16/16 |
| Distributed-Systems Foundations of bitácora (ADR) | 0 | 0 | 2 | 0 | 0 | YES | 0/0 |
| Westwood Fire & Access Provenance | 49 | 45 | 0 | 0 | **49** | YES | 45/45 |
| Westwood Legal-Access & ROW Provenance | 44 | 36 | 1 | **44** | 0 | YES | 36/36 |
| Westwood Planning & Ag-Buffer Provenance | 25 | 24 | 0 | 0 | **25** | YES | 24/24 |
| Westwood Site-Safety & Build Provenance | 63 | 51 | 0 | 0 | **63** | YES | 51/51 |
| Westwood Title & Encumbrance Provenance | 105 | 86 | 0 | 0 | **105** | YES | 86/86 |
| Westwood Water & Septic Provenance | 58 | 46 | 0 | 0 | **58** | YES | 46/46 |
| **TOTAL** | **360** | **304** | — | **44** | **316** | **8/8** | **304/304** |

**Key reads:**

- **Survival: 100%.** Every band and every ref survives projection unchanged. `ref→uuid`
  resolution is 304/304 — every inline `[^key]` resolves to a `finding:: <uuid>` in the
  projected Citations block. Signal integrity is not a risk.
- **Region coverage: essentially zero.** 6 of 8 pages produce **0 regions that contain
  any finding**. 316/360 findings (88%) are outside all regions.
- **The one "in-region" page is misleading.** Westwood Legal-Access shows all 44 findings
  in-region — but that is a single heading (`- ## ⚠ ACCESS PROVENANCE NOTE …`) sitting at
  the top of the page whose body, per `parseRegions` semantics (runs to next same/higher
  heading or EOF), swallows the ENTIRE rest of the page. It is an accidental page-wide
  catch-all, **functionally identical to a synthetic root**, not genuine per-section
  grouping. No page in the corpus has multiple finding-bearing sections.
- **cited vs uncited is clean and deterministic.** On every page, `cited findings =
  well-supported + supported = inline [^ref] count`, and `uncited findings = the
  "unverified: …" band, which carry no [^key]` (they live in the `- Unverified (not
  grounded)` block). e.g. Water: 43+3 cited = 46 refs; 12 unverified = uncited. This is
  exactly the numerator/denominator a per-region citation-recall score needs.
- **`hashRegionBody` is deterministic** (same hash on repeat) — the region content
  fingerprint the scorer would key on is stable.

## Blocker / edge-case table

| # | Edge case | Observed? | Impact | Handling for 6ji.8 |
|---|---|---|---|---|
| 1 | **Findings under top-level bullets, no heading** | YES — 6/8 pages, 316/360 findings | Findings attribute to NO region | **Synthetic ROOT region** spanning the whole projected body is mandatory |
| 2 | **`_(…)_` is NOT a reliable finding delimiter** | YES | Naive `_(…)_` match over-counts | Band must be an **allowlist vocabulary**, not any `_(…)_` |
| 3 | Band spelling `_(unverified: unsupported by cited source)_` (colon + spaces) | YES — 12+19 occurrences | A `[a-z-]+` band regex MISSES it | Band regex must allow `[^)]+` then match against allowlist |
| 4 | `_(repaired)_` provenance mark, co-occurs with a band on the same line (`_(well-supported)_ _(repaired)_`) | YES — 24, 34 per page | Double-counts findings if treated as a band | Exclude `repaired` from band vocabulary (it is a repair provenance mark) |
| 5 | `_(Manual annotation — …)_` italic editorial note | YES — Legal-Access | Matches `_(…)_`, is NOT a band | Allowlist rejects it; identify findings by band∈allowlist OR trailing `[^key]` |
| 6 | `_(grounded)_` hand-authored band variant (in place of `well-supported`) | YES — Planning page | A real, human-added band spelling | Add `grounded` to the band allowlist (semantically "supported") |
| 7 | **Grounded page with ZERO findings** | YES — ADR-0002 (citation-recall:: 1.0, 0 bands/refs) | Denominator = 0 | Scorer must define recall for 0 findings (n/a or 1.0), not divide-by-zero |
| 8 | `- Unverified (not grounded)` block | YES — Water, Title, others | Uncited findings by design | Count as uncited denominator; do NOT treat absence of `[^key]` as an error |
| 9 | Multiple `[^key]` on one finding line | NOT observed | — | 1 ref per finding held across 304 refs; still parse defensively |
| 10 | Nested / sub-heading regions | NOT observed in findings area | The `## Backports`, `## Visual`, `## Sources` headings are free content, not findings | Synthetic root + (optional future) source-group sub-regions |
| 11 | Footnote keys with special chars | Keys are `[a-z0-9-]+` slugs (e.g. `…-vol-4696-p-148-2`) | Low risk | Match `[^…]` on `[^\]]+`, key off exact string |
| 12 | Findings carry a trailing inline `id::` → `<span data-block-id>` | `transformBody` rewrites `id::` block-props to inline spans | Does not touch bands/refs | No effect on scoring; confirmed survival intact |

Nothing in this table blocks the feature. Items 1–2 are the design-shaping ones; the rest
are parser hygiene the scorer must encode.

## Distinct band-marker spellings actually occurring

- **Confidence bands (findings):** `_(well-supported)_`, `_(supported)_`,
  `_(unverified: unsupported by cited source)_`, `_(grounded)_` (hand-authored variant).
- **Not a band — must be excluded:** `_(repaired)_` (repair-provenance mark, co-occurs
  with a band), `_(Manual annotation — …)_` (editorial note).

The scorer MUST drive off an explicit band allowlist, not a generic `_(…)_` regex.

## GO / NO-GO recommendation

**GO.** Grounding signals (band markers, `[^key]` refs, and the `[^key]→finding:: <uuid>`
Citations map) survive `projectSourcePage`/`transformBody` byte-intact on 100% of real
grounded pages, and `finding` attribution is fully deterministic from the projected,
files-canonical content — no DB required. The cited/uncited split needed for a recall
numerator/denominator falls straight out of the band vocabulary + `[^key]` presence.

**Mandatory design consequence:** the region model as-shipped does **not** attribute
findings — 88% land outside every `parseRegions` region because real grounded pages nest
findings under top-level LogSeq source-group bullets, not headings. **A synthetic ROOT
region (whole projected body) is required** so every finding has exactly one owning
region. For pages that genuinely have multiple sections this degrades gracefully to
per-heading scoring; for today's corpus, per-region citation-recall == whole-page recall
until/unless a future pass sub-divides by source-group bullets. Per-region granularity
below the page is an enhancement, not a P0 requirement.

**Scorer must additionally:** (a) treat the band as an allowlist
(`well-supported | supported | grounded | unverified:*`), excluding `repaired` and
editorial `_(…)_` notes; (b) handle the zero-findings grounded page (ADR) without a
divide-by-zero; (c) count `- Unverified (not grounded)` findings as uncited, not errors.
