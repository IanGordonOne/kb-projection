/**
 * region-core — VENDORED verbatim copy of the pure core of
 * ~/Projects/777westwood/scripts/region.ts (parse / body / span / hash / create).
 *
 * ⚠️ THIS COPY IS "CONSUMER #2." Per the agent-CMS north star (kb-projection-6ji),
 * the region-addressing layer had exactly one consumer (777westwood). This file is
 * the second — which, by the casco lesson (extract at N consumers, not 1), is the
 * EXTRACTION TRIGGER. Do NOT let this diverge from the 777westwood original: it
 * exists to prove the region-grain reconciler loop (6ji.1); once the loop holds,
 * the shared module gets extracted and both consumers import it. Until then, keep
 * this byte-faithful to the source.
 */
import { basename } from 'node:path';
import { createHash } from 'node:crypto';

export function fileStem(file: string): string {
  return basename(file).replace(/\.mdx?$/, '');
}

// ── Pure core (unit-tested in region.test.ts) ────────────────────────────────

export type RegionKind = 'heading' | 'fence';

export interface Region {
  id: string;
  kind: RegionKind;
  file: string;
  /** 0-based inclusive line range of the editable BODY (empty ⇒ bodyStart > bodyEnd). */
  bodyStart: number;
  bodyEnd: number;
  headingLevel?: number;
  preview: string;
}

