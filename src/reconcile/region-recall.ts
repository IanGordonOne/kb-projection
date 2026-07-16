/**
 * region-recall — per-region citation-recall scoring (kb-projection-6ji.8, files-canonical).
 */
import { parseRegions, regionSpan, type Region } from './region-core';

export const ROOT_REGION_ID = ':root';

const BAND = /_\(([^)]+)\)_/g;
const REF_INLINE = /\[\^([^\]]+)\](?!:)/;
// The {36} alt carries a negative lookahead so a longer all-hex finding value is
// NOT silently truncated to its first 36 chars — it falls through to \S+ and is
// captured whole (P4 audit, kb-projection-6ji.8.5).
const CITE_DEF = /^\s*-?\s*\[\^([^\]]+)\]:\s*.*\bfinding::\s*([0-9a-fA-F-]{36}(?![0-9a-fA-F-])|\S+)/;
const SUPPORTED_BANDS = new Set(['well-supported', 'supported', 'grounded']);
const UNVERIFIED = /^unverified\b/i;
const PROJECTED_ANCHOR_RE = /<(?:Region|SectionHeading)\b[^>]*\bprojected\b/;
const SOURCE_ATTR_RE = /\bsource=["']([^"']+)["']/;
const PROJECTED_COMMENT_RE = /^<!--\s*projected:\s*(.*?)-->\s*$/;

interface RegionEntry {
  start: number;
  end: number;
  recall: RegionRecall;
}

export interface RegionRecall {
  /** A parseRegions region id, or ROOT_REGION_ID. */
  id: string;
  kind: 'heading' | 'fence' | 'root';
  /** Projected-marker source when present (reporting only). */
  source?: string;
  /** Resolved finding UUIDs of the CITED findings in this region, doc order. */
  findingIds: string[];
  /** # finding-lines in the region span carrying a trailing [^key]. */
  cited: number;
  /** # finding-lines in the region span (allowlisted band present). */
  total: number;
  /** cited/total, or null when total === 0. */
  recall: number | null;
}

export interface PageRecall {
  /** ROOT first, then parseRegions regions in document order. */
  regions: RegionRecall[];
  /** Σ regions[].cited */
  cited: number;
  /** Σ regions[].total */
  total: number;
  /** cited/total, or null when total === 0. */
  recall: number | null;
}

function splitLines(content: string): string[] {
  return content.split(/\r?\n/);
}

function isFindingBand(inner: string): boolean {
  const trimmed = inner.trim();
  return SUPPORTED_BANDS.has(trimmed) || UNVERIFIED.test(trimmed);
}

function isFindingLine(line: string): boolean {
  for (const match of line.matchAll(BAND)) {
    if (isFindingBand(match[1] ?? '')) return true;
  }
  return false;
}

function citationKey(line: string): string | undefined {
  return line.match(REF_INLINE)?.[1];
}

function recallOf(cited: number, total: number): number | null {
  return total === 0 ? null : cited / total;
}

function regionSource(lines: string[], region: Region): string | undefined {
  const [start] = regionSpan(region);
  const anchor = lines[start] ?? '';
  if (PROJECTED_ANCHOR_RE.test(anchor)) return anchor.match(SOURCE_ATTR_RE)?.[1];
  for (let i = region.bodyStart; i <= region.bodyEnd; i++) {
    const line = (lines[i] ?? '').trim();
    if (!line) continue;
    const marker = line.match(PROJECTED_COMMENT_RE);
    return marker ? marker[1].match(SOURCE_ATTR_RE)?.[1] : undefined;
  }
  return undefined;
}

function compareSpan(aStart: number, aEnd: number, bStart: number, bEnd: number): number {
  return aStart - bStart || aEnd - bEnd;
}

function compareContainment(a: RegionEntry, b: RegionEntry): number {
  return b.start - a.start || a.end - b.end;
}

function makeRegionEntries(projectedContent: string, file: string): RegionEntry[] {
  const lines = splitLines(projectedContent);
  return parseRegions(projectedContent, file)
    .map((region): RegionEntry => {
      const [start, end] = regionSpan(region);
      return {
        start,
        end,
        recall: {
          id: region.id,
          kind: region.kind,
          source: regionSource(lines, region),
          findingIds: [],
          cited: 0,
          total: 0,
          recall: null,
        },
      };
    })
    .sort((a, b) => compareSpan(a.start, a.end, b.start, b.end));
}

function owningRegion(lineIndex: number, regions: RegionEntry[]): RegionEntry | undefined {
  let owner: RegionEntry | undefined;
  for (const region of regions) {
    if (region.start > lineIndex || region.end < lineIndex) continue;
    if (!owner || compareContainment(region, owner) < 0) owner = region;
  }
  return owner;
}

/**
 * One-line display of a PageRecall for the CLI text reporter (kb-projection-6ji.9):
 * the page roll-up plus a per-region breakdown for every heading/fence region that
 * carries findings. ROOT is omitted from the breakdown — when it is the only
 * finding-bearing region (today's corpus) it equals the page number, so the roll-up
 * already shows it; when sub-regions exist, they are the interesting part. Display
 * only — `PageRecall` remains the number of truth.
 */
export function formatPageRecall(page: PageRecall): string {
  const fmt = (cited: number, total: number): string => `${cited}/${total}=${total ? (cited / total).toFixed(2) : 'n/a'}`;
  const perRegion = page.regions
    .filter((r) => r.total > 0 && r.id !== ROOT_REGION_ID)
    .map((r) => `${r.id} ${fmt(r.cited, r.total)}`);
  return `recall ${fmt(page.cited, page.total)}${perRegion.length ? ` · ${perRegion.join(' · ')}` : ''}`;
}

/** Global [^key] → finding UUID map from the projected page's `- Citations` block. */
export function resolveCitationMap(projectedContent: string): Map<string, string> {
  const citationMap = new Map<string, string>();
  for (const line of splitLines(projectedContent)) {
    const match = line.match(CITE_DEF);
    if (match) citationMap.set(match[1], match[2]);
  }
  return citationMap;
}

/** Score every region (incl. synthetic ROOT) of a projected grounded page. Pure. */
export function scoreRegionRecall(projectedContent: string, file = 'projected'): PageRecall {
  const lines = splitLines(projectedContent);
  const citationMap = resolveCitationMap(projectedContent);
  const root: RegionRecall = {
    id: ROOT_REGION_ID,
    kind: 'root',
    findingIds: [],
    cited: 0,
    total: 0,
    recall: null,
  };
  const regions = makeRegionEntries(projectedContent, file);

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    if (!isFindingLine(line)) continue;

    const target = owningRegion(lineIndex, regions)?.recall ?? root;
    target.total += 1;

    const key = citationKey(line);
    if (!key) continue;
    target.cited += 1;
    const findingId = citationMap.get(key);
    if (findingId) target.findingIds.push(findingId);
  }

  const scoredRegions = [root, ...regions.map((region) => region.recall)];
  let cited = 0;
  let total = 0;
  for (const region of scoredRegions) {
    region.recall = recallOf(region.cited, region.total);
    cited += region.cited;
    total += region.total;
  }

  return {
    regions: scoredRegions,
    cited,
    total,
    recall: recallOf(cited, total),
  };
}
