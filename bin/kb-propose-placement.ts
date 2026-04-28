#!/usr/bin/env bun
/**
 * CLI: propose section placements for candidate pages.
 *
 * Usage:
 *   bun run cli-propose-placement.ts <manifest.json> --graph <path>
 *     [--candidate <title>]... [--top-n 3] [--json]
 *
 * If no --candidate flags are supplied, the CLI runs cli-audit-drift
 * internally and uses its candidate-page findings as input. This makes
 * the common workflow one shot:
 *
 *   audit drift → propose placements → user picks → patch → preview → apply
 *
 * Exit codes:
 *   0 — proposals generated (some may be empty if no signal)
 *   1 — input manifest fails schema validation
 *   2 — usage error
 */

import { existsSync, readFileSync } from 'node:fs';
import { parseManifest } from '../src/manifest/validate';
import { auditDrift } from '../src/manifest/audit-drift';
import { readPageMetadataBulk, readPageMetadata } from '../src/manifest/logseqMeta';
import { proposePlacement, proposalToMarkdown } from '../src/manifest/propose-placement';
import type { PageMetadata } from '../src/manifest/logseqMeta';

interface CliArgs {
  manifestPath: string;
  graph?: string;
  candidates: string[];
  topN: number;
  json: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: Partial<CliArgs> = { candidates: [], topN: 3, json: false };
  let positional = '';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--graph') out.graph = argv[++i];
    else if (a === '--candidate') (out.candidates as string[]).push(argv[++i]);
    else if (a === '--top-n') out.topN = parseInt(argv[++i], 10);
    else if (a === '--json') out.json = true;
    else if (a === '-h' || a === '--help') {
      process.stderr.write(
        'Usage: cli-propose-placement.ts <manifest.json> --graph <path> [--candidate <title>]... [--top-n 3] [--json]\n'
      );
      process.exit(2);
    } else if (!positional && !a.startsWith('-')) {
      positional = a;
    }
  }
  if (!positional) {
    process.stderr.write('Missing required positional <manifest.json>\n');
    process.exit(2);
  }
  return {
    manifestPath: positional,
    graph: out.graph,
    candidates: out.candidates ?? [],
    topN: out.topN ?? 3,
    json: out.json ?? false,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!existsSync(args.manifestPath)) {
    process.stderr.write(`Manifest file not found: ${args.manifestPath}\n`);
    process.exit(2);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(args.manifestPath, 'utf8'));
  } catch (e) {
    process.stderr.write(`Failed to parse JSON: ${(e as Error).message}\n`);
    process.exit(2);
  }

  const parsed = parseManifest(raw);
  if (!parsed.manifest) {
    process.stderr.write('Manifest fails schema validation; cannot propose placements.\n');
    for (const e of parsed.errors) process.stderr.write(`  ${e.path}: ${e.message}\n`);
    process.exit(1);
  }

  const graphPath = args.graph ?? parsed.manifest.graphPath;

  let candidates = args.candidates;
  if (candidates.length === 0) {
    process.stderr.write('No --candidate flags supplied; running audit-drift to find candidates...\n');
    const drift = auditDrift(parsed.manifest, { hops: 1 }, graphPath);
    candidates = drift.findings
      .filter((f) => f.kind === 'candidate-page' && f.ref.title && !f.id.includes('__truncation_marker__'))
      .map((f) => f.ref.title as string);
    process.stderr.write(`Found ${candidates.length} drift candidates to evaluate.\n`);
    if (candidates.length === 0) {
      process.stderr.write('No candidates to evaluate; exiting clean.\n');
      process.exit(0);
    }
  }

  // Load metadata for manifest entries (the section index source) AND for
  // the candidates themselves.
  const manifestEntriesMeta = readPageMetadataBulk(graphPath, parsed.manifest.entries);
  const candidateMetaMap = new Map<string, PageMetadata>(manifestEntriesMeta);
  for (const c of candidates) {
    if (candidateMetaMap.has(c)) continue;
    const m = readPageMetadata(graphPath, c);
    if (m) candidateMetaMap.set(c, m);
  }

  const proposals = proposePlacement(candidates, parsed.manifest, candidateMetaMap, {
    topN: args.topN,
  });

  if (args.json) {
    process.stdout.write(JSON.stringify(proposals, null, 2) + '\n');
  } else {
    process.stdout.write(proposalToMarkdown(proposals) + '\n');
  }
  process.exit(0);
}

if (import.meta.main) {
  main();
}
