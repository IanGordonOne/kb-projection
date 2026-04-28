/**
 * targets/astro.ts — Astro target for the projection engine.
 *
 * Combines the work that shipped as two separate scripts on the 2026-04-18
 * 777westwood site (sync-kb.ts + transform-kb.ts) into one engine-compatible
 * TargetEmitter. Single pass per page: read LogSeq source → apply optional
 * redaction → build YAML frontmatter → transform body (strip LogSeq syntax,
 * dedent, rewrite wikilinks) → write `<outputDir>/<slug>.md`.
 *
 * After all pages emit, writes `<outputDir>/_manifest.json` for downstream
 * Astro tooling (the host site's link-kb-refs / heading-id passes still
 * read this file). Schema matches the 777westwood reference.
 *
 * Phases 6-8 of PublishSubgraph map here as follows:
 *   - Phase 6 (sync to host)   → emit() per entry + _manifest.json
 *   - Phase 7 (markdown xform) → transformBody() inside emit()
 *   - Phase 8 (link-kb-refs / heading-ids / build / deploy) → host-site
 *     responsibility; the target does NOT invoke `astro build` or deploy.
 *     Those are infrastructure concerns belonging to the host repo.
 *
 * Plan: ~/Projects/kyber/Plans/let-s-please-plan-1-6-generic-hanrahan.md (§1.6 part B).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  registerTarget,
  sha256,
  type EmitResult,
  type SubgraphManifest,
  type TargetEmitter,
  type TransformOptions,
} from '../transformer.ts';
import {
  buildFrontmatter,
  parseProperties,
  slugify,
  transformBody,
} from '../../src/lib/logseqToAstro.ts';

// ─── Astro-specific options ───────────────────────────────────────────

/**
 * Hook applied to a page body BEFORE the LogSeq → markdown transform. Useful
 * for site-specific redactions (the 777westwood site mutated rating-3 pages
 * via this kind of callback). Receives the raw body as it appears in LogSeq;
 * returns the body to be transformed and emitted.
 *
 * Hooks must be deterministic — engine bridge accounting hashes the emitted
 * artifact, and a non-deterministic hook will perpetually report drift.
 */
export type BodyHook = (title: string, body: string) => string;

export interface AstroTargetOptions {
  /** LogSeq graph root (containing `pages/`). Source files are resolved as `<graphPath>/pages/<entry.file>`. */
  graphPath: string;
  /** Titles to omit from the emit (rating-4 hold). Compared exactly against entry.title. */
  excludeTitles?: string[];
  /** Titles to which `bodyHook` is applied; pages outside this set are emitted with their raw body. If unset, the hook applies to every page when present. */
  hookTitles?: string[];
  /** Body transform applied before the LogSeq → Astro markdown transform. */
  bodyHook?: BodyHook;
  /** If true (default), write `<outputDir>/_manifest.json` for downstream Astro tooling. */
  writeManifest?: boolean;
}

// ─── TargetEmitter ────────────────────────────────────────────────────

