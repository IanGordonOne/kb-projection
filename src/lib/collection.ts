/**
 * collection.ts — `createKbCollection` convenience helper.
 *
 * Bundles the two pieces of boilerplate every KB-publishing Astro site
 * repeats: (1) wrapping `createKbLoader` with site config, and (2)
 * declaring the Astro content collection + frontmatter schema. A host's
 * `src/content/config.ts` collapses to a single call, and the host's
 * separate `loaders/kb.ts` shell disappears entirely.
 *
 * The engine cannot import `astro:content` (a virtual module resolved
 * only inside an Astro build), nor `astro:content`'s re-exported `z`,
 * so the host injects `defineCollection` and `z`. Same injection
 * rationale as `createProcessor` in loader.ts.
 *
 * Bead: kyber-3fh.15 (loader factory) — createKbCollection folds the
 *       777westwood loaders/kb.ts + config.ts boilerplate into the engine.
 */

import { createKbLoader, type KbLoaderOptions } from './loader';

/** Minimal structural shape of Astro's `defineCollection`. */
type DefineCollection = (config: { loader: unknown; schema: unknown }) => unknown;

/**
 * Minimal structural shape of the `z` namespace Astro re-exports from
 * `astro:content`. Typed as `any` because the engine deliberately
 * carries no `zod`/`astro` value-import; the host passes the real `z`
 * and we only call `z.object`/`z.string`/`z.array`/`.optional()`.
 */
type ZodLike = any;

export interface CreateKbCollectionOptions extends KbLoaderOptions {
  /** Astro's `defineCollection`, injected by the host (virtual module). */
  defineCollection: DefineCollection;
  /** Astro's re-exported `z`, injected by the host (virtual module). */
  z: ZodLike;
  /**
   * Optional schema builder. Receives the injected `z` and returns the
   * collection schema. Defaults to {@link defaultKbSchema} — the standard
   * KB frontmatter shape. Supply your own to add/constrain fields.
   */
  schema?: (z: ZodLike) => unknown;
}

/**
 * Standard KB frontmatter schema — the default when `schema` is omitted.
 * Mirrors what 777westwood's hand-written `config.ts` declared so the
 * extraction is behavior-preserving.
 */
export function defaultKbSchema(z: ZodLike): unknown {
  return z.object({
    title: z.string(),
    slug: z.string(),
    tier: z.string().optional(),
    type: z.string().optional(),
    category: z.string().optional(),
    short: z.string().optional(),
    source: z.string().optional(),
    project: z.string().optional(),
    created: z.string().optional(),
    lastUpdated: z.string().optional(),
    related: z.string().optional(),
    pageTags: z.string().optional(),
    backlinks: z.array(z.string()).optional(),
    provClass: z.string().optional(), // fact|provision|strategy — fences strategy in render
  });
}

/**
 * Build a complete Astro content collection for a KB-publishing site.
 * Equivalent to the prior 777westwood pair (`loaders/kb.ts` +
 * `config.ts`): wires the loader with site config and attaches the
 * frontmatter schema. The host calls `defineCollection`-injected here
 * rather than the engine importing the virtual module.
 *
 * @example
 *   import { defineCollection, z } from 'astro:content';
 *   import { createMarkdownProcessor } from '@astrojs/markdown-remark';
 *   import { createKbCollection } from '@kyber/kb-projection/collection';
 *   import { redactLight, westwoodLightRules } from './loaders/redact-westwood';
 *
 *   const kb = createKbCollection({
 *     defineCollection, z,
 *     bodyHooks: { light: redactLight },
 *     redactRulesByMode: { light: westwoodLightRules },
 *     createProcessor: () => createMarkdownProcessor(),
 *   });
 *   export const collections = { kb };
 */
export function createKbCollection(opts: CreateKbCollectionOptions) {
  const { defineCollection, z, schema, ...loaderOpts } = opts;
  return defineCollection({
    loader: createKbLoader(loaderOpts),
    schema: (schema ?? defaultKbSchema)(z),
  });
}
