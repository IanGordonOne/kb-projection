/**
 * propose-placement — heuristic topical inference for manifest candidates.
 *
 * Given a list of candidate page titles, the current manifest, and the
 * LogSeq graph, returns a ranked list of section candidates per
 * candidate. "Section" v1 = a `category::` value seen across current
 * manifest entries. No schema extension required; the score is built
 * from existing LogSeq metadata.
 *
 * Score factors (additive, deterministic):
 *   +20  candidate's category exactly matches a section's category
 *   ×5   per outbound wikilink from candidate to a manifest entry in section
 *   ×3   per inbound wikilink (manifest entries in section linking to candidate)
 *   ×1   per shared tag with the section's frequent-tag set
 *
 * Pure: takes already-loaded metadata, returns proposals. Filesystem
 * I/O lives in the CLI/loader path.
 *
 * Bd-3fh.6 design note: "Inference quality depends on LogSeq metadata.
 * Bad metadata → bad suggestions. Creates pressure to author better."
 * Honest: when a candidate has no category and no neighborhood links,
 * topSections is empty (we don't fabricate signal that isn't there).
 */

import type { PublishManifest } from './schema';
import type { PageMetadata } from './logseqMeta';

export interface SectionRank {
  section: string;
  score: number;
  rationale: string[];
  evidence: {
    categoryMatch: boolean;
    outboundLinks: number;
    inboundLinks: number;
    sharedTags: number;
  };
}

export interface PlacementProposal {
  candidate: string;
  candidateCategory: string | null;
  topSections: SectionRank[];
  /** Reason `topSections` is empty (when applicable); helps the human triage. */
  emptyReason?: string;
}

export interface SectionMembers {
  /** Titles of manifest entries in this section. */
  titles: Set<string>;
  /** Tag → count across this section's pages. */
  tagFrequency: Map<string, number>;
}

export type SectionIndex = Map<string, SectionMembers>;

/**
 * Build the section index from manifest entries + their LogSeq metadata.
 * Entries with null category go into a synthetic "(uncategorized)"
 * bucket so they're addressable but visibly distinct. Empty manifests
 * yield an empty index.
 */
export function buildSectionIndex(
  manifest: PublishManifest,
  metaByTitle: Map<string, PageMetadata>
): SectionIndex {
  const index: SectionIndex = new Map();
  for (const entry of manifest.entries) {
    const meta = metaByTitle.get(entry.title);
    const section = meta?.category ?? '(uncategorized)';
    let members = index.get(section);
    if (!members) {
      members = { titles: new Set(), tagFrequency: new Map() };
      index.set(section, members);
    }
    members.titles.add(entry.title);
    if (meta) {
      for (const tag of meta.tags) {
        members.tagFrequency.set(tag, (members.tagFrequency.get(tag) ?? 0) + 1);
      }
    }
  }
  return index;
}

/**
 * Inverse-of-section-index: for a given candidate's outbound wikilinks
 * (and inbound from manifest), how many land in section X?
 */
function countLinksToSection(linkTitles: string[], members: SectionMembers): number {
  let count = 0;
  for (const t of linkTitles) {
    if (members.titles.has(t)) count++;
  }
  return count;
}

/**
 * Count inbound: manifest entries in `section` whose metadata's
 * wikilinks include the candidate title.
 */
function countInboundFromSection(
  candidateTitle: string,
  members: SectionMembers,
  metaByTitle: Map<string, PageMetadata>
): number {
  let count = 0;
  for (const t of members.titles) {
    const meta = metaByTitle.get(t);
    if (!meta) continue;
    if (meta.wikilinks.includes(candidateTitle)) count++;
  }
  return count;
}

/**
 * Count shared tags between candidate's tag set and a section's
 * tag-frequency map. Uses presence (not weight) on the candidate side
 * — a tag the candidate has IS shared if it appears anywhere in the
 * section.
 */
function countSharedTags(
  candidateTags: string[],
  members: SectionMembers
): number {
  let count = 0;
  for (const tag of candidateTags) {
    if (members.tagFrequency.has(tag)) count++;
  }
  return count;
}

const SCORE_WEIGHT_CATEGORY_MATCH = 20;
const SCORE_WEIGHT_OUTBOUND_PER_LINK = 5;
const SCORE_WEIGHT_INBOUND_PER_LINK = 3;
const SCORE_WEIGHT_SHARED_TAG = 1;

