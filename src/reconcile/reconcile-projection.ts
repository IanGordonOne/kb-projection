/**
 * reconcile-projection — region-level projection reconciler (kb-projection-6ji.*).
 *
 * CORRECTED MODEL (Ian, 2026-07-15): the boundary is PROJECTED vs NON-PROJECTED
 * region, NOT engine vs human.
 *   - A PROJECTED region carries a `projected` marker naming its KB source and is
 *     source-owned. If the page copy diverges from a fresh projection — a source
 *     change OR an off-source hand-edit — the remedy is REGENERATE (source-wins),
 *     matching the skill's page-level onlyStale / healthMonitor `hash-mismatch` →
 *     overwrite. Drift on a projected region is a defect, not an edit to preserve.
 *   - A NON-PROJECTED region is a free editing surface for ANYONE (humans AND
 *     engines/agents). It has no source, cannot drift, and is NEVER touched here.
 * A page mixes both (managed-block pattern); this reconciler manages only the
 * projected regions.
 *
 * Grounding (citation-recall / faithfulness) is a PAGE property of the source, gated
 * per-page via the canonical `kb_cli faithfulness-gate` — not a per-region concern.
 *
 * The prior-hash sidecar is the region-level analogue of the projection bridge; here
 * it only DETECTS/REPORTS the drift kind (hand-edited vs source-changed) — the remedy
 * is always source-wins. Unifying it with ~/.kyber/projection_bridge.json is a
 * follow-up (that file lives in the retired legacy path, absent from this repo).
 */
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  createRegionAfter,
  hashRegionBody,
  moveRegion,
  parseRegions,
  regionBody,
  type Region,
  regionSpan,
  replaceRegionBody,
} from './region-core';
import { resolveLogseqPath, transformBody } from '../lib/logseqToAstro';
import { slugify } from '../lib/logseq-primitives';

export type ProjVerdict = 'create' | 'regenerate' | 'unchanged' | 'remove';
export type DriftKind = 'hand-edited' | 'source-changed' | 'both';

export interface ProjPlanItem {
  id: string;
  verdict: ProjVerdict;
  reason: string;
  source?: string;
  /** For a regenerate: what diverged (reporting only — the remedy is always source-wins). */
  drift?: DriftKind;
}

/** id → last-projected normalized-body hash (region-level bridge; drift signal). */
export type PriorState = Record<string, string>;

/** Remove a region's whole span (anchor + body), collapsing the blank-line seam. */
function removeRegionSpan(content: string, region: Region): string {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);
  const [s0, s1] = regionSpan(region);
  lines.splice(s0, s1 - s0 + 1);
  return lines.join(eol).replace(/\n{3,}/g, `${eol}${eol}`);
}

const PROJECTED_ANCHOR_RE = /<(?:Region|SectionHeading)\b[^>]*\bprojected\b/;
const SOURCE_ATTR_RE = /\bsource=["']([^"']+)["']/;
const PROJECTED_COMMENT_RE = /^<!--\s*projected:\s*(.*?)-->$/;

/**
 * Is this region a PROJECTED (source-owned, managed) region? A projected region
 * carries a `projected` marker — either an attribute on its <Region>/<SectionHeading>
 * anchor, or a `<!-- projected: source="…" -->` comment as the FIRST body line (the
 * comment travels inside the region span, so it survives create/regenerate and renders
 * invisibly). Everything else is a free non-projected region.
 */
export function projectedMarker(content: string, region: Region): { projected: boolean; source?: string } {
  const lines = content.split(/\r?\n/);
  const anchor = lines[regionSpan(region)[0]] ?? '';
  if (PROJECTED_ANCHOR_RE.test(anchor)) return { projected: true, source: anchor.match(SOURCE_ATTR_RE)?.[1] };
  for (let i = region.bodyStart; i <= region.bodyEnd; i++) {
    const l = (lines[i] ?? '').trim();
    if (!l) continue;
    const cm = l.match(PROJECTED_COMMENT_RE);
    return cm ? { projected: true, source: cm[1].match(SOURCE_ATTR_RE)?.[1] } : { projected: false };
  }
  return { projected: false };
}

/**
 * Stamp projected markers onto a fresh projection so its regions declare themselves
 * source-owned. Inserts `<!-- projected: source="<title>#<id>" -->` as the first body
 * line of each heading region. Idempotent (skips a region already marked). The marker
 * travels with the region span and renders invisibly.
 */
