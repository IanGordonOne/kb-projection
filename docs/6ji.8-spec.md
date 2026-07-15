# 6ji.8 SPEC — Per-region citation-recall scoring (files-canonical, deterministic)

**Bead:** kb-projection-6ji.8.2 (P1 of the cross-vendor TDD chain 6ji.8)
**Status:** authored, hard-to-vary — this is the contract P2 (RED) and P3 (GREEN) implement against
**Date:** 2026-07-15
**Inputs honored:** the BINDING DESIGN CONSTRAINTS comment on 6ji.8 (Ian, 2026-07-15) and every design consequence in `docs/6ji.8-p0-probe.md` (P0 = GO). Grammar here is pinned against the live corpus (`~/Logseq/MyGraph/pages`, 8 grounded pages).

The load-bearing constraints, restated so this doc can be read alone:

- Per-region citation-recall is derived **deterministically from the projected, files-canonical page** — no DB, no new `kb_cli` call for scoring. The page-level `kb_cli faithfulness-gate` (`faithfulnessGate()`) stays exactly as-is for the *page* gate.
- New code lives in `src/reconcile/` as **pure functions** in the module's existing style (cf. `region-core.ts` — no `fs`, no `exec`, deterministic, unit-tested).
- Must not regress the existing tests.

---

## 1. Problem

Grounding today is a **page** property: a source page carries `citation-recall::` in frontmatter (`sourceIsGrounded()`), and the reconciler gates the whole page through `kb_cli faithfulness-gate`. That is all-or-nothing — a page passes or is excluded in its entirety.

We want **region-granular** faithfulness: for each projected region of a grounded page, a citation-recall number derived from the region's own findings, plus the **findings→region mapping** (regionId → the finding UUIDs it contains, with cited/total counts). This is the substrate that a future region-granular *gate* would consume, and it is immediately useful as region-granular *reporting*.

P0 verified the raw materials survive projection byte-intact and that every finding is deterministically region-attributable **once a synthetic root region exists** (88% of findings live under top-level LogSeq source-group bullets, outside every `parseRegions` heading region). This spec pins the exact function, types, grammar, and wiring.

---

## 2. Non-goals

- **No NLI / entailment scoring.** Per-region recall is **binding-coverage** — the fraction of a region's findings that cite a source — the same semantics as `kb_cli`'s `scoring:"binding"` fallback. Semantic entailment is kb_cli promote-time work and is out of scope. We do not call `kb_cli` for scoring.
- **No reconciliation against the frontmatter `citation-recall::` number.** `projectSourcePage()` strips the leading page-property block, so the scored (projected) content does not even carry `citation-recall::`. The frontmatter value is kb_cli's authoritative page number (possibly NLI-scored); ours is a files-derivable binding-coverage proxy. Asserting equality between them would be reimplementing NLI. They are kept independent (see §6).
- **No region-granular GATING in this bead.** Reporting is the deliverable floor; a per-region *refusal* is explicitly deferred (§3.8, with justification and a named follow-up).
- **No sub-division of the ROOT region by source-group bullet.** P0 shows today's corpus has no page with multiple finding-bearing heading sections, so ROOT == whole-page recall for now. Splitting ROOT into per-source-group sub-regions is a future enhancement, not a P0/P1 requirement.
- **No mutation of the page.** Scoring is a pure read over projected content; it never edits, gates, or removes a region.

---

## 3. Design & justification

### 3.1 Interface boundary — one new pure module

New file `src/reconcile/region-recall.ts`. Pure, dependency-only on `region-core` (`parseRegions`, `regionSpan`, `type Region`) plus `node:` nothing. No `fs`/`exec`. Public surface:

```ts
export const ROOT_REGION_ID = ':root';

export interface RegionRecall {
  id: string;              // a parseRegions region id, or ROOT_REGION_ID
  kind: 'heading' | 'fence' | 'root';
  source?: string;         // projected-marker source when present (reporting only)
  findingIds: string[];    // resolved finding UUIDs of the CITED findings in this region, doc order
  cited: number;           // # finding-lines in the region span carrying a trailing [^key]
  total: number;           // # finding-lines in the region span (allowlisted band present)
  recall: number | null;   // cited/total, or null when total === 0
}

export interface PageRecall {
  regions: RegionRecall[]; // ROOT first, then parseRegions regions in document order
  cited: number;           // Σ regions[].cited
  total: number;           // Σ regions[].total
  recall: number | null;   // cited/total, or null when total === 0
}

/** Global [^key] → finding UUID map from the projected page's `- Citations` block. */
export function resolveCitationMap(projectedContent: string): Map<string, string>;

/** Score every region (incl. synthetic ROOT) of a projected grounded page. Pure. */
export function scoreRegionRecall(projectedContent: string, file?: string): PageRecall;
```

