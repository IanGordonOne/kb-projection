/**
 * region-recall — per-region citation-recall scoring (kb-projection-6ji.8, files-canonical).
 *
 * P2 (RED) SKELETON — signatures only. See docs/6ji.8-spec.md (P1) for the full contract;
 * P3 (GREEN) implements the real scoring logic against test/reconcile/region-recall.test.ts.
 *
 * Every function body below THROWS rather than returning a zero/empty stub value. This is
 * deliberate: the spec's own acceptance criteria include legitimate zero/null/empty
 * expectations (`total === 0`, `recall === null`, `findingIds.length === 0`), so a stub
 * that *returns* one of those would silently false-GREEN the corresponding RED test. A
 * thrown error can never be mistaken for a correct answer.
 */

export const ROOT_REGION_ID = ':root';

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

/** Global [^key] → finding UUID map from the projected page's `- Citations` block. */
export function resolveCitationMap(_projectedContent: string): Map<string, string> {
  throw new Error('P3: not implemented');
}

/** Score every region (incl. synthetic ROOT) of a projected grounded page. Pure. */
export function scoreRegionRecall(_projectedContent: string, _file?: string): PageRecall {
  throw new Error('P3: not implemented');
}
