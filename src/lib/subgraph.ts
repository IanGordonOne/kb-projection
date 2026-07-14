/**
 * subgraph.ts — seed → relevance-scored N-hop subgraph selection over a LogSeq
 * graph (bd kb-projection-0ci, the auto-selection half). Target-agnostic.
 *
 * Tractable-slice design (from the kb-projection-0ci comments): a finite slice
 * of a connected graph always has a boundary — the point is to make it
 * *graceful*, not to chase closure. So:
 *   - seed with a handful of titles;
 *   - expand by co-citation score (a candidate scores by how strongly the
 *     already-included pages link to it: related:: weight 2, body [[..]] weight 1);
 *   - HUB-DEMOTE candidates whose own out-degree is huge (index/MOC pages link
 *     to everything and would explode the frontier);
 *   - cap at maxPages / maxHops;
 *   - report the BOUNDARY (out-links pointing outside the final slice) so the
 *     caller can emit graceful stubs instead of leaving dead links.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { decodeHtml, WIKILINK_RE } from './logseq-primitives';
import { resolveLogseqPath } from './logseqToAstro';

export interface OutLink {
  title: string;
  weight: number;
}

/**
 * Extract a page's out-links: `related::` targets (weight 2, curated) + body
 * `[[wikilinks]]` (weight 1). Deduped to the max weight per title; self-links
 * and blank titles dropped.
 */
export function extractOutlinks(content: string, selfTitle?: string): OutLink[] {
  const weights = new Map<string, number>();
  const lines = content.split('\n');
  let inProps = true;
  for (const line of lines) {
    const relMatch = inProps ? line.match(/^related::\s*(.+)$/i) : null;
    if (relMatch) {
      for (const m of relMatch[1].matchAll(WIKILINK_RE)) {
        const t = decodeHtml(m[1].trim());
        weights.set(t, Math.max(weights.get(t) ?? 0, 2));
      }
      continue;
    }
    // property block ends at the first non-property, non-blank line
    if (inProps && !/^[a-z0-9_-]+::/i.test(line) && line.trim() !== '') inProps = false;
    for (const m of line.matchAll(WIKILINK_RE)) {
      const t = decodeHtml(m[1].trim());
      weights.set(t, Math.max(weights.get(t) ?? 0, 1));
    }
  }
  if (selfTitle) weights.delete(selfTitle);
  weights.delete('');
  // Journal-date wikilinks ([[2026-03-06]]) are navigation cruft, not semantic
  // relatedness — drop them from both scoring and the boundary.
  for (const t of [...weights.keys()]) if (/^\d{4}-\d{2}-\d{2}$/.test(t)) weights.delete(t);
  return [...weights].map(([title, weight]) => ({ title, weight }));
}

export interface SelectOpts {
  graphDir: string;
  seeds: string[];
  /** Hard cap on total pages (seeds included). Default 25. */
  maxPages?: number;
  /** Max expansion hops from the seeds. Default 2. */
  maxHops?: number;
  /** Out-degree above which a candidate is hub-demoted (score ×0.15). Default 40. */
  hubOutdegree?: number;
  /** Minimum score for a candidate to be included. Default 1. */
  minScore?: number;
}

export interface SelectedPage {
  title: string;
  file: string; // LogSeq filename sans dir (basename)
  hop: number;
  score: number;
}

export interface BoundaryLink {
  title: string;
  exists: boolean; // resolves to a real LogSeq page (just not in the slice) vs a bare concept-stub
  referencedBy: string[];
}

export interface SubgraphSelection {
  pages: SelectedPage[];
  boundary: BoundaryLink[];
}

/** Greedy seed → relevance-scored N-hop selection with hub-demotion + boundary report. */
export function selectSubgraph(opts: SelectOpts): SubgraphSelection {
  const graphPages = join(opts.graphDir, 'pages');
  const maxPages = opts.maxPages ?? 25;
  const maxHops = opts.maxHops ?? 2;
  const hubOutdegree = opts.hubOutdegree ?? 40;
  const minScore = opts.minScore ?? 1;

  const contentCache = new Map<string, string | null>(); // title → content (null = no page)
  const outdegreeCache = new Map<string, number>();

  function resolve(title: string): string | null {
    if (contentCache.has(title)) return contentCache.get(title)!;
    const p = resolveLogseqPath({ title, tier: '' }, graphPages);
    const content = p && existsSync(p) ? readFileSync(p, 'utf8') : null;
    contentCache.set(title, content);
    return content;
  }
  function outdegree(title: string, content: string): number {
    if (!outdegreeCache.has(title)) outdegreeCache.set(title, extractOutlinks(content, title).length);
    return outdegreeCache.get(title)!;
  }

  const included = new Map<string, SelectedPage>();
  const scores = new Map<string, number>(); // candidate title → accumulated co-citation score
  const refBy = new Map<string, Set<string>>(); // title → who links it (for boundary + audit)

  function noteOutlinks(fromTitle: string, content: string) {
    for (const { title, weight } of extractOutlinks(content, fromTitle)) {
      scores.set(title, (scores.get(title) ?? 0) + weight);
      (refBy.get(title) ?? refBy.set(title, new Set()).get(title)!).add(fromTitle);
    }
  }

  // Seeds (hop 0) — always included if they resolve.
  for (const title of opts.seeds) {
    const content = resolve(title);
    if (content === null) continue;
    const file = basenameOf(title, graphPages);
    included.set(title, { title, file, hop: 0, score: Infinity });
    noteOutlinks(title, content);
  }

  for (let hop = 1; hop <= maxHops && included.size < maxPages; hop++) {
    // Rank current candidates (not yet included, resolve to a real page).
    const ranked: Array<{ title: string; score: number }> = [];
    for (const [title, rawScore] of scores) {
      if (included.has(title)) continue;
      const content = resolve(title);
      if (content === null) continue; // concept-stub → boundary, never a page
      const deg = outdegree(title, content);
      const score = deg > hubOutdegree ? rawScore * 0.15 : rawScore; // hub-demotion
      if (score >= minScore) ranked.push({ title, score });
    }
    ranked.sort((a, b) => b.score - a.score);

    let addedThisHop = 0;
    for (const { title, score } of ranked) {
      if (included.size >= maxPages) break;
      if (included.has(title)) continue;
      const content = resolve(title)!;
      included.set(title, { title, file: basenameOf(title, graphPages), hop, score });
      noteOutlinks(title, content);
      addedThisHop++;
    }
    if (addedThisHop === 0) break;
  }

  // Boundary: out-links from included pages that point outside the final slice.
  const boundary: BoundaryLink[] = [];
  for (const [title, refs] of refBy) {
    if (included.has(title)) continue;
    const referencedBy = [...refs].filter((r) => included.has(r));
    if (referencedBy.length === 0) continue;
    boundary.push({ title, exists: resolve(title) !== null, referencedBy: referencedBy.sort() });
  }
  boundary.sort((a, b) => b.referencedBy.length - a.referencedBy.length || a.title.localeCompare(b.title));

  return {
    pages: [...included.values()].sort((a, b) => a.hop - b.hop || b.score - a.score || a.title.localeCompare(b.title)),
    boundary,
  };
}

function basenameOf(title: string, graphPages: string): string {
  const p = resolveLogseqPath({ title, tier: '' }, graphPages);
  return p ? p.slice(p.lastIndexOf('/') + 1) : `${title}.md`;
}
