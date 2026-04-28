/**
 * loader.ts — `createKbLoader` factory: site-agnostic Astro Content Layer
 * loader for KB-publishing sites. Host sites import via
 * `@kyber/logseq-to-astro/loader` and supply only site-specific bits
 * (typically a `bodyHooks` map keyed by `entry.redact`).
 *
 * Reads the publish manifest, resolves each entry to a LogSeq page,
 * parses properties, performs hydration-cache substitution for anchor
 * + image-anchor entries (kyber-3fh.9 / kyber-3fh.10), runs
 * transformBody, hands the result to Astro's content store.
 *
 * Plan: 777westwood/Plans/let-s-please-plan-create-kb-loader-thoughtful-pangolin.md
 * Bead: kyber-3fh.15
 */

import type { Loader } from 'astro/loaders';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { applyFilters, type FilterContext, type RedactRules } from '../filters';
import type { FilterSpec } from '../manifest/schema';
import {
  escapeHtml,
  parseProperties,
  resolveLogseqPath,
  slugify,
  stripLeadingPropertyBlock,
  transformBody,
} from './logseqToAstro';

const HYDRATION_CACHE_ENV = 'KYBER_HYDRATION_CACHE';

/** Optional per-page body transform keyed by `entry.redact` value. */
export type BodyHook = (title: string, body: string) => string;

/**
 * The host site's markdown processor. Injected by the host so the
 * lib does not import `@astrojs/markdown-remark` directly — module
 * resolution from the lib's filesystem path (which may be a symlinked
 * `file:` dep at ~/.claude/USER/...) cannot find host-installed
 * Astro packages. The host's kb.ts shell creates the processor and
 * passes a creator function in.
 */
/**
 * Heading shape mirrors Astro's MarkdownHeading. Inlined to keep this
 * package free of a hard dependency on @astrojs/markdown-remark — the
 * host injects a processor whose render output uses this shape.
 */
export interface ProcessorHeading {
  depth: number;
  slug: string;
  text: string;
}

export interface MarkdownProcessorLike {
  render: (
    content: string,
  ) => Promise<{
    code: string;
    metadata: { headings: ProcessorHeading[] };
  }>;
}

export interface KbLoaderOptions {
  /** Default: <cwd>/src/content/kb-publish.manifest.json */
  manifestPath?: string;
  /**
   * Default: $KYBER_HYDRATION_CACHE or ~/.kyber/hydration-cache
   * Per-machine cache populated by hydrate-manifest-anchors and
   * hydrate-manifest-images.
   */
  hydrationCacheDir?: string;
  /**
   * Per-page body transforms keyed by `entry.redact` value.
   * Today's 777westwood pattern: `{ 'light': redactLight }`.
   * The site's loader file supplies this; kyber-3fh.13 (perky-tarsier)
   * adds a richer `filters: [...]` pipeline that lands ALONGSIDE these
   * legacy hooks (filters preferred when both present).
   */
  bodyHooks?: Record<string, BodyHook>;
  /**
   * Required: factory that creates the host site's Astro markdown
   * processor. Host's kb.ts imports `createMarkdownProcessor` from
   * `@astrojs/markdown-remark` and passes `() => createMarkdownProcessor()`.
   * The lib does not import the package directly to avoid
   * symlink-resolution failures from the lib's filesystem path.
   */
  createProcessor: () => Promise<MarkdownProcessorLike>;
  /**
   * Host-supplied redact rules keyed by mode name. The engine ships
   * only `none` as a built-in (no-op); any other mode (e.g., `light`)
   * is host-supplied here. Source-clean: no site-specific patterns
   * live in the engine. Each ruleset is `{ notice?, rules: [{ pattern,
   * replacement }] }`.
   */
  redactRulesByMode?: Record<string, RedactRules>;
}

/** Publish manifest entry shape — must match the manifest schema. */
interface PublishEntry {
  title: string;
  tier: 'seed' | '1-hop' | '2-hop' | 'n-hop';
  backlinks?: string[];
  exclude?: boolean;
  redact?: string;
  file?: string;
  /**
   * kyber-3fh.13 (perky-tarsier) — per-entry filter pipeline applied
   * between hydration-cache substitution and transformBody. See
   * `Tools/filters/` and the manifest schema FilterSpec.
   */
  filters?: FilterSpec[];
}

