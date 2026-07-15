/**
 * reconcile-projection — wire the region-grain reconciler (kb-projection-6ji.1) to
 * the REAL projection pipeline and a real page on disk.
 *
 * Desired-state comes from the actual projection: a freshly-projected page is itself
 * region-structured (every `## heading` is a region; see region-core.parseRegions),
 * so DESIRED = parseRegions(projectedContent). We reconcile it, region by region,
 * against the ACTUAL page file, using a persisted PRIOR-hash sidecar to tell a
 * human's hand-edit (DRIFT → preserve) apart from a stale output (UPDATE → apply).
 *
 * First run (no page yet) writes the projection verbatim and seeds the sidecar.
 * Re-runs reconcile. Creates copy the desired region's whole span (format-agnostic:
 * works for `##`, <SectionHeading/>, and <Region> alike). Section add/remove beyond
 * create is surfaced (missing predecessor → skipped; orphan → preserved), not
 * silently applied — conservative by design.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import {
  createRegionAfter,
  hashRegionBody,
  normalizeForHash,
  parseRegions,
  regionBody,
  regionSpan,
  replaceRegionBody,
} from './region-core';
import { transformBody } from '../lib/logseqToAstro';

export type ProjVerdict = 'create' | 'update' | 'unchanged' | 'drifted' | 'conflict' | 'orphan';

export interface ProjPlanItem {
  id: string;
  verdict: ProjVerdict;
  reason: string;
}

/** id → last-projected normalized-body hash. */
export type PriorState = Record<string, string>;

function hashBody(body: string): string {
  return createHash('sha256').update(normalizeForHash(body)).digest('hex').slice(0, 16);
}

/** Per-region plan reconciling a freshly-projected page against the page on disk. */
export function planProjection(desiredContent: string, actualContent: string, prior: PriorState): ProjPlanItem[] {
  const desired = parseRegions(desiredContent, 'desired');
  const actualById = new Map(parseRegions(actualContent, 'actual').map((r) => [r.id, r] as const));
  const items: ProjPlanItem[] = [];

  for (const d of desired) {
    const a = actualById.get(d.id);
    const dh = hashBody(regionBody(desiredContent, d));
    if (!a) { items.push({ id: d.id, verdict: 'create', reason: 'in projection, absent from page' }); continue; }
    const ah = hashRegionBody(actualContent, a);
    const ph = prior[d.id];
    if (ah === dh) { items.push({ id: d.id, verdict: 'unchanged', reason: 'page already matches projection' }); continue; }
    if (!ph) { items.push({ id: d.id, verdict: 'update', reason: 'no prior baseline; taking projection' }); continue; }
    const humanTouched = ah !== ph;
    const sourceChanged = dh !== ph;
    if (humanTouched && sourceChanged) items.push({ id: d.id, verdict: 'conflict', reason: 'hand-edit AND projection changed' });
    else if (humanTouched) items.push({ id: d.id, verdict: 'drifted', reason: 'hand-edited since last projection — preserved' });
    else items.push({ id: d.id, verdict: 'update', reason: 'projection changed; page clean' });
  }

  const desiredIds = new Set(desired.map((r) => r.id));
  for (const a of parseRegions(actualContent, 'actual')) {
    if (!desiredIds.has(a.id)) items.push({ id: a.id, verdict: 'orphan', reason: 'in page, not in projection — preserved' });
  }
  return items;
}

export interface ApplyProjectionResult {
  content: string;
  items: ProjPlanItem[];
  newPrior: PriorState;
  applied: string[];
  created: string[];
  preserved: string[];
  skipped: string[];
}

