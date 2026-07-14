/**
 * Hand-rolled, zero-dep manifest validator.
 *
 * Two layers:
 *   1. Schema-shape validation (parseManifest) — types, required fields,
 *      enum values, duplicates. Pure: takes a JSON-parsed value, returns
 *      ValidationResult.
 *   2. Reference integrity (validateReferences) — resolves each entry's
 *      title against the LogSeq graph filesystem; reports missing pages.
 *      Side-effecting (filesystem reads).
 *
 * Both layers are reused by audit-drift.ts. The full pipeline lives in
 * validateManifest(rawJson, graphPath?).
 *
 * No external deps. The title→file 5-encoding resolver lives in
 * `../lib/logseq-primitives.ts` and is IMPORTED here (resolveEntryFile is the
 * adapter over it) — do not re-inline it (bd kb-projection-dt7).
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveTitleToPage } from '../lib/logseq-primitives';
import {
  REDACT_MODE_VALUES,
  REDACT_VALUES,
  TIER_VALUES,
  type FilterSpec,
  type PublishEntry,
  type PublishManifest,
  type Redact,
  type RedactMode,
  type Tier,
  type ValidationError,
  type ValidationResult,
  type ValidationWarning,
} from './schema';

const KNOWN_ENTRY_FIELDS = new Set<keyof PublishEntry | string>([
  'title',
  'tier',
  'backlinks',
  'exclude',
  'redact',
  'file',
  'filters',
]);

const KNOWN_MANIFEST_FIELDS = new Set([
  '$schema',
  'generatedAt',
  'graphPath',
  'entries',
]);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function pushErr(errors: ValidationError[], path: string, message: string): void {
  errors.push({ path, message, severity: 'error' });
}

function pushWarn(warnings: ValidationWarning[], path: string, message: string): void {
  warnings.push({ path, message, severity: 'warning' });
}

/**
 * Parse + schema-validate a manifest from a JSON value (already JSON.parse'd).
 * Does NOT touch the filesystem. Returns a ValidationResult with the manifest
 * if all errors were avoidable, or null if shape was unrecoverable.
 */