interface PublishManifest {
  $schema?: string;
  generatedAt?: string;
  graphPath: string;
  entries: PublishEntry[];
}

export function createKbLoader(opts: KbLoaderOptions): Loader {
  const HOME = homedir();
  const manifestPath =
    opts.manifestPath ??
    join(process.cwd(), 'src', 'content', 'kb-publish.manifest.json');
  const hydrationCacheDir =
    opts.hydrationCacheDir ??
    process.env[HYDRATION_CACHE_ENV] ??
    join(HOME, '.kyber', 'hydration-cache');
  const bodyHooks = opts.bodyHooks ?? {};
  const defaultGraphPages = join(HOME, 'Logseq', 'MyGraph', 'pages');

  return {
    name: 'kb',
    load: async ({ store, parseData, generateDigest, watcher, logger }) => {
      if (!existsSync(manifestPath)) {
        logger.error(`Publish manifest not found: ${manifestPath}`);
        return;
      }
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as PublishManifest;
      const graphPages = manifest.graphPath
        ? join(manifest.graphPath, 'pages')
        : defaultGraphPages;

      const processor = await opts.createProcessor();

      const publishedEntries = manifest.entries.filter((e) => !e.exclude);
      const publishedSlugs = new Set(publishedEntries.map((e) => slugify(e.title)));
      const titleToSlug = new Map(publishedEntries.map((e) => [e.title, slugify(e.title)]));

      store.clear();

      let included = 0;
      let skippedMissing = 0;
      let hydratedFromCache = 0;
      let anchorsMissingCache = 0;
      const watchedPaths: string[] = [];

      for (const entry of publishedEntries) {
        const sourcePath = resolveLogseqPath(entry, graphPages);
        if (!sourcePath) {
          logger.warn(`Skipping ${entry.title}: source not found in ${graphPages}`);
          skippedMissing++;
          continue;
        }
        watchedPaths.push(sourcePath);

        const raw = readFileSync(sourcePath, 'utf-8');
        const { props, body } = parseProperties(raw);

        let renderBody = body;
        if (props.type === 'anchor' && props['tg-doc']) {
          const cachePath = join(hydrationCacheDir, basename(sourcePath));
          if (existsSync(cachePath)) {
            const cached = readFileSync(cachePath, 'utf-8');
            renderBody = stripLeadingPropertyBlock(cached);
            watchedPaths.push(cachePath);
            const sidecarPath = cachePath + '.meta.yaml';
            if (existsSync(sidecarPath)) watchedPaths.push(sidecarPath);
            hydratedFromCache++;
          } else {
            logger.warn(
              `Anchor ${entry.title}: hydration cache missing at ${cachePath}; ` +
                `rendering thin anchor body. Run hydrate-manifest-anchors to refresh.`,
            );
            anchorsMissingCache++;
          }
        } else if (props.type === 'image-anchor' && props['tg-doc']) {
          const mime = props['mime-type'] ?? 'image/png';
          const ext =
            mime === 'image/jpeg' || mime === 'image/jpg' ? '.jpg' :
            mime === 'image/webp' ? '.webp' :
            mime === 'image/svg+xml' ? '.svg' :
            mime === 'image/gif' ? '.gif' :
            '.png';
          const sourceBaseNoExt = basename(sourcePath, extname(sourcePath));
          const imageBasename = sourceBaseNoExt + ext;
          const imageCachePath = join(hydrationCacheDir, imageBasename);
          const sidecarCachePath = imageCachePath + '.meta.yaml';
          if (existsSync(imageCachePath)) {
            let alt = props.caption ?? `Image: ${entry.title}`;
            if (!props.caption && existsSync(sidecarCachePath)) {
              try {
                const sidecar = readFileSync(sidecarCachePath, 'utf-8');
                const m = sidecar.match(/^\s+composition:\s*"([^"]+)"/m);
                if (m) alt = m[1];
              } catch {
                /* fall through to title fallback */
              }
            }
            const figcaption = props.caption ? `<figcaption>${escapeHtml(props.caption)}</figcaption>` : '';
            renderBody =
              `<figure>\n` +
              `  <img src="/assets/kb/${imageBasename}" alt="${escapeHtml(alt)}">\n` +
              `  ${figcaption}\n` +
              `</figure>\n`;
            watchedPaths.push(imageCachePath);
            if (existsSync(sidecarCachePath)) watchedPaths.push(sidecarCachePath);
            hydratedFromCache++;
          } else {
            logger.warn(
              `Image-anchor ${entry.title}: image not in cache at ${imageCachePath}; ` +
                `rendering placeholder. Run hydrate-manifest-images to refresh.`,
            );
            renderBody = `> Image \`${props['tg-doc']}\` pending hydration. Run \`hydrate-manifest-images\`.\n`;
            anchorsMissingCache++;
          }
        }

        // kyber-3fh.13 (perky-tarsier) — apply manifest-declared filter
        // pipeline between hydration-cache substitution and transformBody.
        // Filters can prepend/append KB anchor bodies (data filters) or
        // run named code transforms (e.g. redact). cli-validate rejects
        // entries that have BOTH a top-level `redact` AND a redact filter,
        // so the legacy bodyHooks path below only fires when the new
        // pipeline does NOT include a redact filter.
        let filteredBody = renderBody;
        let hasFilterRedact = false;
        if (entry.filters && entry.filters.length > 0) {
          const filterCtx: FilterContext = {
            entryTitle: entry.title,
            graphPages,
            hydrationCacheDir,
            manifest,
            watchedAdditionPaths: [],
            logger,
            redactRulesByMode: opts.redactRulesByMode,
          };
          filteredBody = applyFilters(renderBody, entry.filters, filterCtx);
          for (const p of filterCtx.watchedAdditionPaths) watchedPaths.push(p);
          hasFilterRedact = entry.filters.some((f) => 'redact' in f);
        }

        // Legacy bodyHooks lookup keyed by `entry.redact`. Preferred-against
        // when the new filter pipeline already supplied a redact. Existing
        // sites without filters keep working unchanged.
        const hook =
          !hasFilterRedact && entry.redact ? bodyHooks[entry.redact] : undefined;
        const preTransform = hook ? hook(entry.title, filteredBody) : filteredBody;
        const transformed = transformBody(preTransform, publishedSlugs, titleToSlug);

        const slug = slugify(entry.title);
        const dataIn: Record<string, unknown> = {
          title: entry.title,
          slug,
          tier: entry.tier,
        };
        if (props.type) dataIn.type = props.type;
        if (props.category) dataIn.category = props.category;
        if (props.short) dataIn.short = props.short;
        if (props.source) dataIn.source = props.source;
        if (props.project) dataIn.project = props.project;
        if (props.created) dataIn.created = props.created.replace(/[\[\]]/g, '');
        if (props['last-updated'])
          dataIn.lastUpdated = props['last-updated'].replace(/[\[\]]/g, '');
        if (props.related) dataIn.related = props.related;
        if (props.tags) dataIn.pageTags = props.tags;
        if (entry.backlinks && entry.backlinks.length > 0) dataIn.backlinks = entry.backlinks;

        const data = await parseData({ id: slug, data: dataIn });
        const rendered = await processor.render(transformed);
        store.set({
          id: slug,
          data,
          body: transformed,
          digest: generateDigest({ data, body: transformed }),
          rendered: {
            html: rendered.code,
            metadata: {
              headings: rendered.metadata.headings,
              frontmatter: dataIn,
              imagePaths: [],
            },
          },
        });
        included++;
      }

      logger.info(
        `kb-loader: included=${included} ` +
          `excluded=${manifest.entries.length - publishedEntries.length} ` +
          `missing=${skippedMissing} ` +
          `hydrated=${hydratedFromCache} ` +
          `anchors-missing-cache=${anchorsMissingCache}`,
      );

      if (watcher) {
        watcher.add(manifestPath);
        for (const p of watchedPaths) watcher.add(p);
      }
    },
  };
}
