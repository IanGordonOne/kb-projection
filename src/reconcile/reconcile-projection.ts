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
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  createRegionAfter,
  hashRegionBody,
  normalizeForHash,
  parseRegions,
  regionBody,
  type Region,
  regionSpan,
  replaceRegionBody,
} from './region-core';
import { resolveLogseqPath, transformBody } from '../lib/logseqToAstro';
import { slugify } from '../lib/logseq-primitives';

export type ProjVerdict = 'create' | 'update' | 'unchanged' | 'drifted' | 'conflict' | 'orphan' | 'delete' | 'grounded-drift';

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

/** Remove a region's whole span (anchor + body), collapsing the blank-line seam. */
function removeRegionSpan(content: string, region: Region): string {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);
  const [s0, s1] = regionSpan(region);
  lines.splice(s0, s1 - s0 + 1);
  return lines.join(eol).replace(/\n{3,}/g, `${eol}${eol}`);
}

/**
 * Per-region plan reconciling a freshly-projected page against the page on disk.
 * `groundedRegions` ids carry a faithfulness policy: a hand-edit to a grounded region
 * is a 'grounded-drift' faithfulness ALARM (still preserved) rather than ordinary
 * drift/conflict — the region must stay faithful to its cited source (kb-projection-6ji.4).
 */
export function planProjection(
  desiredContent: string,
  actualContent: string,
  prior: PriorState,
  groundedRegions: Set<string> = new Set(),
): ProjPlanItem[] {
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
    if (humanTouched && groundedRegions.has(d.id))
      items.push({ id: d.id, verdict: 'grounded-drift', reason: 'GROUNDED area hand-edited — faithfulness alarm; gate before outward projection' });
    else if (humanTouched && sourceChanged) items.push({ id: d.id, verdict: 'conflict', reason: 'hand-edit AND projection changed' });
    else if (humanTouched) items.push({ id: d.id, verdict: 'drifted', reason: 'hand-edited since last projection — preserved' });
    else items.push({ id: d.id, verdict: 'update', reason: 'projection changed; page clean' });
  }

  // Sections in the page but not the projection. Provenance decides the verdict:
  //   projection once owned it (id ∈ prior) AND still pristine → 'delete' (source
  //     dropped it; safe to prune). Otherwise → 'orphan' (hand-added, or hand-edited
  //     since projection owned it) → preserve.
  const desiredIds = new Set(desired.map((r) => r.id));
  for (const a of parseRegions(actualContent, 'actual')) {
    if (desiredIds.has(a.id)) continue;
    const ph = prior[a.id];
    if (ph !== undefined && hashRegionBody(actualContent, a) === ph) {
      items.push({ id: a.id, verdict: 'delete', reason: 'projection-owned, dropped from source, unmodified' });
    } else {
      items.push({ id: a.id, verdict: 'orphan', reason: ph === undefined ? 'hand-added, not projection-owned — preserved' : 'hand-edited since projection — preserved' });
    }
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
  deleted: string[];
  groundedDrift: string[];
}

/**
 * Apply the projection plan: update clean regions, create absent ones, preserve
 * drift/conflict/orphan/grounded-drift. `prune` (default false) additionally removes
 * 'delete' sections (projection-owned, dropped from source, unmodified). `groundedRegions`
 * marks faithfulness-policed areas — their drift is preserved but reported in groundedDrift.
 */
