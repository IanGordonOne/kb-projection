#!/usr/bin/env bun
/**
 * CLI: audit drift between a publish manifest and a LogSeq graph.
 *
 * Usage:
 *   bun run cli-audit-drift.ts <manifest.json> [--graph <path>] [--hops <n>]
 *                              [--max-candidates <n>] [--no-candidates] [--json]
 *
 * Exit codes:
 *   0 — no findings, or only info-level findings
 *   1 — at least one warn-level finding
 *   2 — at least one error-level finding (or usage error)
 */

import { existsSync, readFileSync } from 'node:fs';
import { auditDrift } from '../src/manifest/audit-drift';
import { parseManifest } from '../src/manifest/validate';
import type { DriftReport } from '../src/manifest/schema';

interface CliArgs {
  manifestPath: string;
  graph?: string;
  hops: number;
  maxCandidates: number;
  detectCandidates: boolean;
  json: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: Partial<CliArgs> = {
    hops: 1,
    maxCandidates: 25,
    detectCandidates: true,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--graph') out.graph = argv[++i];
    else if (a === '--hops') out.hops = parseInt(argv[++i], 10);
    else if (a === '--max-candidates') out.maxCandidates = parseInt(argv[++i], 10);
    else if (a === '--no-candidates') out.detectCandidates = false;
    else if (a === '--json') out.json = true;
    else if (a === '-h' || a === '--help') {
      process.stderr.write(
        'Usage: cli-audit-drift.ts <manifest.json> [--graph <path>] [--hops <n>] [--max-candidates <n>] [--no-candidates] [--json]\n'
      );
      process.exit(2);
    } else if (!out.manifestPath && !a.startsWith('-')) {
      out.manifestPath = a;
    }
  }
  if (!out.manifestPath) {
    process.stderr.write('Missing required positional <manifest.json>\n');
    process.exit(2);
  }
  return {
    manifestPath: out.manifestPath,
    graph: out.graph,
    hops: out.hops ?? 1,
    maxCandidates: out.maxCandidates ?? 25,
    detectCandidates: out.detectCandidates ?? true,
    json: out.json ?? false,
  };
}

function formatHuman(report: DriftReport, manifestPath: string): string {
  const lines: string[] = [];
  lines.push(`Manifest:    ${manifestPath}`);
  lines.push(`Graph:       ${report.graphPath}`);
  lines.push(`Generated:   ${report.generatedAt}`);
  lines.push(
    `Findings:    ${report.counts.error} errors, ${report.counts.warn} warnings, ${report.counts.info} info`
  );
  if (report.findings.length === 0) {
    lines.push('');
    lines.push('No drift detected.');
    return lines.join('\n');
  }
  lines.push('');
  lines.push('FINDINGS (ranked by severity then kind):');
  for (const f of report.findings) {
    const sev = f.severity.toUpperCase().padEnd(5);
    lines.push(`  [${sev}] ${f.kind}: ${f.message}`);
    lines.push(`          id=${f.id}`);
  }
  return lines.join('\n');
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
    process.stderr.write('Cannot audit: manifest failed schema validation. Run cli-validate first.\n');
    for (const e of parsed.errors) process.stderr.write(`  ${e.path}: ${e.message}\n`);
    process.exit(2);
  }

  const report = auditDrift(
    parsed.manifest,
    {
      hops: args.hops,
      detectCandidates: args.detectCandidates,
      maxCandidates: args.maxCandidates,
    },
    args.graph
  );
  report.manifestPath = args.manifestPath;

  if (args.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    process.stdout.write(formatHuman(report, args.manifestPath) + '\n');
  }

  if (report.counts.error > 0) process.exit(2);
  if (report.counts.warn > 0) process.exit(1);
  process.exit(0);
}

if (import.meta.main) {
  main();
}
