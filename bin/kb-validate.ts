#!/usr/bin/env bun
/**
 * CLI: validate a publish manifest.
 *
 * Usage:
 *   bun run cli-validate.ts <manifest.json> [--graph <path>] [--skip-refs] [--json]
 *
 * Exit codes:
 *   0 — valid (no errors)
 *   1 — invalid (one or more errors)
 *   2 — usage error
 */

import { existsSync, readFileSync } from 'node:fs';
import { validateManifest } from '../src/manifest/validate';
import type { ValidationResult } from '../src/manifest/schema';

interface CliArgs {
  manifestPath: string;
  graph?: string;
  skipRefs: boolean;
  json: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: Partial<CliArgs> = { skipRefs: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--graph') out.graph = argv[++i];
    else if (a === '--skip-refs') out.skipRefs = true;
    else if (a === '--json') out.json = true;
    else if (a === '-h' || a === '--help') {
      process.stderr.write(
        'Usage: cli-validate.ts <manifest.json> [--graph <path>] [--skip-refs] [--json]\n'
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
    skipRefs: out.skipRefs ?? false,
    json: out.json ?? false,
  };
}

function formatHuman(result: ValidationResult, manifestPath: string): string {
  const lines: string[] = [];
  lines.push(`Manifest: ${manifestPath}`);
  if (result.manifest) {
    lines.push(`Entries:  ${result.manifest.entries.length}`);
    lines.push(`Graph:    ${result.manifest.graphPath}`);
  }
  lines.push(`Errors:   ${result.errors.length}`);
  lines.push(`Warnings: ${result.warnings.length}`);
  if (result.errors.length > 0) {
    lines.push('');
    lines.push('ERRORS:');
    for (const e of result.errors) lines.push(`  ${e.path}: ${e.message}`);
  }
  if (result.warnings.length > 0) {
    lines.push('');
    lines.push('WARNINGS:');
    for (const w of result.warnings) lines.push(`  ${w.path}: ${w.message}`);
  }
  lines.push('');
  lines.push(result.valid ? 'VALID' : 'INVALID');
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
    process.exit(1);
  }

  const result = validateManifest(raw, {
    graphPathOverride: args.graph,
    skipRefIntegrity: args.skipRefs,
  });

  if (args.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    process.stdout.write(formatHuman(result, args.manifestPath) + '\n');
  }

  process.exit(result.valid ? 0 : 1);
}

if (import.meta.main) {
  main();
}
