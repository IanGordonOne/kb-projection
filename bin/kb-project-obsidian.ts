#!/usr/bin/env bun
/**
 * kb-project-obsidian — one-command LogSeq → Obsidian projection (bd kb-projection-0ci).
 *
 * Dry-run by DEFAULT (prints the plan). Pass --apply to write the vault.
 *
 * Usage:
 *   bun bin/kb-project-obsidian.ts \
 *     --graph ~/Logseq/MyGraph \
 *     --vault ~/Obsidian/SER-Architecture \
 *     --pages ./pages.json \        # [{ "title": "...", "file"?: "...", "group"?: "..." }]
 *     [--moc "SER Architecture — Map of Content"] \
 *     [--subfolder "03 Concepts"] \
 *     [--apply]
 */
import { readFileSync } from 'node:fs';
import { projectToObsidian, type ObsidianProjectionInput } from '../src/targets/obsidian';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(`--${name}`);
const expand = (p: string) => p.replace(/^~(?=$|\/)/, process.env.HOME ?? '~');

const graphDir = expand(arg('graph') ?? `${process.env.HOME}/Logseq/MyGraph`);
const vaultDir = arg('vault');
const pagesFile = arg('pages');
if (!vaultDir || !pagesFile) {
  console.error('error: --vault <dir> and --pages <json> are required');
  process.exit(2);
}
const pages = JSON.parse(readFileSync(expand(pagesFile), 'utf8')).map(
  (p: { title: string; file?: string; group?: string; tier?: string }) => ({ tier: p.tier ?? 'projected', ...p }),
);

const input: ObsidianProjectionInput = {
  graphDir,
  vaultDir: expand(vaultDir),
  pages,
  vaultSubfolder: arg('subfolder'),
  moc: arg('moc') ? { title: arg('moc')! } : undefined,
  apply: has('apply'),
};

const r = projectToObsidian(input);

const missing = r.pages.filter((p) => p.missing);
console.log(`${r.applied ? 'WROTE' : 'DRY-RUN (pass --apply to write)'} → ${r.vaultDir}`);
console.log(`  pages: ${r.pages.length - missing.length}/${r.pages.length}${missing.length ? ` (MISSING: ${missing.map((m) => m.title).join(', ')})` : ''}`);
console.log(`  assets: ${r.assets.copied.length} copied${r.assets.missing.length ? `, ${r.assets.missing.length} missing` : ''}`);
if (r.moc) console.log(`  + MOC`);
if (!r.applied) console.log(`  (nothing written — re-run with --apply)`);