export function parseManifest(raw: unknown): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];

  if (!isObject(raw)) {
    pushErr(errors, '$', 'manifest root is not an object');
    return { valid: false, errors, warnings, manifest: null };
  }

  if (typeof raw.graphPath !== 'string' || raw.graphPath.length === 0) {
    pushErr(errors, '$.graphPath', 'graphPath is required and must be a non-empty string');
  }

  if (!Array.isArray(raw.entries)) {
    pushErr(errors, '$.entries', 'entries is required and must be an array');
    return { valid: false, errors, warnings, manifest: null };
  }

  for (const key of Object.keys(raw)) {
    if (!KNOWN_MANIFEST_FIELDS.has(key)) {
      pushWarn(warnings, `$.${key}`, `unknown manifest field "${key}" — ignored`);
    }
  }

  if (raw.generatedAt !== undefined && typeof raw.generatedAt !== 'string') {
    pushWarn(warnings, '$.generatedAt', 'generatedAt should be an ISO 8601 string');
  }

  const validatedEntries: PublishEntry[] = [];
  const seenTitles = new Map<string, number[]>();

  for (let i = 0; i < raw.entries.length; i++) {
    const e = raw.entries[i];
    const path = `$.entries[${i}]`;

    if (!isObject(e)) {
      pushErr(errors, path, 'entry is not an object');
      continue;
    }

    let entryValid = true;

    if (typeof e.title !== 'string' || e.title.length === 0) {
      pushErr(errors, `${path}.title`, 'title is required and must be a non-empty string');
      entryValid = false;
    } else {
      const indices = seenTitles.get(e.title) ?? [];
      indices.push(i);
      seenTitles.set(e.title, indices);
    }

    if (typeof e.tier !== 'string' || !TIER_VALUES.includes(e.tier as Tier)) {
      pushErr(
        errors,
        `${path}.tier`,
        `tier must be one of ${TIER_VALUES.map((t) => `"${t}"`).join(', ')}; got ${JSON.stringify(e.tier)}`
      );
      entryValid = false;
    }

    if (e.backlinks !== undefined) {
      if (!Array.isArray(e.backlinks)) {
        pushErr(errors, `${path}.backlinks`, 'backlinks must be an array of strings');
        entryValid = false;
      } else {
        for (let j = 0; j < e.backlinks.length; j++) {
          if (typeof e.backlinks[j] !== 'string') {
            pushErr(errors, `${path}.backlinks[${j}]`, 'backlink must be a string');
            entryValid = false;
            break;
          }
        }
      }
    }

    if (e.exclude !== undefined && typeof e.exclude !== 'boolean') {
      pushErr(errors, `${path}.exclude`, 'exclude must be a boolean if present');
      entryValid = false;
    }

    if (e.redact !== undefined) {
      if (typeof e.redact !== 'string' || !REDACT_VALUES.includes(e.redact as Redact)) {
        pushErr(
          errors,
          `${path}.redact`,
          `redact must be one of ${REDACT_VALUES.map((r) => `"${r}"`).join(', ')}; got ${JSON.stringify(e.redact)}`
        );
        entryValid = false;
      }
    }

    if (e.file !== undefined && typeof e.file !== 'string') {
      pushErr(errors, `${path}.file`, 'file must be a string if present');
      entryValid = false;
    }

    let validatedFilters: FilterSpec[] | undefined;
    let filtersHasRedact = false;
    if (e.filters !== undefined) {
      if (!Array.isArray(e.filters)) {
        pushErr(errors, `${path}.filters`, 'filters must be an array of FilterSpec objects');
        entryValid = false;
      } else {
        validatedFilters = [];
        for (let j = 0; j < e.filters.length; j++) {
          const f = e.filters[j];
          const fpath = `${path}.filters[${j}]`;
          if (!isObject(f)) {
            pushErr(errors, fpath, 'filter must be an object');
            entryValid = false;
            continue;
          }
          const keys = Object.keys(f);
          if (keys.length !== 1) {
            pushErr(
              errors,
              fpath,
              `filter must have exactly one key (prepend | append | redact); got ${keys.length} keys: ${keys.join(', ')}`
            );
            entryValid = false;
            continue;
          }
          const key = keys[0];
          if (key === 'prepend' || key === 'append') {
            const v = (f as Record<string, unknown>)[key];
            if (typeof v !== 'string' || v.length === 0) {
              pushErr(errors, `${fpath}.${key}`, `${key} must be a non-empty string (KB anchor title)`);
              entryValid = false;
              continue;
            }
            validatedFilters.push(
              key === 'prepend'
                ? ({ prepend: v } as FilterSpec)
                : ({ append: v } as FilterSpec)
            );
          } else if (key === 'redact') {
            const v = (f as Record<string, unknown>).redact;
            if (typeof v !== 'string' || v.length === 0) {
              pushErr(
                errors,
                `${fpath}.redact`,
                `redact mode must be a non-empty string; got ${JSON.stringify(v)}`
              );
              entryValid = false;
              continue;
            }
            // Mode-name validity is HOST-SUPPLIED via createKbLoader's
            // `redactRulesByMode` table (the engine ships only `none` as
            // built-in). cli-audit-drift can additionally check known-mode
            // membership when invoked with --known-redact-modes.
            filtersHasRedact = true;
            validatedFilters.push({ redact: v as RedactMode });
          } else {
            pushErr(
              errors,
              fpath,
              `unknown filter key "${key}" (v1 supports prepend | append | redact)`
            );
            entryValid = false;
          }
        }
      }
    }

    // Mutual-exclusion: legacy top-level `redact` and a `filters[].redact`
    // both control the same axis. Refuse the ambiguous combination.
    if (filtersHasRedact && typeof e.redact === 'string') {
      pushErr(
        errors,
        `${path}.redact`,
        'entry has both legacy top-level `redact` and a `filters[].redact`; remove the legacy field (filters wins)'
      );
      entryValid = false;
    }

    for (const key of Object.keys(e)) {
      if (!KNOWN_ENTRY_FIELDS.has(key)) {
        pushWarn(
          warnings,
          `${path}.${key}`,
          `unknown entry field "${key}" — forward-rolled or typo (ignored)`
        );
      }
    }

    if (entryValid) {
      validatedEntries.push({
        title: e.title as string,
        tier: e.tier as Tier,
        ...(Array.isArray(e.backlinks) ? { backlinks: e.backlinks as string[] } : {}),
        ...(typeof e.exclude === 'boolean' ? { exclude: e.exclude } : {}),
        ...(typeof e.redact === 'string' ? { redact: e.redact as Redact } : {}),
        ...(typeof e.file === 'string' ? { file: e.file } : {}),
        ...(validatedFilters !== undefined ? { filters: validatedFilters } : {}),
      });
    }
  }

  for (const [title, indices] of seenTitles) {
    if (indices.length > 1) {
      pushErr(
        errors,
        `$.entries[${indices.join(', ')}]`,
        `duplicate title "${title}" appears at indices ${indices.join(', ')}`
      );
    }
  }

  const manifest: PublishManifest | null =
    typeof raw.graphPath === 'string' && raw.graphPath.length > 0
      ? {
          graphPath: raw.graphPath,
          entries: validatedEntries,
          ...(typeof raw.$schema === 'string' ? { $schema: raw.$schema } : {}),
          ...(typeof raw.generatedAt === 'string' ? { generatedAt: raw.generatedAt } : {}),
        }
      : null;

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    manifest,
  };
}

