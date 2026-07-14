/**
 * logseqToAstro.ts — pure transform helpers shared between the materialized
 * Astro target (Tools/targets/astro.ts) and the loader-driven target (host
 * site's content loader, kyber-3fh.5).
 *
 * Mostly pure functions. resolveLogseqPath is the one impure helper — it
 * does existsSync probes against the LogSeq filesystem to find the actual
 * filename for a manifest title. It's here (rather than in the loader) so
 * the hydrate-manifest-anchors tool can share the same path-resolution
 * logic as the loader without re-implementing the 5-encoding strategy.
 *
 * Plan: ~/commons/code/kyber/Plans/let-s-please-plan-1-6-generic-hanrahan.md (§1.6)
 */

import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';

// LogSeq primitives live in ONE place (bd kb-projection-dt7). These are
// re-exported here so this file's public package API is unchanged, and used
// internally by transformBody (decodeHtml, slugify) below. Do not re-inline them.
import {
  decodeHtml,
  escapeHtml,
  parseProperties,
  resolveTitleToPage,
  slugify,
  stripLeadingPropertyBlock,
  WIKILINK_RE,
} from './logseq-primitives';

export {
  decodeHtml,
  escapeHtml,
  parseProperties,
  slugify,
  stripLeadingPropertyBlock,
  WIKILINK_RE,
};

/**
 * Minimal entry shape needed by the transform helpers. Mirrors a subset of
 * SubgraphManifest's ManifestEntry from ../transformer.ts but inlined so this
 * package has zero runtime or type dependencies on the engine — host-site
 * content loaders can install just `@kyber/logseq-to-astro` (a `file:` dep
 * pointing at this directory) without dragging in the projection engine.
 */
export interface ManifestEntry {
  title: string;
  tier: string;
  backlinks?: string[];
  /** Override the LogSeq filename (sans extension) when the title doesn't map directly. */
  file?: string;
}

/**
 * Resolve a manifest entry's title to its LogSeq filename on disk.
 *
 * LogSeq stores pages as `pages/<title>.md` but escapes a few characters
 * (`:` `?` `"` `/`) into URL-style or triple-underscore forms depending on
 * the LogSeq version. We probe the canonical encodings in order and return
 * the first that exists; null if none.
 *
 * `entry.file`, when set, wins outright (used for hand-overrides where the
 * title→filename mapping is too lossy to recover).
 */
export function resolveLogseqPath(
  entry: ManifestEntry,
  graphPages: string,
): string | null {
  // Path resolution (incl. the 5-encoding candidate list) lives in the shared
  // primitives module; resolveLogseqPath is the entry-shaped adapter over it.
  return resolveTitleToPage(graphPages, entry.title, entry.file);
}

/** Compose YAML frontmatter from manifest entry + parsed properties. Matches sync-kb.ts byte order. */
export function buildFrontmatter(
  entry: ManifestEntry,
  props: Record<string, string>,
): string {
  const slug = slugify(entry.title);
  const fm: string[] = ['---'];
  fm.push(`title: ${JSON.stringify(entry.title)}`);
  fm.push(`slug: "${slug}"`);
  fm.push(`tier: "${entry.tier}"`);
  if (props.type) fm.push(`type: ${JSON.stringify(props.type)}`);
  if (props.category) fm.push(`category: ${JSON.stringify(props.category)}`);
  if (props.short)
    fm.push(`short: ${JSON.stringify(props.short.replace(/"/g, '\\"'))}`);
  if (props.source) fm.push(`source: ${JSON.stringify(props.source)}`);
  if (props.project) fm.push(`project: ${JSON.stringify(props.project)}`);
  if (props.created)
    fm.push(`created: ${JSON.stringify(props.created.replace(/[\[\]]/g, ''))}`);
  if (props['last-updated'])
    fm.push(
      `lastUpdated: ${JSON.stringify(props['last-updated'].replace(/[\[\]]/g, ''))}`,
    );
  if (props.related) fm.push(`related: ${JSON.stringify(props.related)}`);
  if (props.tags) fm.push(`pageTags: ${JSON.stringify(props.tags)}`);
  if (entry.backlinks && entry.backlinks.length > 0) {
    fm.push(`backlinks:`);
    for (const bl of entry.backlinks) fm.push(`  - ${JSON.stringify(bl)}`);
  }
  fm.push('---');
  fm.push('');
  return fm.join('\n');
}

const MARKDOWN_IMAGE_EMBED_RE = /!\[[^\]]*]\(([^)\s]+)\)/g;
const LOCAL_ASSET_REF_RE = /^(?:(?:\.\.|\.)\/)*assets\/.+/;

/**
 * Extract unique asset basenames from markdown image embeds that point at the
 * graph's local assets/ directory. Absolute /assets/... and remote refs are
 * intentionally ignored; only LogSeq-relative graph asset refs are carried
 * through into the published site.
 */
