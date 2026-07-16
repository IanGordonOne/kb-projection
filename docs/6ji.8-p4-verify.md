# 6ji.8 P4 — Verification: red-capable harness + out-of-family audit

**Bead:** kb-projection-6ji.8.5 (P4 of the cross-vendor TDD chain 6ji.8)
**Date:** 2026-07-15
**Coordinator:** Claude (Opus). **Out-of-family auditor:** Cato (GPT).

Two parts, per the cross-vendor TDD Run workflow: (1) a **red-capable** verification
harness the coordinator built and ran on real data, demonstrated able to go RED then green;
(2) an **out-of-family adversarial audit** of the whole spec+tests+code triple.

---

## Part 1 — Red-capable verification harness (coordinator-run)

The scorer's hardest real-world claims are (a) the **partition invariant** (page roll-up ==
Σ region, no double-count/drop) and (b) that per-region recall **actually moves** when a
finding loses its cite — i.e. the harness can go RED, not just green.

### RED demonstration (a green-only harness proves nothing)

Loaded the real projected grounded page *AI Agent Memory Empowered by Knowledge Graphs
(Book Notes)*, scored it, then deleted **one** inline `[^key]` cite from a cited finding
line and re-scored:

| State | total | cited | recall | partition (Σregion == page) |
|-------|------:|------:|-------:|:---:|
| GREEN (unmodified) | 16 | 16 | 1.000 | OK |
| **RED** (one cite deleted) | 16 | **15** | **0.9375** | OK |

Assertions, all true:
- Breaking a cite drops `cited` by **exactly 1** (16→15) — the metric responds to the signal.
- `total` (finding count) is **unchanged** (16) — deleting a *cite* is not deleting a *finding*.
- `recall` **dropped** (1.0 → 0.9375) — **the harness can go RED.**
- The partition invariant holds in **both** states (Σ region total/cited == page total/cited).
- GREEN recall `1.0` equals the source's frontmatter `citation-recall:: 1.0`.

### Corpus cross-check — files-derived proxy vs the authoritative frontmatter number

Scored all **8** real grounded pages and compared the deterministic, files-derived
binding-coverage recall against each page's `citation-recall::` frontmatter (kb_cli's
authoritative promote-time number). The partition invariant was also checked per page.

| Partition | frontmatter | computed | cited/total | regions | page |
|:---:|---:|---:|---:|---:|---|
| OK | 0.837 | 0.837 | 36/43 | 2 | Westwood Legal-Access & ROW Provenance |
| OK | 1.0 | **null** | 0/0 | 3 | Distributed-Systems Foundations (ADR-0002) |
| OK | 0.81 | 0.810 | 51/63 | 1 | Westwood Site-Safety & Build Provenance |
| OK | 0.96 | 0.960 | 24/25 | 1 | Westwood Planning & Ag-Buffer Provenance |
| OK | 1.0 | 1.000 | 16/16 | 2 | AI Agent Memory Empowered by KGs |
| OK | 0.793 | 0.793 | 46/58 | 1 | Westwood Water & Septic Provenance |
| OK | 0.918 | 0.918 | 45/49 | 1 | Westwood Fire & Access Provenance |
| OK | 0.819 | 0.819 | 86/105 | 1 | Westwood Title & Encumbrance Provenance |

**Reads:**
- The files-derived proxy **reproduces the authoritative frontmatter number to 3 decimals on
  all 7 pages with findings.** These pages were promoted with kb_cli's `scoring:"binding"`
  fallback, so binding-coverage == the frontmatter value — strong independent evidence the
  metric semantics are correct, not merely test-passing.
- The **zero-findings** page (ADR-0002, `citation-recall:: 1.0`, 0 findings) correctly scores
  `recall: null` — no divide-by-zero, no false `1.0`/`0` coercion (spec §3.5, AC#12).
- **Partition holds on every page** (Σ region == page), on real data with real nesting.

### Test-suite state (coordinator-reproduced)
- `bun test test/reconcile/region-recall.test.ts` → **20/20 pass**.
- `bun test` (full) → **237 pass / 0 fail** (217 pre-existing + 20 new, zero regressions).
- `bun run typecheck` (`tsc --noEmit`, strict) → clean.
- Test-file lock (`shasum -c` vs the P2 snapshot) → both files byte-identical; GREEN earned.

---

## Part 2 — Out-of-family adversarial audit (Cato / GPT)

**Cato verdict: `concerns`** — and, decisively, **no correctness defect in the shipped
scorer.** Every correctness probe Cato ran (CRLF, fence containers, nested attribution,
exact-match bands, zero-findings null, multi-ref, dangling ref) returned spec-correct
results. The concerns are **test-adequacy**: several rules §3.4/§3.3 call "hard-to-vary"
were not *locked* by any §5 test, so a subtly-wrong reimplementation could still pass the
20 acceptance tests — precisely the same-family blind spot the out-of-family seat exists to
catch. I verified each finding myself before acting.

| Finding | Sev | Coordinator-verified | Remediation |
|---|---|---|---|
| **#16 partition test is tautological** — `page.cited === Σ region.cited` holds by construction (region-recall.ts:164-171), so a double-count/drop moves both sides together and escapes | major | ✓ confirmed | New test asserts page + per-region totals against **independent hardcoded integers** (3/2, root 1/1, sec 2/1) |
| **Exact-match band rule unguarded** — no `_(unsupported)_`-only negative fixture; an `includes("supported")` impl passes all 20 | major | ✓ confirmed (impl correctly yields 0, but untested) | New test locks `_(unsupported)_`/`_(well-unsupported-thing)_` → `total === 0` |
| **CITE_DEF truncates a >36 all-hex value** — `[0-9a-fA-F-]{36}` captured a 40-char value as its first 36 | minor (latent bug) | ✓ confirmed (returned 36) | **Fixed** region-recall.ts:10 — added `(?![0-9a-fA-F-])` lookahead so it falls through to `\S+`; new test locks it |
| **Dangling ref** — `cited` counts an unresolved `[^key]`; `findingIds.length < cited` | minor | ✓ confirmed (spec §3.6 "well-formed page" caveat; correct but untested) | New test pins `cited:1 / findingIds:0` |
| **CRLF + fence-container paths unlocked** | minor | ✓ confirmed correct | New CRLF test + fence-region-container test added |
| Heading-line finding contaminates the heading slug (`total` still correct) | minor (cosmetic) | ✓ confirmed cosmetic | Noted; not a scoring defect |

All remediations are **test-only additions plus one 1-token regex hardening** — no change to
the scorer's semantics. Post-remediation: `test/reconcile/region-recall.test.ts` = **26/26**,
full suite **243 pass / 0 fail**, `tsc --noEmit` clean. The two majors now go RED against the
exact wrong-impls Cato described (verified: an `includes()` band check and a double-counting
attributor both fail the new locks).

---

## Overall verdict — **GO**

The shipped feature is correct against the spec's semantics on every probe (coordinator harness
+ Cato audit agree), reproduces kb_cli's authoritative `citation-recall::` to 3 decimals on all
7 pages-with-findings, is red-capable (breaking a cite drops recall), holds the partition
invariant on real data, and the audit's test-adequacy concerns have been **remediated in-place**
(not deferred). No unresolved critical or major findings remain.

**Deferred as follow-ups (filed as beads, not blockers):**
1. `bin/kb-reconcile.ts` text-reporter per-region roll-up line (display-only; `regionRecall`
   already rides `--json`).
2. Region-granular *gating* (refuse a below-bar region) once ROOT is sub-divided by
   source-group bullet — spec §3.8, dependent on the sub-region enhancement.
