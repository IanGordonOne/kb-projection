/**
 * transformer.ts — projection engine.
 *
 * Orchestrates the projection of a curated subgraph into a format-specific
 * artifact. The engine itself is target-agnostic; concrete emitters
 * (Astro, Obsidian, etc.) register themselves via `registerTarget()`.
 *
 * Pipeline phases (per Plans/let-s-please-plan-1-6-generic-hanrahan.md §1.6):
 *
 *   1–3  build manifest        (build-manifest.ts; engine-internal subprocess)
 *   4    privacy triage        (emit-summaries.ts + pick-kb.sh; pre-engine
 *                                — caller supplies a curated manifest)
 *   5    hudson injection scan (hudson-scan.ts; stub today, gate when shipped)
 *   6–8  target tail            (dispatched to the target's TargetEmitter)
 *
 * State convention: emit correspondences land in ~/.kyber/projection_bridge.json
 * (kyber-side state, PAI-managed behavior). See projectionBridge.ts.
 *
 * 1.6 part A status: interface + dispatcher + shared-phase wiring shipped.
 * No target emitters registered yet — those land in 1.6-B (astro) and 1.6-C
 * (obsidian).
 */

import { spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import {
  loadBridge,
  saveBridge,
  emptyBridge,
  correspondenceKey,
  type ProjectionBridgeFile,
  type ProjectionCorrespondence,
  type ProjectionTargetId,
} from './projectionBridge.ts';

// ─── Types ────────────────────────────────────────────────────────────

/** One entry in the curated subgraph manifest (matches build-manifest.ts output). */
export interface ManifestEntry {
  title: string;
  slug: string;
  /** Absolute path to the source page. */
  file: string;
  size: number;
  tier: 'seed' | '1-hop' | '2-hop' | 'n-hop';
  backlinks: string[];
  category: string | null;
  type: string | null;
  project: string | null;
  excerpt: string;
  /** Privacy flag (e.g. "private", "sensitive"); null if none. */
  privacyFlag: string | null;
}

export interface SubgraphManifest {
  generatedAt: string;
  sourceDir: string;
  graph: string;
  hops: number;
  entries: ManifestEntry[];
}

export interface TransformOptions {
  /** Path to a curated manifest JSON (post-triage). */
  manifestPath: string;
  /** Target ID — must match a registered TargetEmitter. */
  target: ProjectionTargetId;
  /** Where the target should emit (vault path / site src dir / etc.). */
  outputDir: string;
  /** Target-specific options bag, opaque to the engine. */
  targetOptions?: Record<string, unknown>;
  /** If true, skip hudson injection scan (default false). */
  skipHudsonScan?: boolean;
  /** Override default projection-bridge path (for tests). */
  bridgePath?: string;
  /**
   * Iteration loop (kyber-3fh.4). When true, the engine reads its bridge,
   * recomputes per-correspondence status, and filters the manifest to only
   * entries that need re-emit:
   *   - status `stale|orphan|hash-mismatch` for the named target, OR
   *   - no bridge correspondence for the named target yet (new/never-emitted)
   * Targets receive this flag too (via `options.onlyStale`) and should merge
   * any auxiliary outputs (e.g. `_manifest.json`) instead of overwriting.
   */
  onlyStale?: boolean;
}

export interface EmitResult {
  /** One correspondence per emitted page (engine writes these to bridge). */
  correspondences: Array<Omit<ProjectionCorrespondence, 'status' | 'lastCheckedAt'>>;
  /** Optional human-readable summary the engine prints at end of run. */
  summary?: string;
}

/**
 * Target emitter contract. Implementations live in `targets/<id>.ts` and
 * register themselves via `registerTarget()`.
 */
export type TargetEmitter = (
  manifest: SubgraphManifest,
  options: TransformOptions,
) => Promise<EmitResult> | EmitResult;

// ─── Target registry ──────────────────────────────────────────────────

const registry = new Map<ProjectionTargetId, TargetEmitter>();

export function registerTarget(id: ProjectionTargetId, emitter: TargetEmitter): void {
  if (registry.has(id)) {
    throw new Error(`Target '${id}' is already registered.`);
  }
  registry.set(id, emitter);
}

export function getTarget(id: ProjectionTargetId): TargetEmitter | undefined {
  return registry.get(id);
}

export function listTargets(): ProjectionTargetId[] {
  return [...registry.keys()];
}

// ─── Helpers ──────────────────────────────────────────────────────────

function sha256(content: string | Buffer): string {
  return 'sha256:' + createHash('sha256').update(content).digest('hex');
}

function loadManifest(path: string): SubgraphManifest {
  if (!existsSync(path)) {
    throw new Error(`Manifest not found: ${path}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (e) {
    throw new Error(`Manifest at ${path} is not valid JSON: ${(e as Error).message}`);
  }
  // Accept either the wrapped {entries: [...]} shape or a flat array. The
  // 777westwood-era build-kb-manifest.ts (and the current PAI-USER copy)
  // both emit a flat array; the engine adopts the wrapped shape for future
  // metadata (generatedAt, sourceDir, graph, hops). Wrap on the fly so legacy
  // manifests keep working without a forced co-migration of build-manifest.ts.
  if (Array.isArray(parsed)) {
    return {
      generatedAt: '',
      sourceDir: '',
      graph: '',
      hops: 0,
      entries: parsed as ManifestEntry[],
    };
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Manifest at ${path}: not an object or array`);
  }
  const m = parsed as Record<string, unknown>;
  if (!Array.isArray(m.entries)) {
    throw new Error(`Manifest at ${path}: 'entries' must be an array`);
  }
  // Light validation — entries are produced by build-manifest.ts whose output
  // shape is the source of truth; we trust it.
  return parsed as SubgraphManifest;
}

/** Fail if any entry is privacy-flagged — caller should have triaged first. */
function assertNoPrivacyFlags(manifest: SubgraphManifest): void {
  const flagged = manifest.entries.filter((e) => e.privacyFlag);
  if (flagged.length > 0) {
    const names = flagged.map((e) => `${e.title} [${e.privacyFlag}]`).join(', ');
    throw new Error(
      `Refusing to emit: ${flagged.length} privacy-flagged entries in manifest. ` +
        `Run privacy triage (emit-summaries.ts + pick-kb.sh) and supply a curated manifest. ` +
        `Flagged: ${names}`,
    );
  }
}

/**
 * Phase 5 — hudson injection scan. Stubbed today: emits a warning if the
 * tool is not yet present (per parent SKILL.md, hudson-scan.ts is "future").
 * Will become a hard gate when the tool ships.
 */
async function runHudsonScan(
  manifest: SubgraphManifest,
  options: TransformOptions,
): Promise<void> {
  if (options.skipHudsonScan) return;
  const here = dirname(fileURLToPath(import.meta.url));
  const hudsonPath = resolve(here, 'hudson-scan.ts');
  if (!existsSync(hudsonPath)) {
    console.warn(
      `[hudson] WARNING: hudson-scan.ts not yet implemented at ${hudsonPath}; proceeding without injection scan. ` +
        `When the tool ships, this becomes a mandatory gate.`,
    );
    return;
  }
  // When the tool exists, invoke it as a subprocess. The contract: scanner
  // exits non-zero on any positive injection finding.
  const result = spawnSync('bun', ['run', hudsonPath, '--manifest', options.manifestPath], {
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(`Hudson injection scan failed (exit ${result.status}). Aborting emit.`);
  }
}

/**
 * Filter manifest to entries that need re-emit for the named target.
 *
 * Includes (a) entries whose existing bridge correspondence has drifted
 * (source-hash changed, emitted file missing, or both), and (b) entries with
 * no bridge correspondence at all (new pages that have never been emitted).
 * Excludes entries whose bridge says `synced` and whose source hash and
 * emitted-file hash both still match.
 *
 * Resolves source paths the same way targets do: `<graphPath>/pages/<entry.file>`.
 * graphPath comes from `targetOptions.graphPath` — that's a target-side concern,
 * but the engine needs the same value to compare against bridge entries. If
 * targetOptions.graphPath is missing, the engine cannot reason about staleness
 * and falls back to "all entries are stale" so the caller doesn't silently
 * skip pages.
 */
function filterToStaleAndNew(
  manifest: SubgraphManifest,
  options: TransformOptions,
): { filtered: SubgraphManifest; reason: string } {
  const graphPath = (options.targetOptions as Record<string, unknown> | undefined)?.graphPath;
  if (typeof graphPath !== 'string') {
    console.warn(
      `[engine] onlyStale requested but targetOptions.graphPath is missing; ` +
        `cannot map manifest entries to bridge correspondences. Falling back to full emit.`,
    );
    return { filtered: manifest, reason: 'no-graphPath' };
  }
  const bridge = loadBridge(options.bridgePath);
  if (!bridge) {
    return {
      filtered: manifest,
      reason: 'no-bridge — first emit, every entry is new',
    };
  }
  // Index bridge by sourcePath, scoped to the requested target. The same
  // source page may have correspondences for multiple targets; we only care
  // about ours.
  const bySource = new Map<string, ProjectionCorrespondence>();
  for (const c of Object.values(bridge.correspondences)) {
    if (c.emitTarget !== options.target) continue;
    bySource.set(c.sourcePath, c);
  }

  const kept: ManifestEntry[] = [];
  let reasonNew = 0;
  let reasonStale = 0;
  let reasonOrphan = 0;
  let reasonMismatch = 0;
  for (const entry of manifest.entries) {
    const sourcePath = `${graphPath}/pages/${entry.file}`;
    const c = bySource.get(sourcePath);
    if (!c) {
      kept.push(entry);
      reasonNew++;
      continue;
    }
    if (!existsSync(c.sourcePath)) {
      // Source vanished. Skip — re-emit can't fix that; user should remove
      // the entry from the manifest or restore the source.
      continue;
    }
    if (!existsSync(c.emittedPath)) {
      kept.push(entry);
      reasonOrphan++;
      continue;
    }
    const sourceNow = sha256(readFileSync(c.sourcePath, 'utf-8'));
    const emittedNow = sha256(readFileSync(c.emittedPath));
    const sourceChanged = sourceNow !== c.sourceHash;
    const emittedChanged = emittedNow !== c.emittedHash;
    if (sourceChanged && !emittedChanged) {
      kept.push(entry);
      reasonStale++;
    } else if (!sourceChanged && emittedChanged) {
      // Out-of-band edit on the emitted artifact. Re-emit overwrites the
      // hand-edit (the bridge doesn't track WHO touched it). Caller should
      // resolve manually before invoking onlyStale; for now, include it so
      // they at least see the regen happen and can compare.
      kept.push(entry);
      reasonMismatch++;
    } else if (sourceChanged && emittedChanged) {
      kept.push(entry);
      reasonMismatch++;
    }
    // else: synced, skip
  }
  return {
    filtered: { ...manifest, entries: kept },
    reason:
      `new=${reasonNew} stale=${reasonStale} orphan=${reasonOrphan} ` +
      `mismatch=${reasonMismatch} (bridge had ${bySource.size} entries for target=${options.target})`,
  };
}

/** Record successful emit correspondences in the projection bridge. */
function persistCorrespondences(
  result: EmitResult,
  options: TransformOptions,
): void {
  const bridge: ProjectionBridgeFile =
    loadBridge(options.bridgePath) ?? emptyBridge();
  for (const c of result.correspondences) {
    const key = correspondenceKey(c.emittedPath, c.emitTarget);
    bridge.correspondences[key] = {
      ...c,
      status: 'synced',
      lastCheckedAt: new Date().toISOString(),
    };
  }
  saveBridge(bridge, options.bridgePath);
}

// ─── Public API ───────────────────────────────────────────────────────

/**
 * Project a curated subgraph into the named target's format.
 * Returns the EmitResult after correspondences are persisted to the bridge.
 */
export async function transform(options: TransformOptions): Promise<EmitResult> {
  const fullManifest = loadManifest(options.manifestPath);
  assertNoPrivacyFlags(fullManifest);

  const emitter = getTarget(options.target);
  if (!emitter) {
    const known = listTargets();
    const knownStr = known.length === 0 ? '(none)' : known.join(', ');
    throw new Error(
      `Target '${options.target}' is not registered. Known targets: ${knownStr}. ` +
        `Targets register themselves by importing targets/<id>.ts. ` +
        `As of 1.6 part A, no targets ship in the engine — astro lands in part B, obsidian in part C.`,
    );
  }

  let workingManifest: SubgraphManifest = fullManifest;
  if (options.onlyStale) {
    const { filtered, reason } = filterToStaleAndNew(fullManifest, options);
    workingManifest = filtered;
    console.log(
      `[engine] onlyStale: emitting ${filtered.entries.length} of ${fullManifest.entries.length} entries (${reason}).`,
    );
    if (filtered.entries.length === 0) {
      return { correspondences: [], summary: 'onlyStale: nothing to do' };
    }
  }

  await runHudsonScan(workingManifest, options);
  const result = await emitter(workingManifest, options);
  persistCorrespondences(result, options);
  return result;
}

// Re-export sha256 so target emitters can compute hashes consistently.
export { sha256 };

// ─── CLI ──────────────────────────────────────────────────────────────

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args[0] === '--list-targets') {
    const targets = listTargets();
    if (targets.length === 0) {
      console.log('No targets registered. (Engine ships in 1.6-A; targets land in 1.6-B/C.)');
    } else {
      for (const id of targets) console.log(id);
    }
    process.exit(0);
  }

  if (args[0] === '--transform') {
    // Parse minimal flags: --manifest, --target, --output-dir, --options
    let manifestPath: string | undefined;
    let target: string | undefined;
    let outputDir: string | undefined;
    let optionsFile: string | undefined;
    let skipHudson = false;
    let onlyStale = false;
    for (let i = 1; i < args.length; i++) {
      const a = args[i];
      if (a === '--manifest') manifestPath = args[++i];
      else if (a === '--target') target = args[++i];
      else if (a === '--output-dir') outputDir = args[++i];
      else if (a === '--options') optionsFile = args[++i];
      else if (a === '--skip-hudson') skipHudson = true;
      else if (a === '--only-stale') onlyStale = true;
    }
    if (!manifestPath || !target || !outputDir) {
      console.error(
        'Usage: bun run transformer.ts --transform --manifest <path> --target <id> --output-dir <path> [--options <json-file>] [--skip-hudson] [--only-stale]',
      );
      process.exit(2);
    }
    const targetOptions: Record<string, unknown> = optionsFile
      ? JSON.parse(readFileSync(optionsFile, 'utf-8'))
      : {};
    transform({
      manifestPath,
      target,
      outputDir,
      targetOptions,
      skipHudsonScan: skipHudson,
      onlyStale,
    })
      .then((r) => {
        if (r.summary) console.log(r.summary);
        console.log(`Wrote ${r.correspondences.length} correspondences to projection bridge.`);
        process.exit(0);
      })
      .catch((e) => {
        console.error((e as Error).message);
        process.exit(1);
      });
  } else {
    console.error('Usage: bun run transformer.ts (--list-targets | --transform ...)');
    process.exit(2);
  }
}
