#!/usr/bin/env bun
/**
 * apply-patch — apply a manifest patch with mandatory rationale capture.
 *
 * Usage:
 *   bun run apply-patch.ts <manifest.json> <patch.json> [--graph <path>]
 *                          [--dry-run] [--no-bd-remember] [--bd-cwd <path>]
 *                          [--json]
 *
 * Pipeline:
 *   1. Load + parse manifest (must already pass schema validation).
 *   2. Load patch JSON.
 *   3. Apply patch (in-memory) → new manifest + per-op changes.
 *   4. Validate the resulting manifest (schema + ref-integrity).
 *   5. Unless --dry-run:
 *      a. Atomic write (.tmp + rename).
 *      b. For each successful op, run `bd remember` to capture rationale.
 *
 * Exit codes:
 *   0 — applied (or dry-run validated) cleanly
 *   1 — apply errors OR resulting manifest fails validation
 *   2 — usage error / unreadable input
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { execSync } from 'node:child_process';
import { applyPatch, type ManifestPatch, type PatchApplyResult } from './patch';
import { parseManifest, validateManifest } from './validate';
import type { PublishManifest, ValidationResult } from './schema';

interface CliArgs {
  manifestPath: string;
  patchPath: string;
  graph?: string;
  dryRun: boolean;
  noBdRemember: boolean;
  bdCwd?: string;
  json: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: Partial<CliArgs> = {
    dryRun: false,
    noBdRemember: false,
    json: false,
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--graph') out.graph = argv[++i];
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--no-bd-remember') out.noBdRemember = true;
    else if (a === '--bd-cwd') out.bdCwd = argv[++i];
    else if (a === '--json') out.json = true;
    else if (a === '-h' || a === '--help') {
      process.stderr.write(
        'Usage: apply-patch.ts <manifest.json> <patch.json> [--graph <path>] [--dry-run] [--no-bd-remember] [--bd-cwd <path>] [--json]\n'
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
    dryRun: out.dryRun ?? false,
    noBdRemember: out.noBdRemember ?? false,
    bdCwd: out.bdCwd,
    json: out.json ?? false,
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

function atomicWrite(path: string, content: string): void {
  const tmp = join(dirname(path), `.${basename(path)}.tmp.${process.pid}`);
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, path);
}

// NOT the canonical logseqToAstro/slugify (which is byte-pinned to route slugs).
// This builds a human-readable fragment for a unique `bd remember` memo key
// only — deliberately a different, simpler function. Named distinctly so it can
// never be mistaken for the route slugifier (bd kb-projection-dt7).
function memoryKeySlug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

function rememberRationale(
  manifestPath: string,
  change: PatchApplyResult['changes'][number],
  cwd?: string
): { ok: boolean; error?: string } {
  const summary =
    change.op === 'add'
      ? `manifest add: "${change.title}"`
      : change.op === 'remove'
      ? `manifest remove: "${change.title}"`
      : change.op === 'set'
      ? `manifest set: "${change.title}"`
      : `manifest unset: "${change.title}"`;
  const body = `${summary}\n\nRationale: ${change.rationale}\n\nManifest: ${manifestPath}`;
  const key = `manifest-edit-${change.op}-${memoryKeySlug(change.title)}-${Date.now()}`;

  try {
    execSync(`bd remember ${JSON.stringify(body)} --key ${JSON.stringify(key)}`, {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd,
      timeout: 5000,
    });
    return { ok: true };
  } catch (e) {
    const stderr = ((e as { stderr?: Buffer | string }).stderr ?? '').toString();
    return { ok: false, error: stderr.trim() || (e as Error).message };
  }
}

interface ApplyReport {
  manifestPath: string;
  patchPath: string;
  dryRun: boolean;
  applyErrors: PatchApplyResult['errors'];
  validation: { valid: boolean; errors: ValidationResult['errors']; warnings: ValidationResult['warnings'] };
  changes: PatchApplyResult['changes'];
  written: boolean;
  rememberedCount: number;
  rememberFailures: { title: string; error: string }[];
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const rawManifest = readJson(args.manifestPath);
  const parsedIn = parseManifest(rawManifest);
  if (!parsedIn.manifest) {
    process.stderr.write(`Input manifest fails schema validation; aborting.\n`);
    for (const e of parsedIn.errors) process.stderr.write(`  ${e.path}: ${e.message}\n`);
    process.exit(1);
  }

  const rawPatch = readJson(args.patchPath);
  if (!isManifestPatch(rawPatch)) {
    process.stderr.write(`Patch JSON missing required "operations" array.\n`);
    process.exit(2);
  }

  const applyResult = applyPatch(parsedIn.manifest, rawPatch);

  const validation = validateManifest(applyResult.manifest, {
    graphPathOverride: args.graph,
  });

  let written = false;
  let rememberedCount = 0;
  const rememberFailures: { title: string; error: string }[] = [];

  const canWrite =
    !args.dryRun &&
    applyResult.errors.length === 0 &&
    validation.valid;

  if (canWrite) {
    atomicWrite(args.manifestPath, JSON.stringify(applyResult.manifest, null, 2) + '\n');
    written = true;

    if (!args.noBdRemember) {
      for (const change of applyResult.changes) {
        const r = rememberRationale(args.manifestPath, change, args.bdCwd);
        if (r.ok) rememberedCount += 1;
        else
          rememberFailures.push({
            title: change.title,
            error: r.error ?? 'unknown',
          });
      }
    }
  }

  const report: ApplyReport = {
    manifestPath: args.manifestPath,
    patchPath: args.patchPath,
    dryRun: args.dryRun,
    applyErrors: applyResult.errors,
    validation: {
      valid: validation.valid,
      errors: validation.errors,
      warnings: validation.warnings,
    },
    changes: applyResult.changes,
    written,
    rememberedCount,
    rememberFailures,
  };

  if (args.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    process.stdout.write(formatHuman(report) + '\n');
  }

  if (applyResult.errors.length > 0 || !validation.valid) process.exit(1);
  process.exit(0);
}

function formatHuman(r: ApplyReport): string {
  const lines: string[] = [];
  lines.push(`Manifest:    ${r.manifestPath}`);
  lines.push(`Patch:       ${r.patchPath}`);
  lines.push(`Mode:        ${r.dryRun ? 'DRY-RUN' : 'WRITE'}`);
  lines.push(`Operations:  ${r.changes.length} applied, ${r.applyErrors.length} apply-errors`);
  lines.push(
    `Validation:  ${r.validation.valid ? 'PASS' : 'FAIL'} (${r.validation.errors.length} errors, ${r.validation.warnings.length} warnings)`
  );
  if (!r.dryRun) {
    lines.push(`Written:     ${r.written ? 'yes' : 'NO (errors blocked write)'}`);
    lines.push(`bd remember: ${r.rememberedCount} captured`);
    if (r.rememberFailures.length > 0) {
      for (const f of r.rememberFailures) {
        lines.push(`  ! ${f.title}: ${f.error}`);
      }
    }
  }

  if (r.applyErrors.length > 0) {
    lines.push('');
    lines.push('APPLY ERRORS:');
    for (const e of r.applyErrors) lines.push(`  op[${e.opIndex}]: ${e.message}`);
  }

  if (r.validation.errors.length > 0) {
    lines.push('');
    lines.push('VALIDATION ERRORS:');
    for (const e of r.validation.errors) lines.push(`  ${e.path}: ${e.message}`);
  }

  if (r.changes.length > 0) {
    lines.push('');
    lines.push('CHANGES:');
    for (const c of r.changes) {
      lines.push(`  [${c.op}] ${c.title}`);
      lines.push(`    rationale: ${c.rationale}`);
    }
  }

  return lines.join('\n');
}

if (import.meta.main) {
  main();
}
