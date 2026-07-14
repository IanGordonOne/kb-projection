/**
 * Manifest-vs-LogSeq drift detector.
 *
 * Surfaces structured findings between a publish manifest and the live
 * LogSeq graph. Findings get stable IDs (kind + key) so a future
 * dismiss-list/snooze workflow can reference them across runs.
 *
 * Findings are RANKED, not piled. Bd-3fh.6 design notes called out the
 * "47 unprioritized findings is worse than 5 prioritized ones"
 * anti-pattern; the audit obeys that with severity tiers and a deterministic
 * sort order.
 *
 * No external deps. Shared LogSeq primitives (decodeHtml, wikilink extraction,
 * the title→file 5-encoding resolver) live in `../lib/logseq-primitives.ts` and
 * are IMPORTED here — do not re-inline them (bd kb-projection-dt7).
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  REDACT_MODE_VALUES,
  type DriftFinding,
  type DriftReport,
  type DriftSeverity,
  type FilterSpec,
  type PublishEntry,
  type PublishManifest,
  type RedactMode,
} from './schema';
import { extractWikilinks } from '../lib/logseq-primitives';
import { resolveEntryFile } from './validate';

const SEVERITY_RANK: Record<DriftSeverity, number> = {
  error: 0,
  warn: 1,
  info: 2,
};

const KIND_RANK: Record<DriftFinding['kind'], number> = {
  'source-missing': 0,
  'filter-redact-conflict': 1,
  'filter-self-reference': 2,
  'filter-reference-broken': 3,
  'filter-redact-mode-unknown': 4,
  'file-title-mismatch': 5,
  'filter-cycle': 6,
  'block-stale-verified': 7,
  'unknown-field': 8,
  'candidate-page': 9,
};

function rankFindings(findings: DriftFinding[]): DriftFinding[] {
  return [...findings].sort((a, b) => {
    const sevDiff = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (sevDiff !== 0) return sevDiff;
    const kindDiff = KIND_RANK[a.kind] - KIND_RANK[b.kind];
    if (kindDiff !== 0) return kindDiff;
    return a.id.localeCompare(b.id);
  });
}

function makeId(kind: DriftFinding['kind'], key: string): string {
  return `${kind}:${key}`;
}

export interface DriftAuditOptions {
  /** Hops to expand from manifest entries when looking for candidate pages. Default 1. */
  hops?: number;
  /** If true, scan the LogSeq pages dir for unknown-field candidates. Default true. */
  detectCandidates?: boolean;
  /** Cap candidates emitted per audit run to keep the output triageable. Default 25. */
  maxCandidates?: number;
  /**
   * Known redact modes (built-in `none` plus any host-supplied via
   * `redactRulesByMode`). When provided, the audit emits
   * `filter-redact-mode-unknown` for redact filters whose mode is not
   * in this list. When omitted, the audit skips redact-mode checking
   * entirely (modes are presumed valid; runtime no-op handles the
   * unknown case at apply time).
   */
  knownRedactModes?: readonly string[];
  /**
   * Threshold in days for `block-stale-verified` findings. A `verified::`
   * date older than this triggers a warning. Default 180. Set to 0 to
   * disable stale-verified scanning.
   */
  staleVerifiedThresholdDays?: number;
  /**
   * Override the "now" timestamp used for stale-verified age calculation.
   * Defaults to `Date.now()`. Useful for deterministic tests and for
   * "would this be stale as of date X" audits.
   */
  nowMs?: number;
}

/**
 * Match LogSeq block-property lines like `verified:: [[2026-04-20]]` or
 * `verified:: 2026-04-20`. The line is indented under its bullet.
 */
const VERIFIED_LINE_RE = /^\s*verified::\s*(?:\[\[)?(\d{4}-\d{2}-\d{2})(?:\]\])?\s*$/;

/**
 * Match a bullet line — `- text`, `\t- text`, etc. Returns the text after the dash.
 */
const BULLET_LINE_RE = /^\s*-\s+(.*?)\s*$/;

/**
 * Scan a LogSeq page for blocks with stale verified:: properties. Returns
 * one finding per block whose verified date is older than thresholdDays.
 */
