#!/usr/bin/env bun
/**
 * kb-reconcile — reconcile a projected LogSeq page against a page file on disk,
 * preserving hand-edits (kb-projection-6ji.1).
 *
 * Desired state is produced by the REAL projection transform (logseqToAstro) from a
 * LogSeq source page, then reconciled region-by-region against the target file using
 * a persisted prior-hash sidecar. A hand-edit to a projected region is preserved, not
 * stomped.
 *
 * Usage:
 *   bun run bin/kb-reconcile.ts --source <logseq-page.md> --page <target.md>
 *                               [--manifest <kb-publish.manifest.json>]
 *                               [--sidecar <path>] [--plan] [--prune] [--json]
 *                               [--grounded <id,id>] [--faithfulness-min <n>]
 *     (--manifest resolves [[wikilinks]] to /kb/<slug>/ links; omit → unresolved spans)
 *     (--prune removes projection-owned sections the source dropped; default preserves)
 *     (--grounded / source `grounded-regions::` mark faithful areas; a hand-edit there is
 *      a grounded-drift alarm. --faithfulness-min runs the canonical kb_cli gate; a REFUSED
 *      gate exits 3 so CI can block outward projection.)
 *   bun run bin/kb-reconcile.ts --desired <projected.md> --page <target.md> ...
 *     (--desired supplies already-projected content directly, skipping transform)
 *   bun run bin/kb-reconcile.ts --all --manifest <manifest.json> --out-dir <dir>
 *                               [--graph <path>] [--plan] [--prune] [--json]
 *     (batch: project + reconcile every published entry into <out-dir>/<slug>.md)
 *
 * Exit codes: 0 ok · 2 usage error
 */
import { existsSync, readFileSync } from 'node:fs';
import { faithfulnessGate, parseGroundedRegions, projectSourcePage, reconcileManifest, reconcilePage, slugMapsFromManifest } from '../src/reconcile/reconcile-projection';

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--plan' || a === '--json' || a === '--prune' || a === '--all') out[a.slice(2)] = true;
    else if (a.startsWith('--')) out[a.slice(2)] = argv[++i];
  }
  return out;
}

