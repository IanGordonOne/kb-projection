/**
 * projectionBridge.ts — read/write/validate ~/.kyber/projection_bridge.json
 *
 * The bridge file is the single record of source-page → emitted-artifact
 * correspondences for projections (Astro, Obsidian, future targets). This
 * module is the only writer; all readers go through it for type safety
 * and atomic-write guarantees.
 *
 * Mirrors the pattern of _KNOWLEDGE_SYNC/Tools/bridgeStore.ts.
 *
 * Plan: ~/Projects/kyber/Plans/let-s-please-plan-1-6-generic-hanrahan.md (§1.6)
 */

import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';

export const BRIDGE_PATH_ENV = 'KYBER_PROJECTION_BRIDGE_PATH';
export const SCHEMA_VERSION = 1 as const;

export type ProjectionStatus = 'synced' | 'stale' | 'orphan' | 'hash-mismatch';

/** Identifier for an emit target. Targets register themselves under one of these. */
export type ProjectionTargetId = 'astro' | 'obsidian' | (string & {});

export interface ProjectionCorrespondence {
  /** Path to the source page (LogSeq markdown, absolute or vault-relative). */
  sourcePath: string;
  /** sha256:<hex> of the source content at last successful emit. */
  sourceHash: string;
  /** Which target this entry belongs to — one source page may have multiple emits. */
  emitTarget: ProjectionTargetId;
  /** Absolute path to the emitted artifact. */
  emittedPath: string;
  /** sha256:<hex> of the emitted artifact at the moment of emit. */
  emittedHash: string;
  /** ISO-8601 timestamp of the emit. */
  emittedAt: string;
  /** Typed status — see semantics below. */
  status: ProjectionStatus;
  /** Optional human-readable note for non-synced statuses. */
  note?: string;
  /** ISO-8601 last time this entry was visited (read or rewritten). */
  lastCheckedAt?: string;
}

/**
 * Bridge file shape. Keyed by `<sourcePath>::<emitTarget>` to allow the same
 * source page to have multiple correspondences (one per target).
 */
export interface ProjectionBridgeFile {
  version: typeof SCHEMA_VERSION;
  lastSyncTime: string;
  correspondences: Record<string, ProjectionCorrespondence>;
}

const VALID_STATUSES = new Set<ProjectionStatus>([
  'synced',
  'stale',
  'orphan',
  'hash-mismatch',
]);

export function defaultBridgePath(): string {
  return process.env[BRIDGE_PATH_ENV] ?? join(homedir(), '.kyber', 'projection_bridge.json');
}

/**
 * Bridge key. We key on `<emitTarget>::<emittedPath>` rather than source +
 * target because the same source page can be aliased under multiple manifest
 * titles (LogSeq filename canonicalisation: `Project: Foo` and
 * `Project%3A Foo` resolve to the same `.md` file but emit as two slugs);
 * keying on source would clobber one of them. Emitted paths are always
 * filesystem-unique, so `target::emittedPath` is the safe identity.
 */
export function correspondenceKey(emittedPath: string, target: ProjectionTargetId): string {
  return `${target}::${emittedPath}`;
}

export function emptyBridge(): ProjectionBridgeFile {
  return {
    version: SCHEMA_VERSION,
    lastSyncTime: new Date().toISOString(),
    correspondences: {},
  };
}

/**
 * Status semantics:
 * - synced:        sourceHash matches current source; emittedHash matches current emitted file
 * - stale:         sourceHash changed; emitted file unchanged → needs re-emit
 * - orphan:        emitted file missing on disk
 * - hash-mismatch: both source AND emitted changed since last record (manual resolve)
 */

/**
 * Read the bridge file. Returns null if it doesn't exist.
 * Throws on parse / schema errors with file path + reason.
 */
