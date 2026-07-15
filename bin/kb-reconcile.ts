#!/usr/bin/env bun
/**
 * kb-reconcile — region-level projection reconciler (kb-projection-6ji.*).
 *
 * Source-wins: a projected page's regions are regenerated from a fresh projection when
 * they drift or their source changes; the page's NON-projected regions are never touched.
 * A grounded source (carries `citation-recall::`) is run through the canonical kb_cli
 * faithfulness-gate when `--faithfulness-min` is set; a refused page is excluded (exit 3).
 *
 * Usage:
 *   bun run bin/kb-reconcile.ts --source <logseq-page.md> --page <target.md>
 *                               [--manifest <manifest.json>] [--sidecar <path>]
 *                               [--faithfulness-min <n>] [--plan] [--json]
 *   bun run bin/kb-reconcile.ts --desired <projected.md> --page <target.md> ...
 *   bun run bin/kb-reconcile.ts --all --manifest <manifest.json> --out-dir <dir>
 *                               [--graph <path>] [--faithfulness-min <n>] [--plan] [--json]
 *
 * Exit codes: 0 ok · 2 usage · 3 grounding gate refused
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import {
  faithfulnessGate,
  projectSourcePage,
  reconcileManifest,
  reconcilePage,
  slugMapsFromManifest,
  sourceIsGrounded,
  stampProjected,
} from '../src/reconcile/reconcile-projection';

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--plan' || a === '--json' || a === '--all') out[a.slice(2)] = true;
    else if (a.startsWith('--')) out[a.slice(2)] = argv[++i];
  }
  return out;
}

function runBatch(args: Record<string, string | boolean>): number {
  const manifest = args.manifest as string | undefined;
  const outDir = args['out-dir'] as string | undefined;
  if (!manifest || !outDir) { process.stderr.write('usage: kb-reconcile --all --manifest <manifest.json> --out-dir <dir> [--graph <path>] [--faithfulness-min <n>] [--plan] [--json]\n'); return 2; }
  if (!existsSync(manifest)) { process.stderr.write(`not found: ${manifest}\n`); return 2; }
  const minRaw = args['faithfulness-min'] as string | undefined;
  const res = reconcileManifest({
    manifestPath: manifest,
    outDir,
    graphPath: args.graph as string | undefined,
    dryRun: Boolean(args.plan),
    faithfulnessMin: minRaw !== undefined ? Number(minRaw) : undefined,
  });
  if (args.json) { console.log(JSON.stringify(res, null, 2)); return res.entries.some((e) => e.excluded) ? 3 : 0; }

  console.log(`# kb-reconcile --all ${args.plan ? 'PLAN (dry-run)' : ''} → ${res.outDir}  (${res.entries.length} entries)`);
  let errs = 0; let excluded = 0; let drift = 0;
  for (const e of res.entries) {
    if (e.error) { console.log(`  ✗ ${e.slug.padEnd(32)} ${e.error}`); errs++; continue; }
    if (e.excluded) { console.log(`  ⛔ ${e.slug.padEnd(32)} grounding gate refused: ${e.gate && 'reason' in e.gate ? e.gate.reason : ''}`); excluded++; continue; }
    const bits = [
      e.firstRun ? 'first' : '',
      e.created?.length ? `created=${e.created.length}` : '',
      e.regenerated?.length ? `regenerated=${e.regenerated.length}` : '',
      e.removed?.length ? `removed=${e.removed.length}` : '',
      e.reordered?.length ? `reordered=${e.reordered.length}` : '',
      e.handEdited?.length ? `hand-edited=${e.handEdited.length}` : '',
      e.grounded ? 'grounded' : '',
    ].filter(Boolean).join(' · ') || 'unchanged';
    if (e.handEdited?.length) drift++;
    console.log(`  ${e.handEdited?.length ? '⚠' : '·'} ${e.slug.padEnd(32)} ${bits}`);
  }
  console.log(`\n${res.entries.length - errs - excluded} ok · ${errs} error · ${excluded} gate-excluded · ${drift} with off-source hand-edits${args.plan ? '  (no writes)' : ''}`);
  return excluded ? 3 : errs ? 1 : 0;
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  if (args.all) return runBatch(args);

  const page = args.page as string;
  const source = args.source as string;
  const desiredFile = args.desired as string;
  if (!page || (!source && !desiredFile)) {
    process.stderr.write('usage: kb-reconcile --page <target.md> (--source <logseq.md> | --desired <projected.md>) [--manifest <m>] [--sidecar <p>] [--faithfulness-min <n>] [--plan] [--json]\n');
    return 2;
  }
  const sidecar = (args.sidecar as string) ?? `${page}.reconcile.json`;
  const minRaw = args['faithfulness-min'] as string | undefined;

  let desiredContent: string;
  let grounded = false;
  if (desiredFile) {
    if (!existsSync(desiredFile)) { process.stderr.write(`not found: ${desiredFile}\n`); return 2; }
    desiredContent = readFileSync(desiredFile, 'utf8');
  } else {
    if (!existsSync(source)) { process.stderr.write(`not found: ${source}\n`); return 2; }
    const manifest = args.manifest as string | undefined;
    if (manifest && !existsSync(manifest)) { process.stderr.write(`not found: ${manifest}\n`); return 2; }
    const maps = manifest ? slugMapsFromManifest(manifest) : undefined;
    const raw = readFileSync(source, 'utf8');
    grounded = sourceIsGrounded(raw);
    // Grounding gate on the source before projecting outward.
    if (grounded && minRaw !== undefined) {
      const gate = faithfulnessGate(source, Number(minRaw));
      if (gate.status === 'refused') { process.stderr.write(`grounding gate REFUSED: ${gate.reason} — excluded from outward projection.\n`); return 3; }
    }
    const title = basename(source).replace(/\.mdx?$/, '');
    desiredContent = stampProjected(projectSourcePage(raw, maps?.publishedSlugs, maps?.titleToSlug), title);
  }

  const res = reconcilePage({ desiredContent, pageFile: page, sidecarFile: sidecar, dryRun: Boolean(args.plan) });
  if (args.json) { console.log(JSON.stringify({ ...res, grounded }, null, 2)); return 0; }

  const order: Record<string, number> = { remove: 0, regenerate: 1, create: 2, unchanged: 3 };
  const mode = args.plan ? 'PLAN (dry-run)' : res.firstRun ? 'FIRST PROJECTION' : 'RECONCILE';
  console.log(`# kb-reconcile ${mode} — ${page}${grounded ? '  [grounded]' : ''}`);
  for (const it of [...res.items].sort((a, b) => (order[a.verdict] ?? 9) - (order[b.verdict] ?? 9))) {
    console.log(`  ${it.verdict.toUpperCase().padEnd(11)} ${it.id.padEnd(28)} ${it.reason}`);
  }
  const tally = (label: string, xs: string[]) => (xs.length ? `${label}=${xs.length}` : '');
  console.log('\n' + [tally('created', res.created), tally('regenerated', res.regenerated), tally('removed', res.removed), tally('reordered', res.reordered), tally('unchanged', res.unchanged)].filter(Boolean).join(' · ') + (args.plan ? '  (no writes)' : ''));
  if (res.handEdited.length) console.log(`\n⚠ OFF-SOURCE HAND-EDITS regenerated (source-wins): ${res.handEdited.join(', ')} — fix at source (WriteBackBlock/LogSeq), not on the projected page.`);
  return 0;
}

if (import.meta.main) process.exit(main());
