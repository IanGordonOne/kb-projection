#!/usr/bin/env bun
/**
 * Build a KB-subgraph manifest from a host-site source dir + LogSeq graph.
 *
 * Generalized from the 2026-04-18 777westwood implementation.
 *
 * Usage:
 *   bun run build-manifest.ts \
 *     --source-dir /path/to/astro/src/pages \
 *     --graph      /path/to/logseq/graph \
 *     --hops       1 \
 *     --out-json   /tmp/kb-manifest.json \
 *     --out-md     /tmp/kb-manifest.md
 *
 * Produces:
 *   - JSON manifest (machine-readable): per-page title, slug, tier, backlinks, excerpt, privacy flag
 *   - Markdown manifest (human review): table grouped by tier, with privacy-flagged section at top
 */

import { readFileSync, existsSync, statSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface Args {
  sourceDir: string;
  graph: string;
  hops: number;
  outJson: string;
  outMd: string;
  verbose: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Partial<Args> = { hops: 1, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--source-dir') args.sourceDir = argv[++i];
    else if (a === '--graph') args.graph = argv[++i];
    else if (a === '--hops') args.hops = parseInt(argv[++i], 10);
    else if (a === '--out-json') args.outJson = argv[++i];
    else if (a === '--out-md') args.outMd = argv[++i];
    else if (a === '-v' || a === '--verbose') args.verbose = true;
    else if (a === '-h' || a === '--help') {
      process.stderr.write('See top-of-file docstring. Required: --source-dir, --graph.\n');
      process.exit(2);
    }
  }
  if (!args.sourceDir || !args.graph) {
    throw new Error('--source-dir and --graph are required');
  }
  return {
    sourceDir: args.sourceDir,
    graph: args.graph,
    hops: args.hops ?? 1,
    outJson: args.outJson ?? '/tmp/kb-manifest.json',
    outMd: args.outMd ?? '/tmp/kb-manifest.md',
    verbose: args.verbose ?? false,
  };
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

function extractWikilinks(content: string): Set<string> {
  const found = new Set<string>();
  let m: RegExpExecArray | null;
  WIKILINK_RE.lastIndex = 0;
  while ((m = WIKILINK_RE.exec(content)) !== null) {
    const title = decodeHtml(m[1].trim());
    if (title.length > 0 && title.length < 200) found.add(title);
  }
  return found;
}

function resolveToFile(graph: string, title: string): string | null {
  const candidates = [
    title,
    title.replace(/\//g, '___'),
    title.replace(/:/g, '%3A'),
    title.replace(/\?/g, '%3F'),
    title.replace(/"/g, '%22'),
  ];
  for (const c of candidates) {
    const p = join(graph, 'pages', c + '.md');
    if (existsSync(p)) return p;
  }
  return null;
}

function scanSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...scanSourceFiles(full));
    else if (/\.(astro|html|md|mdx|jsx?|tsx?)$/i.test(entry.name)) files.push(full);
  }
  return files;
}

function slugify(title: string): string {
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

function extractProperty(content: string, key: string): string | null {
  const re = new RegExp(`^${key}::\\s*(.+)$`, 'm');
  const m = content.match(re);
  return m ? m[1].trim() : null;
}

function extractExcerpt(content: string): string {
  const lines = content.split('\n');
  const bodyLines: string[] = [];
  for (const line of lines) {
    if (/^[a-z0-9-]+::\s/i.test(line)) continue;
    const stripped = line.replace(/^\s*(?:-\s+|#+\s+)/, '').trim();
    if (stripped.length > 0) bodyLines.push(stripped);
    if (bodyLines.join(' ').length > 300) break;
  }
  return bodyLines.join(' ').slice(0, 220).replace(/\s+/g, ' ');
}

// Keyword heuristic — NOISY. Use only to FLAG for review, never to auto-exclude.
const PRIVACY_KEYWORDS = [
  'firearm', 'gun', 'weapon', 'ammo', 'ammunition',
  'password', 'credential', 'ssn', 'social security',
  'attorney', 'legal strategy',
];

function privacyFlag(title: string, content: string): string | null {
  const hay = (title + ' ' + content.slice(0, 500)).toLowerCase();
  for (const kw of PRIVACY_KEYWORDS) if (hay.includes(kw)) return kw;
  return null;
}

interface ManifestEntry {
  title: string;
  slug: string;
  file: string;
  size: number;
  tier: 'seed' | '1-hop' | '2-hop' | 'n-hop';
  backlinks: string[];
  category: string | null;
  type: string | null;
  project: string | null;
  excerpt: string;
  privacyFlag: string | null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const graphPages = join(args.graph, 'pages');
  if (!existsSync(graphPages)) throw new Error(`Graph pages dir not found: ${graphPages}`);

  // Phase 1 — seed extraction
  const seedTitles = new Set<string>();
  const sourceFiles = scanSourceFiles(args.sourceDir);
  for (const f of sourceFiles) {
    for (const title of extractWikilinks(readFileSync(f, 'utf8'))) seedTitles.add(title);
  }
  if (args.verbose) console.error(`[seed] ${seedTitles.size} titles in ${sourceFiles.length} source files`);

  // Phase 2 — resolve + N-hop expansion
  const resolved = new Map<string, { path: string; tier: ManifestEntry['tier'] }>();
  const unresolved = new Set<string>();

  for (const title of seedTitles) {
    const path = resolveToFile(args.graph, title);
    if (path) resolved.set(title, { path, tier: 'seed' });
    else unresolved.add(title);
  }

  // N-hop: BFS
  let frontier = new Set(seedTitles);
  for (let hop = 1; hop <= args.hops; hop++) {
    const newTitles = new Set<string>();
    for (const title of frontier) {
      const entry = resolved.get(title);
      if (!entry) continue;
      const content = readFileSync(entry.path, 'utf8');
      for (const linked of extractWikilinks(content)) {
        if (!resolved.has(linked) && !newTitles.has(linked)) newTitles.add(linked);
      }
    }
    const hopTier = hop === 1 ? '1-hop' : hop === 2 ? '2-hop' : 'n-hop';
    for (const t of newTitles) {
      const path = resolveToFile(args.graph, t);
      if (path) resolved.set(t, { path, tier: hopTier as ManifestEntry['tier'] });
      else unresolved.add(t);
    }
    if (args.verbose) console.error(`[hop-${hop}] +${newTitles.size} titles`);
    frontier = newTitles;
  }

  // Phase 3 — build manifest entries
  const manifest: ManifestEntry[] = [];
  const seedSet = new Set(Array.from(resolved.entries()).filter(([, v]) => v.tier === 'seed').map(([k]) => k));
  for (const [title, { path, tier }] of resolved) {
    const content = readFileSync(path, 'utf8');
    const backlinks: string[] = [];
    if (tier !== 'seed') {
      for (const seedTitle of seedSet) {
        const seedPath = resolved.get(seedTitle)?.path;
        if (!seedPath) continue;
        if (extractWikilinks(readFileSync(seedPath, 'utf8')).has(title)) backlinks.push(seedTitle);
      }
    }
    manifest.push({
      title,
      slug: slugify(title),
      file: path.replace(graphPages + '/', ''),
      size: statSync(path).size,
      tier,
      backlinks,
      category: extractProperty(content, 'category'),
      type: extractProperty(content, 'type'),
      project: extractProperty(content, 'project'),
      excerpt: extractExcerpt(content),
      privacyFlag: privacyFlag(title, content),
    });
  }

  manifest.sort((a, b) => {
    const tierOrder = { seed: 0, '1-hop': 1, '2-hop': 2, 'n-hop': 3 } as const;
    if (a.tier !== b.tier) return tierOrder[a.tier] - tierOrder[b.tier];
    if ((a.privacyFlag != null) !== (b.privacyFlag != null)) return a.privacyFlag ? -1 : 1;
    return a.title.localeCompare(b.title);
  });

  // Phase 4 — write outputs
  writeFileSync(args.outJson, JSON.stringify(manifest, null, 2));

  const flagged = manifest.filter(m => m.privacyFlag !== null);
  const md: string[] = [];
  md.push(`# KB Sync Manifest — Review`);
  md.push(`Generated: ${new Date().toISOString()}`);
  md.push(`Source: ${args.sourceDir}`);
  md.push(`Graph: ${args.graph}`);
  md.push(`Scope: **${args.hops}-hop** (seed + ${args.hops} hops)`);
  md.push(`Total candidate pages: **${manifest.length}**`);
  md.push(`Privacy-flagged for review: **${flagged.length}** (keyword heuristic — NOISY, use human judgment)`);
  md.push(`Unresolved wikilinks (won't sync): ${unresolved.size}`);
  md.push('');

  if (flagged.length > 0) {
    md.push('## ⚠️ Privacy-flagged — human review required');
    md.push('| Tier | Title | Flag | Size |');
    md.push('|------|-------|------|------|');
    for (const e of flagged) md.push(`| ${e.tier} | ${e.title} | ${e.privacyFlag} | ${(e.size/1024).toFixed(1)}KB |`);
    md.push('');
  }

  const tiers: ManifestEntry['tier'][] = ['seed', '1-hop', '2-hop', 'n-hop'];
  for (const t of tiers) {
    const group = manifest.filter(m => m.tier === t && !m.privacyFlag);
    if (group.length === 0) continue;
    md.push(`## ${t} pages (${group.length})`);
    md.push('| # | Title | Category | Size | Backlinks |');
    md.push('|---|-------|----------|------|-----------|');
    let i = 1;
    for (const e of group) {
      const bl = e.backlinks.length > 3 ? e.backlinks.slice(0, 3).join(' · ') + ` (+${e.backlinks.length - 3})` : e.backlinks.join(' · ');
      md.push(`| ${i++} | ${e.title} | ${e.category ?? '—'} | ${(e.size/1024).toFixed(1)}KB | ${bl} |`);
    }
    md.push('');
  }

  if (unresolved.size > 0) {
    md.push('## Unresolved wikilinks (render as plain text)');
    for (const t of [...unresolved].sort()) md.push(`- ${t}`);
  }

  writeFileSync(args.outMd, md.join('\n'));
  console.error(`[manifest] ${manifest.length} pages → ${args.outJson} + ${args.outMd}`);
}

main().catch(e => { console.error(e); process.exit(1); });