**Why this shape.** `RegionRecall` is the task's named deliverable made concrete: `id → { findingIds, cited, total, recall }`. `cited`/`total` are **integers and the authoritative source of truth**; `recall` is a derived convenience float so consumers don't recompute it (and can be `null`). Mirrors the existing module habit of returning plain data records (`ProjPlanItem`, `RegionHealth`, `ManifestEntrySummary`). `resolveCitationMap` is factored out because the Citations block is page-global (one block at page end), not per-region — it is built once and shared.

### 3.2 The region unit and the mandatory synthetic ROOT

Regions are exactly `parseRegions()` regions (heading / fence), **plus one synthetic ROOT** spanning the whole projected body.

- **`ROOT_REGION_ID = ':root'`.** The leading `:` is outside `[A-Za-z0-9_-]`, the character class every real region id is drawn from (heading ids are `slugify()` output = `[a-z0-9-]`; explicit `<Region name>`/`<SectionHeading id>`/`<!-- region: -->` names match `[A-Za-z0-9_-]+`). So `:root` **cannot collide** with any `parseRegions` id nor be produced by any authorable anchor. This is why the sentinel is collision-proof rather than merely unlikely.
- ROOT's span is `[0, lineCount-1]` of the projected content — it contains every finding.

**Justification (P0 blocker #1):** with the region model as-shipped, 316/360 real findings (88%) land outside every `parseRegions` region because findings nest under top-level LogSeq source-group bullets, not markdown headings. Without ROOT, 88% of findings would attribute to nothing. ROOT makes a flat grounded page degrade to exactly today's single page-level number, and a genuinely multi-section page degrades gracefully to per-heading scores.

### 3.3 Attribution rule — exactly one region per finding (a partition)

Each finding-line at 0-based index `L` attributes to **the innermost containing region**:

- Candidate regions = every `parseRegions` region whose `regionSpan()` `[s,e]` satisfies `s ≤ L ≤ e`.
- Innermost = the candidate with the **greatest span-start `s`** (ties broken by **smallest end `e`**). For properly-nested heading regions this is unambiguous — a child region starts strictly after its parent.
- If no `parseRegions` region contains `L` → attribute to **ROOT**.

**Nested/sub-heading regions each get their own score** and own **only their directly-contained findings** — a finding under `### Child` counts toward `child`, never toward the enclosing `## Parent`. Consequence: findings are **partitioned** across `{ROOT} ∪ parseRegions`, disjoint and complete. This is the property that makes the page roll-up (§3.6) equal whole-page cited/total with **no double counting** — the single most important invariant in the design, and the reason "innermost only" is not negotiable.

ROOT therefore owns precisely the findings outside every `parseRegions` region (P0's "outside-all" bucket). On the one catch-all page (Legal-Access, whose single top heading swallows the whole body) ROOT owns 0 findings and the heading owns them all — the correct graceful behavior.

**Output completeness:** `PageRecall.regions` emits ROOT **plus every `parseRegions` region**, even zero-finding ones (`## Sources`, `## Backports` → `total:0, recall:null`), so the partition is auditable (`Σ region.total === page.total`).

### 3.4 The finding grammar — band allowlist, not generic `_(…)_`

A **finding-line** is a line carrying **≥1 band marker whose inner text matches the allowlist**. A band marker is `_(` + `[^)]+` + `)_`; the captured inner text is trimmed and classified:

| Inner text (trimmed)            | Class    | Counts as finding? |
|---------------------------------|----------|--------------------|
| `well-supported`                | supported| yes                |
| `supported`                     | supported| yes                |
| `grounded`                      | supported| yes                |
| starts with `unverified` (e.g. `unverified: unsupported by cited source`) | unverified | yes |
| `repaired`                      | excluded | **no**             |
| `Manual annotation — …`         | excluded | **no**             |
| any other italic note (`Sequence now stale …`, `Supersedes …`) | excluded | **no** |

Rules that make this hard-to-vary (each ties to a P0 blocker, all confirmed against the live corpus counts — `well-supported`×301, `supported`×16, `unverified: …`×55, `grounded`×1, `repaired`×108, plus 3 free-form editorial italics):

1. **Allowlist, not `_(…)_`** (blocker #2): a naive `_(…)_` match over-counts because `_(repaired)_`, `_(Manual annotation — …)_`, and free-form editorial italics all match. The classifier drives off the allowlist.
2. **Capture `[^)]+` first, then allowlist-match** (blocker #3): the band `_(unverified: unsupported by cited source)_` contains a colon and spaces; a `[a-z-]+`-only band regex would miss it. The regex captures `[^)]+` and matches the trimmed capture against the allowlist (`unverified`-prefix for the unverified class; **exact** match for the supported class — `supported` must not substring-match inside `well-supported`/`unsupported`).
3. **`repaired` is a repair-provenance mark, excluded** (blocker #4): it co-occurs on the same line as a real band, e.g. `_(well-supported)_ _(repaired)_ [^k]`. Because a finding is counted **once per line** (not once per marker), a line with one supported band and one `repaired` mark is one finding, not two.
4. **Editorial `_(…)_` italics excluded** (blocker #5): identified as findings only by allowlisted band (or, defensively, a trailing `[^key]`), never by bare `_(…)_`.

The `- Citations` definition lines (`- [^k]: … · finding:: <uuid>`) and the `- Unverified (not grounded)` / `- Citations` header lines carry **no band** and are therefore never finding-lines — the allowlist gate excludes them automatically.

### 3.5 The metric — cited / total (binding-coverage)

Within a region span:

- **`total`** = number of finding-lines (§3.4).
- **`cited`** = number of finding-lines that also carry a **trailing inline footnote ref** `[^key]` (an occurrence of `[^…]` **not** immediately followed by `:`, to exclude a definition line — though definition lines are already excluded by having no band).
- **`recall`** = `total > 0 ? cited / total : null`.

Counting `cited` off **`[^key]` presence** (not off band spelling) is deliberate: it is the exact binding-coverage definition (a claim is "bound" iff it cites a source) and it is independent of band-spelling drift. On the real corpus the supported-class bands carry a `[^key]` and the `unverified` band does not (P0), so the two views agree — but the counting rule keys off the ref, which is the deterministic signal.

**Zero-findings** (P0 blocker #7 — the ADR page, `citation-recall:: 1.0`, 0 bands/0 refs): `total === 0 ⇒ recall === null`. Never divide by zero, never emit `NaN`, never coerce to `1.0` or `0`. `null` means "not applicable — no findings here."

### 3.6 Findings→region UUID mapping and page roll-up

- `resolveCitationMap(projected)` parses the page-global Citations block. Definition line grammar (pinned against the live page): `  - [^<key>]: <text> · finding:: <uuid>` where `<key>` = `[^\]]+` and `<uuid>` = `[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}` (with a defensive `finding::\s*(\S+)` fallback). Returns `Map<key, uuid>`.
- **`RegionRecall.findingIds`** = for each **cited** finding-line in the region (document order), take its inline `[^key]`, resolve via the map, push the UUID. So `findingIds` holds the UUIDs of the **cited** findings; on a well-formed page `findingIds.length === cited` (P0: 304/304 refs resolve). **Uncited** findings (the `unverified` block) carry no `[^key]` and therefore contribute to `total` but expose **no UUID** — there is no UUID handle for them in the files-canonical projection, and inventing one would not be deterministic.
- **Page roll-up:** `PageRecall.cited = Σ region.cited`, `total = Σ region.total`, `recall = total>0 ? cited/total : null`. Because attribution is a partition (§3.3), this equals whole-page cited/total — a checkable invariant.

### 3.7 Scope — grounded pages only

Groundedness is decided from the **raw** source via the existing `sourceIsGrounded(raw)` (the projected content has no frontmatter to test). The pure scorer is groundedness-agnostic (feed it a non-grounded page and it returns all-null harmlessly); the **wiring layer enforces scope**: `regionRecall` is computed and attached **only** for grounded entries; a non-grounded entry gets no `regionRecall` (undefined / omitted).

### 3.8 Region-granular GATING — OUT of scope (deferred, justified)

Gating (refusing/excluding a below-bar region) is **out of scope for 6ji.8**. Three reasons:

1. **Proxy, not authority.** Files-derived binding-coverage is a proxy; kb_cli's page-level number is the authoritative faithfulness signal. Excluding content on a proxy could refuse regions the authoritative page-gate passed — a correctness regression.
2. **No verdict slot in the reconcile model.** A region is either *projected* (regenerate, source-wins) or *free* (never touched). There is no "drop because low recall" verdict; adding one changes the `ProjVerdict` plan model — a design change beyond a scoring bead.
3. **No granularity to gate on yet.** With 88% of findings in ROOT, per-region gating would today be indistinguishable from the existing page-gate, adding risk with no benefit until source-group sub-regions exist.

**Follow-up:** file a bead "6ji.8 follow-up — region-granular refusal once ROOT is sub-divided by source-group bullet," dependent on the sub-region enhancement.

### 3.9 Wiring — where per-region scores surface

- **Canonical surface:** extend `ManifestEntrySummary` (in `reconcile-projection.ts`) with `regionRecall?: PageRecall`. In `reconcileManifest()`, after `grounded = sourceIsGrounded(raw)` and after building `desiredContent`, for grounded entries set `regionRecall = scoreRegionRecall(desiredContent, slug)` and attach; non-grounded entries omit it.
- **Score the written content.** Input is the same `desiredContent` string the reconciler writes (post-`stampProjected`). `stampProjected` only inserts inert `<!-- projected: … -->` comment lines (no band, no ref) into heading regions, so the score is identical pre/post stamp (asserted in §5). Re-parsing regions from the post-stamp content keeps line indices internally consistent.
- **CLI reporting** (`bin/kb-reconcile.ts`): `--json` already serializes `ManifestEntrySummary`, so `regionRecall` rides along for free. The text reporter (`runBatch`, and the single-page `main`) prints, for grounded entries, the page roll-up and any non-null per-region recalls, e.g. `recall 36/44=0.82 · :root 0/0=n/a`. Display-only; the number of truth is in `regionRecall`.
- **Single-page path:** `main()` in `bin/kb-reconcile.ts`, for a grounded `--source`, computes `scoreRegionRecall(desiredContent, title)` and includes it in the `--json` object and a text summary line.

---

## 4. Data shapes (canonical)

```ts
const ROOT_REGION_ID = ':root';

interface RegionRecall {
  id: string;
  kind: 'heading' | 'fence' | 'root';
  source?: string;
  findingIds: string[];   // cited findings' UUIDs, document order; length === cited on a well-formed page
  cited: number;          // integer, authoritative
  total: number;          // integer, authoritative
  recall: number | null;  // cited/total, or null when total === 0
}

interface PageRecall {
  regions: RegionRecall[]; // [ROOT, …parseRegions regions in doc order]
  cited: number;
  total: number;
  recall: number | null;
}

// ManifestEntrySummary gains:
//   regionRecall?: PageRecall;   // present iff the source was grounded
```

**Regex constants (pinned):**

```
BAND       = /_\(([^)]+)\)_/g                     // capture inner, then allowlist-classify
SUPPORTED  = inner ∈ {"well-supported","supported","grounded"}   // exact
UNVERIFIED = /^unverified\b/i.test(inner)          // colon/spaces tolerated
REF_INLINE = /\[\^[^\]]+\](?!:)/                   // a citation reference on a finding line
CITE_DEF   = /^\s*-?\s*\[\^([^\]]+)\]:\s*.*\bfinding::\s*([0-9a-fA-F-]{36}|\S+)/   // Citations block
```

---

## 5. Acceptance criteria (single-probe, atomic)

Marker/ref **survival** through projection is **assumed** (P0 verified 8/8 pages byte-intact) and is not re-tested here. Each item below names ONE verifiable probe that P2 turns into a failing test. Fixtures are small hand-authored projected-page strings unless a live/snapshot page is named.

1. **ROOT id constant.** `ROOT_REGION_ID === ':root'` — a single equality assertion.
2. **ROOT attribution of heading-less findings.** Fixture: 3 band bullets under top-level bullets, no heading. Probe: the `:root` region's `total === 3`.
3. **Innermost-heading attribution.** Fixture: `## Alpha` with one cited band bullet in its body. Probe: region `alpha` has `total === 1` **and** `:root` `total === 0`.
4. **Nested regions attribute to innermost only (partition).** Fixture: `## Parent` containing `### Child` containing one band bullet. Probe: region `child` `total === 1` **and** region `parent` `total === 0`.
5. **Allowlist accepts the four band spellings.** Fixture: four bullets, one each `_(well-supported)_`, `_(supported)_`, `_(grounded)_`, `_(unverified: unsupported by cited source)_`. Probe: page `total === 4`.
6. **`_(repaired)_` does not inflate a finding.** Fixture line: `- x _(well-supported)_ _(repaired)_ [^k]` (+ matching Citations def). Probe: enclosing region `total === 1` (not 2).
7. **`_(Manual annotation — …)_` excluded.** Fixture: a bullet whose only marker is `_(Manual annotation — this page is research-generated…)_`. Probe: page `total === 0`.
8. **Free-form editorial italic excluded.** Fixture: a bullet with only `_(Sequence now stale relative to the dealer path above.)_`. Probe: page `total === 0`.
9. **`unverified:` colon+spaces spelling matches and is uncited.** Fixture: one `_(unverified: unsupported by cited source)_` bullet, no `[^key]`. Probe: region `total === 1` **and** `cited === 0`.
10. **Cited keys off trailing `[^key]`.** Fixture: one `_(well-supported)_ [^k]` bullet + one `_(unverified: …)_` bullet (no ref). Probe: region `cited === 1`.
11. **recall = cited/total.** Fixture: 3 cited + 1 uncited finding in one region. Probe: that region `recall === 3/4` (and `total === 4`, `cited === 3`).
12. **Zero-findings → null recall (no divide-by-zero).** Fixture: grounded-style page body with 0 bands/0 refs. Probe: `page.recall === null` **and** every `region.recall === null` (no `NaN`).
13. **findings→region UUID mapping.** Fixture: one cited bullet `[^k]` + Citations `- [^k]: … · finding:: <UUID>`. Probe: that region's `findingIds` `=== [<UUID>]`.
14. **Uncited findings expose no UUID.** Fixture: one `_(unverified: …)_` bullet (no ref). Probe: its region `total === 1` **and** `findingIds.length === 0`.
15. **Citations definition lines are not findings.** Fixture: a `- Citations` block with 2 def lines and no body findings. Probe: page `total === 0` (def lines carry no band).
16. **Page roll-up is the partition sum.** Any multi-region fixture. Probe: `page.cited === Σ regions[].cited` **and** `page.total === Σ regions[].total`.
17. **Grounded-only wiring — non-grounded omits.** `reconcileManifest` over a manifest whose source lacks `citation-recall::`. Probe: that entry's `regionRecall === undefined`.
18. **Grounded wiring — summary carries `regionRecall`.** `reconcileManifest` over a grounded source. Probe: that entry's `regionRecall.regions` contains a region with `id === ':root'`.
19. **Stamp-neutrality.** Heading-bearing grounded fixture. Probe: `scoreRegionRecall(projectSourcePage(raw))` deep-equals `scoreRegionRecall(stampProjected(projectSourcePage(raw), title))` (same cited/total).
20. **Real-corpus anchor.** Project the live/snapshot "AI Agent Memory Empowered by Knowledge Graphs (Book Notes)" page (P0: 16 bands, 16 refs, 0 in-region). Probe: `page.total === 16`, `page.cited === 16`, and the `:root` region `total === 16`.

---

## 6. Open questions

1. **Frontmatter vs. binding-coverage divergence.** The projected page can't see `citation-recall::` (stripped), and NLI-scored frontmatter may differ numerically from our binding-coverage. Do we ever want to surface *both* (raw-source frontmatter number **and** files-derived per-region number) side-by-side for reporting? Non-blocking; the per-region metric stands alone. Proposed: report both but never assert equality.
2. **ROOT sub-division.** When (if) a future pass splits ROOT into per-source-group sub-regions, does each source-group bullet become a fence region, or a new synthetic sub-region kind? Deferred; ROOT is the P0-mandated floor.
3. **Multiple `[^key]` on one finding line.** Not observed across 304 refs (P0 #9). Current rule: `cited` is per-line (a line with any `[^key]` is one cited finding); `findingIds` would take the first ref. If multi-ref findings ever appear, decide whether `findingIds` lists all refs' UUIDs. Parse defensively; punt the semantics.
4. **`recall` float comparison.** `recall` is exact `cited/total` (unrounded). Tests should prefer asserting the integer `cited`/`total`; if a rounded display value is ever needed, define the rounding at the CLI layer, not in `PageRecall`.
