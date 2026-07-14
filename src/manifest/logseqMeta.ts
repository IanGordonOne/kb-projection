/**
 * LogSeq page metadata extraction — pure given a filesystem.
 *
 * Reads `<key>::` properties (category, type, project, tags) and
 * outbound wikilinks from a LogSeq page. Used by propose-placement.ts
 * to score candidate-vs-manifest topical fit.
 *
 * No external deps. Shared LogSeq primitives (wikilink extraction, the
 * title→file 5-encoding resolver) live in `../lib/logseq-primitives.ts` and are
 * IMPORTED here — do not re-inline them (bd kb-projection-dt7).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractWikilinks, resolveTitleToPage } from '../lib/logseq-primitives';

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

function extractProperty(content: string, key: string): string | null {
  const re = new RegExp(`^${key}::\\s*(.+)$`, 'm');
  const m = content.match(re);
  return m ? m[1].trim() : null;
}

function extractTags(content: string): string[] {
  const raw = extractProperty(content, 'tags');
  if (!raw) return [];
  // Tags can be wikilinked ([[Foo]], [[Bar]]) or plain comma-separated.
  const wikilinked = extractWikilinks(raw);
  if (wikilinked.length > 0) return wikilinked;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
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
  const file = resolveTitleToPage(join(graphPath, 'pages'), title, explicitFile);
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
    wikilinks: extractWikilinks(content),
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