export function stampProjected(content: string, sourceTitle: string): string {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  let lines = content.split(/\r?\n/);
  // Bottom-to-top so earlier insertions don't shift not-yet-processed anchors.
  const regions = parseRegions(lines.join('\n'), 'p').filter((r) => r.kind === 'heading');
  for (const r of [...regions].sort((a, b) => b.bodyStart - a.bodyStart)) {
    if (projectedMarker(lines.join('\n'), r).projected) continue;
    lines.splice(r.bodyStart, 0, `<!-- projected: source="${sourceTitle}#${r.id}" -->`, '');
  }
  return lines.join(eol);
}

/**
 * Plan the reconcile of a page against a fresh projection. DESIRED = the projected
 * regions the engine wants (from the fresh projection — all carry markers). Only
 * projected regions are considered; the page's non-projected regions are ignored
 * (free surface). Remedy is source-wins: any projected region that differs regenerates.
 */
export function planProjection(desiredContent: string, actualContent: string, prior: PriorState = {}): ProjPlanItem[] {
  const desired = parseRegions(desiredContent, 'desired');
  const actualRegions = parseRegions(actualContent, 'actual');
  const actualById = new Map(actualRegions.map((r) => [r.id, r] as const));
  const items: ProjPlanItem[] = [];

  for (const d of desired) {
    const source = projectedMarker(desiredContent, d).source;
    const a = actualById.get(d.id);
    if (!a) { items.push({ id: d.id, verdict: 'create', reason: 'projected region absent from page', source }); continue; }
    const dh = hashRegionBody(desiredContent, d);
    const ah = hashRegionBody(actualContent, a);
    if (ah === dh) { items.push({ id: d.id, verdict: 'unchanged', reason: 'page matches projection', source }); continue; }
    const ph = prior[d.id];
    const handEdited = ph !== undefined && ah !== ph;
    const sourceChanged = ph === undefined || dh !== ph;
    const drift: DriftKind = handEdited && sourceChanged ? 'both' : handEdited ? 'hand-edited' : 'source-changed';
    const reason =
      drift === 'hand-edited' ? 'projected region hand-edited off-source — regenerating (source-wins)'
      : drift === 'both' ? 'source changed AND page hand-edited — regenerating (source-wins)'
      : 'source changed — regenerating';
    items.push({ id: d.id, verdict: 'regenerate', reason, source, drift });
  }

  // Projected regions on the page that the source dropped → remove (source-owned).
  // Non-projected regions absent from the projection are free content — left alone.
  const desiredIds = new Set(desired.map((r) => r.id));
  for (const a of actualRegions) {
    if (desiredIds.has(a.id)) continue;
    const pm = projectedMarker(actualContent, a);
    if (pm.projected) items.push({ id: a.id, verdict: 'remove', reason: 'projected region dropped from source', source: pm.source });
  }
  return items;
}

/** Regions not contained within another region's span (outermost sections). */
function topLevelRegions(regions: Region[]): Region[] {
  return regions.filter((r) => {
    const [rs, re] = regionSpan(r);
    return !regions.some((o) => {
      if (o === r) return false;
      const [os, oe] = regionSpan(o);
      return os <= rs && re <= oe && (os < rs || re < oe);
    });
  });
}

/**
 * Reorder PROJECTED top-level regions to match the source (desired) order, source-wins
 * (kb-projection-6ji.5). Only projected regions move; free non-projected regions are
 * never repositioned by this pass. A moved region carries its whole span (nested
 * subsections + preserved body) — reorder changes position, never content.
 */
