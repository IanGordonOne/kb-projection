/**
 * Publish manifest schema — types only.
 *
 * Mirrors the PublishEntry interface in 777westwood/src/content/loaders/kb.ts
 * (kyber-3fh.5 — the loader is the runtime consumer; this is the validator
 * companion). Schema v1 covers the live shape. Future fields (section,
 * template, composition) are intentionally absent until kyber-3fh.6 phases
 * 3-5 land — the validator should warn (not error) on unknown fields so
 * forward-rolled manifests remain readable.
 *
 * kyber-3fh.13 (perky-tarsier) adds `filters?: FilterSpec[]` — a per-entry
 * pipeline of declarative transformations applied in the loader between
 * hydration-cache substitution and `transformBody`. Two filter types in v1:
 *   - data filters: { prepend | append: <KB anchor title> }
 *   - code filters: { redact: 'light' | 'none' }
 * Future filters (audience adapter, TOC inject, summarize) extend the
 * discriminated union; each new code filter is also a function in
 * `Tools/filters/` plus a registry entry.
 */

export type Tier = 'seed' | '1-hop' | '2-hop' | 'n-hop';
export const TIER_VALUES: readonly Tier[] = ['seed', '1-hop', '2-hop', 'n-hop'] as const;

export type Redact = 'light';
export const REDACT_VALUES: readonly Redact[] = ['light'] as const;

/**
 * Code-filter mode for the `redact` filter. The string is keyed against
 * the host site's `redactRulesByMode` table supplied to createKbLoader.
 * The engine ships only `none` (no-op) as a built-in; everything else
 * is host-supplied (no site-specific patterns in the engine).
 *
 * `REDACT_MODE_VALUES` is kept for back-compat with audit-drift's
 * unknown-mode finding; it lists ONLY the engine's built-in modes.
 * Host audit-drift invocations should pass the host's known modes
 * (see cli-audit-drift `--known-redact-modes`).
 */
export type RedactMode = string;
export const REDACT_MODE_VALUES: readonly string[] = ['none'] as const;

/**
 * Per-entry filter pipeline element. Discriminated union; cli-validate
 * enforces shape. Future filter types extend this union.
 */
export type FilterSpec =
  | { prepend: string }              // KB anchor title (data filter)
  | { append: string }               // KB anchor title (data filter)
  | { redact: RedactMode };          // named code filter

export interface PublishEntry {
  title: string;
  tier: Tier;
  backlinks?: string[];
  exclude?: boolean;
  /**
   * Legacy single-hook redaction key. Backwards-compatible with kyber-3fh.5.
   * Mutually exclusive with a `redact` filter inside `filters` — cli-validate
   * rejects entries that declare both.
   */
  redact?: Redact;
  file?: string;
  /**
   * Optional per-entry filter pipeline. Applied in declared order in the
   * loader after hydration-cache substitution and before transformBody.
   * v1 supports prepend/append (KB-anchor data filters) and redact (code
   * filter from registry).
   */
  filters?: FilterSpec[];
}

export interface PublishManifest {
  $schema?: string;
  generatedAt?: string;
  graphPath: string;
  entries: PublishEntry[];
}

export interface ValidationError {
  path: string;
  message: string;
  severity: 'error';
}

export interface ValidationWarning {
  path: string;
  message: string;
  severity: 'warning';
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
  manifest: PublishManifest | null;
}

export type DriftSeverity = 'error' | 'warn' | 'info';

export type DriftFindingKind =
  | 'source-missing'              // manifest entry, LogSeq page no longer exists
  | 'candidate-page'              // LogSeq page wikilinked from a manifest entry but not in manifest
  | 'file-title-mismatch'         // manifest entry's `file` field disagrees with `title`-derived filename
  | 'unknown-field'               // forward-rolled field present (warning, not error)
  | 'filter-reference-broken'     // prepend/append references a missing or excluded anchor
  | 'filter-self-reference'       // entry has a filter that references itself
  | 'filter-cycle'                // mutual or longer cycle in filter references
  | 'filter-redact-mode-unknown'  // redact filter mode is not in the registry
  | 'filter-redact-conflict';     // entry has both top-level redact and filters[].redact

export interface DriftFinding {
  id: string;               // stable ID (kind + key) so a future dismiss-list works
  kind: DriftFindingKind;
  severity: DriftSeverity;
  message: string;
  /** The manifest entry index or LogSeq title that triggered this finding. */
  ref: { entryIndex?: number; title?: string; file?: string; filterIndex?: number };
}

export interface DriftReport {
  manifestPath: string;
  graphPath: string;
  generatedAt: string;
  findings: DriftFinding[];
  /** Counts by severity for quick triage. */
  counts: Record<DriftSeverity, number>;
}