export function extractReferencedAssets(body: string): string[] {
  const assets = new Set<string>();
  let match: RegExpExecArray | null;

  while ((match = MARKDOWN_IMAGE_EMBED_RE.exec(body)) !== null) {
    const ref = match[1].trim();
    if (/^https?:\/\//i.test(ref)) continue;
    if (ref.startsWith('/')) continue;
    if (!LOCAL_ASSET_REF_RE.test(ref)) continue;
    const file = basename(ref);
    if (file) assets.add(file);
  }

  return [...assets];
}

/**
 * Copy graph-local assets referenced by projected page bodies into a published
 * site's public assets directory. Missing source files warn and are skipped so
 * page projection never fails on a stale asset reference.
 */
export function copyReferencedAssets(args: {
  graphDir: string;
  pageBodies: string[];
  targetPublicAssetsDir: string;
}): { copied: string[]; missing: string[] } {
  const wanted = [...new Set(args.pageBodies.flatMap(extractReferencedAssets))].sort();
  if (wanted.length === 0) {
    return { copied: [], missing: [] };
  }

  mkdirSync(args.targetPublicAssetsDir, { recursive: true });

  const copied: string[] = [];
  const missing: string[] = [];
  for (const file of wanted) {
    const sourcePath = join(args.graphDir, 'assets', file);
    if (!existsSync(sourcePath)) {
      console.warn(`logseqToAstro: missing asset ${sourcePath}; skipping copy`);
      missing.push(file);
      continue;
    }
    copyFileSync(sourcePath, join(args.targetPublicAssetsDir, file));
    copied.push(file);
  }

  return {
    copied: copied.sort(),
    missing: missing.sort(),
  };
}

/**
 * Body transform — strip LogSeq syntax, dedent implicit-root indentation,
 * rewrite wikilinks to Astro routes (or unresolved spans). Pure / idempotent.
 *
 * Output is BYTE-SENSITIVE for real consumer sites. It was once verified
 * byte-equivalent to the legacy 2026-04-18 transform-kb.ts pipeline via
 * kyber/scripts/regression/777westwood-astro.ts — but that regression (and the
 * legacy/ baseline it diffed against) was RETIRED in v0.2.0, so it is no longer
 * re-runnable. There is currently NO automated coverage of this function: treat
 * any change to it as unguarded and add snapshot coverage first (bd
 * kb-projection-s6h), which is the standing precondition for bd
 * kb-projection-nk3.1.
 */
export function transformBody(
  body: string,
  publishedSlugs: Set<string>,
  titleToSlug: Map<string, string>,
): string {
  let out = body;

  // 1. Strip LogSeq-specific lines
  out = out
    .split('\n')
    .filter((line) => {
      if (/^\s*collapsed::\s*(true|false)\s*$/i.test(line)) return false;
      if (/^\s*id::\s*[0-9a-f-]+\s*$/i.test(line)) return false;
      if (/^\s*logseq\.[a-z-]+::/i.test(line)) return false;
      return true;
    })
    .join('\n');

  // 2. Strip block refs ((uuid)) entirely (including whitespace around them)
  out = out.replace(/\s*\(\([0-9a-f-]{20,}\)\)\s*/g, '');

  // 3. Strip {{query ...}} and {{embed ...}} blocks
  out = out.replace(/\{\{\s*(?:query|embed)[\s\S]*?\}\}/g, '');

  // 3b. Rewrite LogSeq asset references (../assets/X, ./assets/X, assets/X) to
  //     the published absolute path /assets/kb/X, so inline images resolve at
  //     any page depth (e.g. /kb/<slug>/). Leading-slash paths are left alone.
  //     Host copies the referenced graph assets into public/assets/kb/ (see the
  //     consumer's scripts/copy-kb-images.ts, wired to its prebuild hook).
  out = out.replace(/\]\((?:(?:\.\.|\.)\/)*assets\//g, '](/assets/kb/');

  // 4. Normalize bullet-indented headings: "- ## Foo" → "\n## Foo"
  out = out.replace(/^[\s\t]*-\s+(#{1,6}\s+)/gm, '\n$1');

  // 5. CRITICAL — dedent LogSeq's implicit page-root indent. CommonMark would
  //    parse 1-tab content as a code block. Tab → 2-space first, then dedent
  //    by the minimum indent across non-blank, non-heading, non-blockquote
  //    lines. Skipping flush-left content prevents the min from collapsing
  //    to 0 and short-circuiting the dedent.
  const tabReplaced = out.replace(/\t/g, '  ');
  const lines = tabReplaced.split('\n');
  let minIndent = Infinity;
  for (const line of lines) {
    if (line.trim() === '') continue;
    if (/^#{1,6}\s/.test(line)) continue;
    if (/^>/.test(line)) continue;
    const m = line.match(/^( *)\S/);
    if (!m) continue;
    const indent = m[1].length;
    if (indent === 0) continue;
    minIndent = Math.min(minIndent, indent);
  }
  if (isFinite(minIndent) && minIndent > 0) {
    out = lines
      .map((line) => {
        if (line.trim() === '') return line;
        if (/^#{1,6}\s/.test(line)) return line;
        if (/^>/.test(line)) return line;
        const m = line.match(/^( *)/);
        if (!m || m[1].length === 0) return line;
        return line.slice(Math.min(minIndent, m[1].length));
      })
      .join('\n');
  } else {
    out = tabReplaced;
  }

  // 6. Wikilinks: [[Page]] or [[Page|Display]] → markdown link or unresolved span
  out = out.replace(
    /\[\[([^\[\]\|]+?)(?:\|([^\]]+))?\]\]/g,
    (match, title, display) => {
      const cleanTitle = decodeHtml(title.trim());
      const text = (display || title).trim();
      const targetSlug = titleToSlug.get(cleanTitle) || slugify(cleanTitle);
      if (publishedSlugs.has(targetSlug)) {
        return `[${text}](/kb/${targetSlug}/)`;
      }
      return `<span class="kb-unresolved" title="Not published">${text}</span>`;
    },
  );

  // 7. Collapse multiple blank lines
  out = out.replace(/\n{3,}/g, '\n\n');

  return out.trim();
}