function scanStaleVerified(
  filePath: string,
  title: string,
  entryIndex: number | undefined,
  thresholdDays: number,
  nowMs: number
): DriftFinding[] {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  const out: DriftFinding[] = [];
  const lines = content.split('\n');
  const thresholdMs = thresholdDays * 86400 * 1000;
  for (let i = 0; i < lines.length; i++) {
    const m = VERIFIED_LINE_RE.exec(lines[i]);
    if (!m) continue;
    const dateStr = m[1];
    const verifiedMs = Date.parse(dateStr + 'T00:00:00Z');
    if (Number.isNaN(verifiedMs)) continue;
    const ageMs = nowMs - verifiedMs;
    if (ageMs <= thresholdMs) continue;

    let excerpt = '';
    for (let j = i - 1; j >= 0 && j >= i - 6; j--) {
      const bm = BULLET_LINE_RE.exec(lines[j]);
      if (bm && bm[1].length > 0) {
        excerpt = bm[1].slice(0, 120);
        break;
      }
    }
    const ageDays = Math.floor(ageMs / (86400 * 1000));
    out.push({
      id: makeId('block-stale-verified', `${title}::${dateStr}::${i}`),
      kind: 'block-stale-verified',
      severity: 'warn',
      message: `Block in "${title}" verified ${ageDays} days ago (${dateStr}); re-verify against source`,
      ref: {
        entryIndex,
        title,
        file: filePath,
        blockExcerpt: excerpt || undefined,
        verifiedDate: dateStr,
        ageDays,
      },
    });
  }
  return out;
}

const KNOWN_ENTRY_FIELDS = new Set([
  'title',
  'tier',
  'backlinks',
  'exclude',
  'redact',
  'file',
  'filters',
]);

function entryUnknownFields(e: PublishEntry & Record<string, unknown>): string[] {
  return Object.keys(e).filter((k) => !KNOWN_ENTRY_FIELDS.has(k));
}

/**
 * Run the drift audit. Pure given (manifest, graph state). Filesystem
 * reads only; no network, no LLM calls. Output is deterministically
 * ranked.
 */