export function applyProjection(
  desiredContent: string,
  actualContent: string,
  prior: PriorState,
  prune = false,
  groundedRegions: Set<string> = new Set(),
): ApplyProjectionResult {
  const items = planProjection(desiredContent, actualContent, prior, groundedRegions);
  const desired = parseRegions(desiredContent, 'desired');
  const desiredById = new Map(desired.map((r) => [r.id, r] as const));
  const desiredOrder = desired.map((r) => r.id);
  const desiredLines = desiredContent.split(/\r?\n/);

  let content = actualContent;
  const applied: string[] = [];
  const created: string[] = [];
  const preserved: string[] = [];
  const skipped: string[] = [];
  const deleted: string[] = [];

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
  // Deletes — only when pruning; otherwise a 'delete' section is preserved.
  for (const item of items.filter((i) => i.verdict === 'delete')) {
    if (!prune) { preserved.push(item.id); continue; }
    const r = parseRegions(content, 'p').find((x) => x.id === item.id);
    if (!r) { skipped.push(item.id); continue; }
    content = removeRegionSpan(content, r);
    deleted.push(item.id);
  }
  const groundedDrift: string[] = [];
  for (const item of items) {
    if (item.verdict === 'drifted' || item.verdict === 'conflict' || item.verdict === 'orphan') preserved.push(item.id);
    else if (item.verdict === 'grounded-drift') { preserved.push(item.id); groundedDrift.push(item.id); }
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
  for (const id of deleted) delete newPrior[id]; // pruned sections leave the baseline
  return { content, items, newPrior, applied, created, preserved, skipped, deleted, groundedDrift };
}

/**
 * Read a `grounded-regions::` (LogSeq) / `grounded-regions:` (YAML) declaration from
 * a text's leading property/frontmatter block — a comma- or bracket-separated list of
 * region ids the KB has marked faithful-to-source. (kb-projection-6ji.4.)
 */
export function parseGroundedRegions(text: string): Set<string> {
  const m = text.match(/^\s*grounded-regions::?\s*(.+)$/m);
  if (!m) return new Set();
  return new Set(
    m[1]
      .replace(/^\[|\]$/g, '')
      .split(',')
      .map((s) => s.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean),
  );
}

export interface ReconcilePageResult {
  firstRun: boolean;
  items: ProjPlanItem[];
  applied: string[];
  created: string[];
  preserved: string[];
  skipped: string[];
  deleted: string[];
  groundedDrift: string[];
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
  prune?: boolean;
  groundedRegions?: Set<string>;
}): ReconcilePageResult {
  const { desiredContent, pageFile, sidecarFile, dryRun, prune } = opts;
  const groundedRegions = opts.groundedRegions ?? new Set();
  const prior: PriorState = existsSync(sidecarFile) ? JSON.parse(readFileSync(sidecarFile, 'utf8')) : {};

  if (!existsSync(pageFile)) {
    const seed: PriorState = {};
    for (const r of parseRegions(desiredContent, 'desired')) seed[r.id] = hashRegionBody(desiredContent, r);
    if (!dryRun) {
      writeAtomic(pageFile, desiredContent);
      writeAtomic(sidecarFile, JSON.stringify(seed, null, 2));
    }
    const items = parseRegions(desiredContent, 'desired').map((r): ProjPlanItem => ({ id: r.id, verdict: 'create', reason: 'first projection' }));
    return { firstRun: true, items, applied: [], created: items.map((i) => i.id), preserved: [], skipped: [], deleted: [], groundedDrift: [], pageFile, sidecarFile };
  }

  const actual = readFileSync(pageFile, 'utf8');
  const res = applyProjection(desiredContent, actual, prior, Boolean(prune), groundedRegions);
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
    deleted: res.deleted,
    groundedDrift: res.groundedDrift,
    pageFile,
    sidecarFile,
  };
}

export type FaithfulnessGateResult =
  | { status: 'pass'; applicable: boolean }
  | { status: 'refused'; reason: string }
  | { status: 'unenforced'; reason: string };

/**
 * The GATE half of grounded flag+gate: shell out to the CANONICAL kb_cli
 * faithfulness-gate (never a reimplemented threshold — skill mandate). exit 3 →
 * refused (below citation-recall minimum). If kb_cli is absent/unusable, degrade to
 * 'unenforced' so the grounded-drift FLAG still stands as an advisory alarm.
 */