/** Apply the projection plan: update clean regions, preserve drift/conflict/orphan, create absent ones. */
export function applyProjection(desiredContent: string, actualContent: string, prior: PriorState): ApplyProjectionResult {
  const items = planProjection(desiredContent, actualContent, prior);
  const desired = parseRegions(desiredContent, 'desired');
  const desiredById = new Map(desired.map((r) => [r.id, r] as const));
  const desiredOrder = desired.map((r) => r.id);
  const desiredLines = desiredContent.split(/\r?\n/);

  let content = actualContent;
  const applied: string[] = [];
  const created: string[] = [];
  const preserved: string[] = [];
  const skipped: string[] = [];

  // Updates first — they don't move region boundaries, so ids stay resolvable.
  for (const item of items.filter((i) => i.verdict === 'update')) {
    const r = parseRegions(content, 'p').find((x) => x.id === item.id)!;
    content = replaceRegionBody(content, r, regionBody(desiredContent, desiredById.get(item.id)!));
    applied.push(item.id);
  }
  // Creates — copy the desired region's whole span (heading/anchor + body) after its
  // predecessor in the desired order, if that predecessor resolves in the page.
  for (const item of items.filter((i) => i.verdict === 'create')) {
    const dRegion = desiredById.get(item.id)!;
    const idx = desiredOrder.indexOf(item.id);
    const predId = idx > 0 ? desiredOrder[idx - 1] : undefined;
    const pred = predId ? parseRegions(content, 'p').find((x) => x.id === predId) : undefined;
    if (!pred) { skipped.push(item.id); continue; }
    const [s0, s1] = regionSpan(dRegion);
    content = createRegionAfter(content, pred, desiredLines.slice(s0, s1 + 1));
    created.push(item.id);
  }
  for (const item of items) {
    if (item.verdict === 'drifted' || item.verdict === 'conflict' || item.verdict === 'orphan') preserved.push(item.id);
  }

  // PROVENANCE INVARIANT: `prior` is the hash of what projection last WROTE. Advance
  // it only for regions now in sync with the projection (applied/created/unchanged).
  // For a preserved hand-edit, KEEP the old baseline — otherwise the human's text
  // would silently become the new baseline and the next source change would stomp it
  // as a "clean" update instead of surfacing a conflict.
  const newPrior: PriorState = { ...prior };
  const finalById = new Map(parseRegions(content, 'p').map((r) => [r.id, r] as const));
  for (const d of desired) {
    const r = finalById.get(d.id);
    if (!r) continue;
    const desiredHash = hashBody(regionBody(desiredContent, d));
    if (hashRegionBody(content, r) === desiredHash) newPrior[d.id] = desiredHash; // in sync
    // else: preserved drift — leave newPrior[d.id] at the prior baseline
  }
  return { content, items, newPrior, applied, created, preserved, skipped };
}

export interface ReconcilePageResult {
  firstRun: boolean;
  items: ProjPlanItem[];
  applied: string[];
  created: string[];
  preserved: string[];
  skipped: string[];
  pageFile: string;
  sidecarFile: string;
}

function writeAtomic(file: string, content: string): void {
  const tmp = `${file}.reconcile-${process.pid}.tmp`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, file);
}

/**
 * Reconcile a projected page against its file on disk, persisting the prior-hash
 * sidecar. First run seeds; re-runs preserve hand-edits. `dryRun` computes the plan
 * without writing.
 */
export function reconcilePage(opts: {
  desiredContent: string;
  pageFile: string;
  sidecarFile: string;
  dryRun?: boolean;
}): ReconcilePageResult {
  const { desiredContent, pageFile, sidecarFile, dryRun } = opts;
  const prior: PriorState = existsSync(sidecarFile) ? JSON.parse(readFileSync(sidecarFile, 'utf8')) : {};

  if (!existsSync(pageFile)) {
    const seed: PriorState = {};
    for (const r of parseRegions(desiredContent, 'desired')) seed[r.id] = hashRegionBody(desiredContent, r);
    if (!dryRun) {
      writeAtomic(pageFile, desiredContent);
      writeAtomic(sidecarFile, JSON.stringify(seed, null, 2));
    }
    const items = parseRegions(desiredContent, 'desired').map((r): ProjPlanItem => ({ id: r.id, verdict: 'create', reason: 'first projection' }));
    return { firstRun: true, items, applied: [], created: items.map((i) => i.id), preserved: [], skipped: [], pageFile, sidecarFile };
  }

  const actual = readFileSync(pageFile, 'utf8');
  const res = applyProjection(desiredContent, actual, prior);
  if (!dryRun) {
    writeAtomic(pageFile, res.content);
    writeAtomic(sidecarFile, JSON.stringify(res.newPrior, null, 2));
  }
  return {
    firstRun: false,
    items: res.items,
    applied: res.applied,
    created: res.created,
    preserved: res.preserved,
    skipped: res.skipped,
    pageFile,
    sidecarFile,
  };
}

/**
 * Project a real LogSeq source page to region-structured markdown via the REAL
 * transform (logseqToAstro.transformBody). Strips the leading LogSeq page-property
 * block (the loader normally lifts it into frontmatter). publishedSlugs/titleToSlug
 * default empty (unresolved wikilinks render as spans) unless supplied.
 */
export function projectSourcePage(
  rawSource: string,
  publishedSlugs: Set<string> = new Set(),
  titleToSlug: Map<string, string> = new Map(),
): string {
  const lines = rawSource.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && /^[A-Za-z0-9_.-]+::/.test(lines[i])) i++; // skip page-property block
  const body = lines.slice(i).join('\n').replace(/^\n+/, '');
  return transformBody(body, publishedSlugs, titleToSlug);
}
