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
 *                               [--sidecar <path>] [--plan] [--json]
 *   bun run bin/kb-reconcile.ts --desired <projected.md> --page <target.md> ...
 *     (--desired supplies already-projected content directly, skipping transform)
 *
 * Exit codes: 0 ok · 2 usage error
 */
import { existsSync, readFileSync } from 'node:fs';
import { projectSourcePage, reconcilePage } from '../src/reconcile/reconcile-projection';

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--plan' || a === '--json') out[a.slice(2)] = true;
    else if (a.startsWith('--')) out[a.slice(2)] = argv[++i];
  }
  return out;
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  const page = args.page as string;
  const source = args.source as string;
  const desiredFile = args.desired as string;
  if (!page || (!source && !desiredFile)) {
    process.stderr.write('usage: kb-reconcile --page <target.md> (--source <logseq.md> | --desired <projected.md>) [--sidecar <path>] [--plan] [--json]\n');
    return 2;
  }
  const sidecar = (args.sidecar as string) ?? `${page}.reconcile.json`;

  let desiredContent: string;
  if (desiredFile) {
    if (!existsSync(desiredFile)) { process.stderr.write(`not found: ${desiredFile}\n`); return 2; }
    desiredContent = readFileSync(desiredFile, 'utf8');
  } else {
    if (!existsSync(source)) { process.stderr.write(`not found: ${source}\n`); return 2; }
    desiredContent = projectSourcePage(readFileSync(source, 'utf8'));
  }

  const res = reconcilePage({ desiredContent, pageFile: page, sidecarFile: sidecar, dryRun: Boolean(args.plan) });

  if (args.json) { console.log(JSON.stringify(res, null, 2)); return 0; }

  const order: Record<string, number> = { conflict: 0, drifted: 1, orphan: 2, create: 3, update: 4, unchanged: 5 };
  const mode = args.plan ? 'PLAN (dry-run)' : res.firstRun ? 'FIRST PROJECTION' : 'RECONCILE';
  console.log(`# kb-reconcile ${mode} — ${page}`);
  for (const it of [...res.items].sort((a, b) => (order[a.verdict] ?? 9) - (order[b.verdict] ?? 9))) {
    console.log(`  ${it.verdict.toUpperCase().padEnd(9)} ${it.id.padEnd(28)} ${it.reason}`);
  }
  const tally = (label: string, xs: string[]) => (xs.length ? `${label}=${xs.length}` : '');
  console.log(
    '\n' +
      [tally('applied', res.applied), tally('created', res.created), tally('preserved', res.preserved), tally('skipped', res.skipped)]
        .filter(Boolean)
        .join(' · ') +
      (args.plan ? '  (no writes)' : ''),
  );
  return 0;
}

if (import.meta.main) process.exit(main());