export function reorderProjected(content: string, desiredContent: string): { content: string; moved: string[] } {
  const desiredTop = topLevelRegions(parseRegions(desiredContent, 'd')).map((r) => r.id);
  const pageTop = topLevelRegions(parseRegions(content, 'p'));
  const projected = new Set(pageTop.filter((r) => projectedMarker(content, r).projected).map((r) => r.id));
  const target = desiredTop.filter((id) => projected.has(id));
  if (target.length < 2) return { content, moved: [] };
  const current = pageTop.map((r) => r.id).filter((id) => projected.has(id));
  if (current.join(' ') === target.join(' ')) return { content, moved: [] };

  let c = content;
  const moved = new Set<string>();
  // Place each projected region after its predecessor in target order (L-to-R sorts).
  for (let i = 1; i < target.length; i++) {
    const regions = topLevelRegions(parseRegions(c, 'p'));
    const ids = regions.map((r) => r.id);
    const prev = regions.find((r) => r.id === target[i - 1]);
    const cur = regions.find((r) => r.id === target[i]);
    if (!prev || !cur) continue;
    if (ids.indexOf(cur.id) > ids.indexOf(prev.id)) continue; // already after
    const res = moveRegion(c, cur, prev, 'after');
    if (res.status === 'ok') { c = res.content; moved.add(cur.id); }
  }
  return { content: c, moved: [...moved] };
}

export interface ApplyProjectionResult {
  content: string;
  items: ProjPlanItem[];
  newPrior: PriorState;
  created: string[];
  regenerated: string[];
  removed: string[];
  unchanged: string[];
  /** Projected regions repositioned to match source order (source-wins; 6ji.5). */
  reordered: string[];
  /** Projected regions that drifted (hand-edited off-source) — reported like healthMonitor's hash-mismatch. */
  handEdited: string[];
}

/**
 * Apply the plan: source-wins regenerate divergent projected regions, create absent
 * ones, remove dropped ones, then (when `reorder`, default on) reposition projected
 * regions to match source order. Free non-projected regions are never touched.
 */
export function applyProjection(desiredContent: string, actualContent: string, prior: PriorState = {}, reorder = true): ApplyProjectionResult {
  const items = planProjection(desiredContent, actualContent, prior);
  const desired = parseRegions(desiredContent, 'desired');
  const desiredById = new Map(desired.map((r) => [r.id, r] as const));
  const desiredOrder = desired.map((r) => r.id);
  const desiredLines = desiredContent.split(/\r?\n/);

  let content = actualContent;
  const created: string[] = [];
  const regenerated: string[] = [];
  const removed: string[] = [];
  const unchanged: string[] = [];

  for (const it of items.filter((i) => i.verdict === 'regenerate')) {
    const r = parseRegions(content, 'p').find((x) => x.id === it.id)!;
    content = replaceRegionBody(content, r, regionBody(desiredContent, desiredById.get(it.id)!));
    regenerated.push(it.id);
  }
  for (const it of items.filter((i) => i.verdict === 'remove')) {
    const r = parseRegions(content, 'p').find((x) => x.id === it.id);
    if (r) { content = removeRegionSpan(content, r); removed.push(it.id); }
  }
  for (const it of items.filter((i) => i.verdict === 'create')) {
    const d = desiredById.get(it.id)!;
    const idx = desiredOrder.indexOf(it.id);
    const predId = idx > 0 ? desiredOrder[idx - 1] : undefined;
    const regions = parseRegions(content, 'p');
    const pred = (predId ? regions.find((x) => x.id === predId) : undefined) ?? regions[regions.length - 1];
    if (!pred) continue; // empty page on a re-run shouldn't happen (first run writes verbatim)
    const [s0, s1] = regionSpan(d);
    content = createRegionAfter(content, pred, desiredLines.slice(s0, s1 + 1));
    created.push(it.id);
  }
  for (const it of items.filter((i) => i.verdict === 'unchanged')) unchanged.push(it.id);

  // Reorder projected regions to source order AFTER create/remove settle (6ji.5).
  let reordered: string[] = [];
  if (reorder) { const r = reorderProjected(content, desiredContent); content = r.content; reordered = r.moved; }

  // Prior advances to the fresh-projection hash for every projected region now present
  // (post-regenerate they are all in sync). Removed regions leave the bridge.
  const newPrior: PriorState = { ...prior };
  const finalById = new Map(parseRegions(content, 'p').map((r) => [r.id, r] as const));
  for (const d of desired) { const r = finalById.get(d.id); if (r) newPrior[d.id] = hashRegionBody(content, r); }
  for (const id of removed) delete newPrior[id];

  const handEdited = items.filter((i) => i.drift === 'hand-edited' || i.drift === 'both').map((i) => i.id);
  return { content, items, newPrior, created, regenerated, removed, unchanged, reordered, handEdited };
}

