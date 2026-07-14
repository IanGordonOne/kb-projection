/**
 * targets/obsidian.ts — Obsidian-vault emit target (bd kb-projection-0ci).
 *
 * Registers as the 'obsidian' target alongside the Astro target
 * (src/lib/logseqToAstro.ts). Projects a LogSeq SSOT page (and an optional
 * curated subgraph) into an Obsidian vault:
 *   - LogSeq `key:: value` property block  → YAML frontmatter
 *   - carry provenance (grounding_uri / source_ssot_logseq /
 *     source_thought_agent_kb) into frontmatter + a `> [!info]` callout
 *   - de-outline LogSeq bullets → clean GFM (strip cruft, dedent implicit
 *     root, `- ## Foo` → `## Foo`, bare section-label bullets → `###`)
 *   - preserve `[[wikilinks]]` (native in Obsidian), sanitizing '/'-in-title
 *     targets and rewriting inbound links to the sanitized name
 *   - image embeds `![alt](../assets/X)` → Obsidian `![[X]]`, assets copied
 *   - dry-run default (return the plan; write only when apply=true)
 *
 * Reuses the pure helpers from logseqToAstro (parseProperties,
 * resolveLogseqPath, extractReferencedAssets, decodeHtml). The body-cleaning
 * core is DUPLICATED here rather than refactored out of `transformBody`
 * because that function is pinned byte-for-byte by the 777westwood Astro
 * regression and must not be touched (see its header comment).
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import {
  decodeHtml,
  extractReferencedAssets,
  parseProperties,
  resolveLogseqPath,
  type ManifestEntry,
} from '../lib/logseqToAstro';
import { selectSubgraph, type BoundaryLink, type SelectOpts } from '../lib/subgraph';

// ---------------------------------------------------------------------------
// Title / filename sanitizing
// ---------------------------------------------------------------------------

/**
 * Make a LogSeq page title safe as an Obsidian note name. Obsidian reads
 * `[[A/B]]` as a nested path and disallows a few filename chars; map them to
 * readable equivalents so both the file AND inbound `[[wikilinks]]` resolve.
 */