/** Slug matching Astro/github-slugger for headings (so ids == rendered anchors). */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;
const FENCE_OPEN_RE = /^<!--\s*region:\s*([A-Za-z0-9_-]+)\s*-->\s*$/;
const FENCE_CLOSE_RE = /^<!--\s*\/region\s*-->\s*$/;
// Keystatic-editable fence form (kb-projection e00, layer B): the `<Region>`
// content-component is what Keystatic round-trips in the CMS (an <!-- region -->
// HTML comment gets stripped by its editor). Both forms parse identically here,
// so a page may use either. The regexes tolerate leading indentation and single
// or double quotes so a CMS re-serialization that reflows whitespace still
// resolves. In a CommonMark .md the <Region>/</Region> tags must sit on their
// own lines with a blank line between them and the wrapped content (else the
// HTML block swallows it); the rendered <region> wrapper is neutralised by
// `region { display: contents }` in PlanningLayout.
const REGION_OPEN_RE = /^\s*<Region\s+name=["']([A-Za-z0-9_-]+)["']\s*>\s*$/;
const REGION_CLOSE_RE = /^\s*<\/Region>\s*$/;

function previewOf(lines: string[], start: number, end: number): string {
  for (let i = start; i <= end && i < lines.length; i++) {
    // Strip leading block decoration (>, #, bullets) and surrounding emphasis.
    const t = lines[i]
      .replace(/^[>#*_`\-\s]+/, '')
      .replace(/[*_`~\s]+$/, '')
      .trim();
    if (t) return t.slice(0, 72);
  }
  return '';
}

// A designed-landing heading authored as <SectionHeading level="2" id="…" text="…" />
// (kb-projection p80.1) carries an explicit id markdown headings can't express.
// Parsed as a heading boundary so the designed pages are addressable exactly like
// the prose ones (kb-projection 62r — one region model across all planning pages).
const SECTION_HEADING_RE = /^\s*<SectionHeading\b[^>]*\/>\s*$/;

/**
 * A heading boundary: a markdown `## …` OR a self-closing `<SectionHeading …/>`.
 * Returns its level and region id (the heading slug, or the explicit id attr).
 */
export function parseHeadingLine(line: string): { level: number; id: string } | null {
  const md = line.match(HEADING_RE);
  if (md) return { level: md[1].length, id: slugify(md[2]) };
  if (SECTION_HEADING_RE.test(line)) {
    const idm = line.match(/\bid=["']([A-Za-z0-9_-]+)["']/);
    if (!idm) return null;
    const lvl = line.match(/\blevel=["']?(\d)["']?/);
    return { level: lvl ? Number(lvl[1]) : 2, id: idm[1] };
  }
  return null;
}

/** Parse every named region (heading sections + fenced blocks) out of one file. */
export function parseRegions(content: string, file: string): Region[] {
  const lines = content.split('\n');
  const regions: Region[] = [];

  // Heading sections: body runs until the next heading of same-or-higher level.
  // A "heading" is a markdown `## …` OR a <SectionHeading …/> (designed pages).
  for (let i = 0; i < lines.length; i++) {
    const h = parseHeadingLine(lines[i]);
    if (!h) continue;
    let end = lines.length - 1;
    for (let j = i + 1; j < lines.length; j++) {
      const hj = parseHeadingLine(lines[j]);
      if (hj && hj.level <= h.level) { end = j - 1; break; }
    }
    regions.push({
      id: h.id,
      kind: 'heading',
      file,
      headingLevel: h.level,
      bodyStart: i + 1,
      bodyEnd: end,
      preview: previewOf(lines, i + 1, end),
    });
  }

  // Fenced regions: <!-- region: NAME --> ... <!-- /region -->
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(FENCE_OPEN_RE);
    if (!open) continue;
    let close = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (FENCE_CLOSE_RE.test(lines[j])) { close = j; break; }
    }
    if (close === -1) continue; // unterminated fence — skip
    regions.push({
      id: open[1],
      kind: 'fence',
      file,
      bodyStart: i + 1,
      bodyEnd: close - 1,
      preview: previewOf(lines, i + 1, close - 1),
    });
  }

  // Component regions: <Region name="NAME"> ... </Region> (Keystatic form).
  // Same span semantics as fenced regions — the open/close tag lines are the
  // preserved anchor and the body is everything between.
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(REGION_OPEN_RE);
    if (!open) continue;
    let close = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (REGION_CLOSE_RE.test(lines[j])) { close = j; break; }
    }
    if (close === -1) continue; // unterminated — skip
    regions.push({
      id: open[1],
      kind: 'fence',
      file,
      bodyStart: i + 1,
      bodyEnd: close - 1,
      preview: previewOf(lines, i + 1, close - 1),
    });
  }

  return regions;
}

/** Return a region's current body text. */
export function regionBody(content: string, region: Region): string {
  const lines = content.split('\n');
  return lines.slice(region.bodyStart, region.bodyEnd + 1).join('\n');
}

/** Replace a region's body with newBody, preserving its anchor and the rest of the file. */
export function replaceRegionBody(content: string, region: Region, newBody: string): string {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);
  const replacement = newBody.split('\n');
  const count = region.bodyEnd - region.bodyStart + 1;
  lines.splice(region.bodyStart, Math.max(0, count), ...replacement);
  return lines.join(eol);
}

// ── Structural authoring verbs (pure core, unit-tested) ──────────────────────
//
// Sibling operations to replaceRegionBody, all anchor-preserving and single-span:
//   insert       — append content to the END of a region body (before terminator)
//   create       — splice a NEW region (fence <Region> or <SectionHeading>) after one
//   rename        — change an EXPLICIT-id region's id (+ optional cross-page ref rewrite)
//   reorder       — move a whole region before/after another in the SAME file
// Markdown `##` headings have DERIVED ids (slug of text) so they can't be id-renamed
// safely; renameAnchor refuses them. See ISA kb-projection-lhn.

/** True if this region is anchored by a heading line (`##` or <SectionHeading/>). */
function isHeading(region: Region): boolean {
  return region.kind === 'heading';
}

/**
 * Full inclusive line span of a region INCLUDING its anchor(s):
 *   heading — [headingLine, bodyEnd]
 *   fence   — [openTag, closeTag]
 * Works for empty-body regions (bodyStart > bodyEnd): the anchors collapse correctly.
 */
export function regionSpan(region: Region): [number, number] {
  if (isHeading(region)) return [region.bodyStart - 1, Math.max(region.bodyEnd, region.bodyStart - 1)];
  return [region.bodyStart - 1, region.bodyEnd + 1];
}

const eolOf = (content: string): string => (content.includes('\r\n') ? '\r\n' : '\n');

/**
 * Append `text` to the end of a region's body, before its terminator (the next
 * same/higher heading, or the closing fence). Guarantees exactly one blank-line
 * separator when the body already has content; adds none for an empty body.
 */
export function insertIntoBody(content: string, region: Region, text: string): string {
  const eol = eolOf(content);
  const lines = content.split(/\r?\n/);
  const insertAt = region.bodyEnd + 1; // index of the terminator / EOF
  const bodyHasContent = lines
    .slice(region.bodyStart, region.bodyEnd + 1)
    .some((l) => l.trim() !== '');
  const block: string[] = [];
  if (bodyHasContent && (lines[insertAt - 1]?.trim() ?? '') !== '') block.push(''); // single separator
  block.push(...text.split('\n'));
  lines.splice(insertAt, 0, ...block);
  return lines.join(eol);
}

export type RegionKind2 = 'fence' | 'section';

/**
 * Render the lines for a NEW region block (anchors + optional body).
 *   fence   → <Region name="NAME"> … </Region> (blank-line-delimited per CommonMark)
 *   section → <SectionHeading level="L" id="NAME" text="TEXT" /> + optional body
 */
export function renderRegion(
  kind: RegionKind2,
  name: string,
  opts: { body?: string; level?: number; text?: string } = {},
): string[] {
  const body = (opts.body ?? '').replace(/\r?\n$/, '');
  if (kind === 'section') {
    const level = opts.level ?? 2;
    const text = opts.text ?? '';
    const head = `<SectionHeading level="${level}" id="${name}" text="${text}" />`;
    return body ? [head, '', ...body.split('\n')] : [head];
  }
  // fence: <Region> component form — open/close on own lines, blank around body.
  const open = `<Region name="${name}">`;
  return body ? [open, '', ...body.split('\n'), '', '</Region>'] : [open, '', '</Region>'];
}

/**
 * Splice `newLines` as a standalone block immediately after `afterRegion`'s full
 * span, keeping a single blank line on each side so it doesn't glue to neighbors.
 */
export function createRegionAfter(content: string, afterRegion: Region, newLines: string[]): string {
  const eol = eolOf(content);
  const lines = content.split(/\r?\n/);
  const insertAt = regionSpan(afterRegion)[1] + 1;
  const block = ['', ...newLines];
  if ((lines[insertAt]?.trim() ?? '') !== '') block.push(''); // trailing separator when needed
  lines.splice(insertAt, 0, ...block);
  return lines.join(eol);
}

export type RenameResult = { status: 'ok'; content: string } | { status: 'refused'; reason: string };

/**
 * Change a region's id on its anchor line. Works for EXPLICIT-id anchors only:
 *   <Region name="OLD">, <!-- region: OLD -->, <SectionHeading … id="OLD" …/>.
 * Refuses a markdown `##` heading (id is derived from text) and a colliding newId.
 */
export function renameAnchor(content: string, region: Region, newId: string): RenameResult {
  if (!/^[A-Za-z0-9_-]+$/.test(newId)) return { status: 'refused', reason: `invalid id '${newId}'` };
  if (parseRegions(content, region.file).some((r) => r.id === newId))
    return { status: 'refused', reason: `id '${newId}' already exists in file` };

  const eol = eolOf(content);
  const lines = content.split(/\r?\n/);
  const anchorIdx = regionSpan(region)[0];
  const anchor = lines[anchorIdx];

  let next: string | null = null;
  if (REGION_OPEN_RE.test(anchor)) next = anchor.replace(/(name=["'])[A-Za-z0-9_-]+(["'])/, `$1${newId}$2`);
  else if (FENCE_OPEN_RE.test(anchor)) next = anchor.replace(/(region:\s*)[A-Za-z0-9_-]+/, `$1${newId}`);
  else if (SECTION_HEADING_RE.test(anchor)) next = anchor.replace(/(\bid=["'])[A-Za-z0-9_-]+(["'])/, `$1${newId}$2`);
  else if (HEADING_RE.test(anchor))
    return { status: 'refused', reason: `markdown heading id is derived from its text — retitle the heading instead` };

  if (next === null || next === anchor) return { status: 'refused', reason: `could not rewrite anchor: ${anchor}` };
  lines[anchorIdx] = next;
  return { status: 'ok', content: lines.join(eol) };
}

/**
 * Rewrite cross-reference occurrences of an id — anchor hrefs (`#OLD`) and
 * page-qualified refs (`stem/OLD`, `/OLD`) — to newId, at id boundaries only so
 * `#OLD-suffix` is left alone. Returns the rewritten content and the hit count.
 */
export function rewriteRefs(content: string, oldId: string, newId: string): { content: string; count: number } {
  const esc = oldId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`([#/])${esc}(?![A-Za-z0-9_-])`, 'g');
  let count = 0;
  const out = content.replace(re, (_m, sep) => {
    count++;
    return `${sep}${newId}`;
  });
  return { content: out, count };
}

/**
 * Move a whole region (anchor + body) to before/after `target`'s span, within one
 * file. Refuses overlapping/nested spans (a region can't be reordered against itself).
 */
export function moveRegion(
  content: string,
  region: Region,
  target: Region,
  position: 'before' | 'after',
): RenameResult {
  const eol = eolOf(content);
  const lines = content.split(/\r?\n/);
  const [s0, s1] = regionSpan(region);
  const [t0, t1] = regionSpan(target);
  if (!(t1 < s0 || t0 > s1)) return { status: 'refused', reason: `regions overlap or nest — cannot reorder` };

  const moved = lines.slice(s0, s1 + 1);
  const rest = [...lines.slice(0, s0), ...lines.slice(s1 + 1)];
  const shift = t0 > s1 ? s1 - s0 + 1 : 0; // target moves left iff it was after src
  const at0 = t0 - shift;
  const at1 = t1 - shift;
  const insertIndex = position === 'after' ? at1 + 1 : at0;
  const result = [...rest.slice(0, insertIndex), ...moved, ...rest.slice(insertIndex)];
  return { status: 'ok', content: result.join(eol) };
}

// ── Span provenance / optimistic-concurrency guard (kb-projection-6ji.2) ─────
//
// The files-canonical analogue of Sanity's ifRevisionId: an agent (or projection
// reconciler) reads a region's hash, and a later mutating verb passes it back via
// --expect-hash; the verb refuses (exit 5) if the live body no longer matches — so
// concurrent writers / a hand-edit under a projection-owned region can't be silently
// clobbered. Hashing is over NORMALIZED body content (per fiberplane/drift's
// reformat-resilient AST-fingerprint idea, done here without a parser): trailing
// whitespace, intra-line whitespace runs, and blank-line churn don't move the hash,
// so a cosmetic reflow won't false-trigger a conflict. A future upgrade is a full
// mdast-normalized hash; this line-level normalization is the dependency-free v1.

/** Normalize a body for hashing: reflow/whitespace churn should not change the hash. */
export function normalizeForHash(body: string): string {
  return body
    .split(/\r?\n/)
    .map((l) => l.replace(/[ \t]+/g, ' ').replace(/[ \t]+$/g, '').trim())
    .join('\n')
    .replace(/\n{2,}/g, '\n') // collapse blank-line runs
    .replace(/^\n+|\n+$/g, ''); // drop leading/trailing blanks
}

/** Short, stable content hash of a region's current (normalized) body. */
export function hashRegionBody(content: string, region: Region): string {
  return createHash('sha256').update(normalizeForHash(regionBody(content, region))).digest('hex').slice(0, 16);
}
