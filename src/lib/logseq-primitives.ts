/**
 * logseq-primitives.ts — the single source of truth for the low-level LogSeq
 * primitives shared across the projection engine: HTML-entity decoding, the
 * title→filename 5-encoding resolver, `[[wikilink]]` extraction, `slugify`,
 * and leading-property-block parsing.
 *
 * WHY THIS FILE EXISTS (see bd kb-projection-dt7): these primitives were
 * independently re-inlined across `src/manifest/*` under an inherited
 * "self-contained, zero-dep Tool" convention, and two copies (decodeHtml,
 * slugify) had already drifted. This module is the one place each primitive is
 * defined. `logseqToAstro.ts` re-exports these so its public package API is
 * unchanged; every other consumer (manifest/*, subgraph, obsidian) imports
 * from here rather than reimplementing.
 *
 * RULE: do not re-inline any of these helpers elsewhere. Import them from here.
 *
 * Zero dependency on the projection engine — host sites can install just the
 * logseq-to-astro leaf (a `file:` dep) without dragging in the manifest editor.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Canonical LogSeq wikilink matcher: `[[Title]]` or `[[Title|Display]]`. */
export const WIKILINK_RE = /\[\[([^\[\]\|]+?)(?:\|[^\]]+)?\]\]/g;

/**
 * Decode the HTML entities that LogSeq may emit inside page titles / wikilink
 * targets, so a title resolves and matches consistently on every code path.
 *
 * This is the SUPERSET decoder (was duplicated in manifest/audit-drift.ts and
 * manifest/logseqMeta.ts). It is a strict extension of the older 4-entity lib
 * copy — it decodes everything the smaller set did, plus `&nbsp; &lt; &gt;
 * &middot; &hellip;`. Unifying to the superset locks the audit's finding-B
 * divergence closed: a `[[wikilink]]` title now decodes identically whether the
 * manifest path or the lib path touches it.
 */
export function decodeHtml(s: string): string {
  // `&amp;` MUST decode LAST so a composed entity like `&amp;lt;` (the encoding
  // of the literal text `&lt;`) decodes to `&lt;`, not `<`. Decoding `&amp;`
  // first would synthesize a fresh `&lt;` for the named-entity pass to eat —
  // a double-decode (bd kb-projection-gkf).
  return s
    .replace(/&sect;/g, '§')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&middot;/g, '·')
    .replace(/&hellip;/g, '…')
    .replace(/&amp;/g, '&');
}

/** Minimal HTML escape for attribute / text content composed in the loader. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Lossy slug — must match the 777westwood-baseline implementation byte-for-byte. */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/§/g, 'section')
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

/**
 * The canonical title→LogSeq-filename candidate encodings, probed in order.
 *
 * LogSeq stores pages as `pages/<title>.md` but escapes a few characters
 * (`/` `:` `?` `"`) into triple-underscore or URL-style forms depending on the
 * LogSeq version. Callers probe these against the filesystem and take the first
 * that exists. Defined ONCE here — was previously copied in resolveLogseqPath,
 * validate.resolveEntryFile, audit-drift.resolveTitleToFile, logseqMeta.
 */
export function logseqFilenameCandidates(title: string): string[] {
  return [
    title,
    title.replace(/\//g, '___'),
    title.replace(/:/g, '%3A'),
    title.replace(/\?/g, '%3F'),
    title.replace(/"/g, '%22'),
  ];
}

/**
 * Resolve a page title (or explicit filename) to its on-disk LogSeq page path.
 *
 * `pagesDir` is the graph's `pages/` directory. When `file` is set it wins
 * outright (hand-overrides where the title→filename mapping is too lossy to
 * recover); otherwise the 5 candidate encodings are probed in order. Returns
 * the first path that exists, or null.
 */
export function resolveTitleToPage(
  pagesDir: string,
  title: string,
  file?: string,
): string | null {
  if (file) {
    const p = join(pagesDir, file);
    return existsSync(p) ? p : null;
  }
  for (const c of logseqFilenameCandidates(title)) {
    const p = join(pagesDir, c + '.md');
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Extract outbound `[[wikilink]]` titles from page content: deduped,
 * HTML-decoded, and length-filtered (drop empty and pathologically long
 * matches). Returns titles in first-seen order.
 */
export function extractWikilinks(content: string): string[] {
  const found = new Set<string>();
  let m: RegExpExecArray | null;
  WIKILINK_RE.lastIndex = 0;
  while ((m = WIKILINK_RE.exec(content)) !== null) {
    const title = decodeHtml(m[1].trim());
    if (title.length > 0 && title.length < 200) found.add(title);
  }
  return Array.from(found);
}

// NOTE: allow `_` in property keys — LogSeq/PROMOTE write underscored keys like
// `source_session::`. Without `_`, the leading-property-block scan stops at the
// first underscored key and leaks it (plus everything after) into the rendered body.
const PROPERTY_LINE_RE = /^[a-z][a-z0-9_-]*::/;

/**
 * Strip the leading LogSeq `key:: value` property block from content,
 * returning only the body. If there is no leading property block (content
 * starts with prose, a heading, or a bullet), returns content unchanged.
 */
export function stripLeadingPropertyBlock(content: string): string {
  const lines = content.split('\n');
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  if (i >= lines.length || !PROPERTY_LINE_RE.test(lines[i])) {
    return content;
  }
  while (i < lines.length && PROPERTY_LINE_RE.test(lines[i])) i++;
  while (i < lines.length && lines[i].trim() === '') i++;
  return lines.slice(i).join('\n');
}

/** Parse leading LogSeq `key:: value` lines into a property bag + remaining body. */
export function parseProperties(content: string): {
  props: Record<string, string>;
  body: string;
} {
  const lines = content.split('\n');
  const props: Record<string, string> = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const m = line.match(/^([a-z0-9_-]+)::\s*(.+)$/i);
    if (m) {
      props[m[1]] = m[2].trim();
      i++;
    } else if (line.trim() === '' && Object.keys(props).length > 0) {
      i++;
      break;
    } else if (Object.keys(props).length === 0 && line.trim() === '') {
      i++;
    } else {
      break;
    }
  }
  return { props, body: lines.slice(i).join('\n') };
}