const astroEmitter: TargetEmitter = (
  manifest: SubgraphManifest,
  options: TransformOptions,
): EmitResult => {
  const opts = (options.targetOptions ?? {}) as Partial<AstroTargetOptions>;
  if (!opts.graphPath) {
    throw new Error(
      `astro target requires targetOptions.graphPath (path to LogSeq graph root containing pages/).`,
    );
  }
  const graphPath = opts.graphPath;
  const excludeSet = new Set(opts.excludeTitles ?? []);
  const hookTitleSet = opts.hookTitles ? new Set(opts.hookTitles) : null;
  const bodyHook = opts.bodyHook;
  const writeManifest = opts.writeManifest !== false;

  mkdirSync(options.outputDir, { recursive: true });

  // First pass: determine which entries pass the EXCLUDE filter so the
  // wikilink resolver in transformBody can distinguish published vs unresolved.
  const includedEntries = manifest.entries.filter((e) => !excludeSet.has(e.title));
  const publishedSlugs = new Set<string>(includedEntries.map((e) => slugify(e.title)));
  const titleToSlug = new Map<string, string>(
    includedEntries.map((e) => [e.title, slugify(e.title)]),
  );

  const correspondences: EmitResult['correspondences'] = [];
  const includedSummary: Array<{ title: string; slug: string; tier: string }> = [];
  const excludedTitles: string[] = [];
  const redactedTitles: string[] = [];
  const emittedAt = new Date().toISOString();

  for (const entry of manifest.entries) {
    if (excludeSet.has(entry.title)) {
      excludedTitles.push(entry.title);
      continue;
    }
    const sourcePath = join(graphPath, 'pages', entry.file);
    const rawSource = readFileSync(sourcePath, 'utf-8');
    const sourceHashValue = sha256(rawSource);
    const { props, body } = parseProperties(rawSource);

    let preTransformBody = body;
    const shouldHook = bodyHook && (hookTitleSet === null || hookTitleSet.has(entry.title));
    if (shouldHook) {
      preTransformBody = bodyHook!(entry.title, body);
      redactedTitles.push(entry.title);
    }

    const transformed = transformBody(preTransformBody, publishedSlugs, titleToSlug);
    const frontmatter = buildFrontmatter(entry, props);
    // sync-kb writes `frontmatter + body` (no trailing newline added there) and
    // transform-kb later writes `fm + transformBody(body) + '\n'`. Final byte
    // form is therefore: frontmatter, transformed body, single trailing '\n'.
    const finalContent = frontmatter + transformed + '\n';
    const slug = slugify(entry.title);
    const emittedPath = join(options.outputDir, `${slug}.md`);
    writeFileSync(emittedPath, finalContent);

    correspondences.push({
      sourcePath,
      sourceHash: sourceHashValue,
      emitTarget: 'astro',
      emittedPath,
      emittedHash: sha256(finalContent),
      emittedAt,
    });
    includedSummary.push({ title: entry.title, slug, tier: entry.tier });
  }

  if (writeManifest) {
    const manifestPath = join(options.outputDir, '_manifest.json');
    let manifestObj: {
      generated: string;
      included: number;
      excluded: number;
      redacted: number;
      pages: Array<{ title: string; slug: string; tier: string }>;
      excludedTitles: string[];
      redactedTitles: string[];
    };

    if (options.onlyStale && existsSync(manifestPath)) {
      // Partial emit — merge the slugs we just regenerated into the prior
      // manifest. Replace existing entries by slug; append new ones. The
      // exclude/redact summaries from a partial run are necessarily incomplete
      // (we only saw a subset of the manifest), so leave the prior counts
      // untouched and just bump `generated`. This means a partial run never
      // reduces the published-page count visible to downstream tooling.
      try {
        const prior = JSON.parse(readFileSync(manifestPath, 'utf-8')) as typeof manifestObj;
        const bySlug = new Map(prior.pages.map((p) => [p.slug, p]));
        for (const p of includedSummary) bySlug.set(p.slug, p);
        const mergedPages = [...bySlug.values()];
        manifestObj = {
          ...prior,
          generated: emittedAt,
          included: mergedPages.length,
          pages: mergedPages,
        };
      } catch {
        // Prior manifest unreadable — fall through to full overwrite shape.
        manifestObj = {
          generated: emittedAt,
          included: includedSummary.length,
          excluded: excludedTitles.length,
          redacted: redactedTitles.length,
          pages: includedSummary,
          excludedTitles,
          redactedTitles,
        };
      }
    } else {
      manifestObj = {
        generated: emittedAt,
        included: includedSummary.length,
        excluded: excludedTitles.length,
        redacted: redactedTitles.length,
        pages: includedSummary,
        excludedTitles,
        redactedTitles,
      };
    }

    writeFileSync(manifestPath, JSON.stringify(manifestObj, null, 2));
  }

  return {
    correspondences,
    summary:
      `astro: included=${includedSummary.length} ` +
      `excluded=${excludedTitles.length} redacted=${redactedTitles.length}`,
  };
};

// Self-register on import so `import 'targets/astro.ts'` is enough to make
// the engine aware of the target.
registerTarget('astro', astroEmitter);

export { astroEmitter };