function runBatch(args: Record<string, string | boolean>): number {
  const manifest = args.manifest as string | undefined;
  const outDir = args['out-dir'] as string | undefined;
  if (!manifest || !outDir) { process.stderr.write('usage: kb-reconcile --all --manifest <manifest.json> --out-dir <dir> [--graph <path>] [--plan] [--prune] [--json]\n'); return 2; }
  if (!existsSync(manifest)) { process.stderr.write(`not found: ${manifest}\n`); return 2; }
  const res = reconcileManifest({
    manifestPath: manifest,
    outDir,
    graphPath: args.graph as string | undefined,
    dryRun: Boolean(args.plan),
    prune: Boolean(args.prune),
  });
  if (args.json) { console.log(JSON.stringify(res, null, 2)); return res.entries.some((e) => e.groundedDrift?.length) ? 0 : 0; }

  console.log(`# kb-reconcile --all ${args.plan ? 'PLAN (dry-run)' : ''} → ${res.outDir}  (${res.entries.length} entries)`);
  let errs = 0;
  let drift = 0;
  for (const e of res.entries) {
    if (e.error) { console.log(`  ✗ ${e.slug.padEnd(32)} ${e.error}`); errs++; continue; }
    const bits = [
      e.firstRun ? 'first' : '',
      e.applied?.length ? `applied=${e.applied.length}` : '',
      e.created?.length ? `created=${e.created.length}` : '',
      e.deleted?.length ? `deleted=${e.deleted.length}` : '',
      e.preserved?.length ? `preserved=${e.preserved.length}` : '',
      e.groundedDrift?.length ? `grounded-drift=${e.groundedDrift.length}` : '',
    ].filter(Boolean).join(' · ') || 'unchanged';
    if (e.groundedDrift?.length) drift++;
    console.log(`  ${e.groundedDrift?.length ? '⚠' : '·'} ${e.slug.padEnd(32)} ${bits}`);
  }
  console.log(`\n${res.entries.length - errs} ok · ${errs} error · ${drift} with grounded-drift${args.plan ? '  (no writes)' : ''}`);
  return errs ? 1 : 0;
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  if (args.all) return runBatch(args);
  const page = args.page as string;
  const source = args.source as string;
  const desiredFile = args.desired as string;
  if (!page || (!source && !desiredFile)) {
    process.stderr.write('usage: kb-reconcile --page <target.md> (--source <logseq.md> | --desired <projected.md>) [--manifest <manifest.json>] [--sidecar <path>] [--plan] [--json]\n');
    return 2;
  }
  const sidecar = (args.sidecar as string) ?? `${page}.reconcile.json`;

  // Grounded areas: --grounded overrides; else read grounded-regions:: from the source.
  let groundedRegions = new Set<string>();
  if (args.grounded) groundedRegions = new Set(String(args.grounded).split(',').map((s) => s.trim()).filter(Boolean));

  let desiredContent: string;
  if (desiredFile) {
    if (!existsSync(desiredFile)) { process.stderr.write(`not found: ${desiredFile}\n`); return 2; }
    desiredContent = readFileSync(desiredFile, 'utf8');
  } else {
    if (!existsSync(source)) { process.stderr.write(`not found: ${source}\n`); return 2; }
    const manifest = args.manifest as string | undefined;
    if (manifest && !existsSync(manifest)) { process.stderr.write(`not found: ${manifest}\n`); return 2; }
    const maps = manifest ? slugMapsFromManifest(manifest) : undefined;
    const raw = readFileSync(source, 'utf8');
    if (!args.grounded) groundedRegions = parseGroundedRegions(raw);
    desiredContent = projectSourcePage(raw, maps?.publishedSlugs, maps?.titleToSlug);
  }

  const res = reconcilePage({ desiredContent, pageFile: page, sidecarFile: sidecar, dryRun: Boolean(args.plan), prune: Boolean(args.prune), groundedRegions });

  // GATE half: if any grounded area drifted and a faithfulness minimum is set, run the
  // canonical kb_cli gate and let its verdict block the outward projection.
  const minRaw = args['faithfulness-min'] as string | undefined;
  const min = minRaw !== undefined ? Number(minRaw) : undefined;
  let gate: ReturnType<typeof faithfulnessGate> | undefined;
  if (res.groundedDrift.length && min !== undefined && !Number.isNaN(min)) {
    gate = faithfulnessGate(page, min);
  }

  if (args.json) { console.log(JSON.stringify({ ...res, gate }, null, 2)); return gate?.status === 'refused' ? 3 : 0; }

  const order: Record<string, number> = { 'grounded-drift': 0, conflict: 1, drifted: 2, delete: 3, orphan: 4, create: 5, update: 6, unchanged: 7 };
  const mode = args.plan ? 'PLAN (dry-run)' : res.firstRun ? 'FIRST PROJECTION' : 'RECONCILE';
  console.log(`# kb-reconcile ${mode} — ${page}`);
  for (const it of [...res.items].sort((a, b) => (order[a.verdict] ?? 9) - (order[b.verdict] ?? 9))) {
    console.log(`  ${it.verdict.toUpperCase().padEnd(14)} ${it.id.padEnd(28)} ${it.reason}`);
  }
  const tally = (label: string, xs: string[]) => (xs.length ? `${label}=${xs.length}` : '');
  console.log(
    '\n' +
      [tally('applied', res.applied), tally('created', res.created), tally('deleted', res.deleted), tally('preserved', res.preserved), tally('grounded-drift', res.groundedDrift), tally('skipped', res.skipped)]
        .filter(Boolean)
        .join(' · ') +
      (args.plan ? '  (no writes)' : !args.prune && res.items.some((i) => i.verdict === 'delete') ? '  (delete candidates preserved; pass --prune to remove)' : ''),
  );
  if (res.groundedDrift.length) {
    console.log(`\n⚠ GROUNDED-DRIFT: ${res.groundedDrift.join(', ')} — grounded area(s) hand-edited; faithfulness at risk.`);
    if (gate) {
      if (gate.status === 'refused') console.log(`  ✗ faithfulness gate REFUSED: ${gate.reason} — do NOT project outward until re-grounded.`);
      else if (gate.status === 'pass') console.log(`  ✓ faithfulness gate passed${gate.applicable ? '' : ' (n/a — page carries no citation-recall)'}.`);
      else console.log(`  · gate ${gate.status}: ${gate.reason} (flag stands as advisory).`);
    } else if (min === undefined) {
      console.log('  (pass --faithfulness-min <n> to enforce the canonical kb_cli gate.)');
    }
  }
  return gate?.status === 'refused' ? 3 : 0;
}

if (import.meta.main) process.exit(main());
