/**
 * Manifest patch preview — pure transform.
 *
 * Takes a current manifest + a patch and builds a "would-look-like-this"
 * report covering: per-op summary (before/after), affected entries
 * (directly touched + backlink-rippled), and a validation status.
 *
 * Pure: no filesystem writes, no bd-memory side-effects. The CLI
 * (cli-preview.ts) renders human-readable Markdown or JSON.
 */

import type { PublishEntry, PublishManifest, ValidationResult } from './schema';
import { applyPatch, affectedEntries, type ManifestPatch, type PatchChange, type PatchApplyError } from './patch';
import { validateManifest } from './validate';

export interface PreviewReport {
  manifest: {
    before: PublishManifest;
    after: PublishManifest;
  };
  applyErrors: PatchApplyError[];
  validation: {
    valid: boolean;
    errors: ValidationResult['errors'];
    warnings: ValidationResult['warnings'];
  };
  changes: PatchChange[];
  affected: {
    direct: PublishEntry[];
    indirect: PublishEntry[];
  };
}

export interface PreviewOptions {
  graphPathOverride?: string;
  /** Skip filesystem ref-integrity check (e.g., for unit tests). */
  skipRefIntegrity?: boolean;
}

export function buildPreview(
  manifest: PublishManifest,
  patch: ManifestPatch,
  options: PreviewOptions = {}
): PreviewReport {
  const apply = applyPatch(manifest, patch);

  const validation = validateManifest(apply.manifest, {
    graphPathOverride: options.graphPathOverride,
    skipRefIntegrity: options.skipRefIntegrity,
  });

  const directTitles = new Set(apply.changes.map((c) => c.title));
  const allAffected = affectedEntries(apply.manifest, apply.changes);
  const direct = allAffected.filter((e) => directTitles.has(e.title));
  const indirect = allAffected.filter((e) => !directTitles.has(e.title));

  return {
    manifest: { before: manifest, after: apply.manifest },
    applyErrors: apply.errors,
    validation: {
      valid: validation.valid,
      errors: validation.errors,
      warnings: validation.warnings,
    },
    changes: apply.changes,
    affected: { direct, indirect },
  };
}

export function previewToMarkdown(report: PreviewReport, opts: { manifestPath?: string } = {}): string {
  const lines: string[] = [];
  lines.push('# Manifest Patch Preview');
  if (opts.manifestPath) lines.push(`Manifest: \`${opts.manifestPath}\``);
  lines.push('');
  lines.push(
    `**Status:** ${report.validation.valid ? 'PATCH WOULD APPLY CLEANLY' : 'PATCH WOULD FAIL VALIDATION'}`
  );
  lines.push('');
  lines.push(`- Operations: ${report.changes.length} applied, ${report.applyErrors.length} apply-errors`);
  lines.push(`- Validation: ${report.validation.errors.length} errors, ${report.validation.warnings.length} warnings`);
  lines.push(
    `- Entries before: ${report.manifest.before.entries.length} → after: ${report.manifest.after.entries.length}`
  );
  lines.push(
    `- Affected: ${report.affected.direct.length} direct + ${report.affected.indirect.length} indirect (backlink ripple)`
  );
  lines.push('');

  if (report.applyErrors.length > 0) {
    lines.push('## Apply Errors');
    for (const e of report.applyErrors) lines.push(`- op[${e.opIndex}]: ${e.message}`);
    lines.push('');
  }

  if (report.validation.errors.length > 0) {
    lines.push('## Validation Errors');
    for (const e of report.validation.errors) lines.push(`- \`${e.path}\`: ${e.message}`);
    lines.push('');
  }

  if (report.validation.warnings.length > 0) {
    lines.push('## Validation Warnings');
    for (const w of report.validation.warnings) lines.push(`- \`${w.path}\`: ${w.message}`);
    lines.push('');
  }

  if (report.changes.length > 0) {
    lines.push('## Operations');
    for (const c of report.changes) {
      lines.push(`### [${c.op}] ${c.title}`);
      lines.push(`*Rationale:* ${c.rationale}`);
      lines.push('');
      lines.push('Before:');
      lines.push('```json');
      lines.push(JSON.stringify(c.before, null, 2));
      lines.push('```');
      lines.push('After:');
      lines.push('```json');
      lines.push(JSON.stringify(c.after, null, 2));
      lines.push('```');
      lines.push('');
    }
  }

  if (report.affected.indirect.length > 0) {
    lines.push('## Indirectly Affected (backlink ripple)');
    lines.push('These entries weren\'t directly patched but reference one of the changed titles in their backlinks:');
    lines.push('');
    for (const e of report.affected.indirect) {
      const touched = (e.backlinks ?? []).filter((b) =>
        report.changes.some((c) => c.title === b)
      );
      lines.push(`- **${e.title}** (backlinks affected: ${touched.join(', ')})`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