/**
 * Resolve a manifest entry to its on-disk LogSeq page path. Mirrors
 * build-manifest.ts resolveToFile + the loader's title-to-filename
 * mapping. Returns null if no candidate exists.
 */
export function resolveEntryFile(
  graphPath: string,
  entry: Pick<PublishEntry, 'title' | 'file'>
): string | null {
  // The 5-encoding candidate probe lives in the shared primitives module;
  // this stays the (graphPath, entry)-shaped adapter its callers expect.
  return resolveTitleToPage(join(graphPath, 'pages'), entry.title, entry.file);
}

/**
 * Verify every entry's title resolves to a LogSeq page. Reports missing
 * pages as errors. Side-effecting; takes an already-validated manifest.
 */
export function validateReferences(
  manifest: PublishManifest,
  graphPathOverride?: string
): { errors: ValidationError[]; warnings: ValidationWarning[] } {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];
  const graphPath = graphPathOverride ?? manifest.graphPath;

  const pagesDir = join(graphPath, 'pages');
  if (!existsSync(pagesDir)) {
    pushErr(
      errors,
      '$.graphPath',
      `graphPath/pages does not exist: ${pagesDir}`
    );
    return { errors, warnings };
  }

  for (let i = 0; i < manifest.entries.length; i++) {
    const e = manifest.entries[i];
    const resolved = resolveEntryFile(graphPath, e);
    if (!resolved) {
      pushErr(
        errors,
        `$.entries[${i}]`,
        `title "${e.title}" does not resolve to a LogSeq page${e.file ? ` (explicit file: ${e.file})` : ''}`
      );
    } else if (e.file) {
      const expectedFromFile = resolved.endsWith('/' + e.file);
      if (!expectedFromFile) {
        pushWarn(
          warnings,
          `$.entries[${i}].file`,
          `file "${e.file}" resolved to a different path: ${resolved}`
        );
      }
    }
  }

  return { errors, warnings };
}

/**
 * Full pipeline: parse → schema-validate → ref-integrity. Use this for
 * 'kyber kb manifest validate <path>'. Errors are accumulated across both
 * passes.
 */
export function validateManifest(
  raw: unknown,
  options: { graphPathOverride?: string; skipRefIntegrity?: boolean } = {}
): ValidationResult {
  const result = parseManifest(raw);
  if (!result.manifest || options.skipRefIntegrity) return result;

  const ref = validateReferences(result.manifest, options.graphPathOverride);
  return {
    valid: result.valid && ref.errors.length === 0,
    errors: [...result.errors, ...ref.errors],
    warnings: [...result.warnings, ...ref.warnings],
    manifest: result.manifest,
  };
}
