#!/usr/bin/env bun
/**
 * CLI: preview a manifest patch (read-only; no writes, no bd-remember).
 *
 * Usage:
 *   bun run cli-preview.ts <manifest.json> <patch.json> [--graph <path>]
 *                          [--json] [--skip-refs]
 *
 * Exit codes:
 *   0 — patch would apply cleanly (validation passes)
 *   1 — patch would fail (apply errors OR validation errors)
 *   2 — usage error / unreadable input
 */

import { existsSync, readFileSync } from 'node:fs';
import { buildPreview, previewToMarkdown } from '../src/manifest/preview';
import { parseManifest } from '../src/manifest/validate';
import type { ManifestPatch } from '../src/manifest/patch';

interface CliArgs {
  manifestPath: string;
  patchPath: string;
  graph?: string;
  json: boolean;
  skipRefs: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: Partial<CliArgs> = { json: false, skipRefs: false };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--graph') out.graph = argv[++i];
    else if (a === '--json') out.json = true;
    else if (a === '--skip-refs') out.skipRefs = true;
    else if (a === '-h' || a === '--help') {
      process.stderr.write(
        'Usage: cli-preview.ts <manifest.json> <patch.json> [--graph <path>] [--json] [--skip-refs]\n'
      );
      process.exit(2);
    } else if (!a.startsWith('-')) {
      positional.push(a);
    }
  }
  if (positional.length < 2) {
    process.stderr.write('Missing required positionals <manifest.json> <patch.json>\n');
    process.exit(2);
  }
  return {
    manifestPath: positional[0],
    patchPath: positional[1],
    graph: out.graph,
    json: out.json ?? false,
    skipRefs: out.skipRefs ?? false,
  };
}

function readJson(path: string): unknown {
  if (!existsSync(path)) {
    process.stderr.write(`File not found: ${path}\n`);
    process.exit(2);
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    process.stderr.write(`Failed to parse JSON ${path}: ${(e as Error).message}\n`);
    process.exit(2);
  }
}

function isManifestPatch(v: unknown): v is ManifestPatch {
  return (
    typeof v === 'object' &&
    v !== null &&
    Array.isArray((v as { operations?: unknown }).operations)
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const rawManifest = readJson(args.manifestPath);
  const parsedIn = parseManifest(rawManifest);
  if (!parsedIn.manifest) {
    process.stderr.write(`Input manifest fails schema validation; cannot preview.\n`);
    for (const e of parsedIn.errors) process.stderr.write(`  ${e.path}: ${e.message}\n`);
    process.exit(2);
  }

  const rawPatch = readJson(args.patchPath);
  if (!isManifestPatch(rawPatch)) {
    process.stderr.write(`Patch JSON missing required "operations" array.\n`);
    process.exit(2);
  }

  const report = buildPreview(parsedIn.manifest, rawPatch, {
    graphPathOverride: args.graph,
    skipRefIntegrity: args.skipRefs,
  });

  if (args.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    process.stdout.write(previewToMarkdown(report, { manifestPath: args.manifestPath }) + '\n');
  }

  if (report.applyErrors.length > 0 || !report.validation.valid) process.exit(1);
  process.exit(0);
}

if (import.meta.main) {
  main();
}
