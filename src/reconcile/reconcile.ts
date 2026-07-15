/**
 * reconcile — region-grain projection reconciler (PROTOTYPE, kb-projection-6ji.1).
 *
 * The content-span altitude of the reconciler pattern kb-projection already runs at
 * the manifest grain (src/manifest/{patch,apply-patch,audit-drift}). Where the
 * manifest reconciler decides WHICH entries publish, this decides WHICH SPANS of a
 * projected page get structural edits vs. get preserved.
 *
 * Three-way, Terraform-style: DESIRED (what projection wants) vs PRIOR (the
 * last-projected per-region hash) vs ACTUAL (the region's live body). The prior leg
 * — the --expect-hash primitive from region.ts (kb-projection-6ji.2) — is what lets
 * us tell "the human edited this projected span" (DRIFT, preserve it) apart from
 * "the source changed and nobody touched the output" (UPDATE, apply it). That is the
 * exact capability the landscape scan (kb-projection w121yoj7t) found unbuilt.
 *
 * PROTOTYPE scope: proves the loop against an in-memory page; positioning for new
 * regions is by `afterId`; no cross-repo wiring (region logic is vendored in
 * ./region-core). Not wired to the real projection pipeline yet.
 */
import { createHash } from 'node:crypto';
import {
  createRegionAfter,
  hashRegionBody,
  normalizeForHash,
  parseRegions,
  regionBody,
  type Region,
  renderRegion,
  replaceRegionBody,
} from './region-core';

/** A region projection wants to exist with a given body. */
export interface DesiredRegion {
  id: string;
  body: string;
  /** For a region not yet present: which existing region to insert it after. */
  afterId?: string;
  /** How to author a newly-created region (default fence <Region>). */
  kind?: 'fence' | 'section';
  level?: number;
  text?: string;
}

export type Verdict = 'create' | 'update' | 'unchanged' | 'drifted' | 'conflict';

export interface PlanItem {
  id: string;
  verdict: Verdict;
  reason: string;
}

/** id → last-projected normalized-body hash (the reconciler's prior-state leg). */
export type PriorState = Record<string, string>;

/** Hash a raw desired body the same way region-core hashes a live region body. */
export function hashBody(body: string): string {
  return createHash('sha256').update(normalizeForHash(body)).digest('hex').slice(0, 16);
}

/**
 * Compute the per-region plan: what projection would do to converge `actual` to
 * `desired`, honoring `prior` so hand-edits are surfaced as drift, not clobbered.
 */
export function plan(actualContent: string, desired: DesiredRegion[], prior: PriorState): PlanItem[] {
  const byId = new Map(parseRegions(actualContent, 'page').map((r) => [r.id, r] as const));
  return desired.map((d) => {
    const r = byId.get(d.id);
    const dh = hashBody(d.body);
    if (!r) return { id: d.id, verdict: 'create', reason: 'absent in page' };
    const ah = hashRegionBody(actualContent, r);
    const ph = prior[d.id];
    if (ah === dh) return { id: d.id, verdict: 'unchanged', reason: 'already matches desired' };
    if (!ph) return { id: d.id, verdict: 'update', reason: 'no prior baseline; taking source' };
    const humanTouched = ah !== ph;
    const sourceChanged = dh !== ph;
    if (humanTouched && sourceChanged) return { id: d.id, verdict: 'conflict', reason: 'both hand-edit and source changed' };
    if (humanTouched) return { id: d.id, verdict: 'drifted', reason: 'hand-edited since last projection — preserved' };
    return { id: d.id, verdict: 'update', reason: 'source changed; output clean' };
  });
}

export interface ApplyResult {
  content: string;
  newPrior: PriorState;
  applied: string[];
  preserved: string[]; // drifted + conflict ids we deliberately did NOT touch
  skipped: string[]; // e.g. a create with no resolvable afterId
}

/**
 * Apply a plan: emit region edits for create/update verdicts, PRESERVE drifted and
 * conflict regions untouched, and return refreshed prior hashes for every desired
 * region present in the result.
 */
export function apply(actualContent: string, desired: DesiredRegion[], prior: PriorState): ApplyResult {
  const items = plan(actualContent, desired, prior);
  const desiredById = new Map(desired.map((d) => [d.id, d] as const));
  let content = actualContent;
  const applied: string[] = [];
  const preserved: string[] = [];
  const skipped: string[] = [];

  for (const item of items) {
    const d = desiredById.get(item.id)!;
    if (item.verdict === 'update') {
      const r = parseRegions(content, 'page').find((x) => x.id === item.id)!;
      content = replaceRegionBody(content, r, d.body);
      applied.push(item.id);
    } else if (item.verdict === 'create') {
      const afterId = d.afterId;
      const after = afterId ? parseRegions(content, 'page').find((x) => x.id === afterId) : undefined;
      if (!after) { skipped.push(item.id); continue; }
      const lines = renderRegion(d.kind ?? 'fence', item.id, { body: d.body, level: d.level, text: d.text });
      content = createRegionAfter(content, after, lines);
      applied.push(item.id);
    } else if (item.verdict === 'drifted' || item.verdict === 'conflict') {
      preserved.push(item.id);
    }
  }

  const newPrior: PriorState = { ...prior };
  const finalById = new Map(parseRegions(content, 'page').map((r) => [r.id, r] as const));
  for (const d of desired) {
    const r = finalById.get(d.id);
    if (r) newPrior[d.id] = hashRegionBody(content, r);
  }
  return { content, newPrior, applied, preserved, skipped };
}

/** One-line-per-region plan report (the audit-drift-style ranked-ish summary). */
export function formatPlan(items: PlanItem[]): string {
  const order: Record<Verdict, number> = { conflict: 0, drifted: 1, create: 2, update: 3, unchanged: 4 };
  return [...items]
    .sort((a, b) => order[a.verdict] - order[b.verdict])
    .map((i) => `  ${i.verdict.toUpperCase().padEnd(9)} ${i.id.padEnd(20)} ${i.reason}`)
    .join('\n');
}

// Re-export for callers that want the vendored hash of a live region.
export { hashRegionBody, type Region };