function rankSection(
  section: string,
  members: SectionMembers,
  candidateMeta: PageMetadata,
  candidateTitle: string,
  metaByTitle: Map<string, PageMetadata>
): SectionRank | null {
  const categoryMatch = candidateMeta.category === section;
  const outboundLinks = countLinksToSection(candidateMeta.wikilinks, members);
  const inboundLinks = countInboundFromSection(candidateTitle, members, metaByTitle);
  const sharedTags = countSharedTags(candidateMeta.tags, members);

  const score =
    (categoryMatch ? SCORE_WEIGHT_CATEGORY_MATCH : 0) +
    outboundLinks * SCORE_WEIGHT_OUTBOUND_PER_LINK +
    inboundLinks * SCORE_WEIGHT_INBOUND_PER_LINK +
    sharedTags * SCORE_WEIGHT_SHARED_TAG;

  if (score === 0) return null;

  const rationale: string[] = [];
  if (categoryMatch) {
    rationale.push(`Candidate's category "${section}" matches this section.`);
  }
  if (outboundLinks > 0) {
    rationale.push(
      `Candidate wikilinks ${outboundLinks} ${outboundLinks === 1 ? 'page' : 'pages'} already in this section.`
    );
  }
  if (inboundLinks > 0) {
    rationale.push(
      `${inboundLinks} ${inboundLinks === 1 ? 'page' : 'pages'} in this section wikilink to candidate.`
    );
  }
  if (sharedTags > 0) {
    rationale.push(
      `Candidate shares ${sharedTags} ${sharedTags === 1 ? 'tag' : 'tags'} with this section.`
    );
  }

  return {
    section,
    score,
    rationale,
    evidence: { categoryMatch, outboundLinks, inboundLinks, sharedTags },
  };
}

export interface ProposePlacementOptions {
  topN?: number;
}

/**
 * Compute placement proposals for each candidate. Pure given input
 * metadata maps. Sorts sections by score (desc), then alphabetically
 * for stable tie-break.
 */
export function proposePlacement(
  candidates: string[],
  manifest: PublishManifest,
  metaByTitle: Map<string, PageMetadata>,
  options: ProposePlacementOptions = {}
): PlacementProposal[] {
  const topN = options.topN ?? 3;
  const sectionIndex = buildSectionIndex(manifest, metaByTitle);

  return candidates.map((candidate) => {
    const candidateMeta = metaByTitle.get(candidate);
    if (!candidateMeta) {
      return {
        candidate,
        candidateCategory: null,
        topSections: [],
        emptyReason: `Candidate page metadata unavailable (failed to read LogSeq page for "${candidate}")`,
      };
    }

    const ranks: SectionRank[] = [];
    for (const [section, members] of sectionIndex) {
      const rank = rankSection(section, members, candidateMeta, candidate, metaByTitle);
      if (rank) ranks.push(rank);
    }

    ranks.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.section.localeCompare(b.section);
    });

    const proposal: PlacementProposal = {
      candidate,
      candidateCategory: candidateMeta.category,
      topSections: ranks.slice(0, topN),
    };

    if (proposal.topSections.length === 0) {
      proposal.emptyReason = candidateMeta.category
        ? `Candidate has category "${candidateMeta.category}" but no neighborhood overlap with manifest sections.`
        : 'Candidate has no category, no overlapping wikilinks, and no shared tags with current manifest sections.';
    }

    return proposal;
  });
}

export function proposalToMarkdown(proposals: PlacementProposal[]): string {
  const lines: string[] = [];
  lines.push('# Placement Proposals');
  lines.push('');
  lines.push(`Candidates evaluated: ${proposals.length}`);
  lines.push('');
  for (const p of proposals) {
    lines.push(`## ${p.candidate}`);
    lines.push(`Candidate category: ${p.candidateCategory ?? '(none)'}`);
    if (p.topSections.length === 0) {
      lines.push('');
      lines.push(`_No section proposals._ ${p.emptyReason ?? ''}`);
      lines.push('');
      continue;
    }
    lines.push('');
    for (let i = 0; i < p.topSections.length; i++) {
      const r = p.topSections[i];
      lines.push(`### #${i + 1} — ${r.section} (score ${r.score})`);
      for (const reason of r.rationale) lines.push(`- ${reason}`);
      lines.push('');
    }
  }
  return lines.join('\n');
}
