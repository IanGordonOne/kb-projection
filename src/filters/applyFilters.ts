/**
 * applyFilters — orchestrator for the per-entry filter pipeline declared
 * in the publish manifest (kyber-3fh.13 / perky-tarsier).
 *
 * Runs in the loader between hydration-cache substitution and
 * transformBody. Each filter sees the current renderBody and returns a
 * new one. The pipeline is not recursive: data filters splice the
 * referenced anchor's POST-cache-substitution body into the host body,
 * but they do NOT re-apply filters on the spliced body. This keeps
 * cycles operationally harmless (cli-audit-drift still flags them as
 * authorial confusion).
 *
 * Side-channel: `ctx.watchedAdditionPaths` accumulates source + cache
 * paths the loader should add to its watcher so HMR fires on edits to
 * referenced anchors.
 */

import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  parseProperties,
  resolveLogseqPath,
  stripLeadingPropertyBlock,
} from '../lib/logseqToAstro';
import type { FilterSpec, PublishEntry } from '../manifest/schema';
import { applyRedact } from './redact';

/**
 * Minimal manifest shape needed by the orchestrator. Mirrors the loader's
 * inline PublishManifest interface; redeclared here so this file does not
 * have to import from the loader (which would create a cycle).
 */
interface ManifestForFilters {
  entries: Array<Pick<PublishEntry, 'title' | 'exclude' | 'file'>>;
}

export interface FilterContext {
  /** Title of the entry currently being rendered (for self-reference detection). */
  entryTitle: string;
  /** Absolute path to the LogSeq graph's pages dir. */
  graphPages: string;
  /** Absolute path to the per-machine hydration cache. */
  hydrationCacheDir: string;
  /** The full publish manifest — used to verify filter sources are themselves published. */
  manifest: ManifestForFilters;
  /**
   * Mutable accumulator. The loader appends each path to its watcher
   * after applyFilters returns. Includes addition source paths and any
   * cache files that contributed bodies.
   */
  watchedAdditionPaths: string[];
  /**
   * Optional logger for warnings about filter sources that resolve at
   * audit-time but fail to resolve at render-time. The loader supplies
   * its astro-loader logger here.
   */
  logger?: { warn: (msg: string) => void };
}

/**
 * Resolve a KB anchor title to its post-cache-substitution body. Returns
 * null if the anchor cannot be resolved on disk; in that case the caller
 * keeps the host body unchanged (audit-drift is the place that flags
 * broken refs — applyFilters is best-effort at render time).
 *
 * Cache-aware: if the anchor is `type:: anchor` with a `tg-doc::`
 * property, the cache file at `<hydrationCacheDir>/<basename>.md` is
 * consulted; the leading property block is stripped to match the
 * loader's own anchor branch.
 */
function readAdditionBody(
  title: string,
  ctx: FilterContext,
): string | null {
  const sourcePath = resolveLogseqPath({ title, tier: '1-hop' }, ctx.graphPages);
  if (!sourcePath) return null;
  ctx.watchedAdditionPaths.push(sourcePath);

  const raw = readFileSync(sourcePath, 'utf-8');
  const { props, body } = parseProperties(raw);

  if (props.type === 'anchor' && props['tg-doc']) {
    const cachePath = join(ctx.hydrationCacheDir, basename(sourcePath));
    if (existsSync(cachePath)) {
      ctx.watchedAdditionPaths.push(cachePath);
      const sidecarPath = cachePath + '.meta.yaml';
      if (existsSync(sidecarPath)) ctx.watchedAdditionPaths.push(sidecarPath);
      return stripLeadingPropertyBlock(readFileSync(cachePath, 'utf-8'));
    }
    if (ctx.logger) {
      ctx.logger.warn(
        `Filter addition "${title}": tg-doc cache missing at ${cachePath}; ` +
          `splicing thin LogSeq body. Run hydrate-manifest-anchors.`,
      );
    }
    // Fall through to the LogSeq body (which carries the property block).
    // Strip it so the splice doesn't carry property syntax into the host.
    return stripLeadingPropertyBlock(body);
  }

  // For non-anchor pages the body is the LogSeq body verbatim. Still
  // strip a leading property block in case the page declares props.
  return stripLeadingPropertyBlock(body);
}

function applySplice(
  body: string,
  additionTitle: string,
  position: 'prepend' | 'append',
  ctx: FilterContext,
): string {
  if (additionTitle === ctx.entryTitle) {
    // Self-reference is operationally harmless (no recursion) but pointless;
    // audit-drift surfaces it. Skip the splice silently here.
    return body;
  }
  const additionBody = readAdditionBody(additionTitle, ctx);
  if (additionBody === null) {
    if (ctx.logger) {
      ctx.logger.warn(
        `Filter addition "${additionTitle}" referenced by "${ctx.entryTitle}" ` +
          `did not resolve to a LogSeq page; skipping splice.`,
      );
    }
    return body;
  }
  // Single blank-line separator on each side; transformBody collapses runs.
  const trimmed = additionBody.replace(/^\n+|\n+$/g, '');
  if (trimmed.length === 0) return body;
  return position === 'prepend'
    ? `${trimmed}\n\n${body}`
    : `${body}\n\n${trimmed}`;
}

export function applyFilters(
  body: string,
  filters: FilterSpec[],
  ctx: FilterContext,
): string {
  let out = body;
  for (const f of filters) {
    if ('prepend' in f) {
      out = applySplice(out, f.prepend, 'prepend', ctx);
    } else if ('append' in f) {
      out = applySplice(out, f.append, 'append', ctx);
    } else if ('redact' in f) {
      out = applyRedact(out, { mode: f.redact });
    }
  }
  return out;
}
