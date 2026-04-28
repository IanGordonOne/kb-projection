/**
 * healthMonitor.ts — drift detection over the projection bridge.
 *
 * For each correspondence in ~/.kyber/projection_bridge.json, computes the
 * current status by re-hashing the source page and checking the emitted
 * artifact on disk:
 *
 *   - sourceHash unchanged + emitted file present + emittedHash matches → synced
 *   - sourceHash CHANGED  + emitted file present + emittedHash matches → stale
 *   - emitted file missing on disk                                     → orphan
 *   - both source AND emitted changed since last record                → hash-mismatch
 *
 * CLI:
 *   bun run healthMonitor.ts --check              # read-only report
 *   bun run healthMonitor.ts --update             # rewrite bridge with new statuses
 *   bun run healthMonitor.ts --json               # machine-readable report
 *   bun run healthMonitor.ts --check --target=astro    # filter by target
 *
 * Plan: ~/Projects/kyber/Plans/let-s-please-plan-1-6-generic-hanrahan.md (§1.6)
 */

import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import {
  loadBridge,
  saveBridge,
  type ProjectionBridgeFile,
  type ProjectionCorrespondence,
  type ProjectionStatus,
  type ProjectionTargetId,
} from './projectionBridge.ts';

export interface HealthFinding {
  key: string;
  sourcePath: string;
  emitTarget: ProjectionTargetId;
  emittedPath: string;
  previousStatus: ProjectionStatus;
  currentStatus: ProjectionStatus;
  changed: boolean;
  reason?: string;
}

export interface HealthReport {
  generatedAt: string;
  totalEntries: number;
  byStatus: Record<ProjectionStatus, number>;
  findings: HealthFinding[];
}

function sha256(content: string | Buffer): string {
  return 'sha256:' + createHash('sha256').update(content).digest('hex');
}

function deriveStatus(
  c: ProjectionCorrespondence,
): { status: ProjectionStatus; reason?: string } {
  const sourceMissing = !existsSync(c.sourcePath);
  if (sourceMissing) {
    return { status: 'orphan', reason: `source page missing: ${c.sourcePath}` };
  }

  const emittedMissing = !existsSync(c.emittedPath);
  if (emittedMissing) {
    return { status: 'orphan', reason: `emitted artifact missing: ${c.emittedPath}` };
  }

  const sourceContent = readFileSync(c.sourcePath, 'utf-8');
  const sourceHashNow = sha256(sourceContent);
  const sourceChanged = sourceHashNow !== c.sourceHash;

  const emittedContent = readFileSync(c.emittedPath);
  const emittedHashNow = sha256(emittedContent);
  const emittedChanged = emittedHashNow !== c.emittedHash;

  if (!sourceChanged && !emittedChanged) {
    return { status: 'synced' };
  }
  if (sourceChanged && !emittedChanged) {
    return { status: 'stale', reason: 'source content changed; emitted artifact untouched' };
  }
  if (!sourceChanged && emittedChanged) {
    return {
      status: 'hash-mismatch',
      reason: 'emitted artifact modified out-of-band (manual edit or external tool)',
    };
  }
  return {
    status: 'hash-mismatch',
    reason: 'both source and emitted changed since last record (resolve manually)',
  };
}

export function generateReport(
  bridge: ProjectionBridgeFile,
  filterTarget?: ProjectionTargetId,
): HealthReport {
  const findings: HealthFinding[] = [];
  const byStatus: Record<ProjectionStatus, number> = {
    synced: 0,
    stale: 0,
    orphan: 0,
    'hash-mismatch': 0,
  };

  for (const [key, c] of Object.entries(bridge.correspondences)) {
    if (filterTarget && c.emitTarget !== filterTarget) continue;
    const { status, reason } = deriveStatus(c);
    byStatus[status] += 1;
    findings.push({
      key,
      sourcePath: c.sourcePath,
      emitTarget: c.emitTarget,
      emittedPath: c.emittedPath,
      previousStatus: c.status,
      currentStatus: status,
      changed: status !== c.status,
      reason,
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    totalEntries: findings.length,
    byStatus,
    findings,
  };
}

export function applyReport(
  bridge: ProjectionBridgeFile,
  report: HealthReport,
): ProjectionBridgeFile {
  const updated: ProjectionBridgeFile = {
    ...bridge,
    correspondences: { ...bridge.correspondences },
  };
  for (const f of report.findings) {
    if (!f.changed) continue;
    const c = updated.correspondences[f.key];
    if (!c) continue;
    updated.correspondences[f.key] = {
      ...c,
      status: f.currentStatus,
      note: f.reason ?? c.note,
      lastCheckedAt: new Date().toISOString(),
    };
  }
  return updated;
}

function formatHumanReport(report: HealthReport): string {
  const lines: string[] = [];
  lines.push(`Projection bridge health report — ${report.generatedAt}`);
  lines.push(`Total: ${report.totalEntries}`);
  lines.push(
    `  synced=${report.byStatus.synced}  stale=${report.byStatus.stale}  ` +
      `orphan=${report.byStatus.orphan}  hash-mismatch=${report.byStatus['hash-mismatch']}`,
  );
  const drifted = report.findings.filter((f) => f.currentStatus !== 'synced');
  if (drifted.length === 0) {
    lines.push('All correspondences synced.');
    return lines.join('\n');
  }
  lines.push('');
  lines.push('Drifted correspondences:');
  for (const f of drifted) {
    const arrow = f.changed ? `${f.previousStatus} → ${f.currentStatus}` : `${f.currentStatus}`;
    lines.push(`  [${f.emitTarget}] ${f.sourcePath} (${arrow})`);
    if (f.reason) lines.push(`    ${f.reason}`);
  }
  return lines.join('\n');
}

// ─── CLI ──────────────────────────────────────────────────────────────

if (import.meta.main) {
  const args = process.argv.slice(2);
  const mode = args.includes('--update') ? 'update' : args.includes('--check') ? 'check' : null;
  const json = args.includes('--json');
  const targetArg = args.find((a) => a.startsWith('--target='));
  const filterTarget = targetArg ? targetArg.slice('--target='.length) : undefined;

  if (!mode) {
    console.error('Usage: bun run healthMonitor.ts (--check|--update) [--json] [--target=<id>]');
    process.exit(2);
  }

  const bridge = loadBridge();
  if (!bridge) {
    console.error(
      'No projection bridge file found. Run `bun run projectionBridge.ts --init` first.',
    );
    process.exit(2);
  }

  const report = generateReport(bridge, filterTarget);
  if (mode === 'update') {
    const updated = applyReport(bridge, report);
    saveBridge(updated);
  }

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatHumanReport(report));
    if (mode === 'update') {
      const drifted = report.findings.filter((f) => f.changed).length;
      console.log(`\nBridge updated (${drifted} status change${drifted === 1 ? '' : 's'} written).`);
    }
  }

  // Exit non-zero if drift exists, so this can drive CI gates if desired.
  const driftedCount =
    report.byStatus.stale + report.byStatus.orphan + report.byStatus['hash-mismatch'];
  process.exit(driftedCount > 0 ? 1 : 0);
}