export interface ReconcilePageResult {
  firstRun: boolean;
  items: ProjPlanItem[];
  created: string[];
  regenerated: string[];
  removed: string[];
  unchanged: string[];
  reordered: string[];
  handEdited: string[];
  pageFile: string;
  sidecarFile: string;
}

function writeAtomic(file: string, content: string): void {
  const tmp = `${file}.reconcile-${process.pid}.tmp`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, file);
}

/**
 * Reconcile a projected page against its file on disk, persisting the region-bridge
 * sidecar. First run writes the projection verbatim and seeds the bridge; re-runs
 * source-wins regenerate any drifted/stale projected region. `dryRun` plans only.
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
    return { firstRun: true, items, created: items.map((i) => i.id), regenerated: [], removed: [], unchanged: [], reordered: [], handEdited: [], pageFile, sidecarFile };
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
    created: res.created,
    regenerated: res.regenerated,
    removed: res.removed,
    unchanged: res.unchanged,
    reordered: res.reordered,
    handEdited: res.handEdited,
    pageFile,
    sidecarFile,
  };
}

export type FaithfulnessGateResult =
  | { status: 'pass'; applicable: boolean }
  | { status: 'refused'; reason: string }
  | { status: 'unenforced'; reason: string };

/**
 * Grounding gate: shell out to the CANONICAL kb_cli faithfulness-gate (never a
 * reimplemented threshold — skill mandate). exit 3 → refused (below citation-recall
 * minimum). Degrades to 'unenforced' if kb_cli is absent.
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

/** A source page is GROUNDED iff it carries a `citation-recall::` property (research-synthesized). */
export function sourceIsGrounded(rawSource: string): boolean {
  return /^\s*citation-recall::\s*[0-9]/m.test(rawSource);
}

/**
 * Project a real LogSeq source page to region-structured markdown via the REAL
 * transform (logseqToAstro.transformBody). Strips the leading LogSeq page-property
 * block. publishedSlugs/titleToSlug default empty (unresolved wikilinks → spans).
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
 * the loader uses — so `projectSourcePage` resolves `[[wikilinks]]` to `/kb/<slug>/`.
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
  created?: string[];
  regenerated?: string[];
  removed?: string[];
  unchanged?: string[];
  reordered?: string[];
  handEdited?: string[];
  grounded?: boolean;
  gate?: FaithfulnessGateResult;
  excluded?: boolean;
}

export interface ReconcileManifestResult {
  outDir: string;
  entries: ManifestEntrySummary[];
}

/**
 * Batch reconcile: project every published manifest entry and source-wins reconcile
 * it into a config-driven output dir (`<outDir>/<slug>.md` + `<slug>.reconcile.json`).
 * A GROUNDED source page (carries `citation-recall::`) is run through the canonical
 * faithfulness gate when `faithfulnessMin` is set; a REFUSED page is excluded from
 * the outward projection (matching PublishSubgraph Phase 5b).
 */
export function reconcileManifest(opts: {
  manifestPath: string;
  outDir: string;
  graphPath?: string;
  dryRun?: boolean;
  faithfulnessMin?: number;
}): ReconcileManifestResult {
  const { manifestPath, outDir, dryRun, faithfulnessMin } = opts;
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
      const grounded = sourceIsGrounded(raw);

      // Grounding gate: a below-bar grounded source is excluded from the outward projection.
      let gate: FaithfulnessGateResult | undefined;
      if (grounded && faithfulnessMin !== undefined) {
        gate = faithfulnessGate(sourcePath, faithfulnessMin);
        if (gate.status === 'refused') { entries.push({ title: entry.title, slug, grounded, gate, excluded: true }); continue; }
      }

      const desiredContent = stampProjected(projectSourcePage(raw, publishedSlugs, titleToSlug), entry.title);
      const res = reconcilePage({
        desiredContent,
        pageFile: join(outDir, `${slug}.md`),
        sidecarFile: join(outDir, `${slug}.reconcile.json`),
        dryRun,
      });
      entries.push({
        title: entry.title,
        slug,
        firstRun: res.firstRun,
        created: res.created,
        regenerated: res.regenerated,
        removed: res.removed,
        unchanged: res.unchanged,
        reordered: res.reordered,
        handEdited: res.handEdited,
        grounded,
        gate,
      });
    } catch (err) {
      entries.push({ title: entry.title, slug, error: (err as Error).message.split('\n')[0] });
    }
  }
  return { outDir, entries };
}