export function sanitizeObsidianTitle(title: string): string {
  return title
    .replace(/ \/ /g, ', ') // "Hands / head / authority" → "Hands, head, authority"
    .replace(/[\/\\]/g, '-') // any remaining path separator → hyphen
    .replace(/:/g, ' -') // colon is filename-hostile on some FS + illegal in Obsidian
    .replace(/[*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Body transform (de-outline → clean GFM, Obsidian links + embeds)
// ---------------------------------------------------------------------------

/**
 * Strip LogSeq-only syntax and de-outline the implicit page-root indentation.
 * Duplicated from logseqToAstro.transformBody steps 1–5/7 (Astro-agnostic
 * subset), MINUS the Astro route/asset rewrites which the caller does the
 * Obsidian way.
 */
export function cleanLogseqBody(body: string): string {
  let out = body;

  // 1. Drop LogSeq-only property/marker lines.
  out = out
    .split('\n')
    .filter((line) => {
      if (/^\s*collapsed::\s*(true|false)\s*$/i.test(line)) return false;
      if (/^\s*id::\s*[0-9a-f-]+\s*$/i.test(line)) return false;
      if (/^\s*logseq\.[a-z-]+::/i.test(line)) return false;
      if (/^\s*[a-z0-9_-]+::\s/i.test(line)) return false; // stray inline props (e.g. source::)
      return true;
    })
    .join('\n');

  // 2. Block refs ((uuid)) and 3. {{query|embed ...}} blocks → gone.
  out = out.replace(/\s*\(\([0-9a-f-]{20,}\)\)\s*/g, '');
  out = out.replace(/\{\{\s*(?:query|embed)[\s\S]*?\}\}/g, '');

  // 4. Bullet-indented headings "- ## Foo" → "## Foo".
  out = out.replace(/^[\s\t]*-\s+(#{1,6}\s+)/gm, '\n$1');

  // 5. Dedent LogSeq's implicit root indent (tabs → 2sp, then subtract the
  //    minimum indent across non-blank / non-heading / non-blockquote lines).
  const tabReplaced = out.replace(/\t/g, '  ');
  const lines = tabReplaced.split('\n');
  let minIndent = Infinity;
  for (const line of lines) {
    if (line.trim() === '') continue;
    if (/^#{1,6}\s/.test(line)) continue;
    if (/^>/.test(line)) continue;
    const m = line.match(/^( *)\S/);
    if (!m) continue;
    if (m[1].length === 0) continue;
    minIndent = Math.min(minIndent, m[1].length);
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

  return out;
}

/**
 * Promote bare top-level section-label bullets (the PROMOTE page shape:
 * `- Decision` / `- Observation` / `- Sources`) to `###` headings and dedent
 * their nested block by one outline level, so a promoted page reads as
 * headings + prose rather than a two-deep bullet list. Conservative: only a
 * flush-left `- <ShortTitleCaseLabel>` with no inline markdown is promoted.
 */
export function deOutlineSections(body: string): string {
  const lines = body.split('\n');
  const out: string[] = [];
  const LABEL_RE = /^- ([A-Z][A-Za-z0-9 ,'&\/—–-]{0,38})\s*$/;
  let dedentNested = false;
  for (const line of lines) {
    const m = line.match(LABEL_RE);
    if (m && !/[\[\]\(\)!`#|]/.test(m[1])) {
      out.push('', `### ${m[1].trim()}`, '');
      dedentNested = true;
      continue;
    }
    if (dedentNested) {
      if (line.trim() === '') { out.push(line); continue; }
      if (/^ {2,}/.test(line)) {
        // dedent one outline level (2 spaces) and strip a leading child bullet
        out.push(line.replace(/^ {2}/, '').replace(/^- /, ''));
        continue;
      }
      dedentNested = false;
    }
    out.push(line);
  }
  return out.join('\n');
}

/** `![alt](../assets/X)` / `./assets/X` / `assets/X` → Obsidian embed `![[X]]`. */
export function rewriteAssetsToObsidian(body: string): string {
  return body.replace(
    /!\[[^\]]*]\(((?:(?:\.\.|\.)\/)*assets\/[^)\s]+)\)/g,
    (_m, ref) => `![[${basename(decodeURIComponent(ref))}]]`,
  );
}

/**
 * Preserve `[[Page]]` / `[[Page|Display]]`. When the target title is in
 * `titleMap` (a page in this projection whose sanitized name differs), rewrite
 * the link to the sanitized name so it resolves inside the vault. Out-of-slice
 * links are left native — Obsidian renders them as (greyed) unresolved links.
 */
export function rewriteWikilinksToObsidian(
  body: string,
  titleMap: Map<string, string>,
): string {
  return body.replace(
    /\[\[([^\[\]\|]+?)(?:\|([^\]]+))?\]\]/g,
    (_m, title: string, display?: string) => {
      const clean = decodeHtml(title.trim());
      const sanitized = titleMap.get(clean);
      const target = sanitized ?? sanitizeObsidianTitle(clean);
      return display ? `[[${target}|${display.trim()}]]` : `[[${target}]]`;
    },
  );
}

// ---------------------------------------------------------------------------
// Frontmatter + provenance
// ---------------------------------------------------------------------------

export interface Provenance {
  /** Relative LogSeq path, e.g. "pages/Foo.md". */
  source_ssot_logseq?: string;
  /** agent_kb session/thought id (from `source_session`). */
  source_thought_agent_kb?: string;
  /** External grounding URI, if the page carries one. */
  grounding_uri?: string;
}

function yamlStr(s: string): string {
  return JSON.stringify(s.replace(/[\[\]]/g, ''));
}

/** Clean Obsidian YAML frontmatter from LogSeq props + provenance. */
export function buildObsidianFrontmatter(
  title: string,
  props: Record<string, string>,
  prov: Provenance,
): string {
  const fm: string[] = ['---', `title: ${yamlStr(title)}`];
  if (props.type) fm.push(`type: ${yamlStr(props.type)}`);
  if (props.category) fm.push(`category: ${yamlStr(props.category)}`);
  if (props.created) fm.push(`created: ${yamlStr(props.created)}`);
  if (props['last-updated']) fm.push(`updated: ${yamlStr(props['last-updated'])}`);
  const tags = props.tags || props.pageTags;
  if (tags) fm.push(`tags: ${yamlStr(tags)}`);
  if (prov.grounding_uri) fm.push(`grounding_uri: ${yamlStr(prov.grounding_uri)}`);
  if (prov.source_ssot_logseq) fm.push(`source_ssot_logseq: ${yamlStr(prov.source_ssot_logseq)}`);
  if (prov.source_thought_agent_kb)
    fm.push(`source_thought_agent_kb: ${yamlStr(prov.source_thought_agent_kb)}`);
  fm.push('projected_from: "LogSeq (SSOT) via @kyber/kb-projection"');
  fm.push('---', '');
  return fm.join('\n');
}

/** A `> [!info]` Obsidian callout recording where this derived page came from. */
export function buildProvenanceCallout(prov: Provenance): string {
  const lines = ['> [!info] Provenance — derived view, do not edit here'];
  lines.push('> Source of truth is the LogSeq graph; this Obsidian page is a projection.');
  if (prov.source_ssot_logseq) lines.push(`> - LogSeq: \`${prov.source_ssot_logseq}\``);
  if (prov.source_thought_agent_kb)
    lines.push(`> - agent_kb thought/session: \`${prov.source_thought_agent_kb}\``);
  if (prov.grounding_uri) lines.push(`> - grounding: ${prov.grounding_uri}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Whole-page transform + vault emit
// ---------------------------------------------------------------------------

/** Transform one raw LogSeq page's content into an Obsidian page string. */
export function transformPageToObsidian(
  rawContent: string,
  title: string,
  titleMap: Map<string, string>,
  prov: Provenance,
): string {
  const { props, body } = parseProperties(rawContent);
  let out = cleanLogseqBody(body);
  out = rewriteAssetsToObsidian(out);
  out = rewriteWikilinksToObsidian(out, titleMap);
  out = deOutlineSections(out);
  out = out.replace(/\n{3,}/g, '\n\n').trim();

  const fm = buildObsidianFrontmatter(title, props, {
    ...prov,
    source_thought_agent_kb: prov.source_thought_agent_kb || props.source_session,
    grounding_uri: prov.grounding_uri || (props.grounding_uri ?? undefined),
  });
  const callout = buildProvenanceCallout({
    ...prov,
    source_thought_agent_kb: prov.source_thought_agent_kb || props.source_session,
    grounding_uri: prov.grounding_uri || (props.grounding_uri ?? undefined),
  });
  return `${fm}${callout}\n\n${out}\n`;
}

export interface ObsidianProjectionInput {
  /** LogSeq graph dir, e.g. ~/Logseq/MyGraph (contains pages/ + assets/). */
  graphDir: string;
  /** Target Obsidian vault dir. */
  vaultDir: string;
  /**
   * Explicit pages to project. If omitted/empty and `select` is given, the
   * pages are auto-selected as a relevance-scored N-hop subgraph from seeds.
   */
  pages?: Array<ManifestEntry & { group?: string }>;
  /** Auto-select the subgraph from seed titles instead of an explicit list. */
  select?: Omit<SelectOpts, 'graphDir'>;
  /** Emit graceful boundary stubs for out-of-slice links (default: off). */
  stubs?: boolean;
  /** Only stub boundary links referenced by ≥ this many slice pages. Default 2. */
  stubMinRefs?: number;
  /** Subfolder inside the vault to write pages into (default: root). */
  vaultSubfolder?: string;
  /** Emit a Map-of-Content index page. */
  moc?: { title: string; groupTitles?: Record<string, string> };
  /** Write files. Default false → dry-run (return the plan only). */
  apply?: boolean;
}

export interface ObsidianProjectionResult {
  vaultDir: string;
  applied: boolean;
  pages: Array<{ title: string; vaultFile: string; missing?: boolean }>;
  assets: { copied: string[]; missing: string[] };
  moc?: string;
  /** When auto-selected: the boundary links (out-of-slice) + stub count. */
  boundary?: BoundaryLink[];
  stubsWritten?: number;
}

/** Project a curated subgraph into an Obsidian vault. Dry-run unless apply. */
export function projectToObsidian(input: ObsidianProjectionInput): ObsidianProjectionResult {
  const graphPages = join(input.graphDir, 'pages');
  const outDir = input.vaultSubfolder
    ? join(input.vaultDir, input.vaultSubfolder)
    : input.vaultDir;
  const assetsDir = join(input.vaultDir, 'assets');

  // Resolve the page set: explicit list, or auto-select an N-hop subgraph.
  let boundary: BoundaryLink[] | undefined;
  let pages: Array<ManifestEntry & { group?: string }>;
  if (input.pages && input.pages.length > 0) {
    pages = input.pages;
  } else if (input.select) {
    const sel = selectSubgraph({ graphDir: input.graphDir, ...input.select });
    boundary = sel.boundary;
    pages = sel.pages.map((p) => ({ title: p.title, file: p.file, tier: 'projected', group: `hop-${p.hop}` }));
  } else {
    pages = [];
  }

  // titleMap: original title → sanitized (only when they differ).
  const titleMap = new Map<string, string>();
  for (const p of pages) {
    const s = sanitizeObsidianTitle(p.title);
    if (s !== p.title) titleMap.set(p.title, s);
  }

  const pagesOut: ObsidianProjectionResult['pages'] = [];
  const bodies: string[] = [];
  const perGroup: Record<string, string[]> = {};

  for (const entry of pages) {
    const src = resolveLogseqPath(entry, graphPages);
    const vaultFile = `${sanitizeObsidianTitle(entry.title)}.md`;
    if (!src) {
      pagesOut.push({ title: entry.title, vaultFile, missing: true });
      continue;
    }
    const raw = readFileSync(src, 'utf8');
    bodies.push(raw);
    const rendered = transformPageToObsidian(raw, entry.title, titleMap, {
      source_ssot_logseq: `pages/${basename(src)}`,
    });
    if (input.apply) {
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, vaultFile), rendered);
    }
    pagesOut.push({ title: entry.title, vaultFile });
    (perGroup[entry.group ?? 'default'] ||= []).push(sanitizeObsidianTitle(entry.title));
  }

  // Assets referenced by the projected bodies.
  const wanted = [...new Set(bodies.flatMap(extractReferencedAssets))].sort();
  const copied: string[] = [];
  const missing: string[] = [];
  for (const file of wanted) {
    const srcAsset = join(input.graphDir, 'assets', file);
    if (!existsSync(srcAsset)) { missing.push(file); continue; }
    if (input.apply) {
      mkdirSync(assetsDir, { recursive: true });
      copyFileSync(srcAsset, join(assetsDir, file));
    }
    copied.push(file);
  }

  // Map of Content.
  let mocText: string | undefined;
  if (input.moc) {
    const gt = input.moc.groupTitles ?? {};
    const md: string[] = [
      '---',
      `title: ${yamlStr(input.moc.title)}`,
      'type: "moc"',
      'projected_from: "LogSeq (SSOT) via @kyber/kb-projection"',
      '---',
      '',
      `# ${input.moc.title}`,
      '',
      'A curated projection of a LogSeq knowledge subgraph. Use the graph view to walk the connections.',
      '',
    ];
    for (const g of Object.keys(perGroup)) {
      if (gt[g]) md.push(`## ${gt[g]}`);
      else if (g !== 'default') md.push(`## ${g}`);
      for (const t of perGroup[g]) md.push(`- [[${t}]]`);
      md.push('');
    }
    mocText = md.join('\n');
    if (input.apply) {
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, `${sanitizeObsidianTitle(input.moc.title)}.md`), mocText);
    }
  }

  // Boundary stubs: graceful placeholders for out-of-slice links.
  let stubsWritten = 0;
  if (input.stubs && boundary) {
    const minRefs = input.stubMinRefs ?? 2;
    for (const b of boundary) {
      if (b.referencedBy.length < minRefs) continue; // skip one-off boundary mentions
      const name = sanitizeObsidianTitle(b.title);
      const refs = b.referencedBy.map((r) => `[[${sanitizeObsidianTitle(r)}]]`).join(', ');
      const note = b.exists
        ? 'This page exists in the LogSeq graph but is outside this projected slice — widen the slice to include it.'
        : 'No dedicated page exists for this concept in the graph yet.';
      const stub = [
        '---',
        `title: ${yamlStr(b.title)}`,
        'type: "stub"',
        'projected_from: "LogSeq (SSOT) via @kyber/kb-projection"',
        '---',
        '',
        '> [!note] Boundary stub — outside this projected slice',
        `> Referenced by ${refs || '(the slice)'}.`,
        `> ${note}`,
        '',
      ].join('\n');
      if (input.apply) {
        mkdirSync(outDir, { recursive: true });
        writeFileSync(join(outDir, `${name}.md`), stub);
      }
      stubsWritten++;
    }
  }

  return {
    vaultDir: input.vaultDir,
    applied: !!input.apply,
    pages: pagesOut,
    assets: { copied, missing },
    moc: mocText,
    boundary,
    stubsWritten,
  };
}