export function faithfulnessGate(pageFile: string, faithfulnessMin: number, kbCli = 'kb_cli'): FaithfulnessGateResult {
  try {
    const out = execSync(`${kbCli} faithfulness-gate --page ${JSON.stringify(pageFile)} --faithfulness-min ${faithfulnessMin}`, {
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString();
    const parsed = JSON.parse(out) as { refused?: boolean; reason?: string; applicable?: boolean };
    if (parsed.refused) return { status: 'refused', reason: parsed.reason ?? 'below faithfulness minimum' };
    return { status: 'pass', applicable: parsed.applicable !== false };
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer };
    if (e.status === 3 && e.stdout) {
      try {
        const parsed = JSON.parse(e.stdout.toString()) as { reason?: string };
        return { status: 'refused', reason: parsed.reason ?? 'below faithfulness minimum' };
      } catch { /* fall through */ }
    }
    return { status: 'unenforced', reason: `kb_cli faithfulness-gate unavailable (${(err as Error).message.split('\n')[0]})` };
  }
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

/**
 * Resolve publishedSlugs + titleToSlug from a publish manifest — the SAME derivation
 * the loader uses (src/lib/loader.ts) — so `projectSourcePage` resolves `[[wikilinks]]`
 * to real `/kb/<slug>/` links instead of unresolved spans. (6ji.3 item 1.)
 */
export function slugMapsFromManifest(manifestPath: string): {
  publishedSlugs: Set<string>;
  titleToSlug: Map<string, string>;
} {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { entries: Array<{ title: string; exclude?: boolean }> };
  const published = (manifest.entries ?? []).filter((e) => !e.exclude);
  return {
    publishedSlugs: new Set(published.map((e) => slugify(e.title))),
    titleToSlug: new Map(published.map((e) => [e.title, slugify(e.title)] as const)),
  };
}

export interface ManifestEntrySummary {
  title: string;
  slug: string;
  error?: string;
  firstRun?: boolean;
  applied?: string[];
  created?: string[];
  deleted?: string[];
  preserved?: string[];
  groundedDrift?: string[];
  skipped?: string[];
}

export interface ReconcileManifestResult {
  outDir: string;
  entries: ManifestEntrySummary[];
}

/**
 * Batch reconcile: project every published manifest entry and reconcile it into a
 * config-driven output dir (`<outDir>/<slug>.md` + `<slug>.reconcile.json`). This is
 * the pipeline step (6ji.3 item 2) — the same per-page loop the loader walks, but
 * emitting editable, drift-preserving page files instead of Astro's in-memory store.
 * Output location is a parameter, hardcoding no repo (6ji.3 item 4: config-driven).
 */
export function reconcileManifest(opts: {
  manifestPath: string;
  outDir: string;
  graphPath?: string;
  dryRun?: boolean;
  prune?: boolean;
}): ReconcileManifestResult {
  const { manifestPath, outDir, dryRun, prune } = opts;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    graphPath?: string;
    entries: Array<{ title: string; exclude?: boolean; file?: string }>;
  };
  const graphPages = join(opts.graphPath ?? manifest.graphPath ?? join(homedir(), 'Logseq', 'MyGraph'), 'pages');
  const { publishedSlugs, titleToSlug } = slugMapsFromManifest(manifestPath);
  const published = (manifest.entries ?? []).filter((e) => !e.exclude);
  if (!dryRun) mkdirSync(outDir, { recursive: true });

  const entries: ManifestEntrySummary[] = [];
  for (const entry of published) {
    const slug = slugify(entry.title);
    const sourcePath = resolveLogseqPath(entry as Parameters<typeof resolveLogseqPath>[0], graphPages);
    if (!sourcePath) { entries.push({ title: entry.title, slug, error: `source not found in ${graphPages}` }); continue; }
    try {
      const raw = readFileSync(sourcePath, 'utf8');
      const desiredContent = projectSourcePage(raw, publishedSlugs, titleToSlug);
      const groundedRegions = parseGroundedRegions(raw);
      const res = reconcilePage({
        desiredContent,
        pageFile: join(outDir, `${slug}.md`),
        sidecarFile: join(outDir, `${slug}.reconcile.json`),
        dryRun,
        prune,
        groundedRegions,
      });
      entries.push({
        title: entry.title,
        slug,
        firstRun: res.firstRun,
        applied: res.applied,
        created: res.created,
        deleted: res.deleted,
        preserved: res.preserved,
        groundedDrift: res.groundedDrift,
        skipped: res.skipped,
      });
    } catch (err) {
      entries.push({ title: entry.title, slug, error: (err as Error).message.split('\n')[0] });
    }
  }
  return { outDir, entries };
}