export function auditDrift(
  manifest: PublishManifest,
  options: DriftAuditOptions = {},
  graphPathOverride?: string
): DriftReport {
  const graphPath = graphPathOverride ?? manifest.graphPath;
  const hops = options.hops ?? 1;
  const detectCandidates = options.detectCandidates ?? true;
  const maxCandidates = options.maxCandidates ?? 25;
  const knownRedactModes = options.knownRedactModes;
  const staleVerifiedThresholdDays = options.staleVerifiedThresholdDays ?? 180;
  const nowMs = options.nowMs ?? Date.now();

  const findings: DriftFinding[] = [];
  const counts: Record<DriftSeverity, number> = { error: 0, warn: 0, info: 0 };

  const pagesDir = join(graphPath, 'pages');
  if (!existsSync(pagesDir)) {
    findings.push({
      id: makeId('source-missing', `graphPath:${pagesDir}`),
      kind: 'source-missing',
      severity: 'error',
      message: `graphPath/pages does not exist: ${pagesDir}`,
      ref: {},
    });
    counts.error += 1;
    return {
      manifestPath: '',
      graphPath,
      generatedAt: new Date().toISOString(),
      findings,
      counts,
    };
  }

  // Pass A — every entry resolves; surface unknown forward-rolled fields.
  const manifestTitles = new Set<string>();
  const manifestResolvedFiles = new Set<string>();
  for (let i = 0; i < manifest.entries.length; i++) {
    const e = manifest.entries[i];
    manifestTitles.add(e.title);
    const resolved = resolveEntryFile(graphPath, e);
    if (!resolved) {
      findings.push({
        id: makeId('source-missing', e.title),
        kind: 'source-missing',
        severity: 'error',
        message: `Manifest entry "${e.title}" no longer has a source page in LogSeq`,
        ref: { entryIndex: i, title: e.title, file: e.file },
      });
      counts.error += 1;
      continue;
    }
    manifestResolvedFiles.add(resolved);

    if (e.file) {
      const expected = resolved.endsWith('/' + e.file);
      if (!expected) {
        findings.push({
          id: makeId('file-title-mismatch', e.title),
          kind: 'file-title-mismatch',
          severity: 'warn',
          message: `entry "${e.title}" declares file "${e.file}" but resolved to ${resolved}`,
          ref: { entryIndex: i, title: e.title, file: e.file },
        });
        counts.warn += 1;
      }
    }

    const unknownFields = entryUnknownFields(e as PublishEntry & Record<string, unknown>);
    for (const fieldName of unknownFields) {
      findings.push({
        id: makeId('unknown-field', `${e.title}#${fieldName}`),
        kind: 'unknown-field',
        severity: 'info',
        message: `entry "${e.title}" has unknown field "${fieldName}" (forward-rolled or typo)`,
        ref: { entryIndex: i, title: e.title },
      });
      counts.info += 1;
    }

    // Pass A.1 — stale-verified scan on this entry's source page.
    if (staleVerifiedThresholdDays > 0 && !e.exclude) {
      const staleFindings = scanStaleVerified(
        resolved,
        e.title,
        i,
        staleVerifiedThresholdDays,
        nowMs
      );
      for (const f of staleFindings) {
        findings.push(f);
        counts.warn += 1;
      }
    }
  }

  // Pass C — filter pipeline: validate prepend/append refs, surface
  // self-references, cycles, redact mode + legacy-redact conflicts.
  // (kyber-3fh.13 / perky-tarsier.) Computed before candidate detection
  // so cycles + broken refs surface above informational candidates.
  const titleToEntry = new Map<string, { entry: PublishEntry; index: number }>();
  for (let i = 0; i < manifest.entries.length; i++) {
    titleToEntry.set(manifest.entries[i].title, { entry: manifest.entries[i], index: i });
  }
  const filterAdjacency = new Map<string, Set<string>>();
  for (let i = 0; i < manifest.entries.length; i++) {
    const e = manifest.entries[i];
    if (!e.filters || e.filters.length === 0) continue;

    const localFilterRedact = e.filters.some(
      (f): f is { redact: RedactMode } => 'redact' in f
    );
    if (localFilterRedact && typeof e.redact === 'string') {
      findings.push({
        id: makeId('filter-redact-conflict', e.title),
        kind: 'filter-redact-conflict',
        severity: 'error',
        message:
          `entry "${e.title}" declares both legacy top-level \`redact: '${e.redact}'\` ` +
          `and a redact filter inside \`filters\`; remove the legacy field (filters wins).`,
        ref: { entryIndex: i, title: e.title },
      });
      counts.error += 1;
    }

    const adj = new Set<string>();
    for (let j = 0; j < e.filters.length; j++) {
      const f = e.filters[j] as FilterSpec;
      if ('redact' in f) {
        // Mode validity is host-known; skip if knownRedactModes not supplied.
        if (
          knownRedactModes !== undefined &&
          !knownRedactModes.includes(f.redact)
        ) {
          findings.push({
            id: makeId('filter-redact-mode-unknown', `${e.title}#${j}:${String(f.redact)}`),
            kind: 'filter-redact-mode-unknown',
            severity: 'error',
            message:
              `entry "${e.title}" filters[${j}] has unknown redact mode ` +
              `${JSON.stringify(f.redact)}; expected one of ${knownRedactModes.join(', ')}.`,
            ref: { entryIndex: i, title: e.title, filterIndex: j },
          });
          counts.error += 1;
        }
        continue;
      }

      const refTitle = 'prepend' in f ? f.prepend : f.append;
      const position = 'prepend' in f ? 'prepend' : 'append';

      if (refTitle === e.title) {
        findings.push({
          id: makeId('filter-self-reference', `${e.title}#${j}`),
          kind: 'filter-self-reference',
          severity: 'error',
          message:
            `entry "${e.title}" filters[${j}] (${position}) references itself; ` +
            `remove the self-reference.`,
          ref: { entryIndex: i, title: e.title, filterIndex: j },
        });
        counts.error += 1;
        continue;
      }

      const target = titleToEntry.get(refTitle);
      if (!target) {
        findings.push({
          id: makeId('filter-reference-broken', `${e.title}#${j}:${refTitle}`),
          kind: 'filter-reference-broken',
          severity: 'error',
          message:
            `entry "${e.title}" filters[${j}] (${position}) references "${refTitle}", ` +
            `which is not in the publish manifest. Add it as a manifest entry, or fix the title.`,
          ref: { entryIndex: i, title: e.title, filterIndex: j },
        });
        counts.error += 1;
        continue;
      }

      if (target.entry.exclude === true) {
        findings.push({
          id: makeId('filter-reference-broken', `${e.title}#${j}:${refTitle}`),
          kind: 'filter-reference-broken',
          severity: 'error',
          message:
            `entry "${e.title}" filters[${j}] (${position}) references "${refTitle}", ` +
            `but that entry is \`exclude: true\` — composing it would leak private content. ` +
            `Either remove the filter or remove \`exclude: true\` from the addition.`,
          ref: { entryIndex: i, title: e.title, filterIndex: j },
        });
        counts.error += 1;
        continue;
      }

      adj.add(refTitle);
    }

    if (adj.size > 0) filterAdjacency.set(e.title, adj);
  }

  // Cycle detection across filter adjacency (data filters only). Uses
  // a DFS with three-color marking; reports each elementary cycle once,
  // with a stable id derived from the lex-min rotation.
  const reportedCycles = new Set<string>();
  const colors = new Map<string, 0 | 1 | 2>(); // 0=white, 1=gray, 2=black
  function dfs(node: string, stack: string[]): void {
    const c = colors.get(node) ?? 0;
    if (c === 1) {
      // Cycle: extract the path from the first occurrence.
      const idx = stack.indexOf(node);
      if (idx === -1) return;
      const cycle = stack.slice(idx);
      // Canonical form: rotate so smallest title is first; stable id.
      let minIdx = 0;
      for (let k = 1; k < cycle.length; k++) {
        if (cycle[k] < cycle[minIdx]) minIdx = k;
      }
      const canon = [...cycle.slice(minIdx), ...cycle.slice(0, minIdx)];
      const cycleId = canon.join('->');
      if (reportedCycles.has(cycleId)) return;
      reportedCycles.add(cycleId);
      const display = [...canon, canon[0]].map((t) => `"${t}"`).join(' → ');
      // Anchor the finding on the lex-min entry so ranking is stable.
      const anchor = titleToEntry.get(canon[0]);
      findings.push({
        id: makeId('filter-cycle', cycleId),
        kind: 'filter-cycle',
        severity: 'warn',
        message:
          `Filter cycle detected: ${display}. ` +
          `Cycles are operationally harmless (filters do not recurse) but indicate ` +
          `authorial confusion; remove one of the references.`,
        ref: anchor ? { entryIndex: anchor.index, title: canon[0] } : { title: canon[0] },
      });
      counts.warn += 1;
      return;
    }
    if (c === 2) return;
    colors.set(node, 1);
    stack.push(node);
    const next = filterAdjacency.get(node);
    if (next) {
      for (const m of next) dfs(m, stack);
    }
    stack.pop();
    colors.set(node, 2);
  }
  for (const start of filterAdjacency.keys()) {
    if ((colors.get(start) ?? 0) === 0) dfs(start, []);
  }

  // Pass B — candidate pages: LogSeq pages within `hops` of a manifest
  // entry that aren't themselves in the manifest.
  if (detectCandidates) {
    const candidateTitles = new Set<string>();
    let frontier = new Set<string>(manifestTitles);
    for (let hop = 0; hop < hops; hop++) {
      const next = new Set<string>();
      for (const title of frontier) {
        const file = resolveEntryFile(graphPath, { title });
        if (!file) continue;
        let content: string;
        try {
          content = readFileSync(file, 'utf8');
        } catch {
          continue;
        }
        for (const linked of extractWikilinks(content)) {
          if (manifestTitles.has(linked)) continue;
          if (candidateTitles.has(linked)) continue;
          const linkedFile = resolveEntryFile(graphPath, { title: linked });
          if (!linkedFile) continue;
          candidateTitles.add(linked);
          next.add(linked);
        }
      }
      frontier = next;
    }

    const candidatesList = Array.from(candidateTitles).sort();
    const capped = candidatesList.slice(0, maxCandidates);
    for (const title of capped) {
      findings.push({
        id: makeId('candidate-page', title),
        kind: 'candidate-page',
        severity: 'info',
        message: `LogSeq page "${title}" is wikilinked from manifest content but not in the manifest`,
        ref: { title },
      });
      counts.info += 1;
    }
    if (candidatesList.length > capped.length) {
      findings.push({
        id: makeId('candidate-page', '__truncation_marker__'),
        kind: 'candidate-page',
        severity: 'info',
        message: `... ${candidatesList.length - capped.length} more candidate pages (raise --max-candidates to see all)`,
        ref: {},
      });
      counts.info += 1;
    }
  }

  return {
    manifestPath: '',
    graphPath,
    generatedAt: new Date().toISOString(),
    findings: rankFindings(findings),
    counts,
  };
}

/**
 * Walk a directory and return all `.md` paths, mirroring build-manifest's
 * logic for completeness checks. Used by tests + future "orphan page"
 * detection.
 */
export function listGraphPages(graphPath: string): string[] {
  const pagesDir = join(graphPath, 'pages');
  if (!existsSync(pagesDir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(pagesDir)) {
    const p = join(pagesDir, name);
    try {
      const st = statSync(p);
      if (st.isFile() && name.toLowerCase().endsWith('.md')) out.push(p);
    } catch {
      // skip stat errors
    }
  }
  return out;
}
