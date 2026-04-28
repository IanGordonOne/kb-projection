/**
 * LogSeq page metadata extraction — pure given a filesystem.
 *
 * Reads `<key>::` properties (category, type, project, tags) and
 * outbound wikilinks from a LogSeq page. Used by propose-placement.ts
 * to score candidate-vs-manifest topical fit.
 *
 * Zero-dep — matches existing _KNOWLEDGE_PROJECT/Tools style.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface PageMetadata {
  /** LogSeq filename relative to graph/pages, e.g. "Foo.md". */
  file: string;
  category: string | null;
  type: string | null;
  project: string | null;
  /** Tags (from `tags::` property), expanded as plain strings. */
  tags: string[];
  /** All outbound wikilinks ([[Page]] references) found in the body. */
  wikilinks: string[];
}

const WIKILINK_RE = /\[\[([^\[\]\|]+?)(?:\|[^\]]+)?\]\]/g;

function decodeHtml(s: string): string {
  return s
    .replace(/&sect;/g, '§')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&middot;/g, '·')
    .replace(/&hellip;/g, '…');
}

function extractWikilinksFromString(content: string): string[] {
  const found = new Set<string>();
  let m: RegExpExecArray | null;
  WIKILINK_RE.lastIndex = 0;
  while ((m = WIKILINK_RE.exec(content)) !== null) {
    const title = decodeHtml(m[1].trim());
    if (title.length > 0 && title.length < 200) found.add(title);
  }
  return Array.from(found);
}

function extractProperty(content: string, key: string): string | null {
  const re = new RegExp(`^${key}::\\s*(.+)$`, 'm');
  const m = content.match(re);
  return m ? m[1].trim() : null;
}

function extractTags(content: string): string[] {
  const raw = extractProperty(content, 'tags');
  if (!raw) return [];
  // Tags can be wikilinked ([[Foo]], [[Bar]]) or plain comma-separated.
  const wikilinked = extractWikilinksFromString(raw);
  if (wikilinked.length > 0) return wikilinked;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Resolve a manifest entry to its on-disk LogSeq page. Mirrors
 * validate.ts/resolveEntryFile (kept as a separate copy here so
 * propose-placement doesn't pull in the validator's filesystem
 * surface; both functions agree on the canonical mapping).
 */
function resolveTitleToFile(
  graphPath: string,
  title: string,
  explicitFile?: string
): string | null {
  const pagesDir = join(graphPath, 'pages');
  if (explicitFile) {
    const explicit = join(pagesDir, explicitFile);
    if (existsSync(explicit)) return explicit;
    return null;
  }
  const candidates = [
    title,
    title.replace(/\//g, '___'),
    title.replace(/:/g, '%3A'),
    title.replace(/\?/g, '%3F'),
    title.replace(/"/g, '%22'),
  ];
  for (const c of candidates) {
    const p = join(pagesDir, c + '.md');
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Read page metadata for a single LogSeq page. Returns null if the
 * page can't be resolved or read. Pure given filesystem state.
 */
export function readPageMetadata(
  graphPath: string,
  title: string,
  explicitFile?: string
): PageMetadata | null {
  const file = resolveTitleToFile(graphPath, title, explicitFile);
  if (!file) return null;
  let content: string;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const relativeFile = file.split('/pages/').slice(-1)[0];
  return {
    file: relativeFile,
    category: extractProperty(content, 'category'),
    type: extractProperty(content, 'type'),
    project: extractProperty(content, 'project'),
    tags: extractTags(content),
    wikilinks: extractWikilinksFromString(content),
  };
}

/**
 * Bulk-read page metadata for a list of (title, file?) pairs.
 * Returns a Map keyed by title; pages that don't resolve are absent.
 */
export function readPageMetadataBulk(
  graphPath: string,
  entries: Array<{ title: string; file?: string }>
): Map<string, PageMetadata> {
  const out = new Map<string, PageMetadata>();
  for (const e of entries) {
    const meta = readPageMetadata(graphPath, e.title, e.file);
    if (meta) out.set(e.title, meta);
  }
  return out;
}