export function loadBridge(path?: string): ProjectionBridgeFile | null {
  const p = path ?? defaultBridgePath();
  if (!existsSync(p)) return null;
  const raw = readFileSync(p, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Projection bridge at ${p} is not valid JSON: ${(e as Error).message}`);
  }
  validateBridge(parsed, p);
  return parsed as ProjectionBridgeFile;
}

/** Atomic write: temp file + rename. */
export function saveBridge(bridge: ProjectionBridgeFile, path?: string): void {
  const p = path ?? defaultBridgePath();
  validateBridge(bridge, p);
  bridge.lastSyncTime = new Date().toISOString();
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(bridge, null, 2) + '\n', 'utf-8');
  renameSync(tmp, p);
}

/**
 * Convenience: upsert a single correspondence and persist.
 */
export function upsertCorrespondence(
  c: ProjectionCorrespondence,
  path?: string,
): void {
  const bridge = loadBridge(path) ?? emptyBridge();
  const key = correspondenceKey(c.emittedPath, c.emitTarget);
  bridge.correspondences[key] = { ...c, lastCheckedAt: new Date().toISOString() };
  saveBridge(bridge, path);
}

export function validateBridge(value: unknown, sourceLabel = '<projection-bridge>'): asserts value is ProjectionBridgeFile {
  if (!value || typeof value !== 'object') {
    throw new Error(`${sourceLabel}: not an object`);
  }
  const v = value as Record<string, unknown>;
  if (v.version !== SCHEMA_VERSION) {
    throw new Error(`${sourceLabel}: version must be ${SCHEMA_VERSION}, got ${String(v.version)}`);
  }
  if (typeof v.lastSyncTime !== 'string') throw new Error(`${sourceLabel}: lastSyncTime must be string`);
  if (!v.correspondences || typeof v.correspondences !== 'object') {
    throw new Error(`${sourceLabel}: correspondences must be object`);
  }
  for (const [key, c] of Object.entries(v.correspondences as Record<string, unknown>)) {
    if (!c || typeof c !== 'object') {
      throw new Error(`${sourceLabel}: correspondences[${key}] must be object`);
    }
    const cc = c as Record<string, unknown>;
    for (const field of ['sourcePath', 'sourceHash', 'emitTarget', 'emittedPath', 'emittedHash', 'emittedAt'] as const) {
      if (typeof cc[field] !== 'string') {
        throw new Error(`${sourceLabel}: correspondences[${key}].${field} must be string`);
      }
    }
    if (typeof cc.status !== 'string' || !VALID_STATUSES.has(cc.status as ProjectionStatus)) {
      throw new Error(
        `${sourceLabel}: correspondences[${key}].status must be one of ${[...VALID_STATUSES].join('|')}; got ${String(cc.status)}`,
      );
    }
  }
}

// ─── CLI: validate / show ──────────────────────────────────────────────

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args[0] === '--validate') {
    const path = args[1] ?? defaultBridgePath();
    if (!existsSync(path)) {
      console.error(`No projection bridge at ${path}`);
      process.exit(2);
    }
    try {
      const bridge = loadBridge(path);
      console.log(
        `OK: ${path} valid (version ${bridge!.version}, ${Object.keys(bridge!.correspondences).length} correspondences)`,
      );
      process.exit(0);
    } catch (e) {
      console.error((e as Error).message);
      process.exit(1);
    }
  } else if (args[0] === '--show') {
    const bridge = loadBridge();
    if (!bridge) {
      console.error('No projection bridge at default path');
      process.exit(2);
    }
    console.log(JSON.stringify(bridge, null, 2));
  } else if (args[0] === '--init') {
    const path = args[1] ?? defaultBridgePath();
    if (existsSync(path)) {
      console.error(`Refusing to overwrite existing bridge at ${path}`);
      process.exit(1);
    }
    saveBridge(emptyBridge(), path);
    console.log(`Initialized empty projection bridge at ${path}`);
  } else {
    console.error('Usage: bun run projectionBridge.ts [--validate <path>|--show|--init <path>]');
    process.exit(2);
  }
}
